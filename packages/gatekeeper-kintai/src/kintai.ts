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
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorContract,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  ApprovalAction, EmployeeId, EmployeeMonth, KintaiIdentity, PunchKind,
} from "./types.js";
import type { AllocationEntry, AllocationRow, Reconciliation } from "./store/allocations.js";
import type { PunchLocation, PunchRow } from "./store/punches.js";
import type { ActPreview, SubmissionRow } from "./store/submissions.js";
import type { KintaiStore } from "./store/kintai-store.js";
import { UnlinkedAccountError } from "./store/employees.js";
// The refusal for "you have no authority over this employee". Shared with the approval stack
// rather than restated: the two are the same answer to the same question about the org chart.
import { NotAuthorizedError } from "./store/submissions.js";
// The store decides a punch's work date under its own write gate and refuses when the answer
// moved between the facet reading it and the write landing; `punch()` reads that refusal back
// through this predicate, because the error class itself does not survive the RPC boundary.
import { isWorkDateRaced } from "./store/punches.js";
// The store's schema module owns this: it is the same PRAGMA test, run for the same reason, and a
// second copy of it is exactly the kind of duplication this package has been bitten by.
import { hasColumn } from "./store/schema.js";
import { AdminKintaiApi, identify } from "./admin-api.js";
import {
  assertEmployeeId, assertMinutes, assertPeriod, assertPunchKind, assertRequiredText, assertText,
  assertWorkDate, InvalidInputError, LIMITS,
} from "./input.js";
import { jstClockTime } from "./work-date.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

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

// Re-exported: this module was where input validation lived before `input.ts` split it out so
// the HR admin API could share it (see that file), and callers still read the error from here.
export { InvalidInputError };

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
  /**
   * The submission's approval history as it stood when authority was checked, from the same
   * `previewActOnSubmission` call. Carried onto the row and re-checked at apply time — see
   * `ActInput.expectedAfterEventId`.
   */
  afterEventId: number;
};

/**
 * What staging produced: the decision's id, and whether it was ALREADY there.
 *
 * `deduped` is not bookkeeping — it decides whether a queue entry is submitted. Two entries for
 * one decision means two human confirmations, and on a multi-step route those land as approvals at
 * two different steps.
 */
export type StageResult = { id: number; deduped: boolean };

/**
 * The narrow staging capability handed to a session: record one decision, return its id.
 *
 * Deliberately a pair of plain functions rather than the gatekeeper itself. `KintaiSession` is an
 * `RpcTarget` with no storage of its own, and handing it the facet would hand it `applyAction` too
 * — the ability to perform the very write the queue exists to gate.
 */
export type StageApproval = (staged: StagedApproval) => StageResult;
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
 * Refused when this actor already has a DIFFERENT decision on the same submission awaiting
 * confirmation.
 *
 * The alternative would be to replace the pending one, and that is worse: the approver may be
 * looking at it in the Workshop right now, and the Gadget that issued both is code the account
 * holder can rewrite. An identical re-issue is not this — that is a retry, and it is answered with
 * the id already staged.
 *
 * It names the pending decision because the caller has to be able to act on the message, and it
 * discloses nothing new: only somebody who has just passed `checkMayAct` for this submission can
 * reach it.
 */
export class ConflictingDecisionError extends Error {
  readonly code = "KINTAI_DECISION_CONFLICT";
  constructor(pending: { id: number; action: ApprovalAction }, submissionId: number) {
    super(
      `KINTAI_DECISION_CONFLICT: a '${pending.action}' decision on submission ${submissionId} is ` +
      `already awaiting confirmation as action ${pending.id}. Confirm or discard it before ` +
      "deciding differently on the same submission.",
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
 * The safety of this rests on a second property, which holds today and must keep holding: no
 * `KINTAI_`-CODED error is raised after the `INSERT INTO approval_events`. Every coded error on
 * this path comes from a prologue, before any write. If a future change adds a `KINTAI_`-prefixed
 * throw AFTER the insert, this function would classify a write that DID land as a clean refusal,
 * return the row to `pending`, and invite a retry that double-applies it — the dangerous
 * direction, and the one the claim machinery exists to prevent.
 *
 * Note what the property is NOT: things after the insert certainly do throw. Via the amendment
 * branch, `actOnSubmission` delegates to `actOnAmendment`, which writes a punch and updates
 * `amendment_requests` after the approval event, and both can fail — `correctPunch`'s invariant
 * checks, a raw SQLite error. Those throws are UNCODED, so they land in the `APPLY_OUTCOME_UNKNOWN`
 * branch below, which is the honest disposition for a turn whose writes are genuinely half-done
 * (verified: a throw mid-turn does NOT roll back earlier writes in that turn). It is the coded/
 * uncoded split that is load-bearing here, not the absence of throws. `actOnAmendment` states the
 * same property from its own side and orders every coded refusal before its first write to keep it.
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

/**
 * The coded refusals of a decision that NO amount of waiting can turn into an appliable one.
 *
 * THE EXCEPTIONS TO "a clean refusal goes back to `pending`". Almost every refusal describes
 * something that can change back — a reporting line is restored, a returned submission is
 * resubmitted — so a retry can succeed and the Overseer offers one. These cannot, and left
 * `pending` they are worse than merely stuck, because a permanent refusal composes with staging's
 * dedupe: the identical decision re-issued deduplicates onto the unappliable row and returns
 * SUCCESS without queueing anything, a different one is refused with `KINTAI_DECISION_CONFLICT`,
 * and the session has no discard — so an approver following the error's own advice finds both
 * routes closed and their retry silently doing nothing. Failing the row is what reopens them:
 * `failed` is outside `staged_approvals_open`, so the manager can stage a fresh decision on the
 * same submission immediately, and `rejectAction` still clears it.
 *
 * Why each one is permanent:
 *
 *  - `KINTAI_STALE_DECISION` — the marker is `MAX(approval_events.id)`, which is monotonic, so
 *    the comparison that failed will fail identically forever.
 *  - `KINTAI_AMENDMENT_TARGET_SUPERSEDED` — `punches` is append-only and `supersedes_id` is never
 *    cleared, so the successor that made the correction unwritable is there for good.
 *    `punches_supersedes_unique` admits one live successor per punch and it is taken.
 *  - `KINTAI_AMENDMENT_DUPLICATE_PUNCH` — same table, same reason: the punch this request would
 *    duplicate is never removed.
 *
 * The last two are why this is a LIST and no longer a question about staleness. Both were shipped
 * as ordinary domain refusals, both are as permanent as staleness is, and both end their own
 * message with "Reject it" — an instruction the approver could not follow, because the rejection
 * collided with the dead approval as `KINTAI_DECISION_CONFLICT`. Nothing failed when they were
 * added, because the only statement that this list was meant to be complete was prose.
 *
 * IT IS NOW A TESTED CLAIM. `__tests__/approval-queue.test.ts` reads the two store modules whose
 * coded refusals reach `applyAction`, finds every code they define, and requires each one to be
 * classified there and this function to agree — so a new coded refusal cannot be added without
 * someone deciding, in writing, which side of this line it falls on. Add a permanent one here and
 * to that table together; the suite is red until you do.
 *
 * Matched on the message for the same reason `isDomainRefusal` is — `code` does not survive the
 * RPC boundary, so every error in this package repeats its code in its text — and anchored at the
 * start for the same reason too. See `isDomainRefusal`'s KNOWN FRAGILITY: a wrapper that prefixed
 * messages would stop every one of these being recognised.
 */
const TERMINAL_REFUSAL_CODES = [
  "KINTAI_STALE_DECISION",
  "KINTAI_AMENDMENT_TARGET_SUPERSEDED",
  "KINTAI_AMENDMENT_DUPLICATE_PUNCH",
] as const;

/**
 * Is this refusal one a retry can never resolve? See `TERMINAL_REFUSAL_CODES`.
 *
 * Exported for the exhaustiveness test described there, and for nothing else — the same reason
 * `applyStagedApprovalsSchema` is exported. A caller outside this module has no use for it: the
 * disposition it decides is `applyAction`'s, and there is only one `applyAction`.
 */
export function isTerminalRefusal(err: unknown): boolean {
  return (
    err instanceof Error &&
    TERMINAL_REFUSAL_CODES.some((code) => err.message.startsWith(`${code}:`))
  );
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

/**
 * What the approver reads before confirming a decision on a PUNCH CORRECTION.
 *
 * Split from `describeApproval`'s overtime text rather than parameterised, because almost nothing
 * survives the translation. An amendment's `minutes` is 0 by design and there is no quantity to
 * report; what a manager has to judge instead is a comparison — this punch says X, the employee
 * says it should say Y — and whether they believe the reason for the difference. Rendering that
 * through an overtime-shaped template produced "0 minutes of overtime", which is not a vague
 * description of the right thing but a confident description of the wrong one.
 *
 * The closed-period line is the one fact here that is not a property of the request, and it is
 * stated in both the title and the body on purpose. Applying an approved correction is the only
 * write in this system permitted into a month that has been closed (see `actOnAmendment`), the
 * approver cannot infer it from anything else they are shown, and a period is closed precisely
 * when somebody has already been paid on its totals.
 */
function describeCorrectionApproval(
  preview: ActPreview, action: ApprovalAction, comment?: string,
): ActionDescription {
  const amendment = preview.amendment!;
  const { verb } = DECISIONS[action];
  const requested = jstClockTime(amendment.requestedOccurredAt);
  // An addition has no left-hand side. Saying "nothing on this day" is the honest comparison; a
  // fabricated 00:00 would read as a punch that exists.
  const current = amendment.currentOccurredAt === null
    ? null
    : jstClockTime(amendment.currentOccurredAt);
  const change = current === null
    ? `${amendment.kind} punch added at ${requested} (none recorded)`
    : `${amendment.kind} punch ${current} → ${requested}`;
  const closed = amendment.lockedPeriod === null
    ? ""
    : `, into the closed period ${amendment.lockedPeriod}`;
  const step = preview.stepCount > 1
    ? `\n- **Approval step:** ${preview.stepNumber} of ${preview.stepCount}`
    : "";
  const lockWarning = amendment.lockedPeriod === null
    ? ""
    : `\n**The period ${amendment.lockedPeriod} is closed.** Applying this changes a month that ` +
      "has already been closed off, so any total already reported from it — including anything " +
      "already paid — no longer matches the record. A correction is the only write allowed in.\n";

  return {
    title:
      `${verb} the correction to ${preview.employeeName}'s attendance on ` +
      `${amendment.workDate}: ${change}${closed}`,
    description:
      `**${preview.actorName}** is deciding a punch correction for ` +
      `**${preview.employeeName}**. This is the sign-off itself, not a draft.\n` +
      "\n" +
      `- **Decision:** ${action}\n` +
      `- **Employee:** ${preview.employeeName} (${preview.employeeNumber})\n` +
      `- **Work date:** ${amendment.workDate}\n` +
      `- **Punch:** ${amendment.kind}\n` +
      `- **Currently recorded:** ${current ?? "nothing on this day"}\n` +
      `- **Requested time:** ${requested}${step}\n` +
      lockWarning +
      "\n" +
      "**The employee's stated reason**\n" +
      "\n" +
      `${quoted(preview.reason)}\n` +
      "\n" +
      `**${preview.actorName}'s comment**\n` +
      "\n" +
      `${quoted(comment ?? "")}\n` +
      "\n" +
      `${CORRECTION_DECISIONS[action].effect}\n` +
      "\n" +
      "Authority is re-checked against the organisation chart at the moment this is applied, so a " +
      "decision that is no longer yours to make will be refused rather than performed. So is the " +
      "correction itself: if the punch has been changed by someone else in the meantime, applying " +
      "this is refused rather than overwriting them. It cannot be undone automatically — punches " +
      "are never edited or deleted, so reversing an applied correction means filing another one.",
    implementsRevert: false,
    awaitDecision: true,
    actionKind: { tag: "kintai.actOnSubmission", label: "Decide a punch correction" },
  };
}

/**
 * What each decision does to a punch correction, in place of `DECISIONS`' overtime effects.
 *
 * A separate table rather than a reworded one: overtime's text is pinned byte-for-byte by tests,
 * and the two outcomes genuinely differ. Approving overtime makes minutes payable; approving a
 * correction WRITES A PUNCH — appending a row to an append-only table, superseding one that stays
 * permanently readable, and doing so even when the month is closed. That is a different promise and
 * an approver should not read one and get the other.
 */
const CORRECTION_DECISIONS = {
  approve: {
    effect:
      "Approving advances the correction to its next approval step, or — if this is the last step " +
      "— applies it immediately: a new punch is written and the one it replaces is superseded. " +
      "Both rows stay in the record permanently, so the original reading remains readable.",
  },
  reject: {
    effect:
      "Rejecting closes the request for good and changes no punch. The record keeps saying what it " +
      "says now. The employee would have to file a fresh correction.",
  },
  return: {
    effect:
      "Returning sends the request back to the employee as a draft so they can change what they " +
      "are asking for, and voids every approval collected so far — including any from other " +
      "approvers. No punch is written.",
  },
} as const satisfies Record<ApprovalAction, { effect: string }>;

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
  // Branch on what the submission IS, never on anything a caller passed. `preview.amendment` is
  // populated by `previewAct` from the two tables, so a correction cannot be made to describe
  // itself as overtime by any argument reaching this function.
  if (preview.amendment) return describeCorrectionApproval(preview, action, comment);
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
    singleton: { tsType: "KintaiSession" },
    // The HR/admin surface, hosted by the Workshop at `/gatekeepers/kintai`. Declaring it is what
    // makes the Workshop show the nav entry and call `startAppUi()`, so the two must be restored
    // together — a declaration without the method opens a nav entry onto nothing.
    providesUi: { title: "Kintai", icon: KINTAI_ICON },
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

  /**
   * Opens the app, with the capability CHOSEN by the caller's admin status.
   *
   * This is the authorization decision for the whole surface, and it is made here, once, on the
   * server. `context.isAdmin` is supplied fresh by the Workshop on every open (a user's admin
   * status can change), and it is consumed by this expression and never travels any further: it is
   * not put in the frame, not sent to the iframe, and not accepted back from it. The browser
   * therefore has nothing to lie about — an administrator holds `AdminKintaiApi`; everyone else
   * holds `EmployeeKintaiApi`, a DIFFERENT capability scoped to their own attendance, on which
   * `linkAccount` and every other admin method simply does not exist. There is no flag for the app
   * to respect and no method to refuse; the two are different objects.
   *
   * The alternative — one capability plus a boolean the app is trusted to honour — would put
   * `linkAccount` one forged message away from anyone, and `linkAccount` grants identity.
   *
   * The bundle is the same `APP_HTML` for both today; splitting the employee view out of it is
   * Task 3. What differs now is the capability behind the iframe, which is the half that decides
   * what a browser can actually do.
   */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ui = new NativeRpcStub(
      context.isAdmin
        ? new AdminKintaiApi(this.#store(), this.ctx.props.accountId)
        : new EmployeeKintaiApi(this.#store(), this.ctx.props.accountId),
    );
    return { iframeHtml: APP_HTML, ui };
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

/** A punch write's receipt: the row created, whose it is, and the day it was filed against. */
export type PunchReceipt = { punchId: number; employeeId: EmployeeId; workDate: string };

/**
 * THE punch implementation. Both facets that let a person clock in and out — `KintaiSession.punch`
 * (the agent-facing session) and `EmployeeKintaiApi.punch` (the app-UI employee capability) — call
 * exactly this, so the correctness-critical write has one code path rather than two that could
 * drift. Resolve the employee from the capability, then punch, with the one retry the race needs.
 *
 * Three RPCs into the store, and each is its own turn of that Durable Object's input gate, so the
 * gate opens twice inside this function. Deciding the date in `workDateFor` and writing it in
 * `commitPunch` is therefore not atomic: a concurrent `punch("out")` can close the shift in
 * between, and the `in` that read it would be filed against a shift that no longer exists.
 * `commitPunch` closes that — it decides the date AGAIN under the write's own gate and refuses if
 * the answer moved — and this function's job is to arrange the calls so that refusal can only ever
 * happen against a date whose period lock has been checked.
 *
 * Hence `attemptPunch` and hence the single retry. The lock check stays out here rather than move
 * into the store: the amendment path writes into closed periods and reaches the store directly, so
 * the store's writes cannot enforce locks for everyone. If the store refuses the date, the whole
 * sequence is redone — a fresh `workDateFor`, a fresh `assertWritable` against whatever it now
 * says, then the write — so the second attempt is validated exactly as carefully as the first. It
 * runs at most twice and the second attempt's refusal is surfaced, so there is no loop: a punch
 * cannot spin, and a store that disagreed twice is reporting a real conflict rather than a lost
 * race.
 *
 * `now` is captured by the CALLER and reused across both attempts, deliberately. It is when the
 * employee actually tapped the button, it is the `occurred_at` that gets written, and it is what
 * makes the store's recomputation a function of the punch table alone. Re-reading the clock on the
 * retry would move the event — so the callers read `Date.now()` once and pass it, exactly as every
 * instant in this package is a server clock and never a caller-supplied one.
 */
export async function performPunch(
  store: DurableObjectStub<KintaiStore>,
  accountId: string,
  kind: PunchKind,
  location: PunchLocation | undefined,
  now: number,
): Promise<PunchReceipt> {
  const employeeId = await store.resolveAccount(accountId, now);
  if (employeeId === null) throw new UnlinkedAccountError();
  try {
    return await attemptPunch(store, employeeId, kind, now, location);
  } catch (caught) {
    if (!isWorkDateRaced(caught)) throw caught;
    // Exactly one retry, and it is not a loop: this is the only site that retries, and nothing
    // `attemptPunch` calls can reach `performPunch` again.
    return await attemptPunch(store, employeeId, kind, now, location);
  }
}

/**
 * One attempt at the punch: attribute, check the lock against what came back, write.
 *
 * Throws `WorkDateRacedError` — recognised by its message across the RPC boundary, see
 * `isWorkDateRaced` — if the store's own recomputation disagrees with the date checked here.
 */
async function attemptPunch(
  store: DurableObjectStub<KintaiStore>,
  employeeId: EmployeeId, kind: PunchKind, now: number, location?: PunchLocation,
): Promise<PunchReceipt> {
  // Which day this punch belongs to is the employee's own `work_date_policy`, read from the record
  // their capability resolved to and never from anything the caller said. For everyone on
  // `calendar` this is `jstWorkDate(now)`; for `shift_start` it is the date of the shift open right
  // now, so an overnight shift stays on one day. The rule lives in `store/punches.ts`; this asks
  // for the answer. `kind` goes with it because the duplicate-window exception is keyed on it.
  const workDate = await store.workDateFor(employeeId, now, kind);
  // Period locks are enforced here, not inside the store's write functions: the amendment path has
  // to be able to write into a closed period, and it reaches the store directly.
  //
  // Checked against the ATTRIBUTED date, not today's: a night worker clocking out at 06:00 on the
  // first of the month is writing into the month that just closed, and that has to be refused the
  // same as any other write into a locked period.
  await store.assertWritable(workDate);
  // `commitPunch`, not `recordPunch`: the date above was decided in a turn that has since ended,
  // and this one refuses the write outright if it no longer holds.
  const punchId = await store.commitPunch({
    employeeId, workDate, kind, now, source: "gadget", location,
  });
  return { punchId, employeeId, workDate };
}

/**
 * The only surface Gadget code reaches: one employee's own attendance record.
 *
 * A Gadget's own Durable Object cannot identify its caller, which is why this Gatekeeper exists at
 * all. Identity arrives out of band as an opaque `accountId` in `ctx.props`, bound to the class by
 * `KintaiAccount.getSingletonGatekeeperClass` and handed to this session by
 * `KintaiGatekeeper.startSession`. Every method below resolves the employee from that capability,
 * and almost no method accepts an employee identifier as an argument — an employee can freely
 * rewrite their own Gadget's code, so the absence of such a parameter is the boundary, not any
 * check a caller could route around. For the same reason `now` is always `Date.now()` here and
 * never a parameter: a caller-supplied clock would let a Gadget punch into a closed period or
 * backdate a submission past an exemption window.
 *
 * THE EXCEPTION, and why it is one: `requestCorrectionFor` and `requestMissingPunchFor` do take an
 * `employeeId`, because a foreman filing a correction for a worker who has no phone on site is the
 * ordinary case this feature exists for. Read the rule above precisely — it rejects a check a
 * caller could ROUTE AROUND, not every check. What gates these two is `hasAuthorityOver`, a query
 * against `org_edges`, and the org chart is a fact the server owns: no Gadget can grant itself an
 * edge, and rewriting the calling code changes nothing about the answer. That is categorically
 * unlike trusting a caller's own claim about who they are, which is what `#accountId` still
 * decides and what no argument can override. Whose punch it is may be named; WHO IS ASKING may not.
 *
 * Note the pair that follows from it: `submissions.created_by` records the filer, and `checkMayAct`
 * refuses an approver who is either the employee or the filer. Filing for somebody else therefore
 * costs the filer the ability to decide it, which is the point rather than a side effect.
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

  /**
   * Record a clock event, at one instant, on the day the server decides it belongs to.
   *
   * Delegates to the free `performPunch` (above), which is the ONE punch implementation this
   * session shares with `EmployeeKintaiApi.punch`: resolve the employee from the capability,
   * attribute the date, check the lock against it, write, with the single race retry. The
   * orchestration and its reasoning live there so both callers are provably one path; this method
   * is the session's door onto it, reading the server clock once and passing it down.
   *
   * `punch` takes `kind` and an optional `location` and NOTHING else — no work date, no policy, no
   * timestamp. A Gadget can pass extra arguments and they are ignored by the signature, so the day
   * a punch lands on and the moment it records stay the server's to decide.
   */
  async punch(kind: PunchKind, location?: PunchLocation): Promise<PunchReceipt> {
    return performPunch(this.#store, this.#accountId, kind, location, Date.now());
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

  /**
   * Ask for a recorded punch to say a different time. Returns the submission id.
   *
   * A REQUEST, not an edit, and that distinction is the whole shape of this feature. Nothing about
   * the punch changes when this returns; it changes when somebody with authority approves the
   * request, and `punches` is append-only so even then the original stays permanently readable
   * beside its replacement. A caller — human or agent — that reports "fixed" on the strength of
   * this returning is reporting something that has not happened.
   *
   * Four methods rather than one with nullable fields, and the split is deliberate twice over.
   * Correcting a punch and adding one that was never recorded are different intentions with
   * different validation, and this surface is read by an agent through `types.txt`: choosing
   * between named methods errs less often than filling in a discriminating field. Filing for
   * SOMEBODY ELSE is then split again, because that is an authority decision and it should be
   * visible as one at the call site rather than implied by an argument.
   */
  async requestPunchCorrection(
    punchId: number, occurredAt: number, reason: string,
  ): Promise<number> {
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    // Names nobody but the caller, so it stays shareable — exactly as `punch` and `getDay` do.
    // The on-behalf forms below are the ones that reach into another record and say so.
    return this.#fileCorrection(employeeId, employeeId, punchId, occurredAt, reason, now);
  }

  /**
   * Ask for a punch that was never recorded to be added. The forgotten clock-out.
   *
   * `correctPunch` cannot express this — it supersedes an existing row and there is no row to
   * supersede — which is why this is a separate method rather than a correction with no target.
   */
  async requestMissingPunch(
    workDate: string, kind: PunchKind, occurredAt: number, reason: string,
  ): Promise<number> {
    assertWorkDate("workDate", workDate);
    assertPunchKind("kind", kind);
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#fileAddition(employeeId, employeeId, workDate, kind, occurredAt, reason, now);
  }

  /**
   * File a correction on behalf of somebody you have authority over.
   *
   * The case this exists for: a worker tells their foreman they clocked in before the terminal
   * woke up, and the worker has no device on site. Refusing that would push the fix onto an
   * administrator with no first-hand knowledge of the day.
   *
   * Authority is `hasAuthorityOver` — an `org_edges` query the caller cannot influence. Passing
   * your OWN id is refused rather than accommodated: nobody holds an edge to themselves, and
   * `requestPunchCorrection` is the method for that, so the two intentions stay distinct instead
   * of one silently covering both.
   */
  async requestCorrectionFor(
    employeeId: EmployeeId, punchId: number, occurredAt: number, reason: string,
  ): Promise<number> {
    assertEmployeeId("employeeId", employeeId);
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const filerId = await this.#requireEmployee(now);
    await this.#assertMayFileFor(filerId, employeeId, now);
    return this.#fileCorrection(employeeId, filerId, punchId, occurredAt, reason, now);
  }

  /** File a missing punch on behalf of somebody you have authority over. */
  async requestMissingPunchFor(
    employeeId: EmployeeId, workDate: string, kind: PunchKind,
    occurredAt: number, reason: string,
  ): Promise<number> {
    assertEmployeeId("employeeId", employeeId);
    assertWorkDate("workDate", workDate);
    assertPunchKind("kind", kind);
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const filerId = await this.#requireEmployee(now);
    await this.#assertMayFileFor(filerId, employeeId, now);
    return this.#fileAddition(employeeId, filerId, workDate, kind, occurredAt, reason, now);
  }

  /**
   * Refuse a filing for an employee this caller has no authority over, and record the reach as an
   * observation when they do.
   *
   * Two things, together, because they are one decision. Filing for somebody else reads into a
   * record that is not the caller's own — which punch ids are theirs, what their day already holds
   * — and that is the same class of data `listPendingApprovals` protects, so it is authorized the
   * same way and with every observer excluded: `KintaiVerifier` has no members, so an observer id
   * cannot be resolved to an employee and "may this collaborator see Tanaka's punches?" is not a
   * question anything here can answer.
   *
   * The observation is authorized BEFORE the store is asked. An observation the Overseer refuses
   * has to be able to prevent the filing; authorizing it after the write would make it a
   * notification rather than a decision.
   *
   * Workshop admin is NOT a bypass. This is the session facet, whose whole contract is one
   * employee's own record plus whatever the org chart adds; admin capability lives on
   * `AdminKintaiApi` and arrives through `startAppUi`, not here.
   */
  async #assertMayFileFor(filerId: EmployeeId, employeeId: EmployeeId, now: number): Promise<void> {
    const edge = await this.#store.hasAuthorityOver(filerId, employeeId, now);
    if (edge === null) throw new NotAuthorizedError();
    const employee = await this.#store.employeeLabel(employeeId);
    await this.#authorize(
      "Kintai record of an employee you manage",
      `File a punch correction for ${employee.display_name} (${employee.employee_number}), whose ` +
      "attendance record you have approval authority over in the organisation chart. This reads " +
      "which punches their day holds and files a request against one of them; it changes no punch " +
      "until somebody else approves it.",
      this.#listObservers(),
    );
  }

  /** The two filing paths, sharing everything after "who is asking, and for whom". */
  async #fileCorrection(
    employeeId: EmployeeId, filerId: EmployeeId,
    punchId: number, occurredAt: number, reason: string, now: number,
  ): Promise<number> {
    const profile = await this.#store.employeeProfile(employeeId);
    return this.#store.fileAmendment({
      employeeId, targetPunchId: punchId, occurredAt, reason, now,
      department: profile.department, employmentType: profile.employment_type,
      // Never defaulted. The origination rule — `checkMayAct` refusing an approver who filed the
      // request — is only as strong as this column being populated, and a filing path that forgot
      // it would let its filer approve their own request with nothing anywhere saying so.
      createdBy: filerId,
    });
  }

  async #fileAddition(
    employeeId: EmployeeId, filerId: EmployeeId, workDate: string, kind: PunchKind,
    occurredAt: number, reason: string, now: number,
  ): Promise<number> {
    const profile = await this.#store.employeeProfile(employeeId);
    return this.#store.fileAmendment({
      employeeId, targetPunchId: null, workDate, kind, occurredAt, reason, now,
      department: profile.department, employmentType: profile.employment_type,
      createdBy: filerId,
    });
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
    // no way to raise the overtime at all. `submitOvertime` pins its EXEMPTION check to
    // `requestedFor` rather than to now for the same reason: what is being judged is the work, on
    // the day it was done, however late the request about it arrives. (Its approver-reachability
    // check is asked at `now` instead, and deliberately — see `store/submissions.ts`. That one is
    // not about the work: it asks who exists to decide the request, which is a question about
    // today. It does not weaken the argument above, because it refuses a request nobody could ever
    // act on rather than one that merely arrived late.)
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
   *
   * STAGING IS IDEMPOTENT per (submission, actor). Re-issuing the same decision returns the one
   * already staged and queues nothing further; a different decision while one is pending is
   * refused (`ConflictingDecisionError`). Without that, one manager's single intent became two
   * queue entries, two confirmations and — on a multi-step route — two sign-offs at two different
   * steps, none of which can be undone: `approved` is terminal, `revertAction` refuses, and
   * `approval_events` is append-only. A retry is the ordinary response to a transient failure and
   * becomes more so as natural language drives this, so it has to be safe rather than merely
   * discouraged in the agent-facing docs.
   */
  async actOnSubmission(
    submissionId: number, action: ApprovalAction, comment?: string,
  ): Promise<void> {
    if (comment !== undefined) assertText("comment", comment, LIMITS.comment);
    // An empty comment is no comment. Everything downstream already treats them alike — the
    // description renders both as an empty quote and `approval_events.comment` stores NULL for
    // either — but staging compares comments to decide retry-versus-conflict, and without this the
    // one difference that is not a difference would make a re-issue a `KINTAI_DECISION_CONFLICT`.
    // A natural-language caller that omits the comment on one call and passes "" on the next is
    // not changing its decision.
    if (comment === "") comment = undefined;
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);

    const probe = await this.#store.previewActOnSubmission({ submissionId, actorId, now });

    const { id: stagedId, deduped } = this.#stageApproval({
      submissionId, actorId, action, comment, afterEventId: probe.afterEventId,
    });
    // Already staged, and already in front of the approver: this call is a retry of a decision
    // that was recorded, not a second decision. Returning without queueing again is the whole
    // point — two entries would be two confirmations, and on a multi-step route those land as
    // approvals at two different steps from one manager's single intent.
    //
    // KNOWN RACE, accepted. Returning here says "your decision is queued", which is read off the
    // ROW rather than off the queue — and the caller that inserted that row is, at this instant,
    // still awaiting `submitAction` below. If that submission is refused, that caller discards the
    // row and throws, and this one has already returned success for a decision that no longer
    // exists anywhere. It is bounded: it needs a concurrent identical call AND a refusing queue,
    // and the other caller does surface the error. The alternative is holding a lock across an
    // outgoing RPC, which is how the double-apply bug happened — a synchronous claim plus a narrow
    // accepted window beats a gate held open across an await.
    if (deduped) return;
    try {
      await this.#approvalQueue.submitAction(
        stagedId, describeApproval(probe.preview, action, comment),
      );
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
  /**
   * `latestEventId` for the submission when this decision was staged, or NULL on a row staged
   * before this column existed. See `applyAction` for what NULL means there.
   */
  staged_after_event_id: number | null;
};

/**
 * The staging table, its one-way migrations, and the index that makes staging idempotent.
 *
 * Exported so the migration ORDER can be tested against a legacy table, which is the only way to
 * reach it: a live facet runs this in its constructor, so by the time any test can see the table
 * it is already migrated. `KintaiFacetHost.migrateLegacyStaged` in the test worker builds the
 * pre-upgrade shape in its own storage and calls this.
 *
 * THE ORDER OF THE FOUR STATEMENTS IS THE WHOLE POINT and must not be rearranged:
 *
 *  1. create the table
 *  2. add `staged_after_event_id` if this facet predates it
 *  3. SWEEP interrupted rows, `applying` -> `failed`
 *  4. COLLAPSE duplicate open rows, then create the index over the open states
 *
 * 3 before 4 specifically. The collapse counts `applying` as open and keeps `MIN(id)`, so run the
 * other way round it can rank a row as the survivor that the sweep is about to declare dead: given
 * a legacy `#10 pending` and `#11 applying`, it would delete `#11` — a decision a human had ALREADY
 * confirmed and which may have reached the store — and keep `#10`, which then has no `applying` row
 * left for the sweep to find and a NULL staleness marker that makes the apply-time guard skip it
 * too. That is the double sign-off this whole mechanism exists to prevent, reintroduced by its own
 * migration. Swept first, `#11` is `failed` (terminal, never replayed) and `#10` is simply the
 * oldest open row, which is what "keep the oldest" is supposed to mean.
 */
export function applyStagedApprovalsSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS staged_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    actor_employee_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return')),
    comment TEXT,
    staged_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed')),
    error TEXT,
    staged_after_event_id INTEGER
  ) STRICT`);
  // Facets created before the staleness guard existed have the table without that column. Added
  // nullable, which is the only thing ADD COLUMN can do without a default, and NULL is read as
  // "staged before the guard" rather than as a marker value — see `applyAction`.
  if (!hasColumn(sql, "staged_approvals", "staged_after_event_id")) {
    sql.exec(`ALTER TABLE staged_approvals ADD COLUMN staged_after_event_id INTEGER`);
  }

  // A fresh instance means a fresh activation, so a row still marked `applying` belonged to an
  // interrupted one: the decision had already been sent to the store and may or may not have
  // landed. It must never be replayed — applying twice is not harmless, because on a multi-step
  // route the replay would be counted at the step the first apply advanced the submission to.
  //
  // FIRST, before the collapse below. See this function's header.
  sql.exec(
    `UPDATE staged_approvals SET state = 'failed', error = ? WHERE state = 'applying'`,
    APPLY_OUTCOME_UNKNOWN,
  );

  // A facet that predates the index may hold rows the index would reject, and CREATE UNIQUE INDEX
  // fails outright on those — which would make the constructor throw on every activation and brick
  // the facet. So the duplicates are collapsed first, keeping the OLDEST open decision for each
  // pair: it is the one that was staged first and the one the approver is most likely already
  // looking at. This runs once, on the first activation after the upgrade, and is a no-op
  // afterwards because the index then makes duplicates impossible.
  sql.exec(
    `DELETE FROM staged_approvals
     WHERE state IN ('pending', 'applying') AND id NOT IN (
       SELECT MIN(id) FROM staged_approvals
       WHERE state IN ('pending', 'applying')
       GROUP BY submission_id, actor_employee_id
     )`,
  );

  // ONE open decision per (submission, actor). This index is the dedupe mechanism, not a
  // convenience on top of one: `#stage` is synchronous SQLite with no `await` in it, so an INSERT
  // that the index rejects cannot have interleaved with the one that beat it — the same property
  // the apply-time claim relies on. An application-level "is there already one?" check would be a
  // second answer to a question the index already answers, and the kind that drifts.
  //
  // `applying` is in scope as well as `pending`: a decision that is mid-apply must not admit a
  // second one for the same submission and actor. `applied` and `failed` are out, so a settled
  // decision never blocks deciding again — which is what lets a manager re-decide immediately
  // after a stale decision is failed at apply.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS staged_approvals_open
    ON staged_approvals(submission_id, actor_employee_id)
    WHERE state IN ('pending', 'applying')`);
}

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
    applyStagedApprovalsSchema(this.#sql);
    // The collaborators the Overseer has told this facet about. Recorded, not merely accepted,
    // because `listPendingApprovals` has to name them: it returns other employees' payroll records
    // and the Overseer needs to know who must not see them. Opaque ids chosen by the Overseer —
    // never interpreted here, and never used for authorization.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS observers (
      id TEXT PRIMARY KEY
    ) STRICT`);
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
  #stage(staged: StagedApproval): StageResult {
    // No `await` anywhere in this method, and that is load-bearing: a Durable Object's input gate
    // is open across an await, so a check split from its insert by one would let two concurrent
    // callers both stage. Everything here is one synchronous run-to-completion block.
    const inserted = this.#sql
      .exec<{ id: number }>(
        `INSERT INTO staged_approvals
           (submission_id, actor_employee_id, action, comment, staged_at, state,
            staged_after_event_id)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        staged.submissionId, staged.actorId, staged.action, staged.comment ?? null, Date.now(),
        staged.afterEventId,
      )
      .toArray()[0];

    if (!inserted) return this.#openDecision(staged);

    // Bounded for the same reason as `LIMITS`: the code calling this is a Gadget the employee can
    // rewrite, and it can call in a loop. An unbounded staging table would let one account fill
    // its own facet's storage and the Overseer's approval queue with decisions nobody asked for.
    //
    // Counted AFTER the insert, and the row is rolled back if it does not fit. Checking first
    // would make a retry of an already-staged decision fail once the account is at the cap, when
    // it is the one call that adds nothing — and a retry is the normal response to a transient
    // failure, so it has to keep working right up to the limit.
    const { count } = this.#sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM staged_approvals WHERE state IN ('pending', 'applying')`,
      )
      .one();
    if (count > MAX_PENDING_STAGED_ACTIONS) {
      this.#sql.exec(`DELETE FROM staged_approvals WHERE id = ?`, inserted.id);
      throw new TooManyPendingActionsError(MAX_PENDING_STAGED_ACTIONS);
    }
    return { id: inserted.id, deduped: false };
  }

  /**
   * The insert was refused by `staged_approvals_open`, so this actor already has an open decision
   * on this submission. Which of the two things that means depends on whether it is the SAME
   * decision:
   *
   *  - the same one re-issued (same action, same comment) is a retry. It gets the id that is
   *    already staged, and its caller submits no second queue entry.
   *  - a different one is refused. See `ConflictingDecisionError` for why replacing is worse.
   *
   * The comment counts as part of the decision because the approver confirms the comment too: it
   * is rendered into the description they read, and it is written to the permanent approval event.
   */
  #openDecision(staged: StagedApproval): StageResult {
    const open = this.#sql
      .exec<StagedRow>(
        `SELECT * FROM staged_approvals
         WHERE submission_id = ? AND actor_employee_id = ? AND state IN ('pending', 'applying')`,
        staged.submissionId, staged.actorId,
      )
      .toArray()[0];
    if (!open) {
      // Unreachable: `staged_approvals_open` is the only constraint an ON CONFLICT DO NOTHING can
      // trip here, and it matches exactly this query. Refusing is still the safe direction if it
      // ever happens — the harm this whole mechanism exists to prevent is staging a duplicate.
      //
      // Its own code, NOT `KINTAI_DECISION_CONFLICT`: this is a broken invariant (someone added a
      // second unique constraint to this table, most likely), and a log aggregator must be able to
      // tell it from the ordinary refusal that a manager sees when they change their mind.
      throw new Error(
        "KINTAI_STAGING_INVARIANT: this decision could not be staged, and no decision awaiting " +
        "confirmation explains why. Nothing was recorded.",
      );
    }
    if (open.action !== staged.action || (open.comment ?? undefined) !== staged.comment) {
      throw new ConflictingDecisionError(open, staged.submissionId);
    }
    return { id: open.id, deduped: true };
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
        // The store compares this to the submission's history in the same call as the write, so
        // nothing can slip in between the check and the insert. NULL means a row staged before
        // this column existed: those keep the behaviour they were staged under (authority and
        // state re-checked, no staleness check) rather than being made permanently unappliable by
        // an upgrade.
        expectedAfterEventId: row.staged_after_event_id ?? undefined,
      });
    } catch (err) {
      if (isDomainRefusal(err)) {
        if (isTerminalRefusal(err)) {
          // Terminal, and deliberately so — see `TERMINAL_REFUSAL_CODES`. Nothing landed here
          // either (every one of them is raised before the write), so this is not
          // `APPLY_OUTCOME_UNKNOWN`: the row carries the refusal's own text, which names what
          // happened and tells the reader what to do instead — decide again, or reject the request
          // that can no longer be applied. It records WHY this one cannot be retried when most of
          // its siblings can, and frees the submission for the decision the text asks for.
          this.#setState(action, "failed", (err as Error).message);
          this.#prune();
          throw err;
        }
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

/**
 * One employee's own attendance capability, served to every non-admin by `startAppUi`.
 *
 * The employee-facing half of the same surface `AdminKintaiApi` is the HR half of: an app-UI
 * capability built once, server-side, from `isAdmin`. It carries one employee's own record and
 * nothing wider — no roster, no org chart, no other employee's day, and none of the on-behalf
 * filing the session facet allows a manager. Which employee is decided by the capability, resolved
 * from `ctx.props.accountId` on every call, and NO method takes an employee identifier: there is
 * nothing for a Gadget-rewriting employee to name themselves as, exactly as on `KintaiSession`.
 *
 * A concrete class with NO throw-with-interface twin, unlike the admin pair. There is no "employee
 * viewer" to refuse: a non-admin is precisely who this capability is FOR, so the structural line
 * `ViewerKintaiApi` used to hold — a refuse-all twin implementing the admin interface — has no
 * analogue here. The one thing that still has to be pinned is the surface itself: that this class
 * exposes exactly its own methods and NONE of the admin ones, nor `listPendingApprovals` /
 * `actOnSubmission` / any on-behalf `...For` — the approval and management surfaces belong to the
 * session and admin facets, not here. That pin lives in `__tests__/employee-api.test.ts`.
 *
 * `#store` is `#`-private for the reason it is on `KintaiSession`: it is an UNAUTHENTICATED handle
 * on the whole company's ledger, taking an `employeeId` on nearly every method, so a public field
 * would itself become part of the RPC surface and hand a Gadget the very parameter this class
 * withholds. `punch` is the shared `performPunch`, so an employee's clock-in and an agent's are one
 * implementation; the amendment filings mirror `KintaiSession`'s own bodies, for one employee with
 * no on-behalf variant, and record `createdBy = self` — never defaulted, because the origination
 * rule that stops a filer approving their own request is only as strong as that column.
 */
@validateRpc()
export class EmployeeKintaiApi extends RpcTarget {
  readonly #store: DurableObjectStub<KintaiStore>;
  readonly #accountId: string;

  constructor(store: DurableObjectStub<KintaiStore>, accountId: string) {
    super();
    this.#store = store;
    this.#accountId = accountId;
  }

  /**
   * Who the caller is, from the same `identify` the admin capability answers with — the employee
   * reads their OWN account code off it, which is the one thing an unlinked account may do.
   */
  async whoAmI(): Promise<KintaiIdentity> {
    return identify(this.#store, this.#accountId);
  }

  /** One day's punches, allocations, reconciliation, flags and lock — the caller's own. */
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

  /** One month of the caller's own days: worked minutes, flags and per-day overtime state. */
  async myMonth(period: string): Promise<EmployeeMonth> {
    assertPeriod("period", period);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#store.employeeMonth(employeeId, period);
  }

  /**
   * Record a clock event, through the ONE punch implementation both facets share. `now` is the
   * server's, read here and passed down; `punch` takes `kind` and an optional `location` and
   * nothing else, so the day it lands on and the moment it records stay the server's to decide.
   */
  async punch(kind: PunchKind, location?: PunchLocation): Promise<PunchReceipt> {
    return performPunch(this.#store, this.#accountId, kind, location, Date.now());
  }

  /**
   * Ask for a punch that was never recorded to be added — the forgotten clock-out. A REQUEST, not
   * an edit: nothing changes until an approver applies it. Mirrors `KintaiSession`'s own body, for
   * the caller's own record only.
   */
  async requestMissingPunch(
    workDate: string, kind: PunchKind, occurredAt: number, reason: string,
  ): Promise<number> {
    assertWorkDate("workDate", workDate);
    assertPunchKind("kind", kind);
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const profile = await this.#store.employeeProfile(employeeId);
    return this.#store.fileAmendment({
      employeeId, targetPunchId: null, workDate, kind, occurredAt, reason, now,
      department: profile.department, employmentType: profile.employment_type,
      // Never defaulted. `checkMayAct` refuses an approver who filed the request, and that rule is
      // only as strong as this column being populated — here the caller is the filer, and the
      // capability proves it.
      createdBy: employeeId,
    });
  }

  /**
   * Ask for a recorded punch to say a different time. A REQUEST, not an edit, exactly as
   * `KintaiSession.requestPunchCorrection` is — and, like it, names nobody but the caller.
   */
  async requestPunchCorrection(
    punchId: number, occurredAt: number, reason: string,
  ): Promise<number> {
    assertRequiredText("reason", reason, LIMITS.reason);
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const profile = await this.#store.employeeProfile(employeeId);
    return this.#store.fileAmendment({
      employeeId, targetPunchId: punchId, occurredAt, reason, now,
      department: profile.department, employmentType: profile.employment_type,
      createdBy: employeeId,
    });
  }

  /** The caller's own submissions — the employee id comes from the capability, not the caller. */
  async listMySubmissions(): Promise<SubmissionRow[]> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#store.listSubmissionsFor(employeeId);
  }

  /** Withdraw one of the caller's own submissions. */
  async withdrawSubmission(submissionId: number): Promise<void> {
    const actorId = await this.#requireEmployee(Date.now());
    await this.#store.withdrawSubmission(submissionId, actorId);
  }

  /** Move a returned submission back into the queue. The only path out of `draft`. */
  async resubmit(submissionId: number): Promise<void> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    await this.#store.resubmit(submissionId, actorId, now);
  }

  /**
   * Identity from the capability, never an argument, on every method above. Throws for an account
   * HR has not linked, exactly as `KintaiSession` does — every method but `whoAmI` needs it.
   */
  async #requireEmployee(now: number): Promise<EmployeeId> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, now);
    if (employeeId === null) throw new UnlinkedAccountError();
    return employeeId;
  }
}

// Moved to `work-date.ts` when attribution moved into the store, which `kintai.ts` imports — the
// function had to become a leaf or close a cycle. Re-exported so every existing importer, and the
// table of JST boundary cases pinning it in `facet.test.ts`, are unaffected. Same reason
// `InvalidInputError` is re-exported above.
export { jstWorkDate } from "./work-date.js";
