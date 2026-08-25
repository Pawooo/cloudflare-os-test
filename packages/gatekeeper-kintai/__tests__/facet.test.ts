import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { jstWorkDate } from "../src/kintai.js";

// The facet reads the shared store; tests seed through the store directly, then act through the
// facet exactly as Gadget code would.
//
// Reaching the facet: props are bound to the CLASS, never to a name. `getByName` takes a name
// only — it has no props parameter — so a test cannot mint an imbued facet from `env` alone.
// `KINTAI_FACET_HOST` is a test-only Durable Object (see `__tests__/worker.ts`) standing in for the
// Overseer: it performs the exact production expression,
// `ctx.facets.get(name, () => ({ class: ctx.exports.KintaiGatekeeper({ props: { accountId } }) }))`,
// and hands back the resulting stub.
let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  seq += 1;
  // The facet reaches the singleton store, named "". Seed that same instance.
  store = env.KINTAI_STORE.getByName("");
});

/**
 * A caller's view of their own facet. Every property access becomes a forwarded call, so the
 * facet's real signature — not a hand-written proxy's — is what any argument has to get past.
 */
function facetFor(accountId: string) {
  const host = env.KINTAI_FACET_HOST.getByName("overseer");
  const name = `facet-${accountId}-${seq}`;
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      // Not a thenable: `await facetFor(...)` must not resolve this proxy into a call to `then`.
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callFacet(accountId, name, method, args);
    },
  }) as any;
}

/** An employee plus a linked account capability, the normal starting state for a Gadget caller. */
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

/** A minimal manager-approval route, needed before any overtime can be filed. */
async function managerRoute() {
  await store.createRoute({
    name: `route-${seq}`,
    steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
  });
}

describe("identity resolution", () => {
  it("reports the linked employee", async () => {
    const { employeeId, accountId } = await linkedEmployee("tanaka");

    const facet = facetFor(accountId);
    const me = await facet.whoAmI();

    expect(me.linked).toBe(true);
    expect(me.employeeId).toBe(employeeId);
  });

  it("reports an unlinked account rather than throwing, so the UI can explain it", async () => {
    const facet = facetFor("acct-never-linked");
    const me = await facet.whoAmI();

    expect(me.linked).toBe(false);
    expect(me.employeeId).toBeNull();
  });

  it("resolves the account that is open right now, not one that has been re-pointed away", async () => {
    const { employeeId, accountId } = await linkedEmployee("moved");
    const other = await store.createEmployee({
      employeeNumber: `moved-other-${seq}`, displayName: "Other", joinedOn: "2026-04-01",
    });
    // An email change re-points the account at a different employee record.
    await store.linkAccount(accountId, other, Date.now());

    const facet = facetFor(accountId);
    expect((await facet.whoAmI()).employeeId).toBe(other);
    expect((await facet.whoAmI()).employeeId).not.toBe(employeeId);
  });

  it("refuses every operation other than whoAmI for an unlinked account", async () => {
    const facet = facetFor("acct-also-never-linked");

    // Thunk form throughout: the direct form races the DO's error reporting.
    await expect(() => facet.punch("in")).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.getDay("2026-07-03")).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.setAllocations("2026-07-03", []))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.submitOvertime("2026-07-03", 60, "x"))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.listMySubmissions()).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.listPendingApprovals()).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.withdrawSubmission(1)).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.resubmit(1)).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
    await expect(() => facet.actOnSubmission(1, "approve"))
      .rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
  });
});

describe("punching through the facet", () => {
  it("records a punch against the caller's own employee record", async () => {
    const { employeeId, accountId } = await linkedEmployee("ito");

    const facet = facetFor(accountId);
    const result = await facet.punch("in");

    expect(result.punchId).toEqual(expect.any(Number));
    expect(result.employeeId).toBe(employeeId);
    expect(result.workDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const punches = await store.currentPunches(employeeId, result.workDate);
    expect(punches).toHaveLength(1);
    expect(punches[0].source).toBe("gadget");
  });

  it("carries the location through to the punch record", async () => {
    const { employeeId, accountId } = await linkedEmployee("loc");

    const facet = facetFor(accountId);
    const result = await facet.punch("in", { source: "gps", latitude: 35.68, longitude: 139.76 });

    const punches = await store.currentPunches(employeeId, result.workDate);
    expect(punches[0].location_source).toBe("gps");
    expect(punches[0].latitude).toBeCloseTo(35.68);
  });
});

describe("the day view", () => {
  it("surfaces punches, allocations, reconciliation, anomalies and the lock state", async () => {
    const { employeeId, accountId } = await linkedEmployee("day");
    const workDate = "2026-07-03";
    const morning = Date.parse("2026-07-03T00:00:00Z");
    await store.recordPunch({
      employeeId, workDate, kind: "in", now: morning, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate, kind: "out", now: morning + 8 * 3_600_000, source: "gadget",
    });
    await store.setAllocations(employeeId, workDate, [{ projectCode: "P1", minutes: 480 }]);

    const facet = facetFor(accountId);
    const day = await facet.getDay(workDate);

    expect(day.punches).toHaveLength(2);
    expect(day.allocations).toHaveLength(1);
    expect(day.reconciliation.workedMinutes).toBe(480);
    expect(day.reconciliation.discrepancyMinutes).toBe(0);
    expect(day.anomalies).toEqual([]);
    expect(day.locked).toBe(false);
  });

  it("reports anomalies for an unpaired punch", async () => {
    const { employeeId, accountId } = await linkedEmployee("anom");
    const workDate = "2026-07-04";
    await store.recordPunch({
      employeeId, workDate, kind: "in", now: Date.parse("2026-07-04T00:00:00Z"), source: "gadget",
    });

    const facet = facetFor(accountId);
    const day = await facet.getDay(workDate);

    expect(day.anomalies.length).toBeGreaterThan(0);
  });
});

describe("allocations through the facet", () => {
  it("writes against the caller's own employee record", async () => {
    const { employeeId, accountId } = await linkedEmployee("alloc");
    const workDate = "2026-07-06";

    const facet = facetFor(accountId);
    const reconciliation = await facet.setAllocations(
      workDate, [{ projectCode: "P1", minutes: 120 }],
    );

    expect(reconciliation.allocatedMinutes).toBe(120);
    const rows = await store.currentAllocations(employeeId, workDate);
    expect(rows.map((row) => row.employee_id)).toEqual([employeeId]);
  });

  it("refuses to write into a closed period", async () => {
    const { employeeId, accountId } = await linkedEmployee("alloc-locked");
    await store.lockPeriod("2026-06", employeeId, Date.now());

    const facet = facetFor(accountId);
    await expect(() => facet.setAllocations("2026-06-10", [{ projectCode: "P1", minutes: 60 }]))
      .rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
  });
});

describe("overtime through the facet", () => {
  it("files for the caller and records them as the filer", async () => {
    const { employeeId, accountId } = await linkedEmployee("ot");
    const boss = await store.createEmployee({
      employeeNumber: `ot-boss-${seq}`, displayName: "Boss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(employeeId, boss, 0);
    await managerRoute();

    const facet = facetFor(accountId);
    const submissionId = await facet.submitOvertime("2026-07-03", 60, "release");

    const row = await store.getSubmission(submissionId);
    expect(row.employee_id).toBe(employeeId);
    // Not null: the audit trail must be able to answer "who filed this?" on the normal path.
    expect(row.created_by).toBe(employeeId);
  });

  it("lists only the caller's own submissions", async () => {
    const { employeeId: mine, accountId } = await linkedEmployee("mine");
    const theirs = await store.createEmployee({
      employeeNumber: `theirs-${seq}`, displayName: "Theirs", joinedOn: "2026-04-01",
    });
    const boss = await store.createEmployee({
      employeeNumber: `boss-${seq}`, displayName: "Boss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(mine, boss, 0);
    await store.setReportingLine(theirs, boss, 0);
    await managerRoute();
    await store.submitOvertime({
      employeeId: theirs, requestedFor: "2026-07-03", minutes: 60,
      reason: "theirs", now: Date.now(), department: null, employmentType: null,
    });

    const facet = facetFor(accountId);
    await facet.submitOvertime("2026-07-03", 60, "mine");

    const listed = await facet.listMySubmissions();
    expect(listed).toHaveLength(1);
    expect(listed[0].employee_id).toBe(mine);
  });

  it("withdraws and resubmits only the caller's own submissions", async () => {
    const { employeeId: mine, accountId } = await linkedEmployee("wd");
    const boss = await store.createEmployee({
      employeeNumber: `wd-boss-${seq}`, displayName: "Boss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(mine, boss, 0);
    await managerRoute();

    const facet = facetFor(accountId);
    const submissionId = await facet.submitOvertime("2026-07-03", 60, "mine");
    await facet.withdrawSubmission(submissionId);

    expect((await store.getSubmission(submissionId)).state).toBe("withdrawn");
  });
});

describe("approvals through the facet", () => {
  it("derives the approval queue from the org graph, never from a caller's claim", async () => {
    const { employeeId: boss, accountId } = await linkedEmployee("mgr");
    const reportee = await store.createEmployee({
      employeeNumber: `mgr-report-${seq}`, displayName: "Report", joinedOn: "2026-04-01",
    });
    const stranger = await store.createEmployee({
      employeeNumber: `mgr-stranger-${seq}`, displayName: "Stranger", joinedOn: "2026-04-01",
    });
    const otherBoss = await store.createEmployee({
      employeeNumber: `mgr-other-${seq}`, displayName: "OtherBoss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(reportee, boss, 0);
    await store.setReportingLine(stranger, otherBoss, 0);
    await managerRoute();

    const now = Date.now();
    const mineToApprove = await store.submitOvertime({
      employeeId: reportee, requestedFor: "2026-07-03", minutes: 60,
      reason: "reportee", now, department: null, employmentType: null,
    });
    await store.submitOvertime({
      employeeId: stranger, requestedFor: "2026-07-03", minutes: 60,
      reason: "stranger", now, department: null, employmentType: null,
    });

    const facet = facetFor(accountId);
    const pending = await facet.listPendingApprovals();

    expect(pending.map((row) => row.id)).toEqual([mineToApprove]);
  });

  it("acts as the caller, so self-approval is impossible", async () => {
    const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("act-boss");
    const { employeeId: worker, accountId: workerAccount } = await linkedEmployee("act-worker");
    await store.setReportingLine(worker, boss, 0);
    await managerRoute();

    const workerFacet = facetFor(workerAccount);
    const submissionId = await workerFacet.submitOvertime("2026-07-03", 60, "mine");

    // The worker cannot approve their own request: the actor comes from their own capability.
    await expect(() => workerFacet.actOnSubmission(submissionId, "approve"))
      .rejects.toThrow(/KINTAI_SELF_APPROVAL/);

    const bossFacet = facetFor(bossAccount);
    expect(await bossFacet.actOnSubmission(submissionId, "approve")).toBe("approved");
  });
});

// The authorization property this whole package exists to hold. `submitOvertime` and friends take
// an `employeeId` as free input at the STORE layer; the binding of that input to the authenticated
// principal lives entirely in the facet. An employee can rewrite their own Gadget's code at will,
// so the only defence is that there is nowhere in the facet's surface to put someone else's id.
describe("the authorization property", () => {
  it("cannot be induced to file or act on behalf of another employee", async () => {
    const { employeeId: attacker, accountId } = await linkedEmployee("attacker");
    const victim = await store.createEmployee({
      employeeNumber: `victim-${seq}`, displayName: "Victim", joinedOn: "2026-04-01",
    });
    const boss = await store.createEmployee({
      employeeNumber: `atk-boss-${seq}`, displayName: "Boss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(attacker, boss, 0);
    await store.setReportingLine(victim, boss, 0);
    await managerRoute();

    const victimSubmission = await store.submitOvertime({
      employeeId: victim, requestedFor: "2026-07-03", minutes: 60,
      reason: "victim", now: Date.now(), department: null, employmentType: null,
    });
    const victimBefore = await store.listSubmissionsFor(victim);

    const facet = facetFor(accountId);

    // 1. Smuggling an employee id as a trailing argument changes nothing: the facet's methods take
    //    no employee parameter, so the extra value is either rejected outright or discarded.
    let filed: number | null = null;
    try {
      filed = await (facet as unknown as {
        submitOvertime(
          requestedFor: string, minutes: number, reason: string, employeeId: number,
        ): Promise<number>;
      }).submitOvertime("2026-07-03", 30, "smuggled", victim);
    } catch {
      // Rejected by RPC argument validation — equally acceptable.
    }
    if (filed !== null) {
      const row = await store.getSubmission(filed);
      expect(row.employee_id).toBe(attacker);
      expect(row.created_by).toBe(attacker);
    }
    expect(await store.listSubmissionsFor(victim)).toEqual(victimBefore);

    // 2. Naming the victim's submission id does not grant control over it.
    await expect(() => facet.withdrawSubmission(victimSubmission))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    await expect(() => facet.resubmit(victimSubmission))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    // The attacker is a peer, not the victim's manager, so they cannot approve it either.
    await expect(() => facet.actOnSubmission(victimSubmission, "approve"))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);

    // 3. Reads stay scoped to the capability.
    expect(await facet.listMySubmissions())
      .toEqual((await store.listSubmissionsFor(attacker)));
    expect((await facet.listPendingApprovals()).map((row) => row.id)).toEqual([]);
    expect((await store.getSubmission(victimSubmission)).state).toBe("pending");
  });

  it("binds punches and allocations to the capability, not to any argument", async () => {
    const { employeeId: attacker, accountId } = await linkedEmployee("atk2");
    const victim = await store.createEmployee({
      employeeNumber: `victim2-${seq}`, displayName: "Victim", joinedOn: "2026-04-01",
    });
    const workDate = "2026-07-08";

    const facet = facetFor(accountId);
    await facet.setAllocations(workDate, [{ projectCode: "P1", minutes: 60 }]);
    const punch = await facet.punch("in");

    expect(await store.currentAllocations(victim, workDate)).toEqual([]);
    expect(await store.currentPunches(victim, punch.workDate)).toEqual([]);
    expect(await store.currentAllocations(attacker, workDate)).toHaveLength(1);
  });
});

describe("input validation at the boundary", () => {
  it("rejects a malformed or impossible work date rather than writing junk", async () => {
    const { accountId } = await linkedEmployee("junk");
    const facet = facetFor(accountId);

    for (const bad of ["banana", "2026-7-3", "2026-07-03T00:00:00Z", "", "2026-02-31", "2026-13-01"]) {
      await expect(() => facet.getDay(bad)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => facet.setAllocations(bad, [])).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => facet.submitOvertime(bad, 60, "x"))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    }
  });

  it("rejects minutes that are negative or fractional", async () => {
    const { accountId } = await linkedEmployee("mins");
    const facet = facetFor(accountId);

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(() => facet.submitOvertime("2026-07-03", bad, "x"))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => facet.setAllocations("2026-07-03", [{ projectCode: "P1", minutes: bad }]))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    }
  });

  it("nothing is written when validation rejects", async () => {
    const { employeeId, accountId } = await linkedEmployee("novalid");
    const facet = facetFor(accountId);

    await expect(() => facet.setAllocations("2026-02-31", [{ projectCode: "P1", minutes: 60 }]))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);

    expect(await store.currentAllocations(employeeId, "2026-02-31")).toEqual([]);
    expect(await store.currentAllocations(employeeId, "2026-03-02")).toEqual([]);
    expect(await store.listSubmissionsFor(employeeId)).toEqual([]);
  });
});

// The oracle the Task 12 review found: `InvalidTransitionError` names the state it refused, so
// checking state before authority let any Gadget walk the id space and read back every
// submission's state. `withdrawSubmission` and `resubmit` already ordered ownership before state
// for exactly this reason; `actOnSubmission` now matches them.
describe("actOnSubmission discloses nothing before authority is established", () => {
  it("tells a stranger nothing about another employee's submission, in any state", async () => {
    const { accountId: strangerAccount } = await linkedEmployee("probe-stranger");
    const { employeeId: worker } = await linkedEmployee("probe-worker");
    const { employeeId: boss, accountId: bossAccount } = await linkedEmployee("probe-boss");
    await store.setReportingLine(worker, boss, 0);
    await managerRoute();

    const now = Date.now();
    // One submission per terminal state, so the probe covers every branch of the state machine.
    const pending = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 60,
      reason: "pending", now, department: null, employmentType: null,
    });
    const rejected = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-04", minutes: 60,
      reason: "rejected", now, department: null, employmentType: null,
    });
    const withdrawn = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-05", minutes: 60,
      reason: "withdrawn", now, department: null, employmentType: null,
    });
    const returned = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-06", minutes: 60,
      reason: "returned", now, department: null, employmentType: null,
    });
    await store.actOnSubmission({ submissionId: rejected, actorId: boss, action: "reject", now });
    await store.withdrawSubmission(withdrawn, worker);
    await store.actOnSubmission({ submissionId: returned, actorId: boss, action: "return", now });

    // Every state answers with the SAME error, so the response carries no information.
    const stranger = facetFor(strangerAccount);
    for (const id of [pending, rejected, withdrawn, returned]) {
      await expect(() => stranger.actOnSubmission(id, "approve"))
        .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
      await expect(() => stranger.actOnSubmission(id, "approve"))
        .rejects.not.toThrow(/KINTAI_INVALID_TRANSITION/);
    }

    // The real approver still gets the informative error, because they have authority to act.
    const bossFacet = facetFor(bossAccount);
    await expect(() => bossFacet.actOnSubmission(rejected, "approve"))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
    // ...and the pending one still works for them.
    expect(await bossFacet.actOnSubmission(pending, "approve")).toBe("approved");
  });
});

// `jstWorkDate` is exported and pure, and it decides which day every punch lands on. Pinned as a
// table so a later "simplification" to a local-time or Intl-based implementation has to reproduce
// these exactly. Verified independently against `Intl.DateTimeFormat` for `Asia/Tokyo`.
describe("jstWorkDate", () => {
  const cases: [string, string][] = [
    // Midnight UTC is 09:00 JST the same day.
    ["2026-07-03T00:00:00.000Z", "2026-07-03"],
    // The last instant of the JST day: 14:59:59.999Z is 23:59:59.999 JST.
    ["2026-07-03T14:59:59.999Z", "2026-07-03"],
    // ...and one millisecond later the JST day rolls over.
    ["2026-07-03T15:00:00.000Z", "2026-07-04"],
    // Year rollover happens at 15:00Z on 31 December, not at midnight UTC.
    ["2025-12-31T14:59:59.999Z", "2025-12-31"],
    ["2025-12-31T15:00:00.000Z", "2026-01-01"],
    // Leap day, and the day after it.
    ["2028-02-28T15:00:00.000Z", "2028-02-29"],
    ["2028-02-29T15:00:00.000Z", "2028-03-01"],
    // The epoch, as a lower-bound sanity check.
    ["1970-01-01T00:00:00.000Z", "1970-01-01"],
  ];

  it.each(cases)("maps %s to %s", (instant, expected) => {
    expect(jstWorkDate(Date.parse(instant))).toBe(expected);
  });

  it("agrees with Intl for Asia/Tokyo across a year of daily samples", () => {
    // JST has no DST, so this is a fixed +9h offset — but that is the claim under test, not an
    // assumption, so it is checked against the platform's own tz database.
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    });
    for (let day = 0; day < 365; day++) {
      // 15:00Z sits exactly on the JST day boundary, the worst case for an off-by-one.
      const instant = Date.parse("2026-01-01T15:00:00.000Z") + day * 86_400_000;
      expect(jstWorkDate(instant)).toBe(format.format(new Date(instant)));
    }
  });
});

// MUST BE LAST IN THIS FILE. Every facet reaches the one store named "", and this file therefore
// shares a single store across all of its tests (the pool provides no per-test storage isolation —
// the other suites work around it by using a fresh store name per test, which a facet cannot do).
// `punch` derives its work date from the wall clock, so the only way to exercise its lock check is
// to close the live period, and there is no unlock anywhere in this package.
describe("period locks close the live period, irreversibly", () => {
  it("refuses to punch into a closed period", async () => {
    const { employeeId, accountId } = await linkedEmployee("locked");
    const facet = facetFor(accountId);
    const workDate = (await facet.punch("in")).workDate;

    await store.lockPeriod(workDate.slice(0, 7), employeeId, Date.now());

    await expect(() => facet.punch("out")).rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
    // The read path stays open: a closed period is still viewable, just not writable.
    expect((await facet.getDay(workDate)).locked).toBe(true);
  });
});
