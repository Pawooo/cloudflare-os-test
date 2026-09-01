import type { EmployeeId, LocationSource, PunchKind, PunchSource } from "../types.js";
import { LONG_SPAN_MS, MAX_SHIFT_MS, jstWorkDate } from "../work-date.js";
import { workDatePolicyOf } from "./employees.js";
import { matchSite } from "./sites.js";

export type PunchLocation = {
  source: LocationSource;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
};

export type NewPunch = {
  employeeId: EmployeeId;
  workDate: string;
  kind: PunchKind;
  /**
   * The punch's `occurred_at` — always server-determined, never a client-supplied timestamp.
   * For `recordPunch` this is simply the current server time. For `correctPunch` this is the
   * corrected `occurred_at` the punch should have carried, which may be earlier than the
   * original. The moment the correction was actually entered is `correctPunch`'s separate
   * `recordedAt` parameter, not this field — the two must not be conflated.
   */
  now: number;
  source: PunchSource;
  location?: PunchLocation;
};

export type PunchRow = {
  id: number;
  employee_id: number;
  work_date: string;
  kind: PunchKind;
  occurred_at: number;
  recorded_at: number;
  source: PunchSource;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  location_source: LocationSource | null;
  matched_site_id: number | null;
  supersedes_id: number | null;
  amended_by: number | null;
  amend_reason: string | null;
};

/** A repeat of the same kind inside this window is treated as a double-tap, not a new punch. */
export const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Every column a `PunchRow` carries, joined back together from the two tables that hold them.
 *
 * The location columns live in `punch_locations` (see schema.ts: coordinates are purgeable on a
 * shorter clock than the punch, and `punches` is append-only) but reads present one flat row, so
 * a caller never has to know where the split runs. LEFT JOIN, because most punches have no
 * location at all; the columns then read as NULL exactly as they did when they sat on the punch.
 */
const PUNCH_COLUMNS = `
  p.id, p.employee_id, p.work_date, p.kind, p.occurred_at, p.recorded_at, p.source,
  l.latitude, l.longitude, l.accuracy_m, l.location_source, l.matched_site_id,
  p.supersedes_id, p.amended_by, p.amend_reason`;

const PUNCH_SOURCE = `punches p LEFT JOIN punch_locations l ON l.punch_id = p.id`;

function insert(
  sql: SqlStorage,
  input: NewPunch,
  recordedAt: number,
  supersedesId: number | null,
  amendedBy: EmployeeId | null,
  amendReason: string | null,
): number {
  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO punches
         (employee_id, work_date, kind, occurred_at, recorded_at, source,
          supersedes_id, amended_by, amend_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.employeeId, input.workDate, input.kind, input.now, recordedAt, input.source,
      supersedesId, amendedBy, amendReason,
    )
    .one();

  // A location row is written whenever the caller offered a location at all — a denied or
  // unavailable fix carries no coordinates but is still recorded, because "the punch was made
  // without a fix" is information and is not the same as never having been asked.
  //
  // Both the raw coordinates and the evaluated match are stored: site boundaries are redrawn over
  // time, so a dispute needs the evaluation as it stood AND the underlying data.
  const loc = input.location;
  if (loc) {
    const hasFix = loc.latitude !== undefined && loc.longitude !== undefined;
    const siteId = hasFix ? matchSite(sql, loc.latitude!, loc.longitude!, input.now) : null;
    sql.exec(
      `INSERT INTO punch_locations
         (punch_id, latitude, longitude, accuracy_m, location_source, matched_site_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      hasFix ? loc.latitude! : null,
      hasFix ? loc.longitude! : null,
      loc.accuracyM ?? null,
      loc.source ?? null,
      siteId,
    );
  }

  return row.id;
}

/**
 * Append a punch. Returns the existing punch's id when it lands inside the duplicate window with
 * the same kind, so a double-tap does not create a second record or surface an error.
 */
export function recordPunch(sql: SqlStorage, input: NewPunch): number {
  const recent = sql
    .exec<{ id: number }>(
      `SELECT p.id FROM punches p
       WHERE p.employee_id = ? AND p.work_date = ? AND p.kind = ?
         AND p.occurred_at > ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       ORDER BY p.occurred_at DESC LIMIT 1`,
      input.employeeId, input.workDate, input.kind, input.now - DUPLICATE_WINDOW_MS,
    )
    .toArray()[0];
  if (recent) return recent.id;

  return insert(sql, input, input.now, null, null, null);
}

/**
 * Correct a punch by appending a replacement that references it. The original row is never
 * updated: an auditor must be able to see what was first recorded, when, and who changed it.
 *
 * `input.now` is the corrected `occurred_at` (which may be earlier than the original's).
 * `recordedAt` is the real moment the correction was entered, kept separate so a backdated
 * correction doesn't also erase the record of when the correction itself was made — that is the
 * one fact an auditor most needs and it must not be overwritten by the value being corrected.
 *
 * Rejected:
 *  - a correction whose `employeeId`, `workDate` or `kind` don't match the row it claims to
 *    supersede — a correction may not be used to move a punch onto a different person, day, or
 *    kind, only to fix the recorded time/source/location of the same event.
 *  - a second correction of an already-superseded row — enforced by the database's partial
 *    unique index on `supersedes_id` (see schema.ts), not by an application check here, because
 *    "at most one current correction per punch" is an invariant later tasks rely on and must hold
 *    regardless of caller.
 */
export function correctPunch(
  sql: SqlStorage,
  supersedesId: number,
  input: NewPunch,
  amendedBy: EmployeeId,
  reason: string,
  recordedAt: number,
): number {
  const original = sql
    .exec<PunchRow>(`SELECT ${PUNCH_COLUMNS} FROM ${PUNCH_SOURCE} WHERE p.id = ?`, supersedesId)
    .toArray()[0];
  if (!original) {
    throw new Error(`correctPunch: no punch with id ${supersedesId}`);
  }
  if (
    original.employee_id !== input.employeeId ||
    original.work_date !== input.workDate ||
    original.kind !== input.kind
  ) {
    throw new Error(
      "correctPunch: correction must match the employee, work date and kind of the punch it supersedes",
    );
  }

  return insert(sql, input, recordedAt, supersedesId, amendedBy, reason);
}

/** Punches for the day that nothing supersedes. */
export function currentPunches(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): PunchRow[] {
  return sql
    .exec<PunchRow>(
      `SELECT ${PUNCH_COLUMNS} FROM ${PUNCH_SOURCE}
       WHERE p.employee_id = ? AND p.work_date = ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       ORDER BY p.occurred_at`,
      employeeId, workDate,
    )
    .toArray();
}

/** Every punch for the day including superseded ones, oldest first. */
export function allPunches(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): PunchRow[] {
  return sql
    .exec<PunchRow>(
      `SELECT ${PUNCH_COLUMNS} FROM ${PUNCH_SOURCE}
       WHERE p.employee_id = ? AND p.work_date = ? ORDER BY p.id`,
      employeeId, workDate,
    )
    .toArray();
}

type PairResult = {
  /** Total milliseconds across all closed open/close pairs. */
  totalMs: number;
  /** `occurred_at` of a still-open span at the end of the day's punches, or null if none is open. */
  openAt: number | null;
  /** Count of open-kind punches seen while a span of this kind was already open. */
  duplicateOpens: number;
  /** Count of close-kind punches seen with no open span pending. */
  orphanCloses: number;
};

/** Pair up open/close punches of the given kinds, in chronological order, ignoring other kinds. */
function pairSpans(punches: PunchRow[], openKind: PunchKind, closeKind: PunchKind): PairResult {
  let totalMs = 0;
  let openAt: number | null = null;
  let duplicateOpens = 0;
  let orphanCloses = 0;
  for (const punch of punches) {
    if (punch.kind === openKind) {
      if (openAt === null) openAt = punch.occurred_at;
      else duplicateOpens++;
    } else if (punch.kind === closeKind) {
      if (openAt !== null) {
        totalMs += punch.occurred_at - openAt;
        openAt = null;
      } else {
        orphanCloses++;
      }
    }
  }
  return { totalMs, openAt, duplicateOpens, orphanCloses };
}

type DayTotals = {
  inOut: PairResult;
  brk: PairResult;
  /**
   * Break milliseconds, with an unpaired `break_start` extended through the day's last punch so
   * an open break fails safe by under-crediting worked time rather than over-crediting it.
   */
  breakMs: number;
  /**
   * Gross worked milliseconds before clamping to zero. Negative means the punches are internally
   * inconsistent (e.g. a break recorded as longer than the shift that contains it).
   */
  grossMs: number;
};

function computeDayTotals(punches: PunchRow[]): DayTotals {
  const inOut = pairSpans(punches, "in", "out");
  const brk = pairSpans(punches, "break_start", "break_end");

  // An open break is not auto-closed with a fabricated end time; it's charged through to the last
  // thing we know happened that day instead. This is the mirror image of the unpaired-`in` rule:
  // failing safe here means assuming the break ran long, not crediting work that was never
  // confirmed to have happened. Extending a break in this conservative, under-crediting direction
  // is not the fabrication the no-auto-close principle forbids.
  let breakMs = brk.totalMs;
  if (brk.openAt !== null && punches.length > 0) {
    const lastAt = punches[punches.length - 1].occurred_at;
    breakMs += Math.max(0, lastAt - brk.openAt);
  }

  const grossMs = inOut.totalMs - breakMs;
  return { inOut, brk, breakMs, grossMs };
}

/**
 * Worked minutes for the day: paired in/out spans, less paired break spans. An unpaired `in` — the
 * forgot-to-clock-out case — contributes nothing and is deliberately NOT auto-closed; the facet
 * surfaces it as an exception instead. An auto-closed shift is a fabricated record.
 *
 * An unpaired `break_start` is handled asymmetrically (see `computeDayTotals`): it is charged
 * through to the day's last punch rather than contributing zero, because crediting it as worked
 * time would be exactly the fabrication the no-auto-close rule forbids, just in the direction that
 * benefits the timesheet instead of the direction that costs it.
 */
export function workedMinutes(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): number {
  const punches = currentPunches(sql, employeeId, workDate);
  const { grossMs } = computeDayTotals(punches);
  return Math.max(0, Math.round(grossMs / 60_000));
}

/**
 * Data-quality flags for the day's current punches, surfaced so a human resolves them rather than
 * the system guessing or silently clamping:
 *  - `unpaired_in`: a clock-in with no matching clock-out.
 *  - `unpaired_break`: a break start with no matching break end.
 *  - `orphan_out`: a clock-out with no preceding clock-in.
 *  - `duplicate_in`: a second clock-in recorded before the first was closed by a clock-out.
 *  - `negative_gross`: paired break time exceeds paired work time, i.e. the day's punches are
 *    internally inconsistent. `workedMinutes` clamps this case to zero; this flag is the signal
 *    that a zero doesn't just mean "no work happened."
 *  - `long_span`: the day's paired clock-in/clock-out time reaches `LONG_SPAN_MS`. Unlike the
 *    others this one flags a day whose punches are perfectly well-formed, which is the point: a
 *    forgotten clock-out that a later clock-out eventually closed is a fully-credited day with
 *    nothing else wrong with it. See `LONG_SPAN_MS` for why the threshold is where it is, and why
 *    this is applied regardless of `work_date_policy`.
 *
 * The list is policy-independent by construction: it is computed from the punches filed against
 * one work date and never reads `work_date_policy`. Two employees on different policies whose
 * punches ended up on the same day get the same flags.
 */
export function dayAnomalies(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): string[] {
  const punches = currentPunches(sql, employeeId, workDate);
  const { inOut, brk, grossMs } = computeDayTotals(punches);

  const anomalies: string[] = [];
  if (inOut.openAt !== null) anomalies.push("unpaired_in");
  if (brk.openAt !== null) anomalies.push("unpaired_break");
  if (inOut.orphanCloses > 0) anomalies.push("orphan_out");
  if (inOut.duplicateOpens > 0) anomalies.push("duplicate_in");
  if (grossMs < 0) anomalies.push("negative_gross");
  // Measured on `inOut.totalMs` — the paired clock-in-to-clock-out time — and not on `grossMs`,
  // because a fourteen-hour presence with a long break inside it is still a fourteen-hour day a
  // human should look at, and because `grossMs` can be dragged negative by the very inconsistency
  // `negative_gross` reports. Appended last so the flags a caller already knows keep the order
  // they always had.
  if (inOut.totalMs >= LONG_SPAN_MS) anomalies.push("long_span");
  return anomalies;
}

/**
 * The work date a punch made at `now` belongs to, for this employee.
 *
 * THE one implementation of work-date attribution. Every punch that enters the system through the
 * session facet gets its date from here and from nowhere else, which is the point: this package
 * has twice shipped bugs from two copies of one rule drifting apart, and "which day is this?" is
 * the rule that decides what a night worker is paid.
 *
 * Two policies, read from the employee's own record (see `WorkDatePolicy`):
 *
 *  - `calendar`, the default and the common case, is `jstWorkDate(now)` and nothing else. This
 *    function must be transparent for those employees — no query, no open-shift lookup, no way for
 *    a change here to re-file an office worker's punches. It returns before any punch-table access
 *    and before `kind` is even looked at.
 *  - `shift_start` inherits the date of the shift that is open right now, so 22:00 → 06:00 lands
 *    entirely on the start date. With no shift open it falls back to the calendar date, which is
 *    also what a shift-start employee's first punch of the day gets.
 *
 * `kind` is the kind of the punch being filed, and it is needed for the duplicate-window exception
 * in `openShiftWorkDate` — which mirrors `recordPunch`'s suppression, and `recordPunch` suppresses
 * on (employee, work date, kind). Without it the exception could only key on time, and an `in`
 * tapped thirty seconds after a clock-out was filed onto the closed shift's date as though it were
 * a double-tap of it.
 *
 * It answers a question and writes nothing, so asking it twice for the same instant and the same
 * table contents gives the same answer. That determinism is what `commitPunch` relies on: the
 * facet checks the period lock against the answer this gives, and the store then asks again under
 * the write's own input gate and refuses if the punches moved underneath it. See `commitPunch`.
 */
export function workDateFor(
  sql: SqlStorage, employeeId: EmployeeId, now: number, kind: PunchKind,
): string {
  if (workDatePolicyOf(sql, employeeId) === "shift_start") {
    const openShift = openShiftWorkDate(sql, employeeId, now, kind);
    if (openShift !== null) return openShift;
  }
  return jstWorkDate(now);
}

/**
 * The work date of the shift this employee has open at `now`, or null if they have none.
 *
 * Two steps, and only the second of them is the 16-hour guard.
 *
 *  1. PREFILTER — which day might hold an open shift? The employee's most recent unsuperseded
 *     `in` at or before `now`, restricted to the last `MAX_SHIFT_MS` so the read is served by
 *     `punches_by_time` instead of scanning the employee's whole history. This is NOT the guard.
 *     It picks a candidate DAY; it does not decide anything. A shift-opening `in` is dated by the
 *     calendar (nothing was open when it was made), so the candidate row's own `work_date` is the
 *     date the shift belongs to.
 *
 *     Why the prefilter can never hide a shift the guard below would have accepted: the guard
 *     accepts a day D only when D's `openAt` — the earliest unpaired `in` on it — satisfies
 *     `now - openAt < MAX_SHIFT_MS`, so that very `in` is itself inside the prefilter's window and
 *     D is reachable. The prefilter could still pick a DIFFERENT day only if some later `in` were
 *     filed against another date while D's span was open; for an employee on `shift_start` that
 *     cannot happen, because every such `in` goes through this function, and at the earlier
 *     instant it was filed `now - openAt` was smaller still, so it was attributed to D. The one
 *     way to construct the divergence is to file `in`s under `calendar` in between (a mid-shift
 *     policy switch — see `AdminKintaiApi.setWorkDatePolicy`) or through a future import path that
 *     chooses `work_date` itself. In that case the prefilter picks the MORE RECENT `in`'s day,
 *     which is the shift the employee is actually standing in; if that one is closed the punch
 *     falls back to the calendar date, which under-credits rather than over-credits.
 *
 *     `occurred_at <= now` closes the other end. Without it a punch dated in the future — not
 *     reachable through `punch()` today, but `punches.source` already anticipates `'import'` —
 *     would be returned as "the open shift" for every query instant after it, forever.
 *
 *  2. THE GUARD — is that shift still open, and is it still young enough to claim this punch?
 *     Openness is asked of `pairSpans`, the SAME pairing `workedMinutes` and `dayAnomalies` use:
 *     "there is an open shift" and "this day is flagged `unpaired_in`" are one fact and must not
 *     be able to disagree. The 16-hour bound is then applied to `openAt` ITSELF — the shift's
 *     start — and that is the whole guard. Bounding only the prefilter, as this once did, let each
 *     new `in` inside the window roll the window forward while the span stayed open at the
 *     original clock-in: `in` 22:00, `in` +12h, +24h, +36h, +48h, +60h, `out` +66h filed 66 hours
 *     onto one day behind a single `duplicate_in`. Past the bound the punch is refused the
 *     inheritance, the stale day keeps the `unpaired_in` it always had, and the new punch starts a
 *     fresh shift on its own calendar date.
 *
 * ...and one exception, which is not a third rule but the second one held open for a minute, for
 * exactly the punches `recordPunch` would suppress. A shift that closed less than
 * `DUPLICATE_WINDOW_MS` ago still claims a punch OF A KIND ALREADY ON THAT DAY INSIDE THAT WINDOW.
 * Without it a double-tapped clock-out is a silent data-quality bug: the first tap closes the
 * shift, so the second finds nothing open, falls back to the calendar date, and lands on the NEXT
 * day — where `recordPunch`'s duplicate suppression cannot see it, because that is keyed on
 * (employee, work date, kind). The result is a spurious `orphan_out` on a day the employee never
 * worked, produced by tapping a button twice.
 *
 * The kind test is what makes that claim true rather than merely plausible. Keyed on time alone,
 * the exception also caught an `in` tapped seconds after a clock-out — a genuine new shift, which
 * `recordPunch` would never suppress — and filed it, and everything after it, onto the closed
 * shift's date: 14:00 in, 23:59:40 out, 00:00:10 in, 09:00 out became a single 19-hour day with no
 * anomaly at all, and across a month boundary it put a new shift into a month a period lock would
 * have refused it from. The predicate here is `recordPunch`'s, term for term: same employee, same
 * work date, same kind, unsuperseded, `occurred_at > now - DUPLICATE_WINDOW_MS`. If it does not
 * hold, suppression would not fire either, so the exception buys nothing and only costs a wrong
 * record.
 *
 * Superseded punches are excluded throughout, so a corrected clock-in is read as the correction
 * says, never as it was first entered.
 */
function openShiftWorkDate(
  sql: SqlStorage, employeeId: EmployeeId, now: number, kind: PunchKind,
): string | null {
  const lastIn = sql
    .exec<{ work_date: string }>(
      `SELECT p.work_date FROM punches p
       WHERE p.employee_id = ? AND p.kind = 'in'
         AND p.occurred_at > ? AND p.occurred_at <= ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       ORDER BY p.occurred_at DESC LIMIT 1`,
      employeeId, now - MAX_SHIFT_MS, now,
    )
    .toArray()[0];
  if (!lastIn) return null;

  const punches = currentPunches(sql, employeeId, lastIn.work_date);
  const { openAt } = pairSpans(punches, "in", "out");
  if (openAt !== null) {
    return now - openAt < MAX_SHIFT_MS ? lastIn.work_date : null;
  }

  // The shift on this day is closed. It may still claim the punch, but only for the minute in
  // which `recordPunch` would swallow it as a double-tap of something already filed there.
  const suppressible = punches.some(
    (punch) => punch.kind === kind && punch.occurred_at > now - DUPLICATE_WINDOW_MS,
  );
  return suppressible ? lastIn.work_date : null;
}

/**
 * Thrown by `commitPunch` when the work date it recomputes under the write gate is not the one the
 * caller validated. See `commitPunch` for why that is a refusal rather than a correction.
 *
 * The code is repeated in the message, as every other error in this package does, because `code`
 * is a plain own property and does not survive the RPC boundary — the facet receives the message
 * and nothing else, so the message is the only place the code can be read from. `isWorkDateRaced`
 * is that read, written once here rather than as a regex at the call site.
 */
export class WorkDateRacedError extends Error {
  readonly code = "KINTAI_WORK_DATE_RACED";
  constructor(expected: string, actual: string) {
    super(
      `KINTAI_WORK_DATE_RACED: this punch was validated against ${expected} but now belongs to ` +
      `${actual}; another punch landed in between.`,
    );
  }
}

/** Whether a value thrown across the store's RPC boundary is a `WorkDateRacedError`. */
export function isWorkDateRaced(caught: unknown): boolean {
  return caught instanceof Error && caught.message.startsWith("KINTAI_WORK_DATE_RACED");
}

/**
 * Record a punch, deciding its work date under the same input gate that writes it.
 *
 * `KintaiSession.punch` cannot do this by itself. It has to ask `workDateFor` first, because the
 * period lock must be checked against the date the punch will LAND on and for a `shift_start`
 * employee that is not today's — and each RPC into this Durable Object is its own input-gated
 * turn, so between "is a shift open?" and "write it" the gate opens and another punch can land.
 * Concurrent `punch("out")` and `punch("in")` both read the same open shift; the `out` closed it,
 * and the `in` was then filed against a shift that no longer existed, leaving `unpaired_in` and a
 * fresh open shift on yesterday's date.
 *
 * So the date is decided twice and the second one is the decision. `input.workDate` is what the
 * caller validated; this recomputes it from `input.now` — the SAME instant, so the recomputation
 * is a function of the punch table alone — and refuses if the two disagree. Everything from that
 * recomputation to the INSERT happens in one synchronous run with no `await` in it, so no other
 * turn can interleave: this is a compare-and-set, not a re-check followed by a hopeful write.
 *
 * It REFUSES rather than silently filing against the recomputed date. The caller validated a
 * period lock against `input.workDate`, and quietly writing somewhere else would step around it —
 * which is the whole reason the lock check lives in the facet. The facet retries the sequence once
 * against the new date, lock check included; see `KintaiSession.punch`.
 */
export function commitPunch(sql: SqlStorage, input: NewPunch): number {
  const actual = workDateFor(sql, input.employeeId, input.now, input.kind);
  if (actual !== input.workDate) throw new WorkDateRacedError(input.workDate, actual);
  return recordPunch(sql, input);
}
