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

  // An exemption is not an approver. It says the employee's overtime bears no premium, which is
  // why `submitOvertime` refuses them outright; it grants NOBODY authority to sign, so it can
  // never make a request approvable. A correction to an exempt officer's punches is still a
  // request that needs a human, and while this arm answered "reachable" that request was accepted
  // and then sat in nobody's queue -- see `fileAmendment`.
  it("does not accept a root employee whose only claim is a 管理監督者 exemption", async () => {
    const ceo = await store.createEmployee({
      employeeNumber: "V3", displayName: "CEO", joinedOn: "2026-04-01",
    });
    await store.grantExemption(ceo, APR);

    expect(await store.hasReachableApprover(ceo, JUL)).toBe(false);
    await expect(() => store.assertApproverReachable(ceo, JUL))
      .rejects.toThrow(/KINTAI_NO_APPROVER/);
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

  it("rejects a root employee with no designated approver", async () => {
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
    // This used to pin the exemption arm's window against `isExempt`'s own half-open interval.
    // The arm is gone, so what needs pinning is that no instant of an exemption window -- before
    // it, inside it, after it -- makes any difference to the verdict. An exemption that flickered
    // an employee in and out of "approvable" was the shape that let a correction be filed at one
    // moment and be unapprovable at every moment afterwards.
    it("counts an exemption at no instant, inside its window or outside it", async () => {
      const boundary = JUL; // exemption covers [APR, JUL)
      const root = await store.createEmployee({
        employeeNumber: "V12", displayName: "Root", joinedOn: "2026-04-01",
      });
      await store.grantExemption(root, APR, boundary);

      for (const at of [APR - 1, APR, boundary - 1, boundary, boundary + 1]) {
        expect(await store.hasReachableApprover(root, at), `at ${at}`).toBe(false);
      }
      await expect(() => store.assertApproverReachable(root, APR))
        .rejects.toThrow(/KINTAI_NO_APPROVER/);
    });

    // The exemption is not ignored because it is irrelevant to the employee -- it is irrelevant to
    // THIS question. A manager makes them approvable; the exemption neither adds to that nor
    // takes it away.
    it("neither helps nor hinders an exempt employee who has a manager", async () => {
      const officer = await store.createEmployee({
        employeeNumber: "V13", displayName: "Officer", joinedOn: "2026-04-01",
      });
      const chair = await store.createEmployee({
        employeeNumber: "V14", displayName: "Chair", joinedOn: "2026-04-01",
      });
      await store.setReportingLine(officer, chair, APR);
      await store.grantExemption(officer, APR);

      expect(await store.hasReachableApprover(officer, JUL)).toBe(true);
    });
  });
});
