import { jstClockTime, jstWorkDate } from "../work-date.js";
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

/**
 * Thrown when a period that is already closed is closed again.
 *
 * A DIFFERENT AUDIENCE from `PeriodLockedError`, which is the whole reason it is a different error
 * with its own code rather than a reuse of that one. `PeriodLockedError` answers somebody trying
 * to WRITE into a closed month and tells them the one thing they can still do: file an amendment.
 * This answers an administrator who has just pressed "close this month" on a month that is already
 * closed — a double-click, or a screen a colleague has already acted on. Telling them to file an
 * amendment would send them to correct a record they never meant to touch. What they need is that
 * the close they asked for has already happened, by whom and when, so they can see whether it was
 * them a moment ago or somebody else last week.
 *
 * The instant is rendered in JST, like every other instant this package shows a human (see
 * `jstClockTime`): the record is a Japanese payroll record and a UTC timestamp in a message about
 * a calendar month is nine hours of confusion.
 *
 * The code is repeated in the message, as every other error in this package does, because `code`
 * is a plain own property and does not survive the RPC boundary — the browser receives the message
 * and nothing else.
 */
export class AlreadyLockedError extends Error {
  readonly code = "KINTAI_ALREADY_LOCKED";
  constructor(period: string, lock: PeriodLock) {
    super(
      `KINTAI_ALREADY_LOCKED: ${period} is already closed — employee ${lock.lockedBy} closed it ` +
      `on ${jstWorkDate(lock.lockedAt)} at ${jstClockTime(lock.lockedAt)} JST. It stays closed, ` +
      `and this call changed nothing.`,
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

/**
 * Close `period`, recording who closed it and when. Refuses a period that is already closed.
 *
 * THE REFUSAL LIVES HERE, in the same synchronous run as the INSERT, and deliberately not at the
 * admin boundary that calls it. Two reasons, and the first is a race no boundary can close: a
 * check in `AdminKintaiApi.lockPeriod` would read `period_locks` over one RPC and write over
 * another, so two administrators pressing the button at the same moment would both read "open" and
 * both be told they closed the month — falsely for one of them, because there is only ever one
 * row. Here the read and the write are one turn of the store's input gate and nothing can arrive
 * between them. The second reason is ownership: whether a period is closed, and who closed it, is
 * this module's fact, and the refusal's message needs both.
 *
 * That is the OPPOSITE of where the ordinary write refusal lives. `assertWritable` is enforced by
 * the callers (`KintaiSession.punch`) rather than inside the store's write functions, because the
 * amendment path must be able to write into a closed period and reaches the store directly — the
 * store's writes therefore cannot enforce locks for everyone. Nothing needs a bypass for closing a
 * month twice: there is no unlock anywhere in this package, so a second close can never be a
 * legitimate re-close after a reopen. It is a duplicate call.
 *
 * A plain INSERT, where this was `INSERT OR IGNORE`. Keeping the FIRST close is still right and is
 * still what happens — nothing here overwrites `locked_at`/`locked_by` — but a silent no-op is
 * indistinguishable from success to whoever called, and until now the only callers were tests. An
 * administrator pressing a button is somebody who can be misled by it. With the guard above in the
 * same run, `OR IGNORE` could now only hide a bug.
 *
 * If a reopen-then-reclose flow is ever introduced this needs revisiting: it would have to record
 * the new close explicitly, which it would need to do anyway to record the reopen itself.
 */
export function lockPeriod(
  sql: SqlStorage, period: string, lockedBy: EmployeeId, now: number,
): void {
  const existing = periodLock(sql, period);
  if (existing) throw new AlreadyLockedError(period, existing);
  sql.exec(
    `INSERT INTO period_locks (period, locked_at, locked_by) VALUES (?, ?, ?)`,
    period, now, lockedBy,
  );
}

export function assertWritable(sql: SqlStorage, workDate: string): void {
  if (isLocked(sql, workDate)) throw new PeriodLockedError(periodOf(workDate));
}

export type PeriodLock = { lockedAt: number; lockedBy: EmployeeId };

/**
 * The lock record for `period`, or null if it isn't locked.
 *
 * NOT test-only introspection, which is what this said until the admin dashboard landed. Three
 * production callers read it now: `monthlyTotals` for the report's `locked` flag, `lockPeriod`
 * just above to refuse a second close, and `AdminKintaiApi.lockPeriod` for the audit entry's
 * `before`. It is the one read that answers "who closed this month, and when" — which is the first
 * question asked of a closed month.
 */
export function periodLock(sql: SqlStorage, period: string): PeriodLock | null {
  const row = sql
    .exec<{ locked_at: number; locked_by: EmployeeId }>(
      `SELECT locked_at, locked_by FROM period_locks WHERE period = ?`, period,
    )
    .toArray()[0];
  return row ? { lockedAt: row.locked_at, lockedBy: row.locked_by } : null;
}
