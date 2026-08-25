import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.parse("2026-04-01T00:00:00Z");
const T1 = Date.parse("2026-07-01T00:00:00Z");
const T2 = Date.parse("2026-10-01T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`employees-${seq++}`);
});

describe("account linking", () => {
  it("resolves a linked account to its employee", async () => {
    const id = await store.createEmployee({
      employeeNumber: "E001", displayName: "Tanaka", joinedOn: "2026-04-01",
    });
    await store.linkAccount("acct-a", id, T0);

    expect(await store.resolveAccount("acct-a", T1)).toBe(id);
  });

  it("returns null for an account that was never linked", async () => {
    expect(await store.resolveAccount("acct-unknown", T1)).toBeNull();
  });

  it("keeps history on the employee when an email change reassigns the account", async () => {
    const id = await store.createEmployee({
      employeeNumber: "E002", displayName: "Suzuki", joinedOn: "2026-04-01",
    });
    await store.linkAccount("acct-old", id, T0);
    await store.linkAccount("acct-new", id, T1);

    // The new account resolves; the old one no longer does.
    expect(await store.resolveAccount("acct-new", T2)).toBe(id);
    expect(await store.resolveAccount("acct-old", T2)).toBeNull();
    // But the old link still resolved during its own validity window.
    expect(await store.resolveAccount("acct-old", T0 + 1)).toBe(id);
  });
});

describe("exemptions", () => {
  it("reports 管理監督者 status only within the granted period", async () => {
    const id = await store.createEmployee({
      employeeNumber: "E003", displayName: "Yamada", joinedOn: "2026-04-01",
    });
    await store.grantExemption(id, T1, T2);

    expect(await store.isExempt(id, T0)).toBe(false);
    expect(await store.isExempt(id, T1 + 1)).toBe(true);
    expect(await store.isExempt(id, T2 + 1)).toBe(false);
  });

  it("treats an open-ended exemption as still in force", async () => {
    const id = await store.createEmployee({
      employeeNumber: "E004", displayName: "Kato", joinedOn: "2026-04-01",
    });
    await store.grantExemption(id, T0);

    expect(await store.isExempt(id, T2)).toBe(true);
  });
});
