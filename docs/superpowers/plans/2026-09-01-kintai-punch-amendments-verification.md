# Kintai punch amendments — live verification record (Task 9)

**Date:** 2026-09-04
**Plan:** `2026-09-01-kintai-punch-amendments.md`, Task 9
**Spec:** `../specs/2026-09-01-kintai-punch-amendments-design.md`
**Code verified:** `main` at `5a3eac1` — 470 worker tests, 69 app tests, both typechecks green
**Transport:** real Cap'n Web over `ws://localhost:8799/api` (`pnpm run-local --port 8799`), driven
from Node with `capnweb@0.12.0`. Nothing was stubbed and nothing reached into the store or SQLite:
every call below went through `PublicApi` → `AuthenticatedApi` → `Overseer` → the ambient Kintai
capsule's `openSession()`, or through `getGatekeeperApp("kintai")` for the HR surface.

Verified against the CODE, not the plan text: several things landed after Task 9 was written (list
rows carrying `amendment` with `lockedPeriod`, the correction-specific approver description,
terminal refusals freeing the staged decision, the work-date cross-check), and each is covered
below.

## How the session was reached

```
newWebSocketRpcSession("ws://localhost:8799/api")
  → createAccount(name, name, hash) / login(name, hash) → authenticate(token)
  → provisionAmbientAccount("kintai")            # mode defaults to 'optional', so opt-in is required
  → getGatekeeperApp("kintai").ui                # AdminKintaiApi when ADMINS names the user
  → newGadget() → openGadget(id)                 # open() runs ensureAmbientCapsules()
  → getGatekeeperById(i).describe().url === "kintai://attendance"
  → openSession()                                # KintaiSession
```

`getGatekeeperById(i)` is scanned from 0 because nothing on `Overseer` enumerates gatekeepers —
`subscribeToWorkpieces` reports only `type: "gadget"`, and an ambient capsule is an unnamed record
bound to no gadget. That is a gap in the Workshop API, not in Kintai, but it is the one thing that
makes this procedure non-obvious.

Approvals had to go through the OS approval queue, because that is what `actOnSubmission` does:
it stages the decision in the facet's own SQLite and calls `ApprovalQueue.submitAction`, and the
punch is written only when a human confirms. In script terms: `overseer.listActions()` to read the
pending action, `overseer.approveAction(id)` to confirm it. `getAutoApprovableActions()` is empty
by design, so there is no way to skip the human step — which is the correct behaviour and is
therefore also part of what was verified.

## Probe fixtures created (added to the owner's `.wrangler/state`; nothing was removed)

| Workshop user | Kintai employee | id | Notes |
| --- | --- | --- | --- |
| `probeadmin` | — | — | temporarily added to `config.vars.ADMINS` in `scripts/run-dev-server.ts`, **reverted** |
| `probew1` | `PROBE-W1` Probe Worker One | 3 | dept `PROBE`, `calendar` policy, reports to 5 and 4 |
| `probem1` | `PROBE-M1` Probe Manager One | 4 | designated approver 5 |
| `probef1` | `PROBE-F1` Probe Foreman One | 5 | reports to 4 |

The owner's own employees (`E-01`, `A-02`) were never read into, modified, or linked against, and
no period was locked (see scenario 5 — no surface can lock one anyway).

---

## 1. The loop this feature exists for — PASS

`punch("in")` at 14:37:49 JST → `{punchId: 3, employeeId: 3, workDate: "2026-09-04"}`.
`getDay("2026-09-04")` then reported one `in` punch, `source: "gadget"`, and:

```
"anomalies": [ "unpaired_in" ]
```

Filed the forgotten clock-out for a time two seconds in the past:

```
requestMissingPunch("2026-09-04", "out", 1788500271338, "Forgot to tap out; left site at this time.")
  → 2
```

`listPendingApprovals()` as `probem1` carried the amendment detail, verbatim:

```json
{ "id": 2, "employee_id": 3, "kind": "amendment", "requested_for": "2026-09-04",
  "state": "pending", "minutes": 0, "calculation_inputs": null, "created_by": 3,
  "amendment": { "targetPunchId": null, "currentOccurredAt": null,
                 "requestedOccurredAt": 1788500271338, "workDate": "2026-09-04",
                 "kind": "out", "lockedPeriod": null } }
```

`currentOccurredAt: null`, the requested time, and `lockedPeriod: null` — exactly as promised.

`actOnSubmission(2, "approve", "Confirmed with the site foreman.")` staged one action. The OS
confirmation, verbatim:

> **title:** Approve the correction to Probe Worker One's attendance on 2026-09-04: out punch added at 14:37:51 (none recorded)
>
> **Probe Manager One** is deciding a punch correction for **Probe Worker One**. This is the sign-off itself, not a draft.
>
> - **Decision:** approve
> - **Employee:** Probe Worker One (PROBE-W1)
> - **Work date:** 2026-09-04
> - **Punch:** out
> - **Currently recorded:** nothing on this day
> - **Requested time:** 14:37:51
>
> **The employee's stated reason**
>
> > Forgot to tap out; left site at this time.
>
> **Probe Manager One's comment**
>
> > Confirmed with the site foreman.
>
> Approving advances the correction to its next approval step, or — if this is the last step — applies it immediately: a new punch is written and the one it replaces is superseded. Both rows stay in the record permanently, so the original reading remains readable.
>
> Authority is re-checked against the organisation chart at the moment this is applied, so a decision that is no longer yours to make will be refused rather than performed. So is the correction itself: if the punch has been changed by someone else in the meantime, applying this is refused rather than overwriting them. It cannot be undone automatically — punches are never edited or deleted, so reversing an applied correction means filing another one.
>
> `actionKind: {"tag":"kintai.actOnSubmission","label":"Decide a punch correction"}`

It reads as a correction throughout. **No "minutes", no "overtime", no "0m"** anywhere in title,
body or label. (For contrast, the same manager's overtime confirmation — filed as a control in
§9 below — opens "Approve Probe Worker One's 1h 30m of overtime on 2026-09-04". The two are
genuinely different texts, not one template with a substitution.)

`overseer.approveAction(2)` applied it. Afterwards `getDay("2026-09-04")`:

```json
{ "id": 4, "kind": "out", "occurred_at": 1788500271338, "recorded_at": 1788500291766,
  "source": "amendment", "supersedes_id": null, "amended_by": 4,
  "amend_reason": "Forgot to tap out; left site at this time." }
```

`anomalies: []` — `unpaired_in` gone. The day is paired, the added punch carries
`source: "amendment"`, and `amended_by` names the approver (4 = PROBE-M1), not the filer.
`listMySubmissions()` shows submission 2 `approved`. `listPendingApprovals()` for M1 returns `[]`.

### 1b. The correction arm (`targetPunchId` non-null) — PASS

Scenario 1 only exercises the *addition* arm, so the other arm was driven too:
`requestPunchCorrection(3, <08:00 JST>, "Terminal was asleep; I arrived at 08:00.")` → submission 3.
Queue row carried `currentOccurredAt: 1788500269325` (14:37:49) against
`requestedOccurredAt: 1788476400000` (08:00). Confirmation title:

> Approve the correction to Probe Worker One's attendance on 2026-09-04: in punch 14:37:49 → 08:00

with `- **Currently recorded:** 14:37:49` / `- **Requested time:** 08:00`. Applied, and the day
became:

```
id 7  in         08:00:00  source amendment  supersedes_id 3
id 5  break_start 12:00:00 source amendment
id 6  break_end   13:00:00 source amendment
id 4  out        14:37:51  source amendment
anomalies: []            (negative_gross, present before, cleared)
reconciliation: { allocatedMinutes: 0, workedMinutes: 338, discrepancyMinutes: -338 }
```

The successor (7) carries `supersedes_id: 3` and the original row 3 is gone from `getDay` but
still referenced — append-only held. And **`listMySubmissions()` for submission 3 now reports
`currentOccurredAt: 1788476400000`, i.e. 08:00** — the successor's time, read live, not the frozen
target column. That is the subtlest promise in `AmendmentDetail`'s comment and it holds over RPC.

## 2. Self-decision refused — PASS

```
W1 actOnSubmission(3, "approve")
  → KINTAI_SELF_APPROVAL: you cannot approve your own submission.
W1 actOnSubmission(3, "reject")
  → KINTAI_SELF_APPROVAL: you cannot approve your own submission.
```

Reject and return are refused too, which is right. **Nit:** the message says "approve" whichever
verb was attempted, so a worker who tried to *withdraw by rejecting* is told something slightly
off. The refusal itself is correct; only the wording is verb-specific when it should not be.

## 3. Filed-by-approver — PASS

`probef1` (employee 5, a manager of employee 3) filed for the worker:

```
F1 requestMissingPunchFor(3, "2026-09-04", "break_end", <13:00 JST>, "Crew back from lunch at 13:00.")
  → 6
```

The on-behalf read was authorized as an observation first and appears in F1's own action log,
verbatim:

```json
{ "title": "Kintai record of an employee you manage",
  "description": "File a punch correction for Probe Worker One (PROBE-W1), whose attendance record you have approval authority over in the organisation chart. This reads which punches their day holds and files a request against one of them; it changes no punch until somebody else approves it." }
```

F1's own decision attempts:

```
F1 actOnSubmission(6, "approve") → KINTAI_FILED_BY_APPROVER: you filed this request, and nobody
   may decide a request they filed themselves. Someone else in its approval route must decide it.
F1 actOnSubmission(6, "reject")  → KINTAI_FILED_BY_APPROVER: (same)
F1 actOnSubmission(6, "return")  → KINTAI_FILED_BY_APPROVER: (same)
```

F1's `listPendingApprovals()` listed submissions 3 and 4 (the worker's own requests, which F1 may
decide) and **not** submission 6. M1's queue listed all three, including 6 with
`created_by: 5`. M1 approved it — title `... break_end punch added at 13:00 (none recorded)` — and
the punch landed with `source: "amendment"`, `amended_by: 4`.

So: the filer is refused on every verb, the filer's queue hides what they filed, and a second
manager beside them can decide it. All three.

## 4. Future occurrence refused, nothing written — PASS

```
requestMissingPunch(today, "break_start", now + 3_600_000, …)
  → KINTAI_FUTURE_OCCURRENCE: occurredAt may not be in the future. Give the time the punch
    should have been made, not a time still to come.
requestPunchCorrection(3, now + 3_600_000, …)
  → KINTAI_FUTURE_OCCURRENCE: (same)
```

`listMySubmissions()` length before both calls: 2. After: 2. **UNCHANGED** — nothing was created
on either path.

## 5. The closed month — NOT DRIVABLE LIVE. This is a finding.

**There is no way to lock a period through any public surface.** `KintaiStore.lockPeriod` exists
(`src/store/periods.ts`, exposed on the store at `src/store/kintai-store.ts:425`) and has **no
caller anywhere in `src/`** — only in `__tests__`. It is on neither `KintaiSession` nor
`KintaiAdminApi`, and the HR app has no control for it. I did not reach into the store or SQLite to
force one; unreachable-live is the honest result.

The consequence is larger than "this scenario cannot be tested". Three documented behaviours are
currently in permanently-dead branches from any caller's point of view:

- `KintaiDay.locked` — `types.txt:181` tells an agent it "means the month is closed for payroll".
  It can only ever be `false`. Observed `false` on every `getDay` in this run, including 2025-12.
- `KINTAI_PERIOD_LOCKED` (`types.txt:40`) — `assertWritable` is wired into `punch()`, but nothing
  can put a period in the state that makes it fire. `PeriodLockedError`'s message tells the user to
  "submit an amendment for approval" — which is precisely the path this plan built, and which is
  now reachable while the error that points at it is not.
- `AmendmentDetail.lockedPeriod` and the whole closed-period half of
  `describeCorrectionApproval` (the title's `, into the closed period …` clause and the
  `**The period … is closed.**` warning block) are unreachable for the same reason.

What *is* reachable was verified: **`lockedPeriod` stayed `null` on every row**, including the
amendments filed against `2025-12-03` and `2025-12-04` (nine months in the past), which is the
correct answer for an open month. And the second half of the plan's scenario 5 — "an ordinary punch
to that day is still refused" — is doubly unreachable, because `punch()` takes its instant from the
server clock and cannot target a past date at all.

`__tests__/amendment-flow.test.ts:389` does cover the apply-into-a-locked-month behaviour at the
store level. The gap is that no human or agent can create the state it tests.

## 6. Duplicate guard — PASS

With submission 3 undecided against punch 3:

```
requestPunchCorrection(3, <08:05 JST>, "Second attempt.")
  → KINTAI_DUPLICATE_AMENDMENT: submission 3 already asks for this change and has not been
    decided. Withdraw it before filing another.
```

## 7. Work-date cross-check — PASS

```
requestMissingPunch("2025-12-03", "out", <10:00 JST on 2025-12-05>, …)
  → KINTAI_AMENDMENT_WORK_DATE: that time is not on 2025-12-03, so a punch filed against
    2025-12-03 cannot have happened at it. This employee's punches are dated by the JST calendar,
    so the time must fall on 2025-12-03 itself. Name the day the punch belongs to, or the time it
    should carry.
```

Control, same call with the occurrence on the day it names, succeeded — so the refusal is the
cross-check firing, not the date being rejected for some other reason.

## 8. The correction that clears a flag — PASS (the demo's money shot, live)

On `2025-12-03`, via two additions approved into place:

```
requestMissingPunch("2025-12-03", "in",  08:00 JST) → 7   → punch 8
requestMissingPunch("2025-12-03", "out", 23:00 JST) → 8   → punch 9
getDay("2025-12-03") → anomalies: [ "long_span" ]
                       reconciliation: { workedMinutes: 900, discrepancyMinutes: -900 }
```

Then the correction:

```
requestPunchCorrection(9, 17:00 JST, "23:00 was a transcription error; the crew left at 17:00.") → 9
queue row: { targetPunchId: 9, currentOccurredAt: 1764770400000 (23:00),
             requestedOccurredAt: 1764748800000 (17:00), workDate: "2025-12-03",
             kind: "out", lockedPeriod: null }
confirmation title: Approve the correction to Probe Worker One's attendance on 2025-12-03:
                    out punch 23:00 → 17:00
```

Applied:

```
id 8   in   08:00:00  source amendment
id 10  out  17:00:00  source amendment  supersedes_id 9
anomalies: []                            (long_span cleared)
reconciliation: { workedMinutes: 540, discrepancyMinutes: -540 }
```

`long_span before fix: true → after fix: false`. Fifteen flagged hours became nine credited ones
through a request a manager approved, with both punch rows still in the table.

## 9. Extra checks driven while the stack was up

### 9a. Terminal refusal frees the staged decision — PASS

The converging-requests hazard `fileAmendment`'s comment describes was reproduced end to end on
`2025-12-04`. An `out` punch at 19:00 (punch 11) existed. Two requests were filed and both passed
filing, as documented:

- addition of `out` at 18:00 → submission 11
- correction of punch 11 from 19:00 to 18:00 → submission 12

Approving the addition wrote punch 12 at 18:00. Approving the correction then failed at apply:

```
overseer.approveAction(17)
  → KINTAI_AMENDMENT_DUPLICATE_PUNCH: punch 12 already records a out at that time on 2025-12-04,
    so applying this request would record the same event twice. It was not there when the request
    was filed. Reject this request.
```

The staged row was freed: `M1 actOnSubmission(12, "reject", …)` succeeded **immediately** with no
`KINTAI_DECISION_CONFLICT`, the rejection was confirmed, and submission 12 reached `rejected`.
That is the behaviour `b3ec2ed` added, working over real RPC.

**Observed rough edge (Workshop-side, not Kintai's):** the OS action that failed to apply stays
`pending` in the workspace action log forever, and retrying `approveAction` on it reproduces the
same refusal. The way out is `overseer.rejectAction(17)`, which was verified to work and moved the
action to `rejected`. So the approver is not trapped, but they are left with a dead Approve button
next to a live one, and the refusal's own instruction ("Reject this request") is ambiguous between
rejecting the OS action and rejecting the Kintai submission. Both work; the message does not say
which it means.

### 9b. Amendment detail is absent on overtime rows — PASS

A control `submitOvertime(today, 90, …)` produced a queue row with `minutes: 90`,
`calculation_inputs: null` and **no `amendment` key at all** (`typeof row.amendment ===
"undefined"`), which is exactly what `types.txt` promises (`amendment?: AmendmentDetail`, "Present
exactly when `kind` is `'amendment'`"). Its confirmation was the overtime text quoted in §1. The
control was withdrawn afterwards.

### 9c. The admin gate holds for a non-admin over RPC — PASS

`probew1` is not in `ADMINS` (`amIAdmin() === false`). `getGatekeeperApp("kintai").ui` returned a
capability on which `whoAmI()` works (returning that user's own `accountId`, which is the point of
its being ungated) and every one of the eight admin methods refuses:

```
listEmployees / listReportingLines / createEmployee / linkAccount / setReportingLine /
setDesignatedApprover / grantExemption / setWorkDatePolicy
  → KINTAI_ADMIN_REQUIRED: <method> is available to Workshop administrators only.
    Ask an administrator to make this change.
```

## Nothing found that contradicted the code's promises

Every refusal fired with the code its class declares, every message carried its code (which is what
survives the RPC boundary), and every field of `AmendmentDetail` — including the two subtle ones,
`currentOccurredAt` reading the successor and `lockedPeriod` being about the month rather than the
request — behaved as documented. The two things worth acting on are both recorded above: the
unreachable period lock (§5) and the two wording nits (§2's verb, §9a's ambiguous "Reject this
request").

## State left in the owner's `.wrangler/state`

Nothing was deleted. Added: four Workshop accounts (`probeadmin`, `probew1`, `probem1`,
`probef1`), one workspace each for the three non-admin users, three `PROBE-` employees (ids 3, 4,
5) with their account links and org edges, and this attendance data on `PROBE-W1` only:

| Work date | Punches left in place | Submissions |
| --- | --- | --- |
| 2026-09-04 | in 08:00 (amendment, supersedes the 14:37:49 gadget punch), break_start 12:00, break_end 13:00, out 14:37:51 | 2, 3, 5, 6 approved; 13 (overtime control) withdrawn |
| 2025-12-03 | in 08:00, out 17:00 (supersedes the 23:00 row) | 7, 8, 9 approved; 4 withdrawn |
| 2025-12-04 | out 18:00 and out 19:00 — two unsuperseded clock-outs, day reads `orphan_out` | 10, 11 approved; 12 rejected |

The `2025-12-04` day is deliberately left inconsistent: it is the residue of the converging-request
reproduction in §9a, and the whole point of that scenario is that the duplicate cannot be removed
(`punches` is append-only and there is no void path — out of scope by design). It belongs to a
probe employee and touches nothing real.

No period was locked. No `wrangler.dev.jsonc`, `ADMINS` entry, or dev app bundle survived into the
commit — all reverted, `src/generated/app.txt` rebuilt to its 42-line minified form, `git status`
clean, 470 worker / 69 app / `tsc --noEmit` / `typecheck:app` all green afterwards.
