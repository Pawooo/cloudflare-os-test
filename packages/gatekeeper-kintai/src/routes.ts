import type { EmployeeId, StepRule } from "./types.js";

export type RouteConfig = {
  id: number;
  name: string;
  department: string | null;
  employmentType: string | null;
  minMinutes: number;
};

export type RouteStep = {
  stepIndex: number;
  rule: StepRule;
  /**
   * "manager" resolves against the org graph at approval time, so authority correctly follows the
   * current organisation. "employee" pins a specific approver into the snapshot.
   */
  approverKind: "manager" | "employee";
  approverEmployeeId: EmployeeId | null;
};

export type RouteSnapshot = { routeId: number; steps: RouteStep[] };

export type RouteCriteria = {
  department: string | null;
  employmentType: string | null;
  minutes: number;
};

export type NewRoute = {
  name: string;
  department?: string;
  employmentType?: string;
  minMinutes?: number;
  steps: Omit<RouteStep, "stepIndex">[];
};

export class NoRouteError extends Error {
  readonly code = "KINTAI_NO_ROUTE";
  /**
   * `detail` replaces the default message for the other way a request can end up with no usable
   * route: a route matched, but its steps cannot ever be satisfied. The `code` is deliberately the
   * same — from the caller's side both mean "an administrator must fix the route configuration".
   */
  constructor(detail?: string) {
    super(detail
      ?? "No approval route matches this request. Ask an administrator to configure one.");
  }
}

/**
 * Most specific match wins, where specificity is a strict priority order, not a peer comparison:
 *   1. a route scoped to the employee's `department` outranks one that is not,
 *   2. among routes tied on `department`, one also scoped to `employmentType` outranks one that
 *      isn't,
 *   3. a route scoped to neither (the catch-all) always loses to both of the above.
 * `department` is therefore strictly dominant over `employmentType` — a route scoped only by
 * `employmentType` (specificity 1) never outranks one scoped only by `department` (specificity 2),
 * even though both are "one axis more specific than the catch-all." This is a deliberate product
 * choice (encoded by the 2-vs-1 weights below), not an incidental tie-break.
 *
 * Only among routes tied on specificity does the highest minute threshold the request actually
 * clears win. This means specificity is decided FIRST and totally overrides `minMinutes`: a more
 * specific route with a low (or zero) threshold always beats a less specific route with a high
 * threshold, even when the request clears that higher threshold. Concretely, if department
 * "CONSTRUCTION" has both a `{department: "CONSTRUCTION", employmentType: "FULL_TIME",
 * minMinutes: 0}` route and a generic `{department: "CONSTRUCTION", minMinutes: 2700}` escalation
 * route intended to route heavy overtime to a higher tier, the first route's higher specificity
 * (2 dept + 1 type = 3) beats the second's lower specificity (2 dept + 0 type = 2) for every
 * full-time construction request, regardless of `minutes` — the 2700-minute escalation tier never
 * fires for that department's full-time staff, silently and with no error. Threshold-based
 * escalation tiers only compete against each other within the SAME specificity level; every
 * department (or department+employment-type combination) that needs its own escalation ladder
 * must define its own threshold tiers at that same specificity level rather than relying on a
 * less-specific tier to catch the overflow.
 *
 * Ties on both specificity AND `minMinutes` are broken by `id ASC` — see `resolveRoute`, which
 * feeds candidates to this function in that order, and this function's stable left-to-right
 * reduce, which keeps the first (i.e. lowest-id, earliest-created) candidate on an exact tie.
 */
export function selectRoute(
  candidates: RouteConfig[],
  criteria: RouteCriteria,
): RouteConfig | null {
  const eligible = candidates.filter((route) =>
    (route.department === null || route.department === criteria.department) &&
    (route.employmentType === null || route.employmentType === criteria.employmentType) &&
    criteria.minutes >= route.minMinutes);

  if (eligible.length === 0) return null;

  const specificity = (route: RouteConfig) =>
    (route.department === null ? 0 : 2) + (route.employmentType === null ? 0 : 1);

  return eligible.reduce((best, route) => {
    if (specificity(route) !== specificity(best)) {
      return specificity(route) > specificity(best) ? route : best;
    }
    return route.minMinutes > best.minMinutes ? route : best;
  });
}

export function createRoute(sql: SqlStorage, input: NewRoute): number {
  const route = sql
    .exec<{ id: number }>(
      `INSERT INTO approval_routes (name, department, employment_type, min_minutes)
       VALUES (?, ?, ?, ?) RETURNING id`,
      input.name, input.department ?? null, input.employmentType ?? null,
      input.minMinutes ?? 0,
    )
    .one();

  input.steps.forEach((step, index) => {
    sql.exec(
      `INSERT INTO approval_route_steps
         (route_id, step_index, rule, approver_kind, approver_employee_id)
       VALUES (?, ?, ?, ?, ?)`,
      route.id, index, step.rule, step.approverKind, step.approverEmployeeId ?? null,
    );
  });

  return route.id;
}

/** Select the applicable route and snapshot its steps. Throws NoRouteError if none matches. */
export function resolveRoute(sql: SqlStorage, criteria: RouteCriteria): RouteSnapshot {
  const candidates = sql
    .exec<{
      id: number; name: string; department: string | null;
      employment_type: string | null; min_minutes: number;
    }>(
      // ORDER BY id ASC is load-bearing, not cosmetic: it makes selectRoute's tie-break policy
      // (earliest-created route wins an exact specificity+minMinutes tie) a documented outcome
      // rather than an accident of SQLite's unordered scan order. The chosen route is snapshotted
      // onto a submission and cited in audits, so "arbitrary but currently stable" is not enough.
      `SELECT * FROM approval_routes ORDER BY id ASC`,
    )
    .toArray()
    .map((row): RouteConfig => ({
      id: row.id,
      name: row.name,
      department: row.department,
      employmentType: row.employment_type,
      minMinutes: row.min_minutes,
    }));

  const selected = selectRoute(candidates, criteria);
  if (!selected) throw new NoRouteError();

  const steps = sql
    .exec<{
      step_index: number; rule: StepRule;
      approver_kind: "manager" | "employee"; approver_employee_id: number | null;
    }>(
      `SELECT step_index, rule, approver_kind, approver_employee_id
       FROM approval_route_steps WHERE route_id = ? ORDER BY step_index`,
      selected.id,
    )
    .toArray()
    .map((row): RouteStep => ({
      stepIndex: row.step_index,
      rule: row.rule,
      approverKind: row.approver_kind,
      approverEmployeeId: row.approver_employee_id,
    }));

  return { routeId: selected.id, steps };
}
