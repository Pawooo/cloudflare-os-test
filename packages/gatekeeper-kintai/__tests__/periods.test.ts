import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { periodOf, periodOfSql } from "../src/store/periods.js";

const JUL = Date.parse("2026-07-31T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let hr: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`period-${seq++}`);
  hr = await store.createEmployee({
    employeeNumber: "HR1", displayName: "HR", joinedOn: "2026-04-01",
  });
});

describe("periodOf", () => {
  it("reduces a work date to its JST calendar month", () => {
    expect(periodOf("2026-07-03")).toBe("2026-07");
    expect(periodOf("2026-12-31")).toBe("2026-12");
  });

  /**
   * `periodOfSql` is the same rule written twice — once in TypeScript, once as SQL, because the
   * approval queue joins `period_locks` in the query rather than calling `isLocked` per row. Two
   * statements of one rule drift, so the agreement is asserted rather than assumed: change one and
   * not the other and this fails, which is the only thing standing between them.
   */
  it("agrees with its SQL form on every shape of work date", async () => {
    const dates = ["2026-01-01", "2026-07-03", "2026-12-31", "2027-02-28"];
    const inSql = await runInDurableObject(store, (instance) =>
      dates.map((date) =>
        instance.sql
          .exec<{ period: string }>(`SELECT ${periodOfSql("?")} AS period`, date)
          .one().period));

    expect(inSql).toEqual(dates.map(periodOf));
  });
});

describe("period locks", () => {
  it("treats an unlocked period as writable", async () => {
    expect(await store.isLocked("2026-07-03")).toBe(false);
    await expect(store.assertWritable("2026-07-03")).resolves.toBeUndefined();
  });

  it("blocks writes once the period is locked", async () => {
    await store.lockPeriod("2026-07", hr, JUL);

    expect(await store.isLocked("2026-07-03")).toBe(true);
    await expect(() => store.assertWritable("2026-07-03"))
      .rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
  });

  it("leaves other periods writable", async () => {
    await store.lockPeriod("2026-07", hr, JUL);
    expect(await store.isLocked("2026-08-01")).toBe(false);
  });

  /**
   * A MONTH THAT HAS NOT STARTED CANNOT BE CLOSED, and this is where that is refused.
   *
   * The hole this closes: `assertPeriod` accepts any well-formed `YYYY-MM`, `period_locks` has no
   * unlock, and every write into a closed month is refused — so one mistyped year ("2027-08" for
   * "2026-08") wrote a permanent row that would stop the whole company clocking in when that month
   * arrived, a year later, with nothing but hand-editing the Durable Object to undo it.
   *
   * Judged against the CALLER's `now`, which is why this is testable at fixed instants rather than
   * against the wall clock: the same `now` that will be written as `locked_at` is the one the
   * period is compared with, so the refusal and the row can never disagree about what time it is.
   * "Current or earlier", not "ended": closing the live month on its last day is the ordinary case.
   */
  it("refuses to close a month that has not started, against the caller's own clock", async () => {
    // JUL is the 31st of July in JST, so August has not begun.
    const refusal: Error = await store
      .lockPeriod("2026-08", hr, JUL)
      .catch((error: Error) => error);

    expect(refusal.message).toMatch(/KINTAI_FUTURE_PERIOD/);
    // Both months, so a reader who typed the wrong year can see it at once.
    expect(refusal.message).toContain("2026-08");
    expect(refusal.message).toContain("2026-07");
    expect(await store.periodLock("2026-08")).toBeNull();

    // One day later August has started, and the identical call is accepted — the boundary is the
    // month edge itself, not "the month is over".
    await store.lockPeriod("2026-08", hr, JUL + 86_400_000);
    expect(await store.periodLock("2026-08")).toMatchObject({ lockedBy: hr });
  });

  // The shape is asserted here as well as at the admin boundary — the same imported
  // `assertPeriod`, as `anomalousDays` and `monthlyTotals` already call it in this layer. It is
  // the future check's precondition: without it, `"banana" > "2026-07"` would be true and a
  // malformed period would be reported as a month that has not happened yet.
  it("refuses a malformed period rather than writing a lock nothing could ever match", async () => {
    await expect(() => store.lockPeriod("banana", hr, JUL))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);

    expect(await store.periodLock("banana")).toBeNull();
  });

  /**
   * A second close is REFUSED, and the first one survives it.
   *
   * This used to be an `INSERT OR IGNORE` that silently kept the first lock, on the reasoning that
   * a duplicate call is harmless. Keeping the first close is still right and this still keeps it —
   * but a silent no-op is indistinguishable from success to whoever called, and now that an
   * administrator can press "close this month" there is somebody to mislead. The refusal is here,
   * in the same synchronous run as the INSERT, rather than at the admin boundary: a check over one
   * RPC and a write over another would let two admins pressing the button at once both be told
   * they closed the month, when only one row exists.
   */
  it("refuses a second close of the same period, and keeps the first", async () => {
    const other = await store.createEmployee({
      employeeNumber: "HR2", displayName: "Other HR", joinedOn: "2026-04-01",
    });
    await store.lockPeriod("2026-07", hr, JUL);

    const refusal: Error = await store
      .lockPeriod("2026-07", other, JUL + 86_400_000)
      .catch((error: Error) => error);

    // Who closed it and when, in JST, because that is what tells the reader whether this was them
    // a moment ago or somebody else last week.
    expect(refusal.message).toMatch(/KINTAI_ALREADY_LOCKED/);
    expect(refusal.message).toContain("2026-07");
    expect(refusal.message).toContain(`employee ${hr}`);
    expect(refusal.message).toContain("2026-07-31");
    expect(await store.periodLock("2026-07")).toEqual({ lockedAt: JUL, lockedBy: hr });
  });
});

describe("audit log", () => {
  it("appends entries in order", async () => {
    await store.appendAudit({
      at: JUL, actorEmployeeId: hr, action: "lock_period", entity: "period_locks",
      after: { period: "2026-07" },
    });
    await store.appendAudit({
      at: JUL + 1, actorEmployeeId: hr, action: "link_account", entity: "account_links",
    });

    const entries = await store.auditEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("lock_period");
    expect(JSON.parse(entries[0].after!)).toEqual({ period: "2026-07" });
    expect(entries[1].after).toBeNull();
  });

  it("stores omitted, explicit null, and an object identically as SQL NULL or valid JSON", async () => {
    await store.appendAudit({
      at: JUL, actorEmployeeId: hr, action: "omitted", entity: "test",
    });
    await store.appendAudit({
      at: JUL + 1, actorEmployeeId: hr, action: "explicit_null", entity: "test", before: null,
    });
    await store.appendAudit({
      at: JUL + 2, actorEmployeeId: hr, action: "object", entity: "test",
      before: { department: "sales" },
    });

    const entries = await store.auditEntries();
    expect(entries[0].before).toBeNull();
    expect(entries[1].before).toBeNull();
    expect(JSON.parse(entries[2].before!)).toEqual({ department: "sales" });
  });
});
