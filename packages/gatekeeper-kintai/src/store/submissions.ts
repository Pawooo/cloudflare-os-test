import type { ApprovalAction, EmployeeId, SubmissionState } from "../types.js";
import { NoRouteError, resolveRoute, type RouteSnapshot, type RouteStep } from "../routes.js";
import { hasAuthorityOver, managersAt } from "./org.js";
import { designatedApproverOf } from "./employees.js";

// The state machine, and the three invariants it exists to hold:
//
//   1. Self-approval is structurally impossible. It is checked before anything else and is not
//      configurable — no route, no delegation and no state can arrange for an employee to sign off
//      their own overtime.
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

export type ActInput = {
  submissionId: number;
  actorId: EmployeeId;
  action: ApprovalAction;
  now: number;
  comment?: string;
};

export type SubmissionRow = {
  id: number;
  employee_id: number;
  kind: "overtime";
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
  constructor(from: SubmissionState, detail?: string) {
    super(detail
      ?? `KINTAI_INVALID_TRANSITION: a submission in state '${from}' cannot be acted on.`);
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
 */
function assertSatisfiable(snapshot: RouteSnapshot): void {
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
}

/**
 * Create a submission, already pending. The resolved route is snapshotted onto the row: if route
 * configuration changes mid-approval, in-flight submissions must not mutate under their approvers.
 */
export function submitOvertime(sql: SqlStorage, input: NewSubmission): number {
  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: input.minutes,
  });
  assertSatisfiable(snapshot);

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
 * The approvals an `all_of` step must collect. Deliberately *not* the same set as "who may act":
 *
 *  - manager steps require the reporting line only. A delegate covers an absent manager, so
 *    counting them would make a stand-in an extra required signature.
 *  - the employee themself is filtered out. A self-edge is a data error, but if one exists it must
 *    not deadlock the submission behind an approval that self-approval forbids.
 */
function requiredApprovers(
  sql: SqlStorage, submission: SubmissionRow, step: RouteStep, now: number,
): EmployeeId[] {
  if (step.approverKind === "employee") {
    return step.approverEmployeeId === null ? [] : [step.approverEmployeeId];
  }
  return managersAt(sql, submission.employee_id, now, "report")
    .filter((id) => id !== submission.employee_id);
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

  // No edge — but an employee at the root of the reporting tree has no manager edge by
  // definition, and their designated approver is the only person who can ever act. Without this
  // their submissions would strand in `pending` for good. There is no edge to cite, so the audit
  // records a null `authorizing_edge`: authority came from the employee record, not the org graph.
  if (designatedApproverOf(sql, submission.employee_id) === actorId) return null;

  throw new NotAuthorizedError();
}

export function actOnSubmission(sql: SqlStorage, input: ActInput): SubmissionState {
  const submission = getSubmission(sql, input.submissionId);
  // First, ahead of the state machine itself: nobody signs off their own overtime, in any state,
  // under any route.
  if (input.actorId === submission.employee_id) throw new SelfApprovalError();
  if (submission.state !== "pending") throw new InvalidTransitionError(submission.state);

  const snapshot = JSON.parse(submission.route_snapshot) as RouteSnapshot;
  const step = snapshot.steps[submission.current_step];
  if (!step) {
    // Unreachable: `assertSatisfiable` rejects step-less routes at submit time and `current_step`
    // only ever advances into range. Fail closed rather than treat a corrupt row as approvable.
    throw new InvalidTransitionError(
      submission.state,
      `KINTAI_INVALID_TRANSITION: submission ${submission.id} has no step ` +
      `${submission.current_step} in its route snapshot.`,
    );
  }

  const authorizingEdge = authorize(sql, submission, step, input.actorId, input.now);

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
