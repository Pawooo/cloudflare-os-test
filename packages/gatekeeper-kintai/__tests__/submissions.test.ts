import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Rejection assertions are written as `expect(() => store.method(...))`, never as
// `expect(store.method(...))`: handing `.rejects` an already-created RPC promise leaves that
// promise unhandled for a turn, and Vitest reports it as an `Unhandled Rejection` block that can
// fail the run even though the assertion itself passes.
//
// It does NOT suppress the `uncaught exception; source = Uncaught (in promise)` lines this suite
// prints. Those come from workerd, which logs every exception that crosses an RPC boundary
// regardless of how the test asserts on it — `gatekeeper-scheduler` prints them too. Kintai prints
// more of them only because it throws more coded errors than any other package here. They are
// expected output, not a defect to hunt.

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

  it("tells someone with no authority nothing about a submission's state", async () => {
    // Same invariant, in `actOnSubmission`: authority is established before the state machine
    // speaks. Without this ordering `InvalidTransitionError` names the state it refused, turning
    // the method into an oracle over every submission in the company.
    await singleStepRoute();
    const stranger = await employee("S1");
    const id = await submit();
    await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "reject", now: JUL + 1000,
    });

    // The submission is `rejected`, but a stranger is told only that they may not act.
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: stranger, action: "approve", now: JUL + 2000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);

    // The authorised approver still gets the informative error.
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 3000,
    })).rejects.toThrow(/KINTAI_INVALID_TRANSITION/);
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
    // The reporting edge is active at submission time (so Task 10's write-time guard in
    // submitOvertime lets this through — orphan does have a reachable approver when they file) but
    // expires moments later, before anyone acts on it, leaving only a live delegate by review time.
    // The delegate may act (a delegate edge is a real edge) yet is correctly not counted into the
    // requirement, so the required set is empty at approval time. `[].every()` is `true`, which
    // would let a step demanding every manager's signature complete on none of them. "Nobody is
    // required" must fail closed.
    const orphan = await employee("O1");
    const cover = await employee("C4");
    await store.setReportingLine(orphan, boss, APR, JUL + 1);
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

  it("does not let the designated approver satisfy an any_of step for a managed employee", async () => {
    // `designated_approver_id` is the root-of-organisation escape hatch and nothing more (spec).
    // An employee who has BOTH a live manager and a designated approver must still collect a
    // manager's signature — the designated approver has no authority over them at all.
    //
    // `any_of` is the shape that exposes this: under `all_of` the requirement is computed by
    // `requiredApprovers`, which has always gated the fallback correctly, so an ungated
    // `authorize` would let the designated approver record an approval that then failed to satisfy
    // the requirement — visible only as a stray approval event. Under `any_of` one approval
    // completes the step, so an ungated fallback approves the submission outright.
    const both = await store.createEmployee({
      employeeNumber: "R3", displayName: "Both", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    await store.setReportingLine(both, boss, APR);
    await singleStepRoute();
    const id = await submit(120, both);

    // director is not `both`'s manager; director being boss's manager grants nothing here.
    expect(await store.hasAuthorityOver(director, both, JUL + 1000)).toBeNull();
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    expect((await store.getSubmission(id)).state).toBe("pending");
    expect((await store.approvalEvents(id))).toEqual([]);

    // ...and it is not in their queue either: the queue filters through `authorize` itself, so the
    // two answers cannot disagree.
    expect((await store.pendingApprovalsFor(director, JUL + 1000)).map((row) => row.id))
      .not.toContain(id);

    // The actual manager still approves it, so nothing has been broken in the process.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });

  it("still lets the designated approver act, and queue, for a root employee", async () => {
    // The other half of the gate: with no reporting line the fallback is exactly what keeps a root
    // employee's submission from stranding, so gating it must not have switched it off.
    const chief = await rootEmployee();
    await singleStepRoute();
    const id = await submit(120, chief);

    expect((await store.pendingApprovalsFor(director, JUL + 1000)).map((row) => row.id))
      .toContain(id);
  });

  it("ignores a reporting line that is not there, not one that is", async () => {
    // The fallback applies only when the reporting line is empty. A worker who has both a manager
    // and a designated approver must still collect the manager's signature.
    //
    // The designated approver is now refused outright rather than allowed to record an approval
    // that fails to satisfy the requirement: `authorize` gates the fallback on the reporting line
    // being empty, exactly as `requiredApprovers` always did. This is a strictly stronger form of
    // the same invariant — under `all_of` the old behaviour still ended at "boss must sign", but
    // it left a stray approval event on the record from somebody with no authority, and under
    // `any_of` (see the test above) that same stray approval completed the submission.
    const both = await store.createEmployee({
      employeeNumber: "R2", displayName: "Both", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    await store.setReportingLine(both, boss, APR);
    await allOfManagerRoute();
    const id = await submit(120, both);

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_NOT_AUTHORIZED/);
    expect((await store.getSubmission(id)).state).toBe("pending");

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 2000,
    })).toBe("approved");
  });
});

describe("routes nobody could satisfy are refused at submit", () => {
  it("refuses a step pinned to the submitter themself", async () => {
    // Created pending, this submission would be unapprovable by construction: `authorize` refuses
    // everyone but the pinned approver, and the pinned approver is refused as a self-approver. It
    // would sit in `pending` in NOBODY's queue. Plausible configuration, too — a 本社 escalation
    // step pinned to a named 部長 strands that 部長's own overtime.
    await store.createRoute({
      name: "self-pinned", department: "CONSTRUCTION",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: worker },
      ],
    });

    await expect(() => submit()).rejects.toThrow(/KINTAI_NO_ROUTE/);
    // Fails before anything is written, which is the point of checking at submit time.
    expect(await store.listSubmissionsFor(worker)).toEqual([]);
  });

  it("refuses it for the submitter only, not for everyone the route covers", async () => {
    // The same route is perfectly satisfiable for anyone who is not the pinned approver, so the
    // rejection above must be about who is filing, not about the route's shape.
    await store.createRoute({
      name: "self-pinned", department: "CONSTRUCTION",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: worker },
      ],
    });

    const id = await submit(120, boss);
    expect((await store.getSubmission(id)).state).toBe("pending");
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

describe("a filer's own queue", () => {
  it("omits a submission the approver filed, since they can never act on it", async () => {
    await singleStepRoute();
    const id = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: boss,
    });

    // Boss is the worker's manager and so the step-0 approver, but filed this one, so
    // `checkMayAct` refuses them. A queue listing it would promise an action nobody can take.
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);

    expect((await store.pendingApprovalsFor(boss, JUL + 1000)).map((r) => r.id))
      .not.toContain(id);
  });

  it("still lists it for another approver at the same step", async () => {
    // A second manager, so step 0 has someone other than the filer who can act. Excluding the
    // filer must not amount to hiding the row from everyone.
    await store.setReportingLine(worker, director, APR);
    await singleStepRoute();
    const id = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: boss,
    });

    expect((await store.pendingApprovalsFor(director, JUL + 1000)).map((r) => r.id))
      .toContain(id);
    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });

  it("keeps listing rows that predate the filer column", async () => {
    await singleStepRoute();
    const id = await submit();
    // `created_by` is null here. `NULL != ?` is NULL rather than true, so a predicate without the
    // IS NULL arm would silently drop every row filed before the column existed.
    expect((await store.pendingApprovalsFor(boss, JUL + 1000)).map((r) => r.id))
      .toContain(id);
  });
});

describe("nobody approves what they filed", () => {
  // `createdBy` already lets one person file for another, so "the actor is not the employee" is
  // no longer the whole of "the actor did not originate this". These pin the other half: the hand
  // that filed a request is never the hand that settles it.

  /** An overtime submission that is Worker's, but that Boss -- Worker's approver -- filed. */
  async function filedByBoss() {
    return store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: boss,
    });
  }

  it("refuses the filer even though they are an authorised approver", async () => {
    await singleStepRoute();
    const id = await filedByBoss();

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
  });

  it("refuses the filer's reject and return, not only their approval", async () => {
    // `checkMayAct` gates every decision, and the conflict is the same under each verb: one
    // person both originating a change to payroll input and disposing of it.
    await singleStepRoute();
    const id = await filedByBoss();

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "reject", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: boss, action: "return", now: JUL + 2000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
  });

  it("reports the refusal from the preview exactly as from the write", async () => {
    // `previewAct` and `actOnSubmission` are one authority check called twice, so a refusal the
    // preview did not report would surface only after a human had been asked to confirm.
    await singleStepRoute();
    const id = await filedByBoss();

    await expect(() => store.previewActOnSubmission({
      submissionId: id, actorId: boss, now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
  });

  it("still lets a different authorised approver decide it", async () => {
    // A request its filer may not approve must not thereby become unapprovable.
    await singleStepRoute();
    await store.setReportingLine(worker, director, APR);
    const id = await filedByBoss();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: director, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });

  it("reports self-approval, not this, when the employee filed their own", async () => {
    // What the facet does for every overtime submission: `submitOvertime` in `src/kintai.ts`
    // passes `createdBy: employeeId`, so both rules match and the more specific one must answer.
    // Otherwise an employee refused their own overtime is told a third party filed it.
    await singleStepRoute();
    const id = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "site overrun", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: worker,
    });

    await expect(() => store.actOnSubmission({
      submissionId: id, actorId: worker, action: "approve", now: JUL + 1000,
    })).rejects.toThrow(/KINTAI_SELF_APPROVAL/);
  });

  it("leaves a submission with no recorded filer alone", async () => {
    // `created_by` is nullable -- rows written before it existed, and every `submitOvertime` that
    // omits it. A null filer is nobody, and must never read as the actor.
    await singleStepRoute();
    const id = await submit();
    expect((await store.getSubmission(id)).created_by).toBeNull();

    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("approved");
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

// The spec says 管理監督者 "shouldn't be raising overtime requests at all", but exemption alone
// satisfies hasReachableApprover (Task 10), so nothing else stops a submission of theirs from
// being accepted and then stranding — no manager is required to sign it, and nobody is able to.
// This is a store-level guard in the same spirit as the self-approval check: defense in depth, not
// merely a UI concern.
describe("exempt employees", () => {
  it("refuses an overtime request from an employee exempt for the requested period", async () => {
    await singleStepRoute();
    await store.grantExemption(worker, APR);

    await expect(() => submit()).rejects.toThrow(/KINTAI_EXEMPT_EMPLOYEE/);
  });

  it("allows the request once the exemption period has passed", async () => {
    await singleStepRoute();
    // Exempt only through end of June; the request is for 2026-07-03, after the window closes.
    await store.grantExemption(worker, APR, JUL - 1000 * 60 * 60 * 24 * 3);

    await expect(submit()).resolves.toEqual(expect.any(Number));
  });
});

// Closes the hole Task 10's org-write-time validation left open: `hasReachableApprover` and
// `assertApproverReachable` were produced but never called from anywhere, so nothing actually
// stopped a submission from an employee who never had an approver at all from being created and
// stranding in `pending` for good.
describe("no reachable approver", () => {
  it("refuses a submission from an employee with no manager, no exemption, and no designated " +
    "approver, and creates no row", async () => {
    const orphan = await employee("O5");

    await expect(() => submit(120, orphan)).rejects.toThrow(/KINTAI_NO_APPROVER/);

    // Confirm no submission was left behind: this is the first submission this store would ever
    // create, so if the guard let it through it would be id 1.
    await expect(() => store.getSubmission(1)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });
});
