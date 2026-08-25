import type { EmployeeId } from "../types.js";

export type NewEmployee = {
  employeeNumber: string;
  displayName: string;
  department?: string;
  employmentType?: string;
  designatedApproverId?: EmployeeId;
  joinedOn: string;
};

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
