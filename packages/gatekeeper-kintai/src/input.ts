/**
 * Input validation for every untrusted boundary in this package, in one place.
 *
 * These rules used to be module-private in `kintai.ts`, where the only untrusted boundary was the
 * agent-facing session. The HR admin app added a second one — `AdminKintaiApi` takes typed-in form
 * values — and `kintai.ts` imports `admin-api.ts`, so `admin-api.ts` cannot import back from it
 * without a cycle. Extracting them is what lets both boundaries call the SAME `assertWorkDate`
 * rather than growing a second date validator that drifts: this package has already produced real
 * bugs from two copies of one rule disagreeing.
 *
 * `kintai.ts` re-exports `InvalidInputError` so existing importers of it are unaffected.
 */

import { PUNCH_KINDS } from "./types.js";
import { jstWorkDate } from "./work-date.js";

/**
 * Rejects malformed input at the untrusted boundary.
 *
 * A raw SQLite CHECK violation would surface as an uncoded error the RPC boundary can only turn
 * into a 500, and most of these values reach no CHECK at all: `Date.parse("banana")` is `NaN` and
 * `periodOf("banana")` is `"banana"`, so junk dates sail past the exemption, approver-reachability
 * and period-lock queries and persist. Coded, like `SubmissionNotFoundError`, because a malformed
 * argument is an ordinary client mistake.
 */
export class InvalidInputError extends Error {
  readonly code = "KINTAI_INVALID_INPUT";
  constructor(detail: string) {
    super(`KINTAI_INVALID_INPUT: ${detail}`);
  }
}

/**
 * A time that has not happened yet, offered as the time something happened.
 *
 * Separate from `InvalidInputError` because the remedy is different and worth saying: the caller
 * is not malformed, they named the wrong instant. See `assertNotFuture` for why the bound exists
 * at all.
 */
export class FutureOccurrenceError extends Error {
  readonly code = "KINTAI_FUTURE_OCCURRENCE";
  constructor(label: string) {
    super(
      `KINTAI_FUTURE_OCCURRENCE: ${label} may not be in the future. Give the time the punch ` +
      `should have been made, not a time still to come.`,
    );
  }
}

const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real JST calendar date in `YYYY-MM-DD` form.
 *
 * The round-trip is not redundant with the pattern: "2026-02-31" and "2026-13-01" both match it,
 * and `Date.parse` silently rolls them over into March and January rather than failing.
 */
export function assertWorkDate(label: string, value: string): void {
  if (typeof value !== "string" || !WORK_DATE.test(value)) {
    throw new InvalidInputError(`${label} must be a calendar date in YYYY-MM-DD form.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidInputError(`${label} is not a real calendar date: ${value}.`);
  }
}

const PERIOD = /^\d{4}-\d{2}$/;

/**
 * A real JST calendar month in `YYYY-MM` form.
 *
 * `assertWorkDate`'s shape, one field shorter, and for the same reason: `"2026-13"` matches the
 * pattern and `Date.parse` would roll it into next January rather than failing, and `"2026-1"` is
 * simply not the form every period-keyed table (`period_locks`, and the `WHERE work_date LIKE ?`
 * scans in `store/overview.ts`) is written against. That LIKE pattern is exactly why this is worth
 * asserting rather than trusting: `periodOf` and `periodOfSql` never produce anything but a real
 * `YYYY-MM`, so a malformed period reaching `daysWithPunches` is not a value those functions could
 * have written -- it can only be a caller's mistake, and a wildcard character in it would change
 * which rows the LIKE scan matches rather than simply finding none.
 */
export function assertPeriod(label: string, value: string): void {
  if (typeof value !== "string" || !PERIOD.test(value)) {
    throw new InvalidInputError(`${label} must be a calendar month in YYYY-MM form.`);
  }
  const parsed = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 7) !== value) {
    throw new InvalidInputError(`${label} is not a real calendar month: ${value}.`);
  }
}

/** One of the four punch kinds; the schema's CHECKs are the backstop, not the message. */
export function assertPunchKind(label: string, value: string): void {
  if (!(PUNCH_KINDS as readonly string[]).includes(value)) {
    throw new InvalidInputError(
      `${label} must be one of ${PUNCH_KINDS.join(", ")}, and is ${JSON.stringify(value)}.`,
    );
  }
}

/**
 * A punch may not be dated in the future.
 *
 * Its own code rather than `KINTAI_INVALID_INPUT`, because unlike a malformed date this is a
 * well-formed value the caller can act on: they meant a time that has already passed and gave one
 * that has not. The two cases below therefore split — a non-instant is malformed input, a future
 * instant is a refused request.
 *
 * This is not hygiene. A prior review found that a future-dated punch is read as an open shift by
 * `openShiftWorkDate` and can then cause a genuine punch arriving before it to be silently
 * discarded by duplicate suppression. It was rated low severity ONLY because nothing in the system
 * let a human choose a punch time. Filing an amendment is the first path that does, so the bound
 * lands with it rather than after it.
 *
 * Lives here, beside `assertWorkDate`, so the store's write and any boundary that wants to refuse
 * earlier call the same rule instead of growing a second copy that drifts.
 */
export function assertNotFuture(label: string, value: number, now: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidInputError(`${label} must be a finite timestamp in milliseconds.`);
  }
  // The reference instant is checked too, and it is not paranoia: every comparison with `NaN` is
  // false, so a caller passing `NaN` for `now` would not be told the bound was skipped — the
  // future value would simply be accepted. A guard that can be switched off by one bad argument
  // is not a guard.
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new InvalidInputError(`now must be a finite timestamp in milliseconds.`);
  }
  if (value > now) {
    throw new FutureOccurrenceError(label);
  }
}

/**
 * A month that has not started yet, offered as a month to close.
 *
 * `FutureOccurrenceError`'s sibling, and separate from `InvalidInputError` for the same reason:
 * the value is well formed and the caller named the wrong one. Its own code, because the remedy is
 * specific and an app should be able to say it — check the year.
 *
 * The message names BOTH months. The accident this exists for is a mistyped year ("2027-08" for
 * "2026-08") on a control whose confirmation then reads "closed", so the one thing the reader
 * needs is to see the month they asked for next to the month it actually is. The irreversibility
 * is stated too, because it is what makes the mistake expensive rather than annoying.
 */
export class FuturePeriodError extends Error {
  readonly code = "KINTAI_FUTURE_PERIOD";
  constructor(label: string, value: string, current: string) {
    super(
      `KINTAI_FUTURE_PERIOD: ${label} ${value} has not started yet — the current month is ` +
      `${current}. Check the year. A month can only be closed once it has begun, and closing ` +
      `one cannot be undone.`,
    );
  }
}

/**
 * A period that is the current JST month or an earlier one.
 *
 * WHY THIS BOUND EXISTS, and it is not hygiene: `period_locks` has no unlock anywhere in this
 * package, and a closed month refuses every ordinary write into it. A period accepted here is
 * therefore permanent, so a well-formed month a year away is not a harmless row — when it arrives,
 * every `punch()` and every `setAllocations` in it is refused company-wide, and the only way back
 * is editing the Durable Object by hand. `assertPeriod` cannot catch it: "2027-08" is a perfectly
 * real calendar month.
 *
 * CURRENT OR EARLIER, deliberately, and not "the month must have ended". Closing the live month on
 * its last day is the ordinary payroll case, and the admin dashboard's end-to-end does exactly
 * that; a rule that waited for the month to be over would refuse the one close HR actually makes.
 *
 * `now` is a parameter rather than a `Date.now()` read inside, exactly as `assertNotFuture` takes
 * one: the caller that will write `locked_at` passes the same instant it compares with, so the
 * refusal and the row can never disagree about what time it is. It is checked for finiteness for
 * `assertNotFuture`'s reason — every comparison with `NaN` is false, so one bad argument would
 * silently switch the bound off rather than report it.
 *
 * The comparison is a STRING comparison, which is correct only because both sides are fixed-width
 * zero-padded `YYYY-MM`: `assertPeriod` guarantees that of `value`, and `jstWorkDate` of `current`.
 * Call `assertPeriod` first — the store's `lockPeriod` does — or "banana" reads as the future.
 *
 * The +9h offset is not restated here: the current month is `jstWorkDate` sliced, so there is one
 * copy of that arithmetic (see `work-date.ts`) and this cannot drift from what a punch's work date
 * would be at the same instant.
 */
export function assertNotFuturePeriod(label: string, value: string, now: number): void {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new InvalidInputError(`now must be a finite timestamp in milliseconds.`);
  }
  const current = jstWorkDate(now).slice(0, 7);
  if (value > current) {
    throw new FuturePeriodError(label, value, current);
  }
}

/** Minutes are whole and never negative; the schema's CHECKs are the backstop, not the message. */
export function assertMinutes(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidInputError(`${label} must be a whole number of minutes, and not negative.`);
  }
}

/**
 * Size limits on everything a caller can write into the store.
 *
 * The store is ONE Durable Object holding every employee's payroll record, and the code calling
 * the session facet is a Gadget the employee can rewrite at will. Nothing downstream bounds these:
 * the schema's CHECK constraints cover value ranges, never lengths, so an unbounded string or
 * array is a way for any one employee to consume storage every other employee depends on. A single
 * call capped here is worth roughly 100 KB rather than however much the caller felt like sending.
 *
 * The numbers are chosen to sit far above any honest use and far below anything that hurts:
 *
 *  - 200 allocation entries — a day split across 200 distinct projects is already implausible.
 *  - 64 characters of project code — an accounting code, not prose.
 *  - 500 characters of note, per entry — a line of explanation for one project line.
 *  - 2,000 characters of overtime reason — a paragraph or two, which is what an approver reads.
 *  - 2,000 characters of approval comment — the same, from the other side.
 *
 * The last group bounds the HR admin form fields, which the same reasoning covers for a different
 * reason: an administrator is trusted, but a typo pasted from a spreadsheet still lands in the
 * shared store, and `display_name` is rendered in every approver's queue.
 *
 *  - 64 characters of employee number — a payroll code.
 *  - 200 characters of display name, 120 of department, 64 of employment type.
 *  - 200 characters of account code — a UUID today, with room for whatever mints them next.
 *
 * These are boundary-level input validation, alongside `assertWorkDate`/`assertMinutes`. They are
 * NOT a rate limit: nothing here stops a caller making the same bounded call a million times,
 * which stays an open item for the store layer.
 */
export const LIMITS = {
  allocationEntries: 200,
  projectCode: 64,
  note: 500,
  reason: 2_000,
  comment: 2_000,
  employeeNumber: 64,
  displayName: 200,
  department: 120,
  employmentType: 64,
  accountId: 200,
} as const;

/** A caller-supplied string that lands in the shared store: must be a string, and bounded. */
export function assertText(label: string, value: string, maxLength: number): void {
  if (typeof value !== "string") {
    throw new InvalidInputError(`${label} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new InvalidInputError(
      `${label} must be at most ${maxLength} characters (received ${value.length}).`,
    );
  }
}

/**
 * A bounded string that must also carry something.
 *
 * Blank is rejected rather than normalised away: `employees.display_name` is NOT NULL but has no
 * CHECK against emptiness, so `""` inserts happily and then shows up as a nameless row in every
 * approver's queue — a record HR can neither recognise nor easily correct. Whitespace-only counts
 * as blank for the same reason. The value is stored exactly as given; this rejects, it does not
 * rewrite, because silently altering an identifier HR typed is its own surprise.
 */
export function assertRequiredText(label: string, value: string, maxLength: number): void {
  assertText(label, value, maxLength);
  if (value.trim() === "") {
    throw new InvalidInputError(`${label} is required.`);
  }
}

/**
 * A reference to an employee record: a positive integer, because `employees.id` is
 * `INTEGER PRIMARY KEY AUTOINCREMENT` and therefore always one.
 *
 * This is shape only, and deliberately not existence. Whether the row exists is a question for the
 * store — see `assertEmployeeExists` — and answering it here would need a query this function has
 * no handle to make.
 */
export function assertEmployeeId(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidInputError(`${label} must be a positive employee id.`);
  }
}
