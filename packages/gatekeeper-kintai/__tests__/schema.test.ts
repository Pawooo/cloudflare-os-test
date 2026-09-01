import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("kintai schema", () => {
  it("creates every table the design requires", async () => {
    const store = env.KINTAI_STORE.getByName("test-schema");
    const tables = await store.tableNames();

    expect(tables).toEqual([
      "account_links",
      // What a correction request asks for, keyed one-to-one on the submission carrying its
      // approval. Created after both `submissions` and `punches`, which it references.
      "amendment_requests",
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
      // The two growing enumerations. Lookup tables rather than CHECK constraints, so adding a
      // value is an INSERT and never a table rebuild. See `applySchema`.
      "punch_sources",
      "punches",
      "sites",
      "submission_kinds",
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

describe("growing enumerations live in lookup tables", () => {
  it("seeds every submission kind and punch source", async () => {
    const store = env.KINTAI_STORE.getByName("lookup-seed");
    await store.createEmployee({
      employeeNumber: "E1", displayName: "Tanaka", joinedOn: "2026-04-01",
    });

    expect(await store.submissionKinds()).toEqual(["amendment", "overtime"]);
    expect(await store.punchSources()).toEqual(["admin", "amendment", "gadget", "import"]);
  });

  // Two layers, asserted separately, because they fail differently and a reader needs to know
  // which one caught what.
  it("refuses an unknown punch source at the RPC boundary, before any SQL runs", async () => {
    const store = env.KINTAI_STORE.getByName("lookup-reject");
    const employeeId = await store.createEmployee({
      employeeNumber: "E1", displayName: "Tanaka", joinedOn: "2026-04-01",
    });

    // `@validateRpc()` generates this from `NewPunch`, so a bad `source` never reaches the store
    // body. This is the check that matters in production -- the lookup table is the backstop
    // under it, not the front line.
    // Settled by hand rather than with `.rejects`, which leaves this particular rejection
    // duplicated as an unhandled one and makes vitest warn about false positives.
    const refusal = await store.recordPunch({
      employeeId, workDate: "2026-07-03", kind: "in",
      now: Date.parse("2026-07-03T00:00:00Z"),
      // @ts-expect-error -- the point is what happens when TypeScript is bypassed
      source: "nonsense",
    }).then(() => null, (error: unknown) => String(error));
    expect(refusal).toMatch(/expected union/);

    // And nothing was written on the way to being refused.
    expect(await store.allPunches(employeeId, "2026-07-03")).toEqual([]);
  });

  it("refuses an unknown punch source in the database, with TypeScript and RPC both bypassed", async () => {
    // The whole point of a foreign key over a CHECK is that adding a value is an INSERT. The
    // whole point of keeping a database-level constraint at all is that it still refuses a value
    // nobody seeded. That second claim is unreachable through `KintaiStore` -- validation refuses
    // first, as the test above pins -- so it is probed with raw SQL. See `rejectsUnknownEnum`.
    const host = env.KINTAI_FACET_HOST.getByName("lookup-fk-punches");

    expect(await host.rejectsUnknownEnum("punches", "nonsense")).toMatch(/FOREIGN KEY/);
  });

  it("refuses an unknown submission kind in the database", async () => {
    const host = env.KINTAI_FACET_HOST.getByName("lookup-fk-submissions");

    expect(await host.rejectsUnknownEnum("submissions", "expenses")).toMatch(/FOREIGN KEY/);
  });

  it("accepts a seeded value through the same raw path", async () => {
    // Without this the two tests above would also pass against a punches table that refused
    // every source, which is not the property being claimed.
    const host = env.KINTAI_FACET_HOST.getByName("lookup-fk-accepts");

    expect(await host.rejectsUnknownEnum("punches", "amendment")).toBeNull();
    expect(await host.rejectsUnknownEnum("submissions", "amendment")).toBeNull();
  });

  // A dev store created before this change keeps its old `CHECK (kind IN ('overtime'))`, because
  // `CREATE TABLE IF NOT EXISTS` is a no-op on it, and would refuse every amendment with a bare
  // constraint error at the first write. There is no migration; there is an instruction.
  it("tells a developer with a pre-lookup store to reset it", async () => {
    const host = env.KINTAI_FACET_HOST.getByName("lookup-stale");

    const message = await host.detectsStaleSchema();

    expect(message).toMatch(/KINTAI_STALE_SCHEMA/);
    // Names the ONE directory to delete, not all of `.wrangler/state`. The broad instruction cost
    // a full Workshop re-login once; the message is the only place most people will read it.
    expect(message).toMatch(/gatekeeper-kintai-KintaiStore/);
    expect(message).toMatch(/NOT required/);
    expect(message).toMatch(/resetting-the-dev-store\.md/);
  });

  it("is idempotent across repeated activations", async () => {
    // `getByName` twice returns two stubs for ONE live instance, so a second call proves nothing
    // about the constructor -- `applySchema` would have run once either way. `state.abort()`
    // discards the instance while keeping its storage, so the next call genuinely re-enters the
    // constructor against a database that is already seeded. That is the case `INSERT OR IGNORE`
    // exists for, and it is the one that runs on every real activation.
    const stub = env.KINTAI_STORE.getByName("lookup-idempotent");
    expect(await stub.submissionKinds()).toEqual(["amendment", "overtime"]);

    await runInDurableObject(stub, (_instance, state) => {
      state.abort();
    }).catch(() => {
      // `abort()` rejects the in-flight call by design; the discard is the point.
    });

    const revived = env.KINTAI_STORE.getByName("lookup-idempotent");
    expect(await revived.submissionKinds()).toEqual(["amendment", "overtime"]);
    expect(await revived.punchSources()).toEqual(["admin", "amendment", "gadget", "import"]);
  });

  it("restores a seed row a later version adds, on the next activation", async () => {
    // The forward path this design exists for: widening the enum is an INSERT, and an existing
    // store picks it up when it next activates rather than needing a migration.
    const host = env.KINTAI_FACET_HOST.getByName("lookup-reseed");
    expect(await host.reseedsMissingLookupRow()).toEqual(
      ["admin", "amendment", "gadget", "import"],
    );
  });
});
