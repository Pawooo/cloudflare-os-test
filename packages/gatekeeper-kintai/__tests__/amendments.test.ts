import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PunchKind, SubmissionState } from "../src/types.js";

// Rejection assertions are written as `expect(() => store.method(...))`, never as
// `expect(store.method(...))` — see the header of `submissions.test.ts` for why.

const DAY = "2026-07-03";
const NINE_AM = Date.parse("2026-07-03T00:00:00Z");

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
