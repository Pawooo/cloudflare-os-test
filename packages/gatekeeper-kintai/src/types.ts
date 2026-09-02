export const KINTAI_VENDOR_ID = "kintai";

export type EmployeeId = number;

/**
 * The four things a punch can be, written once as values.
 *
 * An array with the union derived from it, for the same reason as `SUBMISSION_KINDS` below: the
 * set has to exist at runtime as well as in the type system -- `assertPunchKind` in `input.ts`
 * checks a caller-supplied string against it -- and a hand-written second copy of the list beside
 * that check is exactly the shape this package has twice shipped bugs from.
 *
 * The `CHECK (kind IN (...))` constraints on `punches` and `amendment_requests` are a third copy
 * and cannot be derived, because SQL text is not TypeScript. They are the database's backstop, not
 * the check a caller ever sees; adding a punch kind means editing them too.
 */
export const PUNCH_KINDS = ["in", "out", "break_start", "break_end"] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

/**
 * The two columns that are growing enumerations, written ONCE, as values.
 *
 * `submissions.kind` and `punches.source` are foreign keys onto seeded lookup tables rather than
 * CHECK constraints (see `applySchema`), so the database needs these same strings as rows. Written
 * as `as const` arrays with the union derived from them, so `schema.ts` seeds from the array and
 * the type cannot drift from what the database will accept -- this package has twice shipped bugs
 * from two copies of one rule disagreeing, and a seed list that has fallen behind its union is
 * exactly that shape: TypeScript permits the write and the foreign key refuses it.
 *
 * They live in this leaf module, not beside the schema, for the reason every other type here does:
 * `app/` is compiled by `tsconfig.app.json`, which has no worker types, and `schema.ts` takes
 * `SqlStorage`. The dependency runs schema -> types, never the other way.
 *
 * Adding a value is one edit here plus an activation: the seed is `INSERT OR IGNORE`, so the new
 * row appears on the next `applySchema` and no table is ever rebuilt.
 */
/**
 * TASK 7 MUST HAND-UPDATE `src/types.txt` WHEN AMENDMENTS BECOME REACHABLE. That file documents
 * `SubmissionRow.kind` as `"overtime"` and nothing ties it to this array — no generator, no test.
 * It is truthful only while no agent-reachable surface can create an amendment, which is exactly
 * what Task 7 changes.
 */
export const SUBMISSION_KINDS = ["overtime", "amendment"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/** How a punch entered the record. See `SUBMISSION_KINDS` for why this is an array. */
export const PUNCH_SOURCES = ["gadget", "admin", "import", "amendment"] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];
export type LocationSource = "gps" | "denied" | "unavailable" | "manual";
export type SubmissionState = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export type ApprovalAction = "approve" | "reject" | "return";
export type StepRule = "any_of" | "all_of";
export type EmployeeStatus = "active" | "leave" | "departed";

/**
 * Which day a punch belongs to, per employee.
 *
 * - `calendar` — the punch belongs to the JST date it happened on. The default, and what every
 *   employee who already exists is on: office staff finish before midnight, so the clock and the
 *   shift agree and there is nothing to decide.
 * - `shift_start` — the punch inherits the work date of the employee's currently open shift, so a
 *   22:00 → 06:00 site crew shift lands entirely on the date it started. Guarded by
 *   `MAX_SHIFT_MS`; see `work-date.ts`.
 *
 * Per employee rather than per deployment because the company has both, and per-employee is the
 * only scope at which either answer is right. It is NOT retroactive: changing it re-files nothing
 * already recorded.
 */
export type WorkDatePolicy = "calendar" | "shift_start";

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
 * What HR types into the "add someone" form, and the only input `createEmployee` accepts.
 *
 * camelCase, unlike the row types: this is an argument, not a row read back out of SQLite.
 * Declared here rather than in `store/employees.ts` for the reason `EmployeeRow` below is — the
 * form that fills it in is compiled by `tsconfig.app.json`, which has no worker types.
 *
 * Every field is checked at the API boundary before it reaches the store; `@validateRpc()` only
 * knows the shapes. See `AdminKintaiApi.createEmployee`.
 */
export type NewEmployee = {
  employeeNumber: string;
  displayName: string;
  department?: string;
  employmentType?: string;
  designatedApproverId?: EmployeeId;
  joinedOn: string;
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
  /** Which day this employee's punches are filed against. See `WorkDatePolicy`. */
  work_date_policy: WorkDatePolicy;
};

/**
 * One employee plus everything the HR roster needs to say whether they can actually use the system.
 *
 * The computed half exists because "created" and "linked" are not the same as "working". An
 * employee whose account is linked still cannot file anything unless somebody could approve it —
 * `submitOvertime` and `fileAmendment` both call `assertApproverReachable` and refuse otherwise —
 * so HR would finish onboarding, see a linked record, and have produced a person the system will
 * turn away. Every field here is computed at the instant of the read from the same functions the
 * runtime uses, so the roster cannot promise something the enforcement path then denies.
 */
export type RosterEntry = EmployeeRow & {
  /** An account capability currently resolves to this employee. */
  linked: boolean;
  /** Reporting managers in force right now. Delegates are excluded, as they are everywhere else. */
  managerIds: EmployeeId[];
  /**
   * 管理監督者 right now: exempt from overtime premiums.
   *
   * NOT from needing an approver, which is what it used to say and what the roster used to show.
   * An exemption grants nobody authority to sign; an exempt officer files no overtime, but their
   * punches still need correcting and a correction still needs a human. It is shown beside
   * `approverReachable`, never as a substitute for it.
   */
  exempt: boolean;
  /**
   * Somebody could approve what this employee files.
   *
   * Straight from the store's `hasReachableApprover` — the SAME function `submitOvertime` and
   * `fileAmendment` reach through `assertApproverReachable`, never a second reading of the org
   * tables. The three fields above are shown so HR can see WHY it is false and what would fix it;
   * this one is the verdict, and it is the one the runtime will apply. Note that `exempt` is NOT
   * one of the reasons it can be true — it is context for a row that is false.
   */
  approverReachable: boolean;
};
