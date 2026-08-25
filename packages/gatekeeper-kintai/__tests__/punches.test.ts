import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NINE_AM = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST
const SIX_PM = Date.parse("2026-07-03T09:00:00Z");  // 18:00 JST
const DAY = "2026-07-03";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`punches-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E900", displayName: "Tanaka", joinedOn: "2026-04-01",
  });
});

describe("recording punches", () => {
  it("records a punch and returns it as current", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });

    const punches = await store.currentPunches(employeeId, DAY);
    expect(punches).toHaveLength(1);
    expect(punches[0].kind).toBe("in");
    expect(punches[0].occurred_at).toBe(NINE_AM);
  });

  it("computes worked minutes from in/out pairs", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    expect(await store.workedMinutes(employeeId, DAY)).toBe(540);
  });
});

describe("corrections", () => {
  it("supersedes rather than updates, and keeps the original readable", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const corrected = await store.correctPunch(
      original,
      { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1_800_000, source: "admin" },
      employeeId,
      "clocked in late by mistake",
    );

    // Only the correction is current...
    const current = await store.currentPunches(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(corrected);

    // ...but the original row still exists, untouched, with the reason recorded.
    const all = await store.allPunches(employeeId, DAY);
    expect(all).toHaveLength(2);
    const supersededRow = all.find((p) => p.id === original)!;
    expect(supersededRow.occurred_at).toBe(NINE_AM);
    const correctionRow = all.find((p) => p.id === corrected)!;
    expect(correctionRow.supersedes_id).toBe(original);
    expect(correctionRow.amend_reason).toBe("clocked in late by mistake");
  });
});

describe("location", () => {
  it("stores coordinates and the evaluated site match together", async () => {
    const site = await store.createSite({
      name: "現場A", latitude: 35.6812, longitude: 139.7671,
      radiusM: 500, validFrom: NINE_AM - 1000,
    });

    const id = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      location: { source: "gps", latitude: 35.6812, longitude: 139.7671, accuracyM: 8 },
    });

    const punch = (await store.currentPunches(employeeId, DAY)).find((p) => p.id === id)!;
    expect(punch.location_source).toBe("gps");
    expect(punch.matched_site_id).toBe(site);
    expect(punch.latitude).toBeCloseTo(35.6812, 4);
  });

  it("still records the punch when the user denied location", async () => {
    const id = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      location: { source: "denied" },
    });

    const punch = (await store.currentPunches(employeeId, DAY)).find((p) => p.id === id)!;
    expect(punch.location_source).toBe("denied");
    expect(punch.matched_site_id).toBeNull();
    expect(punch.latitude).toBeNull();
  });
});

describe("duplicate suppression", () => {
  it("returns the same punch for a double-tap inside the window", async () => {
    const first = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const second = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 5_000, source: "gadget",
    });

    expect(second).toBe(first);
    expect(await store.currentPunches(employeeId, DAY)).toHaveLength(1);
  });

  it("records a genuine second punch outside the window", async () => {
    const first = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const second = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 120_000, source: "gadget",
    });

    expect(second).not.toBe(first);
  });
});
