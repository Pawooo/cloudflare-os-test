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
 * Measured from the START of the shift, never from its most recent punch: a break punched fifteen
 * hours in must not buy the shift another sixteen.
 */
export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;

/**
 * Every work-date policy, in the order the HR form offers them.
 *
 * Written once and shared: `input.ts` validates against this list, the admin form renders it, and
 * the schema's CHECK constraint is the backstop behind both. A third policy is added here.
 */
export const WORK_DATE_POLICIES: readonly WorkDatePolicy[] = ["calendar", "shift_start"];

/** How each policy reads to a human, for the HR form and for nothing else. */
export const WORK_DATE_POLICY_LABELS: Record<WorkDatePolicy, string> = {
  calendar: "Calendar date (office staff)",
  shift_start: "Shift start date (night shifts)",
};
