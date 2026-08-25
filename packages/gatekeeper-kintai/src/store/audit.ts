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

// Normalises an optional before/after value for storage: omitted, undefined, and an explicit
// null all mean "no value" and must all land as SQL NULL — not the JSON text "null", which would
// pass the json_valid CHECK but silently break `WHERE before IS NULL` and hand readers a literal
// "null" string instead of a real null. Anything else is stringified as JSON.
function toJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

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
    toJsonColumn(entry.before),
    toJsonColumn(entry.after),
  );
}

export function auditEntries(sql: SqlStorage): AuditRow[] {
  return sql.exec<AuditRow>(`SELECT * FROM audit_log ORDER BY id`).toArray();
}
