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

import type { PunchKind } from "../types.js";

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
