import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SHIFT_MS, jstWorkDate } from "../src/work-date.js";

// Which work date a punch is attributed to, per employee.
//
// The first suite is the one that matters most: `calendar` is the default and the common case, so
// every expectation in it is the behaviour that existed BEFORE this feature, written down so a
// change to it fails here rather than silently re-filing an office worker's records.

// 22:00 JST on day one, and the punches of the shift that runs out of it. JST is UTC+9 with no
// DST, so 13:00Z is 22:00 JST the same day and 21:00Z is 06:00 JST the NEXT day.
const TEN_PM = Date.parse("2026-07-03T13:00:00Z");
const TWO_AM = Date.parse("2026-07-03T17:00:00Z");
const HALF_TWO_AM = Date.parse("2026-07-03T17:30:00Z");
const SIX_AM = Date.parse("2026-07-03T21:00:00Z");
const NINE_AM_DAY_TWO = Date.parse("2026-07-04T00:00:00Z");
const DAY_ONE = "2026-07-03";
const DAY_TWO = "2026-07-04";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`work-date-policy-${seq++}`);
});

/** An employee on the given policy, or on the default when none is named. */
async function employee(tag: string, policy?: "calendar" | "shift_start") {
  const employeeId = await store.createEmployee({
    employeeNumber: `${tag}-${seq}`, displayName: tag, joinedOn: "2026-04-01",
  });
  if (policy) await store.setWorkDatePolicy(employeeId, policy);
  return employeeId;
}

/**
 * Punch exactly as the facet does: ask for the work date first, then record onto it.
 *
 * The facet resolves the date and passes it to `recordPunch`, so a test that hard-codes a work
 * date would be testing a path production never takes. This is that pair, and nothing else.
 */
async function punch(employeeId: number, kind: string, now: number): Promise<string> {
  const workDate = await store.workDateFor(employeeId, now);
  await store.recordPunch({
    employeeId, workDate, kind: kind as "in", now, source: "gadget",
  });
  return workDate;
}

describe("calendar is the default, and behaves exactly as it always has", () => {
  it("is what a newly created employee gets, with no policy named anywhere", async () => {
    const employeeId = await employee("office");

    const row = (await store.listEmployees()).find((e) => e.id === employeeId)!;
    expect(row.work_date_policy).toBe("calendar");
  });

  it("attributes every punch to the JST date it happened on, open shift or not", async () => {
    const employeeId = await employee("office");

    expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);
    // The shift is open across midnight, and it changes nothing: the date still comes from the
    // clock. This is the assertion the whole feature must not break.
    expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_TWO);
  });

  it("still splits an overnight shift across two dates, anomalies and all", async () => {
    const employeeId = await employee("office");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", SIX_AM);

    // Verbatim the bug the feature exists to fix, pinned as the CURRENT behaviour for anyone left
    // on `calendar`: nothing here is credited, and both days are flagged.
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(0);
    expect(await store.workedMinutes(employeeId, DAY_TWO)).toBe(0);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual(["unpaired_in"]);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
  });

  it("credits an ordinary daytime shift exactly as before", async () => {
    const employeeId = await employee("office");
    const nineAm = Date.parse("2026-07-03T00:00:00Z");
    const sixPm = Date.parse("2026-07-03T09:00:00Z");
    await punch(employeeId, "in", nineAm);
    await punch(employeeId, "out", sixPm);

    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(540);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual([]);
  });
});

describe("shift_start attributes a punch to the shift it belongs to", () => {
  it("lands 22:00 → 06:00 on one work date, with the whole span credited", async () => {
    const employeeId = await employee("night", "shift_start");

    expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);
    expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_ONE);

    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(480);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual([]);
    // And nothing at all was filed on the calendar day the shift ended on.
    expect(await store.currentPunches(employeeId, DAY_TWO)).toEqual([]);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual([]);
  });

  it("carries break punches inside the shift onto the same work date", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);

    expect(await punch(employeeId, "break_start", TWO_AM)).toBe(DAY_ONE);
    expect(await punch(employeeId, "break_end", HALF_TWO_AM)).toBe(DAY_ONE);
    expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_ONE);

    // Eight hours less the half-hour break, all on the start date.
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(450);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual([]);
    expect(await store.currentPunches(employeeId, DAY_TWO)).toEqual([]);
  });

  it("falls back to today's JST date when no shift is open", async () => {
    const employeeId = await employee("night", "shift_start");

    // Nothing recorded at all yet.
    expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);
    // ...and once the shift is closed, the next one starts on its own day again.
    await punch(employeeId, "out", SIX_AM);
    expect(await punch(employeeId, "in", NINE_AM_DAY_TWO)).toBe(DAY_TWO);
  });

  it("attributes a punch made with no open shift to the calendar date, even mid-shift-hours",
    async () => {
      const employeeId = await employee("night", "shift_start");

      // An `out` with nothing open is an orphan wherever it lands; it must land on today.
      expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_TWO);
      expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
    });
});

describe("double-taps, which the duplicate window is supposed to swallow", () => {
  it("suppresses a second clock-out instead of orphaning it on the next day", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", SIX_AM);

    // The shift is CLOSED by the time the second tap lands, so attribution can no longer find an
    // open shift to inherit from. It must still land on the same day: `recordPunch` suppresses a
    // double-tap by (employee, work date, kind), so a punch that drifts onto the next date walks
    // straight past the suppression and becomes a spurious `orphan_out` there.
    expect(await punch(employeeId, "out", SIX_AM + 30_000)).toBe(DAY_ONE);

    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(2);
    expect(await store.currentPunches(employeeId, DAY_TWO)).toEqual([]);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual([]);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual([]);
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(480);
  });

  it("still starts a new day once the duplicate window has passed", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", SIX_AM);

    // Past the window this is no longer a double-tap but a genuine punch with nothing open, and it
    // belongs to the day it happened on — exactly as it would for a calendar employee.
    expect(await punch(employeeId, "out", SIX_AM + 120_000)).toBe(DAY_TWO);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
  });

  it("suppresses a double-tapped clock-in the same way", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);

    // This one already worked: the shift is open, so the repeat inherits its date and the
    // duplicate window sees it. Pinned so the fix above cannot regress it.
    expect(await punch(employeeId, "in", TEN_PM + 30_000)).toBe(DAY_ONE);
    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(1);
  });
});

describe("the 16-hour guard stops a forgotten clock-out swallowing later punches", () => {
  it("starts a fresh shift on today's date past the cutoff, and leaves the stale one flagged",
    async () => {
      const employeeId = await employee("night", "shift_start");
      await punch(employeeId, "in", TEN_PM);

      // 17 hours later: 15:00 JST on day two. Nobody clocked out.
      const seventeenHoursOn = TEN_PM + 17 * 60 * 60_000;
      expect(jstWorkDate(seventeenHoursOn)).toBe(DAY_TWO);
      expect(await punch(employeeId, "in", seventeenHoursOn)).toBe(DAY_TWO);

      // The stale open shift is NOT swallowed: it stays exactly the anomaly it always was.
      expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual(["unpaired_in"]);
      expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(0);
      // ...and the new shift is a normal open shift on its own date.
      expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["unpaired_in"]);
    });

  it("holds the boundary at exactly 16 hours", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);

    // One millisecond inside the window still belongs to the shift...
    expect(await store.workDateFor(employeeId, TEN_PM + MAX_SHIFT_MS - 1)).toBe(DAY_ONE);
    // ...and the instant the window closes, it does not.
    expect(await store.workDateFor(employeeId, TEN_PM + MAX_SHIFT_MS)).toBe(DAY_TWO);
  });

  it("measures the cutoff from the shift start, not from the last punch in it", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    // A break punched 15 hours in keeps the shift's own clock running; it does not restart it.
    await punch(employeeId, "break_start", TEN_PM + 15 * 60 * 60_000);

    expect(await store.workDateFor(employeeId, TEN_PM + MAX_SHIFT_MS + 60_000)).toBe(DAY_TWO);
  });
});

describe("changing an employee's policy", () => {
  it("leaves punches already recorded exactly where they were filed", async () => {
    const employeeId = await employee("switcher");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", SIX_AM);

    await store.setWorkDatePolicy(employeeId, "shift_start");

    // Not retroactive: the split day is still split, and still reads as it did.
    expect((await store.currentPunches(employeeId, DAY_ONE)).map((p) => p.kind)).toEqual(["in"]);
    expect((await store.currentPunches(employeeId, DAY_TWO)).map((p) => p.kind)).toEqual(["out"]);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual(["unpaired_in"]);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
  });

  it("applies to the next punch, and can be switched back", async () => {
    const employeeId = await employee("switcher");
    await store.setWorkDatePolicy(employeeId, "shift_start");
    await punch(employeeId, "in", TEN_PM);
    expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_ONE);

    await store.setWorkDatePolicy(employeeId, "calendar");
    expect(await punch(employeeId, "in", TEN_PM + 86_400_000)).toBe(DAY_TWO);
  });

  it("is read from the employee record on every punch, never cached across one", async () => {
    const one = await employee("nightA", "shift_start");
    const two = await employee("nightB");
    await punch(one, "in", TEN_PM);
    await punch(two, "in", TEN_PM);

    // Two employees, two policies, one instant: each is answered from its own record.
    expect(await store.workDateFor(one, SIX_AM)).toBe(DAY_ONE);
    expect(await store.workDateFor(two, SIX_AM)).toBe(DAY_TWO);
  });

  it("does not let one employee's open shift attribute another's punch", async () => {
    const one = await employee("nightA", "shift_start");
    const two = await employee("nightB", "shift_start");
    await punch(one, "in", TEN_PM);

    // `two` has nothing open, so their punch is dated by the clock even though a colleague's
    // shift is running.
    expect(await store.workDateFor(two, SIX_AM)).toBe(DAY_TWO);
  });
});

describe("the roster reports the policy so HR can see who is on which", () => {
  it("carries work_date_policy on every row", async () => {
    const office = await employee("office");
    const night = await employee("night", "shift_start");

    const roster = await store.listRoster(Date.now());
    expect(roster.find((row) => row.id === office)!.work_date_policy).toBe("calendar");
    expect(roster.find((row) => row.id === night)!.work_date_policy).toBe("shift_start");
  });
});
