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
    await expect(() => store.assertApproverReachable(orphan, JUL))
      .rejects.toThrow(/KINTAI_NO_APPROVER/);
  });

  // The remaining cases exercise where the brief's naive definition and Task 9's
  // `requiredApprovers`/`authorize` rule would disagree if implemented literally. They pin down the
  // behaviour this task's implementation actually chose (see task-10-report.md for the reasoning).

  it("does not count a live delegate alone as a reachable approver", async () => {
    // Mirrors the case called out in submissions.ts requiredApprovers: reporting edges all closed,
    // only a live delegate remains, no designated approver. A delegate CAN act on an individual
    // approval event (hasAuthorityOver matches any edge kind), but requiredApprovers only counts
    // 'report' edges, so an all_of step's requirement stays empty and can never be satisfied. That
    // means this org shape strands a submission exactly as badly as having nobody at all, so
    // hasReachableApprover must say false here, not true.
    const worker = await store.createEmployee({
      employeeNumber: "V7", displayName: "W7", joinedOn: "2026-04-01",
    });
    const oldBoss = await store.createEmployee({
      employeeNumber: "V8", displayName: "OldBoss", joinedOn: "2026-04-01",
    });
    const cover = await store.createEmployee({
      employeeNumber: "V9", displayName: "Cover", joinedOn: "2026-04-01",
    });
    // Reporting line closes before JUL; only the delegate window covers JUL.
    await store.setReportingLine(worker, oldBoss, APR, JUL);
    await store.setDelegate(worker, cover, JUL, JUL + 1000 * 60 * 60 * 24 * 30);

    expect(await store.hasReachableApprover(worker, JUL)).toBe(false);
  });

  it("does not count a self-reporting edge as a reachable approver", async () => {
    // A data error (an employee recorded as their own manager) must not read as "approvable":
    // self-approval is forbidden structurally, so that edge can never actually be used to sign.
    const worker = await store.createEmployee({
      employeeNumber: "V10", displayName: "W10", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(worker, worker, APR);

    expect(await store.hasReachableApprover(worker, JUL)).toBe(false);
  });

  // NOTE: a self-referential designated_approver_id (mirroring requiredApprovers' collapse-to-
  // empty-set rule) is not exercised here: designated_approver_id can only be set at
  // createEmployee time, before the new employee's own id exists, so the public API cannot
  // construct that state. The implementation still guards against it defensively, matching
  // requiredApprovers, in case a future write path ever allows re-pointing it.

  describe("partial exemption windows", () => {
    it("tracks exemption reachability instant-by-instant across the boundary", async () => {
      // A root employee (no manager, no designated approver) exempt for part of the timeline but
      // not all of it. hasReachableApprover must track isExempt's own half-open window exactly:
      // reachable while exempt, unreachable the instant the exemption lapses.
      const boundary = JUL; // exemption covers [APR, JUL)
      const root = await store.createEmployee({
        employeeNumber: "V12", displayName: "Root", joinedOn: "2026-04-01",
      });
      await store.grantExemption(root, APR, boundary);

      expect(await store.hasReachableApprover(root, boundary - 1)).toBe(true);
      expect(await store.hasReachableApprover(root, boundary)).toBe(false);
      await expect(() => store.assertApproverReachable(root, boundary))
        .rejects.toThrow(/KINTAI_NO_APPROVER/);
    });
  });
});
