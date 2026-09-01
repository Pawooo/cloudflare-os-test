# Kintai Punch Amendments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a recorded punch correctable — fix a wrong time, or add one that was never recorded — through a request that a manager approves, so the days `long_span` now flags have an outlet.

**Architecture:** An amendment is a row in `submissions` with `kind = 'amendment'`, so it inherits the approval stack already built and reviewed (route snapshots, multi-person steps, delegation, the pending queue, the atomic `applyAction` claim). A companion `amendment_requests` table carries what a correction needs and overtime does not; its nullable `target_punch_id` is the entire difference between "this punch is wrong" and "this punch is missing". Applying an approved amendment deliberately bypasses the period lock, which is why locks live in the facet and not in the store's write functions.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite (`ctx.storage.sql`), Cap'n Web RPC (`capnweb`, `capnweb-validate`), vitest with `@cloudflare/vitest-pool-workers` (real workerd, not a mock).

**Spec:** `docs/superpowers/specs/2026-09-01-kintai-punch-amendments-design.md` — read it before Task 1. This plan argues from it.

## Global Constraints

- **`punches`, `approval_events` and `audit_log` are append-only.** No `UPDATE`, no `DELETE`, ever. A correction inserts a new row carrying `supersedes_id`. This is the invariant the entire compliance story rests on.
- **Temporal data uses half-open intervals:** `valid_from <= at AND (valid_to IS NULL OR valid_to > at)`.
- **Admin-only methods go on the `KintaiAdminApi` interface**, implemented on `AdminKintaiApi`, implemented-with-throws on `ViewerKintaiApi`. A method on the class but not the interface is reachable by non-admins over RPC — this package has shipped that defect before.
- **Fail safe.** These are payroll inputs. When a rule is ambiguous, the outcome that credits less is the correct one.
- **Every time value is caller-supplied and therefore not monotonic.** Never order by a timestamp where a row id would do.
- **Errors are `KINTAI_`-prefixed and carry their code in the message**, because `code` does not survive the RPC boundary. Follow `PeriodLockedError` in `src/store/periods.ts`.
- **`src/types.txt` is agent-facing behaviour, not comments.** An LLM reads it to decide how to call the API. Text that contradicts the code is a bug.
- **Do not start `pnpm run-local` casually.** The dev server rewrites `src/generated/app.txt` unminified. If you run it, rebuild with `pnpm run build` from a deleted `dist-app/` before committing.

## Gates every task must pass before commit

```bash
cd packages/gatekeeper-kintai
pnpm exec vitest run                          # worker tests
pnpm exec vitest run -c vitest.app.config.ts  # app tests
pnpm exec tsc --noEmit
pnpm run typecheck:app
```

Baseline entering this plan: **330 worker, 65 app.**

---

## File Structure

**Created:**
- `src/store/amendments.ts` — the amendment request record and its rules: create, read, validate, apply. One responsibility: what a correction request *is*. It does not know about RPC, sessions or authority beyond what it is handed.
- `src/store/migrate.ts` — the table-rebuild helper. SQLite cannot alter a `CHECK` constraint, so two constraints in this plan require the twelve-step rebuild procedure. Isolated because it is dangerous and should be read on its own.
- `__tests__/amendments.test.ts` — store-level rules.
- `__tests__/amendment-flow.test.ts` — the loop end to end through the facet.
- `__tests__/migrate.test.ts` — the rebuilds, against pre-change DDL.

**Modified:**
- `src/store/schema.ts` — the new table, the two CHECK rebuilds.
- `src/store/submissions.ts` — `checkMayAct` gains the `created_by` refusal; filing-time satisfiability gains the filer case.
- `src/store/kintai-store.ts` — store methods for the new functions.
- `src/kintai.ts` — session methods, and the atomic apply.
- `src/types.ts` — re-export `AmendmentRequest` from `store/amendments.ts` if the facet needs it in a signature; the type itself lives beside the table it describes.
- `src/input.ts` — `assertPunchKind`, `assertOccurredAt`.
- `src/types.txt` — agent-facing docs for the new methods and refusals.
- `__tests__/worker.ts` — legacy-DDL harness for the rebuild tests.

---

## Task 1: A table-rebuild helper, and `submissions.kind` accepts `'amendment'`

**Why this is first and why it is its own task:** `submissions.kind` is `CHECK (kind IN ('overtime'))`. **SQLite cannot alter a CHECK constraint** — `ALTER TABLE` can add a column, and nothing else that matters here. Every additive migration this package has done so far (`work_date_policy`) was `ADD COLUMN`, which is why no rebuild machinery exists yet. Adding a second submission kind requires rebuilding the table, and a reviewer should be able to reject the rebuild without rejecting the feature.

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/migrate.ts`
- Create: `packages/gatekeeper-kintai/__tests__/migrate.test.ts`
- Modify: `packages/gatekeeper-kintai/src/store/schema.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/worker.ts`

**Interfaces:**
- Produces: `tableDefinition(sql, table): string | null`, `rebuildTable(sql, spec: RebuildSpec): boolean`, where
  `RebuildSpec = { table: string; wantedMarker: string; createSql: string; columns: string[]; indexes?: string[] }`.
  Returns `true` if it rebuilt, `false` if the table was already current or absent.

- [ ] **Step 1: Write the failing test for the rebuild helper**

Add to `__tests__/worker.ts`, inside `KintaiFacetHost`, next to the existing `migrateLegacyEmployees`:

```ts
  /**
   * Build `submissions` with its PRE-amendment CHECK, plus a referencing `approval_events` row,
   * then run the real `applySchema` over it. The only way to reach the rebuild: `applySchema` runs
   * in the store's constructor, so a `KintaiStore` can never be observed before it.
   */
  migrateLegacySubmissions(): {
    kinds: string[];
    events: number;
    amendmentAccepted: boolean;
    nonsenseRejected: boolean;
  } {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_number TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, joined_on TEXT NOT NULL, left_on TEXT,
      department TEXT, employment_type TEXT, designated_approver_id INTEGER
    ) STRICT`);
    sql.exec(
      `INSERT INTO employees (id, employee_number, display_name, joined_on)
       VALUES (1, 'E1', 'Legacy', '2026-04-01')`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      kind TEXT NOT NULL CHECK (kind IN ('overtime')),
      requested_for TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('draft', 'pending', 'approved', 'rejected', 'withdrawn')),
      submitted_at INTEGER,
      current_step INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL CHECK (minutes >= 0),
      reason TEXT NOT NULL,
      calculation_inputs TEXT CHECK (
        calculation_inputs IS NULL OR json_valid(calculation_inputs)),
      route_snapshot TEXT NOT NULL CHECK (json_valid(route_snapshot)),
      created_by INTEGER REFERENCES employees(id)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS approval_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES submissions(id),
      step_index INTEGER NOT NULL, actor_employee_id INTEGER NOT NULL REFERENCES employees(id),
      action TEXT NOT NULL, at INTEGER NOT NULL, comment TEXT, authorizing_edge INTEGER
    ) STRICT`);
    sql.exec(
      `INSERT INTO submissions
         (id, employee_id, kind, requested_for, state, submitted_at, current_step,
          minutes, reason, calculation_inputs, route_snapshot, created_by)
       VALUES (7, 1, 'overtime', '2026-07-03', 'pending', 100, 0, 60, 'legacy', NULL, '{}', 1)`,
    );
    sql.exec(
      `INSERT INTO approval_events
         (submission_id, step_index, actor_employee_id, action, at)
       VALUES (7, 0, 1, 'approve', 101)`,
    );

    applySchema(sql);

    let amendmentAccepted = false;
    try {
      sql.exec(
        `INSERT INTO submissions
           (id, employee_id, kind, requested_for, state, submitted_at, current_step,
            minutes, reason, route_snapshot)
         VALUES (8, 1, 'amendment', '2026-07-03', 'pending', 102, 0, 0, 'fix', '{}')`,
      );
      amendmentAccepted = true;
    } catch { /* left false */ }

    let nonsenseRejected = false;
    try {
      sql.exec(
        `INSERT INTO submissions
           (id, employee_id, kind, requested_for, state, submitted_at, current_step,
            minutes, reason, route_snapshot)
         VALUES (9, 1, 'nonsense', '2026-07-03', 'pending', 103, 0, 0, 'x', '{}')`,
      );
    } catch { nonsenseRejected = true; }

    return {
      kinds: sql.exec<{ kind: string }>(`SELECT kind FROM submissions ORDER BY id`)
        .toArray().map((r) => r.kind),
      events: sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM approval_events WHERE submission_id = 7`).one().n,
      amendmentAccepted,
      nonsenseRejected,
    };
  }
```

Create `__tests__/migrate.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("submissions.kind rebuild", () => {
  it("keeps existing rows and their approval events, and accepts amendment afterwards", async () => {
    const host = env.KINTAI_FACET_HOST.getByName("migrate-submissions");
    const result = await host.migrateLegacySubmissions();

    expect(result.kinds).toEqual(["overtime", "amendment"]);
    expect(result.events).toBe(1);
    expect(result.amendmentAccepted).toBe(true);
    expect(result.nonsenseRejected).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/migrate.test.ts
```

Expected: FAIL — `migrateLegacySubmissions` is not a function, or once it exists, `amendmentAccepted` is `false` because the old CHECK survives `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 3: Write `src/store/migrate.ts`**

```ts
/**
 * Rebuilding a table to change a constraint SQLite will not let us alter.
 *
 * `ALTER TABLE` can add a column and rename things. It cannot change a CHECK constraint, and
 * `CREATE TABLE IF NOT EXISTS` silently keeps the old definition — so a store created before a
 * constraint widened keeps refusing values the current code considers valid, with no error at
 * deploy time and a failure only when the first new value is written.
 *
 * The procedure is SQLite's documented one, minus the parts a Durable Object does not need: DO
 * SQLite gives us one implicit transaction per turn of the input gate, and `applySchema` runs
 * inside the constructor, so no other work interleaves with these statements.
 *
 * Detection is on `sqlite_master.sql` — the stored CREATE statement — searched for a marker that
 * only the current definition contains. Cheap, and it makes the rebuild idempotent: a fresh
 * database gets the current definition from `CREATE TABLE IF NOT EXISTS` and this does nothing.
 */

export type RebuildSpec = {
  /** The table to rebuild. */
  table: string;
  /** A substring present in the wanted definition and absent from every older one. */
  wantedMarker: string;
  /** The full `CREATE TABLE <table>_rebuilt (...)` statement, with the wanted constraints. */
  createSql: string;
  /** Columns to carry over, in order. Must exist in both definitions. */
  columns: string[];
  /** Index statements to re-issue afterwards; dropping a table drops its indexes. */
  indexes?: string[];
};

/** The stored CREATE statement for a table, or null if it does not exist. */
export function tableDefinition(sql: SqlStorage, table: string): string | null {
  const row = sql
    .exec<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
    )
    .toArray()[0];
  return row?.sql ?? null;
}

/**
 * Rebuild `spec.table` if its stored definition lacks `spec.wantedMarker`.
 *
 * Returns true if it rebuilt. Absent table returns false: `applySchema` creates it correctly a few
 * lines earlier, so there is nothing to migrate.
 */
export function rebuildTable(sql: SqlStorage, spec: RebuildSpec): boolean {
  const existing = tableDefinition(sql, spec.table);
  if (existing === null) return false;
  if (existing.includes(spec.wantedMarker)) return false;

  const staging = `${spec.table}_rebuilt`;
  const columnList = spec.columns.join(", ");

  sql.exec(`DROP TABLE IF EXISTS ${staging}`);
  sql.exec(spec.createSql);
  sql.exec(
    `INSERT INTO ${staging} (${columnList}) SELECT ${columnList} FROM ${spec.table}`,
  );
  sql.exec(`DROP TABLE ${spec.table}`);
  sql.exec(`ALTER TABLE ${staging} RENAME TO ${spec.table}`);
  for (const index of spec.indexes ?? []) sql.exec(index);
  return true;
}
```

- [ ] **Step 4: Wire it into `applySchema`**

In `src/store/schema.ts`, add the import and change the `submissions` block. The `CREATE TABLE IF NOT EXISTS submissions` statement gains `'amendment'`; immediately after it, add the rebuild for stores that already exist:

```ts
import { rebuildTable } from "./migrate.js";
```

Change the `kind` line of the existing `CREATE TABLE IF NOT EXISTS submissions` to:

```sql
    kind TEXT NOT NULL CHECK (kind IN ('overtime', 'amendment')),
```

Then directly after that `sql.exec(...)` call:

```ts
  // `CREATE TABLE IF NOT EXISTS` above is a no-op on a store that already exists, so a database
  // created before amendments keeps `CHECK (kind IN ('overtime'))` and refuses every amendment.
  // SQLite cannot alter a CHECK, so the table is rebuilt. See `rebuildTable`.
  rebuildTable(sql, {
    table: "submissions",
    wantedMarker: "'amendment'",
    createSql: `CREATE TABLE submissions_rebuilt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      kind TEXT NOT NULL CHECK (kind IN ('overtime', 'amendment')),
      requested_for TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('draft', 'pending', 'approved', 'rejected', 'withdrawn')),
      submitted_at INTEGER,
      current_step INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL CHECK (minutes >= 0),
      reason TEXT NOT NULL,
      calculation_inputs TEXT CHECK (
        calculation_inputs IS NULL OR json_valid(calculation_inputs)),
      route_snapshot TEXT NOT NULL CHECK (json_valid(route_snapshot)),
      created_by INTEGER REFERENCES employees(id)
    ) STRICT`,
    columns: [
      "id", "employee_id", "kind", "requested_for", "state", "submitted_at", "current_step",
      "minutes", "reason", "calculation_inputs", "route_snapshot", "created_by",
    ],
  });
```

- [ ] **Step 5: Run the test**

```bash
pnpm exec vitest run __tests__/migrate.test.ts
```

Expected: PASS. If `DROP TABLE submissions` fails because `approval_events` references it, foreign keys are enforced — do **not** reach for `PRAGMA foreign_keys`, which DO SQLite restricts. Report the failure and stop; the fallback is to widen the constraint by dropping the CHECK from `kind` entirely and relying on `@validateRpc()` plus TypeScript, which is a decision for the plan's author, not the implementer.

- [ ] **Step 6: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): let submissions carry a second kind

SQLite cannot alter a CHECK constraint and CREATE TABLE IF NOT EXISTS keeps
the old one, so a store created before amendments would refuse every one of
them -- silently at deploy, loudly at the first write. \`rebuildTable\` runs
SQLite's documented rebuild when the stored definition lacks a marker the
current one has, and does nothing on a fresh database."
```

---

## Task 2: `punches.source` accepts `'amendment'`

**Why separate:** `punches` is the append-only table every other record points at, carrying self-referencing `supersedes_id` chains and two indexes. Rebuilding it is the single riskiest operation in this plan and deserves its own reviewer gate. If Task 1's rebuild failed, stop here.

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/schema.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/worker.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/migrate.test.ts`

**Interfaces:**
- Consumes: `rebuildTable` from Task 1.
- Produces: `punches.source` accepting `'gadget' | 'admin' | 'import' | 'amendment'`.

- [ ] **Step 1: Write the failing test**

Add to `KintaiFacetHost` in `__tests__/worker.ts`:

```ts
  /**
   * Build `punches` with its PRE-amendment source CHECK, including a supersedes chain, then run
   * the real `applySchema` over it. A rebuild must preserve the chain and rebuild both indexes.
   */
  migrateLegacyPunches(): {
    ids: number[];
    supersedes: (number | null)[];
    amendmentAccepted: boolean;
    nonsenseRejected: boolean;
    indexes: string[];
  } {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_number TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, joined_on TEXT NOT NULL, left_on TEXT,
      department TEXT, employment_type TEXT, designated_approver_id INTEGER
    ) STRICT`);
    sql.exec(
      `INSERT INTO employees (id, employee_number, display_name, joined_on)
       VALUES (1, 'E1', 'Legacy', '2026-04-01')`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      work_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('gadget', 'admin', 'import')),
      supersedes_id INTEGER REFERENCES punches(id),
      amended_by INTEGER REFERENCES employees(id),
      amend_reason TEXT
    ) STRICT`);
    sql.exec(
      `INSERT INTO punches (id, employee_id, work_date, kind, occurred_at, recorded_at, source)
       VALUES (1, 1, '2026-07-03', 'in', 100, 100, 'gadget')`,
    );
    sql.exec(
      `INSERT INTO punches (id, employee_id, work_date, kind, occurred_at, recorded_at, source,
                            supersedes_id, amended_by, amend_reason)
       VALUES (2, 1, '2026-07-03', 'in', 90, 200, 'admin', 1, 1, 'was early')`,
    );

    applySchema(sql);

    let amendmentAccepted = false;
    try {
      sql.exec(
        `INSERT INTO punches (id, employee_id, work_date, kind, occurred_at, recorded_at, source)
         VALUES (3, 1, '2026-07-03', 'out', 300, 300, 'amendment')`,
      );
      amendmentAccepted = true;
    } catch { /* left false */ }

    let nonsenseRejected = false;
    try {
      sql.exec(
        `INSERT INTO punches (id, employee_id, work_date, kind, occurred_at, recorded_at, source)
         VALUES (4, 1, '2026-07-03', 'out', 400, 400, 'nonsense')`,
      );
    } catch { nonsenseRejected = true; }

    return {
      ids: sql.exec<{ id: number }>(`SELECT id FROM punches ORDER BY id`)
        .toArray().map((r) => r.id),
      supersedes: sql.exec<{ supersedes_id: number | null }>(
        `SELECT supersedes_id FROM punches ORDER BY id`).toArray().map((r) => r.supersedes_id),
      amendmentAccepted,
      nonsenseRejected,
      indexes: sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'punches'
           AND name NOT LIKE 'sqlite_%' ORDER BY name`).toArray().map((r) => r.name),
    };
  }
```

Add to `__tests__/migrate.test.ts`:

```ts
describe("punches.source rebuild", () => {
  it("preserves the supersedes chain and rebuilds both indexes", async () => {
    const host = env.KINTAI_FACET_HOST.getByName("migrate-punches");
    const result = await host.migrateLegacyPunches();

    expect(result.ids).toEqual([1, 2, 3]);
    expect(result.supersedes).toEqual([null, 1, null]);
    expect(result.amendmentAccepted).toBe(true);
    expect(result.nonsenseRejected).toBe(true);
    expect(result.indexes).toEqual(["punches_by_day", "punches_by_time"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run __tests__/migrate.test.ts
```

Expected: FAIL on `amendmentAccepted` being `false`.

- [ ] **Step 3: Widen the CHECK and add the rebuild**

In `src/store/schema.ts`, change the `source` line of `CREATE TABLE IF NOT EXISTS punches` to:

```sql
    source TEXT NOT NULL CHECK (source IN ('gadget', 'admin', 'import', 'amendment')),
```

Read the two existing `CREATE INDEX IF NOT EXISTS punches_by_day` and `punches_by_time` statements in the file and pass them to the rebuild **verbatim** — they must not drift from the ones above. Add after the index statements:

```ts
  // A punch that entered the record through an approved amendment is not one somebody tapped, and
  // the record should say which it was. Same rebuild as `submissions`, for the same reason: the
  // CHECK above is a no-op on an existing store. `punches` is append-only and self-referencing, so
  // the copy carries `id` explicitly to keep `supersedes_id` pointing at the same rows.
  rebuildTable(sql, {
    table: "punches",
    wantedMarker: "'amendment'",
    createSql: `CREATE TABLE punches_rebuilt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      work_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('gadget', 'admin', 'import', 'amendment')),
      supersedes_id INTEGER REFERENCES punches(id),
      amended_by INTEGER REFERENCES employees(id),
      amend_reason TEXT
    ) STRICT`,
    columns: [
      "id", "employee_id", "work_date", "kind", "occurred_at", "recorded_at", "source",
      "supersedes_id", "amended_by", "amend_reason",
    ],
    indexes: [/* the two CREATE INDEX IF NOT EXISTS statements, copied verbatim */],
  });
```

- [ ] **Step 4: Run the test and confirm the index shape is unchanged**

```bash
pnpm exec vitest run __tests__/migrate.test.ts && pnpm exec vitest run
```

Expected: PASS, and all 330 prior tests still pass. `punches_by_time` is what keeps the open-shift lookup off a full scan; if it is missing after a rebuild, night-shift attribution degrades silently.

- [ ] **Step 5: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): mark punches that entered through an amendment

A punch written by an approved correction is not one somebody tapped. The
rebuild carries \`id\` explicitly so the supersedes chain keeps pointing at the
same rows, and re-issues both indexes, since dropping a table drops them."
```

---

## Task 3: The `amendment_requests` record

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/amendments.ts`
- Create: `packages/gatekeeper-kintai/__tests__/amendments.test.ts`
- Modify: `packages/gatekeeper-kintai/src/store/schema.ts`
- Modify: `packages/gatekeeper-kintai/src/types.ts`

**Interfaces:**
- Produces:
  - `type AmendmentRequest = { submission_id: number; target_punch_id: number | null; work_date: string; kind: PunchKind; occurred_at: number; applied_punch_id: number | null }`
  - `getAmendment(sql, submissionId): AmendmentRequest | null`
  - `pendingAmendmentForPunch(sql, punchId): number | null` — the submission id of an undecided amendment against that punch, or null.

- [ ] **Step 1: Add the table to `applySchema`**

In `src/store/schema.ts`, after the `submissions` block and its rebuild:

```ts
  // What a correction needs and overtime does not. Keyed one-to-one on the submission rather than
  // carrying its own id: an amendment IS a submission, and a second identity for the same thing is
  // how two rows for one fact start disagreeing.
  //
  // `target_punch_id` NULL means "add a punch that was never recorded" -- the forgotten clock-out,
  // which `correctPunch` cannot express because it supersedes an existing row. Non-NULL means
  // "that punch says the wrong time".
  sql.exec(`CREATE TABLE IF NOT EXISTS amendment_requests (
    submission_id INTEGER PRIMARY KEY REFERENCES submissions(id),
    target_punch_id INTEGER REFERENCES punches(id),
    work_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
    occurred_at INTEGER NOT NULL,
    applied_punch_id INTEGER REFERENCES punches(id)
  ) STRICT`);

  // The uniqueness rule "one pending amendment per punch" is enforced in `amendments.ts` rather
  // than here, because it depends on the submission's state, which lives in another table.
  sql.exec(`CREATE INDEX IF NOT EXISTS amendment_requests_by_target
    ON amendment_requests (target_punch_id)`);
```

- [ ] **Step 2: Write the failing test**

Create `__tests__/amendments.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const DAY = "2026-07-03";
const NINE_AM = Date.parse("2026-07-03T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`amendments-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E900", displayName: "Tanaka", joinedOn: "2026-04-01",
  });
});

describe("the amendment record", () => {
  it("returns null for a submission that is not an amendment", async () => {
    expect(await store.getAmendment(999)).toBeNull();
  });

  it("reports no pending amendment for an untouched punch", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
```

Expected: FAIL — `store.getAmendment is not a function`.

- [ ] **Step 4: Write `src/store/amendments.ts`**

```ts
import type { EmployeeId, PunchKind } from "../types.js";

/**
 * A request to change one punch, hung off the submission that carries its approval.
 *
 * One request changes one punch. A day needing both a corrected clock-in and an added clock-out is
 * two requests -- separately approvable, separately auditable, and a manager can approve one and
 * reject the other. The alternative, a request that replaces a day wholesale, records "the day
 * changed" rather than which punch was wrong and why.
 */
export type AmendmentRequest = {
  submission_id: number;
  target_punch_id: number | null;
  work_date: string;
  kind: PunchKind;
  occurred_at: number;
  applied_punch_id: number | null;
};

const COLUMNS =
  `submission_id, target_punch_id, work_date, kind, occurred_at, applied_punch_id`;

/** The amendment detail for a submission, or null if that submission is not an amendment. */
export function getAmendment(sql: SqlStorage, submissionId: number): AmendmentRequest | null {
  return sql
    .exec<AmendmentRequest>(
      `SELECT ${COLUMNS} FROM amendment_requests WHERE submission_id = ?`, submissionId,
    )
    .toArray()[0] ?? null;
}

/**
 * The submission id of an undecided amendment against `punchId`, or null.
 *
 * "Undecided" is `draft` or `pending`: a returned amendment is still in play and its target must
 * stay reserved, while `approved`, `rejected` and `withdrawn` are all finished. Without this, two
 * approvers acting on two requests for the same punch produce two corrections, the second
 * superseding the first, and the record shows a change nobody asked for twice.
 */
export function pendingAmendmentForPunch(sql: SqlStorage, punchId: number): number | null {
  const row = sql
    .exec<{ submission_id: number }>(
      `SELECT a.submission_id FROM amendment_requests a
       JOIN submissions s ON s.id = a.submission_id
       WHERE a.target_punch_id = ? AND s.state IN ('draft', 'pending')
       ORDER BY a.submission_id LIMIT 1`,
      punchId,
    )
    .toArray()[0];
  return row?.submission_id ?? null;
}
```

- [ ] **Step 5: Expose both on `KintaiStore`**

In `src/store/kintai-store.ts`, import from `./amendments.js` and add, following the existing one-line-delegate pattern:

```ts
  async getAmendment(submissionId: number): Promise<AmendmentRequest | null> {
    return getAmendment(this.sql, submissionId);
  }

  async pendingAmendmentForPunch(punchId: number): Promise<number | null> {
    return pendingAmendmentForPunch(this.sql, punchId);
  }
```

- [ ] **Step 6: Run the tests, then every gate, then commit**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): add the amendment request record

Keyed one-to-one on the submission it hangs off, because an amendment IS a
submission and a second identity for one fact is how two rows start
disagreeing. A null \`target_punch_id\` is the whole difference between fixing
a punch's time and adding one that was never recorded."
```

---

## Task 4: Filing an amendment, with its validation

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/amendments.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Modify: `packages/gatekeeper-kintai/src/input.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/amendments.test.ts`

**Interfaces:**
- Consumes: `getAmendment`, `pendingAmendmentForPunch` (Task 3); `resolveRoute`, `assertSatisfiable`, `assertApproverReachable` (existing, `src/store/submissions.ts` and `src/store/org.ts`).
- Produces:
  ```ts
  type NewAmendment = {
    employeeId: EmployeeId;
    targetPunchId: number | null;
    workDate: string;
    kind: PunchKind;
    occurredAt: number;
    reason: string;
    now: number;
    department: string | null;
    employmentType: string | null;
    createdBy: EmployeeId;
  };
  fileAmendment(sql: SqlStorage, input: NewAmendment): number  // returns submission id
  ```
- Error classes produced: `AmendmentTargetError`, `PunchAlreadyAmendedError`, `FutureOccurrenceError`, `DuplicateAmendmentError`.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/amendments.test.ts`. These are the rules; each must fail before its implementation exists.

```ts
describe("filing an amendment", () => {
  it("refuses a target punch that does not exist", async () => {
    await expect(store.fileAmendment({
      employeeId, targetPunchId: 9999, workDate: DAY, kind: "in",
      occurredAt: NINE_AM, reason: "typo", now: NINE_AM + 1000,
      department: null, employmentType: null, createdBy: employeeId,
    })).rejects.toThrow(/KINTAI_AMENDMENT_TARGET/);
  });

  it("refuses a target punch that has already been superseded", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.correctPunch(original, {
      employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1000, source: "admin",
    }, employeeId, "earlier", NINE_AM + 500);

    await expect(store.fileAmendment({
      employeeId, targetPunchId: original, workDate: DAY, kind: "in",
      occurredAt: NINE_AM - 2000, reason: "again", now: NINE_AM + 1000,
      department: null, employmentType: null, createdBy: employeeId,
    })).rejects.toThrow(/KINTAI_AMENDMENT_TARGET/);
  });

  it("refuses an occurrence in the future", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await expect(store.fileAmendment({
      employeeId, targetPunchId: punchId, workDate: DAY, kind: "in",
      occurredAt: NINE_AM + 60_000, reason: "later", now: NINE_AM + 1000,
      department: null, employmentType: null, createdBy: employeeId,
    })).rejects.toThrow(/KINTAI_FUTURE_OCCURRENCE/);
  });

  it("refuses a second pending amendment against the same punch", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const managerId = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId, managerId, relation: "reports_to", validFrom: Date.parse("2026-04-01"),
    });

    await store.fileAmendment({
      employeeId, targetPunchId: punchId, workDate: DAY, kind: "in",
      occurredAt: NINE_AM - 1000, reason: "first", now: NINE_AM + 1000,
      department: null, employmentType: null, createdBy: employeeId,
    });

    await expect(store.fileAmendment({
      employeeId, targetPunchId: punchId, workDate: DAY, kind: "in",
      occurredAt: NINE_AM - 2000, reason: "second", now: NINE_AM + 2000,
      department: null, employmentType: null, createdBy: employeeId,
    })).rejects.toThrow(/KINTAI_DUPLICATE_AMENDMENT/);
  });

  it("refuses adding a punch the day already has at that time", async () => {
    const managerId = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId, managerId, relation: "reports_to", validFrom: Date.parse("2026-04-01"),
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });

    await expect(store.fileAmendment({
      employeeId, targetPunchId: null, workDate: DAY, kind: "in",
      occurredAt: NINE_AM, reason: "adding again", now: NINE_AM + 1000,
      department: null, employmentType: null, createdBy: employeeId,
    })).rejects.toThrow(/KINTAI_AMENDMENT_TARGET/);
  });

  it("files a missing punch with no target, and links it to the submission", async () => {
    const managerId = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId, managerId, relation: "reports_to", validFrom: Date.parse("2026-04-01"),
    });

    const submissionId = await store.fileAmendment({
      employeeId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: NINE_AM + 9 * 3600_000, reason: "forgot to clock out",
      now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: employeeId,
    });

    const amendment = await store.getAmendment(submissionId);
    expect(amendment).toMatchObject({
      target_punch_id: null, work_date: DAY, kind: "out", applied_punch_id: null,
    });
    const submission = await store.getSubmission(submissionId);
    expect(submission.kind).toBe("amendment");
    expect(submission.state).toBe("pending");
    expect(submission.minutes).toBe(0);
  });
});
```

> **On `addOrgEdge` and `correctPunch`:** use whatever the existing store method names are — check `src/store/kintai-store.ts` and follow the calls in `__tests__/submissions.test.ts`. Do not invent a signature; if the helper you need is not exposed on `KintaiStore`, expose it the same way its neighbours are.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
```

Expected: FAIL — `store.fileAmendment is not a function`.

- [ ] **Step 3: Add the input assertions**

In `src/input.ts`, following the existing `assertWorkDate` / `assertMinutes` pattern exactly:

```ts
const PUNCH_KINDS = ["in", "out", "break_start", "break_end"] as const;

export function assertPunchKind(label: string, value: string): void {
  if (!(PUNCH_KINDS as readonly string[]).includes(value)) {
    throw new InvalidInputError(
      `${label} must be one of ${PUNCH_KINDS.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * A punch may not be dated in the future.
 *
 * Not hygiene. A future-dated punch is picked up as an open shift by `openShiftWorkDate`, and a
 * genuine punch arriving before it can then be silently discarded by duplicate suppression --
 * confirmed by review, and rated low severity only because nothing let a human choose a punch
 * time. Amendments are the first path that does.
 */
export function assertNotFuture(label: string, value: number, now: number): void {
  if (!Number.isFinite(value)) {
    throw new InvalidInputError(`${label} must be a finite timestamp, got ${value}`);
  }
  if (value > now) {
    throw new InvalidInputError(`${label} may not be in the future`);
  }
}
```

- [ ] **Step 4: Write `fileAmendment`**

Append to `src/store/amendments.ts`:

```ts
export class AmendmentTargetError extends Error {
  constructor(detail: string) {
    super(`KINTAI_AMENDMENT_TARGET: ${detail}`);
    this.name = "AmendmentTargetError";
  }
}

export class FutureOccurrenceError extends Error {
  constructor() {
    super(
      `KINTAI_FUTURE_OCCURRENCE: a punch may not be dated in the future. Give the time the ` +
      `punch should have been made, not a time still to come.`,
    );
    this.name = "FutureOccurrenceError";
  }
}

export class DuplicateAmendmentError extends Error {
  constructor(submissionId: number) {
    super(
      `KINTAI_DUPLICATE_AMENDMENT: submission ${submissionId} already asks to change this punch ` +
      `and has not been decided. Withdraw it before filing another.`,
    );
    this.name = "DuplicateAmendmentError";
  }
}

/**
 * File a request to change one punch. Returns the submission id.
 *
 * The submission is created `pending` at step 0 like any other, so everything downstream --
 * the queue, withdraw, resubmit, the approval state machine -- works on it without knowing it is
 * an amendment. `minutes` is 0: the column belongs to overtime, an amendment's effect on credited
 * minutes can be negative, and it is not known until the correction is applied. It is never read
 * for an amendment.
 */
export function fileAmendment(sql: SqlStorage, input: NewAmendment): number {
  assertNotFuture("occurredAt", input.occurredAt, input.now);

  if (input.targetPunchId !== null) {
    const target = sql
      .exec<{ employee_id: number; work_date: string; kind: string; superseded: number }>(
        `SELECT p.employee_id, p.work_date, p.kind,
                EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id) AS superseded
         FROM punches p WHERE p.id = ?`,
        input.targetPunchId,
      )
      .toArray()[0];

    if (!target) {
      throw new AmendmentTargetError(`no punch with id ${input.targetPunchId}`);
    }
    if (target.employee_id !== input.employeeId) {
      throw new AmendmentTargetError(`punch ${input.targetPunchId} belongs to another employee`);
    }
    // A superseded punch is history. An amendment must name the row that is current now, or two
    // requests filed against the same original both "succeed" and the later one silently loses.
    if (target.superseded) {
      throw new AmendmentTargetError(
        `punch ${input.targetPunchId} has already been corrected. Amend the correction instead.`,
      );
    }
    if (target.work_date !== input.workDate || target.kind !== input.kind) {
      throw new AmendmentTargetError(
        `an amendment may change when a punch happened, not its work date or kind`,
      );
    }

    const pending = pendingAmendmentForPunch(sql, input.targetPunchId);
    if (pending !== null) throw new DuplicateAmendmentError(pending);
  } else {
    // Adding a punch the day already has. Not caught by anything downstream: `recordPunch`'s
    // duplicate suppression is keyed on a sixty-second window around the CURRENT instant, and an
    // amendment's `occurred_at` is in the past, so it would insert a second identical punch and
    // the day would pair wrongly from there on.
    const existing = sql
      .exec<{ id: number }>(
        `SELECT p.id FROM punches p
         WHERE p.employee_id = ? AND p.work_date = ? AND p.kind = ? AND p.occurred_at = ?
           AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
         LIMIT 1`,
        input.employeeId, input.workDate, input.kind, input.occurredAt,
      )
      .toArray()[0];
    if (existing) {
      throw new AmendmentTargetError(
        `a ${input.kind} punch is already recorded at that time on ${input.workDate}`,
      );
    }
  }

  // Filed for the date the punch belongs to, not the date it is being filed on, so exemption and
  // approver-reachability are evaluated against the day worked. Same reasoning as `submitOvertime`.
  const requestedAt = Date.parse(input.workDate);
  assertApproverReachable(sql, input.employeeId, requestedAt);

  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: 0,
  });
  assertAmendmentSatisfiable(snapshot, input.employeeId, input.createdBy);

  const submission = sql
    .exec<{ id: number }>(
      `INSERT INTO submissions
         (employee_id, kind, requested_for, state, submitted_at, current_step,
          minutes, reason, calculation_inputs, route_snapshot, created_by)
       VALUES (?, 'amendment', ?, 'pending', ?, 0, 0, ?, NULL, ?, ?) RETURNING id`,
      input.employeeId, input.workDate, input.now, input.reason,
      JSON.stringify(snapshot), input.createdBy,
    )
    .one();

  sql.exec(
    `INSERT INTO amendment_requests
       (submission_id, target_punch_id, work_date, kind, occurred_at, applied_punch_id)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    submission.id, input.targetPunchId, input.workDate, input.kind, input.occurredAt,
  );

  return submission.id;
}
```

`assertAmendmentSatisfiable` is Task 5. For this task, call `assertSatisfiable(snapshot, input.employeeId)` — the existing export — and Task 5 replaces the call.

- [ ] **Step 5: Expose `fileAmendment` on `KintaiStore`, run the tests**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
```

Expected: PASS, all five.

- [ ] **Step 6: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): file a request to change one punch

Refuses a target that is missing, belongs to someone else, has already been
superseded, or already has an undecided request against it. And refuses a
future occurrence: review found a future-dated punch is read as an open shift
and can cause a genuine punch to be silently discarded, rated low only because
nothing let a human choose a punch time. This is that path."
```

---

## Task 5: Nobody approves what they filed

**Why its own task:** this is the authority change, and it is the finding most likely to be quietly lost in a later refactor. It deserves a reviewer who is looking at nothing else.

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/submissions.ts`
- Modify: `packages/gatekeeper-kintai/src/store/amendments.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/submissions.test.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/amendments.test.ts`

**Interfaces:**
- Produces: `FiledBySelfError` (code `KINTAI_FILED_BY_APPROVER`); `assertAmendmentSatisfiable(snapshot, employeeId, createdBy)`.

**The rule:** `checkMayAct` refuses when the actor is the submission's `employee_id`. With managers filing on behalf of workers, the filer and the employee are different people, so that check no longer catches a manager who files a correction for their report and then approves it — one person originating and authorising a change to payroll input, with nothing in the trail marking it. The actor must be neither.

`created_by` and `employee_id` are the same person for every overtime submission today, so the new refusal is a no-op there and cannot regress it. Pin that with a test rather than asserting it.

- [ ] **Step 1: Write the failing tests**

In `__tests__/amendments.test.ts`:

```ts
describe("nobody approves what they filed", () => {
  it("refuses an approval by the employee who filed it for someone else", async () => {
    const workerId = await store.createEmployee({
      employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01",
    });
    const foremanId = await store.createEmployee({
      employeeNumber: "F1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    const bossId = await store.createEmployee({
      employeeNumber: "B1", displayName: "Ito", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId: workerId, managerId: foremanId, relation: "reports_to",
      validFrom: Date.parse("2026-04-01"),
    });
    await store.addOrgEdge({
      employeeId: foremanId, managerId: bossId, relation: "reports_to",
      validFrom: Date.parse("2026-04-01"),
    });

    const submissionId = await store.fileAmendment({
      employeeId: workerId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: NINE_AM + 9 * 3600_000, reason: "worker forgot",
      now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: foremanId,
    });

    await expect(store.actOnSubmission({
      submissionId, actorId: foremanId, action: "approve", now: NINE_AM + 21 * 3600_000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
  });

  it("lets a different approver decide the same request", async () => {
    const workerId = await store.createEmployee({
      employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01",
    });
    const foremanId = await store.createEmployee({
      employeeNumber: "F1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    const bossId = await store.createEmployee({
      employeeNumber: "B1", displayName: "Ito", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId: workerId, managerId: foremanId, relation: "reports_to",
      validFrom: Date.parse("2026-04-01"),
    });
    await store.addOrgEdge({
      employeeId: workerId, managerId: bossId, relation: "reports_to",
      validFrom: Date.parse("2026-04-01"),
    });

    const submissionId = await store.fileAmendment({
      employeeId: workerId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: NINE_AM + 9 * 3600_000, reason: "worker forgot",
      now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: foremanId,
    });

    const state = await store.actOnSubmission({
      submissionId, actorId: bossId, action: "approve", now: NINE_AM + 21 * 3600_000,
    });
    expect(state).toBe("approved");
  });
});

> **On the second test's org shape:** the boss is a manager of the *worker*, not only of the
> foreman, so a single-step `manager_of` route has two live managers and the boss can act. If your
> route resolves differently, adjust the org rather than the assertion — the point being pinned is
> that a request the filer cannot approve is not thereby unapprovable.
```

In `__tests__/submissions.test.ts`, add one test asserting an ordinary overtime submission — where `created_by` is the employee — still refuses self-approval with `KINTAI_SELF_APPROVAL` and not the new code, so the two rules stay distinguishable.

> Fill in the second test's body by copying the first test's setup verbatim. Do not write "same as above" in the code.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
```

Expected: FAIL — the foreman's approval succeeds.

- [ ] **Step 3: Add the refusal to `checkMayAct`**

In `src/store/submissions.ts`, add the error class beside `SelfApprovalError`:

```ts
export class FiledBySelfError extends Error {
  constructor() {
    super(
      `KINTAI_FILED_BY_APPROVER: this request was filed by you, and nobody may approve a change ` +
      `they filed themselves. Someone else in the approval route must decide it.`,
    );
    this.name = "FiledBySelfError";
  }
}
```

And in `checkMayAct`, immediately after the existing self-approval check:

```ts
  if (input.actorId === submission.employee_id) throw new SelfApprovalError();
  // Filing on behalf of a report means the filer and the employee are no longer the same person,
  // so the check above stops being enough: a manager could file a correction for their report and
  // approve it, originating and authorising one change to payroll input with nothing in the trail
  // saying so. `created_by` equals `employee_id` for every overtime submission, so this is a no-op
  // there and cannot regress it.
  if (submission.created_by !== null && input.actorId === submission.created_by) {
    throw new FiledBySelfError();
  }
```

- [ ] **Step 4: Refuse at filing time when the filer is the only possible approver**

A request nobody can approve should be refused where the person can still do something about it — the employee files it themselves instead. In `src/store/amendments.ts`:

```ts
/**
 * `assertSatisfiable`, plus the filer.
 *
 * A step pinned to the filer can never be satisfied, because `checkMayAct` refuses them. Catch it
 * at filing time: the alternative is a request sitting in a queue that nobody is able to decide,
 * discovered only when somebody tries.
 */
export function assertAmendmentSatisfiable(
  snapshot: RouteSnapshot, employeeId: EmployeeId, createdBy: EmployeeId,
): void {
  assertSatisfiable(snapshot, employeeId);
  if (createdBy === employeeId) return;

  const filerPinned = snapshot.steps.find(
    (step) => step.approverKind === "employee" && step.approverEmployeeId === createdBy,
  );
  if (filerPinned) {
    throw new NoRouteError(
      `KINTAI_NO_ROUTE: step ${filerPinned.stepIndex} of approval route ${snapshot.routeId} names ` +
      `the person filing this request as its approver, and nobody may approve a change they ` +
      `filed. Ask the employee to file it themselves, or ask an administrator to fix the route.`,
    );
  }
}
```

Replace the `assertSatisfiable` call in `fileAmendment` with `assertAmendmentSatisfiable(snapshot, input.employeeId, input.createdBy)`.

> **Note for the implementer:** this catches only a step *pinned* to a named employee. A `manager_of` step whose only live manager happens to be the filer is not caught here, because the set of managers is evaluated at approval time and can change. That request will be refused at approval instead, with `KINTAI_FILED_BY_APPROVER`. Say so in your report; do not try to close it by re-resolving the org at filing time, which would make filing depend on state the snapshot deliberately freezes.

- [ ] **Step 5: Run the tests**

```bash
pnpm exec vitest run __tests__/amendments.test.ts __tests__/submissions.test.ts
```

Expected: PASS. Every prior submissions test must still pass unchanged — if any needed editing, `created_by` was not what you assumed and you should stop and report.

- [ ] **Step 6: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "fix(kintai): refuse an approval by whoever filed the request

The self-approval check compares the actor against whose hours these are, which
was sufficient while the filer and the employee were always the same person.
Filing on behalf of a report separates them, and a foreman could file a
correction for their worker and approve it -- originating and authorising a
change to payroll input, with nothing in the trail marking it. \`created_by\`
equals \`employee_id\` for every overtime submission, so this is a no-op there."
```

---

## Task 6: Applying an approved amendment, atomically

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/amendments.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/amendments.test.ts`

**Interfaces:**
- Consumes: `actOnSubmission` (existing), `correctPunch` and `recordPunch` internals from `src/store/punches.ts`.
- Produces: `actOnAmendment(sql, input: ActInput): { state: SubmissionState; appliedPunchId: number | null }`.

**The two things that make this task delicate:**

1. **It bypasses the period lock deliberately.** This is the one write that may enter a closed month; it is why locks live in the facet rather than the store's write functions, as `src/kintai.ts` already says at three call sites. `actOnAmendment` must not call `assertWritable`, and the facet must not call it around this path.
2. **It must be one turn of the input gate.** Deciding the approval, writing the punch, and recording the link are one fact. A reproduced double-apply race in this package was caused by taking a claim after an outgoing RPC. There must be no `await` between the decision and the write — which is why this is a single synchronous store function, not a facet orchestrating three calls.

- [ ] **Step 1: Write the failing tests**

```ts
describe("applying an approved amendment", () => {
  it("supersedes the target punch and links the result", async () => {
    // worker + manager, a punch at NINE_AM, an amendment moving it to NINE_AM - 1800_000,
    // then the manager approves.
    // Assert: state "approved";
    //         currentPunches has one 'in' at NINE_AM - 1800_000;
    //         the new punch has source 'amendment' and supersedes_id === the original;
    //         getAmendment(submissionId).applied_punch_id === the new punch id;
    //         the original row is still readable.
  });

  it("writes a missing punch that has no target", async () => {
    // amendment with targetPunchId null, kind 'out'. After approval, getDay shows a paired day.
  });

  it("writes nothing while the submission is still pending a second approver", async () => {
    // a two-step route: after the first approval, applied_punch_id is still null and the day
    // is unchanged.
  });

  it("applies into a locked period", async () => {
    // lock the period covering DAY, then approve an amendment for it.
    // Assert the punch is written, and that an ordinary punch to the same day is still refused
    // with KINTAI_PERIOD_LOCKED immediately afterwards.
  });

  it("produces one punch when two approvers act concurrently", async () => {
    // Promise.all of two actOnSubmission calls on a one-step any_of route.
    // Assert exactly one punch with source 'amendment' exists.
  });
});
```

> Write these out fully — setup included, no `// ...` in the committed test file. The comments above say what to assert, not what to paste.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run __tests__/amendments.test.ts
```

- [ ] **Step 3: Write `actOnAmendment`**

```ts
/**
 * Act on an amendment, and apply it in the same turn if that decision approved it.
 *
 * One function rather than a facet calling `actOnSubmission` and then a write, because those are
 * two turns of the input gate with the decision made in the first and acted on in the second. This
 * package has already shipped and fixed a double-apply race of exactly that shape.
 *
 * The period lock is deliberately not consulted. An amendment is the only write allowed into a
 * closed month -- that is what it is for, and what `PeriodLockedError` points users at.
 */
export function actOnAmendment(
  sql: SqlStorage, input: ActInput,
): { state: SubmissionState; appliedPunchId: number | null } {
  const state = actOnSubmission(sql, input);
  if (state !== "approved") return { state, appliedPunchId: null };

  const amendment = getAmendment(sql, input.submissionId);
  if (!amendment) {
    throw new Error(`actOnAmendment: submission ${input.submissionId} has no amendment record`);
  }
  // Belt and braces against a second application: `actOnSubmission` returns "approved" once, but
  // this is a payroll write and the cost of being wrong is a duplicated punch.
  if (amendment.applied_punch_id !== null) {
    return { state, appliedPunchId: amendment.applied_punch_id };
  }

  const submission = getSubmission(sql, input.submissionId);
  const punch: NewPunch = {
    employeeId: submission.employee_id,
    workDate: amendment.work_date,
    kind: amendment.kind,
    now: amendment.occurred_at,
    source: "amendment",
  };

  const punchId = amendment.target_punch_id === null
    // A punch nobody made. `recordPunch` is right here rather than `commitPunch`: the work date
    // comes from the request, which named the day being corrected, not from the clock now.
    ? recordPunch(sql, { ...punch, recordedAt: input.now })
    : correctPunch(
        sql, amendment.target_punch_id, punch, input.actorId,
        submission.reason, input.now,
      );

  sql.exec(
    `UPDATE amendment_requests SET applied_punch_id = ? WHERE submission_id = ?`,
    punchId, input.submissionId,
  );

  return { state, appliedPunchId: punchId };
}
```

> **Two things to check against the real signatures before writing this:** `recordPunch` takes `NewPunch` and derives `recorded_at` from `input.now` — read it, and if it has no `recordedAt` field, add one the way `correctPunch` already takes one, since an amendment's `occurred_at` and the moment it was written are different facts and both matter. `correctPunch`'s `amendedBy` parameter takes the approver here, deliberately: the approver is who is accountable for the record differing. `created_by` on the submission records who asked.
>
> `amendment_requests` is the one table in this feature that is **not** append-only — `applied_punch_id` goes from null to a value, once. That is a link being completed, not history being rewritten, and the punch it points at is itself append-only. Say so in the doc comment.

- [ ] **Step 4: Cover both work-date policies**

Attribution and amendment now interact, and the spec requires both policies exercised. Add:

```ts
  it("applies an amendment for a shift_start employee onto the shift's own date", async () => {
    const nightId = await store.createEmployee({
      employeeNumber: "N1", displayName: "Night", joinedOn: "2026-04-01",
    });
    const managerId = await store.createEmployee({
      employeeNumber: "M2", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.addOrgEdge({
      employeeId: nightId, managerId, relation: "reports_to",
      validFrom: Date.parse("2026-04-01"),
    });
    await store.setWorkDatePolicy(nightId, "shift_start", managerId, NINE_AM);

    // 22:00 JST on DAY, no clock-out. The shift's date is DAY even though the missing
    // clock-out belongs to 06:00 the next morning.
    const shiftStart = Date.parse("2026-07-03T13:00:00Z");
    await store.recordPunch({
      employeeId: nightId, workDate: DAY, kind: "in", now: shiftStart, source: "gadget",
    });

    const submissionId = await store.fileAmendment({
      employeeId: nightId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: shiftStart + 8 * 3600_000, reason: "forgot at the end of the night",
      now: shiftStart + 30 * 3600_000,
      department: null, employmentType: null, createdBy: nightId,
    });
    await store.actOnSubmission({
      submissionId, actorId: managerId, action: "approve", now: shiftStart + 31 * 3600_000,
    });

    // The added punch lands on the work date the REQUEST named, not the JST date of its
    // `occurred_at` -- which is the next day. An amendment writes history; it does not
    // re-run attribution.
    const punches = await store.currentPunches(nightId, DAY);
    expect(punches.map((p) => p.kind)).toEqual(["in", "out"]);
    expect(await store.workedMinutes(nightId, DAY)).toBe(480);
    expect(await store.dayAnomalies(nightId, DAY)).toEqual([]);
  });
```

> This is the assertion most worth arguing with. An added punch takes its work date from the
> request, so a correction never re-runs attribution — deliberate, because the request named a day
> and re-deriving it from `occurred_at` would move the punch somewhere the approver did not agree
> to. Confirm `setWorkDatePolicy`'s real signature on `KintaiStore` before using it.

- [ ] **Step 5: Expose on `KintaiStore`, run the tests, run every gate, commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): apply an approved amendment in the deciding turn

The decision and the punch it writes are one fact, so they are one synchronous
store function rather than a facet making two calls with the input gate open
between them -- the shape of a double-apply race this package has already
shipped and fixed once. Deliberately does not consult the period lock: an
amendment is the only write allowed into a closed month, which is what
PeriodLockedError has been pointing users at."
```

---

## Task 7: The session surface

**Files:**
- Modify: `packages/gatekeeper-kintai/src/kintai.ts`
- Modify: `packages/gatekeeper-kintai/src/types.txt`
- Create: `packages/gatekeeper-kintai/__tests__/amendment-flow.test.ts`

**Interfaces:**
- Produces on `KintaiSession`:
  ```ts
  requestPunchCorrection(punchId: number, occurredAt: number, reason: string): Promise<number>
  requestMissingPunch(
    workDate: string, kind: PunchKind, occurredAt: number, reason: string,
  ): Promise<number>
  requestCorrectionFor(
    employeeId: EmployeeId, punchId: number, occurredAt: number, reason: string,
  ): Promise<number>
  requestMissingPunchFor(
    employeeId: EmployeeId, workDate: string, kind: PunchKind,
    occurredAt: number, reason: string,
  ): Promise<number>
  ```

Two methods rather than one with a nullable field: the surface is read by an agent through `types.txt`, and "correct this punch" and "add a punch that is missing" are different intentions with different validation. An agent choosing between named methods errs less often than one filling in a discriminating field. The `...For` variants are separate again, because filing for someone else is an authority decision and should be visible as one at the call site.

- [ ] **Step 1: Write the failing end-to-end test**

Create `__tests__/amendment-flow.test.ts` driving the whole loop through `KintaiFacetHost` the way `__tests__/facet.test.ts` does — read that file first and follow its setup exactly. The loop:

1. A worker with a manager, linked to an account.
2. The worker punches `in`, forgets `out`. `getDay` shows `unpaired_in`.
3. The worker calls `requestMissingPunch(DAY, "out", ...)`.
4. It appears in the manager's `listPendingApprovals`, carrying its amendment detail.
5. The manager calls `actOnSubmission(id, "approve")`.
6. `getDay` now shows a paired day with credited minutes and no `unpaired_in`.
7. The superseded state is still readable and the added punch has `source: 'amendment'`.

Plus: a `long_span` day is cleared by correcting the clock-out's time, which is the case this whole feature exists for.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm exec vitest run __tests__/amendment-flow.test.ts
```

- [ ] **Step 3: Add the four session methods**

Follow `submitOvertime` in `src/kintai.ts` exactly — `#requireEmployee`, `@validateRpc()`, the `input.ts` assertions, the store call. The four methods differ only in what they pass for `targetPunchId`, `employeeId` and `createdBy`.

Authority for the `...For` variants: the caller must have authority over the target employee at `now` — `hasAuthorityOver` already exists on the store and is what `listPendingApprovals` uses. A caller without it gets `KINTAI_NOT_AUTHORIZED`. Workshop admin is **not** a bypass here: this is the session facet, and admin capability lives on `AdminKintaiApi`.

Every method validates: `assertRequiredText("reason", reason, LIMITS.reason)`, `assertNotFuture("occurredAt", occurredAt, now)`, and for the missing-punch variants `assertWorkDate("workDate", workDate)` and `assertPunchKind("kind", kind)`.

- [ ] **Step 4: Route approvals for amendments through `actOnAmendment`**

`KintaiSession.actOnSubmission` currently calls the store's `actOnSubmission`. It must call `actOnAmendment` when the submission is an amendment. Do this by making the store's `actOnAmendment` handle both — read the submission's `kind` inside it and delegate for `'overtime'` — rather than branching in the facet on a value it has to fetch first, which reintroduces the extra round trip Task 6 exists to avoid.

- [ ] **Step 5: Update `src/types.txt`**

This is agent-facing behaviour. It must say:

- The four new methods, with their parameters and what each returns.
- **That a correction is a request, not an edit.** An agent asked to "fix my clock-out" will otherwise report success when nothing has changed yet. The punch changes on approval and not before.
- The new refusals: `KINTAI_AMENDMENT_TARGET`, `KINTAI_FUTURE_OCCURRENCE`, `KINTAI_DUPLICATE_AMENDMENT`, `KINTAI_FILED_BY_APPROVER`.
- That an amendment is the way through `KINTAI_PERIOD_LOCKED`, which the existing text already promises.
- That filing for another employee requires authority over them.

- [ ] **Step 6: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app && pnpm exec capnweb-validate build --out .wrangler/validate
git add -A && git commit -m "feat(kintai): let an employee ask for a punch to be corrected

Four methods rather than one with a discriminating field, because the surface
is read by an agent and 'correct this punch' and 'add a punch that is missing'
are different intentions with different validation. types.txt says plainly that
a correction takes effect on approval and not before, so an agent asked to fix
a clock-out does not report success over a request nobody has decided."
```

---

## Task 8: Amendment detail in the queue and the lists

**Files:**
- Modify: `packages/gatekeeper-kintai/src/kintai.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/amendment-flow.test.ts`

`listMySubmissions`, `listPendingApprovals` and the `ApprovalQueue`'s `ActionDescription` all currently assume overtime — they describe a submission by its `minutes`, which is 0 for every amendment. An approver seeing "0 minutes" with no other detail cannot make the decision they are being asked for.

- [ ] **Step 1: Write the failing test**

In `__tests__/amendment-flow.test.ts`:

```ts
  it("gives an approver enough detail to decide an amendment", async () => {
    // Worker with a manager; a clock-in at 09:14 that should have been 08:45.
    const original = await store.recordPunch({
      employeeId: workerId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const submissionId = await store.fileAmendment({
      employeeId: workerId, targetPunchId: original, workDate: DAY, kind: "in",
      occurredAt: NINE_AM - 1800_000, reason: "started early on site",
      now: NINE_AM + 3600_000,
      department: null, employmentType: null, createdBy: workerId,
    });

    const pending = await store.pendingApprovalsFor(managerId, NINE_AM + 3600_000);
    const row = pending.find((r) => r.id === submissionId);

    expect(row?.amendment).toEqual({
      targetPunchId: original,
      currentOccurredAt: NINE_AM,
      requestedOccurredAt: NINE_AM - 1800_000,
      workDate: DAY,
      kind: "in",
    });
  });

  it("carries a null current time for a punch that was never recorded", async () => {
    const submissionId = await store.fileAmendment({
      employeeId: workerId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: NINE_AM + 9 * 3600_000, reason: "forgot",
      now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: workerId,
    });

    const pending = await store.pendingApprovalsFor(managerId, NINE_AM + 20 * 3600_000);
    const row = pending.find((r) => r.id === submissionId);

    expect(row?.amendment?.targetPunchId).toBeNull();
    expect(row?.amendment?.currentOccurredAt).toBeNull();
    expect(row?.amendment?.requestedOccurredAt).toBe(NINE_AM + 9 * 3600_000);
  });

  it("leaves an overtime submission with no amendment detail", async () => {
    const submissionId = await store.submitOvertime({
      employeeId: workerId, requestedFor: DAY, minutes: 60, reason: "late job",
      now: NINE_AM + 3600_000, department: null, employmentType: null,
    });

    const pending = await store.pendingApprovalsFor(managerId, NINE_AM + 3600_000);
    expect(pending.find((r) => r.id === submissionId)?.amendment).toBeUndefined();
  });
```

Also assert the `ApprovalQueue`'s `ActionDescription` for an amendment reads as a correction and
not as "0 minutes of overtime" — read how `ActionDescription` is built in `src/kintai.ts` and
follow the existing test for it in `__tests__/facet.test.ts`.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm exec vitest run __tests__/amendment-flow.test.ts
```

Expected: FAIL — `row.amendment` is undefined.

- [ ] **Step 3: Extend the row shape**

Add to the submission row type in `src/store/submissions.ts`:

```ts
/** Amendment detail, present only on rows whose `kind` is `'amendment'`. */
export type AmendmentDetail = {
  targetPunchId: number | null;
  /** What the punch says now. Null when the request is to add a punch that was never recorded. */
  currentOccurredAt: number | null;
  requestedOccurredAt: number;
  workDate: string;
  kind: PunchKind;
};
```

Populate it in the **same query** as the list, not per row — `listPendingApprovals` is called on
every queue render, and a second round trip per submission is how a queue of twenty becomes
twenty-one calls:

```sql
LEFT JOIN amendment_requests a ON a.submission_id = s.id
LEFT JOIN punches t ON t.id = a.target_punch_id
```

selecting `a.target_punch_id`, `t.occurred_at AS current_occurred_at`, `a.occurred_at AS
requested_occurred_at`, `a.work_date`, `a.kind`, and assembling `amendment` only when
`a.submission_id` is non-null.

Apply the same join to `listSubmissionsFor`, so an employee reviewing their own requests sees what
they asked for.

- [ ] **Step 4: Run every gate, then commit**

```bash
pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm exec tsc --noEmit && pnpm run typecheck:app
git add -A && git commit -m "feat(kintai): show an approver what a correction actually changes

An amendment's \`minutes\` is 0, so a queue that describes a submission by its
minutes shows an approver nothing to decide on. The detail is joined in the
same query as the list rather than fetched per row: the queue renders on every
open, and a per-row lookup turns a queue of twenty into twenty-one calls."
```

---

## Task 9: Live verification over real RPC

Not a code task. Nothing here has been exercised through a real Cap'n Web session, and in this package live verification has repeatedly found defects that green tests missed — a sandbox attribute that made a form unusable behind 46 passing tests, and a concurrency bug behind 300.

- [ ] **Step 1: Start the stack**

```bash
pnpm run-local --port 8799
```

If it fails on stale validate output, `rm -rf packages/*/.wrangler/validate` and retry.

- [ ] **Step 2: Drive the loop over `ws://localhost:8799/api`**

Two users, one admin, the real `startAppUi` capability, the gatekeeper session reached as a Gadget reaches it (`newGadget` → `openGadget` → the Kintai capsule → `openSession()`). Follow the procedure in the work-date policy task's verification, which did this successfully.

Verify, and record what you observed for each:

1. A worker files a missing clock-out; the manager sees it and approves; `getDay` changes.
2. The worker cannot approve their own request — `KINTAI_SELF_APPROVAL`.
3. A foreman files for their worker and **cannot** approve it — `KINTAI_FILED_BY_APPROVER`. The foreman's own manager can.
4. A future-dated `occurredAt` is refused by `@validateRpc()` or by `assertNotFuture`, and nothing is written.
5. A correction into a locked month is applied, and an ordinary punch to that day is still refused.
6. A second request against the same punch is refused while the first is undecided.

- [ ] **Step 3: Rebuild the app bundle before committing**

The dev server rewrites `src/generated/app.txt` unminified.

```bash
rm -rf packages/gatekeeper-kintai/dist-app && cd packages/gatekeeper-kintai && pnpm run build
git status  # app.txt must be either unchanged or the minified production build
```

- [ ] **Step 4: Write the verification into the branch**

Commit the observations as a short section in the plan file or a note beside the spec. A verification nobody can find is a verification that did not happen.

---

## Out of scope, deliberately

These are **not** part of this plan and must not be added to it:

- **Screens.** The daily view, the anomaly list, the request form, and amendment cards in the admin UI are the next piece of work and depend on this one.
- **Voiding a punch.** A punch made in error is corrected, not removed.
- **Batching several corrections into one request.**
- **Reopening a closed period.**
- **Amending anything other than a punch.**
