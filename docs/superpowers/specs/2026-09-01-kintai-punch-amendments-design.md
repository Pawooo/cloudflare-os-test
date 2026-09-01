# Kintai punch amendments — design

**Date:** 2026-09-01
**Status:** approved, awaiting implementation plan
**Scope:** mechanism only. Screens are a separate piece of work.

## The problem

`correctPunch` exists in `store/punches.ts`, is tested, and is reachable from nowhere. It has no
`KintaiSession` method, no admin method, and no caller. Two error messages in the shipped code tell
users to "submit an amendment for approval" — `PeriodLockedError` in `store/periods.ts` is the
visible one. That path does not exist. Nobody can change a punch through any surface.

Two changes made this urgent rather than merely untidy:

1. `long_span` (commit `3407e29`) flags any day reaching fourteen paired hours. A forgotten
   clock-out now produces a run of flagged, zero-credit days instead of one over-credited day.
   That is the right direction, and it generates correction work that has no outlet.
2. The overtime engine computes on these records. Numbers nobody can fix are worth little.

`correctPunch` alone does not solve it. It requires the correction to match the employee, work date
and kind of the punch it supersedes, so the only field it can change is `occurred_at`. **It cannot
express a punch that was never made** — which is exactly the forgotten clock-out.

## Decisions

Settled with the project owner before this spec was written:

| Question | Decision |
| --- | --- |
| What can be changed? | Fix an existing punch's time, and add a missing punch. Nothing is ever removed or voided. |
| Who may change a punch in an open period? | Nobody directly. Every correction is a request that needs approval, open period or closed. |
| An approved correction into a closed month? | Writes to the day it belongs to. The lock stays shut to everything else. The month's total changes after the fact and payroll re-reads it. |
| Who approves? | The same route as overtime — the employee's manager chain, the same queue. |
| Who may file? | The employee, or a manager/HR on behalf of someone in their org, recorded as filed-by-X-for-Y. |

Deliberate consequence of the third row: **a closed period's stored total is not stable.** Any
consumer that caches a month's minutes must re-read after an amendment is approved, or reconcile
the difference. Nothing caches today. This is a constraint on the payroll export, which does not
exist yet, and it must be written into that spec when it is.

## Data model

### An amendment is a submission

`submissions.kind` is `CHECK (kind IN ('overtime'))` today, left extensible for this. It gains
`'amendment'`.

This inherits machinery that has already been built, reviewed and repaired: route snapshots,
multi-person and delegated steps, `checkMayAct`, the pending queue, withdraw and resubmit, and the
atomic claim in `applyAction` that fixed a reproduced double-apply race. Reimplementing approval
for corrections would mean a second set of authority rules to keep in step with the first — this
package has twice shipped bugs from two copies of one rule drifting apart.

Overtime's columns that an amendment cannot fill honestly:

- `minutes INTEGER NOT NULL CHECK (minutes >= 0)` — an amendment's effect on credited minutes can
  be negative, and is not known until it is applied. Amendments store `0` and the column's meaning
  is documented as overtime-specific. It is not read for amendments.
- `calculation_inputs` — left NULL. It is not the amendment payload; reusing a column named for
  overtime's arithmetic would be a naming lie.

`requested_for` carries the work date, which is what it already means.

### `amendment_requests`

```sql
CREATE TABLE IF NOT EXISTS amendment_requests (
  submission_id    INTEGER PRIMARY KEY REFERENCES submissions(id),
  target_punch_id  INTEGER REFERENCES punches(id),
  work_date        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('in','out','break_start','break_end')),
  occurred_at      INTEGER NOT NULL,
  applied_punch_id INTEGER REFERENCES punches(id)
) STRICT
```

`target_punch_id` is the whole difference between the two supported cases:

- **non-NULL** — correct that punch's time. `work_date` and `kind` are copied from the target
  rather than supplied by the caller, so they cannot disagree with it; `correctPunch` independently
  enforces the same equality when the correction is written.
- **NULL** — add a punch that was never recorded. `work_date` and `kind` say what to add.

`applied_punch_id` is set when an approved request writes its punch, and is the link from a request
to its result. There is no reverse column on `punches`: a punch-to-request lookup is a query on
`applied_punch_id`, and `punches` is append-only history that should not grow columns for the
benefit of a newer table.

**One request changes one punch.** A day needing both a corrected clock-in and an added clock-out
is two requests, separately approvable and separately auditable — a manager can approve one and
reject the other. Accepted cost: two approvals for one bad day.

### `punches.source`

`CHECK (source IN ('gadget','admin','import'))` gains `'amendment'`. A punch that entered the
record through an approved correction is not a punch someone tapped, and the record should say so.

## Authority

### Filing

`requestPunchCorrection` and `requestMissingPunch` on `KintaiSession` file for the caller's own
linked employee. Filing for someone else requires an org edge from the filer to the target valid at
`now`, or Workshop admin. `submissions.created_by` records the filer; `employee_id` records whose
punch it is. Both already exist — `created_by` was added precisely so that "a fabricated submission
followed by a legitimate approval" does not leave a clean-looking trail.

### Approving

`checkMayAct` today refuses when the actor is the submission's `employee_id`. That is sufficient
while the filer and the employee are always the same person. **They are no longer.** A manager who
files a correction for their own report would otherwise be able to approve it — one person
originating and authorising a change to payroll input.

`checkMayAct` gains a second refusal: the actor must not be `created_by` either. This changes
behaviour for overtime as well, where `created_by` and `employee_id` are the same person today, so
the new rule is a no-op there and cannot regress it.

### Applying

The apply path deliberately bypasses the period lock. This is the one write in the system that may
enter a closed month, and it is why locks live in the facet rather than in the store's write
functions — `kintai.ts` already says so at three call sites.

Applying an approved amendment must, under a single Durable Object input gate: write the punch,
advance the submission, record the approval event, and write the audit row. The existing
`applyAction` claim is taken before any outgoing RPC for exactly this reason; the punch write must
sit inside the same store call rather than being a fourth round trip. A reproduced double-apply
race was caused by precisely this mistake.

## Validation

Each of these is a refusal with a distinct error code, and each needs a test:

- The target punch must exist, belong to the named employee, and **not already be superseded**. An
  amendment must name the current row, not a historical one.
- `occurred_at` must not be in the future. **This is not hygiene.** A prior review found that a
  future-dated punch is picked up as an open shift and can cause a genuine punch to be silently
  discarded by duplicate suppression. It was rated low severity solely because nothing let a human
  choose a punch time — it needed "an import path, if one lands." *This is that path.* The bound
  must be part of this work, not a follow-up.
- A punch may have at most one pending amendment. A second request against the same target is
  refused while the first is undecided.
- Adding a punch that duplicates an existing unsuperseded punch of the same kind and time is
  refused.
- `reason` is required and non-empty. It is the only account of why history differs from what was
  recorded.
- The employee must be linked, and the route must have a reachable approver — `assertApproverReachable`
  already exists and must be called on this path too. It was written for `submitOvertime` and, in an
  earlier round, was specified, tested, exposed, and then never wired into a write path.

## Session surface

New on `KintaiSession`:

- `requestPunchCorrection(punchId, occurredAt, reason)` — fix a time.
- `requestMissingPunch(workDate, kind, occurredAt, reason)` — add a punch.
- Both take an optional target employee for filing on behalf; authority as above.

Two methods rather than one with a nullable field: the surface is read by an agent through
`types.txt`, and "correct this punch" and "add a punch that is missing" are different intentions
with different validation. An agent choosing between two named methods errs less often than one
filling in a discriminating field.

Reused unchanged: `listMySubmissions`, `withdrawSubmission`, `resubmit`, `listPendingApprovals`,
`actOnSubmission`. Each must render or carry amendment detail rather than assuming overtime.

`types.txt` must describe the new methods, the new refusals, and — because an agent will be asked
"fix my clock-out" — that a correction is a request that takes effect only on approval, never
immediately.

## Testing

Beyond per-rule unit tests:

- **The whole loop over real RPC**: employee files, appears in the manager's queue, manager
  approves, `getDay` reflects it, the superseded punch is still readable, `long_span` clears.
- **A correction into a locked month** applies, and the lock still refuses an ordinary punch to the
  same day immediately afterwards.
- **The manager-files-then-approves attempt** is refused. This is the new authority rule and the
  one most likely to be quietly lost in a refactor.
- **Concurrent approvals** of one amendment produce one punch, not two.
- **A future-dated request** is refused, with an accompanying test that the hazard it prevents is
  real.
- `calendar` and `shift_start` employees both, since attribution and amendment now interact.

## Explicitly out of scope

- Screens. Daily view, anomaly list, request form, and amendment cards in the approval queue are a
  separate piece of work that depends on this one.
- Voiding a punch. A punch made in error is corrected, not removed. Revisit if double-taps outside
  the sixty-second window prove common in practice.
- Batching several corrections into one request.
- Reopening a closed period. The lock stays shut; amendments are the only way through it.
- Amending anything other than a punch. Allocations have their own path.
