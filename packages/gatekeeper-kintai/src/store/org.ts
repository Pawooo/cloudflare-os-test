import type { EmployeeId } from "../types.js";
import { designatedApproverOf, isExempt } from "./employees.js";

// The org graph is temporal because audits ask "was this person actually X's manager on 3 July?".
// A non-temporal table cannot answer that after any reorganisation, and every company reorganises.
// Delegation reuses the reporting-line shape with a bounded window, so a manager on leave does not
// silently stall their team's submissions.

export function setReportingLine(
  sql: SqlStorage,
  employeeId: EmployeeId,
  managerId: EmployeeId,
  from: number,
  to?: number,
): void {
  sql.exec(
    `INSERT INTO org_edges (employee_id, manager_id, kind, valid_from, valid_to)
     VALUES (?, ?, 'report', ?, ?)`,
    employeeId, managerId, from, to ?? null,
  );
}

/** Delegation is always bounded — an open-ended delegate is just a second manager. */
export function setDelegate(
  sql: SqlStorage,
  employeeId: EmployeeId,
  delegateId: EmployeeId,
  from: number,
  to: number,
): void {
  sql.exec(
    `INSERT INTO org_edges (employee_id, manager_id, kind, valid_from, valid_to)
     VALUES (?, ?, 'delegate', ?, ?)`,
    employeeId, delegateId, from, to,
  );
}

/**
 * Everyone authorised over `employeeId` at `at` — reporting lines and live delegations.
 *
 * This is an *enumeration* helper ("who could act?"), not the authorisation primitive: to decide
 * whether one specific actor may act, call `hasAuthorityOver`, which also yields the edge id the
 * audit trail needs.
 *
 * `kind` narrows the result to one edge kind. Unfiltered is the default so existing callers keep
 * the full set, but callers that build a *requirement* ("every manager must approve") must pass
 * "report": a delegate stands in for an absent manager, so counting them would turn a stand-in
 * into an extra required signature — the exact opposite of what delegation is for.
 */
export function managersAt(
  sql: SqlStorage,
  employeeId: EmployeeId,
  at: number,
  kind?: "report" | "delegate",
): EmployeeId[] {
  const window = `employee_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`;
  const rows = kind === undefined
    ? sql.exec<{ manager_id: number }>(
      `SELECT DISTINCT manager_id FROM org_edges WHERE ${window}`,
      employeeId, at, at,
    )
    : sql.exec<{ manager_id: number }>(
      `SELECT DISTINCT manager_id FROM org_edges WHERE ${window} AND kind = ?`,
      employeeId, at, at, kind,
    );
  return rows.toArray().map((row) => row.manager_id);
}

/**
 * The org_edges row granting `actorId` authority over `employeeId` at `at`, or null.
 *
 * Returns the edge id rather than a boolean so approval_events can record which edge authorised
 * the action — the audit trail then answers "were they authorised at that moment?" directly
 * instead of by inference against today's org chart.
 */
export function hasAuthorityOver(
  sql: SqlStorage,
  actorId: EmployeeId,
  employeeId: EmployeeId,
  at: number,
): number | null {
  const row = sql
    .exec<{ id: number }>(
      `SELECT id FROM org_edges
       WHERE employee_id = ? AND manager_id = ?
         AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC LIMIT 1`,
      employeeId, actorId, at, at,
    )
    .toArray()[0];
  return row ? row.id : null;
}

export class NoApproverError extends Error {
  readonly code = "KINTAI_NO_APPROVER";
  constructor(employeeId: EmployeeId) {
    super(
      `KINTAI_NO_APPROVER: employee ${employeeId} has no manager, no designated approver, and ` +
      `no 管理監督者 exemption. Give them one before saving this organisation.`,
    );
  }
}

/**
 * Whether this employee could ever have a submission approved. Self-approval is forbidden, so an
 * employee at the root of the org graph needs either an exemption (they raise no requests — see
 * `submitOvertime`'s own guard) or an explicit designated approver. Checked when organisation data
 * is written, so a misconfiguration surfaces then rather than when someone's request strands in
 * the queue.
 *
 * This must stay in lockstep with `submissions.ts`'s `requiredApprovers`/`authorize`, which decide
 * what an *actual* submission needs and who may act on it. Three deliberate departures from a
 * literal "does managersAt return anything" reading, to keep that lockstep:
 *
 *  - `managersAt` is filtered to `"report"` edges only, exactly as `requiredApprovers` filters. A
 *    live delegate can authorize an individual approval event (`authorize` accepts any edge kind),
 *    but `requiredApprovers` never counts one towards an `all_of` step's requirement, so an
 *    employee held up by nothing but a delegate can still see an `all_of` step's requirement stay
 *    permanently empty (and therefore permanently unsatisfied — see `requiredApprovers`'s own
 *    comment on this exact scenario). Counting the delegate here would pass an org shape that can
 *    still strand a submission, which is the one thing this function exists to prevent.
 *  - a manager edge naming the employee themself is filtered out. Self-approval is structurally
 *    forbidden (`actOnSubmission` checks it before anything else), so a self-reporting edge is a
 *    data error that can never actually be used to sign — it must not read as "approvable".
 *  - the designated-approver check goes through `designatedApproverOf` and rejects a self-
 *    reference, mirroring `requiredApprovers`'s "an employee recorded as their own designated
 *    approver collapses to the empty set and fails closed" rule.
 *
 * The 管理監督者 arm has no counterpart in `requiredApprovers`, and that asymmetry is deliberate,
 * not a bug: an exemption grants nobody authority to sign anything, so it can never contribute a
 * *required* approver. It answers a different question here — an exempt employee has no overtime
 * to approve in the first place, so needing zero approvers is fine.
 */
export function hasReachableApprover(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): boolean {
  const managers = managersAt(sql, employeeId, at, "report")
    .filter((id) => id !== employeeId);
  if (managers.length > 0) return true;

  if (isExempt(sql, employeeId, at)) return true;

  const designated = designatedApproverOf(sql, employeeId);
  return designated !== null && designated !== employeeId;
}

export function assertApproverReachable(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): void {
  if (!hasReachableApprover(sql, employeeId, at)) throw new NoApproverError(employeeId);
}
