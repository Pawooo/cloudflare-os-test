import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LONG_SPAN_MS, MAX_SHIFT_MS } from "../src/work-date.js";

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

describe("break accounting", () => {
  it("charges an unpaired break through to the day's last punch instead of crediting it as worked", async () => {
    const breakStart = NINE_AM + 3 * 60 * 60_000; // 12:00 JST, 3 hours into the shift

    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_start", now: breakStart, source: "gadget",
    });
    // No break_end is ever punched; the day is closed out directly instead.
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    // Only the 3 hours before the break started are credited (180 minutes) — NOT the naive
    // 9-hour in/out span (540 minutes), and NOT the 6 hours from break start to close-out treated
    // as zero. An unpaired break must fail safe by under-crediting, never by over-crediting.
    expect(await store.workedMinutes(employeeId, DAY)).toBe(180);
    expect(await store.dayAnomalies(employeeId, DAY)).toContain("unpaired_break");
  });
});

describe("corrections", () => {
  it("supersedes rather than updates, and keeps the original readable", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    // The correction is entered well after the shift, backdating the occurred_at itself.
    const correctionEnteredAt = SIX_PM + 3_600_000;
    const corrected = await store.correctPunch(
      original,
      { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1_800_000, source: "admin" },
      employeeId,
      "clocked in late by mistake",
      correctionEnteredAt,
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

    // The backdated occurred_at must not clobber the record of when the correction was entered.
    expect(correctionRow.occurred_at).toBe(NINE_AM - 1_800_000);
    expect(correctionRow.recorded_at).toBe(correctionEnteredAt);
  });

  it("rejects a correction whose employee, work date or kind don't match the original", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const otherEmployeeId = await store.createEmployee({
      employeeNumber: "E901", displayName: "Suzuki", joinedOn: "2026-04-01",
    });

    // Wrapped in a thunk rather than passed as an already-created promise: `.rejects` on an
    // already-created RPC promise leaves it unhandled for a turn, which Vitest reports as an
    // `Unhandled Rejection` block. (It does not silence workerd's `uncaught exception; source =
    // Uncaught (in promise)` log lines — those accompany every exception crossing an RPC boundary,
    // whichever form the assertion takes.)
    await expect(() =>
      store.correctPunch(
        original,
        { employeeId: otherEmployeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "admin" },
        employeeId,
        "wrong employee",
        NINE_AM,
      ),
    ).rejects.toThrow();
  });

  it("rejects a second correction of the same original", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.correctPunch(
      original,
      { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1_800_000, source: "admin" },
      employeeId,
      "first correction",
      NINE_AM,
    );

    await expect(() =>
      store.correctPunch(
        original,
        { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 900_000, source: "admin" },
        employeeId,
        "second correction of the same row",
        NINE_AM,
      ),
    ).rejects.toThrow();
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

describe("day anomalies", () => {
  it("flags unpaired_in for a clock-in with no clock-out", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["unpaired_in"]);
  });

  it("flags unpaired_break for a break with no break_end", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_start", now: NINE_AM + 1_800_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["unpaired_break"]);
  });

  it("flags orphan_out for a clock-out with no preceding clock-in", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["orphan_out"]);
  });

  it("flags duplicate_in for a second clock-in before the first is closed", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    // Outside the 60s duplicate window, so this is recorded as a genuine second row rather than
    // suppressed as a double-tap — which is exactly what makes it a data-quality anomaly instead.
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 120_000, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["unpaired_in", "duplicate_in"]);
  });

  it("flags negative_gross when paired break time exceeds paired work time", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_start", now: NINE_AM + 100_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE_AM + 200_000, source: "gadget",
    });
    // break_end is recorded well after "out" (a data-entry mistake), making the paired break span
    // longer than the paired work span it's supposed to be carved out of.
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_end", now: NINE_AM + 10_000_000, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["negative_gross"]);
    // The clamp still applies so workedMinutes never goes negative...
    expect(await store.workedMinutes(employeeId, DAY)).toBe(0);
  });
});

/**
 * `long_span` is the flag for a day whose punches are perfectly well-formed and whose LENGTH is
 * the problem — normally a clock-out that arrived hours after the employee actually left.
 *
 * It lives here rather than in the work-date-policy suite deliberately: `dayAnomalies` never reads
 * `work_date_policy`, and it must not start. The same punches on the same day must carry the same
 * flags for a night worker and an office worker; only WHICH day they land on is the policy's
 * business. The policy suite has the shift_start half.
 */
describe("long_span, the flag for a day that is too long to be ordinary", () => {
  /** Clock in at 09:00 JST and out `ms` later, all on the one work date. */
  async function span(ms: number) {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE_AM + ms, source: "gadget",
    });
  }

  it("leaves a legitimate 12-hour rotation completely clean", async () => {
    await span(12 * 3_600_000);

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual([]);
    expect(await store.workedMinutes(employeeId, DAY)).toBe(720);
  });

  it("holds the boundary at exactly the threshold", async () => {
    await span(LONG_SPAN_MS - 1);
    expect(await store.dayAnomalies(employeeId, DAY)).toEqual([]);
  });

  it("flags the threshold itself", async () => {
    await span(LONG_SPAN_MS);
    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["long_span"]);
  });

  it("flags a fifteen-hour day and still credits every minute of it", async () => {
    await span(15 * 3_600_000);

    // The flag is a signal for a human, never a deduction: the minutes are untouched.
    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["long_span"]);
    expect(await store.workedMinutes(employeeId, DAY)).toBe(900);
  });

  it("stays strictly reachable below the 16-hour attribution cutoff", () => {
    // If these ever crossed, the band `shift_start` still credits silently would be unflagged
    // again, which is the hole this constant exists to close.
    expect(LONG_SPAN_MS).toBeGreaterThanOrEqual(12 * 3_600_000);
    expect(LONG_SPAN_MS).toBeLessThan(MAX_SHIFT_MS);
  });

  it("measures the paired in/out time, not the time left after breaks", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    // A three-hour break inside a fifteen-hour presence. Twelve hours are credited, but the
    // employee was clocked in for fifteen and that is what needs looking at.
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_start", now: NINE_AM + 3_600_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "break_end", now: NINE_AM + 4 * 3_600_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE_AM + 15 * 3_600_000, source: "gadget",
    });

    expect(await store.workedMinutes(employeeId, DAY)).toBe(720);
    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["long_span"]);
  });

  it("adds up two shifts on one day rather than looking at each alone", async () => {
    // Two clean eight-hour spans filed against the same work date: sixteen hours clocked in on one
    // day, which nothing else here flags.
    for (const [inAt, outAt] of [[0, 8], [9, 17]]) {
      await store.recordPunch({
        employeeId, workDate: DAY, kind: "in", now: NINE_AM + inAt * 3_600_000, source: "gadget",
      });
      await store.recordPunch({
        employeeId, workDate: DAY, kind: "out", now: NINE_AM + outAt * 3_600_000, source: "gadget",
      });
    }

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["long_span"]);
  });

  it("comes last, leaving the flags a caller already knows in the order they had", async () => {
    // A fifteen-hour span with a second clock-in inside it: the pre-existing flag stays where it
    // was and the new one is appended.
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 3_600_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE_AM + 15 * 3_600_000, source: "gadget",
    });

    expect(await store.dayAnomalies(employeeId, DAY)).toEqual(["duplicate_in", "long_span"]);
  });
});
