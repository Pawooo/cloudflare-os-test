import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fileAmendment } from "../src/store/amendments.js";
import type { NewAddition, NewCorrection } from "../src/store/amendments.js";
import type { PunchKind, SubmissionState } from "../src/types.js";

// Rejection assertions are written as `expect(() => store.method(...))`, never as
// `expect(store.method(...))` — see the header of `submissions.test.ts` for why.

const DAY = "2026-07-03";
const NINE_AM = Date.parse("2026-07-03T00:00:00Z");
const APR = Date.parse("2026-04-01T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let employeeId: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`amendments-${seq++}`);
  employeeId = await store.createEmployee({
    employeeNumber: "E900", displayName: "Tanaka", joinedOn: "2026-04-01",
  });
});

/**
 * Write the two rows `fileAmendment` will write, directly, and return the submission id.
 *
 * There is no filing path yet — it is Task 4 — so the only way to see either read function do
 * anything but return null is to put the rows there by hand. Raw SQL inside the object rather
 * than a new store method, for the reason `rejectsUnknownEnum` in `__tests__/worker.ts` uses it:
 * the shape under test is unreachable through every public surface, and inventing a surface to
 * reach it would mean shipping a write nothing but this test calls.
 *
 * When `fileAmendment` lands, these two inserts are what it must agree with.
 */
async function fileRaw(input: {
  targetPunchId: number | null;
  kind: PunchKind;
  occurredAt: number;
  state?: SubmissionState;
}): Promise<number> {
  const state = input.state ?? "pending";
  return runInDurableObject(store, (instance) => {
    const submission = instance.sql
      .exec<{ id: number }>(
        `INSERT INTO submissions
           (employee_id, kind, requested_for, state, submitted_at, current_step,
            minutes, reason, calculation_inputs, route_snapshot, created_by)
         VALUES (?, 'amendment', ?, ?, ?, 0, 0, 'forgot to clock out', NULL, ?, ?)
         RETURNING id`,
        employeeId, DAY, state, NINE_AM, JSON.stringify({ routeId: 0, steps: [] }), employeeId,
      )
      .one();
    instance.sql.exec(
      `INSERT INTO amendment_requests
         (submission_id, target_punch_id, work_date, kind, occurred_at, applied_punch_id)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      submission.id, input.targetPunchId, DAY, input.kind, input.occurredAt,
    );
    return submission.id;
  });
}

describe("the amendment record", () => {
  it("returns null for a submission that is not an amendment", async () => {
    expect(await store.getAmendment(999)).toBeNull();
  });

  it("reports no pending amendment for an untouched punch", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
  });

  it("reads back every column of a request against an existing punch", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const submissionId = await fileRaw({
      targetPunchId: punchId, kind: "in", occurredAt: NINE_AM - 1800_000,
    });

    expect(await store.getAmendment(submissionId)).toEqual({
      submission_id: submissionId,
      target_punch_id: punchId,
      work_date: DAY,
      kind: "in",
      occurred_at: NINE_AM - 1800_000,
      // Null until the approval that applies it writes the punch, in Task 6. This column is the
      // one thing in the feature that changes after it is written, and it changes exactly once.
      applied_punch_id: null,
    });
    expect(await store.pendingAmendmentForPunch(punchId)).toBe(submissionId);
  });

  it("carries a null target for a punch that was never recorded", async () => {
    // The forgotten clock-out. `correctPunch` structurally cannot express it — it supersedes an
    // existing row — and a null `target_punch_id` is the entire difference.
    const submissionId = await fileRaw({
      targetPunchId: null, kind: "out", occurredAt: NINE_AM + 9 * 3600_000,
    });

    expect(await store.getAmendment(submissionId)).toMatchObject({
      target_punch_id: null, kind: "out", applied_punch_id: null,
    });
  });

  it("stops reporting a request against a punch once it has been decided", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    await fileRaw({
      targetPunchId: punchId, kind: "in", occurredAt: NINE_AM - 1800_000, state: "rejected",
    });

    // A rejected request is finished, so it no longer reserves its target and a second attempt at
    // the same correction is allowed. `approved` and `withdrawn` are finished the same way.
    expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
  });

  it("keeps a draft request reserving its target", async () => {
    const punchId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
    });
    const submissionId = await fileRaw({
      targetPunchId: punchId, kind: "in", occurredAt: NINE_AM - 1800_000, state: "draft",
    });

    // Undecided is `draft` OR `pending`: a draft has not been given up on, and letting a second
    // request past it would leave two live requests to correct one punch.
    expect(await store.pendingAmendmentForPunch(punchId)).toBe(submissionId);
  });

  it("refuses a request whose target punch does not exist", async () => {
    // The foreign key, not an application check. `fileAmendment` will refuse this with a readable
    // error in Task 4; this pins that the database refuses it regardless.
    await expect(() => fileRaw({
      targetPunchId: 9999, kind: "in", occurredAt: NINE_AM,
    })).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("filing an amendment", () => {
  let managerId: number;

  beforeEach(async () => {
    managerId = await store.createEmployee({
      employeeNumber: "M900", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(employeeId, managerId, APR);
  });

  /** A correction of `punchId`. `work_date` and `kind` are the target's; the caller cannot say. */
  function correction(punchId: number, over: Partial<NewCorrection> = {}): NewCorrection {
    return {
      employeeId, targetPunchId: punchId, occurredAt: NINE_AM - 1800_000,
      reason: "clocked in before the terminal woke up", now: NINE_AM + 3600_000,
      department: null, employmentType: null, createdBy: employeeId,
      ...over,
    };
  }

  /** A punch that was never recorded. Here the caller does say the day and the kind. */
  function addition(over: Partial<NewAddition> = {}): NewAddition {
    return {
      employeeId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: NINE_AM + 9 * 3600_000, reason: "forgot to clock out",
      now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: employeeId,
      ...over,
    };
  }

  async function punchAt(occurredAt: number, kind: PunchKind = "in"): Promise<number> {
    return store.recordPunch({
      employeeId, workDate: DAY, kind, now: occurredAt, source: "gadget",
    });
  }

  describe("the target punch", () => {
    it("refuses one that does not exist", async () => {
      await expect(() => store.fileAmendment(correction(9999)))
        .rejects.toThrow(/KINTAI_AMENDMENT_TARGET/);
    });

    it("refuses one belonging to somebody else", async () => {
      const other = await store.createEmployee({
        employeeNumber: "E901", displayName: "Suzuki", joinedOn: "2026-04-01",
      });
      const theirs = await store.recordPunch({
        employeeId: other, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });

      // Named by id alone, an amendment would otherwise be a way to reach into another person's
      // record through a route resolved for the filer's own.
      await expect(() => store.fileAmendment(correction(theirs)))
        .rejects.toThrow(/KINTAI_AMENDMENT_TARGET/);
      expect(await store.pendingAmendmentForPunch(theirs)).toBeNull();
    });

    it("refuses one that has already been superseded", async () => {
      const original = await punchAt(NINE_AM);
      await store.correctPunch(
        original,
        { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1000, source: "admin" },
        managerId, "earlier", NINE_AM + 500,
      );

      // A superseded punch is history. Amending it would produce a second correction of the same
      // original, and whichever applied last would silently win.
      await expect(() => store.fileAmendment(correction(original)))
        .rejects.toThrow(/KINTAI_PUNCH_ALREADY_AMENDED/);
    });

    it("accepts the correction that superseded it", async () => {
      const original = await punchAt(NINE_AM);
      const current = await store.correctPunch(
        original,
        { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 1000, source: "admin" },
        managerId, "earlier", NINE_AM + 500,
      );

      const submissionId = await store.fileAmendment(correction(current));
      expect(await store.pendingAmendmentForPunch(current)).toBe(submissionId);
    });
  });

  describe("the occurrence", () => {
    it("refuses one in the future", async () => {
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(
        correction(punchId, { occurredAt: NINE_AM + 3600_001, now: NINE_AM + 3600_000 }),
      )).rejects.toThrow(/KINTAI_FUTURE_OCCURRENCE/);
    });

    it("allows one at exactly the present instant", async () => {
      // The bound is `>`, not `>=`: filing a correction for a punch that should have been made
      // just now is ordinary, and refusing it would be an off-by-one nobody could work around.
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(
        correction(punchId, { occurredAt: NINE_AM + 3600_000, now: NINE_AM + 3600_000 }),
      );
      expect(await store.getAmendment(submissionId)).toMatchObject({
        occurred_at: NINE_AM + 3600_000,
      });
    });

    it("refuses one measured against an instant that is not finite", async () => {
      // Every comparison with `NaN` is false, so a `now` of `NaN` would silently disarm the bound
      // above rather than fail — the future occurrence would just be accepted.
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(
        correction(punchId, { occurredAt: NINE_AM + 10 * 3600_000, now: Number.NaN }),
      )).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });

    it("refuses one that is not a finite instant", async () => {
      // `NaN > now` is false, so a bare future comparison would let this through and store a punch
      // time nothing downstream can order.
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(correction(punchId, { occurredAt: Number.NaN })))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });
  });

  describe("one undecided request per punch", () => {
    it("refuses a second while the first is undecided", async () => {
      const punchId = await punchAt(NINE_AM);
      const first = await store.fileAmendment(correction(punchId));

      await expect(() => store.fileAmendment(correction(punchId, { reason: "again" })))
        .rejects.toThrow(new RegExp(`KINTAI_DUPLICATE_AMENDMENT.*${first}`));
    });

    it("allows another once the first is withdrawn", async () => {
      const punchId = await punchAt(NINE_AM);
      const first = await store.fileAmendment(correction(punchId));
      await store.withdrawSubmission(first, employeeId);

      const second = await store.fileAmendment(correction(punchId, { reason: "again" }));
      expect(second).not.toBe(first);
      expect(await store.pendingAmendmentForPunch(punchId)).toBe(second);
    });

    it("refuses a second request to add the same punch", async () => {
      // The same rule for the null-target case, which `pendingAmendmentForPunch` cannot see:
      // there is no target punch to key on, so two identical additions would both apply and the
      // day would carry the forgotten clock-out twice.
      await store.fileAmendment(addition());
      await expect(() => store.fileAmendment(addition({ reason: "again" })))
        .rejects.toThrow(/KINTAI_DUPLICATE_AMENDMENT/);
    });

    it("allows adding the same kind at a different time", async () => {
      await store.fileAmendment(addition());
      const second = await store.fileAmendment(
        addition({ occurredAt: NINE_AM + 10 * 3600_000, reason: "and a second break end" }),
      );
      expect(await store.getAmendment(second)).toMatchObject({
        occurred_at: NINE_AM + 10 * 3600_000,
      });
    });
  });

  describe("adding a punch the day already has", () => {
    it("refuses an addition at the same kind and time", async () => {
      // Not caught downstream: `recordPunch`'s duplicate suppression keys on a sixty-second window
      // around the CURRENT instant, and an amendment's occurrence is in the past.
      await punchAt(NINE_AM + 9 * 3600_000, "out");
      await expect(() => store.fileAmendment(addition()))
        .rejects.toThrow(/KINTAI_DUPLICATE_PUNCH/);
    });

    it("allows an addition of a different kind at that time", async () => {
      await punchAt(NINE_AM + 9 * 3600_000, "break_start");
      const submissionId = await store.fileAmendment(addition());
      expect(await store.getAmendment(submissionId)).toMatchObject({ kind: "out" });
    });

    it("ignores a superseded punch at that time", async () => {
      // A superseded punch is not on the day any more, so it cannot be what the addition
      // duplicates. Refusing here would make a day unfixable after one bad correction.
      const stale = await punchAt(NINE_AM + 9 * 3600_000, "out");
      await store.correctPunch(
        stale,
        { employeeId, workDate: DAY, kind: "out", now: NINE_AM + 11 * 3600_000, source: "admin" },
        managerId, "moved", NINE_AM + 12 * 3600_000,
      );

      const submissionId = await store.fileAmendment(addition());
      expect(await store.getAmendment(submissionId)).toMatchObject({
        occurred_at: NINE_AM + 9 * 3600_000,
      });
    });
  });

  describe("the rest of the input", () => {
    it("refuses a blank reason", async () => {
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(correction(punchId, { reason: "   " })))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });

    it("refuses a reason longer than the limit", async () => {
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(correction(punchId, { reason: "x".repeat(2_001) })))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });

    it("refuses an addition whose kind is not a punch kind at the RPC boundary", async () => {
      await expect(() => store.fileAmendment(
        // @ts-expect-error -- the point is what happens when TypeScript is bypassed.
        addition({ kind: "nonsense" }),
      )).rejects.toThrow(/capnweb-validate/);
    });

    it("refuses an addition whose kind is not a punch kind inside the store", async () => {
      // The same junk, one layer in. `@validateRpc()` catches it over RPC, but the apply path and
      // the session facet call the store in-process and never cross that boundary, so the check
      // has to exist on this side of it too. Calling the function directly is the only way to see
      // the inner guard at all.
      await expect(() => runInDurableObject(store, (instance) =>
        fileAmendment(instance.sql, addition({ kind: "nonsense" as PunchKind })),
      )).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });

    it("refuses an addition whose work date is not a calendar date", async () => {
      await expect(() => store.fileAmendment(addition({ workDate: "2026-02-31" })))
        .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    });
  });

  describe("the approval route", () => {
    it("refuses an employee with no reachable approver", async () => {
      // `assertApproverReachable` was specified, tested and exposed in an earlier round and then
      // never wired into a write path. Without it the submission is created and strands: nobody
      // is in its route, so nobody can decide it and only the employee can clear it.
      const orphan = await store.createEmployee({
        employeeNumber: "E902", displayName: "Root", joinedOn: "2026-04-01",
      });
      const theirs = await store.recordPunch({
        employeeId: orphan, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });

      await expect(() => store.fileAmendment(
        correction(theirs, { employeeId: orphan, createdBy: orphan }),
      )).rejects.toThrow(/KINTAI_NO_APPROVER/);
      expect(await store.pendingAmendmentForPunch(theirs)).toBeNull();
    });

    it("refuses a route whose only step is pinned to the employee", async () => {
      // Scoped to a department so it outranks the seeded catch-all: an exact tie on specificity is
      // broken by the lowest route id, which is always that default.
      await store.createRoute({
        name: "self-pinned", department: "CONSTRUCTION",
        steps: [{ rule: "any_of", approverKind: "employee", approverEmployeeId: employeeId }],
      });
      const punchId = await punchAt(NINE_AM);

      // Such a submission is approvable by nobody: `authorize` refuses everyone but the pinned
      // approver, and `checkMayAct` refuses the pinned approver for being the employee.
      await expect(() => store.fileAmendment(
        correction(punchId, { department: "CONSTRUCTION" }),
      )).rejects.toThrow(/KINTAI_NO_ROUTE/);
    });

    it("freezes the resolved route onto the submission", async () => {
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(punchId));

      const submission = await store.getSubmission(submissionId);
      expect(JSON.parse(submission.route_snapshot).steps).toHaveLength(1);
    });
  });

  describe("what filing writes", () => {
    it("copies the work date and kind from the target of a correction", async () => {
      const punchId = await punchAt(NINE_AM, "break_end");
      const submissionId = await store.fileAmendment(correction(punchId));

      // The caller never states either one for a correction, so they cannot disagree with the row
      // being corrected — and `correctPunch` refuses a mismatch again when the punch is written.
      expect(await store.getAmendment(submissionId)).toEqual({
        submission_id: submissionId,
        target_punch_id: punchId,
        work_date: DAY,
        kind: "break_end",
        occurred_at: NINE_AM - 1800_000,
        applied_punch_id: null,
      });
      expect(await store.getSubmission(submissionId)).toMatchObject({ requested_for: DAY });
    });

    it("files a missing punch with no target", async () => {
      const submissionId = await store.fileAmendment(addition());

      expect(await store.getAmendment(submissionId)).toEqual({
        submission_id: submissionId,
        target_punch_id: null,
        work_date: DAY,
        kind: "out",
        occurred_at: NINE_AM + 9 * 3600_000,
        applied_punch_id: null,
      });
    });

    it("creates a pending amendment submission carrying zero minutes", async () => {
      const submissionId = await store.fileAmendment(addition());
      const submission = await store.getSubmission(submissionId);

      expect(submission).toMatchObject({
        employee_id: employeeId,
        kind: "amendment",
        state: "pending",
        current_step: 0,
        requested_for: DAY,
        reason: "forgot to clock out",
        // Zero because `minutes` belongs to overtime: an amendment's effect on credited minutes
        // can be negative and is unknown until it is applied. Never read for an amendment.
        minutes: 0,
        // Not the amendment payload. Reusing a column named for overtime's arithmetic would be a
        // naming lie; `amendment_requests` carries what a correction needs.
        calculation_inputs: null,
        created_by: employeeId,
      });
      expect(submission.submitted_at).toBe(NINE_AM + 20 * 3600_000);
    });

    it("records the filer when a manager files for their report", async () => {
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(punchId, { createdBy: managerId }));

      const submission = await store.getSubmission(submissionId);
      expect(submission.employee_id).toBe(employeeId);
      expect(submission.created_by).toBe(managerId);
    });

    it("puts the amendment in the manager's queue", async () => {
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(punchId));

      const queue = await store.pendingApprovalsFor(managerId, NINE_AM + 4 * 3600_000);
      expect(queue.map((row) => row.id)).toContain(submissionId);
    });
  });
});
