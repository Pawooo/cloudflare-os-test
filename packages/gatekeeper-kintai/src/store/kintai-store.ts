import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { applySchema } from "./schema.js";
import {
  createEmployee, grantExemption, isExempt, linkAccount, resolveAccount,
  type NewEmployee,
} from "./employees.js";
import { hasAuthorityOver, managersAt, setDelegate, setReportingLine } from "./org.js";
import type { EmployeeId } from "../types.js";

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

  async managersAt(employeeId: EmployeeId, at: number): Promise<EmployeeId[]> {
    return managersAt(this.sql, employeeId, at);
  }

  async hasAuthorityOver(
    actorId: EmployeeId, employeeId: EmployeeId, at: number,
  ): Promise<number | null> {
    return hasAuthorityOver(this.sql, actorId, employeeId, at);
  }
}
