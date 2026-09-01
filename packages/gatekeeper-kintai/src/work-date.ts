import type { WorkDatePolicy } from "./types.js";

/**
 * How an instant becomes a work date, in the one module both sides of the package can reach.
 *
 * `jstWorkDate` used to live in `kintai.ts`, which was fine while only the session facet needed
 * it. Attribution now happens in the store — `store/punches.ts` has to fall back to the calendar
 * date when no shift is open — and `kintai.ts` imports the store, so leaving it there would close
 * a cycle. Same reason `input.ts` exists: a rule two boundaries share moves to a leaf rather than
 * being written twice. `kintai.ts` re-exports `jstWorkDate` so every existing importer is
 * unaffected.
 */

/** JST calendar date for a UTC instant. JST has no DST, so a fixed +9h offset is correct. */
export function jstWorkDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The longest a shift may run before `shift_start` stops attributing punches to it: 16 hours.
 *
 * This is the guard that makes `shift_start` safe rather than dangerous. Without it a forgotten
 * clock-out swallows everything after it — clock in Friday evening, forget to clock out, clock in
 * Monday, and Monday's punch is filed against Friday. Sixteen hours sits comfortably above any
 * legitimate shift including overtime, and low enough that a forgotten punch surfaces the next day
 * rather than days later.
 *
 * Measured from the START of the shift — the earliest unpaired `in` on the day, which is what
 * `pairSpans` reports as `openAt` — and never from its most recent punch. A break punched fifteen
 * hours in must not buy the shift another sixteen, and neither must a SECOND `in`: the version of
 * this that bounded only the candidate query let each fresh `in` inside the window roll the window
 * forward while the span stayed open at the original clock-in, chaining to 66 hours on one day
 * behind a single `duplicate_in` flag. `openShiftWorkDate` applies this to `openAt` itself; the
 * bound in its candidate query is a prefilter and is documented there as one.
 */
export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;

/**
 * A day whose paired clock-in/clock-out time reaches this is flagged `long_span`: 14 hours.
 *
 * `MAX_SHIFT_MS` stops `shift_start` from ATTRIBUTING a punch to a stale shift. It says nothing
 * about the day that results, and that left a hole: a `shift_start` employee who clocked in at
 * 22:00 and out fifteen hours later got a single fully-credited day with NO anomaly at all, where
 * the same punches under `calendar` had always produced two flagged, zero-credit days a human had
 * to resolve. The very argument for 16 hours — that it "sits comfortably above any legitimate
 * shift" — is why a credited 15h50m day must not pass silently.
 *
 * So this is deliberately NOT a property of the policy. It is applied by `dayAnomalies` to every
 * employee, because the same punches must not carry different flags depending on a setting, and
 * because a 15-hour credited day is a payroll exception for an office worker too. It adds flags to
 * `calendar` days that previously had none and changes no credited minutes anywhere.
 *
 * Fourteen hours, chosen between two hard edges:
 *  - It must clear a legitimate 12-hour rotation (二交代制), which is an ordinary pattern here and
 *    must never flag. Twelve hours of scheduled work plus its unpaid breaks and an hour or two of
 *    handover or overtime still fits under fourteen.
 *  - It must stay STRICTLY below `MAX_SHIFT_MS`, so that the whole remaining band in which
 *    `shift_start` still inherits (14h to 16h) is a band a human is told about. Set at or above
 *    16h it would be unreachable for the case it exists to catch.
 *
 * Compared with `>=`, so fourteen hours exactly flags. The threshold is the first anomalous value,
 * not the last acceptable one — unlike `MAX_SHIFT_MS`, where 16h exactly is the first instant a
 * shift stops attracting punches.
 */
export const LONG_SPAN_MS = 14 * 60 * 60 * 1000;

/**
 * Every work-date policy, in the order the HR form offers them.
 *
 * Written once and shared: the admin form renders it, and the schema's CHECK constraint is the
 * backstop. Nothing in `input.ts` reads this list — the RPC boundary is where a bad value is
 * refused, and it refuses one from the `WorkDatePolicy` TYPE rather than from this array
 * (`@validateRpc()` on `AdminKintaiApi.setWorkDatePolicy`; see the comment in its body). This
 * array is the runtime enumeration of that same union, for the one caller that has to iterate it.
 * A third policy is added here, to the union in `types.ts`, and to the schema's CHECK.
 */
export const WORK_DATE_POLICIES: readonly WorkDatePolicy[] = ["calendar", "shift_start"];

/** How each policy reads to a human, for the HR form and for nothing else. */
export const WORK_DATE_POLICY_LABELS: Record<WorkDatePolicy, string> = {
  calendar: "Calendar date (office staff)",
  shift_start: "Shift start date (night shifts)",
};
