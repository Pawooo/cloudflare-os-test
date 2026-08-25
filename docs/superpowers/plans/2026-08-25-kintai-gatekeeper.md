# Kintai Gatekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/gatekeeper-kintai/`, a first-party Gatekeeper Worker that owns employee identity, the org graph, the append-only attendance record, and the overtime approval workflow for a kintai (勤怠) system.

**Architecture:** A Gatekeeper mints an opaque per-user capability (`accountId`) that the Workshop stores in the user's Durable Object; the Gatekeeper therefore knows who is calling, which a Gadget's DO structurally cannot. All state lives in one SQLite-backed Durable Object (`KintaiStore`) reached through `ctx.exports`. A workspace facet (`KintaiGatekeeper`), imbued with the caller's `accountId`, is the only surface Gadget code can reach; it resolves the caller to an employee before every operation and never trusts a caller-supplied employee identifier.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite (`ctx.storage.sql`), Cap'n Web RPC (`capnweb`, `capnweb-validate`), Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-25-kintai-gatekeeper-design.md`

## Global Constraints

- **This repository is not currently a git repository.** Run `git init && git add -A && git commit -m "chore: baseline"` before Task 1, or drop the commit step from every task. The plan assumes git is available.
- **Package name:** `@gadgets/gatekeeper-kintai`. Directory `packages/gatekeeper-kintai/` — the `gatekeeper-` prefix is what makes `scripts/run-dev-server.ts` discover it and derive the `GATEKEEPER_KINTAI` binding. Do not rename.
- **`compatibility_date: "2026-02-02"`**, matching `packages/gatekeeper-scheduler/wrangler.jsonc`.
- **Toolchain versions come from the catalog.** Use `"catalog:"` for `capnweb`, `capnweb-validate`, `typescript`, `vite`, `vite-plus`, `vitest`, `wrangler`, `@cloudflare/vitest-pool-workers`. Never pin a version directly.
- **All RPC classes carry `@validateRpc()`** from `capnweb-validate`, as every gatekeeper in this repo does.
- **Timestamps are stored as UTC epoch milliseconds (INTEGER).** `work_date` is stored as a `TEXT` `YYYY-MM-DD` JST calendar date and is **always an explicit column, never derived from a timestamp at query time**.
- **Server time is authoritative** for `occurred_at`. Never accept a client-supplied punch timestamp.
- **All SQLite tables use `STRICT`** and `CHECK` constraints on enum columns, matching `packages/mcp-shared/src/action-store.ts`.
- **`punches`, `approval_events` and `audit_log` are append-only.** No code path may `UPDATE` a row in these tables except to set `supersedes_id`'s counterpart column `superseded_by` where the schema defines one. Corrections always insert a new row.
- **No caller-supplied employee identifier is ever trusted.** Every facet method resolves the employee from `accountId` first.

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `worker-configuration.d.ts` | Package scaffolding |
| `src/index.ts` | Barrel — re-exports `worker.js` and types |
| `src/worker.ts` | Worker entrypoint exports (vendor, account, facet, store DO) |
| `src/types.ts` | Shared domain types and enums |
| `src/kintai.ts` | `GatekeeperVendor`, `KintaiAccount`, `KintaiGatekeeper` facet |
| `src/store/schema.ts` | DDL, applied once per DO activation |
| `src/store/kintai-store.ts` | The `KintaiStore` Durable Object; composes the modules below |
| `src/store/employees.ts` | Employees, account links, exemption periods |
| `src/store/org.ts` | Temporal org graph and delegation |
| `src/store/punches.ts` | Append-only punch log and corrections |
| `src/store/sites.ts` | Geofence sites and match evaluation |
| `src/store/allocations.ts` | Versioned day allocations and reconciliation |
| `src/store/submissions.ts` | Submissions, route snapshots, approval events |
| `src/store/periods.ts` | Period locks |
| `src/store/audit.ts` | Audit log |
| `src/routes.ts` | Pure approval-route resolution |
| `__tests__/*.test.ts` | One test file per module above |
| `__tests__/worker.ts` | Test worker entrypoint (mirrors `gatekeeper-scheduler/__tests__/worker.ts`) |

---

### Task 1: Package scaffolding and vendor declaration

**Files:**
- Create: `packages/gatekeeper-kintai/package.json`
- Create: `packages/gatekeeper-kintai/tsconfig.json`
- Create: `packages/gatekeeper-kintai/wrangler.jsonc`
- Create: `packages/gatekeeper-kintai/vitest.config.ts`
- Create: `packages/gatekeeper-kintai/src/types.ts`
- Create: `packages/gatekeeper-kintai/src/kintai.ts`
- Create: `packages/gatekeeper-kintai/src/worker.ts`
- Create: `packages/gatekeeper-kintai/src/index.ts`
- Test: `packages/gatekeeper-kintai/__tests__/worker.ts`
- Test: `packages/gatekeeper-kintai/__tests__/vendor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GatekeeperVendor` (default export) with `describe(): Promise<VendorDescription>`; the `KINTAI_VENDOR_ID = "kintai"` constant.

- [ ] **Step 1: Write the failing test**

`__tests__/vendor.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("kintai vendor", () => {
  it("declares itself as an auto-provisioned, non-auth vendor", async () => {
    using vendor = env.KINTAI_VENDOR.get();
    const description = await vendor.describe();

    expect(description.autoProvisionsAccount).toBe(true);
    expect(description.providesAuth).toBe(false);
    expect(description.displayName).toBe("Kintai");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/vendor.test.ts`
Expected: FAIL — the package does not exist yet.

- [ ] **Step 3: Create the package scaffolding**

`package.json`:

```json
{
  "name": "@gadgets/gatekeeper-kintai",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "echo \"run 'pnpm dev-server' in the root directory instead\" >&2 && exit 1",
    "deploy": "wrangler deploy",
    "build": "tsc",
    "clean": "rm -rf dist",
    "test:run": "vitest run"
  },
  "dependencies": {
    "@gadgets/backend-utils": "workspace:*",
    "@gadgets/workshop-shared": "workspace:*",
    "capnweb": "catalog:",
    "capnweb-validate": "catalog:"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "catalog:",
    "@types/node": "^26.1.0",
    "miniflare": "5.20260801.0-alpha",
    "typescript": "catalog:",
    "vite": "catalog:",
    "vitest": "catalog:",
    "wrangler": "catalog:"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ESNext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["./worker-configuration.d.ts"]
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", ".wrangler"]
}
```

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "gatekeeper-kintai",
  "main": ".wrangler/validate/src/worker.ts",
  "build": {
    "command": "pnpm exec capnweb-validate build --out .wrangler/validate",
    "watch_dir": "src",
  },
  "compatibility_date": "2026-02-02",
  "compatibility_flags": ["nodejs_als"],
  // KintaiStore is reached through ctx.exports; no binding is required.
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["KintaiStore", "KintaiGatekeeper"] },
  ],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": { "invocation_logs": false },
  },
}
```

`vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_als"],
        durableObjects: {
          KINTAI_STORE: { className: "KintaiStore", useSQLite: true },
        },
        serviceBindings: {
          KINTAI_VENDOR: { name: kCurrentWorker, entrypoint: "GatekeeperVendor" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
```

- [ ] **Step 4: Write the vendor**

`src/types.ts`:

```ts
export const KINTAI_VENDOR_ID = "kintai";

export type EmployeeId = number;
export type PunchKind = "in" | "out" | "break_start" | "break_end";
export type PunchSource = "gadget" | "admin" | "import";
export type LocationSource = "gps" | "denied" | "unavailable" | "manual";
export type SubmissionState = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export type ApprovalAction = "approve" | "reject" | "return";
export type StepRule = "any_of" | "all_of";
export type EmployeeStatus = "active" | "leave" | "departed";
```

`src/kintai.ts`:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";

const KINTAI_ICON = { type: "emoji" as const, emoji: "🕒" };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Kintai vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Kintai",
      url: "https://workers.cloudflare.com/",
      logo: KINTAI_ICON,
      tagline: "Attendance, overtime and approvals",
      description: "Records attendance and routes overtime requests for approval.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }
}
```

`src/worker.ts`:

```ts
export { GatekeeperVendor as default, GatekeeperVendor } from "./kintai.js";
```

`src/index.ts`:

```ts
export * from "./worker.js";
export type * from "./types.js";
```

`__tests__/worker.ts`:

```ts
export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { GatekeeperVendor } from "../src/kintai.js";
```

- [ ] **Step 5: Install and run the test**

Run: `pnpm install && cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/vendor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai pnpm-lock.yaml
git commit -m "feat(kintai): scaffold gatekeeper package and vendor declaration"
```

---

### Task 2: KintaiStore Durable Object and schema

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/schema.ts`
- Create: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Modify: `packages/gatekeeper-kintai/src/worker.ts`
- Test: `packages/gatekeeper-kintai/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the package.
- Produces: `applySchema(sql: SqlStorage): void`; `class KintaiStore extends DurableObject` exposing `readonly sql: SqlStorage` to its own modules and an RPC method `tableNames(): Promise<string[]>` used only by tests.

- [ ] **Step 1: Write the failing test**

`__tests__/schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("kintai schema", () => {
  it("creates every table the design requires", async () => {
    using store = env.KINTAI_STORE.getByName("test-schema");
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
    using first = env.KINTAI_STORE.getByName("test-idempotent");
    const before = await first.tableNames();
    using second = env.KINTAI_STORE.getByName("test-idempotent");
    expect(await second.tableNames()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/schema.test.ts`
Expected: FAIL — `env.KINTAI_STORE` is not defined.

- [ ] **Step 3: Write the schema**

`src/store/schema.ts`:

```ts
// The full kintai schema. Applied on every DO activation; every statement is IF NOT EXISTS so
// this is idempotent. All tables are STRICT, and enum columns carry CHECK constraints, matching
// packages/mcp-shared/src/action-store.ts.
//
// punches, approval_events and audit_log are append-only: corrections insert a new row rather
// than updating an existing one. See the design doc's data model section.

export function applySchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    department TEXT,
    employment_type TEXT,
    designated_approver_id INTEGER REFERENCES employees(id),
    status TEXT NOT NULL CHECK (status IN ('active', 'leave', 'departed')),
    joined_on TEXT NOT NULL,
    departed_on TEXT
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS account_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    linked_by INTEGER REFERENCES employees(id),
    reason TEXT
  ) STRICT`);
  // At most one open link per account.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS account_links_open
    ON account_links(account_id) WHERE valid_to IS NULL`);

  sql.exec(`CREATE TABLE IF NOT EXISTS exemption_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    kind TEXT NOT NULL CHECK (kind IN ('kanri_kantokusha')),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS org_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    manager_id INTEGER NOT NULL REFERENCES employees(id),
    kind TEXT NOT NULL CHECK (kind IN ('report', 'delegate')),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_m REAL NOT NULL CHECK (radius_m > 0),
    valid_from INTEGER NOT NULL,
    valid_to INTEGER
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('gadget', 'admin', 'import')),
    latitude REAL,
    longitude REAL,
    accuracy_m REAL,
    location_source TEXT CHECK (
      location_source IS NULL OR location_source IN ('gps', 'denied', 'unavailable', 'manual')),
    matched_site_id INTEGER REFERENCES sites(id),
    supersedes_id INTEGER REFERENCES punches(id),
    amended_by INTEGER REFERENCES employees(id),
    amend_reason TEXT
  ) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS punches_by_day
    ON punches(employee_id, work_date)`);

  sql.exec(`CREATE TABLE IF NOT EXISTS day_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    project_code TEXT NOT NULL,
    minutes INTEGER NOT NULL CHECK (minutes >= 0),
    note TEXT,
    version INTEGER NOT NULL,
    superseded_by INTEGER REFERENCES day_allocations(id)
  ) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS day_allocations_by_day
    ON day_allocations(employee_id, work_date)`);

  sql.exec(`CREATE TABLE IF NOT EXISTS approval_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department TEXT,
    employment_type TEXT,
    min_minutes INTEGER NOT NULL DEFAULT 0
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS approval_route_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES approval_routes(id),
    step_index INTEGER NOT NULL,
    rule TEXT NOT NULL CHECK (rule IN ('any_of', 'all_of')),
    approver_kind TEXT NOT NULL CHECK (approver_kind IN ('manager', 'employee')),
    approver_employee_id INTEGER REFERENCES employees(id)
  ) STRICT`);

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
    route_snapshot TEXT NOT NULL CHECK (json_valid(route_snapshot))
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS approval_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    step_index INTEGER NOT NULL,
    actor_employee_id INTEGER NOT NULL REFERENCES employees(id),
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return')),
    at INTEGER NOT NULL,
    comment TEXT,
    authorizing_edge INTEGER REFERENCES org_edges(id)
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS period_locks (
    period TEXT PRIMARY KEY,
    locked_at INTEGER NOT NULL,
    locked_by INTEGER NOT NULL REFERENCES employees(id)
  ) STRICT`);

  sql.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_employee_id INTEGER REFERENCES employees(id),
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    before TEXT CHECK (before IS NULL OR json_valid(before)),
    after TEXT CHECK (after IS NULL OR json_valid(after))
  ) STRICT`);
}
```

- [ ] **Step 4: Write the store DO**

`src/store/kintai-store.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { applySchema } from "./schema.js";

@validateRpc()
export class KintaiStore extends DurableObject<Cloudflare.Env> {
  readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    applySchema(this.sql);
  }

  /** Table names, sorted. Test-only introspection. */
  async tableNames(): Promise<string[]> {
    return this.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
         ORDER BY name`,
      )
      .toArray()
      .map((row) => row.name);
  }
}
```

Modify `src/worker.ts` to add the export:

```ts
export { GatekeeperVendor as default, GatekeeperVendor } from "./kintai.js";
export { KintaiStore } from "./store/kintai-store.js";
```

Add the same re-export to `__tests__/worker.ts`:

```ts
export { KintaiStore } from "../src/store/kintai-store.js";
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/schema.test.ts`
Expected: PASS — both cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add KintaiStore durable object and schema"
```

---

### Task 3: Employees, account links and exemptions

Store modules are plain functions taking `sql` and an explicit `now` rather than reading the clock
themselves. The DO supplies `Date.now()`; tests supply fixed timestamps. Every module in this plan
follows that shape.

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/employees.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/employees.test.ts`

**Interfaces:**
- Consumes: `applySchema` (Task 2), `EmployeeId`/`EmployeeStatus` (Task 1).
- Produces:
  - `createEmployee(sql, input: NewEmployee): EmployeeId` where
    `NewEmployee = { employeeNumber: string; displayName: string; department?: string; employmentType?: string; designatedApproverId?: EmployeeId; joinedOn: string }`
  - `linkAccount(sql, accountId: string, employeeId: EmployeeId, now: number, linkedBy?: EmployeeId, reason?: string): void`
  - `resolveAccount(sql, accountId: string, at: number): EmployeeId | null`
  - `isExempt(sql, employeeId: EmployeeId, at: number): boolean`
  - `grantExemption(sql, employeeId: EmployeeId, from: number, to?: number): void`
  - `class UnlinkedAccountError extends Error` with `code = "KINTAI_ACCOUNT_NOT_LINKED"`

- [ ] **Step 1: Write the failing test**

`__tests__/employees.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/employees.test.ts`
Expected: FAIL — `store.createEmployee is not a function`.

- [ ] **Step 3: Write the module**

`src/store/employees.ts`:

```ts
import type { EmployeeId } from "../types.js";

export type NewEmployee = {
  employeeNumber: string;
  displayName: string;
  department?: string;
  employmentType?: string;
  designatedApproverId?: EmployeeId;
  joinedOn: string;
};

/** Thrown when a caller's account capability has no open link to an employee record. */
export class UnlinkedAccountError extends Error {
  readonly code = "KINTAI_ACCOUNT_NOT_LINKED";
  constructor() {
    super("This account is not linked to an employee record. Contact HR to be set up.");
  }
}

export function createEmployee(sql: SqlStorage, input: NewEmployee): EmployeeId {
  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO employees
         (employee_number, display_name, department, employment_type,
          designated_approver_id, status, joined_on)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       RETURNING id`,
      input.employeeNumber,
      input.displayName,
      input.department ?? null,
      input.employmentType ?? null,
      input.designatedApproverId ?? null,
      input.joinedOn,
    )
    .one();
  return row.id;
}

/**
 * Point `accountId` at `employeeId`. Closes any currently-open link for that account first, so the
 * partial unique index (one open link per account) always holds.
 *
 * Re-linking is the supported path for an email change: a new verified email yields a new
 * UserDurableObject and therefore a new accountId, while the employee record — and all history
 * hanging off it — is unchanged.
 */
export function linkAccount(
  sql: SqlStorage,
  accountId: string,
  employeeId: EmployeeId,
  now: number,
  linkedBy?: EmployeeId,
  reason?: string,
): void {
  sql.exec(
    `UPDATE account_links SET valid_to = ? WHERE account_id = ? AND valid_to IS NULL`,
    now, accountId,
  );
  sql.exec(
    `INSERT INTO account_links (account_id, employee_id, valid_from, valid_to, linked_by, reason)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    accountId, employeeId, now, linkedBy ?? null, reason ?? null,
  );
}

/** The employee this account mapped to at `at`, or null if it mapped to none. */
export function resolveAccount(
  sql: SqlStorage,
  accountId: string,
  at: number,
): EmployeeId | null {
  const row = sql
    .exec<{ employee_id: number }>(
      `SELECT employee_id FROM account_links
       WHERE account_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC LIMIT 1`,
      accountId, at, at,
    )
    .toArray()[0];
  return row ? row.employee_id : null;
}

export function grantExemption(
  sql: SqlStorage,
  employeeId: EmployeeId,
  from: number,
  to?: number,
): void {
  sql.exec(
    `INSERT INTO exemption_periods (employee_id, kind, valid_from, valid_to)
     VALUES (?, 'kanri_kantokusha', ?, ?)`,
    employeeId, from, to ?? null,
  );
}

/**
 * Whether the employee was 管理監督者 at `at`.
 *
 * NOTE for sub-project 2: exempt means exempt from 時間外 and 休日 premiums, NOT from 深夜割増
 * (22:00-05:00). Punches must still be recorded and night hours still calculated for these
 * employees. Do not treat this flag as "stop tracking".
 */
export function isExempt(sql: SqlStorage, employeeId: EmployeeId, at: number): boolean {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM exemption_periods
       WHERE employee_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
      employeeId, at, at,
    )
    .one();
  return row.n > 0;
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `KintaiStore` in `src/store/kintai-store.ts` (keep the existing imports and add this one):

```ts
import {
  createEmployee, grantExemption, isExempt, linkAccount, resolveAccount,
  type NewEmployee,
} from "./employees.js";
```

and these methods to the class body:

```ts
  async createEmployee(input: NewEmployee): Promise<EmployeeId> {
    return createEmployee(this.sql, input);
  }

  async linkAccount(
    accountId: string, employeeId: EmployeeId, now: number,
    linkedBy?: EmployeeId, reason?: string,
  ): Promise<void> {
    linkAccount(this.sql, accountId, employeeId, now, linkedBy, reason);
  }

  async resolveAccount(accountId: string, at: number): Promise<EmployeeId | null> {
    return resolveAccount(this.sql, accountId, at);
  }

  async grantExemption(employeeId: EmployeeId, from: number, to?: number): Promise<void> {
    grantExemption(this.sql, employeeId, from, to);
  }

  async isExempt(employeeId: EmployeeId, at: number): Promise<boolean> {
    return isExempt(this.sql, employeeId, at);
  }
```

Add `import type { EmployeeId } from "../types.js";` to the file's imports.

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/employees.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add employees, account links and exemption periods"
```

---

### Task 4: Temporal org graph and delegation

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/org.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/org.test.ts`

**Interfaces:**
- Consumes: `createEmployee` (Task 3).
- Produces:
  - `setReportingLine(sql, employeeId, managerId, from: number, to?: number): void`
  - `setDelegate(sql, employeeId, delegateId, from: number, to: number): void`
  - `managersAt(sql, employeeId, at: number): EmployeeId[]` — every employee authorised over
    `employeeId` at that instant, reporting lines and delegates together.
  - `hasAuthorityOver(sql, actorId, employeeId, at: number): number | null` — the `org_edges.id`
    that grants it, or null. Returning the edge id is what lets `approval_events` record
    `authorizing_edge`.

- [ ] **Step 1: Write the failing test**

`__tests__/org.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/org.test.ts`
Expected: FAIL — `store.setReportingLine is not a function`.

- [ ] **Step 3: Write the module**

`src/store/org.ts`:

```ts
import type { EmployeeId } from "../types.js";

// The org graph is temporal because audits ask "was this person actually X's manager on 3 July?".
// A non-temporal table cannot answer that after any reorganisation, and every company reorganises.
// Delegation reuses the reporting-line shape with a bounded window, so a manager on leave does not
// silently stall their team's submissions.

export function setReportingLine(
  sql: SqlStorage,
  employeeId: EmployeeId,
  managerId: EmployeeId,
  from: number,
  to?: number,
): void {
  sql.exec(
    `INSERT INTO org_edges (employee_id, manager_id, kind, valid_from, valid_to)
     VALUES (?, ?, 'report', ?, ?)`,
    employeeId, managerId, from, to ?? null,
  );
}

/** Delegation is always bounded — an open-ended delegate is just a second manager. */
export function setDelegate(
  sql: SqlStorage,
  employeeId: EmployeeId,
  delegateId: EmployeeId,
  from: number,
  to: number,
): void {
  sql.exec(
    `INSERT INTO org_edges (employee_id, manager_id, kind, valid_from, valid_to)
     VALUES (?, ?, 'delegate', ?, ?)`,
    employeeId, delegateId, from, to,
  );
}

/** Everyone authorised over `employeeId` at `at` — reporting lines and live delegations. */
export function managersAt(
  sql: SqlStorage,
  employeeId: EmployeeId,
  at: number,
): EmployeeId[] {
  return sql
    .exec<{ manager_id: number }>(
      `SELECT DISTINCT manager_id FROM org_edges
       WHERE employee_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
      employeeId, at, at,
    )
    .toArray()
    .map((row) => row.manager_id);
}

/**
 * The org_edges row granting `actorId` authority over `employeeId` at `at`, or null.
 *
 * Returns the edge id rather than a boolean so approval_events can record which edge authorised
 * the action — the audit trail then answers "were they authorised at that moment?" directly
 * instead of by inference against today's org chart.
 */
export function hasAuthorityOver(
  sql: SqlStorage,
  actorId: EmployeeId,
  employeeId: EmployeeId,
  at: number,
): number | null {
  const row = sql
    .exec<{ id: number }>(
      `SELECT id FROM org_edges
       WHERE employee_id = ? AND manager_id = ?
         AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC LIMIT 1`,
      employeeId, actorId, at, at,
    )
    .toArray()[0];
  return row ? row.id : null;
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import { hasAuthorityOver, managersAt, setDelegate, setReportingLine } from "./org.js";
```

and to the class body:

```ts
  async setReportingLine(
    employeeId: EmployeeId, managerId: EmployeeId, from: number, to?: number,
  ): Promise<void> {
    setReportingLine(this.sql, employeeId, managerId, from, to);
  }

  async setDelegate(
    employeeId: EmployeeId, delegateId: EmployeeId, from: number, to: number,
  ): Promise<void> {
    setDelegate(this.sql, employeeId, delegateId, from, to);
  }

  async managersAt(employeeId: EmployeeId, at: number): Promise<EmployeeId[]> {
    return managersAt(this.sql, employeeId, at);
  }

  async hasAuthorityOver(
    actorId: EmployeeId, employeeId: EmployeeId, at: number,
  ): Promise<number | null> {
    return hasAuthorityOver(this.sql, actorId, employeeId, at);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/org.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add temporal org graph with delegation"
```

---

### Task 5: Geofence sites

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/sites.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/sites.test.ts`

**Interfaces:**
- Consumes: `applySchema` (Task 2).
- Produces:
  - `createSite(sql, input: NewSite): number` where
    `NewSite = { name: string; latitude: number; longitude: number; radiusM: number; validFrom: number; validTo?: number }`
  - `distanceMetres(aLat, aLon, bLat, bLon): number` — exported for its own unit test
  - `matchSite(sql, latitude: number, longitude: number, at: number): number | null`

- [ ] **Step 1: Write the failing test**

`__tests__/sites.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { distanceMetres } from "../src/store/sites.js";

const APR = Date.parse("2026-04-01T00:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");

// Tokyo Station and a point ~400m away.
const STATION = { lat: 35.6812, lon: 139.7671 };
const NEARBY = { lat: 35.6848, lon: 139.7671 };

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`sites-${seq++}`);
});

describe("distanceMetres", () => {
  it("returns zero for the same point", () => {
    expect(distanceMetres(STATION.lat, STATION.lon, STATION.lat, STATION.lon)).toBeCloseTo(0, 5);
  });

  it("measures a short north-south offset to within a few metres", () => {
    const d = distanceMetres(STATION.lat, STATION.lon, NEARBY.lat, NEARBY.lon);
    expect(d).toBeGreaterThan(380);
    expect(d).toBeLessThan(420);
  });
});

describe("matchSite", () => {
  it("matches a point inside the radius and not one outside it", async () => {
    const site = await store.createSite({
      name: "現場A", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 500, validFrom: APR,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, OCT)).toBe(site);
    expect(await store.matchSite(NEARBY.lat, NEARBY.lon, OCT)).toBe(site);
    // 5km north is outside.
    expect(await store.matchSite(STATION.lat + 0.045, STATION.lon, OCT)).toBeNull();
  });

  it("ignores a site whose validity window has closed", async () => {
    await store.createSite({
      name: "現場B", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 500, validFrom: APR, validTo: OCT,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, APR + 1)).not.toBeNull();
    expect(await store.matchSite(STATION.lat, STATION.lon, OCT + 1)).toBeNull();
  });

  it("picks the nearest when radii overlap", async () => {
    await store.createSite({
      name: "far", latitude: STATION.lat + 0.003, longitude: STATION.lon,
      radiusM: 5000, validFrom: APR,
    });
    const near = await store.createSite({
      name: "near", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 5000, validFrom: APR,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, OCT)).toBe(near);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/sites.test.ts`
Expected: FAIL — cannot resolve `../src/store/sites.js`.

- [ ] **Step 3: Write the module**

`src/store/sites.ts`:

```ts
export type NewSite = {
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  validFrom: number;
  validTo?: number;
};

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres (haversine). Exported so it can be tested directly. */
export function distanceMetres(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function createSite(sql: SqlStorage, input: NewSite): number {
  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO sites (name, latitude, longitude, radius_m, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      input.name, input.latitude, input.longitude, input.radiusM,
      input.validFrom, input.validTo ?? null,
    )
    .one();
  return row.id;
}

/**
 * The nearest site whose radius contains the point at `at`, or null.
 *
 * Sites are few (one per 現場) so this scans the valid set rather than maintaining a spatial
 * index. Revisit only if site counts reach the thousands.
 */
export function matchSite(
  sql: SqlStorage,
  latitude: number,
  longitude: number,
  at: number,
): number | null {
  const candidates = sql
    .exec<{ id: number; latitude: number; longitude: number; radius_m: number }>(
      `SELECT id, latitude, longitude, radius_m FROM sites
       WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
      at, at,
    )
    .toArray();

  let best: { id: number; distance: number } | null = null;
  for (const site of candidates) {
    const distance = distanceMetres(latitude, longitude, site.latitude, site.longitude);
    if (distance > site.radius_m) continue;
    if (!best || distance < best.distance) best = { id: site.id, distance };
  }
  return best ? best.id : null;
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import { createSite, matchSite, type NewSite } from "./sites.js";
```

and to the class body:

```ts
  async createSite(input: NewSite): Promise<number> {
    return createSite(this.sql, input);
  }

  async matchSite(latitude: number, longitude: number, at: number): Promise<number | null> {
    return matchSite(this.sql, latitude, longitude, at);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/sites.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add geofence sites and nearest-match evaluation"
```

---

### Task 6: Append-only punch log

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/punches.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/punches.test.ts`

**Interfaces:**
- Consumes: `createEmployee` (Task 3), `matchSite` (Task 5).
- Produces:
  - `recordPunch(sql, input: NewPunch): number` where
    `NewPunch = { employeeId: EmployeeId; workDate: string; kind: PunchKind; now: number; source: PunchSource; location?: PunchLocation }`
    and `PunchLocation = { source: LocationSource; latitude?: number; longitude?: number; accuracyM?: number }`
  - `correctPunch(sql, supersedesId: number, input: NewPunch, amendedBy: EmployeeId, reason: string): number`
  - `currentPunches(sql, employeeId, workDate: string): PunchRow[]`
  - `workedMinutes(sql, employeeId, workDate: string): number`
  - `DUPLICATE_WINDOW_MS = 60_000`

- [ ] **Step 1: Write the failing test**

`__tests__/punches.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NINE_AM = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST
const SIX_PM = Date.parse("2026-07-03T09:00:00Z");  // 18:00 JST
const DAY = "2026-07-03";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`punches-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E900", displayName: "Tanaka", joinedOn: "2026-04-01",
  });
});

describe("recording punches", () => {
  it("records a punch and returns it as current", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });

    const punches = await store.currentPunches(employeeId, DAY);
    expect(punches).toHaveLength(1);
    expect(punches[0].kind).toBe("in");
    expect(punches[0].occurred_at).toBe(NINE_AM);
  });

  it("computes worked minutes from in/out pairs", async () => {
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    expect(await store.workedMinutes(employeeId, DAY)).toBe(540);
  });
});

describe("corrections", () => {
  it("supersedes rather than updates, and keeps the original readable", async () => {
    const original = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const corrected = await store.correctPunch(
      original,
      { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1_800_000, source: "admin" },
      employeeId,
      "clocked in late by mistake",
    );

    // Only the correction is current...
    const current = await store.currentPunches(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(corrected);

    // ...but the original row still exists, untouched, with the reason recorded.
    const all = await store.allPunches(employeeId, DAY);
    expect(all).toHaveLength(2);
    const supersededRow = all.find((p) => p.id === original)!;
    expect(supersededRow.occurred_at).toBe(NINE_AM);
    const correctionRow = all.find((p) => p.id === corrected)!;
    expect(correctionRow.supersedes_id).toBe(original);
    expect(correctionRow.amend_reason).toBe("clocked in late by mistake");
  });
});

describe("location", () => {
  it("stores coordinates and the evaluated site match together", async () => {
    const site = await store.createSite({
      name: "現場A", latitude: 35.6812, longitude: 139.7671,
      radiusM: 500, validFrom: NINE_AM - 1000,
    });

    const id = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      location: { source: "gps", latitude: 35.6812, longitude: 139.7671, accuracyM: 8 },
    });

    const punch = (await store.currentPunches(employeeId, DAY)).find((p) => p.id === id)!;
    expect(punch.location_source).toBe("gps");
    expect(punch.matched_site_id).toBe(site);
    expect(punch.latitude).toBeCloseTo(35.6812, 4);
  });

  it("still records the punch when the user denied location", async () => {
    const id = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      location: { source: "denied" },
    });

    const punch = (await store.currentPunches(employeeId, DAY)).find((p) => p.id === id)!;
    expect(punch.location_source).toBe("denied");
    expect(punch.matched_site_id).toBeNull();
    expect(punch.latitude).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/punches.test.ts`
Expected: FAIL — `store.recordPunch is not a function`.

- [ ] **Step 3: Write the module**

`src/store/punches.ts`:

```ts
import type { EmployeeId, LocationSource, PunchKind, PunchSource } from "../types.js";
import { matchSite } from "./sites.js";

export type PunchLocation = {
  source: LocationSource;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
};

export type NewPunch = {
  employeeId: EmployeeId;
  workDate: string;
  kind: PunchKind;
  /** Server time. Never accept a client-supplied timestamp. */
  now: number;
  source: PunchSource;
  location?: PunchLocation;
};

export type PunchRow = {
  id: number;
  employee_id: number;
  work_date: string;
  kind: PunchKind;
  occurred_at: number;
  recorded_at: number;
  source: PunchSource;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  location_source: LocationSource | null;
  matched_site_id: number | null;
  supersedes_id: number | null;
  amended_by: number | null;
  amend_reason: string | null;
};

/** A repeat of the same kind inside this window is treated as a double-tap, not a new punch. */
export const DUPLICATE_WINDOW_MS = 60_000;

function insert(
  sql: SqlStorage,
  input: NewPunch,
  supersedesId: number | null,
  amendedBy: EmployeeId | null,
  amendReason: string | null,
): number {
  // Both the raw coordinates and the evaluated match are stored: site boundaries are redrawn over
  // time, so a dispute needs the evaluation as it stood AND the underlying data.
  const loc = input.location;
  const hasFix = loc?.latitude !== undefined && loc?.longitude !== undefined;
  const siteId = hasFix ? matchSite(sql, loc!.latitude!, loc!.longitude!, input.now) : null;

  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO punches
         (employee_id, work_date, kind, occurred_at, recorded_at, source,
          latitude, longitude, accuracy_m, location_source, matched_site_id,
          supersedes_id, amended_by, amend_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.employeeId, input.workDate, input.kind, input.now, input.now, input.source,
      hasFix ? loc!.latitude! : null,
      hasFix ? loc!.longitude! : null,
      loc?.accuracyM ?? null,
      loc?.source ?? null,
      siteId,
      supersedesId, amendedBy, amendReason,
    )
    .one();
  return row.id;
}

/**
 * Append a punch. Returns the existing punch's id when it lands inside the duplicate window with
 * the same kind, so a double-tap does not create a second record or surface an error.
 */
export function recordPunch(sql: SqlStorage, input: NewPunch): number {
  const recent = sql
    .exec<{ id: number }>(
      `SELECT p.id FROM punches p
       WHERE p.employee_id = ? AND p.work_date = ? AND p.kind = ?
         AND p.occurred_at > ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       ORDER BY p.occurred_at DESC LIMIT 1`,
      input.employeeId, input.workDate, input.kind, input.now - DUPLICATE_WINDOW_MS,
    )
    .toArray()[0];
  if (recent) return recent.id;

  return insert(sql, input, null, null, null);
}

/**
 * Correct a punch by appending a replacement that references it. The original row is never
 * updated: an auditor must be able to see what was first recorded, when, and who changed it.
 */
export function correctPunch(
  sql: SqlStorage,
  supersedesId: number,
  input: NewPunch,
  amendedBy: EmployeeId,
  reason: string,
): number {
  return insert(sql, input, supersedesId, amendedBy, reason);
}

/** Punches for the day that nothing supersedes. */
export function currentPunches(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): PunchRow[] {
  return sql
    .exec<PunchRow>(
      `SELECT * FROM punches p
       WHERE p.employee_id = ? AND p.work_date = ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       ORDER BY p.occurred_at`,
      employeeId, workDate,
    )
    .toArray();
}

/** Every punch for the day including superseded ones, oldest first. */
export function allPunches(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): PunchRow[] {
  return sql
    .exec<PunchRow>(
      `SELECT * FROM punches WHERE employee_id = ? AND work_date = ? ORDER BY id`,
      employeeId, workDate,
    )
    .toArray();
}

/**
 * Worked minutes for the day: paired in/out spans, less paired break spans. An unpaired `in` — the
 * forgot-to-clock-out case — contributes nothing and is deliberately NOT auto-closed; the facet
 * surfaces it as an exception instead. An auto-closed shift is a fabricated record.
 */
export function workedMinutes(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): number {
  const punches = currentPunches(sql, employeeId, workDate);

  const span = (openKind: PunchKind, closeKind: PunchKind): number => {
    let total = 0;
    let openedAt: number | null = null;
    for (const punch of punches) {
      if (punch.kind === openKind && openedAt === null) openedAt = punch.occurred_at;
      else if (punch.kind === closeKind && openedAt !== null) {
        total += punch.occurred_at - openedAt;
        openedAt = null;
      }
    }
    return total;
  };

  const gross = span("in", "out") - span("break_start", "break_end");
  return Math.max(0, Math.round(gross / 60_000));
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import {
  allPunches, correctPunch, currentPunches, recordPunch, workedMinutes,
  type NewPunch, type PunchRow,
} from "./punches.js";
```

and to the class body:

```ts
  async recordPunch(input: NewPunch): Promise<number> {
    return recordPunch(this.sql, input);
  }

  async correctPunch(
    supersedesId: number, input: NewPunch, amendedBy: EmployeeId, reason: string,
  ): Promise<number> {
    return correctPunch(this.sql, supersedesId, input, amendedBy, reason);
  }

  async currentPunches(employeeId: EmployeeId, workDate: string): Promise<PunchRow[]> {
    return currentPunches(this.sql, employeeId, workDate);
  }

  async allPunches(employeeId: EmployeeId, workDate: string): Promise<PunchRow[]> {
    return allPunches(this.sql, employeeId, workDate);
  }

  async workedMinutes(employeeId: EmployeeId, workDate: string): Promise<number> {
    return workedMinutes(this.sql, employeeId, workDate);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/punches.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 6: Add the duplicate-punch test and re-run**

Append to `__tests__/punches.test.ts`:

```ts
describe("duplicate suppression", () => {
  it("returns the same punch for a double-tap inside the window", async () => {
    const first = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const second = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 5_000, source: "gadget",
    });

    expect(second).toBe(first);
    expect(await store.currentPunches(employeeId, DAY)).toHaveLength(1);
  });

  it("records a genuine second punch outside the window", async () => {
    const first = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const second = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM + 120_000, source: "gadget",
    });

    expect(second).not.toBe(first);
  });
});
```

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/punches.test.ts`
Expected: PASS — all seven cases.

- [ ] **Step 7: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add append-only punch log with location and corrections"
```

---

### Task 7: Versioned day allocations and reconciliation

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/allocations.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/allocations.test.ts`

**Interfaces:**
- Consumes: `workedMinutes` (Task 6), `createEmployee` (Task 3).
- Produces:
  - `setAllocations(sql, employeeId, workDate, entries: AllocationEntry[]): Reconciliation` where
    `AllocationEntry = { projectCode: string; minutes: number; note?: string }` and
    `Reconciliation = { allocatedMinutes: number; workedMinutes: number; discrepancyMinutes: number }`
  - `currentAllocations(sql, employeeId, workDate): AllocationRow[]`
  - `reconcile(sql, employeeId, workDate): Reconciliation`

- [ ] **Step 1: Write the failing test**

`__tests__/allocations.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NINE_AM = Date.parse("2026-07-03T00:00:00Z");
const SIX_PM = Date.parse("2026-07-03T09:00:00Z");
const DAY = "2026-07-03";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`alloc-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E800", displayName: "Ito", joinedOn: "2026-04-01",
  });
  await store.recordPunch({
    employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
  });
  await store.recordPunch({
    employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
  });
});

describe("setAllocations", () => {
  it("stores entries and reports a balanced day as zero discrepancy", async () => {
    const result = await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 300 },
      { projectCode: "INTERNAL", minutes: 240 },
    ]);

    expect(result.workedMinutes).toBe(540);
    expect(result.allocatedMinutes).toBe(540);
    expect(result.discrepancyMinutes).toBe(0);
    expect(await store.currentAllocations(employeeId, DAY)).toHaveLength(2);
  });

  it("stores an unbalanced day rather than rejecting it", async () => {
    const result = await store.setAllocations(employeeId, DAY, [
      { projectCode: "TANAKA-MIGRATION", minutes: 120 },
    ]);

    // People fill these in imperfectly. A system that refuses imperfect input does not get
    // filled in, so the discrepancy is recorded and surfaced instead.
    expect(result.discrepancyMinutes).toBe(-420);
    expect(await store.currentAllocations(employeeId, DAY)).toHaveLength(1);
  });

  it("supersedes the previous version rather than deleting it", async () => {
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "FIRST-GUESS", minutes: 540 },
    ]);
    await store.setAllocations(employeeId, DAY, [
      { projectCode: "CORRECTED", minutes: 540 },
    ]);

    const current = await store.currentAllocations(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0].project_code).toBe("CORRECTED");
    expect(current[0].version).toBe(2);

    // The superseded row is still on disk.
    const all = await store.allAllocations(employeeId, DAY);
    expect(all).toHaveLength(2);
    expect(all.some((a) => a.project_code === "FIRST-GUESS")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/allocations.test.ts`
Expected: FAIL — `store.setAllocations is not a function`.

- [ ] **Step 3: Write the module**

`src/store/allocations.ts`:

```ts
import type { EmployeeId } from "../types.js";
import { workedMinutes } from "./punches.js";

export type AllocationEntry = { projectCode: string; minutes: number; note?: string };

export type AllocationRow = {
  id: number;
  employee_id: number;
  work_date: string;
  project_code: string;
  minutes: number;
  note: string | null;
  version: number;
  superseded_by: number | null;
};

export type Reconciliation = {
  allocatedMinutes: number;
  workedMinutes: number;
  /** allocated - worked. Negative means under-allocated. Never a rejection. */
  discrepancyMinutes: number;
};

export function currentAllocations(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): AllocationRow[] {
  return sql
    .exec<AllocationRow>(
      `SELECT * FROM day_allocations
       WHERE employee_id = ? AND work_date = ? AND superseded_by IS NULL
       ORDER BY id`,
      employeeId, workDate,
    )
    .toArray();
}

export function allAllocations(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): AllocationRow[] {
  return sql
    .exec<AllocationRow>(
      `SELECT * FROM day_allocations WHERE employee_id = ? AND work_date = ? ORDER BY id`,
      employeeId, workDate,
    )
    .toArray();
}

export function reconcile(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string,
): Reconciliation {
  const allocated = currentAllocations(sql, employeeId, workDate)
    .reduce((sum, row) => sum + row.minutes, 0);
  const worked = workedMinutes(sql, employeeId, workDate);
  return {
    allocatedMinutes: allocated,
    workedMinutes: worked,
    discrepancyMinutes: allocated - worked,
  };
}

/**
 * Replace the day's allocations with a new version. Prior rows are marked superseded rather than
 * deleted, so a day's allocation history stays readable.
 */
export function setAllocations(
  sql: SqlStorage,
  employeeId: EmployeeId,
  workDate: string,
  entries: AllocationEntry[],
): Reconciliation {
  const previous = currentAllocations(sql, employeeId, workDate);
  const version = previous.length > 0 ? previous[0].version + 1 : 1;

  const inserted: number[] = [];
  for (const entry of entries) {
    const row = sql
      .exec<{ id: number }>(
        `INSERT INTO day_allocations
           (employee_id, work_date, project_code, minutes, note, version, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL) RETURNING id`,
        employeeId, workDate, entry.projectCode, entry.minutes, entry.note ?? null, version,
      )
      .one();
    inserted.push(row.id);
  }

  // Point each superseded row at the first row of the new version, so the chain is traceable.
  const successor = inserted[0] ?? null;
  for (const old of previous) {
    sql.exec(`UPDATE day_allocations SET superseded_by = ? WHERE id = ?`, successor, old.id);
  }

  return reconcile(sql, employeeId, workDate);
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import {
  allAllocations, currentAllocations, reconcile, setAllocations,
  type AllocationEntry, type AllocationRow, type Reconciliation,
} from "./allocations.js";
```

and to the class body:

```ts
  async setAllocations(
    employeeId: EmployeeId, workDate: string, entries: AllocationEntry[],
  ): Promise<Reconciliation> {
    return setAllocations(this.sql, employeeId, workDate, entries);
  }

  async currentAllocations(
    employeeId: EmployeeId, workDate: string,
  ): Promise<AllocationRow[]> {
    return currentAllocations(this.sql, employeeId, workDate);
  }

  async allAllocations(employeeId: EmployeeId, workDate: string): Promise<AllocationRow[]> {
    return allAllocations(this.sql, employeeId, workDate);
  }

  async reconcile(employeeId: EmployeeId, workDate: string): Promise<Reconciliation> {
    return reconcile(this.sql, employeeId, workDate);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/allocations.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add versioned day allocations with reconciliation"
```

---

### Task 8: Approval route resolution

**Files:**
- Create: `packages/gatekeeper-kintai/src/routes.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `StepRule` (Task 1).
- Produces:
  - `type RouteStep = { stepIndex: number; rule: StepRule; approverKind: "manager" | "employee"; approverEmployeeId: EmployeeId | null }`
  - `type RouteSnapshot = { routeId: number; steps: RouteStep[] }`
  - `selectRoute(candidates: RouteConfig[], criteria: RouteCriteria): RouteConfig | null` — pure
  - `createRoute(sql, input: NewRoute): number` where
    `NewRoute = { name: string; department?: string; employmentType?: string; minMinutes?: number; steps: Omit<RouteStep, "stepIndex">[] }`
  - `resolveRoute(sql, criteria: RouteCriteria): RouteSnapshot` where
    `RouteCriteria = { department: string | null; employmentType: string | null; minutes: number }`
  - `class NoRouteError extends Error` with `code = "KINTAI_NO_ROUTE"`

- [ ] **Step 1: Write the failing test**

`__tests__/routes.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { selectRoute, type RouteConfig } from "../src/routes.js";

const GENERIC: RouteConfig = {
  id: 1, name: "default", department: null, employmentType: null, minMinutes: 0,
};
const SITE: RouteConfig = {
  id: 2, name: "site", department: "CONSTRUCTION", employmentType: null, minMinutes: 0,
};
const HEAVY: RouteConfig = {
  id: 3, name: "heavy", department: "CONSTRUCTION", employmentType: null, minMinutes: 2700,
};

describe("selectRoute", () => {
  it("prefers a department match over the catch-all", () => {
    const picked = selectRoute([GENERIC, SITE], {
      department: "CONSTRUCTION", employmentType: null, minutes: 60,
    });
    expect(picked?.id).toBe(SITE.id);
  });

  it("prefers the highest threshold the request clears", () => {
    const picked = selectRoute([GENERIC, SITE, HEAVY], {
      department: "CONSTRUCTION", employmentType: null, minutes: 3000,
    });
    expect(picked?.id).toBe(HEAVY.id);
  });

  it("ignores a threshold the request does not reach", () => {
    const picked = selectRoute([GENERIC, SITE, HEAVY], {
      department: "CONSTRUCTION", employmentType: null, minutes: 100,
    });
    expect(picked?.id).toBe(SITE.id);
  });

  it("falls back to the catch-all for an unmatched department", () => {
    const picked = selectRoute([GENERIC, SITE], {
      department: "SALES", employmentType: null, minutes: 60,
    });
    expect(picked?.id).toBe(GENERIC.id);
  });

  it("returns null when nothing matches", () => {
    expect(selectRoute([SITE], {
      department: "SALES", employmentType: null, minutes: 60,
    })).toBeNull();
  });
});

describe("resolveRoute", () => {
  let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
  let seq = 0;

  beforeEach(() => {
    store = env.KINTAI_STORE.getByName(`routes-${seq++}`);
  });

  it("snapshots the ordered steps of the selected route", async () => {
    const routeId = await store.createRoute({
      name: "site", department: "CONSTRUCTION", minMinutes: 0,
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "all_of", approverKind: "manager", approverEmployeeId: null },
      ],
    });

    const snapshot = await store.resolveRoute({
      department: "CONSTRUCTION", employmentType: null, minutes: 120,
    });

    expect(snapshot.routeId).toBe(routeId);
    expect(snapshot.steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(snapshot.steps[1].rule).toBe("all_of");
  });

  it("throws when no route matches", async () => {
    await expect(store.resolveRoute({
      department: "SALES", employmentType: null, minutes: 60,
    })).rejects.toThrow(/KINTAI_NO_ROUTE|no approval route/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/routes.test.ts`
Expected: FAIL — cannot resolve `../src/routes.js`.

- [ ] **Step 3: Write the module**

`src/routes.ts`:

```ts
import type { EmployeeId, StepRule } from "./types.js";

export type RouteConfig = {
  id: number;
  name: string;
  department: string | null;
  employmentType: string | null;
  minMinutes: number;
};

export type RouteStep = {
  stepIndex: number;
  rule: StepRule;
  /**
   * "manager" resolves against the org graph at approval time, so authority correctly follows the
   * current organisation. "employee" pins a specific approver into the snapshot.
   */
  approverKind: "manager" | "employee";
  approverEmployeeId: EmployeeId | null;
};

export type RouteSnapshot = { routeId: number; steps: RouteStep[] };

export type RouteCriteria = {
  department: string | null;
  employmentType: string | null;
  minutes: number;
};

export type NewRoute = {
  name: string;
  department?: string;
  employmentType?: string;
  minMinutes?: number;
  steps: Omit<RouteStep, "stepIndex">[];
};

export class NoRouteError extends Error {
  readonly code = "KINTAI_NO_ROUTE";
  constructor() {
    super("No approval route matches this request. Ask an administrator to configure one.");
  }
}

/**
 * Most specific match wins: a route scoped to the employee's department or employment type beats
 * a catch-all, and among those, the highest minute threshold the request actually clears.
 */
export function selectRoute(
  candidates: RouteConfig[],
  criteria: RouteCriteria,
): RouteConfig | null {
  const eligible = candidates.filter((route) =>
    (route.department === null || route.department === criteria.department) &&
    (route.employmentType === null || route.employmentType === criteria.employmentType) &&
    criteria.minutes >= route.minMinutes);

  if (eligible.length === 0) return null;

  const specificity = (route: RouteConfig) =>
    (route.department === null ? 0 : 2) + (route.employmentType === null ? 0 : 1);

  return eligible.reduce((best, route) => {
    if (specificity(route) !== specificity(best)) {
      return specificity(route) > specificity(best) ? route : best;
    }
    return route.minMinutes > best.minMinutes ? route : best;
  });
}

export function createRoute(sql: SqlStorage, input: NewRoute): number {
  const route = sql
    .exec<{ id: number }>(
      `INSERT INTO approval_routes (name, department, employment_type, min_minutes)
       VALUES (?, ?, ?, ?) RETURNING id`,
      input.name, input.department ?? null, input.employmentType ?? null,
      input.minMinutes ?? 0,
    )
    .one();

  input.steps.forEach((step, index) => {
    sql.exec(
      `INSERT INTO approval_route_steps
         (route_id, step_index, rule, approver_kind, approver_employee_id)
       VALUES (?, ?, ?, ?, ?)`,
      route.id, index, step.rule, step.approverKind, step.approverEmployeeId ?? null,
    );
  });

  return route.id;
}

/** Select the applicable route and snapshot its steps. Throws NoRouteError if none matches. */
export function resolveRoute(sql: SqlStorage, criteria: RouteCriteria): RouteSnapshot {
  const candidates = sql
    .exec<{
      id: number; name: string; department: string | null;
      employment_type: string | null; min_minutes: number;
    }>(`SELECT * FROM approval_routes`)
    .toArray()
    .map((row): RouteConfig => ({
      id: row.id,
      name: row.name,
      department: row.department,
      employmentType: row.employment_type,
      minMinutes: row.min_minutes,
    }));

  const selected = selectRoute(candidates, criteria);
  if (!selected) throw new NoRouteError();

  const steps = sql
    .exec<{
      step_index: number; rule: StepRule;
      approver_kind: "manager" | "employee"; approver_employee_id: number | null;
    }>(
      `SELECT step_index, rule, approver_kind, approver_employee_id
       FROM approval_route_steps WHERE route_id = ? ORDER BY step_index`,
      selected.id,
    )
    .toArray()
    .map((row): RouteStep => ({
      stepIndex: row.step_index,
      rule: row.rule,
      approverKind: row.approver_kind,
      approverEmployeeId: row.approver_employee_id,
    }));

  return { routeId: selected.id, steps };
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import {
  createRoute, resolveRoute,
  type NewRoute, type RouteCriteria, type RouteSnapshot,
} from "../routes.js";
```

and to the class body:

```ts
  async createRoute(input: NewRoute): Promise<number> {
    return createRoute(this.sql, input);
  }

  async resolveRoute(criteria: RouteCriteria): Promise<RouteSnapshot> {
    return resolveRoute(this.sql, criteria);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/routes.test.ts`
Expected: PASS — all seven cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add approval route selection and snapshotting"
```

---

### Task 9: Submission state machine with authority enforcement

A submission is created directly in `pending`; `draft` is reached only by a `return`, and
`resubmit` moves it back to `pending`. There is no separate "create a draft" call — that keeps one
entry point into the workflow.

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/submissions.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/submissions.test.ts`

**Interfaces:**
- Consumes: `resolveRoute`/`RouteSnapshot` (Task 8), `hasAuthorityOver`/`managersAt` (Task 4).
- Produces:
  - `submitOvertime(sql, input: NewSubmission): number` where
    `NewSubmission = { employeeId: EmployeeId; requestedFor: string; minutes: number; reason: string; now: number; department: string | null; employmentType: string | null }`
  - `actOnSubmission(sql, input: ActInput): SubmissionState` where
    `ActInput = { submissionId: number; actorId: EmployeeId; action: ApprovalAction; now: number; comment?: string }`
  - `resubmit(sql, submissionId: number, actorId: EmployeeId, now: number): void`
  - `withdrawSubmission(sql, submissionId: number, actorId: EmployeeId): void`
  - `getSubmission(sql, id: number): SubmissionRow`
  - `class SelfApprovalError extends Error` (`code = "KINTAI_SELF_APPROVAL"`)
  - `class NotAuthorizedError extends Error` (`code = "KINTAI_NOT_AUTHORIZED"`)
  - `class InvalidTransitionError extends Error` (`code = "KINTAI_INVALID_TRANSITION"`)

- [ ] **Step 1: Write the failing test**

`__tests__/submissions.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const APR = Date.parse("2026-04-01T00:00:00Z");
const JUL = Date.parse("2026-07-03T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;
let boss: number;
let director: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`sub-${seq++}`);
  worker = await store.createEmployee({
    employeeNumber: "W1", displayName: "Worker",
    department: "CONSTRUCTION", joinedOn: "2026-04-01",
  });
  boss = await store.createEmployee({
    employeeNumber: "B1", displayName: "Boss", joinedOn: "2026-04-01",
  });
  director = await store.createEmployee({
    employeeNumber: "D1", displayName: "Director", joinedOn: "2026-04-01",
  });
  await store.setReportingLine(worker, boss, APR);
  await store.setReportingLine(boss, director, APR);
});

async function singleStepRoute() {
  await store.createRoute({
    name: "one-step", department: "CONSTRUCTION",
    steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
  });
}

async function submit(minutes = 120) {
  return store.submitOvertime({
    employeeId: worker, requestedFor: "2026-07-03", minutes,
    reason: "site overrun", now: JUL,
    department: "CONSTRUCTION", employmentType: null,
  });
}

describe("submission lifecycle", () => {
  it("starts pending and reaches approved through its only step", async () => {
    await singleStepRoute();
    const id = await submit();

    expect((await store.getSubmission(id)).state).toBe("pending");
    const state = await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });
    expect(state).toBe("approved");
  });

  it("rejects at any step and stays rejected", async () => {
    await singleStepRoute();
    const id = await submit();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "reject", now: JUL + 1000,
    })).toBe("rejected");

    await expect(store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 2000,
    })).rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
  });

  it("lets the employee withdraw their own submission", async () => {
    await singleStepRoute();
    const id = await submit();
    await store.withdrawSubmission(id, worker);
    expect((await store.getSubmission(id)).state).toBe("withdrawn");
  });
});

describe("authority", () => {
  it("forbids self-approval even when the actor is otherwise a manager", async () => {
    await singleStepRoute();
    const id = await submit();

    await expect(store.actOnSubmission({
      submissionId: id, actorId: worker, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_SELF_APPROVAL/);
  });

  it("refuses an actor with no org edge over the employee", async () => {
    await singleStepRoute();
    const id = await submit();

    await expect(store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });

  it("records which org edge authorised the action", async () => {
    await singleStepRoute();
    const id = await submit();
    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });

    const events = await store.approvalEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].authorizing_edge).toEqual(expect.any(Number));
  });
});

describe("multi-step routes", () => {
  it("advances step by step and only then approves", async () => {
    await store.createRoute({
      name: "two-step", department: "CONSTRUCTION",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
      ],
    });
    const id = await submit();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    expect((await store.getSubmission(id)).current_step).toBe(1);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });
});

describe("return invalidates prior approvals", () => {
  it("requires step 1 to approve again after a return and resubmit", async () => {
    await store.createRoute({
      name: "two-step", department: "CONSTRUCTION",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
      ],
    });
    const id = await submit();

    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });
    // Step 2 sends it back — the content is going to change, so step 1's approval is void.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "return", now: JUL + 2000,
      comment: "split the hours by project first",
    })).toBe("draft");

    await store.resubmit(id, worker, JUL + 3000);
    const after = await store.getSubmission(id);
    expect(after.state).toBe("pending");
    expect(after.current_step).toBe(0);

    // Director cannot approve straight away; step 1 must run again.
    await expect(store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 4000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/submissions.test.ts`
Expected: FAIL — `store.submitOvertime is not a function`.

- [ ] **Step 3: Write the module**

`src/store/submissions.ts`:

```ts
import type { ApprovalAction, EmployeeId, SubmissionState } from "../types.js";
import { resolveRoute, type RouteSnapshot, type RouteStep } from "../routes.js";
import { hasAuthorityOver, managersAt } from "./org.js";

export type NewSubmission = {
  employeeId: EmployeeId;
  requestedFor: string;
  minutes: number;
  reason: string;
  now: number;
  department: string | null;
  employmentType: string | null;
};

export type ActInput = {
  submissionId: number;
  actorId: EmployeeId;
  action: ApprovalAction;
  now: number;
  comment?: string;
};

export type SubmissionRow = {
  id: number;
  employee_id: number;
  kind: "overtime";
  requested_for: string;
  state: SubmissionState;
  submitted_at: number | null;
  current_step: number;
  minutes: number;
  reason: string;
  calculation_inputs: string | null;
  route_snapshot: string;
};

export type ApprovalEventRow = {
  id: number;
  submission_id: number;
  step_index: number;
  actor_employee_id: number;
  action: ApprovalAction;
  at: number;
  comment: string | null;
  authorizing_edge: number | null;
};

export class SelfApprovalError extends Error {
  readonly code = "KINTAI_SELF_APPROVAL";
  constructor() { super("KINTAI_SELF_APPROVAL: you cannot approve your own submission."); }
}

export class NotAuthorizedError extends Error {
  readonly code = "KINTAI_NOT_AUTHORIZED";
  constructor() { super("KINTAI_NOT_AUTHORIZED: you are not an approver for this step."); }
}

export class InvalidTransitionError extends Error {
  readonly code = "KINTAI_INVALID_TRANSITION";
  constructor(from: SubmissionState) {
    super(`KINTAI_INVALID_TRANSITION: a submission in state '${from}' cannot be acted on.`);
  }
}

export function getSubmission(sql: SqlStorage, id: number): SubmissionRow {
  return sql.exec<SubmissionRow>(`SELECT * FROM submissions WHERE id = ?`, id).one();
}

export function approvalEvents(sql: SqlStorage, submissionId: number): ApprovalEventRow[] {
  return sql
    .exec<ApprovalEventRow>(
      `SELECT * FROM approval_events WHERE submission_id = ? ORDER BY id`, submissionId,
    )
    .toArray();
}

/**
 * Create a submission, already pending. The resolved route is snapshotted onto the row: if route
 * configuration changes mid-approval, in-flight submissions must not mutate under their approvers.
 */
export function submitOvertime(sql: SqlStorage, input: NewSubmission): number {
  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: input.minutes,
  });

  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO submissions
         (employee_id, kind, requested_for, state, submitted_at, current_step,
          minutes, reason, calculation_inputs, route_snapshot)
       VALUES (?, 'overtime', ?, 'pending', ?, 0, ?, ?, NULL, ?) RETURNING id`,
      input.employeeId, input.requestedFor, input.now, input.minutes, input.reason,
      JSON.stringify(snapshot),
    )
    .one();
  return row.id;
}

/** Timestamp of the most recent `return`, or 0. Approvals before it no longer count. */
function lastReturnAt(sql: SqlStorage, submissionId: number): number {
  const row = sql
    .exec<{ at: number | null }>(
      `SELECT MAX(at) AS at FROM approval_events
       WHERE submission_id = ? AND action = 'return'`,
      submissionId,
    )
    .one();
  return row.at ?? 0;
}

/** Who may act on this step right now. "manager" resolves live; "employee" is pinned. */
function eligibleApprovers(
  sql: SqlStorage, submission: SubmissionRow, step: RouteStep, now: number,
): EmployeeId[] {
  if (step.approverKind === "employee") {
    return step.approverEmployeeId === null ? [] : [step.approverEmployeeId];
  }
  return managersAt(sql, submission.employee_id, now);
}

export function actOnSubmission(sql: SqlStorage, input: ActInput): SubmissionState {
  const submission = getSubmission(sql, input.submissionId);
  if (submission.state !== "pending") throw new InvalidTransitionError(submission.state);
  if (input.actorId === submission.employee_id) throw new SelfApprovalError();

  const snapshot = JSON.parse(submission.route_snapshot) as RouteSnapshot;
  const step = snapshot.steps[submission.current_step];
  if (!step) throw new InvalidTransitionError(submission.state);

  const eligible = eligibleApprovers(sql, submission, step, input.now);
  if (!eligible.includes(input.actorId)) throw new NotAuthorizedError();

  // Record which org edge granted authority, so the audit answers "were they authorised then?"
  // directly rather than by inference against today's org chart.
  const edge = step.approverKind === "manager"
    ? hasAuthorityOver(sql, input.actorId, submission.employee_id, input.now)
    : null;

  sql.exec(
    `INSERT INTO approval_events
       (submission_id, step_index, actor_employee_id, action, at, comment, authorizing_edge)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submission.id, submission.current_step, input.actorId, input.action, input.now,
    input.comment ?? null, edge,
  );

  if (input.action === "reject") {
    sql.exec(`UPDATE submissions SET state = 'rejected' WHERE id = ?`, submission.id);
    return "rejected";
  }

  if (input.action === "return") {
    // Approvers approved specific content. If the employee changes it, those approvals no longer
    // apply — so the submission restarts from step 0 and earlier approvals stop counting.
    sql.exec(
      `UPDATE submissions SET state = 'draft', current_step = 0 WHERE id = ?`, submission.id,
    );
    return "draft";
  }

  // approve — has this step's rule been satisfied since the last return?
  const since = lastReturnAt(sql, submission.id);
  const approvers = new Set(
    sql
      .exec<{ actor_employee_id: number }>(
        `SELECT DISTINCT actor_employee_id FROM approval_events
         WHERE submission_id = ? AND step_index = ? AND action = 'approve' AND at > ?`,
        submission.id, submission.current_step, since,
      )
      .toArray()
      .map((row) => row.actor_employee_id),
  );

  const satisfied = step.rule === "any_of"
    ? approvers.size > 0
    : eligible.every((id) => approvers.has(id));

  if (!satisfied) return "pending";

  const nextStep = submission.current_step + 1;
  if (nextStep < snapshot.steps.length) {
    sql.exec(`UPDATE submissions SET current_step = ? WHERE id = ?`, nextStep, submission.id);
    return "pending";
  }

  sql.exec(`UPDATE submissions SET state = 'approved' WHERE id = ?`, submission.id);
  return "approved";
}

/** Move a returned submission back into the queue, starting again at step 0. */
export function resubmit(
  sql: SqlStorage, submissionId: number, actorId: EmployeeId, now: number,
): void {
  const submission = getSubmission(sql, submissionId);
  if (submission.state !== "draft") throw new InvalidTransitionError(submission.state);
  if (submission.employee_id !== actorId) throw new NotAuthorizedError();

  sql.exec(
    `UPDATE submissions SET state = 'pending', current_step = 0, submitted_at = ? WHERE id = ?`,
    now, submissionId,
  );
}

export function withdrawSubmission(
  sql: SqlStorage, submissionId: number, actorId: EmployeeId,
): void {
  const submission = getSubmission(sql, submissionId);
  if (submission.employee_id !== actorId) throw new NotAuthorizedError();
  if (submission.state !== "pending" && submission.state !== "draft") {
    throw new InvalidTransitionError(submission.state);
  }
  sql.exec(`UPDATE submissions SET state = 'withdrawn' WHERE id = ?`, submissionId);
}
```

- [ ] **Step 4: Expose the module on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import {
  actOnSubmission, approvalEvents, getSubmission, resubmit, submitOvertime, withdrawSubmission,
  type ActInput, type ApprovalEventRow, type NewSubmission, type SubmissionRow,
} from "./submissions.js";
import type { SubmissionState } from "../types.js";
```

and to the class body:

```ts
  async submitOvertime(input: NewSubmission): Promise<number> {
    return submitOvertime(this.sql, input);
  }

  async actOnSubmission(input: ActInput): Promise<SubmissionState> {
    return actOnSubmission(this.sql, input);
  }

  async resubmit(submissionId: number, actorId: EmployeeId, now: number): Promise<void> {
    resubmit(this.sql, submissionId, actorId, now);
  }

  async withdrawSubmission(submissionId: number, actorId: EmployeeId): Promise<void> {
    withdrawSubmission(this.sql, submissionId, actorId);
  }

  async getSubmission(id: number): Promise<SubmissionRow> {
    return getSubmission(this.sql, id);
  }

  async approvalEvents(submissionId: number): Promise<ApprovalEventRow[]> {
    return approvalEvents(this.sql, submissionId);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/submissions.test.ts`
Expected: PASS — all nine cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add submission state machine with authority enforcement"
```

---

### Task 10: Root-of-organisation validation

Spec requirement: org configuration that leaves a non-exempt employee with no reachable approver
is rejected at write time, not discovered when a submission strands.

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/org.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/org-validation.test.ts`

**Interfaces:**
- Consumes: `managersAt` (Task 4), `isExempt` (Task 3).
- Produces:
  - `hasReachableApprover(sql, employeeId, at: number): boolean`
  - `assertApproverReachable(sql, employeeId, at: number): void`
  - `class NoApproverError extends Error` (`code = "KINTAI_NO_APPROVER"`)

- [ ] **Step 1: Write the failing test**

`__tests__/org-validation.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const APR = Date.parse("2026-04-01T00:00:00Z");
const JUL = Date.parse("2026-07-01T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`orgval-${seq++}`);
});

describe("reachable approver", () => {
  it("accepts an employee with a manager", async () => {
    const worker = await store.createEmployee({
      employeeNumber: "V1", displayName: "W", joinedOn: "2026-04-01",
    });
    const boss = await store.createEmployee({
      employeeNumber: "V2", displayName: "B", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(worker, boss, APR);

    expect(await store.hasReachableApprover(worker, JUL)).toBe(true);
  });

  it("accepts a root employee who is 管理監督者 for that period", async () => {
    const ceo = await store.createEmployee({
      employeeNumber: "V3", displayName: "CEO", joinedOn: "2026-04-01",
    });
    await store.grantExemption(ceo, APR);

    expect(await store.hasReachableApprover(ceo, JUL)).toBe(true);
  });

  it("accepts a root employee with a designated approver", async () => {
    const chair = await store.createEmployee({
      employeeNumber: "V4", displayName: "Chair", joinedOn: "2026-04-01",
    });
    const president = await store.createEmployee({
      employeeNumber: "V5", displayName: "President",
      designatedApproverId: chair, joinedOn: "2026-04-01",
    });

    expect(await store.hasReachableApprover(president, JUL)).toBe(true);
  });

  it("rejects a non-exempt root employee with no designated approver", async () => {
    const orphan = await store.createEmployee({
      employeeNumber: "V6", displayName: "Orphan", joinedOn: "2026-04-01",
    });

    expect(await store.hasReachableApprover(orphan, JUL)).toBe(false);
    await expect(store.assertApproverReachable(orphan, JUL))
      .rejects.toThrow(/KINTAI_NO_APPROVER/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/org-validation.test.ts`
Expected: FAIL — `store.hasReachableApprover is not a function`.

- [ ] **Step 3: Add the validation to `src/store/org.ts`**

Append to the file, and add `import { isExempt } from "./employees.js";` to its imports:

```ts
export class NoApproverError extends Error {
  readonly code = "KINTAI_NO_APPROVER";
  constructor(employeeId: EmployeeId) {
    super(
      `KINTAI_NO_APPROVER: employee ${employeeId} has no manager, no designated approver, and ` +
      `no 管理監督者 exemption. Give them one before saving this organisation.`,
    );
  }
}

/**
 * Whether this employee could ever have a submission approved. Self-approval is forbidden, so an
 * employee at the root of the org graph needs either an exemption (they raise no requests) or an
 * explicit designated approver. Checked when organisation data is written, so a misconfiguration
 * surfaces then rather than when someone's request strands in the queue.
 */
export function hasReachableApprover(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): boolean {
  if (managersAt(sql, employeeId, at).length > 0) return true;
  if (isExempt(sql, employeeId, at)) return true;

  const row = sql
    .exec<{ designated_approver_id: number | null }>(
      `SELECT designated_approver_id FROM employees WHERE id = ?`, employeeId,
    )
    .one();
  return row.designated_approver_id !== null;
}

export function assertApproverReachable(
  sql: SqlStorage, employeeId: EmployeeId, at: number,
): void {
  if (!hasReachableApprover(sql, employeeId, at)) throw new NoApproverError(employeeId);
}
```

- [ ] **Step 4: Expose on the DO**

Add `assertApproverReachable, hasReachableApprover` to the existing `./org.js` import in
`src/store/kintai-store.ts`, and add to the class body:

```ts
  async hasReachableApprover(employeeId: EmployeeId, at: number): Promise<boolean> {
    return hasReachableApprover(this.sql, employeeId, at);
  }

  async assertApproverReachable(employeeId: EmployeeId, at: number): Promise<void> {
    assertApproverReachable(this.sql, employeeId, at);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/org-validation.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): reject org configuration with no reachable approver"
```

---

### Task 11: Period locks and audit log

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/periods.ts`
- Create: `packages/gatekeeper-kintai/src/store/audit.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`
- Test: `packages/gatekeeper-kintai/__tests__/periods.test.ts`

**Interfaces:**
- Consumes: `createEmployee` (Task 3).
- Produces:
  - `periodOf(workDate: string): string` — `"2026-07-03"` → `"2026-07"`
  - `isLocked(sql, workDate: string): boolean`
  - `lockPeriod(sql, period: string, lockedBy: EmployeeId, now: number): void`
  - `assertWritable(sql, workDate: string): void`
  - `class PeriodLockedError extends Error` (`code = "KINTAI_PERIOD_LOCKED"`)
  - `appendAudit(sql, entry: AuditEntry): void` where
    `AuditEntry = { at: number; actorEmployeeId: EmployeeId | null; action: string; entity: string; entityId?: number; before?: unknown; after?: unknown }`

- [ ] **Step 1: Write the failing test**

`__tests__/periods.test.ts`:

```ts
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
    await expect(store.assertWritable("2026-07-03"))
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/periods.test.ts`
Expected: FAIL — cannot resolve `../src/store/periods.js`.

- [ ] **Step 3: Write the modules**

`src/store/periods.ts`:

```ts
import type { EmployeeId } from "../types.js";

/**
 * The lock is what makes append-only storage mean something: without it, "append-only" only means
 * the table grows. After a period closes, punches and allocations for it are writable only through
 * the amendment path, which requires approval and stays permanently visible.
 */
export class PeriodLockedError extends Error {
  readonly code = "KINTAI_PERIOD_LOCKED";
  constructor(period: string) {
    super(
      `KINTAI_PERIOD_LOCKED: ${period} is closed. Submit an amendment for approval instead of ` +
      `editing the record directly.`,
    );
  }
}

/** "2026-07-03" -> "2026-07". work_date is already a JST calendar date. */
export function periodOf(workDate: string): string {
  return workDate.slice(0, 7);
}

export function isLocked(sql: SqlStorage, workDate: string): boolean {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM period_locks WHERE period = ?`, periodOf(workDate),
    )
    .one();
  return row.n > 0;
}

export function lockPeriod(
  sql: SqlStorage, period: string, lockedBy: EmployeeId, now: number,
): void {
  sql.exec(
    `INSERT OR REPLACE INTO period_locks (period, locked_at, locked_by) VALUES (?, ?, ?)`,
    period, now, lockedBy,
  );
}

export function assertWritable(sql: SqlStorage, workDate: string): void {
  if (isLocked(sql, workDate)) throw new PeriodLockedError(periodOf(workDate));
}
```

`src/store/audit.ts`:

```ts
import type { EmployeeId } from "../types.js";

export type AuditEntry = {
  at: number;
  actorEmployeeId: EmployeeId | null;
  action: string;
  entity: string;
  entityId?: number;
  before?: unknown;
  after?: unknown;
};

export type AuditRow = {
  id: number;
  at: number;
  actor_employee_id: number | null;
  action: string;
  entity: string;
  entity_id: number | null;
  before: string | null;
  after: string | null;
};

/**
 * Authority-relevant changes only: account linking, org edges, exemptions, route configuration and
 * period locks. Attendance data is not duplicated here — punches, allocations and approval_events
 * are already append-only and are their own audit trail.
 */
export function appendAudit(sql: SqlStorage, entry: AuditEntry): void {
  sql.exec(
    `INSERT INTO audit_log
       (at, actor_employee_id, action, entity, entity_id, before, after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entry.at, entry.actorEmployeeId, entry.action, entry.entity, entry.entityId ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
  );
}

export function auditEntries(sql: SqlStorage): AuditRow[] {
  return sql.exec<AuditRow>(`SELECT * FROM audit_log ORDER BY id`).toArray();
}
```

- [ ] **Step 4: Expose on the DO**

Add to `src/store/kintai-store.ts` imports:

```ts
import { assertWritable, isLocked, lockPeriod } from "./periods.js";
import { appendAudit, auditEntries, type AuditEntry, type AuditRow } from "./audit.js";
```

and to the class body:

```ts
  async isLocked(workDate: string): Promise<boolean> {
    return isLocked(this.sql, workDate);
  }

  async lockPeriod(period: string, lockedBy: EmployeeId, now: number): Promise<void> {
    lockPeriod(this.sql, period, lockedBy, now);
  }

  async assertWritable(workDate: string): Promise<void> {
    assertWritable(this.sql, workDate);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    appendAudit(this.sql, entry);
  }

  async auditEntries(): Promise<AuditRow[]> {
    return auditEntries(this.sql);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/periods.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 6: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add period locks and authority audit log"
```

---

### Task 12: Account capability and the workspace facet

The facet is the only surface Gadget code reaches. Every method resolves the employee from
`accountId` before doing anything, and no method accepts an employee identifier from the caller.

**Files:**
- Modify: `packages/gatekeeper-kintai/src/kintai.ts`
- Modify: `packages/gatekeeper-kintai/src/worker.ts`
- Modify: `packages/gatekeeper-kintai/__tests__/worker.ts`
- Test: `packages/gatekeeper-kintai/__tests__/facet.test.ts`

**Interfaces:**
- Consumes: every store method from Tasks 3–11.
- Produces:
  - `class KintaiAccount extends WorkerEntrypoint` implementing `GatekeeperUser`, props `{ accountId: string }`
  - `class KintaiGatekeeper extends DurableObject`, props `{ accountId: string }`, with
    `whoAmI()`, `punch(kind, location?)`, `getDay(workDate)`, `setAllocations(workDate, entries)`,
    `submitOvertime(requestedFor, minutes, reason)`, `listPendingApprovals()`,
    `actOnSubmission(submissionId, action, comment?)`

- [ ] **Step 1: Write the failing test**

`__tests__/facet.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The facet reads the shared store; tests seed through the store directly, then act through the
// facet exactly as Gadget code would.
let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  // The facet reaches the singleton store, named "". Seed that same instance.
  store = env.KINTAI_STORE.getByName("");
});

function facetFor(accountId: string) {
  return env.KINTAI_FACET.getByName(`facet-${accountId}-${seq++}`, { accountId });
}

describe("identity resolution", () => {
  it("reports the linked employee", async () => {
    const id = await store.createEmployee({
      employeeNumber: `F${seq}`, displayName: "Tanaka", joinedOn: "2026-04-01",
    });
    await store.linkAccount(`acct-${seq}`, id, Date.now());

    using facet = facetFor(`acct-${seq}`);
    const me = await facet.whoAmI();
    expect(me.employeeId).toBe(id);
    expect(me.linked).toBe(true);
  });

  it("reports an unlinked account rather than throwing, so the UI can explain it", async () => {
    using facet = facetFor("acct-never-linked");
    const me = await facet.whoAmI();
    expect(me.linked).toBe(false);
    expect(me.employeeId).toBeNull();
  });

  it("refuses every other operation for an unlinked account", async () => {
    using facet = facetFor("acct-also-never-linked");
    await expect(facet.punch("in")).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);
  });
});

describe("punching through the facet", () => {
  it("records a punch against the caller's own employee record", async () => {
    const id = await store.createEmployee({
      employeeNumber: `G${seq}`, displayName: "Ito", joinedOn: "2026-04-01",
    });
    const account = `acct-g-${seq}`;
    await store.linkAccount(account, id, Date.now());

    using facet = facetFor(account);
    const result = await facet.punch("in");

    expect(result.punchId).toEqual(expect.any(Number));
    expect(result.employeeId).toBe(id);
  });
});
```

Append to the same file:

```ts
describe("own-submission scoping", () => {
  it("lists only the caller's own submissions", async () => {
    const mine = await store.createEmployee({
      employeeNumber: `H${seq}`, displayName: "Mine", joinedOn: "2026-04-01",
    });
    const theirs = await store.createEmployee({
      employeeNumber: `H${seq}x`, displayName: "Theirs", joinedOn: "2026-04-01",
    });
    const boss = await store.createEmployee({
      employeeNumber: `H${seq}b`, displayName: "Boss", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(mine, boss, 0);
    await store.setReportingLine(theirs, boss, 0);
    await store.createRoute({
      name: `r${seq}`,
      steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
    });

    const account = `acct-h-${seq}`;
    await store.linkAccount(account, mine, Date.now());
    await store.submitOvertime({
      employeeId: theirs, requestedFor: "2026-07-03", minutes: 60,
      reason: "theirs", now: Date.now(), department: null, employmentType: null,
    });

    using facet = facetFor(account);
    await facet.submitOvertime("2026-07-03", 60, "mine");

    const listed = await facet.listMySubmissions();
    expect(listed).toHaveLength(1);
    expect(listed[0].employee_id).toBe(mine);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/facet.test.ts`
Expected: FAIL — `env.KINTAI_FACET` is not defined.

- [ ] **Step 3: Register the facet binding in `vitest.config.ts`**

Add to the `durableObjects` block:

```ts
          KINTAI_FACET: { className: "KintaiGatekeeper", useSQLite: true },
```

- [ ] **Step 4: Write the account and facet**

Append to `src/kintai.ts` (add these imports at the top of the file):

```ts
import { DurableObject } from "cloudflare:workers";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  EmployeeId, ApprovalAction, PunchKind, SubmissionState,
} from "./types.js";
import type { AllocationEntry } from "./store/allocations.js";
import type { PunchLocation } from "./store/punches.js";
import { UnlinkedAccountError } from "./store/employees.js";
import { periodOf } from "./store/periods.js";
```

```ts
type KintaiProps = { accountId: string };

@validateRpc()
export class KintaiAccount
  extends WorkerEntrypoint<Cloudflare.Env, KintaiProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Kintai",
      avatar: KINTAI_ICON,
      singleton: { tsType: "KintaiSession" },
      providesUi: { title: "Kintai", icon: KINTAI_ICON },
    };
  }

  /** The workspace facet class, imbued with this account's capability. */
  async getSingletonGatekeeperClass() {
    return this.ctx.exports.KintaiGatekeeper({ props: this.ctx.props });
  }
}

@validateRpc()
export class KintaiGatekeeper extends DurableObject<Cloudflare.Env, KintaiProps> {
  /** The one shared store. Named "" so every facet reaches the same instance. */
  get #store() {
    return this.ctx.exports.KintaiStore.getByName("");
  }

  get #accountId(): string {
    return this.ctx.props.accountId;
  }

  /**
   * Identity comes from the capability, never from an argument. Every method below starts here,
   * so a Gadget cannot name an employee it is not.
   */
  async #requireEmployee(now: number): Promise<EmployeeId> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, now);
    if (employeeId === null) throw new UnlinkedAccountError();
    return employeeId;
  }

  /** Non-throwing: the UI needs to explain an unlinked account rather than show an error. */
  async whoAmI(): Promise<{ linked: boolean; employeeId: EmployeeId | null }> {
    const employeeId = await this.#store.resolveAccount(this.#accountId, Date.now());
    return { linked: employeeId !== null, employeeId };
  }

  async punch(
    kind: PunchKind, location?: PunchLocation,
  ): Promise<{ punchId: number; employeeId: EmployeeId; workDate: string }> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const workDate = jstWorkDate(now);
    await this.#store.assertWritable(workDate);

    const punchId = await this.#store.recordPunch({
      employeeId, workDate, kind, now, source: "gadget", location,
    });
    return { punchId, employeeId, workDate };
  }

  async getDay(workDate: string) {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return {
      punches: await this.#store.currentPunches(employeeId, workDate),
      allocations: await this.#store.currentAllocations(employeeId, workDate),
      reconciliation: await this.#store.reconcile(employeeId, workDate),
      locked: await this.#store.isLocked(workDate),
    };
  }

  async setAllocations(workDate: string, entries: AllocationEntry[]) {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    await this.#store.assertWritable(workDate);
    return this.#store.setAllocations(employeeId, workDate, entries);
  }

  async submitOvertime(
    requestedFor: string, minutes: number, reason: string,
  ): Promise<number> {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    const profile = await this.#store.employeeProfile(employeeId);
    return this.#store.submitOvertime({
      employeeId, requestedFor, minutes, reason, now,
      department: profile.department, employmentType: profile.employment_type,
    });
  }

  async withdrawSubmission(submissionId: number): Promise<void> {
    const actorId = await this.#requireEmployee(Date.now());
    return this.#store.withdrawSubmission(submissionId, actorId);
  }

  /** Move a returned submission back into the queue. The only path out of `draft`. */
  async resubmit(submissionId: number): Promise<void> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    return this.#store.resubmit(submissionId, actorId, now);
  }

  /** Own submissions only — the employee id comes from the capability, not the caller. */
  async listMySubmissions() {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#store.listSubmissionsFor(employeeId);
  }

  /** Derived from the org graph. Never accepts an employee id from the caller. */
  async listPendingApprovals() {
    const now = Date.now();
    const employeeId = await this.#requireEmployee(now);
    return this.#store.pendingApprovalsFor(employeeId, now);
  }

  async actOnSubmission(
    submissionId: number, action: ApprovalAction, comment?: string,
  ): Promise<SubmissionState> {
    const now = Date.now();
    const actorId = await this.#requireEmployee(now);
    return this.#store.actOnSubmission({ submissionId, actorId, action, now, comment });
  }
}

/** JST calendar date for a UTC instant. JST has no DST, so a fixed +9h offset is correct. */
export function jstWorkDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
```

- [ ] **Step 5: Add the two store methods the facet needs**

Add to `src/store/employees.ts`:

```ts
export type EmployeeProfile = {
  id: number;
  department: string | null;
  employment_type: string | null;
};

export function employeeProfile(sql: SqlStorage, employeeId: EmployeeId): EmployeeProfile {
  return sql
    .exec<EmployeeProfile>(
      `SELECT id, department, employment_type FROM employees WHERE id = ?`, employeeId,
    )
    .one();
}
```

Add to `src/store/submissions.ts`:

```ts
/** Submissions awaiting this approver, derived from the org graph — never from a caller's claim. */
export function pendingApprovalsFor(
  sql: SqlStorage, approverId: EmployeeId, now: number,
): SubmissionRow[] {
  return sql
    .exec<SubmissionRow>(
      `SELECT s.* FROM submissions s
       WHERE s.state = 'pending' AND s.employee_id != ?
         AND EXISTS (
           SELECT 1 FROM org_edges e
           WHERE e.employee_id = s.employee_id AND e.manager_id = ?
             AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?))
       ORDER BY s.submitted_at`,
      approverId, approverId, now, now,
    )
    .toArray();
}
```

```ts
/** Every submission belonging to one employee, newest first. */
export function listSubmissionsFor(
  sql: SqlStorage, employeeId: EmployeeId,
): SubmissionRow[] {
  return sql
    .exec<SubmissionRow>(
      `SELECT * FROM submissions WHERE employee_id = ? ORDER BY id DESC`, employeeId,
    )
    .toArray();
}
```

Expose all three on `KintaiStore`:

```ts
  async employeeProfile(employeeId: EmployeeId): Promise<EmployeeProfile> {
    return employeeProfile(this.sql, employeeId);
  }

  async pendingApprovalsFor(approverId: EmployeeId, now: number): Promise<SubmissionRow[]> {
    return pendingApprovalsFor(this.sql, approverId, now);
  }

  async listSubmissionsFor(employeeId: EmployeeId): Promise<SubmissionRow[]> {
    return listSubmissionsFor(this.sql, employeeId);
  }
```

adding `employeeProfile, type EmployeeProfile` to the `./employees.js` import and
`listSubmissionsFor, pendingApprovalsFor` to the `./submissions.js` import.

- [ ] **Step 6: Export the new classes**

`src/worker.ts`:

```ts
export {
  GatekeeperVendor as default, GatekeeperVendor, KintaiAccount, KintaiGatekeeper,
} from "./kintai.js";
export { KintaiStore } from "./store/kintai-store.js";
```

Add the same names to `__tests__/worker.ts`:

```ts
export { GatekeeperVendor, KintaiAccount, KintaiGatekeeper } from "../src/kintai.js";
```

Add `KintaiGatekeeper` to the `new_sqlite_classes` list in `wrangler.jsonc` — it is already listed
from Task 1, so no change is needed if that was followed.

- [ ] **Step 7: Run the test**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run __tests__/facet.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `cd packages/gatekeeper-kintai && pnpm exec vitest run && pnpm run build`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/gatekeeper-kintai
git commit -m "feat(kintai): add account capability and workspace facet"
```

---

## Verification

After Task 12, confirm the gatekeeper is discovered end to end:

- [ ] Run `pnpm run-local` from the repository root.
- [ ] Confirm the startup output lists `GATEKEEPER_KINTAI` among the bound gatekeepers —
      `scripts/run-dev-server.ts` derives it from the `packages/gatekeeper-kintai/` directory name.
- [ ] Visit http://localhost:8787, open the admin **Gatekeepers** panel, and confirm **Kintai**
      appears with a mode selector. Set it to **enabled**.
- [ ] Confirm the account is auto-provisioned for your user, and that a Gadget bound to it gets
      `linked: false` from `whoAmI()` until an employee record is linked.

## Notes for sub-project 2 (overtime engine)

Two items surfaced during this plan that belong in the engine's own spec:

- **管理監督者 are exempt from 時間外 and 休日 premiums but not from 深夜割増 (22:00–05:00).**
  `isExempt()` must not be read as "stop calculating". Test this case explicitly.
- **`workedMinutes()` deliberately contributes nothing for an unpaired `in`.** The
  forgot-to-clock-out case is an exception for a human to resolve, never an auto-closed shift.
