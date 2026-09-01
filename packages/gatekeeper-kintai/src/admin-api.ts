import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { EmployeeId, KintaiIdentity, RosterEntry, WorkDatePolicy } from "./types.js";
import type { NewEmployee } from "./store/employees.js";
import { EmployeeNotFoundError } from "./store/employees.js";
import type { ReportingLineRow } from "./store/org.js";
import type { KintaiStore } from "./store/kintai-store.js";
import {
  assertEmployeeId, assertRequiredText, assertText, assertWorkDate, InvalidInputError, LIMITS,
} from "./input.js";

/**
 * The HR admin surface, served to the management app at `/gatekeepers/kintai`.
 *
 * Two classes implement this interface, and which one a browser gets is decided once, server-side,
 * in `KintaiAccount.startAppUi()` from the `isAdmin` the Workshop supplies. `AdminKintaiApi` does
 * the work; `ViewerKintaiApi` refuses everything but `whoAmI`. The flag itself never reaches the
 * iframe, so there is nothing for a browser to lie about — a non-admin's capability simply has no
 * admin behaviour behind it.
 *
 * Both classes `implements KintaiAdminApi`, which is the load-bearing part: adding a REQUIRED
 * member to this interface makes both classes fail to compile until someone writes down whether a
 * non-admin may call it. This mirrors `UseOverseerInterface` in `workshop-backend`, for the same
 * reason (see docs/sharing.md).
 *
 * Know the two things that guard does NOT cover, because both compile clean:
 *
 *  - a public method added to `ViewerKintaiApi` itself that is absent from this interface. It is
 *    callable over RPC, and `implements` says nothing about it. (Narrowing the decorator to
 *    `@validateRpc<KintaiAdminApi>()` does generate a narrowed `methods` map, but
 *    capnweb-validate 0.3.0's runtime wrapper dispatches the extra method regardless.)
 *  - an OPTIONAL member (`foo?(): Promise<void>`) added here, which both classes satisfy without
 *    implementing.
 *
 * Neither is caught by the compiler, so both are caught by the test instead: see "exposes exactly
 * the interface" in `__tests__/admin-api.test.ts`, which pins the callable surface of both classes
 * against a written-out list of these members. Add a member here and that list must change too.
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
   * Record that `employeeId` is 管理監督者, from now, open-ended. Admin only.
   *
   * Here because it is the only way to complete an employee at the top of the organisation
   * honestly. `hasReachableApprover` accepts three answers, and the other two both require someone
   * above them: a reporting line, or a designated approver. For a company officer there is nobody,
   * so without this the only route to a usable record is a reporting line that does not exist —
   * writing a fiction into the org chart to get a green tick, in the table an audit reads.
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
}

// Re-exported so worker-side callers of this API read its return type from the API's own module.
export type { KintaiIdentity };

/**
 * Thrown when a non-admin capability is asked for something only HR may do.
 *
 * The code is repeated in the message, as every other error in this package does, because `code`
 * is a plain own property and does not survive the RPC boundary — the browser receives the message
 * and nothing else.
 */
export class AdminRequiredError extends Error {
  readonly code = "KINTAI_ADMIN_REQUIRED";
  constructor(method: string) {
    super(
      `KINTAI_ADMIN_REQUIRED: ${method} is available to Workshop administrators only. ` +
      "Ask an administrator to make this change.",
    );
  }
}

/**
 * `whoAmI` for both capabilities, written once.
 *
 * Shared as a function rather than through a base class so each class still declares every method
 * it serves: `@validateRpc()` and the `implements` check both read what is written on the class,
 * and an inherited method is exactly the kind of thing that could go missing from one of those
 * without anyone noticing.
 */
async function identify(
  store: DurableObjectStub<KintaiStore>, accountId: string,
): Promise<KintaiIdentity> {
  const employeeId = await store.resolveAccount(accountId, Date.now());
  return { accountId, linked: employeeId !== null, employeeId };
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
   * KNOWN LIMITATION, recorded here rather than in a review document: the three mutating methods
   * below write their audit entry in a SECOND RPC call to the store, so the mutation and its audit
   * entry are serialized but NOT atomic. A DO eviction or isolate kill between the two round-trips
   * persists the mutation with no audit record — on the identity-granting operations, which is the
   * worst place for it.
   *
   * Deferred deliberately. Closing it means threading an audit payload into the store primitives,
   * which also pulls `revoke()`'s `unlinkAccount` and every existing caller of `createEmployee`
   * into the audit trail — a change to the store contract, not a fix. The exposure is small (all
   * four calls target the same singleton DO, on an admin-only path) but it is real.
   *
   * `linkAccount` is partly covered regardless: `account_links.linked_by` is written in the same
   * statement as the link itself, so that one operation keeps its actor even if the audit write is
   * lost. `createEmployee` and `setReportingLine` do not.
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

/**
 * The capability handed to everyone who is not a Workshop administrator.
 *
 * Every member of `KintaiAdminApi` is written out, and all but `whoAmI` refuse. That is
 * deliberately more verbose than a check inside each admin method would be, and it buys the one
 * thing a check cannot: because this class `implements KintaiAdminApi`, a REQUIRED member added to
 * that interface in part 2 fails to compile here until a developer decides whether non-admins may
 * call it. The failure mode of forgetting is a build error, not a quietly-widened surface.
 *
 * The compiler's reach stops there. A public method added to THIS CLASS but not to the interface,
 * and an optional member added to the interface, both compile clean and would widen what a
 * non-admin can call — see the interface's own comment. The surface test is what covers those, and
 * it is not optional decoration.
 *
 * `never` as the return type rather than the interface's `Promise<...>`: `never` satisfies any
 * return type, and writing it says the body cannot produce a value at all, which is the point.
 * The parameters are still spelled out so the refusal cannot be dodged by shape.
 */
@validateRpc()
export class ViewerKintaiApi extends RpcTarget implements KintaiAdminApi {
  readonly #store: DurableObjectStub<KintaiStore>;
  readonly #accountId: string;

  constructor(store: DurableObjectStub<KintaiStore>, accountId: string) {
    super();
    this.#store = store;
    this.#accountId = accountId;
  }

  /** Allowed: reading your own account code is how you get yourself onboarded. */
  async whoAmI(): Promise<KintaiIdentity> {
    return identify(this.#store, this.#accountId);
  }

  /** Refused: the roster is the company's headcount, not a directory for every employee. */
  listEmployees(): never {
    throw new AdminRequiredError("listEmployees");
  }

  /** Refused: the org chart is administrative data. */
  listReportingLines(): never {
    throw new AdminRequiredError("listReportingLines");
  }

  /** Refused: creating employee records is HR's job. */
  createEmployee(_input: NewEmployee): never {
    throw new AdminRequiredError("createEmployee");
  }

  /**
   * Refused, and this is the one that matters most: `linkAccount` maps an account capability onto
   * an employee record. Reachable by a non-admin, it would let anyone become anyone — a manager
   * included — and every authority check in the approval path would then pass for them honestly,
   * because they really would be that employee as far as the store is concerned.
   */
  linkAccount(_accountId: string, _employeeId: EmployeeId): never {
    throw new AdminRequiredError("linkAccount");
  }

  /**
   * Refused: a reporting line grants authority over someone else's submissions, so writing one is
   * granting approval power.
   */
  setReportingLine(_employeeId: EmployeeId, _managerId: EmployeeId): never {
    throw new AdminRequiredError("setReportingLine");
  }

  /**
   * Refused: 管理監督者 is a determination about an employee's authority that exempts their
   * overtime from premium pay. Reachable by the employee it describes, it would be a way to write
   * one's own exemption from 労働基準法 §37 into the payroll record.
   */
  grantExemption(_employeeId: EmployeeId): never {
    throw new AdminRequiredError("grantExemption");
  }

  /**
   * Refused: which day a punch is filed against decides what an employee's night hours are worth.
   * Reachable by the employee it describes, it would be a way to move one's own overnight hours
   * onto a different day — and, on the other side, a way to split a colleague's shift in two and
   * flag every day they work.
   */
  setWorkDatePolicy(_employeeId: EmployeeId, _policy: WorkDatePolicy): never {
    throw new AdminRequiredError("setWorkDatePolicy");
  }
}
