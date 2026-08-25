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
  // At most one current correction per punch: a database constraint, not an application check,
  // because later tasks rely on currentPunches() never returning two rows that both claim to
  // supersede the same original.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS punches_supersedes_unique
    ON punches(supersedes_id) WHERE supersedes_id IS NOT NULL`);

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
