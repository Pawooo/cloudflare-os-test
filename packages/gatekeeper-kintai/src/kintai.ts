import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorContract,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ApprovalAction, EmployeeId, PunchKind, SubmissionState } from "./types.js";
import type { AllocationEntry, AllocationRow, Reconciliation } from "./store/allocations.js";
import type { PunchLocation, PunchRow } from "./store/punches.js";
import type { SubmissionRow } from "./store/submissions.js";
import type { KintaiStore } from "./store/kintai-store.js";
import { UnlinkedAccountError } from "./store/employees.js";
import TYPES_CODE from "./types.txt";

const KINTAI_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm40-88a8 8 0 0 1-8 8h-32a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v40h24a8 8 0 0 1 8 8Z'/></svg>",
    ),
};

@validateRpc()
export class GatekeeperVendor
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperVendorContract
{
  /** Describes the auto-provisioned Kintai vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Kintai",
      url: "https://workers.cloudflare.com/",
      logo: KINTAI_ICON,
      tagline: "Attendance, overtime and approvals",
      description: "Records attendance and routes overtime requests for approval.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /**
   * Mints a new opaque Kintai account capability.
   *
   * The accountId is generated here and never derived from anything the caller supplies — the
   * Workshop persists the returned account and is the authority on who holds it thereafter. Kintai
   * itself never interprets the value; `account_links` maps it to an employee and HR owns that
   * mapping. A freshly minted account is therefore inert until HR links it.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.KintaiAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because Kintai is auto-provisioned and holds no credentials. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Kintai is auto-provisioned and has no connect flow.");
  }

  /**
   * Returns no URL-addressed resources: Kintai is ambient-only.
   *
   * Required even though the list is empty. The admin panel resolves every vendor with
   * `Promise.all([describe(), getSupportedResources()])` and drops any vendor whose entry rejects,
   * so a vendor missing this method is silently absent from the Gatekeepers panel rather than
   * appearing with no resources.
   */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing Kintai declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

/**
 * Rejects malformed input at the facet, the untrusted boundary.
 *
 * A raw SQLite CHECK violation would surface as an uncoded error the RPC boundary can only turn
 * into a 500, and most of these values reach no CHECK at all: `Date.parse("banana")` is `NaN` and
 * `periodOf("banana")` is `"banana"`, so junk dates sail past the exemption, approver-reachability
 * and period-lock queries and persist. Coded, like `SubmissionNotFoundError`, because a malformed
 * argument is an ordinary client mistake.
 */
export class InvalidInputError extends Error {
  readonly code = "KINTAI_INVALID_INPUT";
  constructor(detail: string) {
    super(`KINTAI_INVALID_INPUT: ${detail}`);
  }
}

const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real JST calendar date in `YYYY-MM-DD` form.
 *
 * The round-trip is not redundant with the pattern: "2026-02-31" and "2026-13-01" both match it,
 * and `Date.parse` silently rolls them over into March and January rather than failing.
 */
function assertWorkDate(label: string, value: string): void {
  if (typeof value !== "string" || !WORK_DATE.test(value)) {
    throw new InvalidInputError(`${label} must be a calendar date in YYYY-MM-DD form.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidInputError(`${label} is not a real calendar date: ${value}.`);
  }
}

/** Minutes are whole and never negative; the schema's CHECKs are the backstop, not the message. */
function assertMinutes(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidInputError(`${label} must be a whole number of minutes, and not negative.`);
  }
}

type KintaiProps = { accountId: string };

/** Describes the auto-provisioned Kintai account and its ambient singleton. */
export function describeKintaiAccount(): AccountDescription {
  return {
    displayName: "Kintai",
    avatar: KINTAI_ICON,
    // No `providesUi`: the HR/admin surface (mapping accounts to employees, closing periods) is a
    // later sub-project. Every member of `GatekeeperUser` this account does declare is implemented,
    // so the Workshop never reaches a method that is not here.
    singleton: { tsType: "KintaiSession" },
  };
}

/**
 * One employee's account capability: the out-of-band identity a Gadget's own Durable Object cannot
 * establish for itself.
 *
 * Kintai is resourceless. It addresses nothing by URL, holds no credentials, and has no connect
 * flow, so most of `GatekeeperUser` is a principled refusal rather than an implementation — the
 * same shape `ScheduleAccount` takes. The one member with real behaviour is `revoke()`.
 */
@validateRpc()
export class KintaiAccount
  extends WorkerEntrypoint<Cloudflare.Env, KintaiProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Kintai account and its ambient workspace singleton. */
  async describe(): Promise<AccountDescription> {
    return describeKintaiAccount();
  }

  /**
   * The workspace facet class, imbued with this account's capability.
   *
   * Props are bound to the CLASS here, not to an instance name: `getByName` takes a name only. The
   * accountId therefore travels with the class reference and cannot be chosen by whoever later
   * instantiates it. That is the whole security property — see `KintaiGatekeeper`.
   */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<KintaiSession>>> {
    return this.ctx.exports.KintaiGatekeeper({ props: this.ctx.props });
  }

  /** Returns no URL-addressed resources: attendance is ambient, not a thing with a URL. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup because Kintai is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Kintai has no URL-addressed resources.");
  }

  /** Rejects resource configuration because Kintai is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Kintai has no URL-addressed resources.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /**
   * Makes the capability stop resolving, WITHOUT destroying any attendance data.
   *
   * The store is one shared Durable Object holding every employee's records, and an employee's
   * punches, allocations and approvals are a payroll record the company is required to keep — so
   * revocation must not be a delete. Closing the account's open row in `account_links` is the
   * whole of it: an unlinked account is inert by construction, because every session method except
   * `whoAmI` resolves the employee first and throws `KINTAI_ACCOUNT_NOT_LINKED` when there is
   * none. The employee record and its history are untouched, and HR can link a fresh account to
   * the same employee later (`linkAccount` is the supported path, and is how an email change is
   * already handled).
   */
  async revoke(): Promise<void> {
    await this.#store().unlinkAccount(this.ctx.props.accountId, Date.now());
  }

  /** Rejects reconnect because Kintai holds no credentials to refresh. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Kintai has no connect flow.");
  }

  /** Returns no authentication identity: `providesAuth` is false. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier used by the low-stakes observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.KintaiVerifier({});
  }

  /** The one shared store, named "" — the same instance every facet reaches. */
  #store(): DurableObjectStub<KintaiStore> {
    return this.ctx.exports.KintaiStore.getByName("");
  }
}

/**
 * The observer policy for Kintai, which is deliberately trivial.
 *
 * Sharing a Gadget bound to a Kintai session does not widen what that session can see: it stays
 * scoped to the one employee the capability names, and the org chart already decides who may see
 * an approval queue. There is therefore nothing for a verifier to check, exactly as with
 * `ScheduleVerifier`.
 */
@validateRpc()
export class KintaiVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

/**
 * The only surface Gadget code reaches: one employee's own attendance record.
 *
 * A Gadget's own Durable Object cannot identify its caller, which is why this Gatekeeper exists at
 * all. Identity arrives out of band as an opaque `accountId` in `ctx.props`, bound to the class by
 * `KintaiAccount.getSingletonGatekeeperClass` and handed to this session by
 * `KintaiGatekeeper.startSession`. Every method below resolves the employee from that capability,
 * and NO method accepts an employee identifier as an argument — an employee can freely rewrite
 * their own Gadget's code, so the absence of such a parameter is the boundary, not any check a
 * caller could route around. For the same reason `now` is always `Date.now()` here and never a
 * parameter: a caller-supplied clock would let a Gadget punch into a closed period or backdate a
 * submission past an exemption window.
 *
 * The dependencies are `#`-private, deliberately. `#store` is an UNAUTHENTICATED handle on the
 * whole company's ledger — it takes an `employeeId` on nearly every method — so if it were a public
 * field it would itself become part of the RPC surface and hand a Gadget the very parameter this
 * class exists to withhold.
 */
@validateRpc()
export class KintaiSession extends RpcTarget {
  readonly #accountId: string;
  readonly #store: DurableObjectStub<KintaiStore>;
  readonly #approvalQueue: NativeRpcStub<ApprovalQueue>;

  constructor(dependencies: {
    accountId: string;
    store: DurableObjectStub<KintaiStore>;
    approvalQueue: NativeRpcStub<ApprovalQueue>;
  }) {
    super();
    this.#accountId = dependencies.accountId;
    this.#store = dependencies.store;
    this.#approvalQueue = dependencies.approvalQueue;
  }

  /** Releases the approval queue this session owns (it holds a `dup()`, not the caller's stub). */
  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }

  /**
   * Identity comes from the capability, never from an argument. Every method below starts here,
   * so a Gadget cannot name an employee it is not.
   */
  async #requireEmployee(now: number): Promise<EmployeeId> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, now);
    if (employeeId === null) throw new UnlinkedAccountError();
    return employeeId;
  }

  /**
   * Every read passes through here before returning, as `Gatekeeper.startSession` requires.
   *
   * Called AFTER the data is fetched and BEFORE it is returned, matching `ScheduleSessionImpl` and
   * `LibraryReadSession`: the description can then report what was actually read, and a refusal
   * still blocks the caller from seeing any of it.
   */
  async #authorize(title: string, description: string): Promise<void> {
    await this.#approvalQueue.authorizeObservation({ title, description });
  }

  /**
   * Non-throwing: an account with no employee record yet is an ordinary, expected state (a new
   * hire before HR links them), and the UI has to be able to explain it rather than show an error.
   * Every other method on this class throws `UnlinkedAccountError` instead.
   */
  async whoAmI(): Promise<{ linked: boolean; employeeId: EmployeeId | null }> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, Date.now());
    await this.#authorize(
      "Kintai identity",
      "Read which employee record this Kintai account is linked to.",
    );
    return { linked: employeeId !== null, employeeId };
  }

  async punch(
    kind: PunchKind, location?: PunchLocation,
  ): Promise<{ punchId: number; employeeId: EmployeeId; workDate: string }> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const workDate = jstWorkDate(now);
    // Period locks are enforced here, not inside the store's write functions: the amendment path
    // has to be able to write into a closed period, and it reaches the store directly.
    await this.#store.assertWritable(workDate);

    const punchId = await this.#store.recordPunch({
      employeeId, workDate, kind, now, source: "gadget", location,
    });
    return { punchId, employeeId, workDate };
  }

  async getDay(workDate: string): Promise<{
    punches: PunchRow[];
    allocations: AllocationRow[];
    reconciliation: Reconciliation;
    anomalies: string[];
    locked: boolean;
  }> {
    assertWorkDate("workDate", workDate);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const day = {
      punches: await this.#store.currentPunches(employeeId, workDate),
      allocations: await this.#store.currentAllocations(employeeId, workDate),
      reconciliation: await this.#store.reconcile(employeeId, workDate),
      // Surfaced alongside the day rather than left for the caller to derive: a forgotten clock-out
      // contributes nothing to `workedMinutes`, so without this the day silently looks short.
      anomalies: await this.#store.dayAnomalies(employeeId, workDate),
      locked: await this.#store.isLocked(workDate),
    };
    await this.#authorize(
      `Kintai day record for ${workDate}`,
      `Read your own attendance for ${workDate}: ${day.punches.length} punch(es), ` +
      `${day.allocations.length} allocation(s), and the worked/allocated reconciliation.`,
    );
    return day;
  }

  async setAllocations(workDate: string, entries: AllocationEntry[]): Promise<Reconciliation> {
    assertWorkDate("workDate", workDate);
    for (const entry of entries) assertMinutes(`allocation for ${entry.projectCode}`, entry.minutes);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    await this.#store.assertWritable(workDate);
    return this.#store.setAllocations(employeeId, workDate, entries);
  }

  async submitOvertime(requestedFor: string, minutes: number, reason: string): Promise<number> {
    assertWorkDate("requestedFor", requestedFor);
    assertMinutes("minutes", minutes);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const profile = await this.#store.employeeProfile(employeeId);
    // Deliberately NO `assertWritable`, the only write path here without one. A period lock closes
    // the *record* — punches and allocations — and `periods.ts` frames the amendment path as the
    // way to change a closed period. A submission IS that channel: it is a request for approval,
    // not an edit to the ledger, and refusing it would leave an employee who missed the cutoff with
    // no way to raise the overtime at all. `submitOvertime` already pins its own checks (exemption,
    // approver reachability) to `requestedFor` rather than to now, for the same reason.
    return this.#store.submitOvertime({
      employeeId, requestedFor, minutes, reason, now,
      department: profile.department, employmentType: profile.employment_type,
      // `submissions.created_by` is null when omitted, deliberately: defaulting it to employeeId
      // inside the store would manufacture a record asserting the employee filed it themselves,
      // even when an importer or an admin did. On THIS path they did, and the capability proves
      // it — so the self-service route is exactly where the claim can honestly be recorded.
      createdBy: employeeId,
    });
  }

  async withdrawSubmission(submissionId: number): Promise<void> {
    const actorId = await this.#requireEmployee(Date.now());
    return this.#store.withdrawSubmission(submissionId, actorId);
  }

  /** Move a returned submission back into the queue. The only path out of `draft`. */
  async resubmit(submissionId: number): Promise<void> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    return this.#store.resubmit(submissionId, actorId, now);
  }

  /** Own submissions only — the employee id comes from the capability, not the caller. */
  async listMySubmissions(): Promise<SubmissionRow[]> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const submissions = await this.#store.listSubmissionsFor(employeeId);
    await this.#authorize(
      "Kintai submissions",
      `Read your own ${submissions.length} overtime submission(s).`,
    );
    return submissions;
  }

  /** Derived from the org graph. Never accepts an employee id from the caller. */
  async listPendingApprovals(): Promise<SubmissionRow[]> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const pending = await this.#store.pendingApprovalsFor(employeeId, now);
    // The one read that can surface another employee's data, so it says so: the org chart, not the
    // caller, decided which submissions these are.
    await this.#authorize(
      "Kintai approval queue",
      `Read the ${pending.length} overtime submission(s) awaiting your decision as an approver. ` +
      "These belong to employees you have approval authority over in the organisation chart.",
    );
    return pending;
  }

  async actOnSubmission(
    submissionId: number, action: ApprovalAction, comment?: string,
  ): Promise<SubmissionState> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    return this.#store.actOnSubmission({ submissionId, actorId, action, now, comment });
  }
}

/**
 * The account's ambient Gatekeeper, installed by the Overseer as a facet under itself.
 *
 * It holds no state of its own: everything lives in the one shared `KintaiStore`, and this class
 * exists to carry the account capability (`ctx.props.accountId`) from
 * `KintaiAccount.getSingletonGatekeeperClass` into each session it opens. The props are bound to
 * the CLASS, so whoever instantiates the facet cannot choose the accountId.
 */
@validateRpc()
export class KintaiGatekeeper
  extends DurableObject<Cloudflare.Env, KintaiProps>
  implements Gatekeeper<KintaiSession>
{
  /** Describes the ambient Kintai attendance binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "kintai://attendance",
      title: "Kintai",
      snippet: "Record attendance, allocate hours, and route overtime for approval.",
      suggestedBindingName: "KINTAI",
      tsType: "KintaiSession",
    };
  }

  /** Returns the agent-facing KintaiSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Kintai submits no actions to the approval queue, so none can ever be auto-approved. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /**
   * Opens a session bound to this facet's own account capability.
   *
   * `this.ctx.props.accountId` is the only source of identity; nothing the caller passes reaches
   * it. The approval queue is `dup()`ed because the session outlives this call and uses it on
   * every read; the session disposes its copy.
   */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<KintaiSession> {
    const ownedQueue = approvalQueue.dup();
    try {
      return new KintaiSession({
        accountId: this.ctx.props.accountId,
        // The one shared store, named "" — every facet, for every employee, reaches this instance.
        store: this.ctx.exports.KintaiStore.getByName(""),
        approvalQueue: ownedQueue,
      });
    } catch (err) {
      ownedQueue[Symbol.dispose]?.();
      throw err;
    }
  }

  /**
   * Returns no catalog: there is nothing to enumerate ahead of time.
   *
   * A catalog indexes discoverable entries (documents, collections). Kintai's session is a fixed
   * set of operations over the caller's own record, fully described by `getTypeScriptTypes()`.
   * Implemented rather than omitted because the Overseer calls this unconditionally on every
   * ambient capsule; a missing method would log a caught failure on every chat.
   */
  async getAgentCatalog(
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  /**
   * Accepts collaborators under the low-stakes observer policy.
   *
   * Adding an observer does not widen the session: it still speaks for one employee, and the org
   * chart still decides whose approval queue that employee sees. See `KintaiVerifier`.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  // Kintai submits nothing to the approval queue, so the Overseer never calls these back. They
  // throw rather than silently succeeding: a call here means the protocol was violated somewhere,
  // and that should be loud.

  /** Rejects action application because Kintai submits no actions. */
  applyAction(_action: number): Promise<void> {
    throw new Error("Kintai submits no actions for approval.");
  }

  /** Rejects action rejection because Kintai submits no actions. */
  rejectAction(_action: number): Promise<void | { restart?: boolean }> {
    throw new Error("Kintai submits no actions for approval.");
  }

  /** Rejects action reversion because Kintai submits no actions. */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Kintai submits no actions for approval.");
  }
}

/** JST calendar date for a UTC instant. JST has no DST, so a fixed +9h offset is correct. */
export function jstWorkDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
