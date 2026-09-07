# Kintai admin dashboard — live verification record (Task 7, Part 1)

**Date:** 2026-09-07
**Plan:** `2026-09-04-kintai-admin-dashboard.md`, Task 7 Part 1
**Spec:** `../specs/2026-09-04-kintai-admin-dashboard-design.md`
**Code verified:** `feat/kintai-admin-dashboard` at `020312c` — 519 worker tests, 115 app tests,
`tsc --noEmit` and `typecheck:app` green before and after this run.
**Transport:** real Cap'n Web over `ws://localhost:8799/api` (`pnpm run-local --port 8799`), driven
from Node with `capnweb@0.12.0`; and the built app loaded in headless **Chrome 152.0.7977.82**
through the real Workshop page at `/gatekeepers/kintai`, driven over CDP. Nothing was stubbed and
nothing reached into the store or SQLite: every read and write below went through
`getGatekeeperApp("kintai").ui` (the admin capability the screen itself holds) or through
`PublicApi` → `AuthenticatedApi` → `Overseer` → the ambient Kintai capsule's `openSession()`.

This record follows `2026-09-01-kintai-punch-amendments-verification.md` (Task 9), and is written
against the CODE rather than the plan text. Two things that record listed as permanently
unreachable are reachable now and are verified here — see §2.

## How the session was reached (deltas from the Task 9 procedure)

```
newWebSocketRpcSession("ws://localhost:8799/api")
  → createAccount(name, name, argon2idHash) / login(name, hash) → authenticate(token)
  → provisionAmbientAccount("kintai")        # required for the ADMIN account too, not just workers
  → getGatekeeperApp("kintai").ui            # AdminKintaiApi when ADMINS names the user
  → newGadget() → getGatekeeperById(i).describe().url === "kintai://attendance" → openSession()
```

Four things this run had to discover that Task 9's record does not mention:

1. **`provisionAmbientAccount("kintai")` is needed before `getGatekeeperApp("kintai")`, for the
   administrator as well.** Without it the call returns `null` — the ambient mode defaults to
   `optional`, and `listProvidedAccounts` only provisions *auto*-provisioned accounts. Task 9 only
   documents the opt-in for the worker sessions.
2. **The dev stack auto-logs-in as `dev`** (`VITE_DEV_AUTO_LOGIN` in `main.tsx`), who is not in
   `ADMINS`, so a browser that just loads the page gets `ViewerKintaiApi` and a screen that refuses
   everything. The browser runs below set `localStorage.authToken` to the probe admin's own
   `username:token` (obtained over RPC) and reloaded.
3. **The onboarding wizard blocks every route** until `completeOnboarding()` has been called, so a
   freshly created probe account cannot reach `/gatekeepers/kintai` in a browser at all. Called
   over RPC for all four probe accounts.
4. **The app's iframe is an out-of-process target.** `srcDoc` + `sandbox="allow-scripts
   allow-modals"` gives it an opaque origin AND its own CDP session, so `Runtime.evaluate` against
   the page session cannot see it. `Target.setAutoAttach({flatten:true})` and evaluating against
   the child session's context (`origin: "://"`) is what reaches the app.

## Probe fixtures created (added to the owner's `.wrangler/state`; nothing was removed)

| Workshop user | Kintai employee | id | Notes |
| --- | --- | --- | --- |
| `probe7admin` | `PROBE7-A1` Probe7 Admin | 6 | temporarily added to `config.vars.ADMINS` in `scripts/run-dev-server.ts`, **reverted** |
| `probe7w1` | `PROBE7-W1` Probe7 Worker One | 7 | managers 8 then 6; designated approver 8 |
| `probe7m1` | `PROBE7-M1` Probe7 Manager One | 8 | no manager, no designated approver |
| `probe7w2` | `PROBE7-W2` Probe7 Worker Two | 9 | manager 8, then 6 added as the repair |

The owner's own employees (`E-01`, `A-02`) and the Task 9 probes (`PROBE-W1/M1/F1`, ids 3–5) were
never written to. Their rows appear in reads below because the dashboard is company-wide, which is
the point of it.

---

## 1. The repair loop, end to end (the fix wave's I1) — PASS

### 1a. The brief's construction is not possible, and that is the code being right

The brief asked for "a PROBE7 worker with NO approver" who then files something. **A worker with no
approver cannot file anything at all** — `fileAmendment` calls `assertApproverReachable`:

```
PROBE7-W1 (managerIds: [], designated: null, approverReachable: false)
w1.requestMissingPunch("2025-07-10", "in", 08:00 JST, "…")
  → KINTAI_NO_APPROVER: employee 7 has no manager and no designated approver, so nobody could
    approve anything they file -- a punch correction included, which a 管理監督者 exemption does
    not excuse them from needing. Ask an administrator to set a reporting line, or a designated
    approver if they report to nobody.
```

So a submission cannot be *born* stranded. `store/overview.ts`'s own comment names the two ways one
can *become* stranded — "filed by its only possible approver, or left behind by an org change that
closed the last edge reaching it" — and the second is **also not constructible live**: nothing on
`KintaiAdminApi` writes `org_edges.valid_to`, so edges are add-only from every surface. The
filed-by-only-approver case is therefore the one live construction, and it is what was driven.

### 1b. A designated approver may DECIDE but may not FILE on behalf — a finding

Setting a designated approver alone does not open the on-behalf filing path:

```
setDesignatedApprover(7, 8)   → PROBE7-W1: designated 8, approverReachable true
m1.requestMissingPunchFor(7, "2025-07-10", "in", 08:00 JST, "…")
  → KINTAI_NOT_AUTHORIZED: you are not an approver for this step.
```

Correct behaviour — `#assertMayFileFor` gates on `hasAuthorityOver`, which reads `org_edges` only,
and `authorize`'s designated-approver fallback is deliberately gated on the employee having no live
reporting line. **The wording is wrong for this path, though:** nobody is deciding a step here, and
a manager told "you are not an approver for this step" while trying to *file* has been handed a
sentence about a queue they were not looking at. `NotAuthorizedError` is reused verbatim by
`kintai.ts:1092` (filing) and by `submissions.ts`'s `authorize` (deciding). Same class of nit as
Task 9 §2's verb.

### 1c. Stranded, through the admin capability the screen holds

`setReportingLine(7, 8)` made PROBE7-M1 the worker's **only** manager, then that manager filed for
them:

```
m1.requestMissingPunchFor(7, "2025-07-10", "in", 08:00 JST,
  "Probe7: crew lead filing the worker's missed tap-in.")   → 14
```

`ui.listPendingOverview()` — the real `AdminKintaiApi`, verbatim:

```json
{ "id": 14, "employee_id": 7, "kind": "amendment", "requested_for": "2025-07-10",
  "state": "pending", "submitted_at": 1788743367692, "current_step": 0, "minutes": 0,
  "reason": "Probe7: crew lead filing the worker's missed tap-in.",
  "calculation_inputs": null,
  "route_snapshot": "{\"routeId\":1,\"steps\":[{\"stepIndex\":0,\"rule\":\"any_of\",\"approverKind\":\"manager\",\"approverEmployeeId\":null}]}",
  "created_by": 8,
  "amendment": { "targetPunchId": null, "currentOccurredAt": null,
                 "requestedOccurredAt": 1752102000000, "workDate": "2025-07-10",
                 "kind": "in", "lockedPeriod": null },
  "employeeName": "Probe7 Worker One", "employeeNumber": "PROBE7-W1",
  "filedByName": "Probe7 Manager One", "waitingMs": 4,
  "eligibleActorIds": [], "eligibleActorNames": [] }
```

`eligibleActorIds: []` — **the stranded shape, reported and not filtered**, which is the promise
that whole function exists for. And it really is invisible everywhere else:

```
m1.listPendingApprovals()  → []            (the filer's own queue hides it)
w1.listPendingApprovals()  → []            (the subject may not decide it)
w1.listMySubmissions()     → [[14,"pending"]]   (visible, undecidable)
m1.actOnSubmission(14,"approve") → KINTAI_FILED_BY_APPROVER: you filed this request, and nobody
   may decide a request they filed themselves. Someone else in its approval route must decide it.
w1.actOnSubmission(14,"approve") → KINTAI_SELF_APPROVAL: you cannot approve your own submission.
```

### 1d. The repair, and a fresh read that names the decider

```
ui.setReportingLine(7, 6)          # Probe7 Admin becomes a SECOND manager
ui.listPendingOverview()           # fresh call, same capability
  → row 14: "eligibleActorIds": [6], "eligibleActorNames": ["Probe7 Admin"]
     (roster row for 7 now: managerIds [8, 6])
```

Everything else on the row is byte-identical to the stranded read. The data path repairs.

### 1e. The React re-read half, live in the browser (bonus — the brief called this jsdom-only)

Driven in the real iframe on submission 18 (`PROBE7-W2`, whose only manager filed for them), with
**no page reload** between the two reads:

| | 要対応 section 1 |
| --- | --- |
| before | `3 requests · 1 with nobody able to decide` — `[data-testid="stranded"]`: *"Nobody can decide this — it will wait for ever. Give Probe7 Worker Two a manager or a designated approver on the Roster tab, or look at who filed it: whoever files a request can never be the one who decides it."* |
| repair | Roster tab → `set-reporting-line` form (employee 9, manager 6) → submit. Notice, verbatim: `Probe7 Worker Two now reports to Probe7 Admin.` |
| after | `3 requests` — no stranded count, `[data-testid="stranded"]` gone, and the row now reads `Can be decided by Probe7 Admin` |

`invalidateQueue()` after a roster repair works over the real capability, in a real browser.

---

## 2. A close sets the marker — PASS, and it closes the hole it was built for

Driven on **2025-07**, chosen because a survey of every month from 2025-04 to 2026-09 found it
empty of all data — the lock is company-wide (`period_locks` is keyed on the period alone), so a
month with anybody else's punches in it was not an option.

### 2a. Setup: punches into 2025-07 through the amendment path

Submission 14 approved (via `a1.actOnSubmission` → `overseer.listActions()` →
`overseer.approveAction()`; there is still no way to skip the human confirmation), then a clock-out
filed and approved. `ui.getEmployeeDay(7, "2025-07-10")` then gave `in 08:00` / `out 17:00`, both
`source: "amendment"`, `amended_by: 6`, `anomalies: []`, `workedMinutes: 540`.

**Control, before the close:** `w1.setAllocations("2025-07-10", [{projectCode:"PROBE7-JOB",
minutes:540}])` → `{ allocatedMinutes: 540, workedMinutes: 540, discrepancyMinutes: 0 }`. It
succeeded, so the refusal below is the lock and not something else.

### 2b. The close

```
ui.lockPeriod("2025-07")   → returned in 2 ms
```

### 2c. THE HOLE THIS CLOSES — `setAllocations` now refuses. Verbatim, all three:

```
w1.setAllocations("2025-07-10", [{projectCode:"PROBE7-JOB", minutes:480, note:"probe after lock"}])
  → KINTAI_PERIOD_LOCKED: 2025-07 is closed. Submit an amendment for approval instead of editing
    the record directly.

w1.setAllocations("2025-07-10", [])            # the "clear the whole day" shape
  → KINTAI_PERIOD_LOCKED: 2025-07 is closed. Submit an amendment for approval instead of editing
    the record directly.

a1.setAllocations("2025-07-10", [{projectCode:"PROBE7-JOB", minutes:60}])   # an ADMIN's own session
  → KINTAI_PERIOD_LOCKED: 2025-07 is closed. Submit an amendment for approval instead of editing
    the record directly.
```

That is the whole justification of this feature, live. Task 9 §5 recorded `KINTAI_PERIOD_LOCKED`
as sitting in a permanently dead branch because nothing outside the worker could write a row into
`period_locks`. It fires now, from the surface HR presses, against the one write in this system
that has no approval behind it — including for the administrator who closed the month.

A second close is refused too, and names who closed it:

```
ui.lockPeriod("2025-07")
  → KINTAI_ALREADY_LOCKED: 2025-07 is already closed — employee 6 closed it on 2026-09-07 at
    10:10:09 JST. It stays closed, and this call changed nothing.
```

### 2d. The marker on the pending rows

A correction left undecided across the close. `amendment.lockedPeriod` before and after, same row,
same call:

```
before:  { "targetPunchId": 14, "currentOccurredAt": 1752134400000,
           "requestedOccurredAt": 1752138000000, "workDate": "2025-07-10",
           "kind": "out", "lockedPeriod": null }
after:   { …identical…                                    "lockedPeriod": "2025-07" }
```

`AmendmentDetail.lockedPeriod` non-null is a third thing Task 9 §5 listed as unreachable. It is a
join onto the table `lockPeriod` writes, and it flipped on the very next read.

### 2e. The report flips, and the totals still move — "closed ≠ frozen", live

```
monthlyReport("2025-07") before:  locked=false  PROBE7-W1: 1d 540m 0a
monthlyReport("2025-07") after:   locked=true   PROBE7-W1: 1d 540m 0a
```

Then the correction that had been left pending was approved **into the closed month**:

```
getEmployeeDay(7,"2025-07-10")  → id 15 out 18:00, supersedes_id 14, source amendment
monthlyReport("2025-07")        → locked=true   PROBE7-W1: 1d 600m 0a
```

540 → 600 minutes with `locked` still `true`. The badge's four sentences are literally true: the
month is closed, an approved correction is still applied, and the totals moved because of it. A
further correction (18:00 → 19:00) took it to 660m.

### 2f. The closed-period confirmation text — the fourth unreachable branch, now reachable

Task 9 §5 also listed `describeCorrectionApproval`'s closed-period half as unreachable. The OS
confirmation for a correction into `2025-07`, verbatim:

> **title:** Approve the correction to Probe7 Worker One's attendance on 2025-07-10: out punch 18:00 → 19:00, into the closed period 2025-07
>
> **Probe7 Admin** is deciding a punch correction for **Probe7 Worker One**. This is the sign-off itself, not a draft.
>
> - **Decision:** approve
> - **Employee:** Probe7 Worker One (PROBE7-W1)
> - **Work date:** 2025-07-10
> - **Punch:** out
> - **Currently recorded:** 18:00
> - **Requested time:** 19:00
>
> **The period 2025-07 is closed.** Applying this changes a month that has already been closed off, so any total already reported from it — including anything already paid — no longer matches the record. A correction is the only write allowed in.
>
> **The employee's stated reason**
>
> > Probe7: one more correction, filed into the closed month.
>
> **Probe7 Admin's comment**
>
> > Probe7: approving into a closed month.
>
> Approving advances the correction to its next approval step, or — if this is the last step — applies it immediately: a new punch is written and the one it replaces is superseded. Both rows stay in the record permanently, so the original reading remains readable.
>
> Authority is re-checked against the organisation chart at the moment this is applied, so a decision that is no longer yours to make will be refused rather than performed. So is the correction itself: if the punch has been changed by someone else in the meantime, applying this is refused rather than overwriting them. It cannot be undone automatically — punches are never edited or deleted, so reversing an applied correction means filing another one.
>
> `actionKind: {"tag":"kintai.actOnSubmission","label":"Decide a punch correction"}`

Both halves fire: the `, into the closed period 2025-07` clause on the title and the
`**The period 2025-07 is closed.**` block in the body.

---

## 3. Page-open cost with real data — PASS. Nothing near 1s.

Wall clock from Node, over the same RPC the iframe uses, against the store as it stands (9
employees, 3 pending submissions, the owner's data plus both generations of probes). Five
consecutive page opens; the spread across them was under 0.5 ms per call.

| call | ms (median of 5) |
| --- | --- |
| `getGatekeeperApp("kintai").ui` | **21–28** |
| `listPendingOverview()` | 1.7 |
| `listAnomalousDays("2026-09")` | 2.3 |
| `monthlyReport("2026-09")` | 0.7 |
| `listEmployees()` | 1.2 |
| `listReportingLines()` | 1.0 |
| the three panel reads, back-to-back | **4.6** |
| all five reads, sequential wall clock | **7.0** |
| the three panel reads issued in parallel | **3.0–4.7** |
| `getEmployeeDay(7, today)` | 0.4 (2.0 first) |

**Acquiring the capability costs 4× the three reads it is acquired for.** That 21–28 ms is the
Workshop's `listProvidedAccounts` → `startAccountAppUi` path, not Kintai's, and it is not a finding
against this branch — but it is where a page open's time actually goes, so it is recorded rather
than left implied.

### 3b. The O(pending × roster) authority probe, measured rather than assumed

`pendingOverview` asks `checkMayAct` once per (pending row × roster member). Thirty extra
submissions were filed against an open month, measured, and then withdrawn:

| pending rows | probes | `listPendingOverview()` |
| --- | --- | --- |
| 3 | ~27 | 2.1 ms |
| 10 | ~90 | 3.6 ms |
| 20 | ~180 | 6.4 ms |
| 33 | ~297 | 9.4 ms |

Clean linear, ≈ **0.03 ms per `checkMayAct` probe**. A whole page open with 33 pending was 28 ms.
Projected at HR scale — 200 employees, 50 pending — that is 10,000 probes ≈ **300 ms** for section
1 alone, which is slow but not broken; worth knowing before the roster grows, and it is exactly the
cost `store/overview.ts` says it is paying on purpose rather than caching an answer that could
disagree with `actOnSubmission`. One re-measurement at 33 pending came back at 27.1 ms and one
`listAnomalousDays` on an empty month at 18.2 ms; both are scheduling noise on a laptop
`workerd`, not a second slope.

---

## 4. Eligible-decider truthfulness — PASS, nothing surprising

Every pending submission, with who the screen says can decide it, checked against the roster by
hand:

| sub | for | filed by | eligible | correct? |
| --- | --- | --- | --- | --- |
| 18 | PROBE7-W2 (9) | Probe7 Manager One (8) | `[]`, then `[Probe7 Admin]` after the repair | yes — 8 is the filer; 6 was the only other manager once added |
| 19 | PROBE7-W1 (7) | Probe7 Worker One (7) | `[Probe7 Admin, Probe7 Manager One]` = `[6, 8]` | yes — both are live managers of 7, and neither is the subject or the filer |
| 20 | PROBE7-W1 (7), overtime | Probe7 Worker One (7) | `[6, 8]` | yes — same rule, and the row carries **no `amendment` key at all**, matching `types.txt` |

Nothing appeared that should not have. Specifically: `PROBE-M1`/`PROBE-F1` (ids 4, 5) hold approval
authority over `PROBE-W1` and over nobody else, and they appear on no PROBE7 row; `A-02` is
`exempt: true` and appears on none, which is right — `requiredApprovers` never counts an exemption
towards a step.

**The departed-employee case remains unconstructible**, as the brief expected: `employees.status`
is `active` for all nine, and there is no write path to `status` or `departed_on` on
`KintaiAdminApi` (`createEmployee` sets neither; nothing else touches them). So "an eligible actor
who has left the company" cannot be produced or refuted live. Recorded, not claimed either way.

The set is also the honest answer to a question the roster asks separately: three employees are
`approverReachable: false` — `A-02` (the owner's, exempt), `PROBE7-A1` and `PROBE7-M1` (both at the
root of the probe org with nothing above them). The 未整備 section lists exactly those three, which
is `isReady` and `hasReachableApprover` agreeing across the screen and the store.

---

## 5. The real iframe — PASS on every control

Headless Chrome 152, the real Workshop page, the real `srcDoc` +
`sandbox="allow-scripts allow-modals"` iframe (905,000 characters of `srcdoc`, no `src`), driven
over CDP against the child target's own execution context. **Zero uncaught exceptions and zero
console errors across all four browser runs.**

### 5a. `hidden` in a REAL browser — exactly one panel per tab

`hidden` is asserted on the panels themselves (not just the tabs) in jsdom by `AdminPage.test.tsx`;
what a real browser adds is that the attribute actually resolves to `display: none` under the app's
own stylesheet, and that the panel is genuinely unreachable (`offsetParent === null`,
`getBoundingClientRect().height === 0`).

| clicked | selected tab | panel-overview | panel-monthly | panel-roster | visible |
| --- | --- | --- | --- | --- | --- |
| 要対応 | `要対応` | `hidden=false display=block h=944` | `hidden=true display=none h=0` | `hidden=true display=none h=0` | **1** |
| 月次 | `月次` | `hidden=true display=none h=0` | `hidden=false display=block h=217` | `hidden=true display=none h=0` | **1** |
| Roster | `Roster` | `hidden=true display=none h=0` | `hidden=true display=none h=0` | `hidden=false display=flex h=2474` | **1** |
| 要対応 again | `要対応` | `hidden=false display=block h=944` | `none` | `none` | **1** |

`aria-selected="true"` on exactly one tab at a time, every time.

### 5b. 要対応 — three sections, and every notice the queue can carry

DOM dump, verbatim from the sandboxed frame:

```
sections: ["pending-section", "anomalies-section", "blockers-section"]
headings: ["承認待ち · waiting on a decision",
           "要確認の勤務日 · days that need a look (2026-09)",
           "未整備 · not ready to use Kintai"]
summary (section 1): "3 requests · 1 with nobody able to decide"
summary (section 2): "3 days across 3 employees"

asks:     ["2026-09-05: in added at 08:00 (none recorded)",
           "2025-07-10: break_start added at 12:00 (none recorded)",
           "1h 30m of overtime on 2026-09-07"]
filed-by: ["Filed by Probe7 Manager One.", "Filed by Probe7 Worker One.",
           "Filed by Probe7 Worker One."]
stranded: ["Nobody can decide this — it will wait for ever. Give Probe7 Worker Two a manager or a
            designated approver on the Roster tab, or look at who filed it: whoever files a
            request can never be the one who decides it."]
closed-period: ["締め済み 2025-07 — the period 2025-07 is closed. Approving this changes a month
                 that has already been closed off."]
deciders: ["Can be decided by Probe7 Admin, Probe7 Manager One",
           "Can be decided by Probe7 Admin, Probe7 Manager One"]
waiting:  ["1時間未満", "1時間未満", "1時間未満"]
flags:    ["退勤打刻なし", "退勤打刻なし", "退勤打刻なし"]
```

All three notices — stranded, closed-period, deciders — render on real rows produced by the
scenarios above. The stranded row shows the alert *instead of* a decider list, which is the
distinction that matters.

### 5c. Expanding an anomalous day (`getEmployeeDay` over the real capability)

```
before: day-detail elements = 0; buttons = ["false:Show punches" ×3]
click  [data-action="expand-day"]
after:  day-detail elements = 1; buttons = ["true:Hide punches", "false:Show punches", "false:Show punches"]
        punches:  ["16:54:19 in gadget"]
        credited: "Credited 0m"
click again
after:  day-detail elements = 0
```

One read per expand, one panel open at a time, and it collapses.

### 5d. The cross-tab repair jump — the "focus in a hidden subtree" hazard, cleared

`AdminPage.tsx` says focusing a field inside a `hidden` subtree "does nothing at all in a real
browser". Driven in a real browser:

```
before: panel-roster hidden = true;  document.activeElement = BODY
click   要対応 · 未整備 → [data-action="manager-for-this"]  ("Set manager")
after:  panel-roster hidden = false;  panel-overview hidden = true;  selected tab = ["Roster"]
        document.activeElement = SELECT  name="managerId"  label="Reports to"
        offsetParent !== null   (i.e. actually visible and actually focused)
```

The reveal-after-the-tab-switch effect is load-bearing and it works.

### 5e. The Roster tab — all five forms and all four row repairs present

```
forms: link-account            [employeeId, accountId]   → "Link account"
       set-reporting-line      [employeeId, managerId]   → "Set reporting line"
       set-designated-approver [employeeId, approverId]  → "Set approver"
       grant-exemption         [employeeId]              → "Record exemption"
       set-work-date-policy    [employeeId, policy]      → "Set policy"
       create-employee         [employeeNumber, displayName, joinedOn, department,
                                employmentType, designatedApproverId] → "Add employee"
row repairs: link-this · manager-for-this · approver-for-this · exempt-this · policy-for-this
roster-summary: "9 employees · 3 not ready to use Kintai"
```

One real write driven through a form (`set-reporting-line`, employee 9 → manager 6) — see §1e for
its notice and its effect on 要対応.

### 5f. 月次 — the picker, the badge, and the two-step close

At the current month (2026-09):

```
month-label: "2026-09"   next-month: DISABLED   prev-month: enabled
monthly-locked badge: null      close-month button: present
rows: Test Employee E-01 | 1 | 0h 0m | 1
      Admin A-02          | 1 | 0h 0m | 1
      Probe Worker One PROBE-W1 | 1 | 5h 38m | 0
      Probe7 Worker One PROBE7-W1 | 1 | 0h 0m | 1
```

Clicking the disabled → left the label on `2026-09`. **Armed and cancelled on the current month**
(deliberately never confirmed — the live month must survive this run). The confirmation, verbatim
from the DOM:

```
2026-09 を締めますか？
通常の打刻や修正は拒否されます — ordinary edits into this month stop here.
承認された修正申請は引き続き反映されます — approval is the one way in that stays open.
だから合計はまだ動きます — closing a month does not freeze these numbers.
締めを解除する方法はありません — this cannot be undone.
[2026-09 を締める]  [やめる]
```

While armed, the `close-month` button is gone (so there is one live control, not two). `やめる` →
`close-confirm` removed, `close-month` back, label unchanged. **Note: `closable` is
`period <= currentMonth`, so the CURRENT month is closable from this screen** — correct per
`assertNotFuturePeriod`, which refuses only future months, and deliberate per the spec, but it does
mean the one irreversible write is two clicks away on the live month.

Walking ← fifteen months landed on the locked 2025-07:

```
month-label: "2025-07"
monthly-locked: "締め済み · 2025-07 is closed. Ordinary edits are refused; an approved correction
                 is still applied, so these totals can still change."
close-month button: ABSENT      rows: Probe7 Worker One PROBE7-W1 | 1 | 11h 0m | 0
```

The badge names `report.data.period` and the close control is correctly withheld. One more ← to
2025-06 gave `monthly-empty`: *"2025-06 には打刻がありません — nobody clocked in this month, so
there is nothing to total."*

---

## 6. The close race, by hand — DRIVEN, and the fix holds

`35bc082` fixed a real bug: `close()` re-read the month unconditionally after awaiting
`lockPeriod`, so pressing ← mid-close could leave an OPEN month rendering 締め済み with its close
control gone. The fix is the `if (periodRef.current !== target) return;` guard.

**First attempt — not drivable by latency.** `Network.emulateNetworkConditions` with
`latency: 4000` does **not** throttle an already-open WebSocket, and `lockPeriod` on localhost
returns in ~2 ms. 120 ms after pressing confirm, the button was already back to
`"2025-05 を締める"` (not `"締めています…"`): the close had settled and there was no window to
press ← in. Throttling the transport is not a lever here.

**Second attempt — drivable, deterministically, and honestly reported as such.** The bug's
precondition is an *ordering*: the picker must move before `await api.lockPeriod(target)` resolves.
Dispatching both presses in one JS task guarantees exactly that ordering, because `close()` yields
at the await and the ← handler then runs synchronously before any continuation:

```js
p.querySelector('[data-action="confirm-close-month"]').click();  // close() suspends at the await
p.querySelector('[data-action="prev-month"]').click();           // periodRef.current = "2025-04"
```

Armed on **2025-05** (empty). Result, polled every 400 ms for 5.6 s:

```
+ 400ms label=2025-04 badge=null closeBtn=true confirm=false rows=0 empty=yes err=-
… identical through …
+5600ms label=2025-04 badge=null closeBtn=true confirm=false rows=0 empty=yes err=-
```

**PASS.** The picker sits on 2025-04; there is **no 締め済み badge over it**, its close control is
still rendered, and its empty-month notice is the correct one. And the write landed where it was
armed, not where the picker went:

```
monthlyReport("2025-04").locked === false
monthlyReport("2025-05").locked === true
```

That is the pre-fix symptom (`締め済み · <open month> is closed…` with the close control gone) not
occurring, plus the lock landing on the right month. This is a genuine live drive of the ordering —
it is **not** a human pressing two buttons 2 ms apart, and it is not a simulation either; the two
real click handlers ran against the real component in the real iframe, in the order the bug needs.

---

## Findings

Nothing contradicted the code's promises. Five things are worth someone's attention, all recorded
above and none blocking:

1. **`NotAuthorizedError` is reused for the filing path** (§1b). "you are not an approver for this
   step" is the wrong sentence for `requestMissingPunchFor`/`requestPunchCorrectionFor`, where
   nobody is deciding a step. Same family as Task 9 §2's verb-specific `KINTAI_SELF_APPROVAL`.
2. **A submission cannot be born stranded, and an org change cannot strand one either** (§1a).
   `assertApproverReachable` blocks the first; the absence of any `org_edges.valid_to` write blocks
   the second. Filed-by-only-approver is the only live construction, so
   `store/overview.ts`'s comment names two causes of which one is currently unreachable. Worth a
   line in that comment, or a `setReportingLine`-style close if the org ever needs one.
3. **Acquiring the capability costs 4× the reads it is for** (§3): 21–28 ms for
   `getGatekeeperApp("kintai").ui` against 4.6 ms for all three panel reads. Workshop-side, not
   this branch's, but it is where a page open's time is.
4. **The authority probe is linear at ≈0.03 ms per (pending × roster)** (§3b), which projects to
   ~300 ms for section 1 at 200 employees / 50 pending. Known and deliberate; now measured.
5. **The live month is two clicks from an irreversible close** (§5f). `closable` allows
   `period === currentMonth` and `assertNotFuturePeriod` permits it, so the confirmation's four
   sentences are the only thing between a mis-click and closing the month people are clocking into
   today. This run deliberately armed and cancelled there rather than confirming.

The departed-employee eligibility case (§4) could not be constructed — no surface writes
`employees.status` — so it is recorded as untested rather than as passing.

## Environment hazard found during cleanup

**The first `rm -rf dist-app && node build-app.mjs` after a `pnpm run-local` run did not reproduce
`HEAD`'s bundle**; it came back 11 bytes longer, with one extra Tailwind utility on line 37
(`.flex-grow,.grow{flex-grow:1}` where HEAD has `.grow{flex-grow:1}`). A **second**
`rm -rf dist-app && node build-app.mjs` reproduced `HEAD`'s 430,819 bytes **byte for byte**
(md5 `1a3fc2ef509aa2f1804ee4dce1a1529d`), which is what was left in the tree. So the dev server
leaves something behind that widens Tailwind's content scan for exactly one build. Anyone following
this procedure should build **twice** and compare, not once.

## State left in the owner's `.wrangler/state`

Nothing was deleted. **Three period locks were taken, and they are permanent:**

| period | locked | contents |
| --- | --- | --- |
| **2025-05** | yes | empty — locked by the §6 race drive |
| **2025-06** | yes | empty — locked by the §5f close-control drive |
| **2025-07** | yes | `PROBE7-W1` only: 1 day, 660 min, 0 flags |
| 2025-08 | no | empty (the §3b scale probes were all withdrawn) |
| 2025-12 | no | `PROBE-W1`, Task 9's data, untouched |
| 2026-09 | no | `E-01`, `A-02`, `PROBE-W1` untouched; `PROBE7-W1` added |

No 2026 month and no live month was locked. No month containing anybody else's punches was locked.

Added: four Workshop accounts (`probe7admin`, `probe7w1`, `probe7m1`, `probe7w2`), all four
onboarding-completed, one workspace each; four `PROBE7-` employees (ids 6–9) with account links;
four org edges (7→8, 7→6, 9→8, 9→6) and one designated approver (7→8). Attendance:

| employee | work date | punches left in place |
| --- | --- | --- |
| `PROBE7-W1` | 2025-07-10 | `in 08:00` (amendment), `out 19:00` (amendment, superseding 18:00 which superseded 17:00) — 11h 0m, no flags, in a **closed** month |
| `PROBE7-W1` | 2026-09-07 | `in 16:54:19` (gadget), unpaired — reads `unpaired_in`, deliberately, as the drill-down fixture |

Submissions: 14, 15, 16, 17 approved; 18, 19, 20 left **pending** on purpose (18 as the repaired
ex-stranded row, 19 as the closed-period row, 20 as the overtime control) so the owner's Part 2 pass
opens onto a queue with something in it; 21–44 withdrawn (the §3b scale probes).

Reverted before committing: `config.vars.ADMINS` in `scripts/run-dev-server.ts` back to
`["admin"]`; all 19 tracked `packages/*/wrangler.dev.jsonc`; the
`packages/gatekeeper-context/.wrangler/validate/src/*` files the dev server deletes on startup;
`src/generated/app.txt` rebuilt to its 42-line, 430,819-byte minified form identical to `HEAD`'s.
Dev server stopped, all headless Chrome instances killed, `git status` clean, and
519 worker / 115 app / `tsc --noEmit` / `typecheck:app` all green afterwards.

---

## Task 7 checkboxes

- [x] **Part 1** — everything above ran. `listPendingOverview`, `listAnomalousDays`,
  `monthlyReport`, `getEmployeeDay` and `lockPeriod` all driven over real RPC through the admin
  capability; 2025-07 closed, with (a) `setAllocations` refusing `KINTAI_PERIOD_LOCKED` recorded
  verbatim three ways in §2c, (b) a correction still applying (540 → 600 → 660 min), (c) the report
  flipping to `locked: true`; the built app loaded in the real Workshop iframe in headless Chrome,
  every tab clicked and at least one control per section driven.
- [ ] **Part 2 — the owner drives it.** Not started, and deliberately not: the hand-over is the
  owner's own pass over the screen, and it is theirs to run.
