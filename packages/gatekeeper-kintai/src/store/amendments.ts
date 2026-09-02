// A request to change one punch, and the reads that answer "what does this submission ask for?"
// and "is this punch already spoken for?".
//
// One responsibility: what a correction request IS, and what applying one does. Nothing here knows
// about RPC or sessions. It does ask `checkMayAct` who may decide a request -- the same prologue
// the approval stack uses, called rather than restated -- but it never decides who may FILE for
// whom: that is the session's question and this module is handed the answer in `createdBy`.
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
import {
  actOnSubmission, assertSatisfiable, checkMayAct, getSubmission, type ActInput,
} from "./submissions.js";
import { appendMissingPunch, correctPunch, type NewPunch } from "./punches.js";
import type { EmployeeId, PunchKind, SubmissionState } from "../types.js";

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
 * The named punch is not one this employee can amend: there is no such punch, or there is and it
 * is somebody else's.
 *
 * ONE MESSAGE FOR BOTH, and the id is the only thing in it that varies — which the caller supplied
 * and therefore already knows. It said which of the two it was until the session facet gained
 * `requestPunchCorrection`, and that made it an oracle: a punch is named by id alone, so anybody
 * who can file an amendment could walk the id space and read back exactly which punches exist in
 * the whole company's record. It was recorded rather than fixed while nothing outside this
 * package's own tests called `fileAmendment`; that condition is now gone.
 *
 * The distinction is genuinely useful to an administrator and genuinely dangerous to an employee,
 * so the fix is one message on THIS path, not a cleverer one. An admin surface that wants the
 * detail should ask its own question against `punches` rather than reading it out of a refusal
 * meant for whoever happened to call.
 *
 * The constructor takes the id and writes the whole message, rather than taking a `detail` string:
 * a caller-composed detail is how the two messages diverged in the first place, and there is now
 * exactly one throw site in `describeCorrection` for the same reason.
 */
export class AmendmentTargetError extends Error {
  readonly code = "KINTAI_AMENDMENT_TARGET";
  constructor(punchId: number) {
    super(
      `KINTAI_AMENDMENT_TARGET: punch ${punchId} is not one this employee can amend. Re-read the ` +
      `day and name a punch it shows.`,
    );
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
 * APPLY TIME: the punch this correction names was superseded after the request was filed, so the
 * correction can never be written.
 *
 * Filing refuses a target that is ALREADY superseded (`PunchAlreadyAmendedError`) and reserves a
 * target against a second undecided request (`pendingAmendmentForPunch`), but neither can stop a
 * `correctPunch` from some other surface superseding the target while the request sits in a queue.
 * Nothing re-checked it, so the request stayed approvable and could never land:
 * `punches_supersedes_unique` allows one live successor per punch, and the second attempt came
 * back as a raw `UNIQUE constraint failed` -- after the approval had been recorded. Measured; see
 * `__tests__/amendments.test.ts`.
 *
 * Its own code rather than `PunchAlreadyAmendedError`'s, because the audiences differ. That one
 * tells a FILER to name the row that is current. This one tells an APPROVER that the request in
 * front of them is unappliable through no fault of theirs, and that rejecting it is the disposal.
 */
export class AmendmentTargetSupersededError extends Error {
  readonly code = "KINTAI_AMENDMENT_TARGET_SUPERSEDED";
  constructor(punchId: number, successorId: number) {
    super(
      `KINTAI_AMENDMENT_TARGET_SUPERSEDED: punch ${punchId} was corrected by punch ` +
      `${successorId} after this request was filed, so this correction can no longer be applied. ` +
      `Reject it; a fresh correction can be filed against punch ${successorId}.`,
    );
  }
}

/**
 * APPLY TIME: writing this request would put a second identical punch on the day.
 *
 * THE CONVERGING-REQUESTS CASE, and it is not exotic. An `out` at 17:00 exists. An ADDITION of an
 * `out` at 18:00 is filed and accepted, because nothing is at 18:00. A CORRECTION moving the 17:00
 * punch to 18:00 is filed and accepted too, because its target is a different punch with no
 * request against it. Filing's two uniqueness queries are structurally blind to each other -- one
 * keys on a punch id, the other on a `(day, kind, instant)` tuple that was clean when it was
 * asked -- so approving both leaves the day carrying two `out` punches at one instant, which is
 * exactly what `DuplicatePunchError` refuses at filing time. Reproduced before this check existed.
 *
 * Nothing in the database would refuse it, and nothing should: two punches at one instant are
 * legal and have to be, because a double-tap outside the suppression window is a real record. So
 * the only place it can be caught is here, against the day as it stands in the same turn of the
 * input gate as the write.
 *
 * MATCHED ON THE EXACT INSTANT, deliberately, and the residue is caught rather than ignored. Two
 * amendments landing `out` punches a second apart both apply -- there is no window that separates
 * "two requests converged" from "the terminal was tapped twice", and guessing at one would refuse
 * real records. What makes the narrow line acceptable is that the leftover is VISIBLE: a day with
 * two clock-outs pairs wrongly, so `dayAnomalies` returns `orphan_out` and the day surfaces to a
 * human instead of quietly mis-paying. That is this package's policy everywhere else -- flag it,
 * do not guess at it (see `long_span`).
 */
export class AmendmentDuplicatesPunchError extends Error {
  readonly code = "KINTAI_AMENDMENT_DUPLICATE_PUNCH";
  constructor(kind: PunchKind, workDate: string, punchId: number) {
    super(
      `KINTAI_AMENDMENT_DUPLICATE_PUNCH: punch ${punchId} already records a ${kind} at that ` +
      `time on ${workDate}, so applying this request would record the same event twice. It was ` +
      `not there when the request was filed. Reject this request.`,
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
 * NOT CAUGHT HERE, AND CLOSED AT APPLY TIME INSTEAD, where one Durable Object turn can see the day
 * as it actually stands — see `assertStillApplicable`, and the two error classes for how each of
 * these becomes true only after a request has been accepted:
 *  - CONVERGING REQUESTS. An addition of `out` at 18:00 and a correction moving an existing `out`
 *    to 18:00 both pass filing: the two uniqueness queries look at different things (one at
 *    punches, one at undecided additions) and neither can see the other. Approve both and the day
 *    ends up with two identical punches (`AmendmentDuplicatesPunchError`).
 *  - A TARGET SUPERSEDED OUT OF BAND. `describeCorrection` refuses a target that is already
 *    superseded, but nothing stops a direct `correctPunch` from superseding it AFTER the request
 *    is filed. The request stays queued and approvable and can never apply, because
 *    `punches_supersedes_unique` refuses the second successor
 *    (`AmendmentTargetSupersededError`).
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

  // ONE CONDITION, not two, and deliberately not two arms that happen to throw the same thing:
  // "no such punch" and "somebody else's punch" must be indistinguishable to this caller (see
  // `AmendmentTargetError`), and a single test cannot drift apart the way two messages did.
  //
  // The employee check is what stops an amendment being a way to reach into another person's
  // record — a punch is named by id alone, and without this the correction would be filed against
  // their punch through a route resolved for the filer's own department.
  if (!target || target.employee_id !== input.employeeId) {
    throw new AmendmentTargetError(input.targetPunchId);
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

/**
 * What acting on an amendment answers: the submission's new state, and the punch it wrote.
 *
 * `appliedPunchId` is non-null on exactly the one decision that approved the request. Every other
 * decision -- a step advanced, a rejection, a return -- reports null, because nothing was written.
 */
export type AmendmentDecision = {
  state: SubmissionState;
  appliedPunchId: number | null;
};

/**
 * Act on an amendment, and write its punch in the SAME turn of the input gate if that decision
 * approved it.
 *
 * ONE FUNCTION, NOT A FACET MAKING TWO CALLS, and that is the whole point of it. Deciding the
 * approval and writing the punch it authorises are one fact; as two store calls they are two turns
 * of the Durable Object's input gate, with the decision made in the first and acted on in the
 * second. This package has already shipped and fixed a double-apply race of exactly that shape --
 * a claim taken after an outgoing RPC (see `KintaiGatekeeper.applyAction`). There is no `await`
 * anywhere from the recomputation of the decision to the `UPDATE` that records the link, and there
 * must never be one: an `await` reopens the gate and the guarantee becomes theatre.
 *
 * THE PERIOD LOCK IS DELIBERATELY NOT CONSULTED. This is the one write in the system allowed into
 * a closed month -- it is what `PeriodLockedError` has been pointing users at, and it is why locks
 * live in the facet rather than in the store's write functions. Neither this function nor anything
 * wrapping it may call `assertWritable`.
 *
 * THE TWO APPLY-TIME RE-VALIDATIONS RUN BEFORE ANYTHING IS WRITTEN, not after the approval. That
 * ordering is load-bearing twice over:
 *
 *  - `isDomainRefusal` in `kintai.ts` classifies any `KINTAI_`-coded error out of this path as
 *    "refused outright, nothing landed, safe to retry", and that classification is only sound
 *    while nothing after `INSERT INTO approval_events` raises one. A coded throw after the
 *    approval had been recorded would be read as a clean refusal and invite a retry of a write
 *    that DID land -- the dangerous direction, and the one that comment warns about by name.
 *  - the alternative dispositions are all worse. Recording the approval and then failing leaves a
 *    submission whose history says it was approved and whose day says otherwise. Marking it
 *    `rejected` writes a verdict the approver did not give, into an append-only table. Sending it
 *    back to `draft` fabricates a `return` nobody performed. Leaving it `pending` with nothing
 *    written is the only outcome that neither invents a decision nor claims a correction that was
 *    never applied; the approver is told what happened, and the disposal is an ordinary rejection
 *    or the employee's withdrawal. Only `approve` is guarded for that reason -- refusing every
 *    verb would leave an unappliable request in the queue with no way to clear it.
 *
 * `checkMayAct` is run first so that the re-validation, which reads the employee's day, is only
 * reached by somebody who may act on that submission at all; `actOnSubmission` then runs it again
 * for itself. Two runs of one pure read in one synchronous turn, not two implementations -- the
 * ordering rule that check's own doc comment sets out (authority before anything that names a
 * fact about the submission) applies to these refusals too. One consequence worth knowing: an
 * approval that is BOTH stale and unappliable now reports unappliable, because
 * `expectedAfterEventId` is compared inside `actOnSubmission`, after this. Both outcomes end with
 * a human deciding again, and neither writes anything.
 *
 * `amendment_requests` is the one table in this feature that is not append-only:
 * `applied_punch_id` goes from NULL to a value exactly once, here. That is a link being completed,
 * not history being rewritten, and the punch it points at is itself append-only.
 */
export function actOnAmendment(sql: SqlStorage, input: ActInput): AmendmentDecision {
  const amendment = getAmendment(sql, input.submissionId);
  if (!amendment) {
    // Not a coded error: the store routes here only for `kind = 'amendment'`, and an amendment
    // submission without its companion row is a broken invariant rather than a caller's mistake.
    throw new Error(`actOnAmendment: submission ${input.submissionId} has no amendment record`);
  }

  if (input.action === "approve" && amendment.applied_punch_id === null) {
    const { submission } = checkMayAct(sql, input);
    assertStillApplicable(sql, submission.employee_id, amendment);
  }

  // Read BEFORE `actOnSubmission`, and the ordering is the whole reason this line is here rather
  // than beside its use below. `getSubmission` throws `SubmissionNotFoundError`, whose message
  // begins `KINTAI_NOT_FOUND:` -- a coded throw, and every coded throw on this path must happen
  // before the approval event is written or `isDomainRefusal` will read a write that DID land as a
  // clean refusal and invite a retry. It is unreachable either way (the row was read microseconds
  // ago in this same turn, and nothing anywhere deletes from `submissions`), but a coded throw
  // sitting textually after the insert is the exact shape this function's contract forbids, and
  // being unreachable is a weaker guarantee than being impossible.
  const submission = getSubmission(sql, input.submissionId);

  const state = actOnSubmission(sql, input);
  if (state !== "approved") return { state, appliedPunchId: null };

  // Belt and braces. `actOnSubmission` returns "approved" exactly once -- a second decision finds
  // the submission out of `pending` -- so this is unreachable as the code stands. It is written
  // anyway because this is a payroll write and the cost of being wrong is a duplicated punch.
  if (amendment.applied_punch_id !== null) {
    return { state, appliedPunchId: amendment.applied_punch_id };
  }

  const punch: NewPunch = {
    employeeId: submission.employee_id,
    // THE WORK DATE COMES FROM THE REQUEST, and is not re-derived from `occurred_at` through
    // `workDateFor`. An amendment writes history; it does not re-run attribution. The request
    // named a day, an approver agreed to that day, and for a `shift_start` employee the day a
    // 06:00 clock-out belongs to is the previous one anyway -- re-deriving it would move the punch
    // somewhere nobody approved. For a correction the day is the target punch's own, copied at
    // filing time, and `correctPunch` refuses a mismatch against the row it supersedes.
    workDate: amendment.work_date,
    kind: amendment.kind,
    // The instant the punch should have carried, not the instant this is being written. See
    // `NewPunch.now`, and `recordedAt` below for the other half of that pair.
    now: amendment.occurred_at,
    // Not a punch anybody tapped, and the record says so.
    source: "amendment",
  };

  // `input.actorId` -- the APPROVER -- is the amender, deliberately. `amended_by` is the account
  // of whose authority admitted this row to payroll, and the approver is who is accountable for
  // the record differing from what was first recorded. Recording the filer instead would let an
  // employee stamp their own name on a punch they changed about themselves, which is the reading
  // the whole approval stack exists to make false; who ASKED is `submissions.created_by`, one join
  // away, and on a multi-person step every signature is in `approval_events`.
  //
  // `input.now` is the moment the amendment was approved and is passed as `recordedAt`, never as
  // the occurrence: "when was this correction entered?" is the fact an auditor needs about a punch
  // that appeared in a closed month.
  const punchId = amendment.target_punch_id === null
    ? appendMissingPunch(sql, punch, input.actorId, submission.reason, input.now)
    : correctPunch(
        sql, amendment.target_punch_id, punch, input.actorId, submission.reason, input.now,
      );

  sql.exec(
    // `AND applied_punch_id IS NULL` makes this a real compare-and-set rather than a write that
    // merely happens to be guarded. The JS check above already makes a second write unreachable,
    // and this costs nothing -- but the guarantee then lives in the statement itself, which is what
    // a reader auditing "can this link be overwritten?" will actually look at.
    `UPDATE amendment_requests SET applied_punch_id = ?
     WHERE submission_id = ? AND applied_punch_id IS NULL`,
    punchId, input.submissionId,
  );

  return { state, appliedPunchId: punchId };
}

/**
 * Can this approved request still be written? Read against the day as it stands, in the turn that
 * would write it.
 *
 * Neither of these can be answered at filing time, because neither is true then -- see
 * `AmendmentTargetSupersededError` and `AmendmentDuplicatesPunchError` for how each becomes true
 * while the request waits in a queue. Both throw before anything is written; see `actOnAmendment`
 * for why that is not negotiable.
 *
 * Deliberately NOT re-checked here: that the target still exists and still belongs to the employee
 * (`punches` is append-only and neither column is ever updated, so filing's answer cannot go
 * stale), that `occurred_at` is not in the future (time only moves the bound further away), and
 * that an approver is reachable (one is acting).
 */
function assertStillApplicable(
  sql: SqlStorage, employeeId: number, amendment: AmendmentRequest,
): void {
  if (amendment.target_punch_id !== null) {
    const successor = sql
      .exec<{ id: number }>(
        `SELECT id FROM punches WHERE supersedes_id = ? LIMIT 1`, amendment.target_punch_id,
      )
      .toArray()[0];
    if (successor) {
      throw new AmendmentTargetSupersededError(amendment.target_punch_id, successor.id);
    }
  }

  // `p.id IS NOT ?` rather than `<>`, because `IS NOT` is null-safe: for an addition the parameter
  // is NULL and the clause is true of every row, which is what is wanted. For a correction it
  // excludes the target itself, which is legitimately sitting at its own instant and is about to
  // be superseded by this very write.
  const clash = sql
    .exec<{ id: number }>(
      `SELECT p.id FROM punches p
       WHERE p.employee_id = ? AND p.work_date = ? AND p.kind = ? AND p.occurred_at = ?
         AND p.id IS NOT ?
         AND NOT EXISTS (SELECT 1 FROM punches s WHERE s.supersedes_id = p.id)
       LIMIT 1`,
      employeeId, amendment.work_date, amendment.kind, amendment.occurred_at,
      amendment.target_punch_id,
    )
    .toArray()[0];
  if (clash) {
    throw new AmendmentDuplicatesPunchError(amendment.kind, amendment.work_date, clash.id);
  }
}
