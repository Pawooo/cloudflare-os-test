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
