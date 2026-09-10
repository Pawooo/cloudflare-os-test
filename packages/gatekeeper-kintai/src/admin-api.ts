import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ApprovalAction, EmployeeId, KintaiIdentity, RosterEntry, SubmissionState, UiLanguage,
  WorkDatePolicy,
} from "./types.js";
import type { NewEmployee } from "./store/employees.js";
import { EmployeeNotFoundError } from "./store/employees.js";
import type { ReportingLineRow } from "./store/org.js";
import type {
  AnomalousDay, EmployeeDay, MonthlyReport, PendingItem,
} from "./store/overview.js";
import type { KintaiStore } from "./store/kintai-store.js";
import {
  assertEmployeeId, assertPeriod, assertRequiredText, assertText, assertWorkDate,
  InvalidInputError, LIMITS,
} from "./input.js";

/**
 * The HR admin surface, served to the management app at `/gatekeepers/kintai`.
 *
 * Which capability a browser gets is decided once, server-side, in `KintaiAccount.startAppUi()`
 * from the `isAdmin` the Workshop supplies: an administrator gets `AdminKintaiApi`, which
 * implements every member here; everyone else gets `EmployeeKintaiApi` (in `kintai.ts`), a
 * DIFFERENT capability that carries none of these methods — one employee's own attendance, and
 * nothing administrative. The flag itself never reaches the iframe, so there is nothing for a
 * browser to lie about: a non-admin's capability has no admin method to call under any argument,
 * because it is not this class and does not implement this interface.
 *
 * That is the whole authorization property, and it is structural rather than a check. There is no
 * refuse-everything twin holding the line any more — a non-admin simply holds a capability on
 * which `linkAccount` and its siblings do not exist. (This replaced `ViewerKintaiApi`, which used
 * to `implements KintaiAdminApi` and throw on all but `whoAmI` so that a non-admin's capability
 * still answered every admin call, with a refusal; the employee gadget gave non-admins a real
 * capability of their own, and a refuse-all stub with the admin methods still spelled out on it was
 * then both dead and a wider surface than "the methods are absent".)
 *
 * `AdminKintaiApi implements KintaiAdminApi` is still load-bearing: a REQUIRED member added here
 * makes `AdminKintaiApi` fail to compile until it is written, so the surface cannot grow a method
 * nobody implemented. Know the two things that guard does NOT cover, because both compile clean:
 *
 *  - a public method added to `AdminKintaiApi` itself that is absent from this interface. It is
 *    callable over RPC, and `implements` says nothing about it. (Narrowing the decorator to
 *    `@validateRpc<KintaiAdminApi>()` does generate a narrowed `methods` map, but
 *    capnweb-validate 0.3.0's runtime wrapper dispatches the extra method regardless.)
 *  - an OPTIONAL member (`foo?(): Promise<void>`) added here, which the class satisfies without
 *    implementing.
 *
 * Neither is caught by the compiler, so both are caught by the test instead: see "keeps the admin
 * capability to exactly the interface" in `__tests__/admin-api.test.ts`, which pins the callable
 * surface of `AdminKintaiApi` against a written-out list of these members. Add a member here and
 * that list must change too. The parallel pin for the non-admin capability — that
 * `EmployeeKintaiApi` exposes none of these — lives in `__tests__/employee-api.test.ts`.
 *
 * WHAT THIS CAPABILITY READS, as of 2026-09-04: all attendance, for everybody, down to individual
 * punches. `listPendingOverview`, `listAnomalousDays`, `monthlyReport` and `getEmployeeDay` widen
 * it from "administers the org" to "reads the whole company's worked hours", and `getEmployeeDay`
 * is punch-level — the clock times one named person tapped in and out on one named day, and where
 * they were standing when they did. That is a privacy decision and it was taken knowingly, with
 * the project owner, on 2026-09-04: an administrator who cannot see a punch cannot see what is
 * stuck, cannot read a month, and cannot responsibly close one — and closing one is the write this
 * package needs most (`setAllocations` can rewrite a paid month until somebody can).
 *
 * It goes to HR and NOT to managers, who are the other party with a plausible claim on it. A
 * manager's authority in this package is the org chart, and their surface is the session facet:
 * scoped to their own reports, reached through the approval path, and nothing wider. Scoped
 * manager views — a foreman reading their crew's days — are later work and need their own
 * capability; nothing on this interface is that, and a manager holding a Workshop admin account is
 * getting the HR capability, not a manager's one.
 *
 * A non-admin carries ZERO of these attendance reads — not a filtered view, not an empty list,
 * nothing to call — because they hold `EmployeeKintaiApi`, on which none of them exists. A read
 * added here reaches only an administrator's capability; whether a non-admin may see the same thing
 * is a separate decision, made by adding the corresponding method to `EmployeeKintaiApi` (scoped to
 * the caller's own record) or deliberately not. The gap that stays uncaught by the compiler is the
 * one named above — a public method on `AdminKintaiApi` absent from here — so a new read belongs on
 * this interface first, never on the class first.
 */
export interface KintaiAdminApi {
  /**
   * Who the caller is, as their own account capability answers it.
   *
   * The one method every caller may reach, and the reason it is not admin-gated: an unlinked
   * employee reads their `accountId` off this page and gives it to HR, which is the only way HR
   * can learn it. Accounts are minted per user and stored in each user's own Durable Object, so
   * there is no registry of provisioned accounts for HR to browse — the code has to come from the
   * employee. Nothing is leaked by that: the caller learns their OWN account id, which their
   * capability already is.
   */
  whoAmI(): Promise<KintaiIdentity>;

  /**
   * Save the caller's own UI language, or forget it given null. Identity from the capability, like
   * everywhere else on this package — there is no account or employee argument, so nobody can set
   * anyone's language but their own. See `AdminKintaiApi.setLanguage`.
   */
  setLanguage(language: UiLanguage | null): Promise<void>;

  /**
   * The whole roster, with the computed columns HR reads it for. Admin only — this is the
   * company's headcount.
   *
   * It returns `RosterEntry` rather than the raw `employees` row because the question HR actually
   * asks of a roster is "who can use this system?", and no column answers it: an employee is
   * usable only once an account resolves to them AND somebody could approve what they file. Both
   * are computed per read, from the same functions the runtime enforces with.
   *
   * Folded into this one method rather than exposed as a per-employee `hasReachableApprover`,
   * which was the alternative. Three reasons. A roster of 200 would otherwise be 200 further RPCs
   * to answer a question every row asks. The two facts belong to the same instant, and separate
   * calls would let a link land between them and render a row that was never true. And a
   * per-employee probe invites a caller to assemble its own verdict about who is approvable —
   * exactly the second implementation `hasReachableApprover`'s own comment warns about.
   */
  listEmployees(): Promise<RosterEntry[]>;

  /** Every reporting edge, closed windows included. Admin only — this is the org chart. */
  listReportingLines(): Promise<ReportingLineRow[]>;

  /** Create an employee record. Admin only, and validated — see `AdminKintaiApi.createEmployee`. */
  createEmployee(input: NewEmployee): Promise<EmployeeId>;

  /**
   * Point an account capability at an employee record. Admin only, and the most dangerous method
   * in this package — see `AdminKintaiApi.linkAccount`.
   */
  linkAccount(accountId: string, employeeId: EmployeeId): Promise<void>;

  /** Open a reporting line from `employeeId` to `managerId`, effective now. Admin only. */
  setReportingLine(employeeId: EmployeeId, managerId: EmployeeId): Promise<void>;

  /**
   * Name the person who may approve for an employee who reports to nobody. Admin only.
   *
   * The other half of `setReportingLine`, and the only one that reaches the top of the org chart.
   * `hasReachableApprover` accepts two answers — a manager, or this — and whoever sits at the root
   * has no manager by definition. `designated_approver_id` was written for exactly them and was
   * settable only in `createEmployee`'s INSERT, so employee 1, created when there is nobody in the
   * table to point at, could never be given one: implemented, documented, and unreachable by the
   * person it was for. This is the update path — see `AdminKintaiApi.setDesignatedApprover`.
   *
   * NOT interchangeable with `grantExemption`, which used to look like the fix for the same row.
   * 管理監督者 says an employee's overtime bears no premium; it grants nobody authority to sign,
   * and a correction to that employee's punches still needs a person.
   */
  setDesignatedApprover(employeeId: EmployeeId, approverId: EmployeeId): Promise<void>;

  /**
   * Record that `employeeId` is 管理監督者, from now, open-ended. Admin only.
   *
   * Here because 管理監督者 is a determination HR has to be able to record, and NOT because it
   * completes an employee at the top of the organisation — it used to read that way, and that was
   * the bug. `hasReachableApprover` accepts two answers, a reporting line or a designated
   * approver, and an exemption is neither: it grants nobody authority to sign. An exempt officer
   * files no overtime (`submitOvertime` refuses them), but their punches are still the record of
   * when they worked, and correcting one is a request that needs a human. `setDesignatedApprover`
   * is what finishes that row.
   *
   * 管理監督者 is also the status this is really about. It is a determination under 労働基準法 §41
   * about a specific person's authority and treatment, and it decides whether their overtime bears
   * a premium at all. It belongs to HR, is recorded rather than derived, and is exactly the kind of
   * thing an inspection asks to see the provenance of — which is why it is audited and why the
   * period keeps its own row rather than becoming a flag on `employees`.
   */
  grantExemption(employeeId: EmployeeId): Promise<void>;

  /**
   * Record which day this employee's punches are filed against, from now on. Admin only.
   *
   * Beside `grantExemption` because it is the same kind of thing: a fact about one employee that
   * HR determines, that nobody else may assert about themselves, and that changes what their hours
   * are worth. A site crew member on `calendar` has every overnight shift split across two dates
   * and every one of those days flagged; the same person on `shift_start` has one day with the
   * whole span on it. Nothing downstream can repair the difference, because it is decided at the
   * moment each punch is recorded and written into the punch.
   *
   * Not retroactive, exactly as everything else on this surface is additive: changing it re-files
   * nothing already recorded. That is why it belongs at onboarding and why it is audited — an
   * employee whose policy was wrong for a month has a month of records that are wrong in a way
   * only an administrative correction can fix.
   */
  setWorkDatePolicy(employeeId: EmployeeId, policy: WorkDatePolicy): Promise<void>;

  /**
   * Every submission waiting on somebody, with how long it has waited and who could end the wait.
   * Admin only — this is the whole company's queue.
   *
   * THE ONE READ IN THIS SYSTEM THAT CAN SEE A STRANDED REQUEST, and the reason the dashboard's
   * first tab exists. Every other view of the queue is scoped to a person, so a submission nobody
   * may act on — filed by its only possible approver, or left behind by an org change that closed
   * the last edge reaching it — appears in nobody's list and waits forever. See `pendingOverview`.
   *
   * It carries no decide control, deliberately: the admin's move is to chase the person named in
   * `eligibleActorNames`, or to repair the org so somebody is. An admin override would make every
   * route guarantee conditional.
   */
  listPendingOverview(): Promise<PendingItem[]>;

  /**
   * Every (employee, day) in `period` that carries an anomaly flag, with the flags. Admin only.
   *
   * The exceptions queue: one row per day a human should look at, rather than one row per day
   * worked. `period` is `YYYY-MM`.
   */
  listAnomalousDays(period: string): Promise<AnomalousDay[]>;

  /**
   * One month, per employee: days worked, minutes credited, flagged days, and whether it is
   * closed. Admin only — this is every employee's hours.
   *
   * `locked` sits on the report rather than on each row, because one report describes one period
   * under one lock. It says the month is CLOSED, not that the numbers are frozen: an approved
   * amendment still writes into a closed month and the next read of this walks the punches it
   * wrote. See `monthlyTotals`.
   */
  monthlyReport(period: string): Promise<MonthlyReport>;

  /**
   * One employee's one day — the punches, the flags they raise, the minutes they credit. Admin
   * only, and the punch-level read the header's paragraph is about.
   *
   * The drill-down both tabs need: a flagged day and a suspicious total are both questions that
   * can only be answered by looking at the punches. It is the same three calls `KintaiSession.
   * getDay` makes for the employee's own view, so an administrator looking at somebody's day sees
   * exactly what that person sees.
   */
  getEmployeeDay(employeeId: EmployeeId, workDate: string): Promise<EmployeeDay>;

  /**
   * Close `period`: from now on, ordinary writes into it are refused. Admin only, audited, and
   * ONE-WAY — see `AdminKintaiApi.lockPeriod`.
   */
  lockPeriod(period: string): Promise<void>;

  /**
   * Decide a waiting request from this screen — approve, return, or reject, with an optional
   * comment. Refused unless the org chart names the caller as a decider for it at its current
   * step, and refused for its own filer; being an administrator buys nothing. See
   * `AdminKintaiApi.decideSubmission` for why this writes directly rather than through the OS card.
   */
  decideSubmission(
    submissionId: number, action: ApprovalAction, afterEventId: number, comment?: string,
  ): Promise<SubmissionState>;
}

// Re-exported so worker-side callers of this API read its return type from the API's own module.
export type { KintaiIdentity };

/**
 * Thrown when an administrator with no employee record of their own tries to close a month.
 *
 * `period_locks.locked_by` is NOT NULL, and that is the right shape rather than an oversight: a
 * close is an act by a person, and "who closed this month" is the first thing anyone asks of a
 * closed month. The nullable actor columns elsewhere on this surface —
 * `audit_log.actor_employee_id`, `account_links.linked_by` — are nullable for a real case, the
 * first administrator acting before anybody is onboarded. This is the one operation that cannot
 * absorb it: there would be no row to write.
 *
 * NOT `UnlinkedAccountError`, which records the same fact with the wrong remedy. Its message says
 * "Contact HR to be set up", which is the right instruction for an employee whose Gadget cannot
 * resolve them and the wrong one here, because this caller IS HR. The fix is theirs to make and
 * takes one step they already have: read their own account code off `whoAmI` and link it to their
 * own employee record. So the message says that, and carries its own code, so an app can tell the
 * two situations apart.
 *
 * The code is repeated in the message because `code` is a plain own property and does not survive
 * the RPC boundary — the browser receives the message and nothing else.
 */
export class UnlinkedAdminError extends Error {
  readonly code = "KINTAI_ADMIN_NOT_LINKED";
  constructor(method: string) {
    super(
      `KINTAI_ADMIN_NOT_LINKED: ${method} records who performed it, and this account is not ` +
      "linked to an employee record. Link your own account to your own employee record first — " +
      "your account code is the one whoAmI() reports.",
    );
  }
}

/**
 * `whoAmI`, written once and shared by the admin and employee capabilities alike.
 *
 * A plain function rather than a base class so each capability still declares every method it
 * serves: `@validateRpc()` and the `implements` check both read what is written on the class, and
 * an inherited method is exactly the kind of thing that could go missing from one of those without
 * anyone noticing. Exported so `EmployeeKintaiApi` (in `kintai.ts`) answers `whoAmI` from the same
 * resolution as `AdminKintaiApi` — the employee reads their OWN account code off it, which is the
 * one thing every caller, admin or not, may do.
 */
export async function identify(
  store: DurableObjectStub<KintaiStore>, accountId: string,
): Promise<KintaiIdentity> {
  const employeeId = await store.resolveAccount(accountId, Date.now());
  const language = await store.languageFor(accountId);
  return { accountId, linked: employeeId !== null, employeeId, language };
}

/**
 * The capability handed to a Workshop administrator.
 *
 * Note what is NOT here: any way to act as another employee. This surface administers employee
 * records and the org graph; it does not punch, submit, or approve. An admin who wants to act as
 * an employee has to link an account to that employee and hold it — which is a linkable, audited
 * event rather than an ambient power.
 */
@validateRpc()
export class AdminKintaiApi extends RpcTarget implements KintaiAdminApi {
  readonly #store: DurableObjectStub<KintaiStore>;
  readonly #accountId: string;

  constructor(store: DurableObjectStub<KintaiStore>, accountId: string) {
    super();
    this.#store = store;
    this.#accountId = accountId;
  }

  async whoAmI(): Promise<KintaiIdentity> {
    return identify(this.#store, this.#accountId);
  }

  /**
   * Save the caller's own UI language, keyed on `this.#accountId` — never an argument, so there is
   * nothing for a caller to name but themselves. `null` forgets the choice instead: the OS sends
   * null for "system", meaning it wants Kintai to decide for itself again (its own saved
   * preference, then the browser) — see `setLanguage` in `store/preferences.ts` for why that has
   * to delete the row rather than store a null language.
   *
   * `language` is not re-checked here: it is `UiLanguage | null`, a string-literal union plus
   * `null`, and `@validateRpc()` refuses anything outside it before this body runs — the same
   * reason `setWorkDatePolicy` above does not re-check its own literal union either. No
   * `appendAudit` call, unlike every other mutation on this class: a UI language is a personal
   * display preference, not an administrative act over the org or its records, so `audit_log` —
   * which exists to record authority-relevant change — has nothing to say about it, forgetting one
   * included. See the doc comment on `account_preferences` in `schema.ts`.
   */
  async setLanguage(language: UiLanguage | null): Promise<void> {
    await this.#store.setLanguage(this.#accountId, language, Date.now());
  }

  /**
   * The roster, computed at one instant.
   *
   * `Date.now()` is read here and passed down, so every row is judged as of the same moment — a
   * roster whose rows disagreed about what time it is could show a manager edge as live in one row
   * and expired in the next. It is a server clock, never a caller-supplied one: `at` decides which
   * links and which org edges are in force, so accepting it as an argument would let a caller ask
   * what the roster looked like under a reporting line they no longer have.
   */
  async listEmployees(): Promise<RosterEntry[]> {
    return this.#store.listRoster(Date.now());
  }

  async listReportingLines(): Promise<ReportingLineRow[]> {
    return this.#store.listReportingLines();
  }

  /**
   * KNOWN LIMITATION, recorded here rather than in a review document: EVERY mutating method on
   * this class writes its audit entry in a SECOND RPC call to the store, so the mutation and its
   * audit entry are serialized but NOT atomic. A DO eviction or isolate kill between the two
   * round-trips persists the mutation with no audit record — on the identity-granting operations,
   * which is the worst place for it, and on `lockPeriod`, where it would leave a month closed with
   * nothing recording who closed it (the `period_locks` row keeps `locked_by`, so the actor
   * survives there even then — the same partial cover `linkAccount` has).
   *
   * Deferred deliberately. Closing it means threading an audit payload into the store primitives,
   * which also pulls `revoke()`'s `unlinkAccount` and every existing caller of `createEmployee`
   * into the audit trail — a change to the store contract, not a fix. The exposure is small (every
   * call in the pair targets the same singleton DO, on an admin-only path) but it is real.
   *
   * `linkAccount` is partly covered regardless: `account_links.linked_by` is written in the same
   * statement as the link itself, so that one operation keeps its actor even if the audit write is
   * lost, and `lockPeriod` the same way through `period_locks.locked_by`. `createEmployee`,
 * `setReportingLine`, `setDesignatedApprover` and `setWorkDatePolicy` do not.
   *
   * If this is revisited: for `linkAccount` alone the audit write could move AHEAD of the mutation,
   * since its `entityId` is the caller-supplied `employeeId` and does not depend on the write's
   * result. That flips the failure mode from "identity granted, no record" to "record, no grant",
   * which is the safer direction — at the cost of the entry meaning intent rather than fact.
   */
  async createEmployee(input: NewEmployee): Promise<EmployeeId> {
    const now = Date.now();
    await this.#assertNewEmployee(input);
    const actorEmployeeId = await this.#actor(now);
    const employeeId = await this.#store.createEmployee(input);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "create_employee", entity: "employees",
      entityId: employeeId, after: input,
    });
    return employeeId;
  }

  /**
   * Point `accountId` at `employeeId`, as HR onboarding an employee or handling an email change.
   *
   * This is the method that grants identity, and the reason part 1 stops before any real UI: an
   * account is inert until this runs, and afterwards it speaks as that employee everywhere —
   * including as whatever manager the employee is. Two properties keep that safe, and both are
   * structural rather than checks in this body:
   *
   *  - only an administrator can reach it at all, because `startAppUi` never builds this class for
   *    anyone else, and
   *  - `linkedBy` is the CALLER's own employee id, resolved here from their own capability, never
   *    an argument. An admin cannot record the link as someone else's doing.
   *
   * `linkedBy` is left unset when the acting admin has no employee record of their own — a real
   * case (the first administrator, before anybody is onboarded), and the column is nullable for it.
   * Everything else about re-linking, including closing whatever link was open on either side, is
   * the store's `linkAccount`; this adds no second opinion about it.
   */
  async linkAccount(accountId: string, employeeId: EmployeeId): Promise<void> {
    const now = Date.now();
    assertRequiredText("account code", accountId, LIMITS.accountId);
    assertEmployeeId("employee", employeeId);
    await this.#assertEmployeeExists(employeeId);
    const linkedBy = await this.#actor(now);
    // Read before the write, so the entry records what this account resolved to beforehand. For
    // the operation that grants identity, "who was this before" is the question an auditor asks
    // first, and it is unrecoverable once the old link is closed.
    const previous = await this.#store.resolveAccount(accountId, now);
    await this.#store.linkAccount(accountId, employeeId, now, linkedBy ?? undefined);
    await this.#store.appendAudit({
      at: now, actorEmployeeId: linkedBy, action: "link_account", entity: "account_links",
      entityId: employeeId,
      before: previous === null ? undefined : { accountId, employeeId: previous },
      after: { accountId, employeeId },
    });
  }

  /**
   * Opens the line now and leaves it open; closing and back-dating are part 2's problem.
   *
   * Audited because a reporting line grants approval authority over another employee's
   * submissions — writing one is handing out signing power, and until now it recorded no actor at
   * all.
   */
  async setReportingLine(employeeId: EmployeeId, managerId: EmployeeId): Promise<void> {
    const now = Date.now();
    assertEmployeeId("employee", employeeId);
    assertEmployeeId("manager", managerId);
    // Refused rather than written, because a self-edge can never authorise anything: self-approval
    // is rejected outright by `actOnSubmission`, and `hasReachableApprover` therefore filters
    // self-edges out when deciding whether an employee is approvable at all. Writing one would
    // hand HR a reporting line that looks like progress, leave the roster still showing the
    // employee as unable to file, and give no clue why. This is an input check standing in front
    // of that rule, not a second copy of it — the rule itself stays where it is enforced.
    if (employeeId === managerId) {
      throw new InvalidInputError(
        "an employee cannot report to themselves: nobody may approve their own submissions, so " +
        "the line would grant no authority.",
      );
    }
    await this.#assertEmployeeExists(employeeId);
    await this.#assertEmployeeExists(managerId);
    const actorEmployeeId = await this.#actor(now);
    const edgeId = await this.#store.setReportingLine(employeeId, managerId, now);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "set_reporting_line", entity: "org_edges",
      entityId: edgeId, after: { employeeId, managerId, validFrom: now },
    });
  }

  /**
   * Name the person who may approve for an employee who reports to nobody.
   *
   * The escape hatch that could not be reached. `designated_approver_id` is documented in
   * `store/employees.ts` as "the escape hatch for employees at the root of the reporting tree" and
   * was settable only when the record was created — so employee 1, created before anybody exists
   * to name, could never be given one, and after an exemption stopped counting as an approver they
   * could file nothing at all. Same shape as `setReportingLine`: opens now, audited, and it is
   * granting signing authority over somebody else's payroll input.
   *
   * An UPDATE rather than a new row, unlike `setReportingLine` and `grantExemption`. Justified at
   * length on `store/employees.ts`'s `setDesignatedApprover`: this column says who may approve
   * NOW, who actually approved a submission is recorded on `approval_events` beside the action,
   * and the previous value is preserved here in `audit_log`.
   *
   * Two refusals, and only two:
   *
   *  - SELF-DESIGNATION, refused for the reason `setReportingLine` refuses a self-edge. Nobody may
   *    approve their own submissions, so `hasReachableApprover` and `requiredApprovers` both
   *    already collapse a self-reference to "no approver" and fail closed. Writing one would leave
   *    HR looking at a filled-in field, a row still not ready, and no clue why.
   *  - AN APPROVER WHO DOES NOT EXIST. The foreign key would refuse it anyway; this refuses it in
   *    a sentence, as `#assertNewEmployee` already does for the same column at creation.
   *
   * Deliberately NOT refused, and each considered:
   *
   *  - an approver who is themselves unreachable. Whether B can have their OWN requests approved
   *    has nothing to do with whether B can approve A's — the two are different questions about
   *    different people, and conflating them would refuse a perfectly good arrangement (a 代表
   *    signing for the 専務 who signs for nobody) on the strength of an unrelated gap.
   *  - a cycle. Two officers designated as each other's approver is a real arrangement and breaks
   *    nothing: nothing in this package walks `designated_approver_id` transitively. `authorize`
   *    and `requiredApprovers` each take exactly one hop, and the only shape that strands is the
   *    zero-length one — self-designation — which is refused above. A cycle check would be code
   *    defending against a traversal that does not exist.
   *  - clearing it. There is no way here to set it back to nobody, exactly as there is no way to
   *    close a reporting line or end an exemption; removing an approver is a de-authorisation and
   *    belongs with those when they land. Re-pointing it at somebody else works today.
   */
  async setDesignatedApprover(employeeId: EmployeeId, approverId: EmployeeId): Promise<void> {
    const now = Date.now();
    assertEmployeeId("employee", employeeId);
    assertEmployeeId("approver", approverId);
    if (employeeId === approverId) {
      throw new InvalidInputError(
        "an employee cannot be their own designated approver: nobody may approve their own " +
        "submissions, so it would grant no authority and leave them unable to file.",
      );
    }
    await this.#assertEmployeeExists(employeeId);
    await this.#assertEmployeeExists(approverId);
    const actorEmployeeId = await this.#actor(now);
    // Read before the write, for the reason `linkAccount` and `setWorkDatePolicy` both do it: this
    // is an overwrite, so "who could sign for them before" is unrecoverable from the row once it
    // is gone, and it is the first question asked of a change to who may approve.
    const previous = await this.#store.designatedApproverOf(employeeId);
    await this.#store.setDesignatedApprover(employeeId, approverId);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "set_designated_approver", entity: "employees",
      entityId: employeeId,
      before: { employeeId, approverId: previous },
      after: { employeeId, approverId },
    });
  }

  /**
   * Record a 管理監督者 period, open from now.
   *
   * Additive, exactly as `setReportingLine` is: the period opens at the server's clock and stays
   * open, and there is no way here to close one, back-date one, or edit one. That is the same
   * decision for the same reason — this table is a temporal record an audit reads, and a control
   * that rewrites it is a different feature with a different review. Ending an exemption is a
   * genuine gap and a deliberate one.
   *
   * Refused when the employee is ALREADY 管理監督者 at this instant. Not a new rule: the check is
   * `isExempt`, the same function `hasReachableApprover` and the premium calculation ask. A second
   * open period would change nothing about the answer and would leave two rows claiming to be the
   * determination, which is the sort of thing that has to be explained later. A period that has
   * been closed is not in the way — `isExempt` is false then, and a fresh grant is right.
   *
   * The window is `Date.now()` here, never an argument: when someone became 管理監督者 decides
   * which of their past overtime was premium-bearing, and that is not a caller's to choose.
   */
  async grantExemption(employeeId: EmployeeId): Promise<void> {
    const now = Date.now();
    assertEmployeeId("employee", employeeId);
    await this.#assertEmployeeExists(employeeId);
    if (await this.#store.isExempt(employeeId, now)) {
      throw new InvalidInputError(
        "this employee is already recorded as 管理監督者. Ending an exemption is not supported " +
        "here yet.",
      );
    }
    const actorEmployeeId = await this.#actor(now);
    const periodId = await this.#store.grantExemption(employeeId, now);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "grant_exemption", entity: "exemption_periods",
      entityId: periodId, after: { employeeId, kind: "kanri_kantokusha", validFrom: now },
    });
  }

  /**
   * Record which day this employee's punches are filed against, from now on.
   *
   * Written as a plain UPDATE with an audit entry, rather than as a temporal period like
   * `grantExemption`'s. The two are genuinely different: an exemption says something about a span
   * of time that has already partly happened, so its window is the answer; a work-date policy is
   * consulted once, at the instant a punch is recorded, and its verdict is then written into that
   * punch's `work_date` and never revisited. The punches ARE the history of this setting, and a
   * second history kept beside them could only ever contradict them. `audit_log` carries who
   * changed it and what it was before, which is what an inspection asks.
   *
   * Setting the policy an employee is already on is allowed and is a no-op with an honest audit
   * entry whose `before` and `after` agree. It is NOT refused the way a duplicate exemption is:
   * that refusal exists because a second open `exemption_periods` row would leave two records
   * claiming to be the determination, and there is only ever one row here.
   *
   * KNOWN LIMITATION, deliberately not blocked here: changing the policy while the employee has a
   * shift open STRANDS that shift. `shift_start` → `calendar` is the visible half — the clock-in
   * is already filed against the shift's own date, the clock-out then lands on the calendar date,
   * and the one shift splits across two days as `unpaired_in` + `orphan_out`, which is exactly the
   * bug `shift_start` exists to prevent, reintroduced for one shift. It fails SAFE (it
   * under-credits, and both days carry a flag a human must resolve), so it is not refused: this
   * call cannot tell an urgent correction from a routine one, and blocking HR from fixing a
   * misconfigured employee until their shift ends would be worse than a flagged day. The reverse
   * direction heals an in-flight shift rather than stranding it. The HR form says so at the point
   * of change; see `WorkDatePolicyForm` in `app/AdminPage.tsx`.
   */
  async setWorkDatePolicy(employeeId: EmployeeId, policy: WorkDatePolicy): Promise<void> {
    const now = Date.now();
    assertEmployeeId("employee", employeeId);
    // `policy` is NOT re-checked here. It is a string-literal union, which is a TYPE, and
    // `@validateRpc()` refuses anything outside it before this body runs -- the same reason
    // nothing on this surface re-checks that a string is a string. The schema's CHECK constraint
    // is the backstop behind that. A third opinion here is exactly the duplicated rule this
    // package keeps being bitten by; the refusal is pinned by a test instead.
    await this.#assertEmployeeExists(employeeId);
    const actorEmployeeId = await this.#actor(now);
    // Read before the write. "What was it before" is the whole question for a setting that is not
    // retroactive: it is what says which of this employee's existing punches were filed under a
    // different rule, and it is unrecoverable from the row once overwritten.
    const previous = await this.#store.workDatePolicy(employeeId);
    await this.#store.setWorkDatePolicy(employeeId, policy);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "set_work_date_policy", entity: "employees",
      entityId: employeeId,
      before: { employeeId, workDatePolicy: previous },
      after: { employeeId, workDatePolicy: policy },
    });
  }

  /**
   * The whole company's waiting queue, judged at one instant.
   *
   * `Date.now()` is read here and passed down, for the reason `listEmployees` does it: `waitingMs`
   * and "who may act on this" are both answers about a moment, and a screen whose rows disagreed
   * about what time it is could age one row against one clock and decide another's authority
   * against a different one. It is a server clock and never an argument — `now` decides which org
   * edges and which account links are in force, so accepting one would let a caller ask who could
   * have approved under a reporting line that has since been closed.
   *
   * Unaudited, like every read on this surface (see `listEmployees`). `audit_log` records
   * authority-relevant CHANGES; a read of the queue changes nothing, and an entry per dashboard
   * open would bury the entries that matter.
   */
  async listPendingOverview(): Promise<PendingItem[]> {
    return this.#store.pendingOverview(Date.now());
  }

  /**
   * The month's flagged days.
   *
   * `assertPeriod` here AND inside `anomalousDays`, and that is not two opinions: it is the same
   * imported function called at the boundary that accepts a typed-in month, exactly as
   * `createEmployee` calls the same `assertWorkDate` the session facet calls. The boundary check is
   * what turns a form typo into a sentence before a round trip; the store's is what protects the
   * `WHERE work_date LIKE ?` scan from a caller that is not this class.
   */
  async listAnomalousDays(period: string): Promise<AnomalousDay[]> {
    assertPeriod("period", period);
    return this.#store.anomalousDays(period);
  }

  /** One month's totals per employee, plus whether it is closed. See `monthlyTotals`. */
  async monthlyReport(period: string): Promise<MonthlyReport> {
    assertPeriod("period", period);
    return this.#store.monthlyTotals(period);
  }

  /**
   * One employee's one day, punch by punch.
   *
   * `assertWorkDate` IS LOAD-BEARING HERE, and this is the only place it can be. `employeeDay`
   * takes its work date on trust — deliberately, matching every other store read, because every
   * worker-side caller has already derived it from a policy or a punch row — and this method is
   * the surface untrusted input reaches. A malformed date reaching the store is not refused by
   * anything: `work_date` is TEXT with no CHECK, and a query for `"banana"` simply finds no rows,
   * so the screen would report an employee with no punches on a day that does not exist rather
   * than saying what was wrong.
   *
   * `assertEmployeeId` is shape only, and there is deliberately no existence check behind it. This
   * is a read: no foreign key can fire, so there is no 500 to turn into a sentence (which is what
   * `#assertEmployeeExists` exists for, ahead of the WRITES). An id that names nobody returns an
   * empty day, which is also the honest answer for a real employee who did not work — and the
   * caller got the id from a row this same surface handed it.
   */
  async getEmployeeDay(employeeId: EmployeeId, workDate: string): Promise<EmployeeDay> {
    assertEmployeeId("employee", employeeId);
    assertWorkDate("work date", workDate);
    return this.#store.employeeDay(employeeId, workDate);
  }

  /**
   * Close a month, and make every punch in it final.
   *
   * The fourth confirmed implemented-but-unreachable feature in this package, and the one with
   * teeth: `period_locks` has been enforced by `KintaiSession.punch` and by `assertWritable` since
   * the beginning, and nothing outside the worker could write a row into it — so no month could
   * ever be closed, and `setAllocations`, the one write in this system with no approval behind it,
   * could rewrite a paid month indefinitely. This is the call that closes that.
   *
   * ONE-WAY. There is no unlock here and none in the store, because reopening a month is a
   * decision nobody has made: it would have to say what happens to the amendments filed against
   * the closed month, and to a payroll run already made from it. The HR form says so at the point
   * of pressing it.
   *
   * `lockedBy` is the CALLER's own employee id, resolved from their own capability and never an
   * argument, exactly as `linkAccount`'s is. An administrator cannot record the close as somebody
   * else's doing. Unlike `linkAccount` it cannot fall back to "unset" when the acting admin has no
   * employee record — `period_locks.locked_by` is NOT NULL — so that case is refused instead; see
   * `UnlinkedAdminError` for why the column is right and the refusal is not a workaround.
   *
   * TWO REFUSALS ARE NOT CHECKED HERE, and their absence is deliberate. A month ALREADY CLOSED,
   * and a month THAT HAS NOT STARTED, are both refused by `lockPeriod` in `store/periods.ts`, in
   * the same synchronous run as the INSERT. For already-closed that placement is the only correct
   * one — a check in this body would read over one RPC and write over another, so two admins
   * pressing the button together would both be told they closed the month. For the future bound it
   * is a choice: a row in `period_locks` is permanent and refuses every write into its month, so
   * one mistyped year would stop the whole company clocking in when that month arrived, and a
   * guard on a write that cannot be undone belongs against the write rather than in front of the
   * one caller that exists today. See that function's comment for both. What this body does is
   * make sure the refusals can happen at all — the read below is the audit entry's, not a rule's.
   *
   * `assertPeriod` IS still called here, and it is not the store's copy repeated: this is the
   * boundary that accepts a typed-in month, and refusing a form typo before a round trip is what
   * it is for. The store asserts it again because its own two later checks depend on the shape.
   *
   * Read before the write, as `linkAccount`, `setDesignatedApprover` and `setWorkDatePolicy` all
   * do. `before` records the state this call changed FROM, read rather than assumed: an audit
   * entry is read years later by somebody who does not know that a second close is impossible, and
   * an entry that asserted "it was open" without having looked would be a claim about a table
   * rather than a reading of it. If a reopen flow ever lands, this entry stays honest.
   *
   * No `entityId`. `period_locks` is keyed on the period, which is TEXT, and
   * `audit_log.entity_id` is an INTEGER — a number here would join back to the wrong table. The
   * period travels in `before`/`after` instead, which is where a reader looks for it anyway.
   */
  async lockPeriod(period: string): Promise<void> {
    const now = Date.now();
    assertPeriod("period", period);
    const actorEmployeeId = await this.#actor(now);
    if (actorEmployeeId === null) throw new UnlinkedAdminError("lockPeriod");
    const previous = await this.#store.periodLock(period);
    await this.#store.lockPeriod(period, actorEmployeeId, now);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "lock_period", entity: "period_locks",
      before: { period, locked: previous !== null },
      after: { period, lockedBy: actorEmployeeId, lockedAt: now },
    });
  }

  /**
   * Decide a waiting request from the dashboard.
   *
   * The agent path stages a decision and submits it to the Overseer's `ApprovalQueue`; a human
   * confirms it on an OS card, and `KintaiGatekeeper.applyAction` performs the write later. That
   * queue is not reachable from here: the Workshop hands `startAppUi` only `{ isAdmin }`, and the
   * queue goes to `startSession` alone. So this decision is confirmed in Kintai's own UI and written
   * directly — the same shape as every other write on this class, and for the same reason the OS
   * gate does not apply to them: the gate exists to keep a possibly prompt-injected AGENT from
   * exercising authority unattended, and the person pressing this button is the human the gate
   * would have asked.
   *
   * What does not change is the authority. `store.actOnSubmission` runs `checkMayAct` in the same
   * call as the write: the caller must be a decider the org chart names for THIS request at its
   * CURRENT step, and may not be its filer. The dashboard shows the buttons only on rows whose
   * `eligibleActorIds` name the viewer, and that list is computed by the same check — so what the
   * buttons promise is what the write accepts, and a row that moved in between is refused here.
   *
   * `afterEventId` is REQUIRED, and is the marker the row was read with (`PendingItem.afterEventId`).
   * The agent path stages a decision with the marker it saw and the store refuses to apply it if
   * the request's history moved in between; without the same guard here, one manager on a route
   * with two manager steps approved step 0, watched the row re-render unchanged, clicked again, and
   * approved step 1 — one intent, two approvals. Now the second click is refused with
   * `KINTAI_STALE_DECISION`, and a deliberate second decision needs a fresh read. The compare
   * and the write are one synchronous run inside the store, so nothing slips between them.
   *
   * Answers with the request's state AFTER the decision: `"pending"` means the route advanced to
   * another step and the row will still be on the screen — the caller has to say so, because a
   * click that landed and a click that did nothing otherwise look identical.
   *
   * `approval_events` is the decision's record, exactly as for the agent path. The audit row adds
   * the one fact that record cannot carry: which channel it came through, so a reader can tell a
   * dashboard decision from a staged one.
   */
  async decideSubmission(
    submissionId: number, action: ApprovalAction, afterEventId: number, comment?: string,
  ): Promise<SubmissionState> {
    const now = Date.now();
    if (comment !== undefined) assertText("comment", comment, LIMITS.comment);
    // An empty comment is no comment — the same rule `KintaiSession.actOnSubmission` applies, so
    // the two channels record the same thing for the same input.
    if (comment === "") comment = undefined;
    const actorEmployeeId = await this.#actor(now);
    if (actorEmployeeId === null) throw new UnlinkedAdminError("decideSubmission");
    const state = await this.#store.actOnSubmission({
      submissionId, actorId: actorEmployeeId, action, comment, now,
      expectedAfterEventId: afterEventId,
    });
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "decide_submission", entity: "submissions",
      entityId: submissionId,
      after: { submissionId, decision: action, state, channel: "dashboard" },
    });
    return state;
  }

  /**
   * Reject a `NewEmployee` that the schema would accept but HR could not live with.
   *
   * `@validateRpc()` already rejects anything of the wrong TYPE, which is why nothing here
   * re-checks that a string is a string. What it cannot see is meaning, and until part 2 these
   * values came from other worker code rather than from a form:
   *
   *  - `joinedOn` reaches a TEXT column with no CHECK, and every downstream reader treats a work
   *    date as parseable. `assertWorkDate` is the SAME check the session facet applies to every
   *    other date in this package, imported rather than rewritten: it is the one that catches
   *    "2026-02-31", which the regex alone accepts and `Date.parse` silently rolls into March.
   *  - `displayName` is NOT NULL but has no CHECK against emptiness, and it is what every approver
   *    sees in their queue. A blank one is a row HR cannot recognise afterwards.
   *  - the text fields are bounded, because this all lands in the one Durable Object that holds
   *    every employee's payroll record.
   *  - `designatedApproverId` is one of only three ways an employee can ever have a submission
   *    approved, so pointing it at a record that does not exist creates precisely the silently
   *    unusable employee this screen exists to make visible. The foreign key would refuse it
   *    anyway; this refuses it in a sentence.
   *
   * Duplicate employee numbers are NOT checked here. That constraint lives in the schema and is
   * translated where it fires, in `store/employees.ts`'s `createEmployee` — checking first would
   * be a second opinion that a concurrent call could invalidate between the read and the write.
   */
  async #assertNewEmployee(input: NewEmployee): Promise<void> {
    assertRequiredText("employee number", input.employeeNumber, LIMITS.employeeNumber);
    assertRequiredText("name", input.displayName, LIMITS.displayName);
    if (input.department !== undefined) {
      assertText("department", input.department, LIMITS.department);
    }
    if (input.employmentType !== undefined) {
      assertText("employment type", input.employmentType, LIMITS.employmentType);
    }
    assertWorkDate("joining date", input.joinedOn);
    if (input.designatedApproverId !== undefined) {
      assertEmployeeId("designated approver", input.designatedApproverId);
      await this.#assertEmployeeExists(input.designatedApproverId);
    }
  }

  /**
   * Refuse an employee id that names no record, with a coded error rather than a foreign key.
   *
   * The foreign keys are real and enforced (workerd runs SQLite with them on — a link to a missing
   * employee raises `FOREIGN KEY constraint failed`), so this is not what keeps the data honest.
   * It is what turns "500" into a sentence HR can act on, ahead of the write.
   *
   * There is no check-then-write race behind it: nothing in this package ever deletes an employee
   * row — revocation closes an account link and departure sets a status — so a record that exists
   * at the check still exists at the write. If a delete is ever added, this becomes advisory and
   * the foreign key stays the guard.
   */
  async #assertEmployeeExists(employeeId: EmployeeId): Promise<void> {
    if (!await this.#store.employeeExists(employeeId)) {
      throw new EmployeeNotFoundError(employeeId);
    }
  }

  /**
   * The acting admin's own employee id, or null when they have no employee record.
   *
   * Resolved from their own capability on every call, never taken as an argument: the actor on an
   * authority-changing audit entry is the one field an admin must not be able to choose. Null is a
   * real case — the first administrator, before anybody is onboarded — and `actor_employee_id` is
   * nullable for it.
   */
  async #actor(now: number): Promise<EmployeeId | null> {
    return this.#store.resolveAccount(this.#accountId, now);
  }
}
