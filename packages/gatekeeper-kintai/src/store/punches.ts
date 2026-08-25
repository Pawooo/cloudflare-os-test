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
  /** Server time. Never accept a client-supplied timestamp. */
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
      input.employeeId, input.workDate, input.kind, input.now, input.now, input.source,
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

  return insert(sql, input, null, null, null);
}

/**
 * Correct a punch by appending a replacement that references it. The original row is never
 * updated: an auditor must be able to see what was first recorded, when, and who changed it.
 */
export function correctPunch(
  sql: SqlStorage,
  supersedesId: number,
  input: NewPunch,
  amendedBy: EmployeeId,
  reason: string,
): number {
  return insert(sql, input, supersedesId, amendedBy, reason);
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

/**
 * Worked minutes for the day: paired in/out spans, less paired break spans. An unpaired `in` — the
 * forgot-to-clock-out case — contributes nothing and is deliberately NOT auto-closed; the facet
 * surfaces it as an exception instead. An auto-closed shift is a fabricated record.
 */
export function workedMinutes(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): number {
  const punches = currentPunches(sql, employeeId, workDate);

  const span = (openKind: PunchKind, closeKind: PunchKind): number => {
    let total = 0;
    let openedAt: number | null = null;
    for (const punch of punches) {
      if (punch.kind === openKind && openedAt === null) openedAt = punch.occurred_at;
      else if (punch.kind === closeKind && openedAt !== null) {
        total += punch.occurred_at - openedAt;
        openedAt = null;
      }
    }
    return total;
  };

  const gross = span("in", "out") - span("break_start", "break_end");
  return Math.max(0, Math.round(gross / 60_000));
}
