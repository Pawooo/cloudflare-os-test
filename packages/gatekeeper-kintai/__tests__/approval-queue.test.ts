import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isTerminalRefusal } from "../src/kintai.js";
// The two store modules whose coded refusals can reach `applyAction`, as source text. See
// "the terminal-refusal classification" at the foot of this file for why they are read this way.
import submissionsSource from "../src/store/submissions.ts?raw";
import amendmentsSource from "../src/store/amendments.ts?raw";

// `actOnSubmission` is the one side-effecting operation Kintai exposes to a Gadget, and it is a
// manager's approval of somebody else's pay. `Gatekeeper.startSession` requires that side-effecting
// actions "must not actually be performed until they are approved", so the session STAGES the
// decision and submits it to the Overseer's ApprovalQueue; the write happens later, in
// `KintaiGatekeeper.applyAction`.
//
// These tests exercise both halves against the real runtime — the session side through
// `callSession` and the Overseer side (`applyAction`/`rejectAction`/`revertAction`) through
// `callFacet` on the SAME facet name, which is exactly how the Overseer routes an approval back
// (`overseer.ts` resolves `ctx.facets.get(\`gatekeeper${id}\`, ...)` from the gatekeeper record id,
// a stable name, then calls `applyAction` on it).
//
// A host instance of its own, so the recorded queue and the staged rows belong to this file alone.
const HOST = "approval-overseer";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let host: ReturnType<typeof env.KINTAI_FACET_HOST.getByName>;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  store = env.KINTAI_STORE.getByName("");
  host = env.KINTAI_FACET_HOST.getByName(HOST);
  await host.resetQueue();
});

/**
 * One facet name per account per test. Both `sessionFor` and `overseerFor` derive it, so the facet
 * that stages an action is the same facet the Overseer later calls back — the production shape.
 */
function facetName(accountId: string) {
  return `aq-${accountId}-${seq}`;
}

function proxyTo(call: (method: string, args: unknown[]) => Promise<unknown>) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => call(method, args);
    },
  }) as any;
}

/** The agent-facing session: the only surface a Gadget reaches. */
function sessionFor(accountId: string) {
  return proxyTo((method, args) => host.callSession(accountId, facetName(accountId), method, args));
}

/** The `Gatekeeper<KintaiSession>` protocol surface, which only the Overseer reaches. */
function overseerFor(accountId: string) {
  return proxyTo((method, args) => host.callFacet(accountId, facetName(accountId), method, args));
}

/** The most recent action submitted to the approval queue. */
async function lastSubmitted() {
  const { actions } = await host.readQueue();
  return actions.at(-1);
}

async function linkedEmployee(tag: string, extra: Record<string, unknown> = {}) {
  const employeeId = await store.createEmployee({
    employeeNumber: `${tag}-aq${seq}`,
    displayName: tag,
    joinedOn: "2026-04-01",
    ...extra,
  });
  const accountId = `acct-${tag}-aq${seq}`;
  await store.linkAccount(accountId, employeeId, Date.now());
  return { employeeId, accountId };
}

async function managerRoute() {
  await store.createRoute({
    name: `aq-route-${seq}`,
    steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
  });
}

/** A worker with a manager who can approve for them, and one pending submission. */
async function pendingUnderManager(minutes = 90, requestedFor = "2026-07-03") {
  const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("boss");
  const { employeeId: worker, accountId: workerAccount } = await linkedEmployee("worker");
  await store.setReportingLine(worker, boss, 0);
  await managerRoute();
  const submissionId = await store.submitOvertime({
    employeeId: worker, requestedFor, minutes, reason: "server migration ran long",
    now: Date.now(), department: null, employmentType: null,
  });
  return { boss, bossAccount, worker, workerAccount, submissionId };
}

describe("staging", () => {
  it("submits the decision for approval instead of applying it", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();

    expect(await sessionFor(bossAccount).actOnSubmission(submissionId, "approve"))
      .toBeUndefined();

    // Nothing was written: the submission is untouched and the approval log is empty.
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
    expect(await store.approvalEvents(submissionId)).toEqual([]);

    const { actions } = await host.readQueue();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe(1);
  });

  it("describes the decision, the employee, the hours and the date to the approver", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager(90, "2026-07-03");

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "looks right");
    const submitted = (await lastSubmitted())!;

    // "Approve action #7" is worse than no confirmation at all: it trains people to click through.
    expect(submitted.title).toMatch(/worker/);
    expect(submitted.title).toMatch(/2026-07-03/);
    for (const detail of [
      "worker",              // whose overtime
      "boss",                // who is deciding
      "2026-07-03",          // which date
      "90",                  // how many minutes
      "1h 30m",              // ...and in the form a human reads
      "server migration ran long", // what they said they were doing
      "looks right",         // the approver's own comment
    ]) {
      expect(submitted.description).toContain(detail);
    }
    expect(submitted.description.toLowerCase()).toContain("approve");
  });

  it("names the decision it is actually staging, not always 'approve'", async () => {
    const first = await pendingUnderManager();
    await sessionFor(first.bossAccount).actOnSubmission(first.submissionId, "reject");
    expect((await lastSubmitted())!.title.toLowerCase()).toContain("reject");

    seq += 1;
    const second = await pendingUnderManager();
    await sessionFor(second.bossAccount).actOnSubmission(second.submissionId, "return");
    expect((await lastSubmitted())!.title.toLowerCase()).toContain("return");
  });

  it("declares itself unrevertable, blocking, and never auto-approvable", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    const submitted = (await lastSubmitted())!;

    // An applied approval appends an immutable `approval_events` row; "reverting" means appending
    // a compensating decision, which is a payroll question, not a mechanical undo.
    expect(submitted.implementsRevert).toBe(false);
    // Kintai does not simulate: a later read would show a world where the approval did not happen.
    expect(submitted.awaitDecision).toBe(true);
    // Two independent gates keep approving somebody else's pay out of auto-approval: the per-action
    // verdict below, and the facet's empty `getAutoApprovableActions()`.
    expect(submitted.autoApprovable).toBe(false);
    expect(submitted.actionKind).toEqual({
      tag: "kintai.actOnSubmission",
      label: "Decide an overtime submission",
    });
    expect(await overseerFor(bossAccount).getAutoApprovableActions()).toEqual([]);
  });

  it("stages nothing when the queue refuses the submission", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await host.resetQueue(false, true);

    await expect(() => sessionFor(bossAccount).actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/ACTION_DENIED/);

    // The refused id must not be applicable afterwards: a rolled-back stage leaves no row.
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
  });
});

describe("applying", () => {
  it("performs the approval, exactly once", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "ok");

    await overseerFor(bossAccount).applyAction(1);

    expect((await store.getSubmission(submissionId)).state).toBe("approved");
    const events = await store.approvalEvents(submissionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "approve", comment: "ok" });
  });

  it("is idempotent, so a repeated callback cannot double-approve", async () => {
    // Without this, a second apply on a multi-step route would count the same approver twice.
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    await overseerFor(bossAccount).applyAction(1);
    await overseerFor(bossAccount).applyAction(1);

    expect(await store.approvalEvents(submissionId)).toHaveLength(1);
  });

  it("carries the reject and return decisions through too", async () => {
    const rejected = await pendingUnderManager();
    await sessionFor(rejected.bossAccount).actOnSubmission(rejected.submissionId, "reject");
    await overseerFor(rejected.bossAccount).applyAction(1);
    expect((await store.getSubmission(rejected.submissionId)).state).toBe("rejected");

    seq += 1;
    const returned = await pendingUnderManager();
    await sessionFor(returned.bossAccount).actOnSubmission(returned.submissionId, "return");
    await overseerFor(returned.bossAccount).applyAction(1);
    expect((await store.getSubmission(returned.submissionId)).state).toBe("draft");
  });

  it("refuses an action it never staged", async () => {
    const { bossAccount } = await pendingUnderManager();

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });

  it("re-runs every authority check, so authority lost in the meantime refuses the write", async () => {
    // The exact drift the last defect wave found: a designated approver may act ONLY while the
    // employee has no reporting line. Give the employee one after staging and the approval that
    // was legitimate at stage time is no longer theirs to make.
    const { employeeId: designated, accountId: designatedAccount } = await linkedEmployee("desig");
    const { employeeId: rootless } = await linkedEmployee("rootless", {
      designatedApproverId: designated,
    });
    await managerRoute();
    const submissionId = await store.submitOvertime({
      employeeId: rootless, requestedFor: "2026-07-03", minutes: 60, reason: "root case",
      now: Date.now(), department: null, employmentType: null,
    });

    await sessionFor(designatedAccount).actOnSubmission(submissionId, "approve");

    // The org changes: the employee now reports to a manager, so the root escape hatch closes.
    const newBoss = await store.createEmployee({
      employeeNumber: `newboss-aq${seq}`, displayName: "NewBoss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(rootless, newBoss, 0);

    await expect(() => overseerFor(designatedAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);

    expect((await store.getSubmission(submissionId)).state).toBe("pending");
    expect(await store.approvalEvents(submissionId)).toEqual([]);
  });

  it("refuses when the submission left `pending` between staging and approval", async () => {
    const { bossAccount, workerAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    await sessionFor(workerAccount).withdrawSubmission(submissionId);

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
    expect(await store.approvalEvents(submissionId)).toEqual([]);
  });

  it("refuses when the facet's capability no longer names the employee that staged it", async () => {
    // The staged actor is server-derived, and it must STILL be who this facet speaks for. An
    // account re-pointed at somebody else must not be able to spend a decision staged by its
    // previous holder.
    const { boss, bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    const successor = await store.createEmployee({
      employeeNumber: `successor-aq${seq}`, displayName: "Successor", joinedOn: "2026-04-01",
    });
    await store.linkAccount(bossAccount, successor, Date.now());

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_ACTOR/);
    expect(await store.approvalEvents(submissionId)).toEqual([]);

    // The row went back to `pending`, not left `applying`. This is not bookkeeping: `rejectAction`
    // also refuses an `applying` row, so a decision stuck in that state would be unappliable AND
    // unclearable until the Durable Object restarts. HR re-points the account back and the same
    // decision applies — which it can only do from `pending`.
    await store.linkAccount(bossAccount, boss, Date.now());
    await overseerFor(bossAccount).applyAction(1);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });

  it("refuses when the account has been revoked between staging and approval", async () => {
    const { boss, bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    await store.unlinkAccount(bossAccount, Date.now());

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    expect(await store.approvalEvents(submissionId)).toEqual([]);

    // Reset to `pending`, for the same reason as above: nothing was sent to the store, a revoked
    // account can be re-linked, and the Overseer offers the user a retry that must be able to
    // succeed. A row left `applying` would be permanently unappliable and unrejectable.
    await store.linkAccount(bossAccount, boss, Date.now());
    await overseerFor(bossAccount).applyAction(1);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });

  it("leaves a refused action retryable rather than consuming it", async () => {
    // The Overseer's contract: a throw from `applyAction` means "the user will be informed that
    // the action failed and given the opportunity to retry or discard". A refusal that silently
    // ate the staged row would turn every retry into a confusing "unknown action".
    const { bossAccount, workerAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await sessionFor(workerAccount).withdrawSubmission(submissionId);

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
    // Still the same refusal, not KINTAI_UNKNOWN_ACTION: the row survived, so a retry is possible.
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
    // ...and rejecting it is still the way to clear it.
    expect(await overseerFor(bossAccount).rejectAction(1)).toBeUndefined();
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });
});

describe("rejecting", () => {
  it("discards the staged decision without applying anything", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    expect(await overseerFor(bossAccount).rejectAction(1)).toBeUndefined();

    expect((await store.getSubmission(submissionId)).state).toBe("pending");
    expect(await store.approvalEvents(submissionId)).toEqual([]);
    // The discarded row is gone: a later apply cannot resurrect it.
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });

  it("ignores an action it never staged, as the protocol requires of cleanup", async () => {
    const { bossAccount } = await pendingUnderManager();
    expect(await overseerFor(bossAccount).rejectAction(99)).toBeUndefined();
  });

  it("refuses to reject an action that has already been applied", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await overseerFor(bossAccount).applyAction(1);

    await expect(() => overseerFor(bossAccount).rejectAction(1))
      .rejects.toThrow(/KINTAI_ALREADY_APPLIED/);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });
});

describe("reverting", () => {
  it("refuses, because un-approving payroll is a decision, not an undo", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await overseerFor(bossAccount).applyAction(1);

    await expect(() => overseerFor(bossAccount).revertAction(1))
      .rejects.toThrow(/cannot be reverted/i);
    // The description told the UI as much, so this path should never be offered in the first place.
    expect((await lastSubmitted())!.implementsRevert).toBe(false);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });
});

describe("authority is settled before anything is staged", () => {
  it("refuses self-approval at stage time, submitting nothing", async () => {
    const { workerAccount, submissionId } = await pendingUnderManager();

    await expect(() => sessionFor(workerAccount).actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_SELF_APPROVAL/);

    expect((await host.readQueue()).actions).toEqual([]);
    await expect(() => overseerFor(workerAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });

  it("refuses a stranger at stage time, submitting nothing", async () => {
    const { submissionId } = await pendingUnderManager();
    const { accountId: strangerAccount } = await linkedEmployee("stranger");

    await expect(() => sessionFor(strangerAccount).actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);

    // An approver must never be asked to confirm something that would fail on apply — and a
    // stranger must not be able to fill the Overseer's queue with actions about other people.
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("tells a stranger the same thing in every live state, staging nothing", async () => {
    // The state oracle the earlier review closed. Staging must not reopen it: the probe runs the
    // same prologue as the write, so authority is settled before any state is named.
    const { employeeId: worker } = await linkedEmployee("probe-worker");
    const { employeeId: boss } = await linkedEmployee("probe-boss");
    const { accountId: strangerAccount } = await linkedEmployee("probe-stranger");
    await store.setReportingLine(worker, boss, 0);
    await managerRoute();

    const now = Date.now();
    const file = async (requestedFor: string, reason: string) => store.submitOvertime({
      employeeId: worker, requestedFor, minutes: 60, reason, now,
      department: null, employmentType: null,
    });
    const pending = await file("2026-07-03", "pending");
    const rejected = await file("2026-07-04", "rejected");
    const withdrawn = await file("2026-07-05", "withdrawn");
    const returned = await file("2026-07-06", "returned");
    const approved = await file("2026-07-07", "approved");
    await store.actOnSubmission({ submissionId: rejected, actorId: boss, action: "reject", now });
    await store.withdrawSubmission(withdrawn, worker);
    await store.actOnSubmission({ submissionId: returned, actorId: boss, action: "return", now });
    await store.actOnSubmission({ submissionId: approved, actorId: boss, action: "approve", now });
    // Every state the machine has, so the sweep cannot miss one.
    expect((await store.getSubmission(approved)).state).toBe("approved");

    const stranger = sessionFor(strangerAccount);
    for (const id of [pending, rejected, withdrawn, returned, approved]) {
      await expect(() => stranger.actOnSubmission(id, "approve"))
        .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
      await expect(() => stranger.actOnSubmission(id, "approve"))
        .rejects.not.toThrow(/KINTAI_INVALID_TRANSITION/);
    }
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("still gives an authorized approver KINTAI_INVALID_TRANSITION on a terminal submission", async () => {
    const { boss, bossAccount, worker } = await pendingUnderManager();
    const terminal = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-09", minutes: 60, reason: "done",
      now: Date.now(), department: null, employmentType: null,
    });
    await store.actOnSubmission({
      submissionId: terminal, actorId: boss, action: "reject", now: Date.now(),
    });

    await expect(() => sessionFor(bossAccount).actOnSubmission(terminal, "approve"))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("refuses an unknown submission without staging", async () => {
    const { bossAccount } = await pendingUnderManager();

    await expect(() => sessionFor(bossAccount).actOnSubmission(999_999, "approve"))
      .rejects.toThrow(/KINTAI_NOT_FOUND/);
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("refuses a decision that is not one of the three, rather than staging junk", async () => {
    // Staging raises the stakes on this: an unchecked value used to die on `approval_events`'
    // CHECK constraint inside the same call, but a staged one would be shown to an approver as a
    // decision and confirmed by them long before it failed. `@validateRpc()` is what stops it —
    // `ApprovalAction` is a union of three literals — so this pins that the boundary really is
    // generated from the declared type and really does run before the body.
    const { bossAccount, submissionId } = await pendingUnderManager();

    for (const bad of ["Approve", "delete", "", "approve "]) {
      await expect(() => sessionFor(bossAccount).actOnSubmission(submissionId, bad))
        .rejects.toThrow(/expected union/);
    }
    expect((await host.readQueue()).actions).toEqual([]);
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });

  it("refuses an over-long comment before anything is staged", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();

    await expect(() =>
      sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "x".repeat(2_001)))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("refuses an unlinked account before anything is staged", async () => {
    const { submissionId } = await pendingUnderManager();

    await expect(() => sessionFor("acct-aq-never-linked").actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    expect((await host.readQueue()).actions).toEqual([]);
  });

  it("bounds how many decisions may sit unapproved", async () => {
    // The staging table lives in the facet's own storage and an agent can call this in a loop.
    const { boss, bossAccount, worker } = await pendingUnderManager();
    const session = sessionFor(bossAccount);
    expect(boss).toBeGreaterThan(0);

    const ids: number[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push(await store.submitOvertime({
        employeeId: worker, requestedFor: "2026-07-20", minutes: 30, reason: `bulk ${i}`,
        now: Date.now(), department: null, employmentType: null,
      }));
    }
    for (let i = 0; i < 50; i++) await session.actOnSubmission(ids[i], "approve");

    await expect(() => session.actOnSubmission(ids[50], "approve"))
      .rejects.toThrow(/KINTAI_TOO_MANY_PENDING_ACTIONS/);
  });
});

describe("staged actions are isolated per account", () => {
  it("cannot be applied through another account's facet", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    const { accountId: outsiderAccount } = await linkedEmployee("outsider");

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    // Staged rows live in the facet's own storage, and a facet is per account, so the outsider's
    // facet has no such row at all — isolation by construction, not by an ownership check.
    await expect(() => overseerFor(outsiderAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
  });

  it("keeps two facets' identically-numbered actions apart", async () => {
    // Action ids are assigned per facet, so both of these are action 1. Applying one must not
    // touch the other's submission.
    const first = await pendingUnderManager(60, "2026-07-21");
    await sessionFor(first.bossAccount).actOnSubmission(first.submissionId, "approve");

    seq += 1;
    const second = await pendingUnderManager(60, "2026-07-22");
    await sessionFor(second.bossAccount).actOnSubmission(second.submissionId, "reject");

    await overseerFor(second.bossAccount).applyAction(1);

    expect((await store.getSubmission(second.submissionId)).state).toBe("rejected");
    expect((await store.getSubmission(first.submissionId)).state).toBe("pending");
  });
});

// ------------------------------------------------------------------------------------------------
// The regression this suite exists to guard.
//
// `listPendingApprovals()` used to be marked `prohibitAllSharing`, which puts the whole workspace
// into permanent lockdown — and lockdown refuses EVERY action:
//
//   async submitAction(...) {
//     if (this.storage.prohibitAllSharing.get()) {
//       throw new Error("This workspace has observed sensitive data. To prevent leaks, the
//         workspace is prohibited from performing actions.");
//     }
//
// That was harmless while `actOnSubmission` wrote straight to the store. The moment it became an
// action it was fatal: `listPendingApprovals()` is the ONLY way a Gadget can learn a submission id
// it may act on (the session exposes no `getSubmission`), so reading the queue permanently
// disabled deciding on anything in it — the entire approver flow, in one call.
//
// The fix is `excludeObservers`, which blocks the read when a collaborator could see it but sets
// no lockdown. These tests pin both halves: the flow works, and the protection still holds.
describe("reading the approval queue does not disable deciding on it", () => {
  it("stages and applies a decision in the very session that read the queue", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    // The only in-band way to discover a submission this account may act on.
    expect((await session.listPendingApprovals()).map((row: { id: number }) => row.id))
      .toEqual([submissionId]);

    // ...and deciding on what it returned still works. This is the assertion that would have
    // caught the regression.
    await session.actOnSubmission(submissionId, "approve");
    await overseerFor(bossAccount).applyAction(1);

    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });

  it("marks the queue read as excluding collaborators rather than as unshareable", async () => {
    // `prohibitAllSharing` is what caused the lockdown, so nothing may set it.
    const { bossAccount } = await pendingUnderManager();

    await sessionFor(bossAccount).listPendingApprovals();

    const queueRead = (await host.readQueue()).observations.at(-1)!;
    expect(queueRead.title).toBe("Kintai approval queue");
    expect(queueRead.prohibitAllSharing).toBe(false);
  });
});

describe("the approval queue read still protects other employees' records", () => {
  /** A live verifier stub, which is the only thing `addObserver` will accept. */
  async function verifier() {
    return (await env.KINTAI_VENDOR.createAccount()).getVerifier();
  }

  it("refuses the read outright when a current collaborator could see it", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await overseerFor(bossAccount).addObserver("collab", await verifier());
    await host.setShares(["collab"]);

    // The Overseer cannot promise a still-authorized collaborator will not see it, so it blocks
    // the observation and no data is returned — the same protection the old flag gave.
    await expect(() => sessionFor(bossAccount).listPendingApprovals())
      .rejects.toThrow(/OBSERVATION_EXCLUDED/);

    // The caller's own data stays readable: only the queue read names anybody.
    await expect(sessionFor(bossAccount).listMySubmissions()).resolves.toBeDefined();
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
  });

  it("names every recorded collaborator, because none of them can be resolved to an employee", async () => {
    const { bossAccount } = await pendingUnderManager();
    const stub = await verifier();
    await overseerFor(bossAccount).addObserver("collab-b", stub);
    await overseerFor(bossAccount).addObserver("collab-a", stub);
    // Idempotent by contract: the Overseer re-runs verification with the same id.
    await overseerFor(bossAccount).addObserver("collab-a", stub);

    await host.resetQueue();
    await sessionFor(bossAccount).listPendingApprovals();

    const queueRead = (await host.readQueue()).observations.at(-1)!;
    expect(queueRead.excludeObservers).toEqual(["collab-a", "collab-b"]);
  });

  it("stops naming a collaborator who has been removed", async () => {
    const { bossAccount } = await pendingUnderManager();
    const stub = await verifier();
    await overseerFor(bossAccount).addObserver("stays", stub);
    await overseerFor(bossAccount).addObserver("goes", stub);

    await overseerFor(bossAccount).removeObserver("goes");
    // Idempotent, as the contract requires of an id it no longer knows.
    await overseerFor(bossAccount).removeObserver("goes");

    await host.resetQueue();
    await sessionFor(bossAccount).listPendingApprovals();
    expect((await host.readQueue()).observations.at(-1)!.excludeObservers).toEqual(["stays"]);

    // ...and the removed collaborator no longer blocks the read, while the remaining one does.
    await host.setShares(["goes"]);
    await expect(sessionFor(bossAccount).listPendingApprovals()).resolves.toBeDefined();
    await host.setShares(["stays"]);
    await expect(() => sessionFor(bossAccount).listPendingApprovals())
      .rejects.toThrow(/OBSERVATION_EXCLUDED/);
  });

  it("picks up a collaborator added while the session is already running", async () => {
    // The observer list is read on every call, not captured when the session opened — a Gadget
    // that opened its session before being shared must not keep reading payroll data.
    const { bossAccount } = await pendingUnderManager();
    const session = sessionFor(bossAccount);
    await expect(session.listPendingApprovals()).resolves.toBeDefined();

    await overseerFor(bossAccount).addObserver("late", await verifier());
    await host.setShares(["late"]);

    await expect(() => session.listPendingApprovals()).rejects.toThrow(/OBSERVATION_EXCLUDED/);
  });
});

// ------------------------------------------------------------------------------------------------
// Concurrency. `applyAction` awaits an RPC before it claims the row, and a Durable Object's input
// gate is OPEN across an await — so two calls can both read `pending`, both pass the `applying`
// guard, and both proceed. This is not theoretical: `overseer.ts`'s `approveAction` checks state
// synchronously, then awaits `#getClientProfile()` before calling `applyPendingAction`, and only
// marks the record approved after `applyAction` returns. Two clicks race. The Overseer builds a
// single-flight drainer for the AUTO-approval path and says so at `overseer.ts:4207`, but Kintai's
// action is never auto-approvable, so the manual path is the only one that reaches us and it has
// no such guard.
//
// The harm is exactly the one the claim machinery exists to prevent: on a multi-step route the
// replay is counted at the step the first apply advanced to.
describe("a decision cannot be applied twice concurrently", () => {
  it("admits one caller and refuses the other, leaving one approval event", async () => {
    const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("race-boss");
    const { employeeId: worker } = await linkedEmployee("race-worker");
    await store.setReportingLine(worker, boss, 0);
    // TWO steps, so a replay is not merely refused by the state machine but actively harmful:
    // the first apply advances to step 1, and a second would satisfy step 1 and approve outright.
    // Scoped to a department, and the submission is filed under it: this store is shared by every
    // test in the package and `resolveRoute` breaks a specificity tie by lowest id, so a catch-all
    // route created by an earlier test would otherwise win and this would silently become a
    // one-step route — which would test nothing, because the state machine alone refuses a replay
    // on a one-step route.
    await store.createRoute({
      name: `race-route-${seq}`,
      department: "RACE",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
      ],
    });
    const submissionId = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-30", minutes: 60, reason: "race",
      now: Date.now(), department: "RACE", employmentType: null,
    });
    // Guard the guard: prove the two-step route is the one that was snapshotted.
    expect(JSON.parse((await store.getSubmission(submissionId)).route_snapshot).steps)
      .toHaveLength(2);
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    const overseer = overseerFor(bossAccount);
    const results = await Promise.allSettled([overseer.applyAction(1), overseer.applyAction(1)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/KINTAI_ACTION_IN_FLIGHT/);

    // The decision was recorded once, and the submission advanced exactly one step.
    expect(await store.approvalEvents(submissionId)).toHaveLength(1);
    const after = await store.getSubmission(submissionId);
    expect(after.state).toBe("pending");
    expect(after.current_step).toBe(1);
  });

  it("is failed rather than returned to pending, so deciding again is not a dead end", async () => {
    // Staleness is the ONE refusal that can never become retryable: the marker is monotonic, so
    // the comparison that failed will fail identically forever. Returned to `pending` it composed
    // with staging's dedupe into a dead end with a success-shaped exit — the identical retry
    // deduplicated onto the unappliable row and RESOLVED, a different decision was refused as a
    // conflict, and the session has no discard.
    const { bossAAccount, bossB, submissionId } = await twoStepUnderTwoManagers("STALE-4");
    await sessionFor(bossAAccount).actOnSubmission(submissionId, "approve");
    await store.actOnSubmission({
      submissionId, actorId: bossB, action: "approve", now: Date.now(),
    });
    await expect(() => overseerFor(bossAAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_DECISION/);

    // Terminal: it still refuses, and with the reason recorded on the row rather than as an
    // in-flight or unknown outcome. (`applying` refuses `rejectAction` too, so it is unclearable.)
    await expect(() => overseerFor(bossAAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_DECISION/);

    // `failed` is outside the open-decision index, so the manager can decide again IMMEDIATELY on
    // the submission as it now stands — this is what the error's own advice tells them to do.
    await sessionFor(bossAAccount).actOnSubmission(submissionId, "approve");
    expect((await host.readQueue()).actions).toHaveLength(2);
    await overseerFor(bossAAccount).applyAction(2);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
    expect(await store.approvalEvents(submissionId)).toHaveLength(2);

    // ...and the dead decision is still clearable the ordinary way.
    expect(await overseerFor(bossAAccount).rejectAction(1)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------
// Idempotent staging.
//
// `actOnSubmission` used to stage unconditionally, so two calls made one intent into two staged
// rows and two queue entries. On a multi-step route the two human confirmations then land as
// approvals at two DIFFERENT steps — one manager's single decision, two signatures — and none of
// it can be undone: `approved` is terminal, `revertAction` refuses, and `approval_events` is
// append-only.
//
// The mechanism is a partial unique index over the open states, not an application-level check:
// `#stage` is synchronous SQLite with no `await` in it, so check-and-insert cannot interleave.

/** A worker with two managers, and a two-step route that only their department resolves to. */
async function twoStepUnderTwoManagers(department: string, requestedFor = "2026-08-03") {
  const { employeeId: bossA, accountId: bossAAccount } = await linkedEmployee("boss-a");
  const { employeeId: bossB, accountId: bossBAccount } = await linkedEmployee("boss-b");
  const { employeeId: worker } = await linkedEmployee("two-step-worker", { department });
  await store.setReportingLine(worker, bossA, 0);
  await store.setReportingLine(worker, bossB, 0);
  // Scoped to a department, exactly as the concurrency test above is, and for the same reason:
  // this store is shared by every test file and `resolveRoute` breaks a specificity tie by lowest
  // id, so a catch-all route from another test would otherwise silently win.
  await store.createRoute({
    name: `stale-route-${department}-${seq}`,
    department,
    steps: [
      { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
      { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
    ],
  });
  const submissionId = await store.submitOvertime({
    employeeId: worker, requestedFor, minutes: 60, reason: "two-step",
    now: Date.now(), department, employmentType: null,
  });
  // Guard the guard: prove the two-step route is the one that was snapshotted.
  expect(JSON.parse((await store.getSubmission(submissionId)).route_snapshot).steps)
    .toHaveLength(2);
  return { bossA, bossAAccount, bossB, bossBAccount, worker, submissionId };
}

describe("staging the same decision twice", () => {
  it("stages once and queues once when two identical calls race", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    const results = await Promise.allSettled([
      session.actOnSubmission(submissionId, "approve", "ok"),
      session.actOnSubmission(submissionId, "approve", "ok"),
    ]);

    // Both callers succeed — a retry is the normal response to a transient failure and must not
    // become an error — but there is only ever one decision.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await host.readQueue()).actions).toHaveLength(1);
    await expect(() => overseerFor(bossAccount).applyAction(2))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);

    await overseerFor(bossAccount).applyAction(1);
    expect(await store.approvalEvents(submissionId)).toHaveLength(1);
  });

  it("gives a sequential retry the id it already staged, and queues nothing new", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    await session.actOnSubmission(submissionId, "approve", "ok");
    await session.actOnSubmission(submissionId, "approve", "ok");

    expect((await host.readQueue()).actions).toHaveLength(1);
    expect((await host.readQueue()).actions[0].action).toBe(1);
    await expect(() => overseerFor(bossAccount).applyAction(2))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
  });

  it("refuses a DIFFERENT decision while one is awaiting confirmation", async () => {
    // Silently replacing a decision the manager may already be looking at in the Workshop is worse
    // than an error, so this is a refusal rather than an overwrite.
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);
    await session.actOnSubmission(submissionId, "approve", "ok");

    await expect(() => session.actOnSubmission(submissionId, "reject"))
      .rejects.toThrow(/KINTAI_DECISION_CONFLICT/);
    // The error names the decision that is already pending, or the manager cannot act on it.
    await expect(() => session.actOnSubmission(submissionId, "reject"))
      .rejects.toThrow(/approve/);
    // A different comment is a different decision: the approver confirms the comment too.
    await expect(() => session.actOnSubmission(submissionId, "approve", "actually, no"))
      .rejects.toThrow(/KINTAI_DECISION_CONFLICT/);

    // Nothing extra was queued, and the original decision is untouched and still appliable.
    expect((await host.readQueue()).actions).toHaveLength(1);
    await overseerFor(bossAccount).applyAction(1);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
    expect(await store.approvalEvents(submissionId)).toMatchObject([{ comment: "ok" }]);
  });

  it("lets the decision be staged again once the first has been discarded", async () => {
    // The index covers the OPEN states only: a discarded decision must not block deciding again.
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);
    await session.actOnSubmission(submissionId, "approve");
    await overseerFor(bossAccount).rejectAction(1);

    await session.actOnSubmission(submissionId, "reject");

    expect((await host.readQueue()).actions).toHaveLength(2);
    await overseerFor(bossAccount).applyAction(2);
    expect((await store.getSubmission(submissionId)).state).toBe("rejected");
  });

  it("still accepts a retry when the account is already at the pending cap", async () => {
    // The cap is counted after the insert and the row rolled back if it does not fit, rather than
    // checked before it. Checking first would make the ONE call that adds nothing — a retry of a
    // decision already staged — the call that fails at the boundary.
    const { bossAccount, worker } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    const ids: number[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push(await store.submitOvertime({
        employeeId: worker, requestedFor: "2026-08-20", minutes: 30, reason: `cap ${i}`,
        now: Date.now(), department: null, employmentType: null,
      }));
    }
    for (let i = 0; i < 50; i++) await session.actOnSubmission(ids[i], "approve");

    // Full — and a retry of one that is already staged still succeeds.
    await expect(session.actOnSubmission(ids[49], "approve")).resolves.toBeUndefined();
    // ...while a genuinely new decision is still refused.
    await expect(() => session.actOnSubmission(ids[50], "approve"))
      .rejects.toThrow(/KINTAI_TOO_MANY_PENDING_ACTIONS/);
    // The refused one left nothing behind: 50 staged rows, 50 queue entries.
    expect((await host.readQueue()).actions).toHaveLength(50);
  });

  it("treats an omitted comment and an empty one as the same decision", async () => {
    // The comment is part of the decision because the approver confirms it — but "" and omitted
    // are the same absence, and everything downstream already renders and stores them alike. A
    // natural-language caller that passes one on the first call and the other on its retry is not
    // changing its mind, and must not be told it has a conflict.
    const { bossAccount, worker, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    await session.actOnSubmission(submissionId, "approve");
    await expect(session.actOnSubmission(submissionId, "approve", "")).resolves.toBeUndefined();

    // ...and in the other order, on a second submission.
    const second = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-08-11", minutes: 45, reason: "second",
      now: Date.now(), department: null, employmentType: null,
    });
    await session.actOnSubmission(second, "approve", "");
    await expect(session.actOnSubmission(second, "approve")).resolves.toBeUndefined();

    // One decision each, not four.
    expect((await host.readQueue()).actions).toHaveLength(2);
  });

  it("keeps two managers' decisions on the same submission apart", async () => {
    // The index is per (submission, actor). Two approvers deciding on one submission are two
    // decisions, and neither may swallow the other.
    const { bossAAccount, bossBAccount, submissionId } = await twoStepUnderTwoManagers("DEDUPE-2");

    await sessionFor(bossAAccount).actOnSubmission(submissionId, "approve");
    await sessionFor(bossBAccount).actOnSubmission(submissionId, "approve");

    expect((await host.readQueue()).actions).toHaveLength(2);
  });
});

describe("the one-way migration from a pre-index facet", () => {
  it("sweeps interrupted rows BEFORE collapsing duplicates, not after", async () => {
    // The collapse counts `applying` as open and keeps `MIN(id)`, so run before the sweep it can
    // rank a row as the survivor that the sweep is about to declare dead — deleting a decision a
    // human had already confirmed and which may have reached the store, in favour of an older
    // `pending` one that then has a NULL marker and so skips the staleness guard as well. That is
    // the double sign-off this whole change exists to prevent, reintroduced by its own migration.
    const migrated = await host.migrateLegacyStaged([
      // Confirmed and interrupted mid-apply, alongside an older pending decision for the same pair.
      { id: 10, submissionId: 1, actorId: 5, action: "approve", state: "pending" },
      { id: 11, submissionId: 1, actorId: 5, action: "approve", state: "applying" },
      // A genuine legacy duplicate: two open decisions, which the index would refuse to be created
      // over. The older survives.
      { id: 20, submissionId: 2, actorId: 6, action: "approve", state: "pending" },
      { id: 21, submissionId: 2, actorId: 6, action: "reject", state: "pending" },
    ]);

    expect(migrated.map((row) => [row.id, row.state])).toEqual([
      [10, "pending"], [11, "failed"], [20, "pending"],
    ]);
    // #11 survived as terminal, carrying the never-replay reason — not deleted for being younger.
    expect(migrated.find((row) => row.id === 11)!.error)
      .toMatch(/KINTAI_APPLY_OUTCOME_UNKNOWN/);
    // Every legacy row is read at apply time as "staged before the guard existed".
    expect(migrated.every((row) => row.staged_after_event_id === null)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// The apply-time staleness guard.
//
// A staged decision is a photograph of the submission at stage time. Hours or days later the world
// may have moved past it — another approver signed, the employee's request was returned and
// refiled — and applying it then records a decision about something the manager never saw.
//
// The marker is `MAX(approval_events.id)`, read in the SAME store call as the authority check at
// stage time and compared in the SAME store call as the write at apply time. Not a timestamp
// (caller-supplied, non-monotonic — this package already rejected timestamps for the return
// boundary) and not `current_step` (resets to 0 on a return, so a returned-and-refiled submission
// looks identical to what a stale row recorded).

describe("a staged decision the world has moved past", () => {
  it("is refused at apply after another approver acted on the same submission", async () => {
    const { bossA, bossAAccount, bossB, submissionId } = await twoStepUnderTwoManagers("STALE-1");
    expect(bossA).toBeGreaterThan(0);

    await sessionFor(bossAAccount).actOnSubmission(submissionId, "approve");

    // The other manager signs step 0 first, advancing the submission to step 1.
    await store.actOnSubmission({
      submissionId, actorId: bossB, action: "approve", now: Date.now(),
    });
    expect((await store.getSubmission(submissionId)).current_step).toBe(1);

    // Without the guard this lands as a SECOND approval, counted at step 1 — which satisfies the
    // final step and approves the submission outright on one manager's single decision.
    await expect(() => overseerFor(bossAAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_DECISION/);

    expect(await store.approvalEvents(submissionId)).toHaveLength(1);
    const after = await store.getSubmission(submissionId);
    expect(after.state).toBe("pending");
    expect(after.current_step).toBe(1);
  });

  it("is refused at apply after the submission was returned and refiled", async () => {
    // `current_step` is back to 0 and the state is back to `pending`, so neither the state machine
    // nor a step comparison can see anything wrong. The event log can.
    const { boss, bossAccount, worker, submissionId } = await pendingUnderManager();

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "fine by me");

    await store.actOnSubmission({
      submissionId, actorId: boss, action: "return", now: Date.now(),
    });
    await store.resubmit(submissionId, worker, Date.now());
    const refiled = await store.getSubmission(submissionId);
    expect(refiled.state).toBe("pending");
    expect(refiled.current_step).toBe(0);

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_DECISION/);

    // Only the return is on the record; the approval of content the manager never saw is not.
    expect(await store.approvalEvents(submissionId)).toMatchObject([{ action: "return" }]);
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
  });

  it("applies normally when the submission already had history that has not moved", async () => {
    // The guard compares the marker; it does not refuse merely because events exist. A decision
    // staged at step 1 of a route whose step 0 was already signed must still apply.
    const { bossAAccount, bossB, submissionId } = await twoStepUnderTwoManagers("STALE-3");
    await store.actOnSubmission({
      submissionId, actorId: bossB, action: "approve", now: Date.now(),
    });

    await sessionFor(bossAAccount).actOnSubmission(submissionId, "approve");
    await overseerFor(bossAAccount).applyAction(1);

    expect((await store.getSubmission(submissionId)).state).toBe("approved");
    expect(await store.approvalEvents(submissionId)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------
// Refusals that no amount of waiting can turn into an appliable decision.
//
// `KINTAI_STALE_DECISION` was the first of these and the reason `isTerminalRefusal` exists: a
// permanent refusal left `pending` composes with staging's dedupe into a dead end with a
// success-shaped exit. The amendment path added two more of exactly that shape —
// `punches` is append-only, `supersedes_id` is never cleared and an added punch is never removed,
// so neither `KINTAI_AMENDMENT_TARGET_SUPERSEDED` nor `KINTAI_AMENDMENT_DUPLICATE_PUNCH` can ever
// revert — and both errors' own text ends "Reject it". Left `pending`, that instruction was
// impossible to follow: the rejection was refused as `KINTAI_DECISION_CONFLICT`, the identical
// approval deduplicated onto the dead row and RESOLVED without queueing anything, and the manager
// had no route out at all.
//
// Exercised through the real facet, because that is where the classification lives: the store
// refuses identically whichever way the facet reads the refusal.
const AMEND_DAY = "2026-07-03";
/** 09:00 JST on `AMEND_DAY`. */
const AMEND_NINE = Date.parse("2026-07-03T00:00:00Z");
/** 18:00 JST on `AMEND_DAY`, where a forgotten clock-out belongs. */
const AMEND_SIX_PM = AMEND_NINE + 9 * 3_600_000;
/** When the manager decides: after every punch and filing instant used below. */
const AMEND_DECIDED = AMEND_NINE + 30 * 3_600_000;

/** A worker with a manager, one clock-in on `AMEND_DAY`, and the account ids for both. */
async function amendableWorker() {
  const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("amend-boss");
  const { employeeId: worker, accountId: workerAccount } = await linkedEmployee("amend-worker");
  await store.setReportingLine(worker, boss, 0);
  const punchId = await store.recordPunch({
    employeeId: worker, workDate: AMEND_DAY, kind: "in", now: AMEND_NINE, source: "gadget",
  });
  return { boss, bossAccount, worker, workerAccount, punchId };
}

describe("an amendment that can no longer be applied", () => {
  it("frees the approver to reject a correction whose target was fixed by hand", async () => {
    const { boss, bossAccount, worker, punchId } = await amendableWorker();
    const submissionId = await store.fileAmendment({
      employeeId: worker, targetPunchId: punchId, occurredAt: AMEND_NINE - 1800_000,
      reason: "clocked in before the terminal woke up", now: AMEND_NINE + 20 * 3_600_000,
      department: null, employmentType: null, createdBy: worker,
    });
    const session = sessionFor(bossAccount);
    await session.actOnSubmission(submissionId, "approve", "looks right");

    // An administrator corrects the punch directly while the request sits in the queue. Nothing
    // reserves a target against `correctPunch`, and `punches_supersedes_unique` allows only one
    // live successor — so this correction can never be written, now or ever.
    await store.correctPunch(
      punchId,
      { employeeId: worker, workDate: AMEND_DAY, kind: "in", now: AMEND_NINE - 60_000,
        source: "admin" },
      boss, "fixed by hand", AMEND_NINE + 26 * 3_600_000,
    );

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_AMENDMENT_TARGET_SUPERSEDED/);
    // Terminal: the row carries the refusal's own text rather than "outcome unknown", so a second
    // callback repeats what happened instead of re-asking a store that will never say yes.
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_AMENDMENT_TARGET_SUPERSEDED/);

    // ...and the disposal the error itself prescribes is now available. `failed` is outside the
    // open-decision index, so the rejection stages immediately instead of colliding with the dead
    // approval as `KINTAI_DECISION_CONFLICT`.
    await session.actOnSubmission(submissionId, "reject", "already fixed directly");
    expect((await host.readQueue()).actions).toHaveLength(2);
    await overseerFor(bossAccount).applyAction(2);
    expect((await store.getSubmission(submissionId)).state).toBe("rejected");
    expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: null });

    // The dead decision is still clearable the ordinary way.
    expect(await overseerFor(bossAccount).rejectAction(1)).toBeUndefined();
  });

  it("frees the approver to reject an addition the day has since acquired", async () => {
    const { bossAccount, worker } = await amendableWorker();
    const submissionId = await store.fileAmendment({
      employeeId: worker, targetPunchId: null, workDate: AMEND_DAY, kind: "out",
      occurredAt: AMEND_SIX_PM, reason: "forgot to clock out",
      now: AMEND_NINE + 20 * 3_600_000,
      department: null, employmentType: null, createdBy: worker,
    });
    const session = sessionFor(bossAccount);
    await session.actOnSubmission(submissionId, "approve");

    // The punch arrives by another route. Two punches at one instant are legal — a double-tap
    // outside the suppression window is a real record — so nothing in the database would refuse
    // the write; the day would simply carry the same event twice, forever.
    await store.recordPunch({
      employeeId: worker, workDate: AMEND_DAY, kind: "out", now: AMEND_SIX_PM, source: "gadget",
    });

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_AMENDMENT_DUPLICATE_PUNCH/);
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_AMENDMENT_DUPLICATE_PUNCH/);

    await session.actOnSubmission(submissionId, "reject", "the punch is already there");
    await overseerFor(bossAccount).applyAction(2);
    expect((await store.getSubmission(submissionId)).state).toBe("rejected");
    expect((await store.currentPunches(worker, AMEND_DAY))
      .filter((punch) => punch.kind === "out")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The classification itself, kept exhaustive by construction.
//
// The defect above was not a bug in a branch; it was a hand-maintained list of one code in
// `kintai.ts` while the codes themselves were being added two modules away. Nothing failed, and
// nothing could have: no test knew the list was meant to be complete.
//
// So this is the test that now fails. It reads the two store modules whose coded refusals can
// reach `applyAction` — `actOnSubmission` and the amendment path it dispatches to — finds every
// `KINTAI_` code they define, and requires each one to appear in the table below AND for
// `isTerminalRefusal` to agree with it. Adding a coded refusal to either module without deciding,
// in writing, whether waiting can ever make it appliable is therefore a red suite rather than a
// deadlocked approver.
//
// Read as source text with `?raw` rather than by importing the classes: constructing them needs
// arguments, and a list of classes to construct is the same hand-maintained list one level down.
// ------------------------------------------------------------------------------------------------
// What the approver is shown when the submission is a CORRECTION rather than overtime.
//
// An amendment's `minutes` is 0 by design — it has no minutes, and `fileAmendment` says so — so an
// unconditionally overtime-shaped description asked a manager to confirm "0 minutes of overtime",
// with nothing about which punch, what it says now, what it would say, or that the write lands in
// a closed month. The comment on the overtime test above names the harm this is one step worse
// than: a confirmation that MISdescribes the write is worse than one that says too little.
describe("describing a correction to an approver", () => {
  /**
   * A worker with a manager, one clock-in at 09:00, and a pending correction of it to 08:30.
   *
   * `day` is a parameter because this file shares ONE store (`getByName("")`, matching production)
   * so that queue state accumulates the way it really does — and a period lock is the one piece of
   * that state no employee tag can scope. A test that closes a month closes it for every later
   * test, so the test asserting an OPEN period has to be asked about a month nothing has locked.
   */
  async function stagedCorrection(bossTag = "desc-boss", day = AMEND_DAY) {
    const nine = Date.parse(`${day}T00:00:00Z`);
    const { employeeId: boss, accountId: bossAccount } = await linkedEmployee(bossTag);
    const { employeeId: worker, accountId: workerAccount } = await linkedEmployee("desc-worker");
    await store.setReportingLine(worker, boss, 0);
    const punchId = await store.recordPunch({
      employeeId: worker, workDate: day, kind: "in", now: nine, source: "gadget",
    });
    const submissionId = await store.fileAmendment({
      employeeId: worker, targetPunchId: punchId, occurredAt: nine - 1800_000,
      reason: "clocked in before the terminal woke up", now: nine + 20 * 3_600_000,
      department: null, employmentType: null, createdBy: worker,
    });
    return { boss, bossAccount, worker, workerAccount, punchId, submissionId };
  }

  it("names the punch, what it says now and what it would say", async () => {
    const { bossAccount, submissionId } = await stagedCorrection();

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "checked the site log");
    const submitted = (await lastSubmitted())!;

    expect(submitted.title).toBe(
      "Approve the correction to desc-worker's attendance on 2026-07-03: " +
      "in punch 09:00 → 08:30",
    );
    for (const detail of [
      "- **Work date:** 2026-07-03",
      "- **Punch:** in",
      "- **Currently recorded:** 09:00",
      "- **Requested time:** 08:30",
      "clocked in before the terminal woke up",  // why the record differs
      "checked the site log",                    // the approver's own comment
    ]) {
      expect(submitted.description).toContain(detail);
    }
    // No minutes are invented. An amendment has none, and 0 is not a claim of nothing.
    expect(submitted.title).not.toMatch(/overtime|minute/i);
    expect(submitted.description).not.toMatch(/Overtime claimed|0 minutes/);
    expect(submitted.actionKind).toEqual({
      tag: "kintai.actOnSubmission",
      label: "Decide a punch correction",
    });
  });

  it("says no punch exists rather than showing a time that does not", async () => {
    const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("add-boss");
    const { employeeId: worker } = await linkedEmployee("add-worker");
    await store.setReportingLine(worker, boss, 0);
    const submissionId = await store.fileAmendment({
      employeeId: worker, targetPunchId: null, workDate: AMEND_DAY, kind: "out",
      occurredAt: AMEND_SIX_PM, reason: "forgot to clock out",
      now: AMEND_NINE + 20 * 3_600_000,
      department: null, employmentType: null, createdBy: worker,
    });

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    const submitted = (await lastSubmitted())!;

    expect(submitted.title).toBe(
      "Approve the correction to add-worker's attendance on 2026-07-03: " +
      "out punch added at 18:00 (none recorded)",
    );
    expect(submitted.description).toContain("- **Currently recorded:** nothing on this day");
    expect(submitted.description).toContain("- **Requested time:** 18:00");
  });

  it("says plainly that the write lands in a closed period", async () => {
    // The one thing an approver most needs to know and cannot infer: applying this is the only
    // write in the system allowed into a month that has been closed.
    // A month of its own: locking 2026-07 here would make the next test's "open period" claim
    // false, and the failure would look like a bug in the description rather than in the fixture.
    const { boss, bossAccount, submissionId } =
      await stagedCorrection("locked-boss", "2026-06-03");
    await store.lockPeriod("2026-06", boss, AMEND_NINE + 25 * 3_600_000);

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    const submitted = (await lastSubmitted())!;

    expect(submitted.title).toContain("into the closed period 2026-06");
    expect(submitted.description).toContain("**The period 2026-06 is closed.**");
  });

  it("says nothing about a period that is open", async () => {
    const { bossAccount, submissionId } = await stagedCorrection("open-boss");

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    const submitted = (await lastSubmitted())!;

    expect(submitted.title).not.toContain("closed");
    expect(submitted.description).not.toContain("is closed");
  });

  it("names the decision it is staging, on a correction as on overtime", async () => {
    const { bossAccount, submissionId } = await stagedCorrection("reject-boss");

    await sessionFor(bossAccount).actOnSubmission(submissionId, "reject");

    expect((await lastSubmitted())!.title).toMatch(/^Reject the correction/);
  });

  it("still describes overtime as overtime", async () => {
    // The branch must be on what the submission IS, not on anything a caller says, and the
    // overtime description is pinned byte-for-byte by the tests above this one.
    const { bossAccount, submissionId } = await pendingUnderManager(90, "2026-07-03");

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    const submitted = (await lastSubmitted())!;

    expect(submitted.title).toContain("1h 30m of overtime");
    expect(submitted.description).toContain("- **Overtime claimed:** 90 minutes (1h 30m)");
    expect(submitted.actionKind).toMatchObject({ label: "Decide an overtime submission" });
  });
});

describe("the terminal-refusal classification", () => {
  /**
   * Every coded refusal these two modules define, and whether the condition it names can ever
   * revert. `terminal` means it cannot: the staged decision is failed rather than left `pending`,
   * so the manager can decide again immediately instead of deadlocking against staging's dedupe.
   *
   * Codes that no longer reach `applyAction` at all are still classified, and classified as
   * `retryable` — the disposition they have today. Where that is because the refusal is
   * unreachable rather than because it can revert, the comment says so, because "unreachable" is
   * a fact about today's callers and the classification has to survive one of them changing.
   */
  const DISPOSITION: Record<string, "terminal" | "retryable"> = {
    // --- submissions.ts
    // Both operands are immutable — a submission's `employee_id` and `created_by` never change,
    // and the staged row's actor is fixed and re-verified — so neither can become true after
    // staging, and staging itself refused them through the same prologue.
    KINTAI_SELF_APPROVAL: "retryable",
    KINTAI_FILED_BY_APPROVER: "retryable",
    // `submitOvertime` only; no decision path raises it.
    KINTAI_EXEMPT_EMPLOYEE: "retryable",
    // The genuinely retryable one, and the reason the default is `pending`: a reporting line is
    // restored or a designated approver is set, and the same decision then applies.
    KINTAI_NOT_AUTHORIZED: "retryable",
    // Nothing deletes submissions, so this is permanent in practice — but a decision on a
    // submission that does not exist has nothing to double-apply, and `rejectAction` clears the
    // row. Left retryable because failing it changes nothing an approver can observe.
    KINTAI_NOT_FOUND: "retryable",
    // Reverts: a returned submission is resubmitted and is `pending` again. Pinned through the
    // facet by "leaves a refused action retryable rather than consuming it".
    KINTAI_INVALID_TRANSITION: "retryable",
    // The marker is `MAX(approval_events.id)`, which is monotonic. The comparison that failed
    // fails identically forever.
    KINTAI_STALE_DECISION: "terminal",

    // --- amendments.ts
    // Filing-time refusals. `fileAmendment` raises all four before any submission exists, so no
    // staged decision can meet them.
    KINTAI_AMENDMENT_TARGET: "retryable",
    KINTAI_PUNCH_ALREADY_AMENDED: "retryable",
    KINTAI_DUPLICATE_PUNCH: "retryable",
    KINTAI_DUPLICATE_AMENDMENT: "retryable",
    // `supersedes_id` is never cleared and `punches` is append-only, so the successor that made
    // this correction unwritable is there for good.
    KINTAI_AMENDMENT_TARGET_SUPERSEDED: "terminal",
    // Same reason: the punch that would be duplicated is never removed.
    KINTAI_AMENDMENT_DUPLICATE_PUNCH: "terminal",
  };

  const DEFINED = [
    ...submissionsSource.matchAll(/readonly code = "(KINTAI_[A-Z_]+)"/g),
    ...amendmentsSource.matchAll(/readonly code = "(KINTAI_[A-Z_]+)"/g),
  ].map((match) => match[1]);

  it("has an entry for every coded refusal the two modules define", () => {
    // Guard the guard: a regex that matched nothing would make this test vacuously green.
    expect(DEFINED.length).toBeGreaterThan(10);
    for (const code of DEFINED) {
      expect(
        Object.keys(DISPOSITION),
        `${code} is a coded refusal with no entry in DISPOSITION. Decide whether the condition ` +
        `it names can ever revert: if it cannot, it belongs in isTerminalRefusal, or a staged ` +
        `decision meeting it deadlocks the approver.`,
      ).toContain(code);
    }
  });

  it("has no entry for a code that no longer exists", () => {
    // The other direction, so a renamed code is caught rather than silently reclassified: the
    // rename would add an unclassified code above and leave a dead entry here.
    for (const code of Object.keys(DISPOSITION)) expect(DEFINED).toContain(code);
  });

  it("classifies each of them the way the table says", () => {
    for (const [code, disposition] of Object.entries(DISPOSITION)) {
      expect(isTerminalRefusal(new Error(`${code}: whatever the message says`)), code)
        .toBe(disposition === "terminal");
    }
  });

  it("matches the code only at the start of the message", () => {
    // The anchoring `isDomainRefusal` documents as load-bearing, held here too: a refusal that
    // merely mentions a terminal code in its prose must not be failed terminally.
    expect(isTerminalRefusal(
      new Error("KINTAI_NOT_AUTHORIZED: see also KINTAI_STALE_DECISION for the other case"),
    )).toBe(false);
    expect(isTerminalRefusal(new Error("KINTAI_STALE_DECISIONS: not this code"))).toBe(false);
    expect(isTerminalRefusal("KINTAI_STALE_DECISION: not an Error at all")).toBe(false);
  });
});
