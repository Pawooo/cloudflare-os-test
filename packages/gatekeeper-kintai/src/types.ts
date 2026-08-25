export const KINTAI_VENDOR_ID = "kintai";

export type EmployeeId = number;
export type PunchKind = "in" | "out" | "break_start" | "break_end";
export type PunchSource = "gadget" | "admin" | "import";
export type LocationSource = "gps" | "denied" | "unavailable" | "manual";
export type SubmissionState = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export type ApprovalAction = "approve" | "reject" | "return";
export type StepRule = "any_of" | "all_of";
export type EmployeeStatus = "active" | "leave" | "departed";
