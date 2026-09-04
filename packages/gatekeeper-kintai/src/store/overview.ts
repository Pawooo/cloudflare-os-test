// The dashboard's plain reads: three views over the same append-only facts every other module in
// this package already owns.
//
// Nothing here is a new rule. `anomalousDays`, `monthlyTotals` and `employeeDay` all answer their
// questions by asking `currentPunches`, `workedMinutes` and `dayAnomalies` -- the SAME functions
// `KintaiSession.getDay` uses -- once per (employee, day) that has punches. There is no stored
// total and no cached anomaly list anywhere in this module, and that is deliberate: `workedMinutes`
// and `dayAnomalies` are derived from `punches`, which is append-only, so a stored aggregate would
// be a SECOND COPY of a fact the punch table already answers -- one that could disagree with it the
// moment an amendment is applied. "Closed ≠ frozen" (see `monthlyReport.locked`) only means what it
// says because there is nowhere for a stale number to hide: an approved correction changes the
// punches, and the very next read of this module walks those punches again and reports the new
// total. See `daysWithPunches` for the one query this module owns for itself.

import { assertPeriod } from "../input.js";
import { currentPunches, dayAnomalies, workedMinutes, type PunchRow } from "./punches.js";
import { periodLock } from "./periods.js";
import type { EmployeeId } from "../types.js";

/** Every (employee, day) in the month that holds punches -- the only days that can have state. */
function daysWithPunches(
  sql: SqlStorage, period: string,
): { employee_id: number; work_date: string }[] {
  return sql.exec<{ employee_id: number; work_date: string }>(
    `SELECT DISTINCT employee_id, work_date FROM punches
     WHERE work_date LIKE ? ORDER BY employee_id, work_date`,
    `${period}-%`,
  ).toArray();
}

/**
 * `display_name` and `employee_number` for a set of employees, in one query.
 *
 * `employeeLabel` answers this one id at a time, which is right for describing a single action to
 * an approver and wrong here: both readers below name every employee who has a day in the month,
 * and a label query per row would turn one dashboard open into one round trip per employee. An
 * empty `employeeIds` still has to short-circuit -- `IN ()` is invalid SQL, and an empty month is
 * exactly the case `daysWithPunches` returns nothing for.
 */
function labelsFor(
  sql: SqlStorage, employeeIds: number[],
): Map<number, { display_name: string; employee_number: string }> {
  if (employeeIds.length === 0) return new Map();
  const placeholders = employeeIds.map(() => "?").join(", ");
  const rows = sql
    .exec<{ id: number; display_name: string; employee_number: string }>(
      `SELECT id, display_name, employee_number FROM employees WHERE id IN (${placeholders})`,
      ...employeeIds,
    )
    .toArray();
  return new Map(rows.map((row) => [row.id, row]));
}

export type AnomalousDay = {
  employeeId: number;
  displayName: string;
  employeeNumber: string;
  workDate: string;
  anomalies: string[];
};

/**
 * Every (employee, day) in `period` whose anomaly list is non-empty, with the flags themselves.
 *
 * The dashboard's exception queue: one row per day a human should look at, not one row per day
 * worked. A day with punches but no anomalies is filtered out here rather than left for the caller
 * to filter, because "which days need attention" is this function's whole job and a caller that
 * forgot the filter would otherwise get a silently wrong queue.
 */
export function anomalousDays(sql: SqlStorage, period: string): AnomalousDay[] {
  assertPeriod("period", period);

  const days = daysWithPunches(sql, period);
  if (days.length === 0) return [];

  const labels = labelsFor(sql, [...new Set(days.map((day) => day.employee_id))]);
  const result: AnomalousDay[] = [];
  for (const { employee_id: employeeId, work_date: workDate } of days) {
    const anomalies = dayAnomalies(sql, employeeId, workDate);
    if (anomalies.length === 0) continue;
    const label = labels.get(employeeId)!;
    result.push({
      employeeId,
      displayName: label.display_name,
      employeeNumber: label.employee_number,
      workDate,
      anomalies,
    });
  }
  return result;
}

export type MonthlyTotalRow = {
  employeeId: number;
  displayName: string;
  employeeNumber: string;
  daysWorked: number;
  workedMinutes: number;
  anomalousDays: number;
};

/**
 * `locked` sits on the report, not on a row: `period_locks` is keyed on the period alone, so every
 * row in one `monthlyTotals` call describes the same month under the same lock and there is nothing
 * for a per-row flag to disagree about. One report, one period, one lock verdict.
 */
export type MonthlyReport = { period: string; locked: boolean; rows: MonthlyTotalRow[] };

/**
 * One row per employee who has punches in `period`: days worked, minutes credited, and how many of
 * those days are flagged.
 *
 * `locked` is read from `periodLock`, the same table `assertWritable` checks -- not re-derived, so
 * this can never disagree with what actually blocks an ordinary write. It says nothing about
 * whether the numbers beside it can still move: a locked period accepts exactly one write, an
 * approved amendment (see `actOnAmendment`), and a `monthlyTotals` call made after one walks the
 * punches it wrote like any other. Locked closes the front door; it does not freeze the ledger.
 */
export function monthlyTotals(sql: SqlStorage, period: string): MonthlyReport {
  assertPeriod("period", period);

  const locked = periodLock(sql, period) !== null;
  const days = daysWithPunches(sql, period);
  if (days.length === 0) return { period, locked, rows: [] };

  const totals = new Map<
    number, { daysWorked: number; workedMinutes: number; anomalousDays: number }
  >();
  for (const { employee_id: employeeId, work_date: workDate } of days) {
    const entry = totals.get(employeeId) ?? { daysWorked: 0, workedMinutes: 0, anomalousDays: 0 };
    entry.daysWorked += 1;
    entry.workedMinutes += workedMinutes(sql, employeeId, workDate);
    if (dayAnomalies(sql, employeeId, workDate).length > 0) entry.anomalousDays += 1;
    totals.set(employeeId, entry);
  }

  const labels = labelsFor(sql, [...totals.keys()]);
  const rows: MonthlyTotalRow[] = [...totals.entries()].map(([employeeId, entry]) => {
    const label = labels.get(employeeId)!;
    return {
      employeeId,
      displayName: label.display_name,
      employeeNumber: label.employee_number,
      ...entry,
    };
  });

  return { period, locked, rows };
}

export type EmployeeDay = {
  punches: PunchRow[];
  anomalies: string[];
  workedMinutes: number;
};

/**
 * One employee's one day, as an admin would need to see it to decide whether it needs fixing: the
 * current punches, the flags they raise, and the minutes they credit.
 *
 * The same three calls `KintaiSession.getDay` makes for the employee's own view, because an admin
 * looking at somebody else's day must see exactly what that employee sees -- a second computation
 * here, even one that agreed today, is a second place for `workedMinutes` and `dayAnomalies` to
 * drift apart from tomorrow.
 */
export function employeeDay(sql: SqlStorage, employeeId: EmployeeId, workDate: string): EmployeeDay {
  return {
    punches: currentPunches(sql, employeeId, workDate),
    anomalies: dayAnomalies(sql, employeeId, workDate),
    workedMinutes: workedMinutes(sql, employeeId, workDate),
  };
}
