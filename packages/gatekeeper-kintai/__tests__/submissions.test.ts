import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_APPROVALS_QUERY, SUBMISSIONS_FOR_EMPLOYEE_QUERY,
} from "../src/store/submissions.js";

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
const DAY_MS = 24 * 60 * 60 * 1000;

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

    // ...and it is not in their queue either: the queue filters through `checkMayAct` itself, so
    // the two answers cannot disagree.
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

describe("who can approve is a question about now", () => {
  it("accepts a submission from an employee whose manager was set today", async () => {
    // Reproduces a live failure. The reporting line is created DURING the work day -- which is
    // what happens whenever someone is onboarded, or moves team, on the day they work. The old
    // code asked "did they have a manager at the start of the work date?", so an edge created at
    // 16:33 could not approve that same day's overtime, and the answer never became yes: filing
    // later did not help, because the question was pinned to the past.
    //
    // The admin roster meanwhile evaluates the SAME function at `Date.now()` and reported
    // "reports to Admin - all ready". One question, two instants, two answers.
    const seq = Date.now();
    const late = await store.createEmployee({
      employeeNumber: `L${seq}`, displayName: "Late", department: "CONSTRUCTION",
      joinedOn: "2026-04-01",
    });
    const chief = await store.createEmployee({
      employeeNumber: `C${seq}`, displayName: "Chief", joinedOn: "2026-04-01",
    });
    await singleStepRoute();

    // JUL is 2026-07-03T00:00:00Z. The edge starts well after the work date began.
    const middleOfTheDay = JUL + 16 * 3600_000;
    await store.setReportingLine(late, chief, middleOfTheDay);

    const id = await store.submitOvertime({
      employeeId: late, requestedFor: "2026-07-03", minutes: 120,
      reason: "manager assigned today", now: middleOfTheDay + 3600_000,
      department: "CONSTRUCTION", employmentType: null,
    });

    expect((await store.getSubmission(id)).state).toBe("pending");
    // And the person who can actually approve it, can.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: chief, action: "approve", now: middleOfTheDay + 7200_000,
    })).toBe("approved");
  });

  it("still refuses an employee who has no approver at filing time", async () => {
    // The rule did not become "anything goes": reachability is still required, just asked about
    // the moment the answer is needed.
    const seq = Date.now() + 1;
    const orphan = await store.createEmployee({
      employeeNumber: `O${seq}`, displayName: "Orphan", department: "CONSTRUCTION",
      joinedOn: "2026-04-01",
    });
    await singleStepRoute();

    await expect(() => store.submitOvertime({
      employeeId: orphan, requestedFor: "2026-07-03", minutes: 120,
      reason: "nobody above me", now: JUL + 3600_000,
      department: "CONSTRUCTION", employmentType: null,
    })).rejects.toThrow(/KINTAI_NO_APPROVER/);
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
    // A second manager, so step 0 has someone other than the filer who can act. Refusing the
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
    // `created_by` is null here, and a null filer is not a match for anybody. The queue no longer
    // states that for itself — `FiledBySelfError`'s `created_by !== null` guard is the only place
    // it is decided — but the row it protects is the same one: every submission filed before the
    // column existed.
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
  it("routes a department nobody configured to the seeded default", async () => {
    // Was: `KINTAI_NO_ROUTE`. `applySchema` seeds a catch-all so a fresh store can approve
    // anything at all; a configured route still outranks it by specificity, which
    // `selectRoute`'s own tests pin.
    await singleStepRoute();
    const id = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "no SALES route configured", now: JUL,
      department: "SALES", employmentType: null,
    });

    expect((await store.getSubmission(id)).state).toBe("pending");
    // Still a human other than the employee: the default is any_of manager, and boss is one.
    expect(await store.actOnSubmission({
      submissionId: id, actorId: boss, action: "approve", now: JUL + 1000,
    })).toBe("approved");
  });

  it("still refuses an employee the default route cannot reach an approver for", async () => {
    // The signal the old KINTAI_NO_ROUTE carried has not been lost, it moved. An orphan with no
    // manager matches the catch-all but has nobody to satisfy it, and is refused before a
    // submission exists rather than stranding one nobody can decide.
    const orphan = await employee("O1");
    await expect(() => store.submitOvertime({
      employeeId: orphan, requestedFor: "2026-07-03", minutes: 120,
      reason: "nobody above me", now: JUL,
      department: null, employmentType: null,
    })).rejects.toThrow(/KINTAI_NO_APPROVER|KINTAI_NO_ROUTE/);
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

  // The fourth unsatisfiable shape, on the overtime path. It is not amendment-only: the store's
  // `submitOvertime` takes `createdBy`, and only the session facet's habit of setting it to the
  // employee kept this out of reach. Filed by the person the route pins, the request would reach
  // step 1 and stop there for good -- `authorize` refuses everyone but Director, and `checkMayAct`
  // refuses Director for having filed it.
  it("refuses to create a submission against a step pinned to whoever filed it", async () => {
    await twoStepRoute();

    await expect(() => store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: director,
    })).rejects.toThrow(/KINTAI_NO_ROUTE/);
    await expect(() => store.getSubmission(1)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  // The same route is fine when somebody else files, including the employee themself. The check is
  // about this filer and this route, not about the route being unusable.
  it("accepts that same route when the pinned approver did not file it", async () => {
    await twoStepRoute();

    await expect(store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: boss,
    })).resolves.toEqual(expect.any(Number));
  });
});

// The spec says 管理監督者 "shouldn't be raising overtime requests at all": they are exempt from
// the premiums overtime approval exists to control, so there is nothing for an approver to sign.
// A store-level guard in the same spirit as the self-approval check -- defense in depth, not
// merely a UI concern. It is no longer the only thing standing between an exempt employee and a
// stranded request: an exemption stopped counting as a reachable approver, so an exempt officer
// with nobody above them is refused by `assertApproverReachable` too, whichever day they file for.
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

  // The deliberate half of the split `938639c` made: reachability moved to `now`, exemption stayed
  // on the work date. Nothing asserted the half that stayed, so moving the exemption check to
  // `input.now` too passed every test in this suite.
  it("refuses a day the employee was exempt for, however long afterwards they file", async () => {
    await singleStepRoute();
    // Exempt across the work date; the exemption ends a week later, and they file a week after
    // that. Exemption is a property of the WORK, so filing late must not launder it.
    await store.grantExemption(worker, APR, JUL + 7 * DAY_MS);

    await expect(() => store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "site overrun", now: JUL + 14 * DAY_MS,
      department: "CONSTRUCTION", employmentType: null,
    })).rejects.toThrow(/KINTAI_EXEMPT_EMPLOYEE/);
  });

  // `requestedFor` is a JST calendar date, and `workDateStart` is what turns it into the instant
  // that date BEGINS. `Date.parse("2026-07-03")` is UTC midnight -- 09:00 JST, mid-morning of the
  // day it claims to start -- so both of these read the wrong nine hours, in opposite directions,
  // and neither was covered by anything.
  describe("a window that moves inside the 00:00-09:00 JST band", () => {
    it("refuses a day whose exemption lapsed during that morning", async () => {
      await singleStepRoute();
      // Exempt until 03:00 JST on the work date. The employee WAS 管理監督者 when that work date
      // began, so the day is exempt work and the request is refused. Anchored at 09:00 JST the
      // exemption reads as already over and the request would be accepted.
      await store.grantExemption(worker, APR, Date.parse("2026-07-03T03:00:00+09:00"));

      await expect(() => submit()).rejects.toThrow(/KINTAI_EXEMPT_EMPLOYEE/);
    });

    it("allows a day whose exemption only began during that morning", async () => {
      await singleStepRoute();
      // 管理監督者 from 03:00 JST on the work date. The date began before that, so it is not an
      // exempt work date and the request stands. Anchored at 09:00 JST the exemption reads as
      // covering the whole day and the request would be refused -- credit denied for a day the
      // determination did not cover.
      await store.grantExemption(worker, Date.parse("2026-07-03T03:00:00+09:00"));

      await expect(submit()).resolves.toEqual(expect.any(Number));
    });
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

  /**
   * The gap `938639c` opened, reproduced end to end.
   *
   * Exemption is asked about the work date; reachability is asked about `now`. While both used
   * the same instant, an employee whose only claim to an approver was their own exemption had
   * already been refused by `ExemptEmployeeError` before reachability was consulted, so
   * reachability's exemption arm was unreachable from here. Splitting the instants uncoupled them:
   * not exempt on the day worked, exempt by the time they file, and the exemption arm then answers
   * "reachable" for an employee no route can ever name.
   *
   * The result was a `pending` submission in nobody's queue -- `requiredApprovers` never counts an
   * exemption, and `authorize` has no edge and no designated approver to fall back on -- clearable
   * only by withdrawing it. Exactly what `assertApproverReachable` was wired in to prevent.
   */
  it("refuses a day worked before an exemption the employee has since been granted", async () => {
    await singleStepRoute();
    const officer = await employee("O6");
    // Not 管理監督者 on 2026-07-03, so nothing refuses the day itself...
    await store.grantExemption(officer, Date.parse("2026-08-01T00:00:00Z"));

    // ...and no manager, no designated approver, ever. Nobody can approve this, at any instant.
    await expect(() => store.submitOvertime({
      employeeId: officer, requestedFor: "2026-07-03", minutes: 120,
      reason: "site overrun", now: Date.parse("2026-08-10T00:00:00Z"),
      department: "CONSTRUCTION", employmentType: null,
    })).rejects.toThrow(/KINTAI_NO_APPROVER/);

    // And nothing was left behind to strand: the first submission this store would create is id 1.
    await expect(() => store.getSubmission(1)).rejects.toThrow(/KINTAI_NOT_FOUND/);
    expect(await store.pendingApprovalsFor(boss, Date.parse("2026-08-10T00:00:00Z"))).toEqual([]);
  });
});

/**
 * `pendingApprovalsFor` and `checkMayAct` are ONE rule, asserted as a property rather than by
 * example. Nothing here names a route shape or an org edge: it enumerates a set of submissions and
 * a set of actors, asks the authority prologue about every pair, and requires the queue to hold
 * exactly the pairs it accepted.
 *
 * This is the test whose absence let the two drift. The queue used to restate the origination rule
 * as SQL — `employee_id != ?` and a `created_by` test — which agreed with `checkMayAct` only by
 * construction, and in both directions silently: a refusal added ahead of `authorize` would leave
 * the SQL behind and put dead entries in the queue, and a `FiledBySelfError` ever narrowed would
 * leave the SQL hiding rows nobody else can act on. The second is invisible stranding, which is
 * the failure `pendingApprovalsFor`'s own doc comment says it exists to prevent.
 *
 * By construction it exercises every arm of the queue's refusal list, and asserts that it did:
 * a matrix that happened to miss one would be a matrix that stopped guarding it.
 */
describe("the queue lists exactly what the act check accepts", () => {
  /**
   * The domain refusals that mean "not this person, not now" — the same list the queue filters on.
   * Anything else is a real failure and must reach the test, never be read as "no": a queue that
   * was empty because every row threw would otherwise pass this file.
   */
  const REFUSALS = [
    "KINTAI_SELF_APPROVAL", "KINTAI_FILED_BY_APPROVER",
    "KINTAI_NOT_AUTHORIZED", "KINTAI_INVALID_TRANSITION",
  ];

  const NOW = JUL + 10_000;
  const seen = new Set<string>();

  /**
   * Does the authority prologue accept this actor for this submission? `previewActOnSubmission` is
   * `checkMayAct` with nothing after it, so this asks the exact question `actOnSubmission` asks,
   * without writing. Awaited inside the try, so no rejected promise is ever left for a turn.
   */
  async function mayAct(submissionId: number, actorId: number): Promise<boolean> {
    try {
      await store.previewActOnSubmission({ submissionId, actorId, now: NOW });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      const code = REFUSALS.find((candidate) => message.startsWith(`${candidate}:`));
      if (code === undefined) throw err;
      seen.add(code);
      return false;
    }
  }

  it("holds a row for an actor exactly when the act check would let them act", async () => {
    await twoStepRoute();

    // A root employee: no manager edge, so `authorize` can only reach them through the designated
    // approver fallback.
    const chief = await store.createEmployee({
      employeeNumber: "P-CHIEF", displayName: "Chief", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    // Both a live manager AND a designated approver: the shape where the fallback must NOT apply,
    // and the one that shipped a real bug once.
    const both = await store.createEmployee({
      employeeNumber: "P-BOTH", displayName: "Both", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    await store.setReportingLine(both, boss, APR);
    // Somebody with no authority over anyone, to keep the matrix from being all approvers.
    const outsider = await store.createEmployee({
      employeeNumber: "P-OUT", displayName: "Outsider", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(outsider, boss, APR);

    const filed = await store.submitOvertime({
      employeeId: worker, requestedFor: "2026-07-03", minutes: 120,
      reason: "entered from the paper sheet", now: JUL,
      department: "CONSTRUCTION", employmentType: null, createdBy: boss,
    });
    const atStepOne = await submit(90, worker);
    await store.actOnSubmission({
      submissionId: atStepOne, actorId: boss, action: "approve", now: JUL + 1000,
    });
    const withdrawn = await submit(45, worker);
    await store.withdrawSubmission(withdrawn, worker);
    const returned = await submit(15, worker);
    await store.actOnSubmission({
      submissionId: returned, actorId: boss, action: "return", now: JUL + 1000,
    });

    const submissions = [
      // A manager step, decidable by the one manager.
      { name: "plain", id: await submit(120, worker) },
      // Filed by the only person who could have decided it: decidable by nobody.
      { name: "filed by the approver", id: filed },
      // The approver's own overtime, decided a level up.
      { name: "about the boss", id: await submit(60, boss) },
      // A step pinned to a named employee rather than to a relationship.
      { name: "at a pinned step", id: atStepOne },
      // Reachable only through the root-of-organisation fallback.
      { name: "root employee", id: await submit(30, chief) },
      // Manager AND designated approver: the manager decides, the designated approver may not.
      { name: "manager and approver", id: await submit(75, both) },
      // Left `pending` by nothing: not actionable however authorised the actor is.
      { name: "withdrawn", id: withdrawn },
      { name: "returned to draft", id: returned },
    ];
    const actors = [
      { name: "worker", id: worker }, { name: "boss", id: boss },
      { name: "director", id: director }, { name: "chief", id: chief },
      { name: "outsider", id: outsider },
    ];

    for (const actor of actors) {
      const queued = new Set(
        (await store.pendingApprovalsFor(actor.id, NOW)).map((row) => row.id),
      );
      for (const submission of submissions) {
        const allowed = await mayAct(submission.id, actor.id);
        // Compared as strings so a failure names the pair rather than reporting `true !== false`.
        expect(`${submission.name} / ${actor.name}: queued=${queued.has(submission.id)}`)
          .toBe(`${submission.name} / ${actor.name}: queued=${allowed}`);
      }
      // The queue must not hold anything outside the matrix either — an id from another test's
      // fixture appearing here would mean the filter let something through unexamined.
      expect([...queued].filter((id) => !submissions.some((s) => s.id === id))).toEqual([]);
    }

    // And the matrix is not weaker than it looks: every refusal the queue filters on was reached
    // by a real pair above. One that stopped being exercised would be one that stopped being
    // guarded, silently, which is how this pair of rules drifted the first time.
    expect([...seen].sort()).toEqual([...REFUSALS].sort());
  });
});

/**
 * What the LISTS say about an amendment, as opposed to what the confirmation dialog says.
 *
 * `previewAct` has answered this since the amendment work landed, but only for the one submission
 * an approver has already singled out. The lists were left describing every row by its `minutes`,
 * which is 0 on an amendment and means nothing there — so a queue of corrections read as a stack
 * of zero-minute overtime requests, and neither a human nor an agent summarising the queue for one
 * could tell what any of them asked for.
 *
 * These assert the row detail. The dialog's own text is covered in `__tests__/facet.test.ts`.
 */
describe("amendment detail in the lists", () => {
  const DAY = "2026-07-03";
  /** An hour after the punch: when the request is filed, and when the queue is read. */
  const LATER = JUL + 3600_000;

  /** A clock-in at 09:00 JST on `DAY`, the punch every correction below is filed against. */
  async function clockIn() {
    return store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: JUL, source: "gadget",
    });
  }

  /** "That 09:00 punch should say 08:30." */
  async function fileCorrection(targetPunchId: number, occurredAt = JUL - 1800_000) {
    return store.fileAmendment({
      employeeId: worker, targetPunchId, occurredAt,
      reason: "started early on site", now: LATER,
      department: "CONSTRUCTION", employmentType: null, createdBy: worker,
    });
  }

  it("gives an approver the target punch, its current time and the requested one", async () => {
    await singleStepRoute();
    const punchId = await clockIn();
    const submissionId = await fileCorrection(punchId);

    const row = (await store.pendingApprovalsFor(boss, LATER))
      .find((candidate) => candidate.id === submissionId);

    expect(row?.amendment).toEqual({
      targetPunchId: punchId,
      currentOccurredAt: JUL,
      requestedOccurredAt: JUL - 1800_000,
      workDate: DAY,
      kind: "in",
      lockedPeriod: null,
    });
  });

  it("carries a null current time for a punch that was never recorded", async () => {
    await singleStepRoute();
    const submissionId = await store.fileAmendment({
      employeeId: worker, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: JUL + 9 * 3600_000, reason: "forgot to clock out",
      now: JUL + 20 * 3600_000,
      department: "CONSTRUCTION", employmentType: null, createdBy: worker,
    });

    const row = (await store.pendingApprovalsFor(boss, JUL + 20 * 3600_000))
      .find((candidate) => candidate.id === submissionId);

    expect(row?.amendment).toEqual({
      targetPunchId: null,
      currentOccurredAt: null,
      requestedOccurredAt: JUL + 9 * 3600_000,
      workDate: DAY,
      kind: "out",
      lockedPeriod: null,
    });
  });

  it("leaves an overtime submission with no amendment detail at all", async () => {
    await singleStepRoute();
    const submissionId = await submit();

    const row = (await store.pendingApprovalsFor(boss, LATER))
      .find((candidate) => candidate.id === submissionId);

    // Absence is the discriminator, exactly as it is on `ActPreview` — so a reader that branches
    // on `row.amendment` cannot be fooled by an overtime row carrying an empty one.
    expect(row).toBeDefined();
    expect(row?.amendment).toBeUndefined();
  });

  it("shows the employee the same detail in their own list", async () => {
    await singleStepRoute();
    const punchId = await clockIn();
    const submissionId = await fileCorrection(punchId);
    const overtimeId = await submit();

    const mine = await store.listSubmissionsFor(worker);

    expect(mine.find((row) => row.id === submissionId)?.amendment).toEqual({
      targetPunchId: punchId,
      currentOccurredAt: JUL,
      requestedOccurredAt: JUL - 1800_000,
      workDate: DAY,
      kind: "in",
      lockedPeriod: null,
    });
    expect(mine.find((row) => row.id === overtimeId)?.amendment).toBeUndefined();
  });

  it("names the closed period a correction would write into", async () => {
    await singleStepRoute();
    const punchId = await clockIn();
    const submissionId = await fileCorrection(punchId);
    // Closed AFTER filing, which is the ordinary case: the month ends and payroll runs while
    // requests for it are still in the queue. Filing does not check the lock, on purpose.
    await store.lockPeriod("2026-07", boss, LATER);

    const row = (await store.pendingApprovalsFor(boss, LATER))
      .find((candidate) => candidate.id === submissionId);

    // Named, not flagged: an approver triaging a queue has to read WHICH month they are about to
    // reopen, and applying an approved amendment is the only write in this system allowed in.
    expect(row?.amendment?.lockedPeriod).toBe("2026-07");
    // The lock is a fact about the month, not about the request, so it must not leak onto rows
    // whose month is open.
    const july = await store.pendingApprovalsFor(boss, LATER);
    expect(july.every((r) => r.kind !== "overtime" || r.amendment === undefined)).toBe(true);
  });

  /**
   * The join must not turn the queue scan quadratic, and "it looked fine" is not a finding.
   *
   * `pendingApprovalsFor` already pays one indexed point lookup per pending row for the authority
   * prologue; the detail is meant to be free on top of that. It is free only if every joined table
   * is reached by an index — `punches` twice, once by primary key and once by the partial unique
   * index on `supersedes_id`, and `period_locks` by its primary key. A missed index on either
   * `punches` join would make the queue's cost the pending set TIMES the whole punch history,
   * which on this table is the biggest one in the schema.
   *
   * Asserted on the plan rather than on a timing, because a timing that passes on an empty test
   * store proves nothing about a store with a year of punches in it. The query is read from the
   * module under test, not restated here, so a change to the joins is a change to what is checked.
   */
  it("reaches every joined table by an index, so neither list scans punches", async () => {
    const plans = await runInDurableObject(store, (instance) =>
      // One bound parameter for the employee list, none for the queue. `EXPLAIN QUERY PLAN` needs
      // the parameter supplied even though it runs nothing.
      ([[PENDING_APPROVALS_QUERY, []], [SUBMISSIONS_FOR_EMPLOYEE_QUERY, [1]]] as const).map(
        ([query, args]) =>
          instance.sql
            .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...args)
            .toArray()
            .map((step) => step.detail)));

    for (const plan of plans) {
      // Exactly one table is walked, and it is the one the WHERE clause narrows: `submissions`.
      // `pendingApprovalsFor` then pays the authority prologue per surviving row, which is the
      // cost its own comment measures. Everything the detail adds must be a point lookup on top of
      // that — a `SCAN punches` here would make the cost the pending set times the punch history,
      // and `punches` is the largest table in the schema by a wide margin.
      expect(plan.filter((step) => step.startsWith("SCAN"))).toEqual(["SCAN s"]);
      // Not merely "no scan": every join step must name the index it took, so that dropping
      // `punches_supersedes_unique` (or the successor join ever being written in a way SQLite
      // cannot prove satisfies that partial index) fails here rather than degrading quietly.
      const searches = plan.filter((step) => step.startsWith("SEARCH"));
      expect(searches).toHaveLength(4);
      for (const step of searches) {
        expect(step).toMatch(/USING (INTEGER PRIMARY KEY|(COVERING )?INDEX )/);
      }
      // And each of the four joined aliases is one of them: `a` the request, `t` the target punch,
      // `c` the punch that superseded it, `pl` the period lock.
      expect(searches.map((step) => step.split(" ")[1]).sort()).toEqual(["a", "c", "pl", "t"]);
    }
  });

  it("shows the punch's new time when the target was superseded out of band", async () => {
    await singleStepRoute();
    const punchId = await clockIn();
    const submissionId = await fileCorrection(punchId);
    // Somebody else corrects the same punch directly — an admin from the HR surface, say — while
    // the request sits in the queue. `punches` is append-only, so this writes a SUCCESSOR row and
    // leaves the target's own `occurred_at` at 09:00 forever.
    await store.correctPunch(
      punchId,
      { employeeId: worker, workDate: DAY, kind: "in", now: JUL + 600_000, source: "admin" },
      boss, "corrected from the paper sheet", LATER,
    );

    const row = (await store.pendingApprovalsFor(boss, LATER))
      .find((candidate) => candidate.id === submissionId);

    // 09:10, the successor's time — not the 09:00 the target row still records. This is the ONE
    // signal a triaging approver gets that the request is now doomed: `actOnAmendment` will refuse
    // it with `KINTAI_AMENDMENT_TARGET_SUPERSEDED` whatever they decide, and nothing else in the
    // row has changed. Reading the target's own frozen time would show them a comparison that has
    // not been the live one since the moment the successor was written.
    expect(row?.amendment?.currentOccurredAt).toBe(JUL + 600_000);
    expect(row?.amendment?.targetPunchId).toBe(punchId);
  });
});
