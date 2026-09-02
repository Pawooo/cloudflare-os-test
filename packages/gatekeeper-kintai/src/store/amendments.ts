// A request to change one punch, and the reads that answer "what does this submission ask for?"
// and "is this punch already spoken for?".
//
// One responsibility: what a correction request IS. Nothing here knows about RPC, sessions, or
// authority beyond what it is handed.
//
// `amendment_requests` is the one table in this feature that is not append-only. `applied_punch_id`
// goes from NULL to a value exactly once, when the approval that applies the request writes its
// punch -- a link being completed, not history being rewritten. `punches`, `approval_events` and
// `audit_log` remain append-only, and the punch this column points at is one of them.

import {
  LIMITS, assertNotFuture, assertPunchKind, assertRequiredText, assertWorkDate,
} from "../input.js";
import { resolveRoute } from "../routes.js";
import { assertApproverReachable } from "./org.js";
import { assertSatisfiable } from "./submissions.js";
import type { EmployeeId, PunchKind } from "../types.js";

/**
 * A request to change one punch, hung off the submission that carries its approval.
 *
 * Keyed on `submission_id` and holding no id of its own: an amendment IS a submission, and giving
 * one fact a second identity is how two rows for it start disagreeing.
 *
 * `target_punch_id` is the whole difference between the two supported cases. Non-NULL means "that
 * punch says the wrong time". NULL means "add a punch that was never recorded" -- the forgotten
 * clock-out, which `correctPunch` structurally cannot express, because it supersedes an existing
 * row and there is no row to supersede.
 *
 * One request changes one punch. A day needing both a corrected clock-in and an added clock-out is
 * two requests -- separately approvable, separately auditable, and a manager can approve one and
 * reject the other. The alternative, a request that replaces a day wholesale, records "the day
 * changed" rather than which punch was wrong and why.
 *
 * Column names rather than camelCase, as every other row type in this package does: these rows are
 * read straight out of SQLite.
 */
export type AmendmentRequest = {
  submission_id: number;
  target_punch_id: number | null;
  work_date: string;
  kind: PunchKind;
  occurred_at: number;
  /** The punch an approved request wrote. NULL until it is applied; written once, never again. */
  applied_punch_id: number | null;
};

const COLUMNS =
  `submission_id, target_punch_id, work_date, kind, occurred_at, applied_punch_id`;

/** The amendment detail for a submission, or null if that submission is not an amendment. */
export function getAmendment(sql: SqlStorage, submissionId: number): AmendmentRequest | null {
  return sql
    .exec<AmendmentRequest>(
      `SELECT ${COLUMNS} FROM amendment_requests WHERE submission_id = ?`, submissionId,
    )
    .toArray()[0] ?? null;
}

/**
 * The submission id of an undecided amendment against `punchId`, or null.
 *
 * "Undecided" is `draft` or `pending`: a returned amendment is still in play and its target must
 * stay reserved, while `approved`, `rejected` and `withdrawn` are all finished. Without this, two
 * approvers acting on two requests for the same punch produce two corrections, the second
 * superseding the first, and the record shows a change nobody asked for twice.
 *
 * Ordered by `submission_id` rather than by any timestamp, as everything in this package is: every
 * time value is caller-supplied and therefore not monotonic, and a row id is.
 */
export function pendingAmendmentForPunch(sql: SqlStorage, punchId: number): number | null {
  const row = sql
    .exec<{ submission_id: number }>(
      `SELECT a.submission_id FROM amendment_requests a
       JOIN submissions s ON s.id = a.submission_id
       WHERE a.target_punch_id = ? AND s.state IN ('draft', 'pending')
       ORDER BY a.submission_id LIMIT 1`,
      punchId,
    )
    .toArray()[0];
  return row?.submission_id ?? null;
}

/** What every amendment carries, whichever of the two things it asks for. */
type AmendmentFiling = {
  /** Whose punch it is. Not necessarily who is filing -- see `createdBy`. */
  employeeId: EmployeeId;
  /** The time the punch should carry. In the past; see `assertNotFuture`. */
  occurredAt: number;
  /** Why the record differs from what was recorded. Required, and the only account of it. */
  reason: string;
  /** When this request is being filed. Not the punch's time. */
  now: number;
  department: string | null;
  employmentType: string | null;
  /** Whose hand filed it. The employee themself, or a manager/HR filing on their behalf. */
  createdBy: EmployeeId;
};

/**
 * "That punch says the wrong time."
 *
 * There is deliberately no `workDate` or `kind` here. Both are read off the target and written
 * from there, so a caller cannot state a day or a kind that disagrees with the punch being
 * corrected -- the disagreement is not validated away, it is unrepresentable. `correctPunch`
 * independently refuses a mismatch when the replacement punch is finally written, which keeps the
 * guarantee even if a later caller assembles the row some other way.
 */
export type NewCorrection = AmendmentFiling & { targetPunchId: number };

/**
 * "Add a punch that was never recorded" -- the forgotten clock-out.
 *
 * Here the caller does say the day and the kind, because there is no row to read them from. That
 * is the whole reason the two shapes are separate types rather than one with nullable fields: the
 * fields are meaningful in exactly one of the two cases.
 */
export type NewAddition = AmendmentFiling & {
  targetPunchId: null;
  workDate: string;
  kind: PunchKind;
};

export type NewAmendment = NewCorrection | NewAddition;

/**
 * The named punch is not one this employee can amend.
 *
 * TASK 7 MUST COLLAPSE ITS TWO MESSAGES INTO ONE before any agent-reachable surface can file.
 * "There is no punch with id N" and "punch N does not belong to employee E" are distinguishable,
 * which makes this an oracle: a caller who can file amendments can walk the id space and learn
 * exactly which punch ids exist. Not reachable today — nothing outside this package's own tests
 * calls `fileAmendment` — which is the only reason it is recorded here rather than fixed now. The
 * detail is genuinely useful to an administrator and genuinely dangerous to an employee, so the
 * fix is one message on this path, not a cleverer one.
 */
export class AmendmentTargetError extends Error {
  readonly code = "KINTAI_AMENDMENT_TARGET";
  constructor(detail: string) {
    super(`KINTAI_AMENDMENT_TARGET: ${detail}`);
  }
}

/**
 * The named punch is history: something already supersedes it.
 *
 * Its own code rather than a flavour of `AmendmentTargetError`, because the caller is not wrong
 * about the punch -- they are looking at a stale copy of the day, and the actionable answer is
 * "re-read it and amend the row that is current". `correctPunch` would refuse the write later
 * anyway (the partial unique index on `supersedes_id`), but only after an approver had spent
 * their attention on a request that could never apply.
 */
export class PunchAlreadyAmendedError extends Error {
  readonly code = "KINTAI_PUNCH_ALREADY_AMENDED";
  constructor(punchId: number) {
    super(
      `KINTAI_PUNCH_ALREADY_AMENDED: punch ${punchId} has already been corrected, so it is no ` +
      `longer the current record of that event. Amend the correction that superseded it.`,
    );
  }
}

/** The day already has this punch, so adding it would record the same event twice. */
export class DuplicatePunchError extends Error {
  readonly code = "KINTAI_DUPLICATE_PUNCH";
  constructor(kind: PunchKind, workDate: string) {
    super(
      `KINTAI_DUPLICATE_PUNCH: a ${kind} punch is already recorded at that time on ${workDate}. ` +
      `Correct that punch instead of adding a second one.`,
    );
  }
}

export class DuplicateAmendmentError extends Error {
  readonly code = "KINTAI_DUPLICATE_AMENDMENT";
  constructor(submissionId: number) {
    super(
      `KINTAI_DUPLICATE_AMENDMENT: submission ${submissionId} already asks for this change and ` +
      `has not been decided. Withdraw it before filing another.`,
    );
  }
}

/**
 * What the target punch says about itself, and whether anything has replaced it.
 *
 * `superseded` is `EXISTS`, not a join: a punch has at most one live successor (the partial unique
 * index on `supersedes_id`), and the question is only whether there is one.
 */
type TargetPunch = {
  employee_id: number;
  work_date: string;
  kind: PunchKind;
  superseded: number;
};

/**
 * The submission id of an undecided request to add this exact punch, or null.
 *
 * The null-target half of "one undecided request per punch". `pendingAmendmentForPunch` cannot see
 * these: an addition names no target, so there is no punch id to key on, and two identical
 * additions would otherwise both be approved and write the forgotten clock-out twice.
 *
 * Matched on the whole of what would be written -- employee, day, kind, instant -- rather than on
 * the day and kind alone. A day can legitimately need two `out` punches added at different times;
 * it can never need the same one twice.
 */
function undecidedAdditionOf(
  sql: SqlStorage, employeeId: EmployeeId, workDate: string, kind: PunchKind, occurredAt: number,
): number | null {
  const row = sql
    .exec<{ submission_id: number }>(
      `SELECT a.submission_id FROM amendment_requests a
       JOIN submissions s ON s.id = a.submission_id
       WHERE a.target_punch_id IS NULL
         AND s.employee_id = ? AND a.work_date = ? AND a.kind = ? AND a.occurred_at = ?
         AND s.state IN ('draft', 'pending')
       ORDER BY a.submission_id LIMIT 1`,
      employeeId, workDate, kind, occurredAt,
    )
    .toArray()[0];
  return row?.submission_id ?? null;
}

/**
 * File a request to change one punch. Returns the submission id.
 *
 * The submission is created `pending` at step 0 exactly like an overtime request, so the queue,
 * withdraw, resubmit and the approval state machine all work on it without knowing it is an
 * amendment. `minutes` is 0 and `calculation_inputs` is NULL: both belong to overtime, an
 * amendment's effect on credited minutes can be negative and is unknown until it is applied, and
 * neither column is ever read for an amendment. What the request actually asks for is the
 * companion `amendment_requests` row, written in the same call.
 *
 * ORDER OF REFUSALS. `reason` and the occurrence are checked before anything is looked up, so a
 * malformed request is refused the same way whether or not its target happens to exist. The route
 * checks come last, because they are the only ones whose answer depends on configuration a caller
 * cannot see.
 *
 * "AT MOST ONE UNDECIDED REQUEST PER PUNCH" IS APPLICATION CODE, NOT A CONSTRAINT, and that is not
 * a shortcut. It is a uniqueness rule over `amendment_requests.target_punch_id` conditioned on
 * `submissions.state`, and a partial unique index cannot span two tables. Read-then-write is safe
 * here only because both halves run inside one turn of the Durable Object's input gate: nothing
 * else touches this store between the check and the insert. Move this logic anywhere that is not
 * a single store call and the check stops meaning anything.
 *
 * Deliberately NOT checked here:
 *  - the period lock. Applying an approved amendment is the one write that may enter a closed
 *    month, and refusing to even ask would leave a locked month permanently wrong.
 *  - `isExempt`. `submitOvertime` refuses an exempt employee because there is no premium to
 *    approve; a 管理監督者's punches are still the record of when they worked and still need to be
 *    correctable. This is why `hasReachableApprover` no longer counts an exemption as "needs
 *    nobody": an exempt employee with no manager and no designated approver used to pass
 *    `assertApproverReachable` here and then strand, because no step of the seeded `any_of`
 *    manager route can be satisfied for them — `authorize` finds no org edge and no designated
 *    approver to fall back on, so every actor is refused. (`requiredApprovers` returns an empty
 *    set too, which strands an `all_of` step for the same reason; on the seeded route it is
 *    `authorize` that does the refusing.) They are now refused at filing, where an administrator
 *    can still be asked for a designated approver.
 *  - who may file for whom. `createdBy` is recorded, not authorised: authority over another
 *    employee is the session's question, and this function is handed the answer.
 *
 * KNOWN, AND TASK 6's TO CLOSE — neither is caught here, and both must be re-validated at APPLY
 * time, where one Durable Object turn can see the day as it actually stands:
 *  - CONVERGING REQUESTS. An addition of `out` at 18:00 and a correction moving an existing `out`
 *    to 18:00 both pass filing: the two uniqueness queries look at different things (one at
 *    punches, one at undecided additions) and neither can see the other. Approve both and the day
 *    ends up with two identical punches.
 *  - A TARGET SUPERSEDED OUT OF BAND. `describeCorrection` refuses a target that is already
 *    superseded, but nothing stops a direct `correctPunch` from superseding it AFTER the request
 *    is filed. The request stays queued and approvable and can never apply, because
 *    `punches_supersedes_unique` refuses the second successor.
 */
export function fileAmendment(sql: SqlStorage, input: NewAmendment): number {
  // The only account of why history differs from what was recorded, so it may not be blank; and
  // bounded like every other caller-supplied string that lands in this shared store.
  assertRequiredText("reason", input.reason, LIMITS.reason);
  assertNotFuture("occurredAt", input.occurredAt, input.now);

  const { workDate, kind } = input.targetPunchId === null
    ? describeAddition(sql, input)
    : describeCorrection(sql, input);

  // Asked at the filing instant, not against the day the punch belongs to. "Who can approve this?"
  // is a question about the org as it stands when the answer is needed; a correction to a punch
  // from three months ago is approved by whoever manages this employee today, because that is who
  // exists to approve it.
  //
  // Pinning it to the work date is what `submitOvertime` used to do, and it was wrong there for a
  // reason that bites harder here: it made a reporting line created during a day unable to approve
  // that day, permanently, and it disagreed with the roster's own readiness column. Amendments
  // reach further back than overtime ever does, so the work date is further from the org that has
  // to act on it. Same call as `submitOvertime`, same instant, deliberately.
  assertApproverReachable(sql, input.employeeId, input.now);

  // `minutes: 0` is the honest criterion, not a placeholder: an amendment has no minutes to route
  // on. A route gated on a minute threshold therefore never claims an amendment, which is right --
  // such a route exists to escalate large overtime claims, and this is not one.
  const snapshot = resolveRoute(sql, {
    department: input.department,
    employmentType: input.employmentType,
    minutes: 0,
  });
  // `createdBy` is passed, not omitted: a step pinned to the FILER can never be satisfied either,
  // because `checkMayAct` refuses them for being `created_by`. Filing on behalf of a report is
  // what makes that shape reachable, and this is the path that introduced it.
  assertSatisfiable(snapshot, input.employeeId, input.createdBy);

  const submission = sql
    .exec<{ id: number }>(
      `INSERT INTO submissions
         (employee_id, kind, requested_for, state, submitted_at, current_step,
          minutes, reason, calculation_inputs, route_snapshot, created_by)
       VALUES (?, 'amendment', ?, 'pending', ?, 0, 0, ?, NULL, ?, ?) RETURNING id`,
      input.employeeId, workDate, input.now, input.reason,
      JSON.stringify(snapshot), input.createdBy,
    )
    .one();

  sql.exec(
    `INSERT INTO amendment_requests
       (submission_id, target_punch_id, work_date, kind, occurred_at, applied_punch_id)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    submission.id, input.targetPunchId, workDate, kind, input.occurredAt,
  );

  return submission.id;
}

/** Validate a correction against the punch it names, and read the day and kind off that punch. */
function describeCorrection(
  sql: SqlStorage, input: NewCorrection,
): { workDate: string; kind: PunchKind } {
  const target = sql
    .exec<TargetPunch>(
      `SELECT p.employee_id, p.work_date, p.kind,
              EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id) AS superseded
       FROM punches p WHERE p.id = ?`,
      input.targetPunchId,
    )
    .toArray()[0];

  if (!target) {
    throw new AmendmentTargetError(`there is no punch with id ${input.targetPunchId}.`);
  }
  // A punch is named by id alone, so without this an amendment is a way to reach into another
  // person's record through a route resolved for the filer's own department.
  if (target.employee_id !== input.employeeId) {
    throw new AmendmentTargetError(
      `punch ${input.targetPunchId} does not belong to employee ${input.employeeId}.`,
    );
  }
  // A superseded punch is history. An amendment must name the row that is current, or two requests
  // filed against the same original both succeed and whichever applies last silently wins.
  if (target.superseded) {
    throw new PunchAlreadyAmendedError(input.targetPunchId);
  }

  const pending = pendingAmendmentForPunch(sql, input.targetPunchId);
  if (pending !== null) throw new DuplicateAmendmentError(pending);

  return { workDate: target.work_date, kind: target.kind };
}

/** Validate an addition against the day it would land on, and hand back what it will write. */
function describeAddition(
  sql: SqlStorage, input: NewAddition,
): { workDate: string; kind: PunchKind } {
  // Caller-supplied here, unlike a correction, so both need checking. Junk reaches no CHECK it
  // would fail usefully: `Date.parse("banana")` is NaN, and the exemption, reachability and lock
  // queries all read a work date as an opaque string.
  assertWorkDate("workDate", input.workDate);
  assertPunchKind("kind", input.kind);

  // Not caught by anything downstream. `recordPunch`'s duplicate suppression keys on a sixty-second
  // window around the CURRENT instant, and an amendment's occurrence is in the past, so applying
  // this would insert a second identical punch and the day would pair wrongly from then on.
  //
  // Superseded punches are excluded: one of those is no longer part of the day, so it cannot be
  // what the addition duplicates, and counting it would make a day unfixable after one bad
  // correction.
  const existing = sql
    .exec<{ id: number }>(
      `SELECT p.id FROM punches p
       WHERE p.employee_id = ? AND p.work_date = ? AND p.kind = ? AND p.occurred_at = ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       LIMIT 1`,
      input.employeeId, input.workDate, input.kind, input.occurredAt,
    )
    .toArray()[0];
  if (existing) throw new DuplicatePunchError(input.kind, input.workDate);

  const pending = undecidedAdditionOf(
    sql, input.employeeId, input.workDate, input.kind, input.occurredAt,
  );
  if (pending !== null) throw new DuplicateAmendmentError(pending);

  return { workDate: input.workDate, kind: input.kind };
}
