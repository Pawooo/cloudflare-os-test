import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Rejection assertions are written as `expect(() => store.method(...))`, never as
// `expect(store.method(...))`: handing an already-created RPC promise to `.rejects` races the
// Durable Object's own error reporting and can emit a spurious unhandled rejection that flips the
// process exit code even when the assertion itself passes (see Task 6).

const APR = Date.parse("2026-04-01T00:00:00Z");
const JUL = Date.parse("2026-07-03T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;
let boss: number;
let director: number;

async function employee(number: string) {
  return store.createEmployee({
    employeeNumber: number, displayName: number, joinedOn: "2026-04-01",
  });
}

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

async function twoStepRoute() {
  await store.createRoute({
    name: "two-step", department: "CONSTRUCTION",
    steps: [
      { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
      { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
    ],
  });
}

async function allOfManagerRoute() {
  await store.createRoute({
    name: "all-managers", department: "CONSTRUCTION",
    steps: [{ rule: "all_of", approverKind: "manager", approverEmployeeId: null }],
  });
}

async function submit(minutes = 120, employeeId = worker) {
  return store.submitOvertime({
    employeeId, requestedFor: "2026-07-03", minutes,
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

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 2000,
    })).rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
  });

  it("lets the employee withdraw their own submission", async () => {
    await singleStepRoute();
    const id = await submit();
    await store.withdrawSubmission(id, worker);
    expect((await store.getSubmission(id)).state).toBe("withdrawn");
  });

  it("refuses a withdrawal by anyone but the employee", async () => {
    await singleStepRoute();
    const id = await submit();
    await expect(() => store.withdrawSubmission(id, boss))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    expect((await store.getSubmission(id)).state).toBe("pending");
  });

  it("refuses to resubmit a submission that is not in draft", async () => {
    await singleStepRoute();
    const id = await submit();
    await expect(() => store.resubmit(id, worker, JUL + 1000))
      .rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
  });

  it("tells a non-owner nothing about a submission's state", async () => {
    // Ownership is checked before state in both `resubmit` and `withdrawSubmission`, so the error
    // a stranger gets never varies with the state they are probing for.
    await singleStepRoute();
    const id = await submit();
    await expect(() => store.resubmit(id, boss, JUL + 1000))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    await expect(() => store.withdrawSubmission(id, boss))
      .rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });
});

describe("authority", () => {
  it("forbids self-approval even when the actor is otherwise a manager", async () => {
    await singleStepRoute();
    const id = await submit();

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: worker, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_SELF_APPROVAL/);
  });

  it("forbids self-approval ahead of every other check", async () => {
    // Self-approval is structural, not a state-machine rule: it is reported first even when the
    // submission is in a state where nobody could act at all.
    await singleStepRoute();
    const id = await submit();
    await store.withdrawSubmission(id, worker);

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: worker, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_SELF_APPROVAL/);
  });

  it("refuses an actor with no org edge over the employee", async () => {
    await singleStepRoute();
    const id = await submit();

    await expect(() => store.actOnSubmission({
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
    // It is the edge that granted authority at that instant, not merely some edge.
    expect(events[0].authorizing_edge)
      .toBe(await store.hasAuthorityOver(boss, worker, JUL + 1000));
  });

  it("records no edge for a step pinned to a named employee", async () => {
    await twoStepRoute();
    const id = await submit();
    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });
    await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 2000,
    });

    const events = await store.approvalEvents(id);
    expect(events[1].step_index).toBe(1);
    expect(events[1].authorizing_edge).toBeNull();
  });

  it("lets a live delegate satisfy an any_of manager step", async () => {
    const cover = await employee("C1");
    await store.setDelegate(worker, cover, JUL, JUL + 100_000);
    await singleStepRoute();
    const id = await submit();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: cover, action: "approve", now: JUL + 1000,
    })).toBe("approved");
    const events = await store.approvalEvents(id);
    expect(events[0].authorizing_edge)
      .toBe(await store.hasAuthorityOver(cover, worker, JUL + 1000));
  });

  it("refuses a delegate whose window has closed", async () => {
    const cover = await employee("C2");
    await store.setDelegate(worker, cover, JUL, JUL + 500);
    await singleStepRoute();
    const id = await submit();

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: cover, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });
});

describe("multi-step routes", () => {
  it("advances step by step and only then approves", async () => {
    await twoStepRoute();
    const id = await submit();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    expect((await store.getSubmission(id)).current_step).toBe(1);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });

  it("keeps following its own snapshot when the route configuration changes mid-flight", async () => {
    await singleStepRoute();
    const id = await submit();

    // An administrator adds a stricter, more specific route after the fact. In-flight submissions
    // must not mutate under their approvers.
    await store.createRoute({
      name: "stricter", department: "CONSTRUCTION", minMinutes: 1,
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
      ],
    });

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });
});

describe("all_of steps", () => {
  it("requires every reporting manager to approve", async () => {
    const second = await employee("B2");
    await store.setReportingLine(worker, second, APR);
    await allOfManagerRoute();
    const id = await submit();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    // The same manager approving twice does not stand in for the other one.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1500,
    })).toBe("pending");
    expect(await store.actOnSubmission({
      submissionId: id, actorId: second, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });

  it("does not require a delegate — a stand-in satisfies a step, never adds one", async () => {
    const cover = await employee("C3");
    await store.setDelegate(worker, cover, JUL, JUL + 100_000);
    await allOfManagerRoute();
    const id = await submit();

    // The reporting manager alone completes it; the live delegate is not a required approver.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });

  it("is not satisfied when nobody is required — an empty requirement fails closed", async () => {
    // Reporting edges all closed, but a live delegate. The delegate may act (a delegate edge is a
    // real edge) yet is correctly not counted into the requirement, so the required set is empty.
    // `[].every()` is `true`, which would let a step demanding every manager's signature complete
    // on none of them. "Nobody is required" must fail closed.
    const orphan = await employee("O1");
    const cover = await employee("C4");
    await store.setReportingLine(orphan, boss, APR, JUL - 1);
    await store.setDelegate(orphan, cover, JUL, JUL + 100_000);
    await allOfManagerRoute();
    const id = await submit(120, orphan);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: cover, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    expect((await store.getSubmission(id)).state).toBe("pending");
  });

  it("drops the requirement for a manager whose edge has expired", async () => {
    const leaver = await employee("L1");
    const stayer = await employee("S1");
    const temp = await employee("T1");
    await store.setReportingLine(temp, leaver, APR, JUL + 1500);
    await store.setReportingLine(temp, stayer, APR);
    await allOfManagerRoute();
    const id = await submit(120, temp);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: leaver, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    // The leaver's edge has lapsed by now, so they are no longer in the required set and their
    // recorded approval still stands — the submission completes rather than deadlocking.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: stayer, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });
});

describe("designated approver", () => {
  async function rootEmployee() {
    const chief = await store.createEmployee({
      employeeNumber: "R1", displayName: "Chief", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    return chief;
  }

  it("lets the designated approver act for an employee with no manager edge", async () => {
    const chief = await rootEmployee();
    await singleStepRoute();
    const id = await submit(120, chief);

    expect(await store.hasAuthorityOver(director, chief, JUL + 1000)).toBeNull();
    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).toBe("approved");

    // Authority came from the employee record, not the org graph, so there is no edge to cite.
    const events = await store.approvalEvents(id);
    expect(events[0].authorizing_edge).toBeNull();
  });

  it("still refuses everyone who is neither a manager nor the designated approver", async () => {
    const chief = await rootEmployee();
    await singleStepRoute();
    const id = await submit(120, chief);

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });

  it("completes an all_of step for an employee with no reporting line", async () => {
    // With no reporting managers the requirement falls back to the designated approver, so a root
    // employee is not stranded. Read together with "an empty requirement fails closed": the set is
    // non-empty here precisely because a designated approver exists.
    const chief = await rootEmployee();
    await allOfManagerRoute();
    const id = await submit(120, chief);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });

  it("still requires the designated approver when only a delegate is available", async () => {
    // A delegate satisfies a step, never adds one — and never substitutes for the requirement
    // either. The fallback puts the designated approver in the required set, so the delegate's
    // approval alone does not complete the step.
    const chief = await rootEmployee();
    const cover = await employee("C5");
    await store.setDelegate(chief, cover, JUL, JUL + 100_000);
    await allOfManagerRoute();
    const id = await submit(120, chief);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: cover, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });

  it("ignores a reporting line that is not there, not one that is", async () => {
    // The fallback applies only when the reporting line is empty. A worker who has both a manager
    // and a designated approver must still collect the manager's signature.
    const both = await store.createEmployee({
      employeeNumber: "R2", displayName: "Both", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    await store.setReportingLine(both, boss, APR);
    await allOfManagerRoute();
    const id = await submit(120, both);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).toBe("pending");
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });
});

describe("provenance", () => {
  it("records nothing rather than guessing when the filer is not stated", async () => {
    await singleStepRoute();
    const id = await submit();
    expect((await store.getSubmission(id)).created_by).toBeNull();
  });

  it("records who filed a submission on someone else's behalf", async () => {
    await singleStepRoute();
    const id = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: director,
    });
    const row = await store.getSubmission(id);
    expect(row.employee_id).toBe(worker);
    expect(row.created_by).toBe(director);
  });
});

describe("unknown submissions", () => {
  it("reports a missing submission as not found, not as a storage failure", async () => {
    await expect(() => store.getSubmission(4242)).rejects.toThrow(/KINTAI_NOT_FOUND/);
    await expect(() => store.actOnSubmission({
      submissionId: 4242, actorId: boss, action: "approve", now: JUL,
    })).rejects.toThrow(/KINTAI_NOT_FOUND/);
    await expect(() => store.resubmit(4242, worker, JUL)).rejects.toThrow(/KINTAI_NOT_FOUND/);
    await expect(() => store.withdrawSubmission(4242, worker)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  it("refuses to report an empty history for a submission that does not exist", async () => {
    await expect(() => store.approvalEvents(4242)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });
});

describe("return invalidates prior approvals", () => {
  it("requires step 1 to approve again after a return and resubmit", async () => {
    await twoStepRoute();
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
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 4000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
  });

  it("counts the same approver's fresh approval after a resubmit", async () => {
    await twoStepRoute();
    const id = await submit();

    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });
    await store.actOnSubmission({
      submissionId: id, actorId: director, action: "return", now: JUL + 2000,
    });
    await store.resubmit(id, worker, JUL + 3000);

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 4000,
    })).toBe("pending");
    expect((await store.getSubmission(id)).current_step).toBe(1);
    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 5000,
    })).toBe("approved");
  });

  it("discounts a pre-return approval even when the return carries an earlier timestamp", async () => {
    // Times are supplied by the caller, so they are not monotonic. The boundary that decides which
    // approvals survive a return must be the append-only log's own order, not the clock.
    const second = await employee("B3");
    await store.setReportingLine(worker, second, APR);
    await allOfManagerRoute();
    const id = await submit();

    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 5000,
    });
    expect(await store.actOnSubmission({
      submissionId: id, actorId: second, action: "return", now: JUL + 4000,
    })).toBe("draft");
    await store.resubmit(id, worker, JUL + 6000);

    // Only `second` has approved since the return; the boss's stale approval must not count.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: second, action: "approve", now: JUL + 7000,
    })).toBe("pending");
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 8000,
    })).toBe("approved");
  });

  it("keeps the original filing time across a return and resubmit", async () => {
    // "How long has this sat unapproved?" must survive a round trip through draft.
    await twoStepRoute();
    const id = await submit();
    expect((await store.getSubmission(id)).submitted_at).toBe(JUL);

    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "return", now: JUL + 2000,
    });
    await store.resubmit(id, worker, JUL + 3000);

    expect((await store.getSubmission(id)).submitted_at).toBe(JUL);
  });

  it("keeps every event in the append-only log across a return", async () => {
    await twoStepRoute();
    const id = await submit();

    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    });
    await store.actOnSubmission({
      submissionId: id, actorId: director, action: "return", now: JUL + 2000,
      comment: "revise",
    });
    await store.resubmit(id, worker, JUL + 3000);
    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 4000,
    });

    const events = await store.approvalEvents(id);
    expect(events.map((event) => event.action)).toEqual(["approve", "return", "approve"]);
    expect(events[1].comment).toBe("revise");
  });
});

describe("unusable routes", () => {
  it("reports an unmatched route by its code", async () => {
    await singleStepRoute();
    await expect(() => store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "wrong department", now: JUL,
      department: "SALES", employmentType: null,
    })).rejects.toThrow(/KINTAI_NO_ROUTE/);
  });

  it("refuses to create a submission against a route with no steps", async () => {
    await store.createRoute({ name: "empty", department: "CONSTRUCTION", steps: [] });
    await expect(() => submit()).rejects.toThrow(/KINTAI_NO_ROUTE|no approval steps/i);
  });

  it("refuses to create a submission against an employee step with no approver", async () => {
    await store.createRoute({
      name: "unpinned", department: "CONSTRUCTION",
      steps: [{ rule: "any_of", approverKind: "employee", approverEmployeeId: null }],
    });
    await expect(() => submit()).rejects.toThrow(/KINTAI_NO_ROUTE|no approver/i);
  });
});
