import type { EmployeeId } from "../types.js";

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
