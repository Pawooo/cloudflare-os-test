// The full kintai schema. Applied on every DO activation; every statement is IF NOT EXISTS so
// this is idempotent. All tables are STRICT. An enum column whose set is FIXED carries a CHECK
// constraint, matching packages/mcp-shared/src/action-store.ts; one that will keep GROWING is a
// foreign key onto a seeded lookup table instead, because SQLite cannot alter a CHECK. See the
// block at the top of applySchema.
//
// punches, approval_events and audit_log are append-only: corrections insert a new row rather
// than updating an existing one. See the design doc's data model section.

import { PUNCH_SOURCES, SUBMISSION_KINDS } from "../types.js";

/** Whether `table` already has `column`. The test every ADD COLUMN below is guarded by. */
export function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .some((row) => row.name === column);
}

/**
 * Refuse to run against a store predating the lookup tables.
 *
 * Such a store still has `CHECK (kind IN ('overtime'))` and will refuse every amendment with a
 * bare constraint failure at the first write, hours after the deploy that caused it. There is no
 * migration: converting the column is itself a table rebuild, which is what the lookup tables
 * exist to avoid, and there is no deployed store whose data needs preserving. So this is a dev
 * affordance -- it turns a confusing write failure into an instruction.
 *
 * `submissions` alone is probed because both columns moved in one change: a store whose
 * `submissions.kind` is a foreign key has a `punches.source` that is one too, and a store whose
 * `kind` is still a CHECK has neither. One question answers for both.
 *
 * If a store with data ever needs this conversion, it is a real migration and belongs somewhere
 * that can fail without resetting the object. `applySchema` runs in the constructor, so a throw
 * here bricks the store on every activation rather than degrading -- acceptable for a dev store
 * that must be reset anyway, and NOT acceptable as a general migration strategy.
 */
function assertSchemaCurrent(sql: SqlStorage): void {
  const row = sql
    .exec<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'submissions'`,
    )
    .toArray()[0];
  if (row?.sql && !row.sql.includes("submission_kinds")) {
    throw new Error(
      `KINTAI_STALE_SCHEMA: this store predates the submission_kinds lookup table and cannot ` +
      `accept amendments. There is no migration -- delete this store's own Durable Object ` +
      `storage (.wrangler/state/v3/do/gatekeeper-kintai-KintaiStore) and re-seed. Deleting all ` +
      `of .wrangler/state is NOT required and costs every other gatekeeper's data. See ` +
      `docs/resetting-the-dev-store.md.`,
    );
  }
}

export function applySchema(sql: SqlStorage): void {
  // Growing enumerations live in lookup tables, not in CHECK constraints.
  //
  // SQLite cannot alter a CHECK, and DO SQLite enforces foreign keys immediately with an
  // end-of-turn integrity check on top -- so widening a CHECK means rebuilding the table, which
  // means rebuilding everything that references it. `submissions` drags `approval_events`;
  // `punches` drags `punch_locations`, `amendment_requests` and its own `supersedes_id`. These two
  // columns will keep growing (expenses, travel claims, imports), so they are foreign keys and
  // adding a value is an INSERT.
  //
  // CHECK stays where the set is genuinely fixed: `minutes >= 0`, `json_valid(...)`, the state
  // machine. Those are invariants, not enumerations.
  //
  // Created before anything that references them, because the constraint is checked at once. Get
  // this order wrong and store creation itself fails, not some later write.
  //
  // The values come from `src/types.ts`, which is also where their TypeScript unions are derived
  // from, so the seed and the type are one list and cannot disagree. `INSERT OR IGNORE` with a
  // bound parameter per value is what makes re-running this on every activation safe.
  sql.exec(`CREATE TABLE IF NOT EXISTS submission_kinds (kind TEXT PRIMARY KEY) STRICT`);
  for (const kind of SUBMISSION_KINDS) {
    sql.exec(`INSERT OR IGNORE INTO submission_kinds (kind) VALUES (?)`, kind);
  }

  sql.exec(`CREATE TABLE IF NOT EXISTS punch_sources (source TEXT PRIMARY KEY) STRICT`);
  for (const source of PUNCH_SOURCES) {
    sql.exec(`INSERT OR IGNORE INTO punch_sources (source) VALUES (?)`, source);
  }

  assertSchemaCurrent(sql);

  sql.exec(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    department TEXT,
    employment_type TEXT,
    designated_approver_id INTEGER REFERENCES employees(id),
    status TEXT NOT NULL CHECK (status IN ('active', 'leave', 'departed')),
    joined_on TEXT NOT NULL,
    departed_on TEXT,
    -- Which day this employee's punches are filed against. See WorkDatePolicy in types.ts.
    -- The DEFAULT is the whole safety property of this feature: an employee record written
    -- before the column existed, and one created by any caller that does not mention it, both
    -- come out 'calendar' -- exactly how they behaved before there was a policy at all.
    work_date_policy TEXT NOT NULL DEFAULT 'calendar'
      CHECK (work_date_policy IN ('calendar', 'shift_start'))
  ) STRICT`);
  // A store created before the policy existed has the table without that column, and `employees`
  // holds real payroll records — it cannot be recreated. ADD COLUMN with a non-null DEFAULT is
  // the one shape SQLite allows for a NOT NULL addition, and it backfills every existing row with
  // 'calendar', which is the behaviour those employees already had.
  if (!hasColumn(sql, "employees", "work_date_policy")) {
    sql.exec(
      `ALTER TABLE employees ADD COLUMN work_date_policy TEXT NOT NULL DEFAULT 'calendar'
         CHECK (work_date_policy IN ('calendar', 'shift_start'))`,
    );
  }

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
    source TEXT NOT NULL REFERENCES punch_sources(source),
    supersedes_id INTEGER REFERENCES punches(id),
    amended_by INTEGER REFERENCES employees(id),
    amend_reason TEXT
  ) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS punches_by_day
    ON punches(employee_id, work_date)`);
  // Attribution asks one question of this table on every punch a `shift_start` employee makes:
  // "when did this employee last clock in?" — bounded to the last 16 hours. `punches_by_day` is
  // keyed on the work date, which is the answer being computed and so cannot be the way in; this
  // index makes that lookup a range scan of at most a shift's worth of rows instead of a walk
  // over the employee's whole punch history. See `workDateFor` in punches.ts.
  sql.exec(`CREATE INDEX IF NOT EXISTS punches_by_time
    ON punches(employee_id, kind, occurred_at)`);
  // At most one current correction per punch: a database constraint, not an application check,
  // because later tasks rely on currentPunches() never returning two rows that both claim to
  // supersede the same original.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS punches_supersedes_unique
    ON punches(supersedes_id) WHERE supersedes_id IS NOT NULL`);

  // Location lives in its OWN table, one row per punch at most, rather than as columns on the
  // punch. Coordinates tied to an individual are personal data under 個人情報保護法 and the design
  // gives them a shorter retention clock than the punch itself — but `punches` is append-only, so
  // purging columns off a punch row would require UPDATE or DELETE against a table where both are
  // forbidden. Separating them makes the purge sub-project 5 owns a DELETE against this table
  // alone, leaving every attendance record untouched and unrewritten.
  //
  // Both the raw coordinates and the evaluated `matched_site_id` are kept together: site
  // boundaries are redrawn over time, so a dispute needs the evaluation as it stood AND the
  // underlying data — and a purge that removes the coordinates must remove the derived match with
  // them, which one row makes automatic.
  //
  // A row exists whenever the caller supplied any location at all, including a refusal
  // (`location_source = 'denied'`, no coordinates): recording that the punch was made without a
  // fix is itself information, and it is distinct from a punch that never offered one.
  sql.exec(`CREATE TABLE IF NOT EXISTS punch_locations (
    punch_id INTEGER PRIMARY KEY REFERENCES punches(id),
    latitude REAL,
    longitude REAL,
    accuracy_m REAL,
    location_source TEXT CHECK (
      location_source IS NULL OR location_source IN ('gps', 'denied', 'unavailable', 'manual')),
    matched_site_id INTEGER REFERENCES sites(id)
  ) STRICT`);

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

  // A fallback route, so a store that nobody has configured can still route an approval.
  //
  // Without one, `resolveRoute` finds no candidate and throws `KINTAI_NO_ROUTE`: overtime and
  // every amendment are unreachable on a fresh store, and nothing in the admin API can create a
  // route to fix it (`createRoute` exists on the store and has no caller outside the worker). So
  // the choice was a store that cannot approve anything, or a default -- and a system whose first
  // approval silently fails is worse than one whose default is written down here.
  //
  // Deliberately the LEAST specific route possible: no department, no employment type, no minute
  // floor. `selectRoute` scores specificity, so ANY route an administrator configures outranks
  // this one for the submissions it matches; this only ever decides a case nothing else claims.
  // One step, any manager, which is the weakest rule that still requires a human other than the
  // employee -- `checkMayAct` refuses the employee and the filer regardless of route.
  //
  // Seeded only when there are no routes at all, not `INSERT OR IGNORE` on a fixed id: an
  // administrator who has configured their own routes must not have this reappear underneath them
  // on the next activation. Once any route exists this never runs again.
  const routeCount = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM approval_routes`)
    .one().n;
  if (routeCount === 0) {
    const route = sql
      .exec<{ id: number }>(
        `INSERT INTO approval_routes (name, department, employment_type, min_minutes)
         VALUES ('Default -- any manager', NULL, NULL, 0) RETURNING id`,
      )
      .one();
    sql.exec(
      `INSERT INTO approval_route_steps
         (route_id, step_index, rule, approver_kind, approver_employee_id)
       VALUES (?, 0, 'any_of', 'manager', NULL)`,
      route.id,
    );
  }

  sql.exec(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    kind TEXT NOT NULL REFERENCES submission_kinds(kind),
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
    -- Who filed this. Nullable because a row may predate the column or come from an importer,
    -- but without it a fabricated submission followed by a legitimate approval leaves an audit
    -- trail that looks clean: employee_id says whose overtime it is, never whose hand filed it.
    created_by INTEGER REFERENCES employees(id)
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
