import type { EmployeeId, EmployeeRow, NewEmployee } from "../types.js";
import { InvalidInputError } from "../input.js";

// Both are declared in `types.ts` so `app/` can render one and submit the other without pulling
// worker types into the browser build; re-exported here because this is where their queries live
// and every existing caller reads them from this module. See their comments in `types.ts`.
export type { EmployeeRow, NewEmployee };

/**
 * Thrown when a caller's account capability has no open link to an employee record.
 *
 * The code is repeated in the message, as every other error in this package does, because `code`
 * is a plain own property and does not survive the RPC boundary — a Gadget receives the message
 * and nothing else, so the message is the only place a caller can read the code from.
 */
export class UnlinkedAccountError extends Error {
  readonly code = "KINTAI_ACCOUNT_NOT_LINKED";
  constructor() {
    super(
      "KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an employee record. " +
      "Contact HR to be set up.",
    );
  }
}

/**
 * Create an employee record.
 *
 * `employee_number` is UNIQUE in the schema, and re-using one is an ordinary HR mistake — the same
 * person typed in twice, or a code copied from the wrong spreadsheet row. SQLite reports it as
 * `UNIQUE constraint failed: employees.employee_number`, which the RPC boundary can only turn into
 * an uncoded 500, so it is caught here, at the statement that raises it, and re-thrown as the same
 * coded error every other rejected input in this package uses. The constraint stays the authority:
 * this translates the refusal, it does not check first and hope.
 */
export function createEmployee(sql: SqlStorage, input: NewEmployee): EmployeeId {
  let row: { id: number };
  try {
    row = sql
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
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message.includes("UNIQUE constraint failed: employees.employee_number")) {
      throw new InvalidInputError(
        `employee number ${input.employeeNumber} already belongs to another employee record.`,
      );
    }
    throw caught;
  }
  return row.id;
}

/**
 * Point `accountId` at `employeeId`. Closes any currently-open link first — either one keyed on
 * this same accountId (re-pointing an account at a different employee; required so the partial
 * unique index, one open link per account, doesn't reject the insert) or one keyed on this same
 * employeeId (an email change: a new verified email yields a new UserDurableObject and therefore
 * a new accountId, and the employee's previous account should stop resolving).
 *
 * Re-linking is the supported path for an email change: the employee record — and all history
 * hanging off it — is unchanged; only which accountId currently resolves to it changes.
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
    `UPDATE account_links SET valid_to = ?
     WHERE (account_id = ? OR employee_id = ?) AND valid_to IS NULL`,
    now, accountId, employeeId,
  );
  sql.exec(
    `INSERT INTO account_links (account_id, employee_id, valid_from, valid_to, linked_by, reason)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    accountId, employeeId, now, linkedBy ?? null, reason ?? null,
  );
}

/**
 * Close this account's open link, if it has one. Returns whether one was open.
 *
 * This is the whole of account revocation, and deliberately so: it is the inverse of the closing
 * half of `linkAccount`, not a deletion. The employee record and every punch, allocation and
 * submission hanging off it are payroll history the company must keep; what stops is the
 * capability's ability to resolve to that employee. Idempotent — closing an already-closed (or
 * never-opened) account is a no-op, so a repeated `revoke()` cannot rewrite the original
 * `valid_to`.
 *
 * There is no matching "unlink employee": HR re-points an employee at a new account with
 * `linkAccount`, which closes whatever was open on either side.
 */
export function unlinkAccount(sql: SqlStorage, accountId: string, now: number): boolean {
  const cursor = sql.exec(
    `UPDATE account_links SET valid_to = ? WHERE account_id = ? AND valid_to IS NULL`,
    now, accountId,
  );
  // Drain the cursor before reading rowsWritten; SqlStorage reports it only once the statement has
  // actually run.
  cursor.toArray();
  return cursor.rowsWritten > 0;
}

/** One row of `account_links`. */
export type AccountLinkRow = {
  id: number;
  account_id: string;
  employee_id: number;
  valid_from: number;
  valid_to: number | null;
  linked_by: number | null;
  reason: string | null;
};

/**
 * The account's currently-open link, or null. Test-only introspection.
 *
 * `resolveAccount` answers the question the runtime asks ("which employee is this?"); this exposes
 * the rest of the row — notably `linked_by`, the audit trail for the one operation that grants
 * identity — which nothing in the runtime reads back.
 */
export function openAccountLink(sql: SqlStorage, accountId: string): AccountLinkRow | null {
  return sql
    .exec<AccountLinkRow>(
      `SELECT id, account_id, employee_id, valid_from, valid_to, linked_by, reason
       FROM account_links WHERE account_id = ? AND valid_to IS NULL`,
      accountId,
    )
    .toArray()[0] ?? null;
}

/**
 * The validity window every read of `account_links` shares, as one SQL fragment.
 *
 * Written once because "is this link in force?" is a rule, and this package has twice produced
 * real bugs from two copies of one rule drifting apart. `resolveAccount` answers it for one
 * account; `linkedEmployeeIds` answers it across the roster; both must agree, or an employee can
 * read "linked" on their own page while HR's roster shows them unlinked. Takes `?, ?` — the same
 * instant, twice.
 */
const LINK_IN_FORCE = `valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`;

/** The employee this account mapped to at `at`, or null if it mapped to none. */
export function resolveAccount(
  sql: SqlStorage,
  accountId: string,
  at: number,
): EmployeeId | null {
  const row = sql
    .exec<{ employee_id: number }>(
      `SELECT employee_id FROM account_links
       WHERE account_id = ? AND ${LINK_IN_FORCE}
       -- 'id DESC' breaks a valid_from tie deterministically: two links opened at the same instant
       -- would otherwise resolve to an arbitrary employee, and this is the identity boundary.
       -- (The partial unique index allows at most one OPEN link per account, but closed links can
       -- still share a valid_from.) Newest row wins.
       ORDER BY valid_from DESC, id DESC LIMIT 1`,
      accountId, at, at,
    )
    .toArray()[0];
  return row ? row.employee_id : null;
}

/**
 * Every employee an account currently resolves to, at `at`.
 *
 * The roster's "can this person sign in as themselves yet?" column, answered in one query rather
 * than one per row. Returns employee ids and NEVER the account codes behind them: HR has no
 * business reading anyone's account code off a list, and the only supported way to learn one stays
 * the employee reading it off their own page. It is a Set because the caller asks it a membership
 * question once per roster row.
 *
 * Shares `LINK_IN_FORCE` with `resolveAccount`, so "linked" on the roster means exactly what
 * "linked" means when the employee's own capability answers `whoAmI`.
 */
export function linkedEmployeeIds(sql: SqlStorage, at: number): Set<EmployeeId> {
  const rows = sql
    .exec<{ employee_id: number }>(
      `SELECT DISTINCT employee_id FROM account_links WHERE ${LINK_IN_FORCE}`,
      at, at,
    )
    .toArray();
  return new Set(rows.map((row) => row.employee_id));
}

/**
 * Thrown when a caller names an employee record that does not exist.
 *
 * Coded, and the code repeated in the message, for the reason every error in this package is: the
 * RPC boundary delivers the message and nothing else. Without it, an admin who mistypes an id gets
 * whatever SQLite says about a foreign key — or, where foreign keys are not enforced, an
 * `account_links` row pointing at nobody and a silent success.
 */
export class EmployeeNotFoundError extends Error {
  readonly code = "KINTAI_NOT_FOUND";
  constructor(employeeId: EmployeeId) {
    super(`KINTAI_NOT_FOUND: there is no employee ${employeeId}.`);
  }
}

/** Whether an employee record exists. Status is not consulted: departed employees still exist. */
export function employeeExists(sql: SqlStorage, employeeId: EmployeeId): boolean {
  return sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM employees WHERE id = ?`, employeeId)
    .one().n > 0;
}

/**
 * The employee's fallback approver, or null.
 *
 * `designated_approver_id` is the escape hatch for employees at the root of the reporting tree,
 * who have no manager edge and would otherwise have no one able to approve anything they file.
 * It is deliberately NOT part of `hasAuthorityOver`: that answers "which org edge authorised
 * this?", and a designated approver is authority granted by the employee record itself, with no
 * edge and no validity window behind it.
 */
export function designatedApproverOf(
  sql: SqlStorage,
  employeeId: EmployeeId,
): EmployeeId | null {
  const row = sql
    .exec<{ designated_approver_id: number | null }>(
      `SELECT designated_approver_id FROM employees WHERE id = ?`, employeeId,
    )
    .toArray()[0];
  return row?.designated_approver_id ?? null;
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

export type EmployeeProfile = {
  id: number;
  department: string | null;
  employment_type: string | null;
};

/**
 * Every employee, oldest first.
 *
 * Unfiltered by status on purpose. A departed employee still owns payroll history the company must
 * keep, and HR re-points an account at an existing record with `linkAccount` — so a roster that
 * hid departed rows would hide exactly the records an admin needs to find. Paging is a part-2
 * question; the surface is admin-only and the table is one company's headcount.
 */
export function listEmployees(sql: SqlStorage): EmployeeRow[] {
  return sql
    .exec<EmployeeRow>(
      `SELECT id, employee_number, display_name, department, employment_type,
              designated_approver_id, status, joined_on, departed_on
       FROM employees ORDER BY id`,
    )
    .toArray();
}

/** How an employee is named to a human. Never used for authorization — only for display. */
export type EmployeeLabel = {
  id: number;
  display_name: string;
  employee_number: string;
};

/**
 * The human-readable identity of one employee, for describing an action to an approver.
 *
 * `.one()` for the same reason as `employeeProfile`: every caller reaches this with an id that
 * came out of `resolveAccount` or out of a `submissions.employee_id` foreign key, so a missing row
 * is corruption rather than an ordinary client mistake.
 */
export function employeeLabel(sql: SqlStorage, employeeId: EmployeeId): EmployeeLabel {
  return sql
    .exec<EmployeeLabel>(
      `SELECT id, display_name, employee_number FROM employees WHERE id = ?`, employeeId,
    )
    .one();
}

/**
 * The routing attributes of one employee. `.one()` is deliberate: every caller reaches this with an
 * id that came out of `resolveAccount`, and `account_links.employee_id` has a foreign key onto
 * `employees(id)`, so a missing row is corruption rather than an ordinary client mistake.
 */
export function employeeProfile(sql: SqlStorage, employeeId: EmployeeId): EmployeeProfile {
  return sql
    .exec<EmployeeProfile>(
      `SELECT id, department, employment_type FROM employees WHERE id = ?`, employeeId,
    )
    .one();
}
