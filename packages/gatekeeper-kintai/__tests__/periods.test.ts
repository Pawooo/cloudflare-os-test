import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { periodOf } from "../src/store/periods.js";

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
});
