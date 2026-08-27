import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { EmployeeId, KintaiIdentity } from "./types.js";
import type { EmployeeRow, NewEmployee } from "./store/employees.js";
import type { ReportingLineRow } from "./store/org.js";
import type { KintaiStore } from "./store/kintai-store.js";

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

  /** The whole roster. Admin only — this is the company's headcount. */
  listEmployees(): Promise<EmployeeRow[]>;

  /** Every reporting edge, closed windows included. Admin only — this is the org chart. */
  listReportingLines(): Promise<ReportingLineRow[]>;

  /** Create an employee record. Admin only. */
  createEmployee(input: NewEmployee): Promise<EmployeeId>;

  /**
   * Point an account capability at an employee record. Admin only, and the most dangerous method
   * in this package — see `AdminKintaiApi.linkAccount`.
   */
  linkAccount(accountId: string, employeeId: EmployeeId): Promise<void>;

  /** Open a reporting line from `employeeId` to `managerId`, effective now. Admin only. */
  setReportingLine(employeeId: EmployeeId, managerId: EmployeeId): Promise<void>;
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

  async listEmployees(): Promise<EmployeeRow[]> {
    return this.#store.listEmployees();
  }

  async listReportingLines(): Promise<ReportingLineRow[]> {
    return this.#store.listReportingLines();
  }

  async createEmployee(input: NewEmployee): Promise<EmployeeId> {
    const now = Date.now();
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
    const actorEmployeeId = await this.#actor(now);
    const edgeId = await this.#store.setReportingLine(employeeId, managerId, now);
    await this.#store.appendAudit({
      at: now, actorEmployeeId, action: "set_reporting_line", entity: "org_edges",
      entityId: edgeId, after: { employeeId, managerId, validFrom: now },
    });
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
}
