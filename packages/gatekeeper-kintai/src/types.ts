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
