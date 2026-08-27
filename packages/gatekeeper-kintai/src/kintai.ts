import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionDescription,
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
import type { ApprovalAction, EmployeeId, PunchKind } from "./types.js";
import type { AllocationEntry, AllocationRow, Reconciliation } from "./store/allocations.js";
import type { PunchLocation, PunchRow } from "./store/punches.js";
import type { ActPreview, SubmissionRow } from "./store/submissions.js";
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

/**
 * Size limits on everything a caller can write into the store.
 *
 * The store is ONE Durable Object holding every employee's payroll record, and the code calling
 * this facet is a Gadget the employee can rewrite at will. Nothing downstream bounds these: the
 * schema's CHECK constraints cover value ranges, never lengths, so an unbounded string or array is
 * a way for any one employee to consume storage every other employee depends on. A single call
 * capped here is worth roughly 100 KB rather than however much the caller felt like sending.
 *
 * The numbers are chosen to sit far above any honest use and far below anything that hurts:
 *
 *  - 200 allocation entries — a day split across 200 distinct projects is already implausible.
 *  - 64 characters of project code — an accounting code, not prose.
 *  - 500 characters of note, per entry — a line of explanation for one project line.
 *  - 2,000 characters of overtime reason — a paragraph or two, which is what an approver reads.
 *  - 2,000 characters of approval comment — the same, from the other side.
 *
 * These are facet-level input validation, alongside `assertWorkDate`/`assertMinutes`, because this
 * is the untrusted boundary. They are NOT a rate limit: nothing here stops a caller making the
 * same bounded call a million times, which stays an open item for the store layer.
 */
const LIMITS = {
  allocationEntries: 200,
  projectCode: 64,
  note: 500,
  reason: 2_000,
  comment: 2_000,
} as const;

/** A caller-supplied string that lands in the shared store: must be a string, and bounded. */
function assertText(label: string, value: string, maxLength: number): void {
  if (typeof value !== "string") {
    throw new InvalidInputError(`${label} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new InvalidInputError(
      `${label} must be at most ${maxLength} characters (received ${value.length}).`,
    );
  }
}

type KintaiProps = { accountId: string };

/**
 * One approval decision, recorded in the gatekeeper's own storage and waiting for a human.
 *
 * Every field is server-derived. `actorId` in particular came from `resolveAccount` on the
 * session's own capability and was never a parameter — see `KintaiSession`.
 */
export type StagedApproval = {
  submissionId: number;
  actorId: EmployeeId;
  action: ApprovalAction;
  comment?: string;
};

/**
 * The narrow staging capability handed to a session: record one decision, return its id.
 *
 * Deliberately a pair of plain functions rather than the gatekeeper itself. `KintaiSession` is an
 * `RpcTarget` with no storage of its own, and handing it the facet would hand it `applyAction` too
 * — the ability to perform the very write the queue exists to gate.
 */
export type StageApproval = (staged: StagedApproval) => number;
export type DiscardApproval = (stagedId: number) => void;

/** The opaque observer ids currently recorded on the facet. See `KintaiGatekeeper.addObserver`. */
export type ListObservers = () => string[];

/** How many decisions may sit unconfirmed in one facet's storage at once. */
const MAX_PENDING_STAGED_ACTIONS = 50;

/** How many settled rows to keep before the oldest are pruned. */
const MAX_RETAINED_STAGED_ACTIONS = 100;

export class UnknownActionError extends Error {
  readonly code = "KINTAI_UNKNOWN_ACTION";
  constructor(id: number) {
    super(`KINTAI_UNKNOWN_ACTION: this Kintai gatekeeper has no staged action ${id}.`);
  }
}

export class ActionInFlightError extends Error {
  readonly code = "KINTAI_ACTION_IN_FLIGHT";
  constructor(id: number) {
    super(`KINTAI_ACTION_IN_FLIGHT: Kintai action ${id} is already being applied.`);
  }
}

export class ActionAlreadyAppliedError extends Error {
  readonly code = "KINTAI_ALREADY_APPLIED";
  constructor(id: number) {
    super(
      `KINTAI_ALREADY_APPLIED: Kintai action ${id} has already been applied and can no longer be ` +
      "rejected. An applied decision is part of the approval history; changing it means recording " +
      "a new decision.",
    );
  }
}

/**
 * Refused when the capability that staged a decision no longer names the employee it was staged
 * for — the account was re-pointed at somebody else, which HR does on an email change.
 *
 * This is the identity boundary held across time: a staged row is not a licence to act as whoever
 * it names. The facet re-derives the employee from its OWN `ctx.props.accountId` at apply time and
 * refuses unless the two agree, so even a corrupted staging table cannot make this facet act as an
 * employee it does not currently speak for.
 */
export class StaleActorError extends Error {
  readonly code = "KINTAI_STALE_ACTOR";
  constructor() {
    super(
      "KINTAI_STALE_ACTOR: this account no longer speaks for the employee who staged this " +
      "decision, so it will not be applied on their behalf.",
    );
  }
}

/**
 * Refused when one facet already holds `MAX_PENDING_STAGED_ACTIONS` unconfirmed decisions.
 *
 * The same reasoning as `LIMITS`: the code calling the session is a Gadget the account holder can
 * rewrite, so "how many times may it call this?" has to have an answer somewhere.
 */
export class TooManyPendingActionsError extends Error {
  readonly code = "KINTAI_TOO_MANY_PENDING_ACTIONS";
  constructor(limit: number) {
    super(
      `KINTAI_TOO_MANY_PENDING_ACTIONS: ${limit} approval decisions from this account are already ` +
      "awaiting confirmation. Wait for them to be confirmed or discarded before staging more.",
    );
  }
}

export class RevertUnsupportedError extends Error {
  readonly code = "KINTAI_REVERT_UNSUPPORTED";
  constructor() {
    super(
      "KINTAI_REVERT_UNSUPPORTED: an approval decision cannot be reverted automatically. It " +
      "changed a submission's state and appended a permanent row to its approval history; " +
      "undoing it means recording a new, compensating decision, which is a payroll judgement " +
      "rather than a mechanical undo.",
    );
  }
}

/**
 * Reported when a decision was interrupted after it had been sent to the store.
 *
 * Terminal, and deliberately not retryable: applying twice is NOT harmless. On a multi-step route
 * a replayed approval would be counted at the step the first one advanced the submission to.
 */
const APPLY_OUTCOME_UNKNOWN =
  "KINTAI_APPLY_OUTCOME_UNKNOWN: this decision was interrupted after it had been sent to the " +
  "attendance record, so it may or may not have been recorded. Check the submission's approval " +
  "history before deciding again.";

/**
 * Did the store refuse this decision outright, or might it have recorded it and been cut off?
 *
 * Every refusal `actOnSubmission` can raise comes from its authority prologue, before any write,
 * and leads with its own code. Anything else reaching the caller is a transport or runtime failure
 * that may have been cut off mid-write, and must not be replayed.
 *
 * Matching on the MESSAGE, not on `err.code`, is deliberate and not a shortcut: `code` is a plain
 * own property on these error classes and does not survive the RPC boundary — this package
 * established that early enough that every error here repeats its code in the message text for
 * exactly this reason (see `UnlinkedAccountError`'s own comment). The message is the only place a
 * caller can read the code from.
 *
 * The safety of this rests on a second property, which holds today and must keep holding: NOTHING
 * in `actOnSubmission` after the `INSERT INTO approval_events` throws at all. Every `KINTAI_`-coded
 * error it can raise comes from the prologue, before any write. If a future change adds a
 * `KINTAI_`-prefixed throw AFTER the insert, this function would classify a write that DID land as
 * a clean refusal, return the row to `pending`, and invite a retry that double-applies it — the
 * dangerous direction, and the one the claim machinery exists to prevent.
 *
 * KNOWN FRAGILITY, so the next person meets it here rather than in production: the match is
 * anchored at the start of the message. If anything in the RPC path ever starts prefixing error
 * messages — a wrapper, a new capnweb version, an added "Error calling X:" — then every domain
 * refusal stops being recognised as one. That fails in the SAFE direction (a refused decision
 * would be marked terminally `failed` with "outcome unknown" instead of being left retryable), but
 * it would quietly make every refusal a dead end. A structured signal would be better if one ever
 * becomes available; until then, the anchoring is load-bearing and is pinned by the tests that
 * assert a refused apply stays retryable.
 */
function isDomainRefusal(err: unknown): boolean {
  return err instanceof Error && /^KINTAI_[A-Z_]+:/.test(err.message);
}

/** Minutes as a human reads them: `45m`, `2h`, `1h 30m`. */
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Free text written by the employee being judged, or by the approver, quoted into the description.
 *
 * Blockquoted line by line rather than interpolated raw. The description is Markdown rendered to a
 * human who is about to authorise a payment, and this is the one part of it that the party with an
 * interest in the outcome controls: a "reason" containing its own headings, list items or bold
 * text would otherwise render as though it were part of the surrounding, gatekeeper-authored
 * explanation of what is about to happen.
 */
function quoted(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "> _(none given)_";
  return trimmed.split("\n").map((line) => `> ${line}`).join("\n");
}

const DECISIONS = {
  approve: {
    verb: "Approve",
    effect:
      "Approving advances the submission to its next approval step, or — if this is the last " +
      "step — marks it approved, at which point it counts as payable overtime.",
  },
  reject: {
    verb: "Reject",
    effect:
      "Rejecting closes the submission for good. The employee cannot resubmit it; they would have " +
      "to file a fresh request.",
  },
  return: {
    verb: "Return",
    effect:
      "Returning sends the submission back to the employee as a draft so they can change it, and " +
      "voids every approval collected so far — including any from other approvers.",
  },
} as const satisfies Record<ApprovalAction, { verb: string; effect: string }>;

/**
 * What the approver actually reads before confirming.
 *
 * It has to say who is deciding, for whom, how many hours, on which date, and what the decision
 * is. "Approve action #7" is worse than no confirmation at all, because it trains people to click
 * through — and the thing being confirmed here is a manager's sign-off on somebody else's pay.
 *
 * KNOWN AND ACCEPTED LIMIT: this description carries another employee's name, number, hours and
 * stated reason, and the Overseer persists it verbatim in an `ActionRecord` audit log. That is the
 * intended design of the action log, but note the asymmetry — `ObservationDescription` can name
 * `excludeObservers` and `ActionDescription` has no equivalent, so the protection
 * `listPendingApprovals` applies to exactly this data does not extend to the action log. Keeping
 * the description informative is the deliberate choice: a confirmation the approver cannot
 * evaluate defeats the entire purpose of routing this through a human. Recorded here so it is a
 * decision rather than an oversight.
 */
function describeApproval(
  preview: ActPreview, action: ApprovalAction, comment?: string,
): ActionDescription {
  const decision = DECISIONS[action];
  const duration = `${preview.minutes} minutes (${formatDuration(preview.minutes)})`;
  const step = preview.stepCount > 1
    ? `\n- **Approval step:** ${preview.stepNumber} of ${preview.stepCount}`
    : "";
  return {
    title:
      `${decision.verb} ${preview.employeeName}'s ${formatDuration(preview.minutes)} of ` +
      `overtime on ${preview.requestedFor}`,
    description:
      `**${preview.actorName}** is recording an approval decision on **${preview.employeeName}**'s ` +
      "overtime request. This is the manager's sign-off itself, not a draft.\n" +
      "\n" +
      `- **Decision:** ${action}\n` +
      `- **Employee:** ${preview.employeeName} (${preview.employeeNumber})\n` +
      `- **Date worked:** ${preview.requestedFor}\n` +
      `- **Overtime claimed:** ${duration}${step}\n` +
      "\n" +
      "**The employee's stated reason**\n" +
      "\n" +
      `${quoted(preview.reason)}\n` +
      "\n" +
      `**${preview.actorName}'s comment**\n` +
      "\n" +
      `${quoted(comment ?? "")}\n` +
      "\n" +
      `${decision.effect}\n` +
      "\n" +
      "Authority is re-checked against the organisation chart at the moment this is applied, so a " +
      "decision that is no longer yours to make will be refused rather than performed. It cannot " +
      "be undone automatically: an applied decision appends a permanent entry to the submission's " +
      "approval history, and reversing it means recording a new, compensating decision.",
    // See `RevertUnsupportedError`.
    implementsRevert: false,
    // Kintai does not simulate. Until this is applied, every read still shows a world in which the
    // decision did not happen, and an agent that kept working would retry or undo itself.
    awaitDecision: true,
    // Tagged so a policy engine can see what this is, but NEVER pre-approvable: the tag appears in
    // no entry of `getAutoApprovableActions()`, and `autoApprovable` is left unset, which is
    // independently sufficient ("Absent -> never auto-approvable").
    actionKind: { tag: "kintai.actOnSubmission", label: "Decide an overtime submission" },
  };
}

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
 *
 * That is why `listPendingApprovals` excludes every observer rather than the ones who should not
 * see a particular submission: this interface has no members, so an observer id cannot be resolved
 * to an employee and "may this collaborator see Tanaka's overtime?" is a question nothing here can
 * answer. Excluding all of them is the only sound reading of a verifier that verifies nothing.
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
  readonly #stageApproval: StageApproval;
  readonly #discardApproval: DiscardApproval;
  readonly #listObservers: ListObservers;

  constructor(dependencies: {
    accountId: string;
    store: DurableObjectStub<KintaiStore>;
    approvalQueue: NativeRpcStub<ApprovalQueue>;
    /**
     * Records one decision in the OWNING FACET's storage and returns its id. A narrow capability,
     * not the facet: see `StageApproval`. It is a plain closure, so calling it crosses no RPC
     * boundary — this object lives in the facet's own isolate and only a stub to it travels.
     */
    stageApproval: StageApproval;
    /** Drops a staged row that was never submitted. See `actOnSubmission`. */
    discardApproval: DiscardApproval;
    /**
     * The collaborators currently recorded on the owning facet, read fresh on every use, because
     * one can be added while a Gadget is still running.
     */
    listObservers: ListObservers;
  }) {
    super();
    this.#accountId = dependencies.accountId;
    this.#store = dependencies.store;
    this.#approvalQueue = dependencies.approvalQueue;
    this.#stageApproval = dependencies.stageApproval;
    this.#discardApproval = dependencies.discardApproval;
    this.#listObservers = dependencies.listObservers;
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
   *
   * `excludeObservers` names collaborators who must not see this observation. It is passed only
   * when there is at least one, never as an empty array, so the description an unshared read sends
   * is byte-identical to what it always sent.
   */
  async #authorize(
    title: string, description: string, excludeObservers?: string[],
  ): Promise<void> {
    await this.#approvalQueue.authorizeObservation(
      excludeObservers && excludeObservers.length > 0
        ? { title, description, excludeObservers }
        : { title, description },
    );
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
    if (!Array.isArray(entries)) {
      throw new InvalidInputError("entries must be an array of allocation lines.");
    }
    if (entries.length > LIMITS.allocationEntries) {
      throw new InvalidInputError(
        `entries must contain at most ${LIMITS.allocationEntries} allocation lines ` +
        `(received ${entries.length}).`,
      );
    }
    // Validated in full BEFORE anything is written: `setAllocations` supersedes the whole day, so
    // a rejection partway through would already have replaced the day's allocations.
    for (const entry of entries) {
      assertText("projectCode", entry?.projectCode, LIMITS.projectCode);
      assertMinutes(`allocation for ${entry.projectCode}`, entry.minutes);
      if (entry.note !== undefined) {
        assertText(`note for ${entry.projectCode}`, entry.note, LIMITS.note);
      }
    }
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    await this.#store.assertWritable(workDate);
    return this.#store.setAllocations(employeeId, workDate, entries);
  }

  async submitOvertime(requestedFor: string, minutes: number, reason: string): Promise<number> {
    assertWorkDate("requestedFor", requestedFor);
    assertMinutes("minutes", minutes);
    assertText("reason", reason, LIMITS.reason);
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

  /**
   * Derived from the org graph. Never accepts an employee id from the caller.
   *
   * The ONE read in this session that returns other people's records — minutes, stated reason,
   * dates and employee ids for everyone the caller approves for — so it is the one observation
   * that names `excludeObservers`. Everything else here is the caller's own data, and a Gadget the
   * caller shares with a colleague showing the caller's own attendance is a choice they are
   * entitled to make; a Gadget showing their reports' payroll data to a collaborator is not, and
   * `addObserver` accepts every collaborator under the low-stakes observer policy, so nothing else
   * in this package would stop it.
   *
   * This call THROWS if a current collaborator could see the result: the Overseer cannot promise
   * to hide it from them, so it refuses the observation and no data is returned. A Gadget that
   * wants to stay shareable must not call `listPendingApprovals()`; `punch()`, `getDay()` and
   * `listMySubmissions()` stay freely shareable. Failing closed on the approval queue is the right
   * side to err on for payroll data belonging to somebody else.
   *
   * WHY `excludeObservers` AND NOT `prohibitAllSharing`. Both block this read on a shared Gadget,
   * but `prohibitAllSharing` also puts the whole workspace into permanent lockdown, and lockdown
   * refuses EVERY action — including `actOnSubmission`, which is now an action. That combination
   * made the only approver flow there is impossible: this method is the sole way a Gadget can
   * learn a submission id it may act on, so reading the queue permanently disabled deciding on
   * anything in it. `excludeObservers` is the targeted tool for exactly this case — the
   * interface's own TODO on `prohibitAllSharing` calls it a stopgap and names sharing sensitive
   * data with recipients who already have access as the intended direction, and a manager
   * approving their subordinate's overtime is precisely such a recipient.
   *
   * Every recorded observer is excluded, not a computed subset: `GatekeeperUserVerifier` exposes
   * only `verify()`, so there is no path from an opaque observer id to an employee record and no
   * way to ask whether a particular collaborator is entitled to this data. Excluding all of them
   * is the safe reading, and it preserves the original intent exactly — nobody but the account
   * owner sees another employee's payroll record.
   *
   * TWO ACCEPTED RESIDUAL RISKS, recorded rather than hidden. Both follow from dropping a
   * workspace-wide, permanent flag for a per-observation one, and neither can be avoided while
   * keeping the approver flow, because approving IS an action and `prohibitAllSharing` has no
   * per-gatekeeper form.
   *
   *  1. Exfiltration through another gatekeeper. Lockdown used to stop the Gadget performing ANY
   *     action after this read, which blocked forwarding the data by email or Slack. Mitigated
   *     only by those actions themselves being queued for the same human, with a description
   *     saying what is being sent.
   *
   *  2. Sharing AFTER the read. `prohibitAllSharing` was permanent and also blocked all future
   *     sharing — `addCollaborator`, `createShareLink`, `newShareLinkKey` and non-owner `open` all
   *     throw once it is set — so data read on an unshared Gadget could never reach anyone. This
   *     flag is evaluated per observation, against the observers recorded AT THAT INSTANT. Read
   *     the queue while unshared and nothing is named; share the Gadget afterwards and the new
   *     collaborator sees whatever it already rendered from that read. Later calls do start
   *     failing, but what is already on the page is not retracted, and `addObserver` accepts
   *     everyone (see `KintaiVerifier`).
   */
  async listPendingApprovals(): Promise<SubmissionRow[]> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const pending = await this.#store.pendingApprovalsFor(employeeId, now);
    // The one read that can surface another employee's data, so it says so: the org chart, not the
    // caller, decided which submissions these are. The observer list is read at call time and not
    // captured when the session opened, because a collaborator can be added mid-run.
    await this.#authorize(
      "Kintai approval queue",
      `Read the ${pending.length} overtime submission(s) awaiting your decision as an approver. ` +
      "These belong to employees you have approval authority over in the organisation chart.",
      this.#listObservers(),
    );
    return pending;
  }

  /**
   * Approve, reject or return one submission — by SUBMITTING the decision for approval, not by
   * performing it.
   *
   * This is a manager's sign-off on somebody else's pay, the most side-effecting thing this
   * package does, and `Gatekeeper.startSession` requires that "side-effecting actions must not
   * actually be performed until they are approved". So the decision is staged in the gatekeeper's
   * own storage and submitted to the Overseer's `ApprovalQueue`; the write happens later, in
   * `KintaiGatekeeper.applyAction`. The system is heading toward natural-language operation where
   * a possibly prompt-injected agent would otherwise exercise approval authority unattended, and
   * this is the control that stops that.
   *
   * Three things are settled here, before anything is staged:
   *
   *  - the actor, from the capability. As everywhere else in this class, never from an argument.
   *  - the decision itself: `@validateRpc()` refuses anything but the three literals of
   *    `ApprovalAction` before this body runs, which matters more now than it did — an unchecked
   *    value used to die on `approval_events`' CHECK within the same call, but a staged one would
   *    be shown to a human as a decision and confirmed by them before failing.
   *  - authority, via `previewActOnSubmission` — which runs the SAME check the write runs, not a
   *    copy of it. Without a stage-time check a manager would be asked to confirm a decision that
   *    then failed on apply; with a separately-written one, this package would have a fifth
   *    implementation of "who may approve", which is exactly how its last real bug happened.
   *
   * The refusals a caller can observe are therefore unchanged by queueing: a stranger still gets a
   * uniform `KINTAI_NOT_AUTHORIZED` in every live state, an authorized approver acting on a
   * terminal submission still gets `KINTAI_INVALID_TRANSITION`, and self-approval is still refused
   * first with `KINTAI_SELF_APPROVAL`.
   *
   * Still returns nothing, as it always did. A queued action is applied later, by a different
   * call, and cannot return the resulting state to this caller: read the outcome back from
   * `listMySubmissions()` (as the employee) or `listPendingApprovals()` (as the approver).
   */
  async actOnSubmission(
    submissionId: number, action: ApprovalAction, comment?: string,
  ): Promise<void> {
    if (comment !== undefined) assertText("comment", comment, LIMITS.comment);
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);

    const preview = await this.#store.previewActOnSubmission({ submissionId, actorId, now });

    const stagedId = this.#stageApproval({ submissionId, actorId, action, comment });
    try {
      await this.#approvalQueue.submitAction(stagedId, describeApproval(preview, action, comment));
    } catch (err) {
      // No approver will ever see this action, so nothing can ever apply it. Drop the row rather
      // than leaving an unreachable decision sitting in the facet's storage against the cap.
      this.#discardApproval(stagedId);
      throw err;
    }
  }
}

/** One decision waiting for a human, as it sits in the facet's own SQLite. */
type StagedRow = {
  id: number;
  submission_id: number;
  actor_employee_id: number;
  action: ApprovalAction;
  comment: string | null;
  staged_at: number;
  state: "pending" | "applying" | "applied" | "failed";
  error: string | null;
};

/**
 * The account's ambient Gatekeeper, installed by the Overseer as a facet under itself.
 *
 * The attendance record itself lives in the one shared `KintaiStore`; this class carries the
 * account capability (`ctx.props.accountId`) from `KintaiAccount.getSingletonGatekeeperClass` into
 * each session it opens. The props are bound to the CLASS, so whoever instantiates the facet
 * cannot choose the accountId.
 *
 * It holds exactly one piece of state of its own: approval decisions that have been submitted for
 * confirmation but not yet applied. They live HERE, in the facet's own storage, and not in the
 * shared store, because the facet is per account — so a decision staged by one account's facet is
 * physically unreachable from another's. That is isolation by construction; staged rows in the
 * company-wide store would instead need an ownership check on every path, which is the kind of
 * check somebody eventually forgets. The Overseer routes an approval back to the facet that
 * submitted it (it resolves the facet by a stable name from the gatekeeper record id, then calls
 * `applyAction`), and Durable Object storage outlives any one session, so the row is still here
 * when the human gets round to deciding — hours or days later, as the interface expects.
 */
@validateRpc()
export class KintaiGatekeeper
  extends DurableObject<Cloudflare.Env, KintaiProps>
  implements Gatekeeper<KintaiSession>
{
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS staged_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      actor_employee_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return')),
      comment TEXT,
      staged_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed')),
      error TEXT
    ) STRICT`);
    // The collaborators the Overseer has told this facet about. Recorded, not merely accepted,
    // because `listPendingApprovals` has to name them: it returns other employees' payroll records
    // and the Overseer needs to know who must not see them. Opaque ids chosen by the Overseer —
    // never interpreted here, and never used for authorization.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS observers (
      id TEXT PRIMARY KEY
    ) STRICT`);
    // A fresh instance means a fresh activation, so a row still marked `applying` belonged to an
    // interrupted one: the decision had already been sent to the store and may or may not have
    // landed. It must never be replayed — applying twice is not harmless, because on a multi-step
    // route the replay would be counted at the step the first apply advanced the submission to.
    this.#sql.exec(
      `UPDATE staged_approvals SET state = 'failed', error = ? WHERE state = 'applying'`,
      APPLY_OUTCOME_UNKNOWN,
    );
  }

  /** The one shared store, named "" — the same instance every facet reaches. */
  #store(): DurableObjectStub<KintaiStore> {
    return this.ctx.exports.KintaiStore.getByName("");
  }

  #staged(id: number): StagedRow | undefined {
    return this.#sql
      .exec<StagedRow>(`SELECT * FROM staged_approvals WHERE id = ?`, id)
      .toArray()[0];
  }

  #setState(id: number, state: StagedRow["state"], error?: string): void {
    this.#sql.exec(
      `UPDATE staged_approvals SET state = ?, error = ? WHERE id = ?`, state, error ?? null, id,
    );
  }

  /**
   * Record one decision. The narrow capability behind `StageApproval` — the session gets this and
   * `#discard`, and nothing else that touches this table.
   */
  #stage(staged: StagedApproval): number {
    // Bounded for the same reason as `LIMITS`: the code calling this is a Gadget the employee can
    // rewrite, and it can call in a loop. An unbounded staging table would let one account fill
    // its own facet's storage and the Overseer's approval queue with decisions nobody asked for.
    const { count } = this.#sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM staged_approvals WHERE state IN ('pending', 'applying')`,
      )
      .one();
    if (count >= MAX_PENDING_STAGED_ACTIONS) {
      throw new TooManyPendingActionsError(MAX_PENDING_STAGED_ACTIONS);
    }
    return this.#sql
      .exec<{ id: number }>(
        `INSERT INTO staged_approvals
           (submission_id, actor_employee_id, action, comment, staged_at, state)
         VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
        staged.submissionId, staged.actorId, staged.action, staged.comment ?? null, Date.now(),
      )
      .one().id;
  }

  #observers(): string[] {
    return this.#sql
      .exec<{ id: string }>(`SELECT id FROM observers ORDER BY id`)
      .toArray()
      .map((row) => row.id);
  }

  /** Drop a staged row. Only ever used on one that has not been applied. */
  #discard(id: number): void {
    this.#sql.exec(`DELETE FROM staged_approvals WHERE id = ? AND state != 'applied'`, id);
  }

  /** Keep the settled rows bounded; pending ones are bounded by `MAX_PENDING_STAGED_ACTIONS`. */
  #prune(): void {
    this.#sql.exec(
      `DELETE FROM staged_approvals WHERE id IN (
         SELECT id FROM staged_approvals
         WHERE state NOT IN ('pending', 'applying')
         ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
      MAX_RETAINED_STAGED_ACTIONS,
    );
  }

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

  /**
   * Empty, permanently. Kintai's one queued action is a manager's decision on somebody else's pay,
   * which must never be applied without a human looking at it.
   *
   * The action still carries an `actionKind` so a policy engine can recognise what it is, but a
   * kind listed here is a kind a user may pre-approve — and this one may not be. The per-action
   * `autoApprovable` verdict is left unset as well ("Absent -> never auto-approvable"), so both
   * gates are independently closed.
   */
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
        store: this.#store(),
        approvalQueue: ownedQueue,
        // A NARROW capability, never the facet itself: handing the session `this` would hand it
        // `applyAction`, which is precisely the write the approval queue exists to gate. These two
        // closures are the whole of what staging needs. They cross no RPC boundary — the session
        // object lives in this facet's isolate and only a stub to it travels — so each is a plain
        // local call into this Durable Object's own SQLite.
        stageApproval: (staged) => this.#stage(staged),
        discardApproval: (stagedId) => this.#discard(stagedId),
        listObservers: () => this.#observers(),
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
   * Accepts a collaborator under the low-stakes observer policy, and RECORDS them.
   *
   * Accepting is still trivial — adding an observer does not widen the session, which still speaks
   * for one employee, and the org chart still decides whose approval queue that employee sees (see
   * `KintaiVerifier`). What is no longer trivial is the bookkeeping: `listPendingApprovals` is the
   * one read that returns another employee's payroll record, and it protects it by naming every
   * observer in the observation's `excludeObservers`, which the Overseer then either enforces or
   * refuses the read over. That list can only be as complete as what is stored here, so these two
   * methods are load-bearing rather than the no-ops they used to be.
   */
  async addObserver(id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // Idempotent by contract: the Overseer may call again with the same id to re-run whatever
    // verification the gatekeeper does. Kintai's verification is trivial (see `KintaiVerifier`),
    // but the id must still be RECORDED, because `listPendingApprovals` excludes every recorded
    // observer and an unrecorded one would be excluded from nothing.
    this.#sql.exec(`INSERT INTO observers (id) VALUES (?) ON CONFLICT (id) DO NOTHING`, id);
  }

  /** Removes a collaborator, so later reads stop naming them. Idempotent, as the contract says. */
  async removeObserver(id: string): Promise<void> {
    this.#sql.exec(`DELETE FROM observers WHERE id = ?`, id);
  }

  // ---------------------------------------------------------------------------------------------
  // The Overseer's callbacks, once a human has decided about a staged approval.

  /**
   * The human confirmed the decision: perform it now.
   *
   * `store.actOnSubmission` re-runs every authority check, and that is the point rather than
   * redundancy. Time has passed — hours or days, by design — and the organisation may have changed
   * underneath the decision; a manager who has since lost authority over the employee must not
   * have their stale sign-off applied. The check is the same one the stage-time probe ran, because
   * both go through `checkMayAct`.
   *
   * Two identity properties hold here, both preserved from the unqueued version:
   *
   *  - `now` is `Date.now()`, server-side. It is not read from the staged row, so a decision does
   *    not carry its staging clock into a world that has moved on.
   *  - the actor is re-derived from THIS facet's own `ctx.props.accountId` and must still be the
   *    employee the row names. A staged row is not a licence to act as whoever it says: an account
   *    re-pointed at somebody else (`KINTAI_STALE_ACTOR`) or revoked
   *    (`KINTAI_ACCOUNT_NOT_LINKED`) cannot spend a decision staged by its previous holder.
   */
  async applyAction(action: number): Promise<void> {
    const row = this.#staged(action);
    if (!row) throw new UnknownActionError(action);
    // Idempotent: the Overseer may call back more than once, and a replay would be counted as a
    // second, independent approval at whatever step the first one advanced the submission to.
    if (row.state === "applied") return;
    if (row.state === "applying") throw new ActionInFlightError(action);
    if (row.state === "failed") throw new Error(row.error ?? APPLY_OUTCOME_UNKNOWN);

    // Claimed BEFORE THE FIRST AWAIT, not merely before the store call. A Durable Object's input
    // gate is OPEN across an await, so a claim taken after `resolveAccount` would let two
    // concurrent callers both read `pending`, both pass the guard above, and both apply — and on a
    // multi-step route the second is counted at the step the first advanced to, which is precisely
    // the harm this machinery exists to prevent. The guards above and this write run in one
    // synchronous run-to-completion block, so the second caller sees `applying` and is refused.
    //
    // Reachable from the real Overseer: `approveAction` checks state synchronously, awaits
    // `#getClientProfile()`, and only marks the record approved after `applyAction` returns, so two
    // clicks race. Its single-flight drainer guards the auto-approval path only, and Kintai's
    // action is never auto-approvable.
    //
    // It also means an activation that dies anywhere from here on leaves an `applying` row for the
    // constructor to sweep to a terminal `failed`. In the narrow window before the store call that
    // is pessimistic — nothing had been sent — but it errs toward "a human re-decides" rather than
    // toward replaying a write that may have landed.
    this.#setState(action, "applying");

    const now = Date.now();
    const store = this.#store();
    try {
      const employeeId = await store.resolveAccount(this.ctx.props.accountId, now);
      if (employeeId === null) throw new UnlinkedAccountError();
      if (employeeId !== row.actor_employee_id) throw new StaleActorError();
    } catch (err) {
      // Nothing has been sent to the store, so the decision is untouched and must stay retryable —
      // a revoked account can be re-linked, and the Overseer offers a retry.
      this.#setState(action, "pending");
      throw err;
    }

    try {
      await store.actOnSubmission({
        submissionId: row.submission_id,
        actorId: row.actor_employee_id,
        action: row.action,
        now,
        comment: row.comment ?? undefined,
      });
    } catch (err) {
      if (isDomainRefusal(err)) {
        // Refused by the authority prologue, before any write. Nothing landed, so the row goes
        // back to `pending`: the Overseer tells the user the action failed and offers a retry,
        // which must be able to succeed once whatever caused the refusal is resolved.
        this.#setState(action, "pending");
        throw err;
      }
      this.#setState(action, "failed", APPLY_OUTCOME_UNKNOWN);
      this.#prune();
      throw new Error(APPLY_OUTCOME_UNKNOWN, { cause: err });
    }
    this.#setState(action, "applied");
    this.#prune();
  }

  /**
   * The human refused the decision: discard it. Nothing was ever applied, so there is nothing to
   * undo — the submission is exactly as the employee left it.
   */
  async rejectAction(action: number): Promise<void | { restart?: boolean }> {
    const row = this.#staged(action);
    // Cleanup is idempotent by contract, and a discarded row is indistinguishable from one that
    // never existed.
    if (!row) return;
    if (row.state === "applying") throw new ActionInFlightError(action);
    if (row.state === "applied") throw new ActionAlreadyAppliedError(action);
    this.#discard(action);
  }

  /**
   * Refuses. `implementsRevert: false` on every description says so up front, so the UI should
   * never offer this — see `RevertUnsupportedError` for why un-approving is a payroll decision
   * rather than a mechanical undo.
   */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new RevertUnsupportedError();
  }
}

/** JST calendar date for a UTC instant. JST has no DST, so a fixed +9h offset is correct. */
export function jstWorkDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
