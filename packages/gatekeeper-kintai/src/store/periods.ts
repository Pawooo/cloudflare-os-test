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
  sql.exec(
    `INSERT OR REPLACE INTO period_locks (period, locked_at, locked_by) VALUES (?, ?, ?)`,
    period, now, lockedBy,
  );
}

export function assertWritable(sql: SqlStorage, workDate: string): void {
  if (isLocked(sql, workDate)) throw new PeriodLockedError(periodOf(workDate));
}
