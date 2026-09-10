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

/**
 * The languages either app-UI screen can render, written once as values, for the same reason
 * `SUBMISSION_KINDS` above is: `account_preferences.language` is a foreign key onto a seeded
 * lookup table (`ui_languages`) rather than a CHECK constraint, so the set has to exist as
 * database rows as well as a TypeScript union, and `schema.ts` seeds the rows from this exact
 * array. `@validateRpc()` on `setLanguage` refuses anything outside the union before the store is
 * ever asked, and the lookup table is the backstop behind that.
 */
export const UI_LANGUAGES = ["en", "ja"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
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
  /**
   * The caller's own saved UI language, or `null` if they have never chosen one. Read by
   * `identify()` off `account_preferences`, keyed on `accountId` — see that table's comment in
   * `schema.ts` for why the key is the account and not the employee. `null` is not a default: the
   * page decides what to show a caller who has never chosen (the browser's own language), and
   * conflating "never chosen" with "chose English" would make that decision impossible to tell
   * from a real one.
   *
   * REQUIRED, matching the wire: `identify()` always sets this key, `null` included, on every
   * `whoAmI()` response — the RPC surface pin in `admin-api.test.ts` checks for the key by name.
   * It was briefly optional so the pre-i18n `whoAmI` mocks kept compiling while the wire was being
   * laid; both screens now read it to choose which dictionary to render (`resolveLanguage` in
   * `app/i18n`), and a mock that omits it would be a mock of an identity the server cannot send.
   */
  language: UiLanguage | null;
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

// ---- the wire shapes the admin app renders -----------------------------------------------------
//
// Everything below this line is a row that crosses the RPC boundary into `app/`, and it lives here
// for ONE reason, which is the same reason `EmployeeRow` and `KintaiIdentity` above do: `app/` is
// compiled by `tsconfig.app.json`, which has the DOM lib and no worker types. The modules that
// QUERY these rows -- `store/punches.ts`, `store/submissions.ts`, `store/overview.ts` -- all take
// `SqlStorage`, so `import type` from any of them pulls those files into the app's type program
// and reports every occurrence of that name (verified: ~40 errors across `src/store` and
// `src/routes.ts`). `src/types.ts` imports nothing, so it is the one module both programs can
// reach, and `pnpm run typecheck:app` is the proof that it still is.
//
// They were HAND-RESTATED in `app/AdminPage.tsx` until 2026-09-04, which is the thing this section
// exists to have ended. Two copies of a row shape compile clean in both projects when a field is
// renamed on the store side, and the dashboard then reads `undefined` at runtime -- a render throw
// with no error boundary above it, i.e. a white screen, from a change TypeScript signed off on.
// The store modules now import these and re-export them under the same names, so worker-side
// callers still read each row type from the module that queries it and nothing there moved.
//
// A SECOND COPY STILL EXISTS AND IS NOT THIS ONE: `src/types.txt`, the hand-written description of
// this package's wire surface for agents, restates `PunchRow`, `SubmissionRow` and
// `AmendmentDetail` in prose. Nothing ties it to these declarations -- no generator, no test -- so
// a field added or renamed here must be carried into that file by hand. See the TASK 7 note above,
// which is the same hazard on the same file.

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

/**
 * The `submissions` table's own columns, exactly as SQL hands them back.
 *
 * Separate from `SubmissionRow` because `SqlStorage.exec<T>` constrains `T` to a record of SQL
 * VALUES, and `SubmissionRow.amendment` is an assembled object — a `SELECT *` cannot be typed as
 * one. The split is worth having on its own terms too: that is what the write paths and the
 * authority prologue work with, and none of them has any use for display detail.
 */
export type SubmissionColumns = {
  id: number;
  employee_id: number;
  /**
   * What kind of request this is. `overtime` until amendments landed; an amendment is a submission
   * too, so that it inherits the approval stack rather than growing a second one beside it.
   *
   * Whatever reads a submission must not assume `overtime`. `minutes` and `calculation_inputs` are
   * overtime's columns and carry 0 and NULL on an amendment; what an amendment asks for lives in
   * `amendment_requests`, keyed on this row's id.
   */
  kind: SubmissionKind;
  requested_for: string;
  state: SubmissionState;
  submitted_at: number | null;
  current_step: number;
  minutes: number;
  reason: string;
  calculation_inputs: string | null;
  route_snapshot: string;
  created_by: number | null;
};

/**
 * What one amendment asks to change, as a reader deciding on it needs to see it.
 *
 * ONE TYPE FOR BOTH SURFACES: the confirmation dialog (`ActPreview.amendment`, via `previewAct`)
 * and the list rows (`SubmissionRow.amendment`, via `listSubmissionsFor` and
 * `pendingApprovalsFor`). They are assembled by the same code from the same columns, so a queue
 * cannot summarise a request as one thing and the dialog confirm it as another.
 *
 * `currentOccurredAt` is what the target punch says NOW, read at the moment the reader is shown
 * the question rather than copied at filing time: the whole judgement is "should this become that",
 * and a stale left-hand side would be describing a comparison that is no longer the one being made.
 * It is null exactly when `targetPunchId` is — the forgotten clock-out, where there is no punch to
 * compare against and saying so is the honest answer.
 *
 * "WHAT THE PUNCH SAYS NOW" IS NOT THE TARGET ROW'S OWN COLUMN, and this is the subtle part.
 * `punches` is append-only: a correction appends a SUCCESSOR carrying `supersedes_id`, so the
 * target row's `occurred_at` is frozen from the instant it was written and reading it could never
 * have detected anything. The live time is the successor's when one exists — which is exactly the
 * case that matters, because a target superseded out of band (an admin correcting the same punch
 * from the HR surface while the request sits in a queue) makes the request permanently
 * unappliable: `actOnAmendment` refuses it with `KINTAI_AMENDMENT_TARGET_SUPERSEDED` whatever the
 * approver decides. Nothing else in the row changes, so a current time that no longer matches what
 * the request was filed against is the one signal a triaging approver gets.
 *
 * ONE HOP, deliberately, and it is the same hop `actOnAmendment` takes: it looks for a row whose
 * `supersedes_id` is the target and names it in the refusal. A successor that has itself been
 * superseded would leave this one revision behind — the request is doomed either way and the
 * signal still fires — and resolving the whole chain would mean a recursive CTE on a query that
 * runs on every queue open. `punches_supersedes_unique` guarantees at most one successor per
 * punch, so the hop is single-valued.
 *
 * `lockedPeriod` is the one field here that is NOT a property of the request: it is the state of
 * the month the write would land in, named rather than flagged because the reader needs to read
 * WHICH month. Null means open. Applying an approved amendment is the only write in the system
 * allowed into a closed period (see `actOnAmendment`), so this is the single thing about the
 * decision an approver most needs told and is least able to infer.
 *
 * Every field is read off the tables rather than assembled from a caller's argument, like every
 * other field of `ActPreview`.
 */
export type AmendmentDetail = {
  targetPunchId: number | null;
  /**
   * What the punch says now — the successor's time once something has superseded the target, not
   * the target row's own frozen column. Null when the request is to add a punch that was never
   * recorded. See the type's own comment: this field is the reason it has one.
   */
  currentOccurredAt: number | null;
  requestedOccurredAt: number;
  workDate: string;
  kind: PunchKind;
  /** The closed month this would write into, or null when that month is open. */
  lockedPeriod: string | null;
};

/**
 * A submission as the LIST reads return it: every column of the table, plus an amendment's detail.
 *
 * This is the shape `listMySubmissions` and `listPendingApprovals` put on the wire, and the one
 * `src/types.txt` describes to an agent.
 */
export type SubmissionRow = SubmissionColumns & {
  /**
   * What an amendment asks to change — present exactly on rows whose `kind` is `'amendment'`, and
   * absent on every overtime row.
   *
   * ABSENT IS THE DISCRIMINATOR, matching `ActPreview.amendment` and carrying the same type from
   * the same assembler. Without it a list row for an amendment is unreadable: `kind` says
   * `amendment`, `minutes` says 0 and means nothing there (see `kind` above), and nothing else on
   * the row says which punch, what it currently records, or what was asked for. An approver
   * browsing the queue — or an agent summarising it for them — saw a request for zero minutes.
   *
   * Populated by the LIST reads, `listSubmissionsFor` and `pendingApprovalsFor`, which join it in
   * the same query. `getSubmission` is a `SELECT *` used by the write paths and leaves it absent
   * even on an amendment; the authority prologue runs it once per queue row and has no use for
   * display data, so it does not pay for the joins. Ask `previewAct` (or `getAmendment`) for the
   * detail of one submission.
   */
  amendment?: AmendmentDetail;
};

/** One (employee, day) in a month whose anomaly list is non-empty, with the flags themselves. */
export type AnomalousDay = {
  employeeId: number;
  displayName: string;
  employeeNumber: string;
  workDate: string;
  /** The flag strings `dayAnomalies` produces: `unpaired_in`, `orphan_out`, `long_span`, … */
  anomalies: string[];
};

/** One employee's month: days worked, minutes credited, and how many of those days are flagged. */
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
 *
 * It says the month is CLOSED, not that its numbers are frozen. A closed period accepts exactly
 * one write — an approved amendment — and the next read walks the punches that write left behind.
 */
export type MonthlyReport = { period: string; locked: boolean; rows: MonthlyTotalRow[] };

/** One employee's one day: the punches, the flags they raise, the minutes they credit. */
export type EmployeeDay = {
  punches: PunchRow[];
  anomalies: string[];
  workedMinutes: number;
};

/**
 * One day of one employee's own month, as the employee gadget shows it: the minutes credited, the
 * flags the day raises, and that day's own overtime request, if it has one.
 */
export type EmployeeMonthDay = {
  workDate: string;
  workedMinutes: number;
  anomalies: string[];
  /** The day's own overtime submission state, or null if none. One request per day is the
   *  common case; if several exist, the most recent by submission id. */
  overtime: { minutes: number; state: SubmissionState } | null;
};

/**
 * One employee's own month: one row per day they have punches in `period`, bounded to that one
 * employee. `monthlyTotals`'s per-employee rollup for the admin dashboard, seen from the other
 * side -- the days themselves, for the employee whose days they are.
 */
export type EmployeeMonth = { period: string; days: EmployeeMonthDay[] };

/**
 * One waiting request, as an administrator triaging the whole company's queue needs to read it.
 *
 * Every field of the underlying `SubmissionRow` is kept, amendment detail included, so this row is
 * a superset of what the approver's own queue shows rather than a re-description of it. The added
 * fields are the three things an administrator has that an approver does not: whose request it is
 * in words, how long it has waited, and WHO COULD END THE WAIT.
 */
export type PendingItem = SubmissionRow & {
  employeeName: string;
  employeeNumber: string;
  /**
   * Who filed it, in words, or null when the row records no filer.
   *
   * Null is not "the employee themself": `created_by` is nullable and a null records that no filer
   * was captured (an older row, or a `submitOvertime` call that omitted it). Conflating the two
   * would misreport the one column that makes `FiledBySelfError` — and so most of the stranding
   * the dashboard exists to find — legible.
   */
  filedByName: string | null;
  /** epoch ms it has waited, from submitted_at to `now`. */
  waitingMs: number;
  /** Who can decide it right now. Empty means STRANDED — surface loudly, never hide. */
  eligibleActorIds: EmployeeId[];
  eligibleActorNames: string[];
  /**
   * `latestEventId` at the moment of this read. A decision made from this row states it back, so
   * a click against a row that moved in between is refused (`KINTAI_STALE_DECISION`) rather
   * than counted at whatever step is now current.
   */
  afterEventId: number;
};

// ---- the wire shapes the EMPLOYEE gadget renders -----------------------------------------------
//
// The same rule as the admin section above, for the employee half of the surface: these cross the
// RPC boundary into `app/`, so they live in this zero-import leaf rather than in the store modules
// that query them (`store/allocations.ts`, `store/punches.ts`) or in `kintai.ts` (which imports
// `cloudflare:workers`). Those modules re-export them under the same names, so worker-side callers
// still read each shape from where it is produced and nothing there moved. `KintaiEmployeeClient`
// below is the app-facing mirror of `EmployeeKintaiApi`, and it can only be written here because
// every type it names is reachable here.

/** Where a punch was taken, as the gadget offers it to `punch`. See `store/punches.ts`. */
export type PunchLocation = {
  source: LocationSource;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
};

/** One project allocation on one of the caller's own days. See `store/allocations.ts`. */
export type AllocationRow = {
  id: number;
  employee_id: number;
  work_date: string;
  project_code: string;
  minutes: number;
  note: string | null;
  version: number;
  superseded_by: number | null;
};

/** Allocated vs worked minutes for one day, with the (never-rejecting) discrepancy between them. */
export type Reconciliation = {
  allocatedMinutes: number;
  workedMinutes: number;
  /** allocated - worked. Negative means under-allocated. Never a rejection. */
  discrepancyMinutes: number;
};

/** A punch write's receipt: the row created, whose it is, and the day it was filed against. */
export type PunchReceipt = { punchId: number; employeeId: EmployeeId; workDate: string };

/**
 * The capability the employee gadget calls, as the page sees it — the plain-type mirror of
 * `EmployeeKintaiApi`, exactly as `KintaiAdminClient` mirrors the admin surface.
 *
 * Declared here, not imported from `kintai.ts`: `EmployeeKintaiApi` extends `RpcTarget` and its
 * module pulls in `cloudflare:workers` and the whole store, none of which `tsconfig.app.json` can
 * compile. This leaf imports nothing, so the app reaches the shape without dragging the worker into
 * its type graph. Every method here is the app-visible half of the class's own; the class is the
 * authority and `employee-api.test.ts` pins its callable surface, so a method added there without
 * a line here is simply unreachable from the page until this mirror catches up.
 */
export type KintaiEmployeeClient = {
  whoAmI(): Promise<KintaiIdentity>;
  getDay(workDate: string): Promise<{
    punches: PunchRow[];
    allocations: AllocationRow[];
    reconciliation: Reconciliation;
    anomalies: string[];
    locked: boolean;
  }>;
  myMonth(period: string): Promise<EmployeeMonth>;
  punch(kind: PunchKind, location?: PunchLocation): Promise<PunchReceipt>;
  requestMissingPunch(
    workDate: string, kind: PunchKind, occurredAt: number, reason: string,
  ): Promise<number>;
  requestPunchCorrection(punchId: number, occurredAt: number, reason: string): Promise<number>;
  listMySubmissions(): Promise<SubmissionRow[]>;
  withdrawSubmission(submissionId: number): Promise<void>;
  resubmit(submissionId: number): Promise<void>;
  /**
   * Save the caller's own UI language, or forget it given null. Identity comes from the
   * capability, so there is nothing to name but themselves.
   *
   * The header's `LanguageToggle` is the only caller: it switches the screen first and calls this
   * second, so a rejection here costs the reader their saved preference and not the switch they
   * just made. `@validateRpc()` on `EmployeeKintaiApi.setLanguage` refuses anything but the two
   * `UI_LANGUAGES` literals and null before the store is asked.
   */
  setLanguage(language: UiLanguage | null): Promise<void>;
};
