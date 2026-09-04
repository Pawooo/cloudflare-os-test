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

  it("preserves the original lock when the same period is locked twice", async () => {
    const other = await store.createEmployee({
      employeeNumber: "HR2", displayName: "Other HR", joinedOn: "2026-04-01",
    });

    await store.lockPeriod("2026-07", hr, JUL);
    await store.lockPeriod("2026-07", other, JUL + 1000 * 60 * 60 * 24);

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
