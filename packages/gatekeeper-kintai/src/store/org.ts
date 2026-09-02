import type { EmployeeId } from "../types.js";
import { designatedApproverOf } from "./employees.js";

// The org graph is temporal because audits ask "was this person actually X's manager on 3 July?".
// A non-temporal table cannot answer that after any reorganisation, and every company reorganises.
// Delegation reuses the reporting-line shape with a bounded window, so a manager on leave does not
// silently stall their team's submissions.

/**
 * Opens a reporting edge and returns its id.
 *
 * The id is returned so an audit trail can name the exact row: a reporting line grants approval
 * authority over another employee, and an entry that cannot be joined back to the edge it created
 * only records that *something* changed.
 */
export function setReportingLine(
  sql: SqlStorage,
  employeeId: EmployeeId,
  managerId: EmployeeId,
  from: number,
  to?: number,
): number {
  return sql
    .exec<{ id: number }>(
      `INSERT INTO org_edges (employee_id, manager_id, kind, valid_from, valid_to)
       VALUES (?, ?, 'report', ?, ?) RETURNING id`,
      employeeId, managerId, from, to ?? null,
    )
    .one().id;
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

/** One reporting edge, whole, as the HR org view shows it. */
export type ReportingLineRow = {
  id: number;
  employee_id: number;
  manager_id: number;
  valid_from: number;
  valid_to: number | null;
};

/**
 * Every reporting edge ever written, oldest first — closed windows included.
 *
 * `kind = 'report'` only. A delegate is a bounded stand-in for an absent manager, not a line of
 * report: `requiredApprovers` already refuses to count one towards an `all_of` step, and
 * `hasReachableApprover` filters them out for the same reason. Listing them here would put them in
 * front of an admin as though they were part of the org chart.
 *
 * Closed edges are kept because the graph is temporal: an admin looking at today's chart has to be
 * able to tell "this line was closed in July" from "this person never reported to anyone".
 */
export function listReportingLines(sql: SqlStorage): ReportingLineRow[] {
  return sql
    .exec<ReportingLineRow>(
      `SELECT id, employee_id, manager_id, valid_from, valid_to
       FROM org_edges WHERE kind = 'report' ORDER BY id`,
    )
    .toArray();
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
       -- 'id DESC' is not decoration: two edges can share a valid_from (a same-instant transfer,
       -- or a bulk org import), and without a secondary key SQLite may return either one. The id
       -- that comes back is written into approval_events.authorizing_edge, so an arbitrary
       -- tie-break would put an arbitrary edge in the audit trail. Newest row wins.
       ORDER BY valid_from DESC, id DESC LIMIT 1`,
      employeeId, actorId, at, at,
    )
    .toArray()[0];
  return row ? row.id : null;
}

export class NoApproverError extends Error {
  readonly code = "KINTAI_NO_APPROVER";
  constructor(employeeId: EmployeeId) {
    super(
      `KINTAI_NO_APPROVER: employee ${employeeId} has no manager and no designated approver, so ` +
      `nobody could approve anything they file -- a punch correction included, which a 管理監督者 ` +
      `exemption does not excuse them from needing. Ask an administrator to set a reporting line, ` +
      `or a designated approver if they report to nobody.`,
    );
  }
}

/**
 * Whether somebody could approve what this employee files. Self-approval is forbidden, so an
 * employee at the root of the org graph needs an explicit designated approver — see
 * `setDesignatedApprover`, which is how one is given to somebody created before anybody existed
 * to point at. Checked at every write that depends on the answer, so a misconfiguration surfaces
 * there rather than when someone's request strands in a queue nobody can see.
 *
 * AN EXEMPTION IS NOT AN APPROVER, and this function used to say it was. 管理監督者 answers a
 * different question — "is this employee's overtime premium-bearing?" — and `submitOvertime`
 * refuses an exempt filer outright because of it, so for a while the two questions could not be
 * told apart from here: an exempt employee never reached this function with anything to approve.
 *
 * Two things broke that coincidence. `938639c` split the instants, asking about exemption on the
 * work date and about reachability at `now`, so an employee not exempt on the day they worked but
 * exempt by the day they filed passed both gates and stranded. And amendments arrived: a
 * correction to an exempt officer's punches is an ordinary request needing an ordinary human,
 * `requiredApprovers` never counts an exemption towards a step, and `authorize` has neither an
 * edge nor a designated approver to fall back on — so the request was accepted into nobody's
 * queue, on the record of the person whose hours most warrant a second reader.
 *
 * The arm is gone rather than made conditional. One function that answers one question is the
 * whole point of this one existing: `authorize`, `requiredApprovers` and `hasReachableApprover`
 * each answer a version of "who may approve for this employee" — `pendingApprovalsFor` used to be
 * a fourth and now asks `checkMayAct` instead — and this package has already shipped a bug from
 * one of them quietly disagreeing. A second variant here,
 * or a flag saying which caller is asking, is that bug's next opportunity.
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
 *    approver collapses to the empty set and fails closed" rule. `setDesignatedApprover` refuses
 *    to write one; this stays as the backstop, because the column predates that method.
 *
 * Every arm now has a counterpart in `requiredApprovers`, which is what it means for the two to be
 * in lockstep: this answers "is that set ever non-empty?", nothing more.
 */
export function hasReachableApprover(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): boolean {
  const managers = managersAt(sql, employeeId, at, "report")
    .filter((id) => id !== employeeId);
  if (managers.length > 0) return true;

  const designated = designatedApproverOf(sql, employeeId);
  return designated !== null && designated !== employeeId;
}

export function assertApproverReachable(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): void {
  if (!hasReachableApprover(sql, employeeId, at)) throw new NoApproverError(employeeId);
}
