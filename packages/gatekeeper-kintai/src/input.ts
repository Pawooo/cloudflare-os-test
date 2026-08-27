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
    throw new InvalidInputError(`${label} must be an employee id.`);
  }
}
