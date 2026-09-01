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
      // Location is its own table so a coordinate purge never has to touch the append-only
      // punches row. `punch_locations` sorts before `punches` ('_' < 'e').
      "punch_locations",
      "punches",
      "sites",
      "submissions",
    ]);
  });

  it("keeps location data off the append-only punch row, so it can be purged alone", async () => {
    // The spec requires a coordinate purge that does not touch attendance records, and `punches`
    // is append-only (no UPDATE, no DELETE). Those two only hold together if the coordinates are
    // not columns on the punch — so this asserts the split structurally rather than trusting a
    // comment. A purge is then a DELETE against `punch_locations` alone.
    const store = env.KINTAI_STORE.getByName("test-schema-locations");
    const location = ["accuracy_m", "latitude", "location_source", "longitude", "matched_site_id"];

    const punches = await store.tableColumns("punches");
    for (const column of location) expect(punches).not.toContain(column);
    expect(punches).toEqual([
      "amend_reason", "amended_by", "employee_id", "id", "kind", "occurred_at", "recorded_at",
      "source", "supersedes_id", "work_date",
    ]);

    expect(await store.tableColumns("punch_locations"))
      .toEqual([...location, "punch_id"].sort());
  });

  it("carries the work-date policy on the employee, defaulting to calendar", async () => {
    const store = env.KINTAI_STORE.getByName("test-schema-policy");

    expect(await store.tableColumns("employees")).toEqual([
      "departed_on", "department", "designated_approver_id", "display_name", "employee_number",
      "employment_type", "id", "joined_on", "status", "work_date_policy",
    ]);

    // The DEFAULT is what makes this feature safe to ship: an INSERT that says nothing about the
    // policy — which is every existing caller — produces the behaviour that existed before it.
    const employeeId = await store.createEmployee({
      employeeNumber: "E-default", displayName: "Default", joinedOn: "2026-04-01",
    });
    expect((await store.listEmployees()).find((row) => row.id === employeeId))
      .toMatchObject({ work_date_policy: "calendar" });
  });

  // A store created before the column existed holds real payroll records and cannot be recreated,
  // so the column has to be added to the table in place. See `migrateLegacyEmployees`.
  it("adds the policy column to an employees table that predates it, as calendar", async () => {
    const host = env.KINTAI_FACET_HOST.getByName("schema-migration");

    const rows = await host.migrateLegacyEmployees(["Tanaka", "Suzuki"]);

    expect(rows).toEqual([
      { display_name: "Tanaka", work_date_policy: "calendar" },
      { display_name: "Suzuki", work_date_policy: "calendar" },
    ]);
  });

  it("is idempotent across activations", async () => {
    const first = env.KINTAI_STORE.getByName("test-idempotent");
    const before = await first.tableNames();
    const second = env.KINTAI_STORE.getByName("test-idempotent");
    expect(await second.tableNames()).toEqual(before);
  });
});
