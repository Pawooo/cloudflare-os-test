import type { RosterEntry } from "../types.js";
import { isExempt, linkedEmployeeIds, listEmployees } from "./employees.js";
import { hasReachableApprover, managersAt } from "./org.js";

/**
 * The HR roster: `employees` composed with the account links and the org graph.
 *
 * Its own module because it is the one place that reads both: `org.ts` already imports
 * `employees.ts`, so this would either invert that dependency or close a cycle if it lived in
 * either. None of the four computed fields is a column, and none can be — each is an answer about
 * the state of another table at a given instant.
 *
 * The shape it returns is declared in `types.ts`; see `RosterEntry` there for why each field is
 * present and what it promises.
 */

/**
 * The whole roster, computed as of `at`.
 *
 * `at` is a parameter rather than `Date.now()` because everything temporal in this package takes
 * its instant from the caller — one read must judge every row against ONE moment, or a roster
 * fetched across a boundary could report two employees as of different times.
 *
 * Every computed field delegates to the function that already owns its rule: `linkedEmployeeIds`
 * shares its validity window with `resolveAccount`, `managersAt(…, "report")` and `isExempt` are
 * the same calls the approval path makes, and `approverReachable` is `hasReachableApprover`
 * itself — the function `submitOvertime` enforces through `assertApproverReachable`. Nothing here
 * re-derives a verdict from the parts, deliberately: `hasReachableApprover` has three careful
 * departures from a literal reading of the org tables (see its comment), and a roster that
 * recomputed the answer from `managerIds` and `exempt` would be a second implementation of the
 * rule that decides whether an employee can work at all.
 *
 * Unpaged, exactly as `listEmployees` is unpaged and for the same reason: this is one company's
 * headcount, the surface is admin-only, and under ~200 employees a page boundary costs more than
 * it saves. The per-row queries are indexed lookups inside the same SQLite instance, not round
 * trips.
 */
export function listRoster(sql: SqlStorage, at: number): RosterEntry[] {
  const linked = linkedEmployeeIds(sql, at);
  return listEmployees(sql).map((employee) => ({
    ...employee,
    linked: linked.has(employee.id),
    // "report" only, and self-edges dropped, matching what `hasReachableApprover` counts. A
    // manager column that listed an edge the verdict ignores would read as a contradiction.
    managerIds: managersAt(sql, employee.id, at, "report").filter((id) => id !== employee.id),
    exempt: isExempt(sql, employee.id, at),
    approverReachable: hasReachableApprover(sql, employee.id, at),
  }));
}
