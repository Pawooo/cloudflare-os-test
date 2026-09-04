import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The admin dashboard's three plain reads, at store level. Every rule they report on is asserted
// elsewhere -- `dayAnomalies`, `workedMinutes` and `periodLock` in their own test files -- so what
// is tested here is only the composition: which days get counted, how they roll up per employee,
// and that a lock on the period reports itself honestly without freezing the numbers beside it.

const DAY = "2026-07-03";
const NINE = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`overview-${seq++}`);
  worker = await store.createEmployee({
    employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01",
  });
});

describe("anomalousDays", () => {
  it("lists exactly the days whose anomaly list is non-empty, with the flags", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    // no out: unpaired_in
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000,
      source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "out",
      now: NINE + 86_400_000 + 8 * 3_600_000, source: "gadget",
    });

    const days = await store.anomalousDays("2026-07");
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      employeeId: worker, displayName: "Yamada", employeeNumber: "W1",
      workDate: DAY, anomalies: ["unpaired_in"],
    });
  });

  it("is bounded to the month it was asked about", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: "2026-06-30", kind: "in", now: NINE - 3 * 86_400_000,
      source: "gadget",
    });
    expect(await store.anomalousDays("2026-07")).toHaveLength(0);
  });
});

describe("monthlyTotals", () => {
  it("sums each employee's month and counts their anomalous days", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "out", now: NINE + 8 * 3_600_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000,
      source: "gadget",
    });
    // day 2 unpaired

    const report = await store.monthlyTotals("2026-07");
    expect(report.period).toBe("2026-07");
    expect(report.locked).toBe(false);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      employeeId: worker, daysWorked: 2, workedMinutes: 480, anomalousDays: 1,
    });
  });

  it("carries the lock, and a total that an approved correction can still change", async () => {
    // "Closed ≠ frozen": a locked month refuses ordinary writes but still admits an approved
    // amendment, and the very next read of `monthlyTotals` has to show what that amendment wrote --
    // there is no stored aggregate to have gone stale. Setup needs a manager (to approve) and a
    // route scoped to a department: an unscoped route ties the seeded catch-all on specificity and
    // `selectRoute` keeps the lower id, which is the seed -- so an unscoped test route would
    // silently exercise the seed instead of itself. Scoping to DEPT, and naming DEPT when filing,
    // is what makes this test's own route the one that actually resolves.
    const DEPT = "OVERVIEW-DEPT";
    const manager = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    const employeeId = await store.createEmployee({
      employeeNumber: "W2", displayName: "Suzuki", joinedOn: "2026-04-01", department: DEPT,
    });
    await store.setReportingLine(employeeId, manager, 0);
    await store.createRoute({
      name: `overview-route-${seq}`,
      department: DEPT,
      steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
    });

    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const outId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE + 8 * 3_600_000, source: "gadget",
    });

    await store.lockPeriod("2026-07", manager, NINE + 20 * 3_600_000);

    const before = await store.monthlyTotals("2026-07");
    expect(before.locked).toBe(true);
    expect(before.rows.find((row: { employeeId: number }) => row.employeeId === employeeId))
      .toMatchObject({ workedMinutes: 480 });

    // The lock refuses an ordinary write against this period...
    await expect(() => store.assertWritable(DAY)).rejects.toThrow(/KINTAI_PERIOD_LOCKED/);

    // ...but a correction, filed and approved, still applies -- the one write the lock never sees.
    const submissionId = await store.fileAmendment({
      employeeId, targetPunchId: outId, occurredAt: NINE + 9 * 3_600_000,
      reason: "left at six; the terminal was tapped when clocking out at five",
      now: NINE + 21 * 3_600_000, department: DEPT, employmentType: null, createdBy: employeeId,
    });
    const state = await store.actOnSubmission({
      submissionId, actorId: manager, action: "approve", now: NINE + 22 * 3_600_000,
    });
    expect(state).toBe("approved");

    const after = await store.monthlyTotals("2026-07");
    expect(after.locked).toBe(true);
    expect(after.rows.find((row: { employeeId: number }) => row.employeeId === employeeId))
      .toMatchObject({ workedMinutes: 540 });
  });
});

describe("employeeDay", () => {
  it("returns the current punches, the flags and the credited minutes of one day", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const day = await store.employeeDay(worker, DAY);
    expect(day.punches).toHaveLength(1);
    expect(day.anomalies).toEqual(["unpaired_in"]);
    expect(day.workedMinutes).toBe(0);
  });
});

describe("assertPeriod at the boundary", () => {
  // `assertPeriod` has no unit-test file of its own -- `assertWorkDate`, its sibling in
  // `input.ts`, has none either; both are exercised only through the callers that reach them
  // (`facet.test.ts`'s "input validation at the boundary", `admin-api.test.ts`'s date tests). This
  // is the equivalent for `assertPeriod`: it is reached here through the readers that call it,
  // `anomalousDays` and `monthlyTotals`, rather than imported and called directly.
  it.each(["2026-13", "2026-1", "banana", "", "2026-00"])(
    "refuses %o as a period", async (period) => {
      await expect(() => store.anomalousDays(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => store.monthlyTotals(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    },
  );

  it("accepts a real calendar month", async () => {
    await expect(store.anomalousDays("2026-07")).resolves.toEqual([]);
    await expect(store.monthlyTotals("2026-07"))
      .resolves.toMatchObject({ period: "2026-07", locked: false, rows: [] });
  });
});
