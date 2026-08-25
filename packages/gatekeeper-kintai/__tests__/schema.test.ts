import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("kintai schema", () => {
  it("creates every table the design requires", async () => {
    const store = env.KINTAI_STORE.getByName("test-schema");
    const tables = await store.tableNames();

    expect(tables).toEqual([
      "account_links",
      "approval_events",
      "approval_route_steps",
      "approval_routes",
      "audit_log",
      "day_allocations",
      "employees",
      "exemption_periods",
      "org_edges",
      "period_locks",
      "punches",
      "sites",
      "submissions",
    ]);
  });

  it("is idempotent across activations", async () => {
    const first = env.KINTAI_STORE.getByName("test-idempotent");
    const before = await first.tableNames();
    const second = env.KINTAI_STORE.getByName("test-idempotent");
    expect(await second.tableNames()).toEqual(before);
  });
});
