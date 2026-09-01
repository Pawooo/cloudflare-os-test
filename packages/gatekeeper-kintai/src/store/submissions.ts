import type { ApprovalAction, EmployeeId, SubmissionKind, SubmissionState } from "../types.js";
import { NoRouteError, resolveRoute, type RouteSnapshot, type RouteStep } from "../routes.js";
import { assertApproverReachable, hasAuthorityOver, managersAt } from "./org.js";
import { designatedApproverOf, employeeLabel, isExempt } from "./employees.js";

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

export type SubmissionRow = {
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
 * KNOWN GAP, deliberately left: `assertSatisfiable` refuses a route step pinned to the *employee*
 * at filing time, so such a submission never strands. It does not know about the filer, so a step
 * pinned to somebody who then files on another's behalf produces a submission nobody can decide —
 * discovered only when they try. Unreachable today, because the one caller that sets `createdBy`
 * (`KintaiSession.submitOvertime`) sets it to the employee; it becomes reachable with the first
 * filed-on-behalf path, and the filing-time check belongs there rather than here.
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
 * No task in the plan wires that rule in elsewhere, and without it an exempt employee's submission
 * would be silently accepted and then strand: their own exemption satisfies `hasReachableApprover`
 * (Task 10), but that is a statement about them needing no approver, not about anyone being
 * required or able to approve a step. This is defense in depth in the same spirit as
 * `SelfApprovalError` — a store-level guard, not merely a UI concern.
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

export function getSubmission(sql: SqlStorage, id: number): SubmissionRow {
  // `.one()` would throw a raw SQLite error with no `code`, which the RPC boundary can only turn
  // into a 500. An unknown id is an ordinary client mistake and gets its own coded error.
  const row = sql
    .exec<SubmissionRow>(`SELECT * FROM submissions WHERE id = ?`, id)
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
 * A FOURTH way exists and is NOT rejected here: a step pinned to whoever FILED the submission, who
 * is refused by `FiledBySelfError` for the same reason the submitter is. This function is not given
 * the filer, and cannot be without deciding whether filing-on-behalf is even in play — see the
 * KNOWN GAP on `FiledBySelfError`. Unreachable while every filing path sets `created_by` to the
 * employee themself; the amendment work closes it with `assertAmendmentSatisfiable`. Do not read
 * the list above as exhaustive until it does.
 */
export function assertSatisfiable(snapshot: RouteSnapshot, employeeId: EmployeeId): void {
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
}

/**
 * Create a submission, already pending. The resolved route is snapshotted onto the row: if route
 * configuration changes mid-approval, in-flight submissions must not mutate under their approvers.
 */
export function submitOvertime(sql: SqlStorage, input: NewSubmission): number {
  // `requested_for` is a calendar date (JST work date), not an instant; it is parsed as UTC
  // midnight of that date to evaluate both checks below against the period this request is
  // actually about. This is deliberately the requested date, not `input.now` (the filing time) —
  // an employee exempt on the day worked but filing later, once no longer exempt, is still filing
  // for exempt work and must still be refused; and an employee with no approver on the day worked
  // must not be let through just because they later happen to gain one before filing.
  const requestedAt = Date.parse(input.requestedFor);

  if (isExempt(sql, input.employeeId, requestedAt)) {
    throw new ExemptEmployeeError();
  }

  // Task 10's write-time validation (`hasReachableApprover`/`assertApproverReachable`) is not
  // wired into any org-mutation path — there is currently no API that closes an `org_edges` row
  // (`account_links` has an UPDATE ... valid_to path; `org_edges` does not), so no write can yet
  // orphan an employee who once had an approver. `createEmployee` cannot enforce it either, since
  // the very first employee in an organisation has no manager by definition. That leaves exactly
  // one reachable hole: a `submitOvertime` call for an employee who never had a manager, an
  // exemption, or a designated approver at all. Guard it here.
  //
  // The moment an edge-closing API is introduced, this stops being the only hole: closing an
  // employee's last reporting edge (or revoking their designated approver, if that ever becomes
  // mutable) needs this same check at that write, not only at submission time — an employee who
  // is orphaned before ever filing again would otherwise pass silently until they did.
  assertApproverReachable(sql, input.employeeId, requestedAt);

  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: input.minutes,
  });
  assertSatisfiable(snapshot, input.employeeId);

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
 * Task 10's `hasReachableApprover` asks a related question with a third arm, 管理監督者 exemption.
 * That arm has no counterpart here and must not gain one: an exemption grants nobody authority to
 * sign, so it can never contribute a required approver. It means the employee needs no approval,
 * which is a question about whether to route at all, not about who must sign.
 */
function requiredApprovers(
  sql: SqlStorage, submission: SubmissionRow, step: RouteStep, now: number,
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
  sql: SqlStorage, submission: SubmissionRow, step: RouteStep, actorId: EmployeeId, now: number,
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
  submission: SubmissionRow;
  snapshot: RouteSnapshot;
  step: RouteStep;
  /** The org edge that granted authority, or null for a pinned step or the root fallback. */
  authorizingEdge: number | null;
};

/**
 * THE authority prologue for acting on a submission. There is exactly one of these, deliberately.
 *
 * `actOnSubmission` (the write) and `previewAct` (the stage-time probe, run before an approval is
 * queued for a human to confirm) both call this. They are not two checks kept in agreement — they
 * are one check called twice, because this project has already shipped a real bug from copies of
 * "who may approve" drifting apart: `authorize`, `requiredApprovers`, `hasReachableApprover` and
 * `pendingApprovalsFor` all answer a version of it, and one of them silently disagreed for weeks,
 * letting a designated approver sign for an employee who already had a manager. A probe written
 * separately from the write is exactly how that happens again.
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
function checkMayAct(sql: SqlStorage, input: ActCheck): ActAuthority {
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
  return { preview, afterEventId: latestEventId(sql, submission.id) };
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

/** Every submission belonging to one employee, newest first. */
export function listSubmissionsFor(
  sql: SqlStorage, employeeId: EmployeeId,
): SubmissionRow[] {
  return sql
    .exec<SubmissionRow>(
      `SELECT * FROM submissions WHERE employee_id = ? ORDER BY id DESC`, employeeId,
    )
    .toArray();
}

/**
 * Submissions this approver can act on right now, derived from the org graph and each submission's
 * own route snapshot — never from a caller's claim about who they are or what they manage.
 *
 * The filter is `authorize` itself rather than a parallel SQL predicate. Those two must agree: a
 * queue that lists what the approver cannot act on produces dead entries, and — much worse — a
 * queue that omits what they alone can act on strands the submission in `pending` invisibly. The
 * only way to keep them in step under every route shape (a step pinned to a named employee, a
 * delegate covering an absent manager, a root employee's designated approver) is to ask the same
 * function. Route snapshots are JSON on the row, so the current step cannot be evaluated in SQL;
 * SQL narrows to the pending rows and the authorisation decision happens here.
 *
 * The two exclusions in the SQL are not optimisations. `checkMayAct` refuses an actor who is the
 * submission's employee AND one who filed it, so in both cases the row could never be acted on by
 * this approver and listing it would produce exactly the dead entry described above. Excluding
 * them cannot hide anything actionable, because the refusal is unconditional: no route shape,
 * delegation or later step makes such a row decidable by that person.
 *
 * `created_by` is nullable, so the filer test has to admit NULL rather than compare against it —
 * `NULL != ?` is NULL, not true, and would silently drop every row that predates the column.
 */
export function pendingApprovalsFor(
  sql: SqlStorage, approverId: EmployeeId, now: number,
): SubmissionRow[] {
  const pending = sql
    .exec<SubmissionRow>(
      // submitted_at is caller-supplied and so is not monotonic; id breaks ties in insertion order.
      `SELECT * FROM submissions
       WHERE state = 'pending' AND employee_id != ?
         AND (created_by IS NULL OR created_by != ?)
       ORDER BY submitted_at, id`,
      approverId, approverId,
    )
    .toArray();

  return pending.filter((submission) => {
    const snapshot = JSON.parse(submission.route_snapshot) as RouteSnapshot;
    const step = snapshot.steps[submission.current_step];
    // A submission with no step at its current index is unactionable by anyone (see
    // `actOnSubmission`); it must not appear in a queue that promises "you can act on this".
    if (!step) return false;
    try {
      authorize(sql, submission, step, approverId, now);
      return true;
    } catch (err) {
      if (err instanceof NotAuthorizedError) return false;
      throw err;
    }
  });
}
