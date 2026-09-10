import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EmployeeKintaiApi, jstWorkDate } from "../src/kintai.js";

// The employee gadget's first read: one employee's own month, from `store/overview.ts`'s
// `employeeMonth`. It shares `daysWithPunches` and the per-day `workedMinutes`/`dayAnomalies`
// calls with `monthlyTotals` -- nothing here restates a rule that a store test elsewhere already
// covers (`workedMinutes`, `dayAnomalies` and the overtime state machine all have their own test
// files), so what is asserted here is only the composition: which days come back, which employee
// and month they are bounded to, and that a day's own overtime request rides along with it.

const NINE = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST
const DAY_MS = 24 * 60 * 60 * 1000;

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`empmonth-${seq++}`);
  worker = await store.createEmployee({ employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01" });
});

describe("employeeMonth", () => {
  it("returns one row per day the employee has punches in the month, with worked minutes and flags", async () => {
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-03", kind: "in", now: NINE, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-03", kind: "out", now: NINE + 8 * 3_600_000, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000, source: "gadget" }); // unpaired

    const month = await store.employeeMonth(worker, "2026-07");
    expect(month.period).toBe("2026-07");
    expect(month.days).toHaveLength(2);
    expect(month.days[0]).toMatchObject({ workDate: "2026-07-03", workedMinutes: 480, anomalies: [], overtime: null });
    expect(month.days[1]).toMatchObject({ workDate: "2026-07-04", anomalies: ["unpaired_in"], overtime: null });
  });

  it("carries the day's own overtime request state", async () => {
    // A departmented route and a departmented employee: an unscoped test route ties the seeded
    // catch-all on specificity, and `selectRoute` keeps the lower id -- the seed -- so an unscoped
    // route here would silently exercise the seed instead of itself (see `overview.test.ts`'s
    // "carries the lock..." test for the same trap).
    const DEPT = "EMPMONTH-DEPT";
    const manager = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    const departmented = await store.createEmployee({
      employeeNumber: "W2", displayName: "Tanaka", department: DEPT, joinedOn: "2026-04-01",
    });
    await store.setReportingLine(departmented, manager, 0);
    await store.createRoute({
      name: `empmonth-route-${seq}`, department: DEPT,
      steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
    });

    await store.recordPunch({
      employeeId: departmented, workDate: "2026-07-03", kind: "in", now: NINE, source: "gadget",
    });
    await store.recordPunch({
      employeeId: departmented, workDate: "2026-07-03", kind: "out", now: NINE + 8 * 3_600_000,
      source: "gadget",
    });
    // A second punched day with no overtime filed against it -- proves absence reads null, not
    // just that presence reads populated.
    await store.recordPunch({
      employeeId: departmented, workDate: "2026-07-05", kind: "in", now: NINE + 2 * DAY_MS,
      source: "gadget",
    });

    await store.submitOvertime({
      employeeId: departmented, requestedFor: "2026-07-03", minutes: 90,
      reason: "closed out the site", now: NINE + 9 * 3_600_000,
      department: DEPT, employmentType: null,
    });

    const month = await store.employeeMonth(departmented, "2026-07");
    const day3 = month.days.find((day: { workDate: string }) => day.workDate === "2026-07-03");
    const day5 = month.days.find((day: { workDate: string }) => day.workDate === "2026-07-05");
    expect(day3).toMatchObject({ overtime: { minutes: 90, state: "pending" } });
    expect(day5).toMatchObject({ overtime: null });
  });

  it("is bounded to the month and to this employee", async () => {
    const other = await store.createEmployee({
      employeeNumber: "W3", displayName: "Suzuki", joinedOn: "2026-04-01",
    });
    // A June punch for `worker` -- must not appear in the July read.
    await store.recordPunch({
      employeeId: worker, workDate: "2026-06-30", kind: "in", now: NINE - 3 * DAY_MS,
      source: "gadget",
    });
    // A July punch, but for a DIFFERENT employee -- must not appear in `worker`'s July read.
    await store.recordPunch({
      employeeId: other, workDate: "2026-07-03", kind: "in", now: NINE, source: "gadget",
    });

    const month = await store.employeeMonth(worker, "2026-07");
    expect(month.days).toHaveLength(0);
  });
});

describe("employeeMonth pinned against the per-day source", () => {
  // Guards the SHARING, not just the output: `workedMinutes` read one day at a time is the ground
  // truth `monthlyTotals` and `employeeMonth` both derive from. A future `employeeMonth` that
  // computed its own total, even one that agreed today, would pass every other test in this file
  // and only be caught here.
  it("agrees with workedMinutes read one day at a time, for every day it returns", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-03", kind: "in", now: NINE, source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-03", kind: "out", now: NINE + 8 * 3_600_000,
      source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-10", kind: "in", now: NINE + 7 * DAY_MS,
      source: "gadget",
    });
    // day 2 left unpaired on purpose -- the pin has to hold for a flagged day too, not only a
    // clean one.

    const month = await store.employeeMonth(worker, "2026-07");
    expect(month.days.length).toBeGreaterThan(0);
    for (const day of month.days) {
      expect(day.workedMinutes).toBe(await store.workedMinutes(worker, day.workDate));
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The employee capability itself, reached the way the Workshop reaches it: a non-admin's
// `startAppUi` hands back an `EmployeeKintaiApi`, and the iframe can only call what that capability
// carries. Forwarded through `KINTAI_FACET_HOST.callAppUi` exactly as `admin-api.test.ts` does, so
// an authorization or orchestration test genuinely attempts the call through the production
// expression rather than a proxy's idea of it.

const THREE_HOURS = 3 * 60 * 60_000;
const host = env.KINTAI_FACET_HOST.getByName("employee-api-overseer");

/** The capability `startAppUi({ isAdmin: false })` hands the iframe, as a caller sees it. */
function appUi(accountId: string) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callAppUi(accountId, false, method, args);
    },
  }) as any;
}

/** A linked employee in the singleton store the account resolves to. */
async function linkedEmployee(tag: string, extra: Record<string, unknown> = {}) {
  const shared = env.KINTAI_STORE.getByName("");
  const employeeId = await shared.createEmployee({
    employeeNumber: `${tag}-${seq}`, displayName: tag, joinedOn: "2026-04-01", ...extra,
  });
  const accountId = `acct-${tag}-${seq}`;
  await shared.linkAccount(accountId, employeeId, Date.now());
  return { employeeId, accountId, shared };
}

// The two behaviours the SHARED punch orchestration owns, asserted through the employee facet
// rather than the session. Either would still pass if `EmployeeKintaiApi.punch` re-implemented a
// bare insert; both fail unless it runs the same `assertWritable` + `workDateFor` path
// `KintaiSession.punch` runs — which is the whole point of there being one implementation.
describe("the employee punch shares the one orchestration", () => {
  it("refuses a punch that would land in a closed period with KINTAI_PERIOD_LOCKED", async () => {
    // A shift_start employee with an open shift on a past, closed month: the clock-out attributes
    // to the shift's date, which is locked — so it must be refused exactly as an ordinary write
    // into a closed month is. Proves the facet runs `assertWritable`, not a bare `commitPunch`.
    const { employeeId, accountId, shared } = await linkedEmployee("emp-lock", {});
    await shared.setWorkDatePolicy(employeeId, "shift_start");
    const now = Date.now();
    await shared.recordPunch({
      employeeId, workDate: "2026-05-20", kind: "in", now: now - THREE_HOURS, source: "gadget",
    });
    await shared.lockPeriod("2026-05", employeeId, now);

    await expect(() => appUi(accountId).punch("out")).rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
    // Nothing was written, into the closed month or onto today.
    expect(await shared.currentPunches(employeeId, "2026-05-20")).toHaveLength(1);
    expect(await shared.currentPunches(employeeId, jstWorkDate(Date.now()))).toEqual([]);
  });

  it("attributes a shift_start employee's overnight punch to the shift's date", async () => {
    // The clock-out lands on the OPEN shift's start date, not on the calendar date it happened on.
    // Proves the facet runs `workDateFor` against the employee the capability resolves to.
    const { employeeId, accountId, shared } = await linkedEmployee("emp-shift", {});
    await shared.setWorkDatePolicy(employeeId, "shift_start");
    const now = Date.now();
    const shiftDate = jstWorkDate(now - 26 * 60 * 60_000); // never today, whatever time the suite runs
    await shared.recordPunch({
      employeeId, workDate: shiftDate, kind: "in", now: now - THREE_HOURS, source: "gadget",
    });

    const out = await appUi(accountId).punch("out");

    expect(out.workDate).toBe(shiftDate);
    expect(out.workDate).not.toBe(jstWorkDate(Date.now()));
    expect(out.employeeId).toBe(employeeId);
    expect(await shared.currentPunches(employeeId, shiftDate)).toHaveLength(2);
  });
});

/** The names a caller can actually invoke on `cls` over RPC. */
function callableSurface(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter((name) => name !== "constructor")
    .toSorted();
}

// The surface pin. `EmployeeKintaiApi` is a concrete class with no throw-with-interface twin (a
// non-admin is who this capability is FOR, so there is no "employee viewer" to refuse) — but the
// callable surface still has to be written down, because a public method added to it is callable
// over RPC and `@validateRpc()` does not narrow that away. This is the parallel of admin-api.test's
// "exposes exactly the interface".
describe("the employee capability's surface", () => {
  const EXPECTED = [
    "getDay", "listMySubmissions", "myMonth", "punch", "requestMissingPunch",
    "requestPunchCorrection", "resubmit", "setLanguage", "whoAmI", "withdrawSubmission",
  ];

  it("exposes exactly its own methods, and nothing more", () => {
    expect(callableSurface(EmployeeKintaiApi)).toEqual(EXPECTED.toSorted());
  });

  // The exclusions that matter, named so a regression is loud. The approval queue and the
  // management surface belong to `KintaiSession` and `AdminKintaiApi`; the on-behalf `...For`
  // filings are the session's, gated by the org chart. None may ride in on the employee capability.
  it("exposes none of the approval, management or on-behalf methods", () => {
    const surface = callableSurface(EmployeeKintaiApi);
    for (const forbidden of [
      "listPendingApprovals", "actOnSubmission",
      "requestCorrectionFor", "requestMissingPunchFor",
      "setAllocations", "submitOvertime",
      // A sample of the admin surface: a non-admin holds a different class entirely, so none of
      // these exists here.
      "linkAccount", "lockPeriod", "listEmployees", "createEmployee", "getEmployeeDay",
      "listPendingOverview", "monthlyReport", "setWorkDatePolicy",
    ]) {
      expect(surface, forbidden).not.toContain(forbidden);
    }
    // And nothing on-behalf by shape either: no `...For` method may appear.
    expect(surface.filter((name) => name.endsWith("For"))).toEqual([]);
  });
});

// The other half of the pin: what the two reads hand the browser. A method that starts returning
// more fields widens this surface without touching a name, so the keys are written out and compared
// by CALLING each read, as admin-api.test does.
describe("the shapes the employee reads hand back", () => {
  it("getDay returns exactly its five keys", async () => {
    const { employeeId, accountId, shared } = await linkedEmployee("emp-getday", {});
    const now = Date.now();
    await shared.recordPunch({
      employeeId, workDate: jstWorkDate(now), kind: "in", now, source: "gadget",
    });

    const day = await appUi(accountId).getDay(jstWorkDate(now));
    expect(Object.keys(day).toSorted())
      .toEqual(["allocations", "anomalies", "locked", "punches", "reconciliation"]);
    expect(day.punches.length).toBeGreaterThan(0);
  });

  it("myMonth returns the period and one written-out day shape per punched day", async () => {
    const { employeeId, accountId, shared } = await linkedEmployee("emp-mymonth", {});
    // A fixed, past month of this employee's own, so the shape is deterministic whatever day the
    // suite runs — and one this employee alone punches into, so it is theirs to read.
    const nine = Date.parse("2026-07-03T00:00:00Z");
    await shared.recordPunch({
      employeeId, workDate: "2026-07-03", kind: "in", now: nine, source: "gadget",
    });
    await shared.recordPunch({
      employeeId, workDate: "2026-07-03", kind: "out", now: nine + 8 * 3_600_000, source: "gadget",
    });

    const month = await appUi(accountId).myMonth("2026-07");
    expect(Object.keys(month).toSorted()).toEqual(["days", "period"]);
    expect(month.period).toBe("2026-07");
    expect(month.days.length).toBeGreaterThan(0);
    for (const day of month.days) {
      expect(Object.keys(day).toSorted())
        .toEqual(["anomalies", "overtime", "workDate", "workedMinutes"]);
    }
    expect(month.days.find((d: { workDate: string }) => d.workDate === "2026-07-03"))
      .toMatchObject({ workedMinutes: 480 });
  });

  it("resolves myMonth to the employee the capability names, not an argument", async () => {
    // No method here takes an employee id: the month read is bounded to whoever the account
    // resolves to. A second employee's punches in the same month are invisible.
    const { accountId } = await linkedEmployee("emp-scope", {});
    const { employeeId: other, shared } = await linkedEmployee("emp-scope-other", {});
    const nine = Date.parse("2026-07-15T00:00:00Z");
    await shared.recordPunch({
      employeeId: other, workDate: "2026-07-15", kind: "in", now: nine, source: "gadget",
    });

    const mine = await appUi(accountId).myMonth("2026-07");
    expect(mine.days).toEqual([]);
  });

  it("still answers whoAmI, which is how an employee reads their code for HR", async () => {
    const accountId = `acct-emp-unlinked-${seq}`;
    expect(await appUi(accountId).whoAmI())
      .toEqual({ accountId, linked: false, employeeId: null, language: null });
  });
});

// The employee-facing twin of `AdminKintaiApi.setLanguage`, exercised through the capability a
// non-admin actually holds. Identity comes from the capability, never an argument, and an
// unlinked account may still choose a language — see the doc comment on `EmployeeKintaiApi.
// setLanguage`.
describe("setLanguage", () => {
  it("is null on a fresh account, until chosen", async () => {
    const accountId = `acct-emp-lang-${seq}`;

    expect((await appUi(accountId).whoAmI()).language).toBeNull();
  });

  it("records the caller's choice, read back on whoAmI, even unlinked", async () => {
    const accountId = `acct-emp-lang-set-${seq}`;

    expect(await appUi(accountId).setLanguage("ja")).toBeUndefined();

    expect((await appUi(accountId).whoAmI()).language).toBe("ja");
  });

  // Refused by `@validateRpc()`, the literal union, before the method body -- and so before any
  // write -- exactly as `setWorkDatePolicy` is pinned in `admin-api.test.ts`.
  it("refuses anything but the two literals, before any write", async () => {
    const accountId = `acct-emp-lang-refuse-${seq}`;

    await expect(() => appUi(accountId).setLanguage("fr"))
      .rejects.toThrow(/capnweb-validate.*setLanguage\[0\]: expected union/);

    expect(await env.KINTAI_STORE.getByName("").languageFor(accountId)).toBeNull();
  });

  it("is scoped to the caller's own account, and never another's", async () => {
    const mine = `acct-emp-lang-mine-${seq}`;
    const theirs = `acct-emp-lang-theirs-${seq}`;

    await appUi(mine).setLanguage("ja");

    expect((await appUi(theirs).whoAmI()).language).toBeNull();
  });

  // The OS's "system" arrives here as null — see `EmployeeKintaiApi.setLanguage`'s doc comment
  // for why forgetting has to be a real state and not just "never chosen yet" reused.
  it("forgets a previous choice when set to null, and whoAmI reports null again", async () => {
    const accountId = `acct-emp-lang-forget-${seq}`;

    await appUi(accountId).setLanguage("ja");
    expect((await appUi(accountId).whoAmI()).language).toBe("ja");

    expect(await appUi(accountId).setLanguage(null)).toBeUndefined();

    expect((await appUi(accountId).whoAmI()).language).toBeNull();
  });

  it("setting null on an account with no saved choice is a no-op that still succeeds", async () => {
    const accountId = `acct-emp-lang-forget-noop-${seq}`;

    expect(await appUi(accountId).setLanguage(null)).toBeUndefined();

    expect((await appUi(accountId).whoAmI()).language).toBeNull();
  });
});
