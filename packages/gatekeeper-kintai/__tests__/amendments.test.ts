import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fileAmendment } from "../src/store/amendments.js";
import type { NewAddition, NewCorrection } from "../src/store/amendments.js";
import type { PunchKind, SubmissionState } from "../src/types.js";
import { MAX_SHIFT_MS } from "../src/work-date.js";

// Rejection assertions are written as `expect(() => store.method(...))`, never as
// `expect(store.method(...))` — see the header of `submissions.test.ts` for why.

const DAY = "2026-07-03";
const NINE_AM = Date.parse("2026-07-03T00:00:00Z");
/** The instant `DAY` begins in JST — nine hours before `NINE_AM`, not `Date.parse(DAY)`. */
const DAY_START = Date.parse("2026-07-03T00:00:00+09:00");
/** JST has no DST, so every JST day is exactly this long. */
const DAY_MS = 24 * 3600_000;
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

/**
 * The message of a refusal, for the tests that compare two refusals against each other.
 *
 * `expect(...).rejects.toThrow(/regex/)` cannot express "these two say the SAME thing", which is
 * the whole assertion where an error's job is to disclose nothing. The promise is created and
 * awaited inside the `try`, so it is never left unhandled for a turn — see this file's header.
 */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected this call to be refused, and it was not");
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

    it("refuses both with the SAME message, so the id space cannot be walked", async () => {
      // The two refusals used to be distinguishable — "there is no punch with id N" versus
      // "punch N does not belong to employee E" — which made this an oracle: anyone who can file
      // an amendment could try ids and read back which punches exist in the whole company's
      // record. Harmless while nothing outside these tests called `fileAmendment`; the session
      // facet now does. The detail is useful to an administrator and dangerous to an employee, so
      // it is gone from this path rather than reworded.
      const other = await store.createEmployee({
        employeeNumber: "E903", displayName: "Suzuki", joinedOn: "2026-04-01",
      });
      const theirs = await store.recordPunch({
        employeeId: other, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });

      // Byte-identical apart from the id the caller itself supplied, which discloses nothing it
      // did not already know.
      const missing = await refusal(() => store.fileAmendment(correction(theirs + 10_000)));
      const borrowed = await refusal(() => store.fileAmendment(correction(theirs)));

      expect(borrowed).toBe(missing.replace(String(theirs + 10_000), String(theirs)));
      expect(borrowed).not.toMatch(new RegExp(`employee ${employeeId}|employee ${other}`));
      expect(borrowed).not.toMatch(/does not exist|there is no punch|belong/);
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

  // ----------------------------------------------------------------------------------------------
  // The named work date and the occurrence, checked AGAINST EACH OTHER.
  //
  // Nothing did, so an addition naming 2026-07-03 with an occurrence three weeks away was accepted
  // and applied there — and a correction, whose day is copied off the target and so cannot be
  // wrong, could still move a punch's TIME to an instant that day never contained. Both produce a
  // punch filed against a day it does not belong to, which is precisely what `long_span`,
  // `orphan_out` and `negative_gross` exist to flag after the fact.
  //
  // The caller most likely to get this wrong is an agent constructing a date, and "the approver
  // will notice" is weak when the request reads plausibly: an approver is shown the day and the
  // clock time, not the arithmetic between them.
  // ----------------------------------------------------------------------------------------------
  describe("the occurrence against the day it names", () => {
    it("refuses an addition whose occurrence is weeks from the day it names", async () => {
      await expect(() => store.fileAmendment(
        addition({ occurredAt: DAY_START + 21 * DAY_MS, now: DAY_START + 30 * DAY_MS }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
    });

    it("refuses an addition one day off, which is the mistake actually made", async () => {
      // A JST/UTC confusion is worth nine hours, so it lands on the neighbouring date rather than
      // somewhere obviously absurd. This is the case the check is for.
      await expect(() => store.fileAmendment(
        addition({ occurredAt: NINE_AM + DAY_MS, now: NINE_AM + 2 * DAY_MS }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
    });

    it("holds the day's own boundaries for a calendar employee", async () => {
      // The whole JST day and nothing either side of it. `assertWorkDate` guarantees the day is
      // real, so this is exactly `jstWorkDate(occurredAt) === workDate` — the same answer live
      // attribution gives a `calendar` employee, asked of a past instant.
      const lastInstant = await store.fileAmendment(
        addition({ occurredAt: DAY_START + DAY_MS - 1 }),
      );
      expect(await store.getAmendment(lastInstant)).toMatchObject({
        occurred_at: DAY_START + DAY_MS - 1,
      });

      await expect(() => store.fileAmendment(
        addition({ occurredAt: DAY_START + DAY_MS, reason: "one millisecond into tomorrow" }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
      await expect(() => store.fileAmendment(
        addition({ occurredAt: DAY_START - 1, reason: "one millisecond before the day" }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
    });

    it("refuses a correction that moves a punch off its own day", async () => {
      // The correction half, and it is not covered by the addition half: `work_date` is copied off
      // the target and so cannot disagree with it, but `occurred_at` is caller-supplied on both
      // paths. `correctPunch` would write the new time against the target's day without comment.
      const punchId = await punchAt(NINE_AM);
      await expect(() => store.fileAmendment(
        correction(punchId, { occurredAt: NINE_AM + DAY_MS, now: NINE_AM + 2 * DAY_MS }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
    });

    it("allows a night worker's clock-out on the following morning", async () => {
      // The case that forbids a plain equality check: for a `shift_start` employee a 06:00
      // clock-out belongs to the date the shift STARTED, so the occurrence's own JST date is
      // legitimately the next one. This is the forgotten clock-out this whole feature exists for.
      await store.setWorkDatePolicy(employeeId, "shift_start");
      const nightShiftOut = DAY_START + 30 * 3600_000;  // 06:00 JST the following morning

      const submissionId = await store.fileAmendment(
        addition({ occurredAt: nightShiftOut, now: DAY_START + 40 * 3600_000 }),
      );
      expect(await store.getAmendment(submissionId)).toMatchObject({
        work_date: DAY, occurred_at: nightShiftOut,
      });
    });

    it("bounds a night worker's day by one shift's length past it", async () => {
      // A shift can open at any hour of the named day and stops claiming punches at
      // `MAX_SHIFT_MS` — so the widest instant any shift dated D can honestly reach is
      // `MAX_SHIFT_MS` past the END of D. Past that the punch belongs to a later day whatever
      // the policy.
      await store.setWorkDatePolicy(employeeId, "shift_start");
      const edge = DAY_START + DAY_MS + MAX_SHIFT_MS;

      const submissionId = await store.fileAmendment(
        addition({ occurredAt: edge - 1, now: edge + DAY_MS }),
      );
      expect(await store.getAmendment(submissionId)).toMatchObject({ occurred_at: edge - 1 });

      await expect(() => store.fileAmendment(
        addition({ occurredAt: edge, now: edge + DAY_MS, reason: "one past the bound" }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);
    });

    it("reads the policy off the employee, not off the request", async () => {
      // The same instant, refused for a `calendar` employee and accepted for a night worker. The
      // policy is HR's setting on the employee record and no caller can name it.
      const nightShiftOut = DAY_START + 30 * 3600_000;
      await expect(() => store.fileAmendment(
        addition({ occurredAt: nightShiftOut, now: DAY_START + 40 * 3600_000 }),
      )).rejects.toThrow(/KINTAI_AMENDMENT_WORK_DATE/);

      await store.setWorkDatePolicy(employeeId, "shift_start");
      await expect(store.fileAmendment(
        addition({ occurredAt: nightShiftOut, now: DAY_START + 40 * 3600_000 }),
      )).resolves.toBeGreaterThan(0);
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

    // Asked at the FILING instant, not about the day the punch belongs to. A correction reaches
    // back further than overtime ever does, so the work date is further from the org that has to
    // act on it -- and the manager who has to act is the one who exists today. Anchored on the
    // work date this is refused outright, permanently, with the obvious approver standing there.
    it("asks who can approve as of now, not as of the day being corrected", async () => {
      const latecomer = await store.createEmployee({
        employeeNumber: "E904", displayName: "Late", joinedOn: "2026-04-01",
      });
      const theirs = await store.recordPunch({
        employeeId: latecomer, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });
      // Nobody could have approved for them on the day itself; a reporting line opened a month
      // later, and it is that manager who will decide this request.
      await store.setReportingLine(latecomer, managerId, NINE_AM + 30 * 86400_000);

      await expect(store.fileAmendment(correction(theirs, {
        employeeId: latecomer, createdBy: latecomer, now: NINE_AM + 40 * 86400_000,
      }))).resolves.toEqual(expect.any(Number));
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

    // The shape overtime cannot reach and an amendment can. `submitOvertime` refuses an exempt
    // employee outright -- no premium, nothing to approve -- so its exemption arm never came up.
    // A 管理監督者's punches are still the record of when they worked, so this path deliberately
    // does not refuse them, and while an exemption counted as "needs nobody" the request was
    // accepted into a queue nobody could act on.
    it("refuses an exempt employee with nobody to approve for them", async () => {
      const officer = await store.createEmployee({
        employeeNumber: "E905", displayName: "Officer", joinedOn: "2026-04-01",
      });
      await store.grantExemption(officer, APR);
      const theirs = await store.recordPunch({
        employeeId: officer, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });

      await expect(() => store.fileAmendment(
        correction(theirs, { employeeId: officer, createdBy: officer }),
      )).rejects.toThrow(/KINTAI_NO_APPROVER/);
      expect(await store.pendingAmendmentForPunch(theirs)).toBeNull();
    });

    // And the fix the refusal names actually works, which is the half that matters: refusing an
    // officer who can never be given an approver would just be stranding them earlier.
    it("accepts that same employee once an administrator designates an approver", async () => {
      const officer = await store.createEmployee({
        employeeNumber: "E906", displayName: "Officer", joinedOn: "2026-04-01",
      });
      await store.grantExemption(officer, APR);
      await store.setDesignatedApprover(officer, managerId);
      const theirs = await store.recordPunch({
        employeeId: officer, workDate: DAY, kind: "in", now: NINE_AM, source: "gadget",
      });

      const submissionId = await store.fileAmendment(
        correction(theirs, { employeeId: officer, createdBy: officer }),
      );
      // Filed AND decidable, by the person named. The route resolves to a manager step, which
      // `authorize` satisfies from the designated approver for an employee with no reporting line.
      expect(await store.actOnSubmission({
        submissionId, actorId: managerId, action: "approve", now: NINE_AM + 2 * 3600_000,
      })).toBe("approved");
    });

    // The fourth way a route can be unsatisfiable, and the one `assertSatisfiable` could not see
    // until it was told who filed. A step pinned to the filer is refused by `checkMayAct` at
    // approval time, so the request would sit in a queue nobody could clear.
    it("refuses a route whose only step is pinned to whoever filed it", async () => {
      await store.createRoute({
        name: "filer-pinned", department: "CONSTRUCTION",
        steps: [{ rule: "any_of", approverKind: "employee", approverEmployeeId: managerId }],
      });
      const punchId = await punchAt(NINE_AM);

      await expect(() => store.fileAmendment(correction(punchId, {
        department: "CONSTRUCTION", createdBy: managerId,
      }))).rejects.toThrow(/KINTAI_NO_ROUTE/);
      expect(await store.pendingAmendmentForPunch(punchId)).toBeNull();
    });

    // The same route, filed by the employee themself, is fine: the pinned approver is a third
    // party to it. Refusing this too would make a legitimate escalation route unusable.
    it("accepts that same route when the employee files their own correction", async () => {
      await store.createRoute({
        name: "third-party-pinned", department: "CONSTRUCTION",
        steps: [{ rule: "any_of", approverKind: "employee", approverEmployeeId: managerId }],
      });
      const punchId = await punchAt(NINE_AM);

      await expect(store.fileAmendment(correction(punchId, { department: "CONSTRUCTION" })))
        .resolves.toEqual(expect.any(Number));
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

  /**
   * `checkMayAct`'s filer refusal, pinned on the path that made it necessary.
   *
   * It landed with overtime (`a944e0f`) where it is a no-op, because `created_by` and
   * `employee_id` are the same person for every overtime submission the facet writes. Amendments
   * are the first thing that separates them for real: a foreman fixes their worker's forgotten
   * clock-out, and without this they would be authorising a change to payroll input they
   * originated, with nothing in the trail saying the two hands were one.
   */
  describe("nobody approves what they filed", () => {
    it("refuses an approval by the manager who filed it for their report", async () => {
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(
        correction(punchId, { createdBy: managerId }),
      );

      await expect(() => store.actOnSubmission({
        submissionId, actorId: managerId, action: "approve", now: NINE_AM + 4 * 3600_000,
      })).rejects.toThrow(/KINTAI_FILED_BY_APPROVER/);
      expect((await store.getSubmission(submissionId)).state).toBe("pending");
    });

    it("lets a different approver decide the same request", async () => {
      // A second manager of the EMPLOYEE, not of the foreman: the seeded route is a single
      // `any_of` manager step, so both are live approvers and the request the filer cannot decide
      // is not thereby undecidable.
      const bossId = await store.createEmployee({
        employeeNumber: "B900", displayName: "Ito", joinedOn: "2026-04-01",
      });
      await store.setReportingLine(employeeId, bossId, APR);
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(
        correction(punchId, { createdBy: managerId }),
      );

      expect(await store.actOnSubmission({
        submissionId, actorId: bossId, action: "approve", now: NINE_AM + 4 * 3600_000,
      })).toBe("approved");
    });

    it("keeps it out of the filer's own queue, and in the other approver's", async () => {
      const bossId = await store.createEmployee({
        employeeNumber: "B901", displayName: "Ito", joinedOn: "2026-04-01",
      });
      await store.setReportingLine(employeeId, bossId, APR);
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(
        correction(punchId, { createdBy: managerId }),
      );

      const at = NINE_AM + 4 * 3600_000;
      expect((await store.pendingApprovalsFor(managerId, at)).map((row) => row.id))
        .not.toContain(submissionId);
      expect((await store.pendingApprovalsFor(bossId, at)).map((row) => row.id))
        .toContain(submissionId);
    });

    it("reports self-approval, not this, when the employee filed their own correction", async () => {
      // Both rules match when an employee corrects their own punch, and the more specific one has
      // to answer -- otherwise they are told a third party filed what they filed themselves.
      const punchId = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(punchId));

      await expect(() => store.actOnSubmission({
        submissionId, actorId: employeeId, action: "approve", now: NINE_AM + 4 * 3600_000,
      })).rejects.toThrow(/KINTAI_SELF_APPROVAL/);
    });
  });
});

/**
 * The decision and the punch it writes, in one turn of the input gate.
 *
 * Everything here goes through `store.actOnSubmission`, which is the only entry point: the store
 * reads the submission's kind for itself and routes an amendment through `actOnAmendment`. There
 * is deliberately no second RPC to apply an approved request — a facet that fetched the kind, then
 * decided, then wrote would have the gate open between each pair, which is the shape of the
 * double-apply race this package has already shipped and fixed once.
 */
describe("applying an approved amendment", () => {
  let managerId: number;

  /** When the manager decides. After every punch and every filing instant used below. */
  const DECIDED_AT = NINE_AM + 30 * 3600_000;
  /** 18:00 JST on DAY — where the converging-requests case makes two punches collide. */
  const SIX_PM = NINE_AM + 9 * 3600_000;

  beforeEach(async () => {
    managerId = await store.createEmployee({
      employeeNumber: "M910", displayName: "Sato", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(employeeId, managerId, APR);
  });

  async function punchAt(occurredAt: number, kind: PunchKind = "in"): Promise<number> {
    return store.recordPunch({
      employeeId, workDate: DAY, kind, now: occurredAt, source: "gadget",
    });
  }

  function correction(punchId: number, over: Partial<NewCorrection> = {}): NewCorrection {
    return {
      employeeId, targetPunchId: punchId, occurredAt: NINE_AM - 1800_000,
      reason: "clocked in before the terminal woke up", now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: employeeId,
      ...over,
    };
  }

  function addition(over: Partial<NewAddition> = {}): NewAddition {
    return {
      employeeId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: SIX_PM, reason: "forgot to clock out", now: NINE_AM + 20 * 3600_000,
      department: null, employmentType: null, createdBy: employeeId,
      ...over,
    };
  }

  // ----------------------------------------------------------------------------------------------
  // The three cases the review found undertested. None of them is a new rule; each one pins a claim
  // the code already makes in prose.
  // ----------------------------------------------------------------------------------------------

  it("shows why appendMissingPunch cannot be recordPunch", async () => {
    // THE COUNTERFACTUAL behind `appendMissingPunch`'s doc comment, which says "Measured, not
    // theorised -- see __tests__/amendments.test.ts" and until now cited nothing.
    //
    // `recordPunch`'s suppression has no upper bound on `occurred_at`: it takes the LATEST
    // unsuperseded punch of that kind on the day with `occurred_at > now - 60s`. Backdate `now`
    // and a later punch matches. Nothing is written and the caller is handed a punch id that has
    // nothing to do with what it asked for -- which, on the amendment path, `applied_punch_id`
    // would then record as the punch the request wrote.
    const sevenPm = await punchAt(NINE_AM + 10 * 3600_000, "out");

    const returned = await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: SIX_PM, source: "gadget",
    });

    expect(returned).toBe(sevenPm);
    expect((await store.currentPunches(employeeId, DAY)).filter((p) => p.kind === "out"))
      .toHaveLength(1);
  });

  it("writes nothing on the non-final signature of an all_of step", async () => {
    const second = await store.createEmployee({
      employeeNumber: "M911", displayName: "Ito", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(employeeId, second, APR);
    // Scoped to a department, and the filing names it. A route with no department TIES the
    // catch-all `applySchema` seeds and loses the tie on id, so an unscoped route here would
    // silently exercise the seeded single-step `any_of` and this test would assert nothing.
    await store.createRoute({
      name: "both-managers", department: "CONSTRUCTION",
      steps: [{ rule: "all_of", approverKind: "manager", approverEmployeeId: null }],
    });
    const submissionId = await store.fileAmendment(
      addition({ department: "CONSTRUCTION" }),
    );

    expect(await approve(submissionId, managerId)).toBe("pending");
    expect((await store.getAmendment(submissionId))!.applied_punch_id).toBeNull();
    expect(await store.currentPunches(employeeId, DAY)).toHaveLength(0);

    // Only the signature that finalises the step writes -- and it is that signer whose name lands
    // in `amended_by`, which is what the doc comment means by "whoever finalised it".
    expect(await approve(submissionId, second, DECIDED_AT + 1000)).toBe("approved");
    const punches = await store.currentPunches(employeeId, DAY);
    expect(punches).toHaveLength(1);
    expect(punches[0].amended_by).toBe(second);
  });

  it("reports unappliable ahead of stale when a decision is both", async () => {
    // Documented precedence: `assertStillApplicable` runs before `actOnSubmission`, so it answers
    // first. Both leave nothing written and both end with a human deciding again, so the ordering
    // is not load-bearing -- but it is observable, and an untested documented ordering is one
    // refactor away from being a lie.
    const punchId = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(correction(punchId));
    // Someone fixes the punch by hand: the request can never apply now.
    await store.correctPunch(
      punchId, { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 60_000, source: "admin" },
      managerId, "fixed at the terminal", DECIDED_AT - 1000,
    );

    await expect(() => store.actOnSubmission({
      submissionId, actorId: managerId, action: "approve", now: DECIDED_AT,
      // A marker that is ALSO stale: nothing has been acted on, so the real value is 0.
      expectedAfterEventId: 99,
    })).rejects.toThrow(/KINTAI_AMENDMENT_TARGET_SUPERSEDED/);
  });

  function approve(
    submissionId: number, actorId = managerId, now = DECIDED_AT,
  ): Promise<SubmissionState> {
    return store.actOnSubmission({ submissionId, actorId, action: "approve", now });
  }

  it("supersedes the target punch and links the result", async () => {
    const original = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(correction(original));

    expect(await approve(submissionId)).toBe("approved");

    const current = await store.currentPunches(employeeId, DAY);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      occurred_at: NINE_AM - 1800_000,
      // Not a punch anybody tapped, and the record says so.
      source: "amendment",
      supersedes_id: original,
      // The APPROVER, not the filer. `amended_by` is the account of whose authority admitted this
      // punch to payroll; who asked for it is `submissions.created_by`.
      amended_by: managerId,
      amend_reason: "clocked in before the terminal woke up",
      // When the correction was ENTERED, which is not when the punch occurred. Conflating the two
      // would erase the one fact an auditor most needs about a backdated write.
      recorded_at: DECIDED_AT,
    });

    expect(await store.getAmendment(submissionId))
      .toMatchObject({ applied_punch_id: current[0].id });

    // The original row is history, not garbage: still readable, still saying what was first
    // recorded. `punches` is append-only.
    const all = await store.allPunches(employeeId, DAY);
    expect(all.map((punch) => punch.id)).toEqual([original, current[0].id]);
    expect(all[0]).toMatchObject({ occurred_at: NINE_AM, source: "gadget", amended_by: null });
  });

  it("writes a missing punch that has no target", async () => {
    await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(addition());

    expect(await approve(submissionId)).toBe("approved");

    const current = await store.currentPunches(employeeId, DAY);
    expect(current.map((punch) => punch.kind)).toEqual(["in", "out"]);
    expect(current[1]).toMatchObject({
      occurred_at: SIX_PM,
      source: "amendment",
      // Nothing to supersede — that is the whole difference between the two cases — but the
      // amender and the reason are still recorded, because they are the only in-table account of
      // why a punch nobody made exists at all.
      supersedes_id: null,
      amended_by: managerId,
      amend_reason: "forgot to clock out",
      recorded_at: DECIDED_AT,
    });
    // The forgotten clock-out, closed. This is what `long_span` has had no outlet for.
    expect(await store.workedMinutes(employeeId, DAY)).toBe(540);
    expect(await store.dayAnomalies(employeeId, DAY)).toEqual([]);
    expect(await store.getAmendment(submissionId))
      .toMatchObject({ applied_punch_id: current[1].id });
  });

  it("writes the added punch even when a later punch of the same kind sits on the day", async () => {
    // `recordPunch` must not be the write on this path, and this is why. Its duplicate
    // suppression asks for the LATEST unsuperseded punch of the same kind on the day with
    // `occurred_at > now - 60s` and NO upper bound; with `now` set to a backdated occurrence, the
    // 19:00 `out` below matches. `recordPunch` would then return that punch's id, write nothing,
    // and the request would record it as the punch it applied — a day left wrong and an
    // `applied_punch_id` pointing at a punch this amendment did not write.
    await punchAt(NINE_AM);
    const late = await punchAt(NINE_AM + 10 * 3600_000, "out");
    const submissionId = await store.fileAmendment(addition());

    expect(await approve(submissionId)).toBe("approved");

    const applied = (await store.getAmendment(submissionId))?.applied_punch_id;
    expect(applied).not.toBe(late);
    const current = await store.currentPunches(employeeId, DAY);
    expect(current).toHaveLength(3);
    expect(current.find((punch) => punch.id === applied))
      .toMatchObject({ occurred_at: SIX_PM, source: "amendment" });
  });

  it("writes nothing while the submission is still pending a second approver", async () => {
    const bossId = await store.createEmployee({
      employeeNumber: "B910", displayName: "Ito", joinedOn: "2026-04-01",
    });
    // Scoped to a department so it outranks the seeded catch-all.
    await store.createRoute({
      name: "two-step", department: "CONSTRUCTION",
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: bossId },
      ],
    });
    const original = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(
      correction(original, { department: "CONSTRUCTION" }),
    );

    expect(await approve(submissionId)).toBe("pending");

    // A step advanced, not a decision reached. Applying here would write a punch the second
    // approver had not agreed to and could no longer refuse.
    expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: null });
    expect((await store.currentPunches(employeeId, DAY)).map((punch) => punch.occurred_at))
      .toEqual([NINE_AM]);

    expect(await approve(submissionId, bossId, DECIDED_AT + 3600_000)).toBe("approved");
    expect((await store.currentPunches(employeeId, DAY))[0].occurred_at)
      .toBe(NINE_AM - 1800_000);
  });

  it("writes nothing when the decision is a rejection", async () => {
    const original = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(correction(original));

    expect(await store.actOnSubmission({
      submissionId, actorId: managerId, action: "reject", now: DECIDED_AT,
    })).toBe("rejected");

    expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: null });
    expect((await store.currentPunches(employeeId, DAY))[0].occurred_at).toBe(NINE_AM);
  });

  it("applies into a locked period, which stays shut to everything else", async () => {
    const original = await punchAt(NINE_AM);
    // Closed BEFORE the request is filed, which is the story `PeriodLockedError` tells: the direct
    // write is refused and the user is sent here. Filing is not blocked by the lock either —
    // refusing to even ask would leave a closed month permanently wrong.
    await store.lockPeriod("2026-07", managerId, NINE_AM + 25 * 3600_000);
    const submissionId = await store.fileAmendment(correction(original));

    expect(await approve(submissionId)).toBe("approved");
    expect((await store.currentPunches(employeeId, DAY))[0].occurred_at)
      .toBe(NINE_AM - 1800_000);

    // And the lock is unmoved. `assertWritable` is the check the facet runs before an ordinary
    // punch — locks live in the facet rather than in the store's write functions precisely so
    // that this one path can go round them, so this is that refusal, immediately afterwards.
    expect(await store.isLocked(DAY)).toBe(true);
    await expect(() => store.assertWritable(DAY)).rejects.toThrow(/KINTAI_PERIOD_LOCKED/);
  });

  it("produces one punch when two approvers act concurrently", async () => {
    const bossId = await store.createEmployee({
      employeeNumber: "B911", displayName: "Ito", joinedOn: "2026-04-01",
    });
    // Two live managers of the employee, and the seeded route is a single `any_of` manager step,
    // so either of them alone approves it.
    await store.setReportingLine(employeeId, bossId, APR);
    const original = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(correction(original));

    const outcomes = await Promise.allSettled([
      approve(submissionId, managerId),
      approve(submissionId, bossId),
    ]);

    // One decides; the other finds the submission already out of `pending`. The decision and the
    // write are one synchronous run inside one turn of the input gate, so there is no instant at
    // which both callers can see it as undecided.
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect((refused as PromiseRejectedResult).reason.message)
      .toMatch(/KINTAI_INVALID_TRANSITION/);

    const all = await store.allPunches(employeeId, DAY);
    expect(all.filter((punch) => punch.source === "amendment")).toHaveLength(1);
    expect(all).toHaveLength(2);
  });

  it("does not write a second punch when the request is already linked to one", async () => {
    // Belt and braces. `actOnSubmission` returns "approved" once, so this is unreachable through
    // the path as it stands — the state is set by hand below because nothing in the package can
    // produce it. It is pinned anyway: this is a payroll write, and the cost of being wrong is a
    // duplicated punch.
    const original = await punchAt(NINE_AM);
    const submissionId = await store.fileAmendment(correction(original));
    const decoy = await punchAt(NINE_AM + 3600_000, "break_start");
    await runInDurableObject(store, (instance) => {
      instance.sql.exec(
        `UPDATE amendment_requests SET applied_punch_id = ? WHERE submission_id = ?`,
        decoy, submissionId,
      );
    });

    expect(await approve(submissionId)).toBe("approved");

    expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: decoy });
    expect((await store.allPunches(employeeId, DAY))
      .filter((punch) => punch.source === "amendment")).toHaveLength(0);
  });

  /**
   * Two things filing cannot catch, because neither is true when the request is filed.
   *
   * Both are refused BEFORE the approval event is written, which is the whole reason they are
   * checked where they are: `isDomainRefusal` in `kintai.ts` classifies any `KINTAI_`-coded error
   * out of this path as "refused outright, nothing landed, retryable", and that classification is
   * only safe while nothing after the insert throws one. So the submission stays `pending` with
   * no approval recorded, and disposal is a rejection or a withdrawal — an approval that cannot
   * be applied is not recorded as one.
   */
  describe("a request that can no longer be applied", () => {
    it("refuses an approval whose target was corrected by another route", async () => {
      const original = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(original));
      // Superseded AFTER filing, so filing's own check could not have seen it. `correctPunch` is
      // reachable from the admin surface, and nothing reserves a target against it.
      await store.correctPunch(
        original,
        { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 60_000, source: "admin" },
        managerId, "fixed by hand", NINE_AM + 26 * 3600_000,
      );

      // `punches_supersedes_unique` would refuse the write anyway (see `__tests__/punches.test.ts`
      // — a second correction of one row throws a raw constraint violation). A coded refusal
      // before anything is written is the difference between an approver being told what happened
      // and an approver being handed a 500 after their approval was recorded.
      await expect(() => approve(submissionId))
        .rejects.toThrow(/KINTAI_AMENDMENT_TARGET_SUPERSEDED/);

      expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: null });
      expect(await store.approvalEvents(submissionId)).toEqual([]);
      expect((await store.getSubmission(submissionId)).state).toBe("pending");
      expect(await store.currentPunches(employeeId, DAY)).toHaveLength(1);
    });

    it("refuses an approval that would duplicate a punch another amendment added", async () => {
      // THE CONVERGING-REQUESTS CASE. Both requests pass filing and neither uniqueness query can
      // see the other: one keys on a punch id, the other on a (day, kind, instant) tuple that was
      // clean when it was asked.
      await punchAt(NINE_AM);
      const atFive = await punchAt(NINE_AM + 8 * 3600_000, "out");
      const added = await store.fileAmendment(addition());
      const moved = await store.fileAmendment(
        correction(atFive, { occurredAt: SIX_PM, reason: "clocked out early by mistake" }),
      );

      expect(await approve(added)).toBe("approved");

      // The day now has an 18:00 `out`. Applying the correction as well would put two `out`
      // punches at one instant on it — exactly what `DuplicatePunchError` refuses at filing time,
      // arriving by a route filing cannot see. The database would not refuse it: two punches at
      // one instant are legal, and have to be.
      await expect(() => approve(moved, managerId, DECIDED_AT + 3600_000))
        .rejects.toThrow(/KINTAI_AMENDMENT_DUPLICATE_PUNCH/);

      expect((await store.getSubmission(moved)).state).toBe("pending");
      expect(await store.approvalEvents(moved)).toEqual([]);
      expect(await store.getAmendment(moved)).toMatchObject({ applied_punch_id: null });
      expect((await store.currentPunches(employeeId, DAY))
        .filter((punch) => punch.kind === "out").map((punch) => punch.occurred_at))
        .toEqual([NINE_AM + 8 * 3600_000, SIX_PM]);
    });

    it("still lets an approver reject it", async () => {
      // The disposal route, and the reason the re-validation guards approvals only. Refusing every
      // decision would leave an unappliable request in the queue for good, clearable only by the
      // employee withdrawing it.
      const original = await punchAt(NINE_AM);
      const submissionId = await store.fileAmendment(correction(original));
      await store.correctPunch(
        original,
        { employeeId, workDate: DAY, kind: "in", now: NINE_AM - 60_000, source: "admin" },
        managerId, "fixed by hand", NINE_AM + 26 * 3600_000,
      );

      expect(await store.actOnSubmission({
        submissionId, actorId: managerId, action: "reject", now: DECIDED_AT,
      })).toBe("rejected");
      expect(await store.getAmendment(submissionId)).toMatchObject({ applied_punch_id: null });
    });
  });

  it("applies an amendment for a shift_start employee onto the shift's own date", async () => {
    const nightId = await store.createEmployee({
      employeeNumber: "N910", displayName: "Night", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(nightId, managerId, APR);
    await store.setWorkDatePolicy(nightId, "shift_start");

    // 22:00 JST on DAY, no clock-out. The shift's date is DAY even though the missing clock-out
    // belongs to 06:00 the next morning.
    const shiftStart = Date.parse("2026-07-03T13:00:00Z");
    await store.recordPunch({
      employeeId: nightId, workDate: DAY, kind: "in", now: shiftStart, source: "gadget",
    });

    const submissionId = await store.fileAmendment({
      employeeId: nightId, targetPunchId: null, workDate: DAY, kind: "out",
      occurredAt: shiftStart + 8 * 3600_000, reason: "forgot at the end of the night",
      now: shiftStart + 30 * 3600_000,
      department: null, employmentType: null, createdBy: nightId,
    });
    expect(await approve(submissionId, managerId, shiftStart + 31 * 3600_000)).toBe("approved");

    // The added punch lands on the work date the REQUEST named, not the JST date of its
    // `occurred_at` — which is the next day. An amendment writes history; it does not re-run
    // attribution, because the request named a day and an approver agreed to that day.
    const punches = await store.currentPunches(nightId, DAY);
    expect(punches.map((punch) => punch.kind)).toEqual(["in", "out"]);
    expect(await store.workedMinutes(nightId, DAY)).toBe(480);
    expect(await store.dayAnomalies(nightId, DAY)).toEqual([]);
    expect(await store.currentPunches(nightId, "2026-07-04")).toEqual([]);
  });
});
