import type { EmployeeId } from "../types.js";
import { workedMinutes } from "./punches.js";

export type AllocationEntry = { projectCode: string; minutes: number; note?: string };

export type AllocationRow = {
  id: number;
  employee_id: number;
  work_date: string;
  project_code: string;
  minutes: number;
  note: string | null;
  version: number;
  superseded_by: number | null;
};

export type Reconciliation = {
  allocatedMinutes: number;
  workedMinutes: number;
  /** allocated - worked. Negative means under-allocated. Never a rejection. */
  discrepancyMinutes: number;
};

export function currentAllocations(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): AllocationRow[] {
  return sql
    .exec<AllocationRow>(
      `SELECT * FROM day_allocations
       WHERE employee_id = ? AND work_date = ? AND superseded_by IS NULL
       ORDER BY id`,
      employeeId, workDate,
    )
    .toArray();
}

export function allAllocations(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): AllocationRow[] {
  return sql
    .exec<AllocationRow>(
      `SELECT * FROM day_allocations WHERE employee_id = ? AND work_date = ? ORDER BY id`,
      employeeId, workDate,
    )
    .toArray();
}

export function reconcile(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): Reconciliation {
  const allocated = currentAllocations(sql, employeeId, workDate)
    .reduce((sum, row) => sum + row.minutes, 0);
  const worked = workedMinutes(sql, employeeId, workDate);
  return {
    allocatedMinutes: allocated,
    workedMinutes: worked,
    discrepancyMinutes: allocated - worked,
  };
}

/**
 * Replace the day's allocations with a new version. Prior rows are marked superseded rather than
 * deleted, so a day's allocation history stays readable.
 *
 * Version numbers are drawn from the full history of the day (MAX(version) across every row,
 * current or superseded), not from the currently-active rows. This matters because a call can
 * legitimately write zero rows (clearing a day's allocations entirely, e.g. after a punch
 * correction invalidates a prior split): if the next version number were derived from
 * `currentAllocations`, a cleared day would have no current row to read a version number from and
 * the sequence would silently reset to 1, colliding with history instead of advancing past it. A
 * zero-row call consumes no version number in the table (nothing is written), so a later
 * non-empty call may legitimately reuse the number the empty call computed and discarded — there
 * is nothing for it to collide with.
 */
export function setAllocations(
  sql: SqlStorage,
  employeeId: EmployeeId,
  workDate: string,
  entries: AllocationEntry[],
): Reconciliation {
  const previous = currentAllocations(sql, employeeId, workDate);

  const maxVersion = sql
    .exec<{ v: number | null }>(
      `SELECT MAX(version) AS v FROM day_allocations WHERE employee_id = ? AND work_date = ?`,
      employeeId, workDate,
    )
    .one().v;
  const version = (maxVersion ?? 0) + 1;

  const inserted: number[] = [];
  for (const entry of entries) {
    const row = sql
      .exec<{ id: number }>(
        `INSERT INTO day_allocations
           (employee_id, work_date, project_code, minutes, note, version, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL) RETURNING id`,
        employeeId, workDate, entry.projectCode, entry.minutes, entry.note ?? null, version,
      )
      .one();
    inserted.push(row.id);
  }

  // Point each superseded row at the first row of the new version, so the chain is traceable.
  // When the new version writes zero rows (clearing the day), there is no successor row to point
  // to; each superseded row is marked with a self-reference instead. A self-reference is always a
  // valid, already-existing id (the row being updated), so it satisfies the foreign key without
  // fabricating a pointer to a row that doesn't exist, while still being non-NULL so
  // `currentAllocations`'s `superseded_by IS NULL` filter correctly excludes it.
  const successor = inserted[0] ?? null;
  for (const old of previous) {
    sql.exec(
      `UPDATE day_allocations SET superseded_by = ? WHERE id = ?`,
      successor ?? old.id, old.id,
    );
  }

  return reconcile(sql, employeeId, workDate);
}
