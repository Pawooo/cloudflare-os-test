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
  constructor() {
    super("No approval route matches this request. Ask an administrator to configure one.");
  }
}

/**
 * Most specific match wins: a route scoped to the employee's department or employment type beats
 * a catch-all, and among those, the highest minute threshold the request actually clears.
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
    }>(`SELECT * FROM approval_routes`)
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
