import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { applySchema } from "./schema.js";
import {
  allAllocations, currentAllocations, reconcile, setAllocations,
  type AllocationEntry, type AllocationRow, type Reconciliation,
} from "./allocations.js";
import {
  createEmployee, employeeExists, employeeProfile, grantExemption, isExempt, linkAccount,
  listEmployees, openAccountLink, resolveAccount, setWorkDatePolicy, unlinkAccount,
  workDatePolicyOf,
  type AccountLinkRow, type EmployeeProfile, type EmployeeRow, type NewEmployee,
} from "./employees.js";
import { listRoster } from "./roster.js";
import {
  assertApproverReachable, hasAuthorityOver, hasReachableApprover, listReportingLines, managersAt,
  setDelegate, setReportingLine,
  type ReportingLineRow,
} from "./org.js";
import {
  allPunches, commitPunch, correctPunch, currentPunches, dayAnomalies, recordPunch, workDateFor,
  workedMinutes,
  type NewPunch, type PunchRow,
} from "./punches.js";
import { createSite, matchSite, type NewSite } from "./sites.js";
import {
  actOnSubmission, approvalEvents, getSubmission, listSubmissionsFor, pendingApprovalsFor,
  previewAct, resubmit, submitOvertime, withdrawSubmission,
  type ActCheck, type ActInput, type ActProbe, type ApprovalEventRow, type NewSubmission,
  type SubmissionRow,
} from "./submissions.js";
import {
  createRoute, resolveRoute,
  type NewRoute, type RouteCriteria, type RouteSnapshot,
} from "../routes.js";
import { assertWritable, isLocked, lockPeriod, periodLock, type PeriodLock } from "./periods.js";
import { appendAudit, auditEntries, type AuditEntry, type AuditRow } from "./audit.js";
import type {
  EmployeeId, PunchKind, RosterEntry, SubmissionState, WorkDatePolicy,
} from "../types.js";

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

  /** Column names of one table, sorted. Test-only introspection. */
  async tableColumns(table: string): Promise<string[]> {
    return this.sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?) ORDER BY name`, table)
      .toArray()
      .map((row) => row.name);
  }

  async createEmployee(input: NewEmployee): Promise<EmployeeId> {
    return createEmployee(this.sql, input);
  }

  /** The whole roster, departed employees included. See `listEmployees`. */
  async listEmployees(): Promise<EmployeeRow[]> {
    return listEmployees(this.sql);
  }

  /** The roster with the two computed onboarding columns, as of `at`. See `listRoster`. */
  async listRoster(at: number): Promise<RosterEntry[]> {
    return listRoster(this.sql, at);
  }

  /** Whether an employee record exists. Departed employees still exist. */
  async employeeExists(employeeId: EmployeeId): Promise<boolean> {
    return employeeExists(this.sql, employeeId);
  }

  async linkAccount(
    accountId: string, employeeId: EmployeeId, now: number,
    linkedBy?: EmployeeId, reason?: string,
  ): Promise<void> {
    linkAccount(this.sql, accountId, employeeId, now, linkedBy, reason);
  }

  /** Close an account's open link. Account revocation — never a delete. See `unlinkAccount`. */
  async unlinkAccount(accountId: string, now: number): Promise<boolean> {
    return unlinkAccount(this.sql, accountId, now);
  }

  async resolveAccount(accountId: string, at: number): Promise<EmployeeId | null> {
    return resolveAccount(this.sql, accountId, at);
  }

  /** The account's open link row, or null. Test-only introspection. */
  async openAccountLink(accountId: string): Promise<AccountLinkRow | null> {
    return openAccountLink(this.sql, accountId);
  }

  async employeeProfile(employeeId: EmployeeId): Promise<EmployeeProfile> {
    return employeeProfile(this.sql, employeeId);
  }

  /** Records a 管理監督者 period and returns its id. See `grantExemption`. */
  async grantExemption(employeeId: EmployeeId, from: number, to?: number): Promise<number> {
    return grantExemption(this.sql, employeeId, from, to);
  }

  async isExempt(employeeId: EmployeeId, at: number): Promise<boolean> {
    return isExempt(this.sql, employeeId, at);
  }

  /** Which day this employee's punches are filed against. See `workDatePolicyOf`. */
  async workDatePolicy(employeeId: EmployeeId): Promise<WorkDatePolicy> {
    return workDatePolicyOf(this.sql, employeeId);
  }

  /** Record the policy from now on. Not retroactive. See `setWorkDatePolicy`. */
  async setWorkDatePolicy(employeeId: EmployeeId, policy: WorkDatePolicy): Promise<void> {
    setWorkDatePolicy(this.sql, employeeId, policy);
  }

  /** Opens a reporting edge and returns its id. See `setReportingLine`. */
  async setReportingLine(
    employeeId: EmployeeId, managerId: EmployeeId, from: number, to?: number,
  ): Promise<number> {
    return setReportingLine(this.sql, employeeId, managerId, from, to);
  }

  async setDelegate(
    employeeId: EmployeeId, delegateId: EmployeeId, from: number, to: number,
  ): Promise<void> {
    setDelegate(this.sql, employeeId, delegateId, from, to);
  }

  /** Every reporting edge, closed windows included and delegates excluded. See `listReportingLines`. */
  async listReportingLines(): Promise<ReportingLineRow[]> {
    return listReportingLines(this.sql);
  }

  async managersAt(
    employeeId: EmployeeId, at: number, kind?: "report" | "delegate",
  ): Promise<EmployeeId[]> {
    return managersAt(this.sql, employeeId, at, kind);
  }

  async hasAuthorityOver(
    actorId: EmployeeId, employeeId: EmployeeId, at: number,
  ): Promise<number | null> {
    return hasAuthorityOver(this.sql, actorId, employeeId, at);
  }

  async hasReachableApprover(employeeId: EmployeeId, at: number): Promise<boolean> {
    return hasReachableApprover(this.sql, employeeId, at);
  }

  async assertApproverReachable(employeeId: EmployeeId, at: number): Promise<void> {
    assertApproverReachable(this.sql, employeeId, at);
  }

  async createSite(input: NewSite): Promise<number> {
    return createSite(this.sql, input);
  }

  async matchSite(latitude: number, longitude: number, at: number): Promise<number | null> {
    return matchSite(this.sql, latitude, longitude, at);
  }

  /**
   * The work date a punch of `kind` made at `now` belongs to, for this employee. See `workDateFor`.
   *
   * Asked BEFORE the write rather than only inside it, because the caller needs the answer for
   * itself: `KintaiSession.punch` checks the period lock against the date the punch will land on,
   * and for a `shift_start` employee that is not today's. Answering it only inside the write would
   * leave the lock checked against the wrong month for exactly the employees this feature is for.
   *
   * This call and the write are two separate turns of this object's input gate, so the answer can
   * be stale by the time it is used. That is what `commitPunch` exists to catch — it is the write,
   * and it decides the date again for itself.
   */
  async workDateFor(employeeId: EmployeeId, now: number, kind: PunchKind): Promise<string> {
    return workDateFor(this.sql, employeeId, now, kind);
  }

  /**
   * Append a punch, taking `input.workDate` on trust. The unguarded write.
   *
   * Correct for a caller that already knows the date for a reason of its own — the tests that seed
   * a specific day, and the amendment path, which is writing history rather than punching a clock.
   * Anything filing a punch AT THE CURRENT INSTANT must use `commitPunch` instead, which decides
   * the date under this same gate rather than trusting one read a turn earlier.
   */
  async recordPunch(input: NewPunch): Promise<number> {
    return recordPunch(this.sql, input);
  }

  /**
   * Append a punch, recomputing its work date here and refusing if it has moved. See `commitPunch`.
   *
   * The atomic half of `KintaiSession.punch`: one turn of the input gate covers both deciding
   * which day the punch belongs to and writing it there, which two separate RPCs could not.
   */
  async commitPunch(input: NewPunch): Promise<number> {
    return commitPunch(this.sql, input);
  }

  async correctPunch(
    supersedesId: number, input: NewPunch, amendedBy: EmployeeId, reason: string,
    recordedAt: number,
  ): Promise<number> {
    return correctPunch(this.sql, supersedesId, input, amendedBy, reason, recordedAt);
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

  async dayAnomalies(employeeId: EmployeeId, workDate: string): Promise<string[]> {
    return dayAnomalies(this.sql, employeeId, workDate);
  }

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

  async createRoute(input: NewRoute): Promise<number> {
    return createRoute(this.sql, input);
  }

  async resolveRoute(criteria: RouteCriteria): Promise<RouteSnapshot> {
    return resolveRoute(this.sql, criteria);
  }

  async submitOvertime(input: NewSubmission): Promise<number> {
    return submitOvertime(this.sql, input);
  }

  async actOnSubmission(input: ActInput): Promise<SubmissionState> {
    return actOnSubmission(this.sql, input);
  }

  /**
   * Run the authority prologue of `actOnSubmission` WITHOUT writing anything, and report what an
   * approver needs to read before confirming the decision.
   *
   * This is not a second implementation of "who may approve": it and `actOnSubmission` call the
   * same `checkMayAct`, so they cannot drift. It exists because `KintaiSession.actOnSubmission`
   * now queues the decision for human confirmation rather than performing it, and asking a manager
   * to confirm something that will be refused on apply is worse than refusing it immediately.
   *
   * It also returns the staleness marker (`ActProbe.afterEventId`), read in this same call so the
   * authority verdict and the marker describe one consistent version of the submission.
   */
  async previewActOnSubmission(input: ActCheck): Promise<ActProbe> {
    return previewAct(this.sql, input);
  }

  async resubmit(submissionId: number, actorId: EmployeeId, now: number): Promise<void> {
    resubmit(this.sql, submissionId, actorId, now);
  }

  async withdrawSubmission(submissionId: number, actorId: EmployeeId): Promise<void> {
    withdrawSubmission(this.sql, submissionId, actorId);
  }

  async listSubmissionsFor(employeeId: EmployeeId): Promise<SubmissionRow[]> {
    return listSubmissionsFor(this.sql, employeeId);
  }

  async pendingApprovalsFor(approverId: EmployeeId, now: number): Promise<SubmissionRow[]> {
    return pendingApprovalsFor(this.sql, approverId, now);
  }

  async getSubmission(id: number): Promise<SubmissionRow> {
    return getSubmission(this.sql, id);
  }

  async approvalEvents(submissionId: number): Promise<ApprovalEventRow[]> {
    return approvalEvents(this.sql, submissionId);
  }

  async isLocked(workDate: string): Promise<boolean> {
    return isLocked(this.sql, workDate);
  }

  async lockPeriod(period: string, lockedBy: EmployeeId, now: number): Promise<void> {
    lockPeriod(this.sql, period, lockedBy, now);
  }

  async assertWritable(workDate: string): Promise<void> {
    assertWritable(this.sql, workDate);
  }

  /** The lock record for `period`, or null if it isn't locked. Test-only introspection. */
  async periodLock(period: string): Promise<PeriodLock | null> {
    return periodLock(this.sql, period);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    appendAudit(this.sql, entry);
  }

  async auditEntries(): Promise<AuditRow[]> {
    return auditEntries(this.sql);
  }
}
