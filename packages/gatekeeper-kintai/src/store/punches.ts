import type { EmployeeId, LocationSource, PunchKind, PunchSource } from "../types.js";
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

function insert(
  sql: SqlStorage,
  input: NewPunch,
  recordedAt: number,
  supersedesId: number | null,
  amendedBy: EmployeeId | null,
  amendReason: string | null,
): number {
  // Both the raw coordinates and the evaluated match are stored: site boundaries are redrawn over
  // time, so a dispute needs the evaluation as it stood AND the underlying data.
  const loc = input.location;
  const hasFix = loc?.latitude !== undefined && loc?.longitude !== undefined;
  const siteId = hasFix ? matchSite(sql, loc!.latitude!, loc!.longitude!, input.now) : null;

  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO punches
         (employee_id, work_date, kind, occurred_at, recorded_at, source,
          latitude, longitude, accuracy_m, location_source, matched_site_id,
          supersedes_id, amended_by, amend_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.employeeId, input.workDate, input.kind, input.now, recordedAt, input.source,
      hasFix ? loc!.latitude! : null,
      hasFix ? loc!.longitude! : null,
      loc?.accuracyM ?? null,
      loc?.source ?? null,
      siteId,
      supersedesId, amendedBy, amendReason,
    )
    .one();
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
    .exec<PunchRow>(`SELECT * FROM punches WHERE id = ?`, supersedesId)
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
      `SELECT * FROM punches p
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
      `SELECT * FROM punches WHERE employee_id = ? AND work_date = ? ORDER BY id`,
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
  return anomalies;
}
