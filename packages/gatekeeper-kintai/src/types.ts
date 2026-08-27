export const KINTAI_VENDOR_ID = "kintai";

export type EmployeeId = number;
export type PunchKind = "in" | "out" | "break_start" | "break_end";
export type PunchSource = "gadget" | "admin" | "import";
export type LocationSource = "gps" | "denied" | "unavailable" | "manual";
export type SubmissionState = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export type ApprovalAction = "approve" | "reject" | "return";
export type StepRule = "any_of" | "all_of";
export type EmployeeStatus = "active" | "leave" | "departed";

/**
 * What the admin app's `whoAmI()` reports about the caller's own account.
 *
 * Declared here rather than beside the API it belongs to because `app/` imports it, and everything
 * `app/` reaches is compiled by `tsconfig.app.json` — which has the DOM lib and no worker types.
 * `admin-api.ts` transitively imports the store, whose functions take `SqlStorage`, so importing
 * the type from there would pull the whole worker surface into the browser build's type graph.
 * `src/types.ts` is a leaf of plain types, exactly as the scheduler's `management-types.ts` is.
 */
export type KintaiIdentity = {
  /** The caller's own account code, the string an employee reads out to HR. */
  accountId: string;
  linked: boolean;
  employeeId: EmployeeId | null;
};

/**
 * One employee record, whole, as the HR roster shows it.
 *
 * Column names, not camelCase: these rows are read straight out of `employees` and every other row
 * type in this package (`SubmissionRow`, `PunchRow`) does the same, so a renaming layer here would
 * be the odd one out.
 *
 * Declared in this leaf module rather than beside its queries in `store/employees.ts` for the same
 * reason as `KintaiIdentity` above: `app/` renders these rows, and everything `app/` reaches is
 * compiled by `tsconfig.app.json`, which has the DOM lib and no worker types. `store/employees.ts`
 * takes `SqlStorage`, so importing the type from there would pull the worker surface into the
 * browser build's type graph. `store/employees.ts` re-exports it, so nothing else moved.
 */
export type EmployeeRow = {
  id: number;
  employee_number: string;
  display_name: string;
  department: string | null;
  employment_type: string | null;
  designated_approver_id: number | null;
  status: EmployeeStatus;
  joined_on: string;
  departed_on: string | null;
};

/**
 * One employee plus everything the HR roster needs to say whether they can actually use the system.
 *
 * The computed half exists because "created" and "linked" are not the same as "working". An
 * employee whose account is linked still cannot file overtime unless somebody could approve it —
 * `submitOvertime` calls `assertApproverReachable` and refuses otherwise — so HR would finish
 * onboarding, see a linked record, and have produced a person the system will turn away. Every
 * field here is computed at the instant of the read from the same functions the runtime uses, so
 * the roster cannot promise something the enforcement path then denies.
 */
export type RosterEntry = EmployeeRow & {
  /** An account capability currently resolves to this employee. */
  linked: boolean;
  /** Reporting managers in force right now. Delegates are excluded, as they are everywhere else. */
  managerIds: EmployeeId[];
  /** 管理監督者 right now: exempt from overtime premiums, and so from needing an approver. */
  exempt: boolean;
  /**
   * Somebody could approve what this employee files.
   *
   * Straight from the store's `hasReachableApprover` — the SAME function `submitOvertime` reaches
   * through `assertApproverReachable`, never a second reading of the org tables. The three fields
   * above are shown so HR can see WHY it is false and what would fix it; this one is the verdict,
   * and it is the one the runtime will apply.
   */
  approverReachable: boolean;
};
