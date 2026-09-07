import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
