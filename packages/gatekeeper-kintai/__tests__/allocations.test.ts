import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NINE_AM = Date.parse("2026-07-03T00:00:00Z");
const SIX_PM = Date.parse("2026-07-03T09:00:00Z");
const DAY = "2026-07-03";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`alloc-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E800", displayName: "Ito", joinedOn: "2026-04-01",
  });
  await store.recordPunch({
    employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
  });
  await store.recordPunch({
    employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
  });
});

describe("setAllocations", () => {
  it("stores entries and reports a balanced day as zero discrepancy", async () => {
    const result = await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 300 },
      { projectCode: "INTERNAL", minutes: 240 },
    ]);

    expect(result.workedMinutes).toBe(540);
    expect(result.allocatedMinutes).toBe(540);
    expect(result.discrepancyMinutes).toBe(0);
    expect(await store.currentAllocations(employeeId, DAY)).toHaveLength(2);
  });

  it("stores an unbalanced day rather than rejecting it", async () => {
    const result = await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 120 },
    ]);

    // People fill these in imperfectly. A system that refuses imperfect input does not get
    // filled in, so the discrepancy is recorded and surfaced instead.
    expect(result.discrepancyMinutes).toBe(-420);
    expect(await store.currentAllocations(employeeId, DAY)).toHaveLength(1);
  });

  it("supersedes the previous version rather than deleting it", async () => {
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "FIRST-GUESS", minutes: 540 },
    ]);
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "CORRECTED", minutes: 540 },
    ]);

    const current = await store.currentAllocations(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0].project_code).toBe("CORRECTED");
    expect(current[0].version).toBe(2);

    // The superseded row is still on disk.
    const all = await store.allAllocations(employeeId, DAY);
    expect(all).toHaveLength(2);
    expect(all.some((a) => a.project_code === "FIRST-GUESS")).toBe(true);
  });

  it("keeps version numbers monotonic when a prior version had multiple rows", async () => {
    // First version writes two rows sharing version 1.
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 300 },
      { projectCode: "INTERNAL", minutes: 240 },
    ]);
    // Second version replaces both with a single row.
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "CORRECTED", minutes: 540 },
    ]);

    const current = await store.currentAllocations(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0].version).toBe(2);

    const all = await store.allAllocations(employeeId, DAY);
    expect(all).toHaveLength(3);
    expect(all.filter((a) => a.version === 1)).toHaveLength(2);
    expect(all.every((a) => a.version === 1 ? a.superseded_by !== null : a.superseded_by === null))
      .toBe(true);
  });

  it("clearing a day with an empty array supersedes prior rows and surfaces full under-allocation", async () => {
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "FIRST-GUESS", minutes: 540 },
    ]);

    const result = await store.setAllocations(employeeId, DAY, []);

    expect(result.allocatedMinutes).toBe(0);
    expect(result.workedMinutes).toBe(540);
    expect(result.discrepancyMinutes).toBe(-540);
    expect(await store.currentAllocations(employeeId, DAY)).toHaveLength(0);

    // The prior row must be superseded (not left dangling as "current"), and the version
    // sequence must keep advancing even though the new version wrote zero rows.
    const all = await store.allAllocations(employeeId, DAY);
    expect(all).toHaveLength(1);
    expect(all[0].project_code).toBe("FIRST-GUESS");
    expect(all[0].superseded_by).not.toBeNull();

    // A subsequent write must not reuse version 1 (FIRST-GUESS's version): the empty clearing
    // call wrote no row, so it consumed no version number, and the next real write is free to
    // take version 2 without colliding with any existing row.
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "REINSTATED", minutes: 540 },
    ]);
    const current = await store.currentAllocations(employeeId, DAY);
    expect(current[0].version).toBe(2);
  });
});

describe("reconcile", () => {
  it("matches the result returned by setAllocations", async () => {
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 120 },
    ]);

    const result = await store.reconcile(employeeId, DAY);
    expect(result.allocatedMinutes).toBe(120);
    expect(result.workedMinutes).toBe(540);
    expect(result.discrepancyMinutes).toBe(-420);
  });
});
