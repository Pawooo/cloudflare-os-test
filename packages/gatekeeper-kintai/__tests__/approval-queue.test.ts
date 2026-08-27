import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    const successor = await store.createEmployee({
      employeeNumber: `successor-aq${seq}`, displayName: "Successor", joinedOn: "2026-04-01",
    });
    await store.linkAccount(bossAccount, successor, Date.now());

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_STALE_ACTOR/);
    expect(await store.approvalEvents(submissionId)).toEqual([]);
  });

  it("refuses when the account has been revoked between staging and approval", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");

    await store.unlinkAccount(bossAccount, Date.now());

    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    expect(await store.approvalEvents(submissionId)).toEqual([]);
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
    await store.actOnSubmission({ submissionId: rejected, actorId: boss, action: "reject", now });
    await store.withdrawSubmission(withdrawn, worker);
    await store.actOnSubmission({ submissionId: returned, actorId: boss, action: "return", now });

    const stranger = sessionFor(strangerAccount);
    for (const id of [pending, rejected, withdrawn, returned]) {
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
// A REAL LIMITATION of routing this action through the queue, reproduced rather than described.
//
// `listPendingApprovals()` is marked `prohibitAllSharing`, deliberately and after review: it is the
// one read that returns other employees' payroll records. The Overseer's response to such an
// observation is to put the whole workspace into lockdown — and lockdown refuses EVERY action:
//
//   async submitAction(...) {
//     if (this.storage.prohibitAllSharing.get()) {
//       throw new Error("This workspace has observed sensitive data. To prevent leaks, the
//         workspace is prohibited from performing actions.");
//     }
//
// Before this change `actOnSubmission` wrote straight to the store and was untouched by that.
// Now it is an action, so the natural approver flow — list your queue, then decide on one of the
// entries — cannot complete inside one Gadget. And `listPendingApprovals()` is the ONLY way a
// Gadget can learn a submission id it may act on: the session exposes no `getSubmission`.
//
// This is a genuine conflict between two correct decisions, not something to work around here.
// Pinned so it is visible, and so it fails loudly if the Workshop's lockdown rule changes.
describe("the sharing lockdown blocks the approver flow", () => {
  it("refuses to stage a decision once the queue has been read in the same session", async () => {
    const { bossAccount, submissionId } = await pendingUnderManager();
    const session = sessionFor(bossAccount);

    // The only in-band way to discover a submission this account may act on.
    expect((await session.listPendingApprovals()).map((row: { id: number }) => row.id))
      .toEqual([submissionId]);

    await expect(() => session.actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/prohibited from performing actions/);

    // Nothing staged, nothing submitted, nothing applied: the decision simply cannot be made here.
    expect((await host.readQueue()).actions).toEqual([]);
    await expect(() => overseerFor(bossAccount).applyAction(1))
      .rejects.toThrow(/KINTAI_UNKNOWN_ACTION/);
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
  });

  it("still works for a session that never read the queue", async () => {
    // The lockdown is what blocks it, not anything about the decision — so the same decision, from
    // a session that reached the submission id another way, goes through unchanged.
    const { bossAccount, submissionId } = await pendingUnderManager();

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await overseerFor(bossAccount).applyAction(1);

    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });
});
