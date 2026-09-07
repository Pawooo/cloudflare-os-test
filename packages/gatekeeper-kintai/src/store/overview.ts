// The dashboard's reads: four views over the same append-only facts every other module in this
// package already owns.
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
//
// `pendingOverview` is the fourth, and it is the same principle applied to a rule rather than to a
// number. It answers a question about AUTHORITY -- who can decide each waiting request -- and it
// answers it by asking `eligibleActors`, which asks `checkMayAct` once per candidate: the same
// function `actOnSubmission`, `previewAct` and the approval queue all go through. There is no
// route walking and no edge reading in this module, deliberately. A stored total that disagreed
// with the punches would be a wrong number; a second copy of "who may approve" that disagreed with
// the act check would be a dashboard that hides a stranded request or invents an approver for it,
// and this project has already shipped that bug once (see `checkMayAct`).

import { assertPeriod } from "../input.js";
import { currentPunches, dayAnomalies, workedMinutes } from "./punches.js";
import { periodLock } from "./periods.js";
import { eligibleActors, pendingSubmissions } from "./submissions.js";
import type {
  AnomalousDay, EmployeeDay, EmployeeId, MonthlyReport, MonthlyTotalRow, PendingItem,
} from "../types.js";

/*
 * The five read shapes this module produces, re-exported so worker-side callers -- `admin-api.ts`,
 * `KintaiStore` and the tests -- still read each one from the module that produces it.
 *
 * The declarations moved to `src/types.ts` on 2026-09-04. Until then `app/AdminPage.tsx` carried a
 * SECOND, hand-written copy of THREE of them -- `PendingItem`, `AnomalousDay` and `EmployeeDay`,
 * the three the dashboard rendered at the time -- because `import type` from this module pulls it
 * into the app's type program and every `SqlStorage` in this file becomes an error there. Two
 * copies compile clean in both projects when a field is renamed here, and the dashboard then
 * renders `undefined` -- see that module's "wire shapes" section. `MonthlyReport` and
 * `MonthlyTotalRow` were never restated: the 月次 tab landed after the move, and moving them with
 * the other three is why it never had to be.
 *
 * Nothing about how any of these rows is ASSEMBLED moved; that is still entirely below.
 */
export type { AnomalousDay, EmployeeDay, MonthlyReport, MonthlyTotalRow, PendingItem };

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
 * an approver and wrong here: the readers below name every employee who has a day in the month --
 * or, in `pendingOverview`, every employee named anywhere in the pending set, whose own employee,
 * whose filer and whose every eligible actor all resolve through ONE call -- and a label query per
 * row would turn one dashboard open into one round trip per employee. An empty `employeeIds` still
 * has to short-circuit -- `IN ()` is invalid SQL, and an empty month is exactly the case
 * `daysWithPunches` returns nothing for.
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

/**
 * Every submission waiting on somebody, with how long it has waited and who could act on it.
 *
 * THE ONE READ IN THIS SYSTEM THAT CAN SEE A STRANDED REQUEST. Every other surface is scoped to a
 * person: `listSubmissionsFor` shows an employee their own requests, which they may not decide, and
 * `pendingApprovalsFor` shows an approver what they can act on. A submission nobody may act on —
 * filed by its only possible approver, or left behind by an org change that closed the last edge
 * reaching it — appears on neither, and sat in `pending` unseen by anyone. That is the failure this
 * function exists to make visible, so an empty `eligibleActorIds` is REPORTED, never filtered:
 * dropping those rows would leave the screen looking healthiest precisely when the queue is worst.
 *
 * `eligibleActors` per row, and it is a probe of `checkMayAct` — not a rule this module owns. See
 * its comment for why the candidate set is the whole roster and why an empty answer here means
 * stranded (these rows are all `pending`, the one state in which "nobody may act" cannot be
 * explained by the submission already being settled).
 *
 * The names are ONE query, after the eligible sets are known rather than before: an employee's own
 * name, their filer's, and every eligible actor's all come out of a single `labelsFor` over the
 * union of those ids. Resolving them per row would be one round trip per name on the read whose
 * whole cost is already O(pending × roster) authority probes.
 *
 * Rows come back in the approval queue's own order -- `submitted_at`, then id -- which is longest
 * wait first, and so already the order this screen wants to be read in. It is the queue's order
 * because it is the queue's query (see `pendingSubmissions`), not because this read chose one.
 *
 * `waitingMs` is measured against the caller's `now`, like every other instant in this package, so
 * one dashboard open judges every row against ONE moment. A null `submitted_at` — no column
 * records when it started waiting — reports 0 rather than `now - 0`, which would be fifty-six years
 * and would sort a row with no known age above every real one.
 */
export function pendingOverview(sql: SqlStorage, now: number): PendingItem[] {
  const pending = pendingSubmissions(sql);
  if (pending.length === 0) return [];

  const eligible = new Map<number, EmployeeId[]>(
    pending.map((row) => [row.id, eligibleActors(sql, row.id, now)]),
  );

  const named = new Set<number>();
  for (const row of pending) {
    named.add(row.employee_id);
    if (row.created_by !== null) named.add(row.created_by);
    for (const actorId of eligible.get(row.id)!) named.add(actorId);
  }
  const labels = labelsFor(sql, [...named]);

  return pending.map((row) => {
    const employee = labels.get(row.employee_id)!;
    const actorIds = eligible.get(row.id)!;
    return {
      ...row,
      employeeName: employee.display_name,
      employeeNumber: employee.employee_number,
      filedByName: row.created_by === null
        ? null
        : labels.get(row.created_by)!.display_name,
      waitingMs: row.submitted_at === null ? 0 : now - row.submitted_at,
      eligibleActorIds: actorIds,
      eligibleActorNames: actorIds.map((actorId) => labels.get(actorId)!.display_name),
    };
  });
}
