import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The correction loop end to end through the facet: an employee asks for a punch to be fixed or
// added, it appears in their manager's queue, the manager decides it, and the day changes.
//
// This is the first surface from which a punch can be corrected at all. `fileAmendment` has
// existed since the store work landed and had no caller outside these tests; every rule it
// enforces is covered at store level in `__tests__/amendments.test.ts`. What is only testable
// here is the part the facet owns: identity from the capability, authority to file for somebody
// else, the server clock, and the fact that filing changes NOTHING until an approval is applied.
//
// Setup follows `__tests__/facet.test.ts` exactly — see its header for why a test cannot mint an
// account-imbued facet from `env` and has to go through `KINTAI_FACET_HOST`.
//
// Rejection assertions are written as `expect(() => session.method(...))`, never as
// `expect(session.method(...))` — see the header of `submissions.test.ts` for why.

const DAY = "2026-07-03";
/** 09:00 JST on `DAY`. */
const NINE = Date.parse("2026-07-03T00:00:00Z");
/** 18:00 JST on `DAY`, where a forgotten clock-out belongs. */
const SIX_PM = NINE + 9 * 3_600_000;
/** 23:00 JST on `DAY`: fourteen hours after the clock-in, which is exactly `long_span`. */
const ELEVEN_PM = NINE + 14 * 3_600_000;
/** A department, so the route created below outranks the catch-all `applySchema` seeds. */
const DEPT = "CONSTRUCTION";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
const host = env.KINTAI_FACET_HOST.getByName("overseer");

beforeEach(() => {
  seq += 1;
  // The facet reaches the singleton store, named "". Seed that same instance. As in
  // `approval-queue.test.ts`, that means state accumulates across the tests in this file: every
  // employee tag carries `seq`, and the one test that closes a period closes a month of its own.
  store = env.KINTAI_STORE.getByName("");
});

/** A caller's view of their own session: every property access is a forwarded call. */
function sessionFor(accountId: string) {
  const name = `flow-${accountId}-${seq}`;
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callSession(accountId, name, method, args);
    },
  }) as any;
}

/** The Overseer's side of the same facet: the callback that applies a confirmed decision. */
function overseerFor(accountId: string) {
  const name = `flow-${accountId}-${seq}`;
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callFacet(accountId, name, method, args);
    },
  }) as any;
}

/** The id of the decision most recently submitted to the approval queue. */
async function lastStagedAction(): Promise<number> {
  const { actions } = await host.readQueue();
  return actions.at(-1)!.action;
}

async function linkedEmployee(tag: string, extra: Record<string, unknown> = {}) {
  const employeeId = await store.createEmployee({
    employeeNumber: `${tag}-${seq}`,
    displayName: tag,
    joinedOn: "2026-04-01",
    ...extra,
  });
  const accountId = `acct-${tag}-${seq}`;
  await store.linkAccount(accountId, employeeId, Date.now());
  return { employeeId, accountId };
}

/**
 * A route scoped to `DEPT`, and the reason it is scoped.
 *
 * A route created with no department ties the catch-all route `applySchema` seeds — same
 * specificity, same minute floor — and `selectRoute` keeps the lowest id on an exact tie, which is
 * the seeded one. An unscoped test route therefore silently exercises the seed instead of itself.
 * Every employee below is created in `DEPT` so that the filing resolves to THIS route.
 */
async function departmentRoute() {
  await store.createRoute({
    name: `flow-route-${seq}`,
    department: DEPT,
    steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
  });
}

/** A worker in `DEPT` with one manager, a route, and one clock-in on `DAY`. */
async function workerWithManager(tag: string) {
  const { employeeId: boss, accountId: bossAccount } = await linkedEmployee(`${tag}-boss`);
  const { employeeId: worker, accountId: workerAccount } =
    await linkedEmployee(`${tag}-worker`, { department: DEPT });
  await store.setReportingLine(worker, boss, 0);
  await departmentRoute();
  return { boss, bossAccount, worker, workerAccount };
}

/** Play the Overseer: confirm and apply the decision the session has just staged. */
async function confirmLastDecision(accountId: string) {
  await overseerFor(accountId).applyAction(await lastStagedAction());
}

describe("the forgotten clock-out, from request to corrected day", () => {
  it("adds the punch nobody made, once the manager has approved it", async () => {
    const { boss, bossAccount, worker, workerAccount } = await workerWithManager("add");
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const workerSession = sessionFor(workerAccount);

    // The day as the employee finds it: clocked in, never out, so nothing is credited at all.
    const before = await workerSession.getDay(DAY);
    expect(before.anomalies).toEqual(["unpaired_in"]);
    expect(before.reconciliation.workedMinutes).toBe(0);

    const submissionId = await workerSession.requestMissingPunch(
      DAY, "out", SIX_PM, "forgot to clock out",
    );

    // A REQUEST, NOT AN EDIT, and this is the assertion `types.txt` rests on: an agent asked to
    // "fix my clock-out" must not report success over something nobody has decided.
    const filed = await workerSession.getDay(DAY);
    expect(filed.anomalies).toEqual(["unpaired_in"]);
    expect(filed.punches).toHaveLength(1);
    expect((await store.getSubmission(submissionId)).state).toBe("pending");
    expect(await store.getAmendment(submissionId)).toMatchObject({
      target_punch_id: null, work_date: DAY, kind: "out", occurred_at: SIX_PM,
      applied_punch_id: null,
    });

    // It reaches the manager's queue as an ordinary pending submission, because it IS one.
    const queue = await sessionFor(bossAccount).listPendingApprovals();
    expect(queue.map((row: { id: number }) => row.id)).toContain(submissionId);
    expect(queue.find((row: { id: number }) => row.id === submissionId)).toMatchObject({
      kind: "amendment", employee_id: worker, minutes: 0, calculation_inputs: null,
    });

    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve", "checked the site log");
    await confirmLastDecision(bossAccount);

    const after = await workerSession.getDay(DAY);
    expect(after.anomalies).toEqual([]);
    expect(after.reconciliation.workedMinutes).toBe(540);
    const added = after.punches.find((row: { kind: string }) => row.kind === "out")!;
    // Not a punch anybody tapped, and the record says so. `amended_by` is the APPROVER: whose
    // authority admitted the row to payroll, not who asked for it.
    expect(added).toMatchObject({
      source: "amendment", occurred_at: SIX_PM, amended_by: boss,
      amend_reason: "forgot to clock out", supersedes_id: null,
    });
    // The link from the request to what it wrote.
    expect(await store.getAmendment(submissionId))
      .toMatchObject({ applied_punch_id: added.id });
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
  });

  it("clears a long_span day by correcting the clock-out, which is why this exists", async () => {
    // The case the whole feature is for. `long_span` flags a day reaching fourteen paired hours —
    // almost always a clock-out that arrived hours late — and until this path existed it flagged
    // days nobody could fix.
    const { bossAccount, worker, workerAccount } = await workerWithManager("span");
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const late = await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "out", now: ELEVEN_PM, source: "gadget",
    });
    const workerSession = sessionFor(workerAccount);
    expect((await workerSession.getDay(DAY)).anomalies).toEqual(["long_span"]);

    const submissionId = await workerSession.requestPunchCorrection(
      late, SIX_PM, "left at six; the terminal was tapped when I locked up",
    );
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await confirmLastDecision(bossAccount);

    const after = await workerSession.getDay(DAY);
    expect(after.anomalies).toEqual([]);
    expect(after.reconciliation.workedMinutes).toBe(540);

    // The superseded reading is still there. `punches` is append-only: the day now reads 18:00,
    // and what it said before is permanently readable beside it.
    const history = await store.allPunches(worker, DAY);
    expect(history.filter((row: { kind: string }) => row.kind === "out")).toHaveLength(2);
    const original = history.find((row: { id: number }) => row.id === late)!;
    expect(original.occurred_at).toBe(ELEVEN_PM);
    const correction = history.find(
      (row: { supersedes_id: number | null }) => row.supersedes_id === late,
    )!;
    expect(correction).toMatchObject({ occurred_at: SIX_PM, source: "amendment" });
  });
});

describe("filing on somebody else's behalf", () => {
  it("lets a manager file for a report, and then refuses to let them decide it", async () => {
    // The authority rule the spec calls the one most likely to be quietly lost in a refactor: one
    // person may not both originate a change to payroll input and authorise it. It needs a second
    // approver to be visible at all, which is why this route's step is `any_of` over managers.
    const { boss, bossAccount, worker, workerAccount } = await workerWithManager("behalf");
    const { employeeId: second, accountId: secondAccount } = await linkedEmployee("behalf-second");
    await store.setReportingLine(worker, second, 0);
    const punchId = await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });

    const submissionId = await sessionFor(bossAccount).requestCorrectionFor(
      worker, punchId, NINE - 1_800_000, "he was on site at half eight; I signed him in",
    );

    // Whose punch it is, and whose hand filed it, recorded as two different facts.
    expect(await store.getSubmission(submissionId)).toMatchObject({
      employee_id: worker, created_by: boss, kind: "amendment",
    });

    // The filer cannot decide it, even though they are a manager of the employee and the route
    // step is satisfied by any of them.
    await expect(() => sessionFor(bossAccount).actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
    // Nor dispose of it: the verb does not change the collapse of authority into one person.
    await expect(() => sessionFor(bossAccount).actOnSubmission(submissionId, "reject"))
      .rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
    // The employee themself cannot either — that has always been true.
    await expect(() => sessionFor(workerAccount).actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_SELF_APPROVAL/);

    // The other manager can, and it applies.
    expect(second).not.toBe(boss);
    await sessionFor(secondAccount).actOnSubmission(submissionId, "approve");
    await confirmLastDecision(secondAccount);
    expect((await store.getSubmission(submissionId)).state).toBe("approved");
    expect((await sessionFor(workerAccount).getDay(DAY)).punches[0])
      .toMatchObject({ occurred_at: NINE - 1_800_000, source: "amendment" });
  });

  it("adds a missing punch for a report the same way", async () => {
    const { boss, bossAccount, worker } = await workerWithManager("behalf-add");
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });

    const submissionId = await sessionFor(bossAccount).requestMissingPunchFor(
      worker, DAY, "out", SIX_PM, "he left at six; the terminal was already locked",
    );

    expect(await store.getSubmission(submissionId))
      .toMatchObject({ employee_id: worker, created_by: boss });
    expect(await store.getAmendment(submissionId))
      .toMatchObject({ target_punch_id: null, kind: "out", occurred_at: SIX_PM });
  });

  it("refuses somebody with no authority over the employee", async () => {
    // A peer, not a manager. `KINTAI_NOT_AUTHORIZED` whether or not the punch or the employee
    // exists, so nothing about either is disclosed by asking.
    const { worker } = await workerWithManager("peer");
    const { accountId: peerAccount } = await linkedEmployee("peer-other", { department: DEPT });
    const punchId = await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const peer = sessionFor(peerAccount);

    await expect(() => peer.requestCorrectionFor(worker, punchId, NINE - 60_000, "not mine"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    await expect(() => peer.requestMissingPunchFor(worker, DAY, "out", SIX_PM, "not mine"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    // A punch id that does not exist, and an employee id that does not, answer identically.
    await expect(() => peer.requestCorrectionFor(worker, 999_999, NINE, "not mine"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    await expect(() => peer.requestMissingPunchFor(999_999, DAY, "out", SIX_PM, "nobody"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);

    expect(await store.listSubmissionsFor(worker)).toEqual([]);
    expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
  });

  it("refuses the on-behalf form for the caller's own record", async () => {
    // Authority over another employee is an org edge, and nobody has one to themselves. Filing for
    // yourself is `requestPunchCorrection`, which needs no authority at all — so this is not a
    // gap, it is the two intentions staying distinct at the call site.
    const { worker, workerAccount } = await workerWithManager("self-behalf");
    const punchId = await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });

    await expect(() => sessionFor(workerAccount)
      .requestCorrectionFor(worker, punchId, NINE - 60_000, "mine, the long way round"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    await expect(sessionFor(workerAccount)
      .requestPunchCorrection(punchId, NINE - 60_000, "mine, the short way round"))
      .resolves.toBeGreaterThan(0);
  });

  it("treats reading into a report's record as an observation, and refuses it when shared",
    async () => {
      // Filing for somebody else reaches into a record that is not the caller's own: which punch
      // ids are theirs, what their day already holds. That is the same class of data
      // `listPendingApprovals` protects, so it is authorized the same way — every recorded
      // observer excluded, because `KintaiVerifier` has no members and an observer id cannot be
      // resolved to an employee. Filing for YOURSELF names nobody and stays shareable, exactly as
      // `punch()` and `getDay()` do.
      const { bossAccount, worker } = await workerWithManager("shared");
      const punchId = await store.recordPunch({
        employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
      });
      const verifier = await (await env.KINTAI_VENDOR.createAccount()).getVerifier();
      await overseerFor(bossAccount).addObserver("collab", verifier);
      await host.setShares(["collab"]);

      await expect(() => sessionFor(bossAccount)
        .requestCorrectionFor(worker, punchId, NINE - 60_000, "signed in late"))
        .rejects.toThrow(/OBSERVATION_EXCLUDED/);
      // Refused BEFORE the write, not after it: an observation the Overseer will not authorize has
      // to be able to prevent the filing, or authorizing it decides nothing.
      expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
      await host.setShares([]);
    });
});

describe("what the facet refuses before the store is asked", () => {
  it("refuses a malformed punch kind at the RPC boundary", async () => {
    // TWO LAYERS, and this is the outer one: `@validateRpc()` refuses a value outside `PunchKind`
    // before the method body runs, so the store is never asked. The INNER one — the store's own
    // `assertPunchKind`, which covers in-process callers that cross no RPC boundary — is tested in
    // `__tests__/amendments.test.ts` ("refuses an addition whose kind is not a punch kind inside
    // the store"). Neither makes the other redundant.
    const { workerAccount } = await workerWithManager("kind");
    await expect(() => sessionFor(workerAccount)
      .requestMissingPunch(DAY, "nonsense", SIX_PM, "not a kind"))
      .rejects.toThrow(/capnweb-validate/);
  });

  it("refuses a blank reason and a malformed day", async () => {
    const { workerAccount } = await workerWithManager("input");
    const session = sessionFor(workerAccount);

    await expect(() => session.requestMissingPunch(DAY, "out", SIX_PM, "   "))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    await expect(() => session.requestMissingPunch("2026-02-31", "out", SIX_PM, "no such day"))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);
  });

  it("refuses an occurrence in the future, against the server's own clock", async () => {
    // `now` is `Date.now()` here and is never a parameter, so a Gadget cannot move the bound. A
    // future-dated punch is read as an open shift by `openShiftWorkDate` and can cause a genuine
    // punch to be discarded as a duplicate — the hazard is real, and this is the first path that
    // let a human choose a punch time.
    const { workerAccount } = await workerWithManager("future");
    await expect(() => sessionFor(workerAccount)
      .requestMissingPunch(DAY, "out", Date.now() + 3_600_000, "tomorrow's clock-out"))
      .rejects.toThrow(/KINTAI_FUTURE_OCCURRENCE/);
  });

  it("refuses every one of the four on an account HR has not linked", async () => {
    const session = sessionFor("acct-never-linked-flow");
    for (const call of [
      () => session.requestPunchCorrection(1, NINE, "who am I"),
      () => session.requestMissingPunch(DAY, "out", SIX_PM, "who am I"),
      () => session.requestCorrectionFor(1, 1, NINE, "who am I"),
      () => session.requestMissingPunchFor(1, DAY, "out", SIX_PM, "who am I"),
    ]) {
      await expect(call).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    }
  });
});

describe("a correction is the way through a closed period", () => {
  it("files and applies into a month that is closed for payroll", async () => {
    // The one write in the system allowed into a closed month, and the promise
    // `PeriodLockedError` has been making all along. 2026-05 is a month nothing else in this file
    // touches: a lock leaks into every later test in this shared store.
    const lockedDay = "2026-05-20";
    const nine = Date.parse("2026-05-20T00:00:00Z");
    const { boss, bossAccount, worker, workerAccount } = await workerWithManager("locked");
    const late = await store.recordPunch({
      employeeId: worker, workDate: lockedDay, kind: "out", now: nine + 14 * 3_600_000,
      source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: lockedDay, kind: "in", now: nine, source: "gadget",
    });
    await store.lockPeriod("2026-05", boss, Date.now());

    // The lock is shut to ordinary writes...
    await expect(() => sessionFor(workerAccount).setAllocations(lockedDay, []))
      .rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
    expect((await sessionFor(workerAccount).getDay(lockedDay)).locked).toBe(true);

    // ...and open to a request for approval, which is what a correction is.
    const submissionId = await sessionFor(workerAccount)
      .requestPunchCorrection(late, nine + 9 * 3_600_000, "left at six, tapped out when locking up");
    await sessionFor(bossAccount).actOnSubmission(submissionId, "approve");
    await confirmLastDecision(bossAccount);

    const after = await sessionFor(workerAccount).getDay(lockedDay);
    expect(after.locked).toBe(true);
    expect(after.reconciliation.workedMinutes).toBe(540);
    expect(after.anomalies).toEqual([]);
  });
});
