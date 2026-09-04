import type {
  ApprovalAction, EmployeeId, PunchKind, SubmissionKind, SubmissionState,
} from "../types.js";
import { NoRouteError, resolveRoute, type RouteSnapshot, type RouteStep } from "../routes.js";
import { assertApproverReachable, hasAuthorityOver, managersAt } from "./org.js";
import { workDateStart } from "../work-date.js";
import { designatedApproverOf, employeeLabel, isExempt } from "./employees.js";
// Read for the amendment detail on `ActPreview` and on the list rows. `periods.ts` imports
// nothing but the shared types, so this closes no cycle -- and the lock verdict has to be read
// HERE, in the same call as the authority check, or the approver is shown a period state that had
// already moved by the time they saw it.
import { periodOfSql } from "./periods.js";

// The state machine, and the three invariants it exists to hold:
//
//   1. Deciding a request you originated is structurally impossible. Checked before anything else
//      and not configurable — no route, no delegation and no state can arrange for an employee to
//      sign off their own overtime (`SelfApprovalError`), nor for whoever filed a request to be
//      the one who settles it (`FiledBySelfError`). Those became two people the moment
//      `created_by` let one person file for another; before that, the first was the whole rule.
//   2. A `return` voids every approval that came before it. An approver approved specific content;
//      once the employee may change that content, their approval no longer describes anything.
//   3. The route snapshot on the submission is authoritative. Steps are read from
//      `submissions.route_snapshot`, never re-resolved from live configuration, so an
//      administrator editing routes cannot mutate submissions that are already in flight.
//
// A submission is created directly in `pending`. `draft` is reached only by a `return`, and
// `resubmit` is the only way out of it — one entry point into the workflow, so there is no
// "created but never submitted" state to reason about.

export type NewSubmission = {
  employeeId: EmployeeId;
  requestedFor: string;
  minutes: number;
  reason: string;
  now: number;
  department: string | null;
  employmentType: string | null;
  /** Who filed it, when that is not the employee themself (an importer, or an admin acting for
   *  them). Recorded so the audit trail can distinguish whose overtime it is from whose hand
   *  filed it. */
  createdBy?: EmployeeId;
};

/** The question "may this actor act on this submission right now?", and nothing else. */
export type ActCheck = {
  submissionId: number;
  actorId: EmployeeId;
  now: number;
};

/** Acting on a submission is the authority question (`ActCheck`) plus the decision itself. */
export type ActInput = ActCheck & {
  action: ApprovalAction;
  comment?: string;
  /**
   * The submission's approval history as it stood when this decision was made — `latestEventId`
   * at that moment. Refuse if it has moved since. Omit for a decision made and performed in the
   * same call, which has no "since".
   *
   * Passed INTO the write rather than checked by the caller beforehand, because a caller-side
   * check would read the marker over one RPC and write over another, leaving exactly the window
   * this is meant to close. Here the comparison and the `INSERT` are one synchronous run.
   */
  expectedAfterEventId?: number;
};

/**
 * The `submissions` table's own columns, exactly as SQL hands them back.
 *
 * Separate from `SubmissionRow` because `SqlStorage.exec<T>` constrains `T` to a record of SQL
 * VALUES, and `SubmissionRow.amendment` is an assembled object — a `SELECT *` cannot be typed as
 * one. The split is worth having on its own terms too: this is what the write paths and the
 * authority prologue work with, and none of them has any use for display detail.
 */
export type SubmissionColumns = {
  id: number;
  employee_id: number;
  /**
   * What kind of request this is. `overtime` until amendments landed; an amendment is a submission
   * too, so that it inherits the approval stack rather than growing a second one beside it.
   *
   * Whatever reads a submission must not assume `overtime`. `minutes` and `calculation_inputs` are
   * overtime's columns and carry 0 and NULL on an amendment; what an amendment asks for lives in
   * `amendment_requests`, keyed on this row's id.
   */
  kind: SubmissionKind;
  requested_for: string;
  state: SubmissionState;
  submitted_at: number | null;
  current_step: number;
  minutes: number;
  reason: string;
  calculation_inputs: string | null;
  route_snapshot: string;
  created_by: number | null;
};

/**
 * A submission as the LIST reads return it: every column of the table, plus an amendment's detail.
 *
 * This is the shape `listMySubmissions` and `listPendingApprovals` put on the wire, and the one
 * `src/types.txt` describes to an agent.
 */
export type SubmissionRow = SubmissionColumns & {
  /**
   * What an amendment asks to change — present exactly on rows whose `kind` is `'amendment'`, and
   * absent on every overtime row.
   *
   * ABSENT IS THE DISCRIMINATOR, matching `ActPreview.amendment` and carrying the same type from
   * the same assembler. Without it a list row for an amendment is unreadable: `kind` says
   * `amendment`, `minutes` says 0 and means nothing there (see `kind` above), and nothing else on
   * the row says which punch, what it currently records, or what was asked for. An approver
   * browsing the queue — or an agent summarising it for them — saw a request for zero minutes.
   *
   * Populated by the LIST reads, `listSubmissionsFor` and `pendingApprovalsFor`, which join it in
   * the same query. `getSubmission` is a `SELECT *` used by the write paths and leaves it absent
   * even on an amendment; the authority prologue runs it once per queue row and has no use for
   * display data, so it does not pay for the joins. Ask `previewAct` (or `getAmendment`) for the
   * detail of one submission.
   */
  amendment?: AmendmentDetail;
};

export type ApprovalEventRow = {
  id: number;
  submission_id: number;
  step_index: number;
  actor_employee_id: number;
  action: ApprovalAction;
  at: number;
  comment: string | null;
  authorizing_edge: number | null;
};

export class SelfApprovalError extends Error {
  readonly code = "KINTAI_SELF_APPROVAL";
  constructor() { super("KINTAI_SELF_APPROVAL: you cannot approve your own submission."); }
}

/**
 * The other half of "you did not originate this": whoever filed a request does not settle it.
 *
 * `SelfApprovalError` was the whole rule only while the person a submission is *about* and the
 * person who *filed* it were always the same. `NewSubmission.createdBy` already separates them —
 * an importer, or an admin filing from a paper sheet — and a manager filing a punch correction for
 * their own report will make it ordinary. In that shape the self-approval check passes cleanly:
 * the manager is not the employee, and they are the employee's approver, so one person can
 * originate a change to payroll input and authorise it in the same breath. Nothing in the trail
 * marks it, because a filer and an approver are each unremarkable on their own; only the fact that
 * they are the same row is the finding, and no reader is looking for that.
 *
 * It refuses `reject` and `return` as well as `approve`. `checkMayAct` gates all three, and the
 * conflict does not depend on the verb — disposing of a request you raised is the same authority
 * collapsing into one person as approving it.
 *
 * `created_by` is nullable, and a null must never match an actor: it records that no filer was
 * captured (an older row, or a `submitOvertime` call that omitted it), not that the actor was one.
 *
 * `assertSatisfiable` is the filing-time half of this and now takes the filer, so a route step
 * pinned to whoever files is refused before a submission exists rather than after somebody tries
 * to decide it. One case is left for this check and cannot move earlier: a `manager_of` step whose
 * only live manager turns out to be the filer. That set is resolved at approval time and can
 * change in between, so asking at filing would mean re-resolving the org the snapshot exists to
 * freeze — such a request is refused here, when it is asked.
 */
export class FiledBySelfError extends Error {
  readonly code = "KINTAI_FILED_BY_APPROVER";
  constructor() {
    super(
      "KINTAI_FILED_BY_APPROVER: you filed this request, and nobody may decide a request they " +
      "filed themselves. Someone else in its approval route must decide it.",
    );
  }
}

/**
 * The spec says 管理監督者 "shouldn't be raising overtime requests at all" — they are exempt from
 * the premiums overtime approval exists to control, so there is nothing for an approver to sign.
 * Defense in depth in the same spirit as `SelfApprovalError`: a store-level guard, not merely a UI
 * concern.
 *
 * It was for a while the ONLY thing standing between an exempt employee and a stranded request,
 * because `hasReachableApprover` counted an exemption as "needs nobody" and so let one through.
 * That arm is gone — an exemption grants nobody authority to sign — so an exempt officer with
 * nobody above them is now refused by `assertApproverReachable` as well, whichever instant each
 * check is asked about. The two refusals answer different questions and both still belong here:
 * this one is about the WORK (exempt work bears no premium, so there is nothing to approve), and
 * that one is about the ORG (nobody could approve it if there were).
 */
export class ExemptEmployeeError extends Error {
  readonly code = "KINTAI_EXEMPT_EMPLOYEE";
  constructor() {
    super(
      "KINTAI_EXEMPT_EMPLOYEE: this employee is 管理監督者-exempt for the requested period and " +
      "may not raise an overtime request for it.",
    );
  }
}

export class NotAuthorizedError extends Error {
  readonly code = "KINTAI_NOT_AUTHORIZED";
  constructor() { super("KINTAI_NOT_AUTHORIZED: you are not an approver for this step."); }
}

export class SubmissionNotFoundError extends Error {
  readonly code = "KINTAI_NOT_FOUND";
  constructor(id: number) {
    super(`KINTAI_NOT_FOUND: there is no submission ${id}.`);
  }
}

export class InvalidTransitionError extends Error {
  readonly code = "KINTAI_INVALID_TRANSITION";
  constructor(from: SubmissionState) {
    super(`KINTAI_INVALID_TRANSITION: a submission in state '${from}' cannot be acted on.`);
  }
}

/**
 * Refused when a decision made earlier is applied to a submission whose approval history has moved
 * on since — another approver signed, it was returned, it was refiled.
 *
 * Distinct from `InvalidTransitionError`, which catches only the cases where the submission left
 * `pending`. The dangerous cases are the ones where it is STILL `pending` and still looks
 * actionable: a decision staged before a return and applied after the employee refiled would be
 * recorded as a sign-off on content the approver never saw.
 */
export class StaleDecisionError extends Error {
  readonly code = "KINTAI_STALE_DECISION";
  constructor() {
    super(
      "KINTAI_STALE_DECISION: this submission has been acted on since this decision was made, so " +
      "the decision no longer applies to what it was made about. Discard it and decide again on " +
      "the submission as it now stands.",
    );
  }
}

export function getSubmission(sql: SqlStorage, id: number): SubmissionColumns {
  // `.one()` would throw a raw SQLite error with no `code`, which the RPC boundary can only turn
  // into a 500. An unknown id is an ordinary client mistake and gets its own coded error.
  const row = sql
    .exec<SubmissionColumns>(`SELECT * FROM submissions WHERE id = ?`, id)
    .toArray()[0];
  if (!row) throw new SubmissionNotFoundError(id);
  return row;
}

export function approvalEvents(sql: SqlStorage, submissionId: number): ApprovalEventRow[] {
  // Asking for the history of a submission that does not exist is an error, not an empty history:
  // returning [] would let a typo read as "this submission has never been acted on".
  const exists = sql
    .exec<{ id: number }>(`SELECT id FROM submissions WHERE id = ?`, submissionId)
    .toArray()[0];
  if (!exists) throw new SubmissionNotFoundError(submissionId);

  return sql
    .exec<ApprovalEventRow>(
      `SELECT * FROM approval_events WHERE submission_id = ? ORDER BY id`, submissionId,
    )
    .toArray();
}

/**
 * A snapshot nobody can ever satisfy must not become a pending submission: the row would sit in
 * `pending` for good, approvable by no one and clearable only by the employee withdrawing it. Fail
 * at submit time, while there is still no state to clean up, rather than at the first approval
 * attempt — and fail closed, because "no steps" is a misconfiguration, not a licence to skip
 * approval.
 *
 * Three ways a snapshot can be unsatisfiable, all rejected here:
 *
 *  - no steps at all;
 *  - an `employee` step naming nobody;
 *  - an `employee` step pinned to the submitter themself. `authorize` refuses everyone but the
 *    pinned approver (`NotAuthorizedError`) and `actOnSubmission` refuses the pinned approver
 *    because they are the submitter (`SelfApprovalError`), so the submission appears in nobody's
 *    queue and can never advance. This is not exotic configuration: a 本社 escalation step pinned
 *    to a named 部長 strands that 部長's own overtime the moment they file any.
 *
 *  - an `employee` step pinned to whoever FILED it, when that is not the employee. `checkMayAct`
 *    refuses them by `FiledBySelfError` for the same reason it refuses the employee, so the step
 *    is as unsatisfiable as a self-pinned one — a manager files a correction for their report
 *    against a route that names the manager, and the request lands in a queue only they can see
 *    and only they cannot act on.
 *
 * `createdBy` IS REQUIRED, and nullable rather than optional, so that every call site has to say
 * who filed. An optional parameter is how the fourth case would go on being skipped by whichever
 * path forgot it, which is exactly what happened while this function knew only about the employee.
 * Null means no filer was recorded (an older row, or a store call that omitted it) and matches
 * nobody — the same rule `FiledBySelfError` applies to a null `created_by`.
 *
 * It is one function rather than a general `assertSatisfiable` plus an amendment-flavoured one, and
 * that is the deliberate part. The plan named the filer check `assertAmendmentSatisfiable` while
 * amendments were the only path that could reach the shape; they are not — the store's
 * `submitOvertime` takes `createdBy` too, and only the session facet's habit of setting it to the
 * employee kept overtime out of it. A rule that two write paths both need, written twice, is how
 * "who may approve" drifted apart here before.
 *
 * WHAT THIS DOES NOT CATCH, deliberately: a `manager_of` step whose only live manager happens to
 * be the filer. The set of managers is resolved at approval time and can change between filing and
 * then, and re-resolving the org here would make filing depend on the state the snapshot exists to
 * freeze. That request is refused at approval instead, with `KINTAI_FILED_BY_APPROVER`.
 */
export function assertSatisfiable(
  snapshot: RouteSnapshot, employeeId: EmployeeId, createdBy: EmployeeId | null,
): void {
  if (snapshot.steps.length === 0) {
    throw new NoRouteError(
      `KINTAI_NO_ROUTE: approval route ${snapshot.routeId} has no approval steps, so nothing ` +
      `could ever approve this request. Ask an administrator to configure its steps.`,
    );
  }
  const unpinned = snapshot.steps.find(
    (step) => step.approverKind === "employee" && step.approverEmployeeId === null,
  );
  if (unpinned) {
    throw new NoRouteError(
      `KINTAI_NO_ROUTE: step ${unpinned.stepIndex} of approval route ${snapshot.routeId} names no ` +
      `approver, so nothing could ever approve this request. Ask an administrator to fix it.`,
    );
  }
  const selfPinned = snapshot.steps.find(
    (step) => step.approverKind === "employee" && step.approverEmployeeId === employeeId,
  );
  if (selfPinned) {
    throw new NoRouteError(
      `KINTAI_NO_ROUTE: step ${selfPinned.stepIndex} of approval route ${snapshot.routeId} names ` +
      `this employee as its approver, and nobody may approve their own submission, so nothing ` +
      `could ever approve this request. Ask an administrator to fix it.`,
    );
  }
  // After the employee arm, never before it: somebody who is both gets the more specific message,
  // matching `checkMayAct`'s own ordering. Skipped when the filer IS the employee, which the arm
  // above has already answered.
  if (createdBy === null || createdBy === employeeId) return;
  const filerPinned = snapshot.steps.find(
    (step) => step.approverKind === "employee" && step.approverEmployeeId === createdBy,
  );
  if (filerPinned) {
    throw new NoRouteError(
      `KINTAI_NO_ROUTE: step ${filerPinned.stepIndex} of approval route ${snapshot.routeId} names ` +
      `the person filing this request as its approver, and nobody may decide a request they ` +
      `filed, so nothing could ever approve it. Ask the employee to file it themselves, or ask ` +
      `an administrator to fix the route.`,
    );
  }
}

/**
 * Create a submission, already pending. The resolved route is snapshotted onto the row: if route
 * configuration changes mid-approval, in-flight submissions must not mutate under their approvers.
 */
export function submitOvertime(sql: SqlStorage, input: NewSubmission): number {
  // `requested_for` is a calendar date (JST work date), not an instant. `workDateStart` rather
  // than `Date.parse`, which yields UTC midnight — 09:00 JST, mid-morning of the day it claims to
  // start — so anything beginning during those nine hours read as absent for the whole day.
  const requestedAt = workDateStart(input.requestedFor);

  // Exemption is asked about the DAY WORKED, not the filing time, and that is deliberate: an
  // employee exempt when they worked but filing later, once no longer exempt, is still filing for
  // exempt work and must still be refused. Exemption is a property of the work.
  if (isExempt(sql, input.employeeId, requestedAt)) {
    throw new ExemptEmployeeError();
  }

  // Task 10's write-time validation (`hasReachableApprover`/`assertApproverReachable`) is not
  // wired into any org-mutation path — there is currently no API that closes an `org_edges` row
  // (`account_links` has an UPDATE ... valid_to path; `org_edges` does not), so no write can yet
  // orphan an employee who once had an approver. `createEmployee` cannot enforce it either, since
  // the very first employee in an organisation has no manager by definition. That leaves exactly
  // one reachable hole: a `submitOvertime` call for an employee who never had a manager or a
  // designated approver at all. Guard it here.
  //
  // `setDesignatedApprover` points the column at somebody, so through the admin surface it cannot
  // orphan anyone. Do NOT read that as a property of the write itself: unlike a reporting edge,
  // which is additive, this column holds one value and the write is destructive — pointing it at
  // the employee themself overwrites whoever could previously sign for them, taking an employee
  // with no manager from reachable to orphaned in one statement. The store primitive refuses that
  // one case for itself; everything else is guaranteed at the admin boundary, which is where the
  // guarantee ends. An in-process caller reaching the store directly inherits nothing else.
  //
  // The moment an edge-closing API is introduced — or a way to clear a designated approver —
  // this stops being the only hole: that write needs this same check, not only submission time,
  // because an employee orphaned before they next file would otherwise pass silently until
  // they did.
  //
  // Asked at `input.now`, NOT at `requestedAt`, and unlike exemption above that is the whole
  // point. "Who can approve this?" is a question about the org as it stands when the answer is
  // needed, not about the day the work happened. Pinning it to the work date made a reporting
  // line created during that day unable to approve it — reproduced live: an edge created at
  // 16:33 JST could not approve overtime for that same date, and filing later never helped
  // because the question stayed pinned to a moment before the edge existed. Worse, it left the
  // submission permanently unfileable, when the obvious approver was standing right there.
  //
  // It also put this check into open disagreement with `listRoster`, which asks
  // `hasReachableApprover` at `Date.now()` and so displayed "reports to Admin - all ready" for an
  // employee this function was simultaneously refusing as having no manager. `roster.ts` states
  // that it calls the same functions the approval path calls precisely so the two cannot drift;
  // the `at` they passed was the drift.
  assertApproverReachable(sql, input.employeeId, input.now);

  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: input.minutes,
  });
  assertSatisfiable(snapshot, input.employeeId, input.createdBy ?? null);

  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO submissions
         (employee_id, kind, requested_for, state, submitted_at, current_step,
          minutes, reason, calculation_inputs, route_snapshot, created_by)
       VALUES (?, 'overtime', ?, 'pending', ?, 0, ?, ?, NULL, ?, ?) RETURNING id`,
      input.employeeId, input.requestedFor, input.now, input.minutes, input.reason,
      JSON.stringify(snapshot), input.createdBy ?? null,
    )
    .one();
  return row.id;
}

/**
 * The `approval_events.id` of the most recent `return`, or 0. Approvals logged at or before it do
 * not count any more.
 *
 * The boundary is the append-only log's own row id rather than the `at` timestamp because every
 * time in this system is supplied by the caller and so is not monotonic. With a timestamp boundary
 * a `return` recorded with an earlier clock reading than the approval it is meant to void would
 * leave that approval standing — which is precisely the invariant being defended. Row ids are
 * assigned in insertion order, so "recorded before the most recent return" is exactly what they
 * express.
 */
function lastReturnEventId(sql: SqlStorage, submissionId: number): number {
  const row = sql
    .exec<{ id: number | null }>(
      `SELECT MAX(id) AS id FROM approval_events
       WHERE submission_id = ? AND action = 'return'`,
      submissionId,
    )
    .one();
  return row.id ?? 0;
}

/**
 * The id of this submission's most recent approval event, or 0 if it has none yet.
 *
 * The staleness marker: a decision records this when it is made and refuses to be applied if it
 * has changed. `approval_events.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so it is monotonic by
 * construction and never reused — the same reason `lastReturnEventId` uses row ids rather than
 * `at`, since every time in this system is caller-supplied and therefore not monotonic.
 *
 * 0 rather than NULL for "no events yet", matching `lastReturnEventId`: ids start at 1, so 0 is
 * unambiguous, and it keeps the comparison a plain `!==` in every case rather than one that has to
 * remember that `NULL` is not equal to itself. A freshly filed submission nobody has acted on gets
 * a real marker like any other.
 */
function latestEventId(sql: SqlStorage, submissionId: number): number {
  const row = sql
    .exec<{ id: number | null }>(
      `SELECT MAX(id) AS id FROM approval_events WHERE submission_id = ?`, submissionId,
    )
    .one();
  return row.id ?? 0;
}

/**
 * The employee's live reporting line, with any self-edge dropped.
 *
 * Reporting edges only: a delegate covers an absent manager, so counting one would make a stand-in
 * an extra required signature. A manager edge naming the employee themself is a data error, and
 * self-approval is structurally forbidden, so it must never read as a manager who could sign.
 *
 * This exists as one function because THREE decisions have to agree about it — the `all_of`
 * requirement, who may act, and whether the designated-approver fallback applies at all. When they
 * were written out separately they drifted, and the drift was invisible under `all_of` routes.
 */
function reportingManagers(sql: SqlStorage, employeeId: EmployeeId, now: number): EmployeeId[] {
  return managersAt(sql, employeeId, now, "report").filter((id) => id !== employeeId);
}

/**
 * The employee's `designated_approver_id`, or null if there is none or it names the employee.
 *
 * This is the root-of-organisation escape hatch and nothing more; `rootFallbackApplies` decides
 * *whether* it is in play. Self-reference collapses to null for the same reason a self-edge does.
 */
function designatedFallback(sql: SqlStorage, employeeId: EmployeeId): EmployeeId | null {
  const designated = designatedApproverOf(sql, employeeId);
  return designated === null || designated === employeeId ? null : designated;
}

/**
 * The approvals an `all_of` step must collect. Deliberately *not* the same set as "who may act":
 *
 *  - manager steps require the reporting line only (see `reportingManagers`).
 *  - the employee themself is filtered out of every manager-kind set, and out of the designated-
 *    approver fallback. A step *pinned* to the employee is not filtered here — it is refused
 *    outright at submit time by `assertSatisfiable`, because such a step could never complete.
 *
 * With no reporting line at all the requirement falls back to the designated approver: the same
 * person `authorize` lets act for a root employee, so the step can actually complete rather than
 * stranding them in `pending`. It also keeps the set non-empty, which is what preserves the
 * fail-closed guarantee on the case that guard was written for — no reporting managers AND no
 * designated approver, e.g. an employee covered only by a delegate, where the set stays empty and
 * the step is correctly never satisfied.
 *
 * `hasReachableApprover` asks the related question "is this set ever non-empty?", and now asks it
 * over exactly these two arms. It used to have a third, 管理監督者 exemption, which had no
 * counterpart here and never could: an exemption grants nobody authority to sign, so it can never
 * contribute a required approver. Whether an employee needs approval at all is a different
 * question, and `ExemptEmployeeError` is where overtime answers it.
 */
function requiredApprovers(
  sql: SqlStorage, submission: SubmissionColumns, step: RouteStep, now: number,
): EmployeeId[] {
  if (step.approverKind === "employee") {
    return step.approverEmployeeId === null ? [] : [step.approverEmployeeId];
  }

  const managers = reportingManagers(sql, submission.employee_id, now);
  if (managers.length > 0) return managers;

  const designated = designatedFallback(sql, submission.employee_id);
  return designated === null ? [] : [designated];
}

/**
 * Authorise the actor for this step, returning the org edge that granted it (null for a step
 * pinned to a named employee, which needs no edge).
 *
 * `hasAuthorityOver` is the gate, not a lookup performed after the fact: it is the authorisation
 * primitive, and the edge id it returns is what lets the audit trail answer "were they authorised
 * at that moment?" directly, rather than by inference against a later org chart.
 */
function authorize(
  sql: SqlStorage, submission: SubmissionColumns, step: RouteStep, actorId: EmployeeId, now: number,
): number | null {
  if (step.approverKind === "employee") {
    if (step.approverEmployeeId === null || step.approverEmployeeId !== actorId) {
      throw new NotAuthorizedError();
    }
    return null;
  }
  const edge = hasAuthorityOver(sql, actorId, submission.employee_id, now);
  if (edge !== null) return edge;

  // No edge — but an employee at the ROOT of the reporting tree has no manager edge by definition,
  // and their designated approver is the only person who can ever act. Without this their
  // submissions would strand in `pending` for good.
  //
  // Gated on the employee having no live reporting line, which is what makes the comment above
  // true. `designated_approver_id` is the root-of-organisation escape hatch (spec, "Root-of-
  // organisation rule") and nothing else: an employee who has BOTH a live manager and a designated
  // approver must still collect a manager's signature. Ungated, the designated approver could
  // single-handedly satisfy an `any_of` manager step — and would appear in their queue — which is
  // the authority `requiredApprovers` and `hasReachableApprover` both already refuse to grant them.
  // The same filters as `requiredApprovers`, through the same two functions, so the two cannot
  // drift apart again.
  //
  // There is no edge to cite, so the audit records a null `authorizing_edge`: authority came from
  // the employee record, not the org graph.
  if (
    reportingManagers(sql, submission.employee_id, now).length === 0 &&
    designatedFallback(sql, submission.employee_id) === actorId
  ) {
    return null;
  }

  throw new NotAuthorizedError();
}

/** Everything `checkMayAct` established, so its caller never has to re-derive any of it. */
type ActAuthority = {
  submission: SubmissionColumns;
  snapshot: RouteSnapshot;
  step: RouteStep;
  /** The org edge that granted authority, or null for a pinned step or the root fallback. */
  authorizingEdge: number | null;
};

/**
 * THE authority prologue for acting on a submission. There is exactly one of these, deliberately.
 *
 * `actOnSubmission` (the write), `previewAct` (the stage-time probe, run before an approval is
 * queued for a human to confirm), `pendingApprovalsFor` (the queue) and `actOnAmendment` (which
 * runs it ahead of its own apply-time re-validation, so that an approver learns nothing about a
 * day they may not act on) all call this. They are not four checks kept in agreement — they are
 * one check called four times, because this project has already shipped a real bug from copies of
 * "who may approve" drifting apart: `authorize`,
 * `requiredApprovers` and `hasReachableApprover` each answer a version of it, and one of them
 * silently disagreed for weeks, letting a designated approver sign for an employee who already had
 * a manager. A probe, or a queue, written separately from the write is exactly how that happens
 * again — the queue was, in SQL, until the property test in `__tests__/submissions.test.ts` was
 * written to hold the two together.
 *
 * The ORDER here is itself load-bearing and must not be rearranged:
 *
 *  1. Origination first, ahead of everything else: neither the employee a submission is about nor
 *     the person who filed it may decide it, in any state, under any route.
 *  2. Authority BEFORE state, matching `withdrawSubmission` and `resubmit`.
 *     `InvalidTransitionError` names the state it refused, so checking state first would let a
 *     Gadget walk the id space and read back the exact state of every submission in the company.
 *     Ordering authority first closes that: a caller who cannot act learns only that they cannot.
 *
 *     Precisely what stays closed, and what does not. EXISTENCE is enumerable and always was —
 *     `getSubmission` is statement 1 and throws `KINTAI_NOT_FOUND`, so a caller can discover which
 *     ids exist. That is deliberate: an id that does not exist has no state and no owner to leak,
 *     and refusing to distinguish it would mean answering `KINTAI_NOT_AUTHORIZED` for typos. What
 *     is closed is everything that follows — the state, and whose submission it is. The only
 *     exceptions are the two the step above refuses: the caller's OWN submissions, which answer
 *     `KINTAI_SELF_APPROVAL` and disclose only what `listMySubmissions` already shows them, and
 *     submissions the caller filed, which answer `KINTAI_FILED_BY_APPROVER` and disclose only that
 *     a request they themselves wrote still exists. Neither hands out anything they did not have.
 *  3. Only then, with authority established, is the state safe to name.
 *
 * A row with no step at its current index is unactionable by anyone — `assertSatisfiable` rejects
 * step-less routes at submit time and `current_step` only ever advances into range, so this is
 * unreachable for well-formed data. "You are not an approver for this step" is literally true of
 * it, and fails closed without disclosing anything, so the corrupt row reports that rather than
 * its own state.
 */
export function checkMayAct(sql: SqlStorage, input: ActCheck): ActAuthority {
  const submission = getSubmission(sql, input.submissionId);
  if (input.actorId === submission.employee_id) throw new SelfApprovalError();
  // After the employee check, never before it: somebody who is both gets the more specific
  // message. A null `created_by` is not a match — see `FiledBySelfError`.
  if (submission.created_by !== null && input.actorId === submission.created_by) {
    throw new FiledBySelfError();
  }

  const snapshot = JSON.parse(submission.route_snapshot) as RouteSnapshot;
  const step = snapshot.steps[submission.current_step];
  if (!step) throw new NotAuthorizedError();

  const authorizingEdge = authorize(sql, submission, step, input.actorId, input.now);

  if (submission.state !== "pending") throw new InvalidTransitionError(submission.state);

  return { submission, snapshot, step, authorizingEdge };
}

/**
 * What one amendment asks to change, as a reader deciding on it needs to see it.
 *
 * ONE TYPE FOR BOTH SURFACES: the confirmation dialog (`ActPreview.amendment`, via `previewAct`)
 * and the list rows (`SubmissionRow.amendment`, via `listSubmissionsFor` and
 * `pendingApprovalsFor`). They are assembled by the same code from the same columns, so a queue
 * cannot summarise a request as one thing and the dialog confirm it as another.
 *
 * `currentOccurredAt` is what the target punch says NOW, read at the moment the reader is shown
 * the question rather than copied at filing time: the whole judgement is "should this become that",
 * and a stale left-hand side would be describing a comparison that is no longer the one being made.
 * It is null exactly when `targetPunchId` is — the forgotten clock-out, where there is no punch to
 * compare against and saying so is the honest answer.
 *
 * "WHAT THE PUNCH SAYS NOW" IS NOT THE TARGET ROW'S OWN COLUMN, and this is the subtle part.
 * `punches` is append-only: a correction appends a SUCCESSOR carrying `supersedes_id`, so the
 * target row's `occurred_at` is frozen from the instant it was written and reading it could never
 * have detected anything. The live time is the successor's when one exists — which is exactly the
 * case that matters, because a target superseded out of band (an admin correcting the same punch
 * from the HR surface while the request sits in a queue) makes the request permanently
 * unappliable: `actOnAmendment` refuses it with `KINTAI_AMENDMENT_TARGET_SUPERSEDED` whatever the
 * approver decides. Nothing else in the row changes, so a current time that no longer matches what
 * the request was filed against is the one signal a triaging approver gets.
 *
 * ONE HOP, deliberately, and it is the same hop `actOnAmendment` takes: it looks for a row whose
 * `supersedes_id` is the target and names it in the refusal. A successor that has itself been
 * superseded would leave this one revision behind — the request is doomed either way and the
 * signal still fires — and resolving the whole chain would mean a recursive CTE on a query that
 * runs on every queue open. `punches_supersedes_unique` guarantees at most one successor per
 * punch, so the hop is single-valued.
 *
 * `lockedPeriod` is the one field here that is NOT a property of the request: it is the state of
 * the month the write would land in, named rather than flagged because the reader needs to read
 * WHICH month. Null means open. Applying an approved amendment is the only write in the system
 * allowed into a closed period (see `actOnAmendment`), so this is the single thing about the
 * decision an approver most needs told and is least able to infer.
 *
 * Every field is read off the tables rather than assembled from a caller's argument, like every
 * other field of `ActPreview`.
 */
export type AmendmentDetail = {
  targetPunchId: number | null;
  /**
   * What the punch says now — the successor's time once something has superseded the target, not
   * the target row's own frozen column. Null when the request is to add a punch that was never
   * recorded. See the type's own comment: this field is the reason it has one.
   */
  currentOccurredAt: number | null;
  requestedOccurredAt: number;
  workDate: string;
  kind: PunchKind;
  /** The closed month this would write into, or null when that month is open. */
  lockedPeriod: string | null;
};

/**
 * The columns of an `AmendmentDetail`, and the joins that supply them, as SQL — written once and
 * spliced into every query that needs the detail.
 *
 * Shared rather than duplicated because there are two callers with genuinely different bases: the
 * single-submission read starts from `amendment_requests`, and the two lists start from
 * `submissions` and reach it through a `LEFT JOIN`. What they must not differ on is the DETAIL —
 * which punch is "current", how the period is derived — so that part is one string and one
 * assembler (`toAmendmentDetail`), and only the FROM clause varies.
 *
 * Every join is keyed on an index: `punches.id` is the primary key, `c.supersedes_id` has the
 * partial unique index `punches_supersedes_unique`, and `period_locks.period` is that table's
 * primary key. Nothing here scans, so adding the detail does not make the queue's cost grow with
 * the size of `punches` — see "amendment detail in the lists" in `__tests__/submissions.test.ts`,
 * which asserts the plan.
 *
 * The alias `a` is assumed to be `amendment_requests`; `t`, `c` and `pl` are this fragment's own.
 */
const AMENDMENT_DETAIL_COLUMNS = `
  a.target_punch_id,
  COALESCE(c.occurred_at, t.occurred_at) AS current_occurred_at,
  a.occurred_at AS requested_occurred_at,
  a.work_date AS amendment_work_date,
  a.kind AS amendment_kind,
  pl.period AS locked_period`;

const AMENDMENT_DETAIL_JOINS = `
  LEFT JOIN punches t ON t.id = a.target_punch_id
  LEFT JOIN punches c ON c.supersedes_id = a.target_punch_id
  LEFT JOIN period_locks pl ON pl.period = ${periodOfSql("a.work_date")}`;

/** The row `AMENDMENT_DETAIL_COLUMNS` selects. Column names, not the type's field names. */
type AmendmentDetailColumns = {
  target_punch_id: number | null;
  current_occurred_at: number | null;
  requested_occurred_at: number;
  /** Aliased away from `submissions.requested_for`/`kind`, which `s.*` also brings along. */
  amendment_work_date: string;
  amendment_kind: PunchKind;
  locked_period: string | null;
};

function toAmendmentDetail(row: AmendmentDetailColumns): AmendmentDetail {
  return {
    targetPunchId: row.target_punch_id,
    currentOccurredAt: row.current_occurred_at,
    requestedOccurredAt: row.requested_occurred_at,
    workDate: row.amendment_work_date,
    kind: row.amendment_kind,
    lockedPeriod: row.locked_period,
  };
}

/**
 * What an approver reads before confirming a decision. Display only — nothing here is ever used to
 * decide anything, and it exists at all only because a human is about to be asked a question.
 */
export type ActPreview = {
  /** Whose overtime this is. Server-derived from the submission, never from a caller. */
  employeeName: string;
  employeeNumber: string;
  /** Who is deciding. Server-derived from the acting capability, never from a caller. */
  actorName: string;
  requestedFor: string;
  minutes: number;
  reason: string;
  /** 1-based, for display: "step 2 of 3". */
  stepNumber: number;
  stepCount: number;
  /**
   * What this request would change, present only when the submission is an amendment.
   *
   * ABSENT IS THE DISCRIMINATOR, and `describeApproval` branches on it. An amendment's `minutes` is
   * 0 by design — `fileAmendment` writes it and nothing ever reads it — so a description built from
   * `minutes` alone told the approver they were signing off zero minutes of overtime. There is no
   * value of `minutes` that could have carried this; the detail had to arrive.
   *
   * The same type, from the same assembler, as `SubmissionRow.amendment`: the queue an approver
   * browsed and the dialog they confirm cannot describe one request two ways.
   */
  amendment?: AmendmentDetail;
};

/**
 * What `previewAct` answers: the display half, and the staleness marker.
 *
 * Two fields rather than one flat object on purpose. `ActPreview` is display-only and says so, and
 * `describeApproval` renders every field of it into text a human reads; `afterEventId` decides
 * whether a decision may be applied at all. Flattening the marker into `ActPreview` would put a
 * load-bearing value into a type whose contract is that nothing in it decides anything, and the
 * next person to add a display field would have no way to know which kind they were adding.
 */
export type ActProbe = {
  preview: ActPreview;
  /** `latestEventId` at the moment authority was checked. See `ActInput.expectedAfterEventId`. */
  afterEventId: number;
};

/**
 * Run the authority prologue WITHOUT writing, and report what an approver needs to see, plus the
 * marker that says which version of the submission they are being shown.
 *
 * This is how a decision can be staged for human confirmation without a second implementation of
 * "who may approve": it and `actOnSubmission` share `checkMayAct`, so they cannot disagree. It
 * writes nothing, and it returns nothing at all to a caller who has not already proven they may
 * act — so it discloses no more than `actOnSubmission` itself always has.
 *
 * The marker is read HERE, in the same call as the authority check, and not by the caller
 * afterwards. Two calls would leave a window in which precisely the thing the marker guards
 * against — somebody else acting — could happen between them, and the decision would then be
 * stamped with a marker for a submission it was never shown.
 */
export function previewAct(sql: SqlStorage, input: ActCheck): ActProbe {
  const { submission, snapshot } = checkMayAct(sql, input);
  const employee = employeeLabel(sql, submission.employee_id);
  const actor = employeeLabel(sql, input.actorId);
  const preview: ActPreview = {
    employeeName: employee.display_name,
    employeeNumber: employee.employee_number,
    actorName: actor.display_name,
    requestedFor: submission.requested_for,
    minutes: submission.minutes,
    reason: submission.reason,
    stepNumber: submission.current_step + 1,
    stepCount: snapshot.steps.length,
  };
  if (submission.kind === "amendment") {
    preview.amendment = amendmentPreview(sql, submission.id);
  }
  return { preview, afterEventId: latestEventId(sql, submission.id) };
}

/**
 * The amendment half of `previewAct`: what this request would change, plus whether the month it
 * lands in is closed.
 *
 * NOT `getAmendment`, and the difference is the point. That function answers "what does the record
 * say this request is", from one table. This answers "what is the approver being asked to agree
 * to", which needs the target punch's CURRENT time joined in — the right-hand side of the
 * comparison lives on the request, the left-hand side lives on the punch (or on the punch that has
 * since superseded it), and only `punches` knows whether somebody has moved it since the request
 * was filed.
 *
 * `LEFT JOIN`, because the target is null for an addition, and a null `currentOccurredAt` is the
 * honest answer there rather than an absence to paper over.
 *
 * One submission, so this could have called `isLocked` for the period rather than joining
 * `period_locks`. It joins, because the lists cannot call `isLocked` per row and the two surfaces
 * sharing `AMENDMENT_DETAIL_COLUMNS` is worth more than one saved join: a period derived two ways
 * is a period that can be derived two ways.
 *
 * Read here rather than in `amendments.ts` because that module imports this one; asking it for this
 * would close a cycle. The query is small and belongs to the question `previewAct` is answering.
 */
function amendmentPreview(sql: SqlStorage, submissionId: number): AmendmentDetail {
  const row = sql
    .exec<AmendmentDetailColumns>(
      `SELECT ${AMENDMENT_DETAIL_COLUMNS}
       FROM amendment_requests a
       ${AMENDMENT_DETAIL_JOINS}
       WHERE a.submission_id = ?`,
      submissionId,
    )
    .toArray()[0];
  if (!row) {
    // A submission whose `kind` says amendment with no amendment row is a broken record, not a
    // display problem. Uncoded on purpose: `isDomainRefusal` must not read this as a clean refusal.
    throw new Error(`previewAct: submission ${submissionId} is an amendment with no request row`);
  }
  return toAmendmentDetail(row);
}

export function actOnSubmission(sql: SqlStorage, input: ActInput): SubmissionState {
  const { submission, snapshot, step, authorizingEdge } = checkMayAct(sql, input);

  // AFTER authority, before any write. Ordered after `checkMayAct` for the same reason state is:
  // this error names something about the submission, and only somebody who may act on it may
  // learn that. Before the insert because a stale decision must leave no trace at all — and
  // because throwing here keeps the guarantee `isDomainRefusal` rests on, that every `KINTAI_`
  // error out of this function comes from before the write.
  if (
    input.expectedAfterEventId !== undefined &&
    latestEventId(sql, submission.id) !== input.expectedAfterEventId
  ) {
    throw new StaleDecisionError();
  }

  sql.exec(
    `INSERT INTO approval_events
       (submission_id, step_index, actor_employee_id, action, at, comment, authorizing_edge)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submission.id, submission.current_step, input.actorId, input.action, input.now,
    input.comment ?? null, authorizingEdge,
  );

  if (input.action === "reject") {
    sql.exec(`UPDATE submissions SET state = 'rejected' WHERE id = ?`, submission.id);
    return "rejected";
  }

  if (input.action === "return") {
    // Approvers approved specific content. If the employee may now change it, those approvals no
    // longer apply — so the submission restarts from step 0 and earlier approvals stop counting.
    sql.exec(
      `UPDATE submissions SET state = 'draft', current_step = 0 WHERE id = ?`, submission.id,
    );
    return "draft";
  }

  // approve — has this step's rule been satisfied since the last return?
  const since = lastReturnEventId(sql, submission.id);
  const approvers = new Set(
    sql
      .exec<{ actor_employee_id: number }>(
        `SELECT DISTINCT actor_employee_id FROM approval_events
         WHERE submission_id = ? AND step_index = ? AND action = 'approve' AND id > ?`,
        submission.id, submission.current_step, since,
      )
      .toArray()
      .map((row) => row.actor_employee_id),
  );

  // An `all_of` requirement is evaluated against the org as it stands now, so a manager who has
  // since left drops out of it rather than stalling the submission for good.
  //
  // An EMPTY requirement is unsatisfied, not vacuously satisfied. `[].every()` is `true`, which
  // would let a step that asks for every manager's signature complete on none of them — reachable
  // today by an employee whose reporting edges are all closed but who has a live delegate, since
  // the delegate can act but is (correctly) not counted into the requirement. "Nobody is required"
  // must fail closed, exactly as `assertSatisfiable`'s "nobody can approve" does.
  const required = step.rule === "all_of"
    ? requiredApprovers(sql, submission, step, input.now)
    : [];
  const satisfied = step.rule === "any_of"
    ? approvers.size > 0
    : required.length > 0 && required.every((id) => approvers.has(id));

  if (!satisfied) return "pending";

  const nextStep = submission.current_step + 1;
  if (nextStep < snapshot.steps.length) {
    sql.exec(`UPDATE submissions SET current_step = ? WHERE id = ?`, nextStep, submission.id);
    return "pending";
  }

  sql.exec(`UPDATE submissions SET state = 'approved' WHERE id = ?`, submission.id);
  return "approved";
}

/** Move a returned submission back into the queue, starting again at step 0. */
export function resubmit(
  sql: SqlStorage, submissionId: number, actorId: EmployeeId, now: number,
): void {
  const submission = getSubmission(sql, submissionId);
  // Ownership before state, matching `withdrawSubmission`: a non-owner must not be able to learn
  // a submission's state from which error comes back.
  if (submission.employee_id !== actorId) throw new NotAuthorizedError();
  if (submission.state !== "draft") throw new InvalidTransitionError(submission.state);

  // `submitted_at` keeps the ORIGINAL filing time. Overwriting it on every resubmit makes "how
  // long has this sat unapproved?" unanswerable after a single return, which is exactly the
  // question an overtime backlog is audited on. COALESCE only fills it if it was somehow never
  // set.
  sql.exec(
    `UPDATE submissions
     SET state = 'pending', current_step = 0, submitted_at = COALESCE(submitted_at, ?)
     WHERE id = ?`,
    now, submissionId,
  );
}

export function withdrawSubmission(
  sql: SqlStorage, submissionId: number, actorId: EmployeeId,
): void {
  const submission = getSubmission(sql, submissionId);
  if (submission.employee_id !== actorId) throw new NotAuthorizedError();
  if (submission.state !== "pending" && submission.state !== "draft") {
    throw new InvalidTransitionError(submission.state);
  }
  sql.exec(`UPDATE submissions SET state = 'withdrawn' WHERE id = ?`, submissionId);
}

/**
 * One row of a list query: the submission's own columns, plus the amendment detail the LEFT JOIN
 * supplies.
 *
 * The `AmendmentDetailColumns` half is all-NULL on an overtime row, and `requested_occurred_at`,
 * `amendment_work_date` and `amendment_kind` are nonetheless typed non-null: they are non-null
 * everywhere they are READ, which is only ever behind the `amendment_submission_id` check in
 * `withAmendmentDetail`. Typing the half nullable would buy nothing but a `!` on each of them.
 */
type SubmissionListRow = SubmissionColumns & AmendmentDetailColumns & {
  /** `amendment_requests.submission_id`. Non-null exactly on an amendment row: the discriminator. */
  amendment_submission_id: number | null;
};

/** The submission columns, `${AMENDMENT_DETAIL_JOINS}`'s columns, and the discriminator. */
const SUBMISSION_LIST_COLUMNS =
  `s.*, a.submission_id AS amendment_submission_id, ${AMENDMENT_DETAIL_COLUMNS}`;

const SUBMISSION_LIST_JOINS =
  `LEFT JOIN amendment_requests a ON a.submission_id = s.id ${AMENDMENT_DETAIL_JOINS}`;

/**
 * Split one joined row back into a `SubmissionRow`, with `amendment` attached only when there was
 * a request to attach.
 *
 * The joined columns are destructured OUT rather than left on the row. These rows cross the RPC
 * boundary to agents and to the app, and a submission carrying both `amendment.workDate` and a
 * stray snake_case `amendment_work_date` beside it would be two spellings of one fact, with
 * nothing saying which is the contract. `src/types.txt` describes the row, and it must describe
 * all of it.
 */
function withAmendmentDetail(row: SubmissionListRow): SubmissionRow {
  const {
    amendment_submission_id: amendmentId,
    target_punch_id, current_occurred_at, requested_occurred_at,
    amendment_work_date, amendment_kind, locked_period,
    ...submission
  } = row;
  // Absent, not empty: whatever reads these rows branches on the property's presence.
  if (amendmentId === null) return submission;
  return {
    ...submission,
    amendment: toAmendmentDetail({
      target_punch_id, current_occurred_at, requested_occurred_at,
      amendment_work_date, amendment_kind, locked_period,
    }),
  };
}

/**
 * Every submission belonging to one employee, newest first — with each amendment's detail, so an
 * employee reviewing their own requests can see what they asked for.
 *
 * Joined in the same query as the list, not fetched per row. Same reason as `pendingApprovalsFor`,
 * and the same reason `previewAct` reads its lock verdict in the call that checks authority: a
 * second round trip per submission is a window as well as a cost.
 */
export function listSubmissionsFor(
  sql: SqlStorage, employeeId: EmployeeId,
): SubmissionRow[] {
  return sql
    .exec<SubmissionListRow>(
      `SELECT ${SUBMISSION_LIST_COLUMNS}
       FROM submissions s
       ${SUBMISSION_LIST_JOINS}
       WHERE s.employee_id = ? ORDER BY s.id DESC`,
      employeeId,
    )
    .toArray()
    .map(withAmendmentDetail);
}

/**
 * The refusals that mean "not you, not this one, not now" — the only errors out of `checkMayAct`
 * that describe a row the queue should quietly leave out rather than fail over.
 *
 * Enumerated, never `catch (err) { return false }`. The filter below runs the whole authority
 * prologue per row, so a broken route snapshot, a missing employee record or a SQLite failure all
 * arrive here too, and swallowing those would turn a real fault into an empty queue — an approver
 * shown nothing to do, which is exactly the invisible stranding this function exists to prevent,
 * arrived at from the other side. Each one, and why it is on the list or not:
 *
 *  - `SelfApprovalError` — the actor is the employee. Unconditional and permanent: no route shape
 *    or later step makes their own submission decidable by them.
 *  - `FiledBySelfError` — the actor filed it. Same: whoever raises a request never settles it.
 *  - `NotAuthorizedError` — `authorize` found no edge and no root fallback, or the row has no step
 *    at its current index. The second is unreachable for well-formed data and fails closed here
 *    for the same reason it does in `actOnSubmission`.
 *  - `InvalidTransitionError` — the row is not `pending`. Unreachable while the SQL narrows to
 *    `pending`, and listed anyway so that narrowing stays a narrowing: if it is ever widened, the
 *    queue keeps answering correctly instead of throwing.
 *  - `SubmissionNotFoundError` is deliberately ABSENT. Every id passed in came from the SELECT in
 *    the same synchronous turn, so a row disappearing between the two is not a refusal — it is a
 *    fact about the database nobody should be hiding.
 */
function isQueueRefusal(err: unknown): boolean {
  return err instanceof SelfApprovalError ||
    err instanceof FiledBySelfError ||
    err instanceof NotAuthorizedError ||
    err instanceof InvalidTransitionError;
}

/**
 * Submissions this approver can act on right now, derived from the org graph and each submission's
 * own route snapshot — never from a caller's claim about who they are or what they manage.
 *
 * The filter is `checkMayAct` — the whole authority prologue, the same function `previewAct` and
 * `actOnSubmission` call, not a re-statement of it. Those must agree: a queue that lists what the
 * approver cannot act on produces dead entries, and — much worse — a queue that omits what they
 * alone can act on strands the submission in `pending` invisibly. The only way to keep them in
 * step under every route shape (a step pinned to a named employee, a delegate covering an absent
 * manager, a root employee's designated approver) is to ask the same question, so this is one
 * function called three times, exactly as `previewAct`/`actOnSubmission` are one called twice.
 *
 * It used to call `authorize` and re-state the rest: `employee_id != ?` for `SelfApprovalError`,
 * a `created_by` test for `FiledBySelfError`, an explicit `if (!step) return false`. Those agreed
 * with `checkMayAct` only by construction, and drifted silently in both directions — a refusal
 * added AHEAD of `authorize` would have left the SQL behind and filled the queue with rows nobody
 * could act on, and `FiledBySelfError` ever narrowed would have left the SQL hiding rows the
 * approver alone could act on. `__tests__/submissions.test.ts` now asserts the equivalence as a
 * property over a matrix of submissions and actors, because nothing else was going to catch it.
 *
 * `state = 'pending'` survives, purely as narrowing: it is not the authority answer — the filter
 * would refuse a non-pending row on its own — it just keeps the company's whole submission history
 * out of memory on every queue open. Route snapshots are JSON on the row, so the actual decision
 * cannot be evaluated in SQL at all.
 *
 * The cost is one extra indexed point lookup per pending row: `checkMayAct` takes an id and
 * re-reads the row this function already holds. Measured in the workerd test runtime, over 1000
 * pending rows for one approver, it moves a median 16-17ms per call to 21ms — about 4µs a row, and
 * a real ~28% on a synthetic worst case. At 50 rows, which is already a large queue for one
 * person, both are 1ms and the difference does not show above the timer's resolution. The cost is
 * bounded by the PENDING set, not by history, and the alternative on offer is a second copy of the
 * approval rule that has already drifted once. If it ever does matter, the fix is to pass the row
 * into the prologue rather than the id — not to restate what it decides.
 */
export function pendingApprovalsFor(
  sql: SqlStorage, approverId: EmployeeId, now: number,
): SubmissionRow[] {
  const pending = sql
    .exec<SubmissionListRow>(
      // submitted_at is caller-supplied and so is not monotonic; id breaks ties in insertion order.
      `SELECT ${SUBMISSION_LIST_COLUMNS}
       FROM submissions s
       ${SUBMISSION_LIST_JOINS}
       WHERE s.state = 'pending' ORDER BY s.submitted_at, s.id`,
    )
    .toArray();

  return pending
    // The joins supply DISPLAY DATA AND NEVER AUTHORITY. The filter is untouched by them: it is
    // still `checkMayAct` on the submission's id, so the property test in
    // `__tests__/submissions.test.ts` still holds the queue and the act check together. A join
    // that narrowed the rows would be a second, silent statement of who may approve — which is
    // precisely the drift the whole comment above is about. `LEFT JOIN` throughout, so no row can
    // be dropped by it either.
    .filter((submission) => {
      try {
        checkMayAct(sql, { submissionId: submission.id, actorId: approverId, now });
        return true;
      } catch (err) {
        if (isQueueRefusal(err)) return false;
        throw err;
      }
    })
    // After the filter, not before: assembling detail for rows the approver may not see would be
    // work thrown away, and the queue's cost is already the pending set.
    .map(withAmendmentDetail);
}
