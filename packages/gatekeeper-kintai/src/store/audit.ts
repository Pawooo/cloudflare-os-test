import type { EmployeeId } from "../types.js";

export type AuditEntry = {
  at: number;
  actorEmployeeId: EmployeeId | null;
  action: string;
  entity: string;
  entityId?: number;
  before?: unknown;
  after?: unknown;
};

export type AuditRow = {
  id: number;
  at: number;
  actor_employee_id: number | null;
  action: string;
  entity: string;
  entity_id: number | null;
  before: string | null;
  after: string | null;
};

/**
 * Authority-relevant changes only: account linking, org edges, exemptions, route configuration and
 * period locks. Attendance data is not duplicated here — punches, allocations and approval_events
 * are already append-only and are their own audit trail.
 */
export function appendAudit(sql: SqlStorage, entry: AuditEntry): void {
  sql.exec(
    `INSERT INTO audit_log
       (at, actor_employee_id, action, entity, entity_id, before, after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entry.at, entry.actorEmployeeId, entry.action, entry.entity, entry.entityId ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
  );
}

export function auditEntries(sql: SqlStorage): AuditRow[] {
  return sql.exec<AuditRow>(`SELECT * FROM audit_log ORDER BY id`).toArray();
}
