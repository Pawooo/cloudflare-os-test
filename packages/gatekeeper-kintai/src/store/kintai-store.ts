import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { applySchema } from "./schema.js";
import {
  allAllocations, currentAllocations, reconcile, setAllocations,
  type AllocationEntry, type AllocationRow, type Reconciliation,
} from "./allocations.js";
import {
  createEmployee, employeeProfile, grantExemption, isExempt, linkAccount, resolveAccount,
  type EmployeeProfile, type NewEmployee,
} from "./employees.js";
import {
  assertApproverReachable, hasAuthorityOver, hasReachableApprover, managersAt, setDelegate,
  setReportingLine,
} from "./org.js";
import {
  allPunches, correctPunch, currentPunches, dayAnomalies, recordPunch, workedMinutes,
  type NewPunch, type PunchRow,
} from "./punches.js";
import { createSite, matchSite, type NewSite } from "./sites.js";
import {
  actOnSubmission, approvalEvents, getSubmission, listSubmissionsFor, pendingApprovalsFor,
  resubmit, submitOvertime, withdrawSubmission,
  type ActInput, type ApprovalEventRow, type NewSubmission, type SubmissionRow,
} from "./submissions.js";
import {
  createRoute, resolveRoute,
  type NewRoute, type RouteCriteria, type RouteSnapshot,
} from "../routes.js";
import { assertWritable, isLocked, lockPeriod, periodLock, type PeriodLock } from "./periods.js";
import { appendAudit, auditEntries, type AuditEntry, type AuditRow } from "./audit.js";
import type { EmployeeId, SubmissionState } from "../types.js";

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

  async employeeProfile(employeeId: EmployeeId): Promise<EmployeeProfile> {
    return employeeProfile(this.sql, employeeId);
  }

  async grantExemption(employeeId: EmployeeId, from: number, to?: number): Promise<void> {
    grantExemption(this.sql, employeeId, from, to);
  }

  async isExempt(employeeId: EmployeeId, at: number): Promise<boolean> {
    return isExempt(this.sql, employeeId, at);
  }

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

  async recordPunch(input: NewPunch): Promise<number> {
    return recordPunch(this.sql, input);
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
