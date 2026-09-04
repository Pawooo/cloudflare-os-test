import type { EmployeeId } from "../types.js";

/**
 * The lock is what makes append-only storage mean something: without it, "append-only" only means
 * the table grows. After a period closes, punches and allocations for it are writable only through
 * the amendment path, which requires approval and stays permanently visible.
 */
export class PeriodLockedError extends Error {
  readonly code = "KINTAI_PERIOD_LOCKED";
  constructor(period: string) {
    super(
      `KINTAI_PERIOD_LOCKED: ${period} is closed. Submit an amendment for approval instead of ` +
      `editing the record directly.`,
    );
  }
}

/** "2026-07-03" -> "2026-07". work_date is already a JST calendar date. */
export function periodOf(workDate: string): string {
  return workDate.slice(0, 7);
}

/**
 * `periodOf`, as a SQL expression over a `work_date` column.
 *
 * For the reads that need the period of MANY rows at once and so cannot call `isLocked` per row —
 * the approval queue joins `period_locks` on this, because a lock lookup per pending amendment is
 * a round trip per row on a query that runs on every queue open.
 *
 * A second statement of the same rule, and therefore a drift risk: it exists only because a
 * TypeScript function cannot appear in a join condition. `__tests__/periods.test.ts` asserts the
 * two agree on the same inputs, mechanically, so that changing one and not the other fails.
 */
export function periodOfSql(workDateColumn: string): string {
  return `substr(${workDateColumn}, 1, 7)`;
}

export function isLocked(sql: SqlStorage, workDate: string): boolean {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM period_locks WHERE period = ?`, periodOf(workDate),
    )
    .one();
  return row.n > 0;
}

export function lockPeriod(
  sql: SqlStorage, period: string, lockedBy: EmployeeId, now: number,
): void {
  // OR IGNORE, not OR REPLACE: there is no unlock anywhere in this package, so a second call for
  // an already-locked period cannot be a legitimate re-close after a reopen — it's a duplicate
  // call. The first close is the fact worth keeping for audit ("who closed this, and when"), so a
  // repeat becomes a harmless no-op rather than silently overwriting locked_at/locked_by. If a
  // reopen-then-reclose flow is ever introduced, this needs revisiting — it would have to record
  // the new close explicitly, which it would need to do anyway to record the reopen itself.
  sql.exec(
    `INSERT OR IGNORE INTO period_locks (period, locked_at, locked_by) VALUES (?, ?, ?)`,
    period, now, lockedBy,
  );
}

export function assertWritable(sql: SqlStorage, workDate: string): void {
  if (isLocked(sql, workDate)) throw new PeriodLockedError(periodOf(workDate));
}

export type PeriodLock = { lockedAt: number; lockedBy: EmployeeId };

/** The lock record for `period`, or null if it isn't locked. Test-only introspection. */
export function periodLock(sql: SqlStorage, period: string): PeriodLock | null {
  const row = sql
    .exec<{ locked_at: number; locked_by: EmployeeId }>(
      `SELECT locked_at, locked_by FROM period_locks WHERE period = ?`, period,
    )
    .toArray()[0];
  return row ? { lockedAt: row.locked_at, lockedBy: row.locked_by } : null;
}
