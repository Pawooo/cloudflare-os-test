import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const APR = Date.parse("2026-04-01T00:00:00Z");
const JUL = Date.parse("2026-07-01T00:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`org-${seq++}`);
});

async function employee(number: string) {
  return store.createEmployee({
    employeeNumber: number, displayName: number, joinedOn: "2026-04-01",
  });
}

describe("temporal org graph", () => {
  it("answers who the manager was at a past instant, after a reorg", async () => {
    const worker = await employee("E100");
    const oldBoss = await employee("E200");
    const newBoss = await employee("E300");

    await store.setReportingLine(worker, oldBoss, APR, JUL);
    await store.setReportingLine(worker, newBoss, JUL);

    expect(await store.managersAt(worker, APR + 1)).toEqual([oldBoss]);
    expect(await store.managersAt(worker, OCT)).toEqual([newBoss]);
  });

  it("grants authority only inside the edge's validity window", async () => {
    const worker = await employee("E101");
    const boss = await employee("E201");
    await store.setReportingLine(worker, boss, JUL);

    expect(await store.hasAuthorityOver(boss, worker, APR)).toBeNull();
    expect(await store.hasAuthorityOver(boss, worker, OCT)).not.toBeNull();
  });

  it("returns the edge id that granted authority, for the audit trail", async () => {
    const worker = await employee("E102");
    const boss = await employee("E202");
    await store.setReportingLine(worker, boss, APR);

    const edge = await store.hasAuthorityOver(boss, worker, JUL);
    expect(typeof edge).toBe("number");
  });

  it("lets a bounded delegate act alongside the real manager", async () => {
    const worker = await employee("E103");
    const boss = await employee("E203");
    const cover = await employee("E303");

    await store.setReportingLine(worker, boss, APR);
    await store.setDelegate(worker, cover, JUL, OCT);

    expect(await store.managersAt(worker, APR + 1)).toEqual([boss]);
    expect((await store.managersAt(worker, JUL + 1)).sort()).toEqual([boss, cover].sort());
    // Delegation expires on its own.
    expect(await store.managersAt(worker, OCT + 1)).toEqual([boss]);
  });

  it("grants nobody authority over an employee with no edges", async () => {
    const orphan = await employee("E104");
    const other = await employee("E204");
    expect(await store.hasAuthorityOver(other, orphan, JUL)).toBeNull();
  });
});
