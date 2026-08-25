import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AccountDescription, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { ApprovalAction, EmployeeId, PunchKind, SubmissionState } from "./types.js";
import type { AllocationEntry, AllocationRow, Reconciliation } from "./store/allocations.js";
import type { PunchLocation, PunchRow } from "./store/punches.js";
import type { SubmissionRow } from "./store/submissions.js";
import { UnlinkedAccountError } from "./store/employees.js";

const KINTAI_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm40-88a8 8 0 0 1-8 8h-32a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v40h24a8 8 0 0 1 8 8Z'/></svg>",
    ),
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
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
}

type KintaiProps = { accountId: string };

/**
 * One employee's account capability: the out-of-band identity a Gadget's own Durable Object cannot
 * establish for itself.
 *
 * This implements the singleton slice of `GatekeeperUser` — `describe` and
 * `getSingletonGatekeeperClass` — and deliberately does NOT declare `implements GatekeeperUser`,
 * because it does not yet implement the rest of that protocol (`getSupportedResources`,
 * `getVerifier`, `revoke`, `reconnect`, `ensureResources`, `getAuthenticatedEmail`,
 * `getGatekeeperClassFor`, `startResourceConfigurator`). Nor does `GatekeeperVendor` implement
 * `createAccount()`, so nothing in the Workshop mints one of these yet. Wiring the account into
 * the Workshop needs both of those AND the `Gatekeeper<KintaiSession>` protocol on
 * `KintaiGatekeeper` (`describe`, `getTypeScriptTypes`, `startSession`, `getAgentCatalog`,
 * `addObserver`, the action methods) — a session layer no task in this plan specified. Claiming the
 * interfaces before implementing them would turn a missing feature into a runtime crash inside the
 * Workshop UI, so the claim is withheld until the session layer exists.
 */
@validateRpc()
export class KintaiAccount extends WorkerEntrypoint<Cloudflare.Env, KintaiProps> {
  /** Describes the auto-provisioned Kintai account and its ambient workspace singleton. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Kintai",
      avatar: KINTAI_ICON,
      singleton: { tsType: "KintaiSession" },
      providesUi: { title: "Kintai", icon: KINTAI_ICON },
    };
  }

  /**
   * The workspace facet class, imbued with this account's capability.
   *
   * Props are bound to the CLASS here, not to an instance name: `getByName` takes a name only. The
   * accountId therefore travels with the class reference and cannot be chosen by whoever later
   * instantiates it. That is the whole security property — see `KintaiGatekeeper`.
   */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<KintaiGatekeeper>> {
    return this.ctx.exports.KintaiGatekeeper({ props: this.ctx.props });
  }
}

/**
 * The only surface Gadget code reaches.
 *
 * A Gadget's own Durable Object cannot identify its caller, which is why this Gatekeeper exists at
 * all. Identity arrives out of band as an opaque `accountId` in `ctx.props`, bound to the class by
 * `KintaiAccount.getSingletonGatekeeperClass`. Every method below resolves the employee from that
 * capability, and NO method accepts an employee identifier as an argument — an employee can freely
 * rewrite their own Gadget's code, so the absence of such a parameter is the boundary, not any
 * check a caller could route around.
 */
@validateRpc()
export class KintaiGatekeeper extends DurableObject<Cloudflare.Env, KintaiProps> {
  /** The one shared store. Named "" so every facet reaches the same instance. */
  get #store() {
    return this.ctx.exports.KintaiStore.getByName("");
  }

  get #accountId(): string {
    return this.ctx.props.accountId;
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
   * Non-throwing: an account with no employee record yet is an ordinary, expected state (a new
   * hire before HR links them), and the UI has to be able to explain it rather than show an error.
   * Every other method on this class throws `UnlinkedAccountError` instead.
   */
  async whoAmI(): Promise<{ linked: boolean; employeeId: EmployeeId | null }> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, Date.now());
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
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return {
      punches: await this.#store.currentPunches(employeeId, workDate),
      allocations: await this.#store.currentAllocations(employeeId, workDate),
      reconciliation: await this.#store.reconcile(employeeId, workDate),
      // Surfaced alongside the day rather than left for the caller to derive: a forgotten clock-out
      // contributes nothing to `workedMinutes`, so without this the day silently looks short.
      anomalies: await this.#store.dayAnomalies(employeeId, workDate),
      locked: await this.#store.isLocked(workDate),
    };
  }

  async setAllocations(workDate: string, entries: AllocationEntry[]): Promise<Reconciliation> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    await this.#store.assertWritable(workDate);
    return this.#store.setAllocations(employeeId, workDate, entries);
  }

  async submitOvertime(requestedFor: string, minutes: number, reason: string): Promise<number> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const profile = await this.#store.employeeProfile(employeeId);
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
    return this.#store.listSubmissionsFor(employeeId);
  }

  /** Derived from the org graph. Never accepts an employee id from the caller. */
  async listPendingApprovals(): Promise<SubmissionRow[]> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#store.pendingApprovalsFor(employeeId, now);
  }

  async actOnSubmission(
    submissionId: number, action: ApprovalAction, comment?: string,
  ): Promise<SubmissionState> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    return this.#store.actOnSubmission({ submissionId, actorId, action, now, comment });
  }
}

/** JST calendar date for a UTC instant. JST has no DST, so a fixed +9h offset is correct. */
export function jstWorkDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
