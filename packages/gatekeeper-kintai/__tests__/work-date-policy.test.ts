import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PunchKind } from "../src/types.js";
import { LONG_SPAN_MS, MAX_SHIFT_MS, jstWorkDate } from "../src/work-date.js";

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
async function punch(employeeId: number, kind: PunchKind, now: number): Promise<string> {
  const workDate = await store.workDateFor(employeeId, now, kind);
  await store.recordPunch({ employeeId, workDate, kind, now, source: "gadget" });
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
    expect(await store.workDateFor(employeeId, TEN_PM + MAX_SHIFT_MS - 1, "out")).toBe(DAY_ONE);
    // ...and the instant the window closes, it does not.
    expect(await store.workDateFor(employeeId, TEN_PM + MAX_SHIFT_MS, "out")).toBe(DAY_TWO);
  });

  // The cutoff is measured from `openAt` — the earliest unpaired `in` on the day — and the only
  // punch that can move the candidate-query's own bound is another `in`, because that query filters
  // `AND p.kind = 'in'`. So an `in` is the ONLY kind that can exercise this. An earlier version of
  // this test used a `break_start`, which cannot enter that query at all and therefore could not
  // distinguish the two anchorings; it passed against the very defect it was named for.
  it("measures the cutoff from the shift start, not from the last CLOCK-IN inside it", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    // A second clock-in 15 hours in — the forgot-to-clock-out case. It inherits the open shift's
    // date (it is still inside the window measured from the start)...
    expect(await punch(employeeId, "in", TEN_PM + 15 * 60 * 60_000)).toBe(DAY_ONE);

    // ...and it must NOT buy the shift another sixteen hours. Seventeen hours after the shift
    // started is past the cutoff even though it is only two hours after the last `in`.
    expect(await store.workDateFor(employeeId, TEN_PM + 17 * 60 * 60_000, "out")).toBe(DAY_TWO);
    // A break punched inside the shift cannot move it either — the original form of this test.
    const other = await employee("night-break", "shift_start");
    await punch(other, "in", TEN_PM);
    await punch(other, "break_start", TEN_PM + 15 * 60 * 60_000);
    expect(await store.workDateFor(other, TEN_PM + MAX_SHIFT_MS + 60_000, "out")).toBe(DAY_TWO);
  });

  // The review's own reproduction, verbatim. Both of these were filed entirely onto DAY_ONE.
  it("refuses the 22-hour span a single re-clock-in used to buy", async () => {
    const employeeId = await employee("night", "shift_start");
    expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);
    expect(await punch(employeeId, "in", TEN_PM + 14 * 60 * 60_000)).toBe(DAY_ONE);

    // 22 hours after the shift opened. Anchored to the last `in` this was 8 hours and inherited
    // DAY_ONE, crediting 22 hours on one day behind a lone `duplicate_in`.
    expect(await punch(employeeId, "out", TEN_PM + 22 * 60 * 60_000)).toBe(DAY_TWO);
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(0);
    expect(await store.dayAnomalies(employeeId, DAY_ONE))
      .toEqual(["unpaired_in", "duplicate_in"]);
    // The clock-out landed where it happened, orphaned and flagged, crediting nothing.
    expect(await store.workedMinutes(employeeId, DAY_TWO)).toBe(0);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
  });

  it("cannot be chained by clocking in every twelve hours", async () => {
    const employeeId = await employee("night", "shift_start");
    const hoursOn = (hours: number) => TEN_PM + hours * 60 * 60_000;
    expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);

    // Each of these is under 16 hours after the PREVIOUS `in`, which is what used to roll the
    // window forward indefinitely while the span stayed open at 22:00 on DAY_ONE: six clock-ins
    // and a clock-out 66 hours later all landed on DAY_ONE, crediting 3960 minutes for one day.
    const dates = [];
    for (const hours of [12, 24, 36, 48, 60]) {
      dates.push(await punch(employeeId, "in", hoursOn(hours)));
    }
    dates.push(await punch(employeeId, "out", hoursOn(66)));

    // The chain is cut every time the shift underneath it turns 16 hours old. A clock-in that is
    // refused starts a shift of its OWN on its own calendar date, and the next one twelve hours
    // later legitimately inherits that — a twelve-hour-old open shift is not stale. What can no
    // longer happen is the thing that made this dangerous: one day accumulating all of it.
    expect(dates).toEqual([
      DAY_ONE,                                       // inside the original shift's 16 hours
      jstWorkDate(hoursOn(24)), jstWorkDate(hoursOn(24)), // refused; then inherits that one
      jstWorkDate(hoursOn(48)), jstWorkDate(hoursOn(48)), // refused again; then inherits
      jstWorkDate(hoursOn(66)),                      // the clock-out, on its own day
    ]);
    // Every day the 66 hours were spread across is an unpaired, zero-credit, flagged day — which
    // is exactly what a forgotten clock-out looked like before `shift_start` existed. Nothing
    // anywhere credits the span. Previously DAY_ONE alone credited 3960 minutes.
    for (const date of new Set(dates)) {
      expect(await store.workedMinutes(employeeId, date)).toBe(0);
      expect(await store.dayAnomalies(employeeId, date)).not.toEqual([]);
    }
  });

  // Not reachable through `punch()` — the facet always passes `Date.now()` — but `punches.source`
  // already carries `'import'` in its CHECK, so a punch dated ahead of the clock is anticipated.
  // Unbounded above, the candidate query returned it as "the open shift" for every instant after.
  it("ignores a clock-in whose occurred_at is in the future", async () => {
    const employeeId = await employee("night", "shift_start");
    const future = TEN_PM + 150 * 60 * 60_000;
    await store.recordPunch({
      employeeId, workDate: jstWorkDate(future), kind: "in", now: future, source: "import",
    });

    expect(await store.workDateFor(employeeId, TEN_PM, "in")).toBe(DAY_ONE);
    expect(await store.workDateFor(employeeId, SIX_AM, "out")).toBe(DAY_TWO);
  });
});

// Finding 2. The exception exists to keep `recordPunch`'s suppression reachable, so it must reach
// exactly as far as that suppression does: same employee, same work date, SAME KIND, inside the
// same 60s window. Keyed on time alone it also caught punches `recordPunch` would never suppress.
describe("the duplicate-window exception is scoped to the kind it exists for", () => {
  const TWO_PM = Date.parse("2026-07-03T05:00:00Z");
  // 23:59:40 JST on DAY_ONE, and 00:00:10 JST on DAY_TWO — twenty seconds later, over midnight.
  const JUST_BEFORE_MIDNIGHT = Date.parse("2026-07-03T14:59:40Z");
  const JUST_AFTER_MIDNIGHT = Date.parse("2026-07-03T15:00:10Z");

  it("does not let a clock-in inherit the date of a shift that just closed", async () => {
    const employeeId = await employee("night", "shift_start");
    expect(await punch(employeeId, "in", TWO_PM)).toBe(DAY_ONE);
    expect(await punch(employeeId, "out", JUST_BEFORE_MIDNIGHT)).toBe(DAY_ONE);

    // Thirty seconds after the clock-out, but a genuine new shift: `recordPunch` would never
    // suppress an `in` against an `out`, so the exception has nothing to keep reachable here.
    // It used to file this — and the clock-out nine hours later — onto DAY_ONE, producing one
    // 19-hour day with NO anomaly at all and an empty DAY_TWO.
    expect(await punch(employeeId, "in", JUST_AFTER_MIDNIGHT)).toBe(DAY_TWO);
    expect(await punch(employeeId, "out", Date.parse("2026-07-04T00:00:00Z"))).toBe(DAY_TWO);

    // Two ordinary ten-hour and nine-hour days, each flagged clean. Before the kind test this was
    // one 19-hour day credited in full with an empty anomaly list, and DAY_TWO held nothing.
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(600);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual([]);
    expect(await store.workedMinutes(employeeId, DAY_TWO)).toBe(540);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual([]);
  });

  // The month-boundary version of the same thing, which is why it matters beyond tidiness: a new
  // shift filed into the previous month is a write a period lock would have refused outright.
  it("does not file a new shift into the month that just closed", async () => {
    const employeeId = await employee("night", "shift_start");
    // 23:59:40 JST on 2026-06-30, then 00:00:10 JST on 2026-07-01.
    const lastNight = Date.parse("2026-06-30T05:00:00Z");
    const lastSecond = Date.parse("2026-06-30T14:59:40Z");
    const firstSecond = Date.parse("2026-06-30T15:00:10Z");
    await punch(employeeId, "in", lastNight);
    await punch(employeeId, "out", lastSecond);

    expect(await punch(employeeId, "in", firstSecond)).toBe("2026-07-01");
    expect(await store.currentPunches(employeeId, "2026-07-01")).toHaveLength(1);
  });

  it("still claims a double-tapped clock-out, which is what it exists for", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", SIX_AM);

    expect(await punch(employeeId, "out", SIX_AM + 30_000)).toBe(DAY_ONE);
    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(2);
    expect(await store.currentPunches(employeeId, DAY_TWO)).toEqual([]);
  });

  it("holds both halves strict at the 60-second boundary", async () => {
    const doubleTap = await employee("tapper", "shift_start");
    await punch(doubleTap, "in", TEN_PM);
    await punch(doubleTap, "out", SIX_AM);
    // One millisecond inside the window the closed shift still claims the repeat `out`...
    expect(await store.workDateFor(doubleTap, SIX_AM + 59_999, "out")).toBe(DAY_ONE);
    // ...and at 60s exactly it does not, matching `recordPunch`'s own strict `>` comparison.
    expect(await store.workDateFor(doubleTap, SIX_AM + 60_000, "out")).toBe(DAY_TWO);
    expect(await store.workDateFor(doubleTap, SIX_AM + 60_001, "out")).toBe(DAY_TWO);

    // The kind test is checked at the same three instants, so "scoped to the kind" cannot be
    // mistaken for "the window moved": an `in` is refused inside the window as well as outside it.
    const newShift = await employee("starter", "shift_start");
    await punch(newShift, "in", TEN_PM);
    await punch(newShift, "out", SIX_AM);
    expect(await store.workDateFor(newShift, SIX_AM + 59_999, "in")).toBe(DAY_TWO);
    expect(await store.workDateFor(newShift, SIX_AM + 60_000, "in")).toBe(DAY_TWO);
    expect(await store.workDateFor(newShift, SIX_AM + 60_001, "in")).toBe(DAY_TWO);
  });

  // The window is part of the predicate, not just the kind. A `break_start` earlier in the closed
  // shift is the same kind but hours outside the window, so `recordPunch` would not suppress a new
  // one either — and the exception must not claim it.
  it("does not claim a punch whose matching kind on that day is outside the window", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "break_start", TWO_AM);
    await punch(employeeId, "break_end", HALF_TWO_AM);
    await punch(employeeId, "out", SIX_AM);

    expect(await punch(employeeId, "break_start", SIX_AM + 30_000)).toBe(DAY_TWO);
    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(4);
  });
});

// Finding 3. `shift_start` did what it was built to do and, in doing it, made a forgotten
// clock-out invisible: under `calendar` those punches had always produced two flagged zero-credit
// days a human had to resolve, and under `shift_start` they became one clean fully-paid day.
describe("a long day is flagged whichever policy the employee is on", () => {
  const FIFTEEN_HOURS = 15 * 60 * 60_000;

  it("flags a fifteen-hour shift_start day that used to carry no anomaly at all", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    expect(await punch(employeeId, "out", TEN_PM + FIFTEEN_HOURS)).toBe(DAY_ONE);

    // Still one day and still credited in full — the feature is not walked back. What changed is
    // that the day now says it needs looking at, where before it said nothing.
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(900);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual(["long_span"]);
  });

  it("leaves the same punches under calendar exactly as they were", async () => {
    const employeeId = await employee("office");
    await punch(employeeId, "in", TEN_PM);
    await punch(employeeId, "out", TEN_PM + FIFTEEN_HOURS);

    // Split across two dates, neither of which is a long span on its own, so nothing here moves.
    expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(0);
    expect(await store.dayAnomalies(employeeId, DAY_ONE)).toEqual(["unpaired_in"]);
    expect(await store.workedMinutes(employeeId, DAY_TWO)).toBe(0);
    expect(await store.dayAnomalies(employeeId, DAY_TWO)).toEqual(["orphan_out"]);
  });

  it("says the same thing about the same day for both policies", async () => {
    // The identical punch set, filed against the identical work date, for two employees who differ
    // only in their policy. `dayAnomalies` must not be able to tell them apart.
    const night = await employee("night", "shift_start");
    const office = await employee("office");
    for (const employeeId of [night, office]) {
      for (const [kind, at] of [["in", TEN_PM], ["out", TEN_PM + FIFTEEN_HOURS]] as const) {
        await store.recordPunch({
          employeeId, workDate: DAY_ONE, kind, now: at, source: "gadget",
        });
      }
    }

    expect(await store.dayAnomalies(office, DAY_ONE))
      .toEqual(await store.dayAnomalies(night, DAY_ONE));
    expect(await store.dayAnomalies(office, DAY_ONE)).toEqual(["long_span"]);
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

  // ACCEPTED, not fixed: switching mid-shift strands the shift that is open. It fails safe — it
  // under-credits and flags both halves — and refusing the change would keep HR from correcting a
  // misconfigured employee until their shift ended. It is pinned here so the fail-safe direction
  // cannot drift into an over-crediting one unnoticed, and it is warned about where HR reads:
  // the hint on `WorkDatePolicyForm` and the doc on `AdminKintaiApi.setWorkDatePolicy`.
  it("strands an in-flight shift when switched from shift_start to calendar, and says so",
    async () => {
      const employeeId = await employee("switcher", "shift_start");
      expect(await punch(employeeId, "in", TEN_PM)).toBe(DAY_ONE);

      await store.setWorkDatePolicy(employeeId, "calendar");

      expect(await punch(employeeId, "out", SIX_AM)).toBe(DAY_TWO);
      expect(await store.workedMinutes(employeeId, DAY_ONE)).toBe(0);
      expect(await store.workedMinutes(employeeId, DAY_TWO)).toBe(0);
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
    expect(await store.workDateFor(one, SIX_AM, "out")).toBe(DAY_ONE);
    expect(await store.workDateFor(two, SIX_AM, "out")).toBe(DAY_TWO);
  });

  it("does not let one employee's open shift attribute another's punch", async () => {
    const one = await employee("nightA", "shift_start");
    const two = await employee("nightB", "shift_start");
    await punch(one, "in", TEN_PM);

    // `two` has nothing open, so their punch is dated by the clock even though a colleague's
    // shift is running.
    expect(await store.workDateFor(two, SIX_AM, "out")).toBe(DAY_TWO);
  });
});

// Finding 4, at the store. `KintaiSession.punch` has to ask for the work date in one turn of the
// store's input gate and write it in another, because the period lock is checked in between and
// has to be checked against the attributed date. `commitPunch` is what makes the pair safe: it
// decides the date a second time, under the write's own gate, and refuses if the answer moved.
describe("commitPunch decides the work date under the gate that writes it", () => {
  it("writes the punch when the date it was given still holds", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);

    const workDate = await store.workDateFor(employeeId, SIX_AM, "out");
    const punchId = await store.commitPunch({
      employeeId, workDate, kind: "out", now: SIX_AM, source: "gadget",
    });

    expect(workDate).toBe(DAY_ONE);
    expect((await store.currentPunches(employeeId, DAY_ONE)).map((p) => p.id)).toContain(punchId);
  });

  it("refuses the write when the shift closed between the read and the write", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);

    // What the facet would have read and validated the period lock against.
    const workDate = await store.workDateFor(employeeId, SIX_AM, "out");
    expect(workDate).toBe(DAY_ONE);
    // ...and what a concurrent punch did in the gap. The clock-out closes the shift, so an `in`
    // decided from it no longer belongs to DAY_ONE.
    await punch(employeeId, "out", SIX_AM - 1_000);

    await expect(() => store.commitPunch({
      employeeId, workDate, kind: "in", now: SIX_AM, source: "gadget",
    })).rejects.toThrow(/KINTAI_WORK_DATE_RACED/);

    // Refused, not silently re-filed: nothing was written to either day. Writing it to the
    // recomputed date would step around the period lock the caller checked against DAY_ONE.
    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(2);
    expect(await store.currentPunches(employeeId, DAY_TWO)).toEqual([]);
  });

  it("refuses just as readily when the recomputed date is the EARLIER one", async () => {
    const employeeId = await employee("night", "shift_start");
    // Nothing open, so a clock-in at 22:00 is dated by the calendar.
    const workDate = await store.workDateFor(employeeId, SIX_AM, "in");
    expect(workDate).toBe(DAY_TWO);
    // A shift opens in the gap, so the punch now belongs to the shift's date instead.
    await punch(employeeId, "in", TEN_PM);

    await expect(() => store.commitPunch({
      employeeId, workDate, kind: "in", now: SIX_AM, source: "gadget",
    })).rejects.toThrow(/KINTAI_WORK_DATE_RACED/);
  });

  it("is transparent for a calendar employee, whose date cannot move", async () => {
    const employeeId = await employee("office");
    await punch(employeeId, "in", TEN_PM);

    // `workDateFor` returns before any punch-table access for `calendar`, so its recomputation is
    // a pure function of the clock and there is nothing for a concurrent punch to change.
    const punchId = await store.commitPunch({
      employeeId, workDate: DAY_TWO, kind: "out", now: SIX_AM, source: "gadget",
    });
    expect((await store.currentPunches(employeeId, DAY_TWO)).map((p) => p.id)).toEqual([punchId]);
  });

  it("still suppresses a double-tap rather than refusing it", async () => {
    const employeeId = await employee("night", "shift_start");
    await punch(employeeId, "in", TEN_PM);
    const first = await store.commitPunch({
      employeeId, workDate: DAY_ONE, kind: "out", now: SIX_AM, source: "gadget",
    });

    // The shift is closed now, but the duplicate-window exception keeps DAY_ONE the answer for a
    // repeat `out`, so the recomputation agrees and `recordPunch` returns the original id.
    const second = await store.commitPunch({
      employeeId, workDate: DAY_ONE, kind: "out", now: SIX_AM + 30_000, source: "gadget",
    });
    expect(second).toBe(first);
    expect(await store.currentPunches(employeeId, DAY_ONE)).toHaveLength(2);
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
