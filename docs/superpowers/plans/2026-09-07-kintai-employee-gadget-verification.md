# Kintai employee gadget — live verification record (Task 7, Part 1)

**Date:** 2026-09-08
**Plan:** `2026-09-07-kintai-employee-gadget.md`, Task 7 Part 1
**Spec:** `../specs/2026-09-07-kintai-employee-gadget-design.md`
**Code verified:** `main` at `e67225d` plus the two commits this pass added on top — `49f1ebf`
(the final review's Minor 1 cleanup, argued in §0) and `f7335bd` (a clock pin in one test, §0b).
531 worker tests, 138 app tests, `tsc --noEmit` and `typecheck:app` green on the final tree.
**Transport:** real Cap'n Web over `ws://localhost:8799/api` (`pnpm run-local --port 8799`), driven
from Node 24 with `capnweb@0.12.0`; and the two built bundles loaded in headless
**Chrome 152.0.7977.82** through the real Workshop page at `/gatekeepers/kintai`, driven over CDP.
Nothing was stubbed and nothing reached into the store or SQLite: every read and write below went
through `getGatekeeperApp("kintai").ui` (the capability the screen itself holds — `EmployeeKintaiApi`
for a worker, `AdminKintaiApi` for the administrator) or through `PublicApi` → `AuthenticatedApi`
→ `Overseer` → the ambient Kintai capsule's `openSession()` (the agent's `KintaiSession`).

This record follows `2026-09-04-kintai-admin-dashboard-verification.md` and is written against the
CODE rather than the plan text.

## 0. The cleanup first — `49f1ebf`, and why it deletes rather than keeps

Removing `ViewerKintaiApi` on this branch means a non-admin receives the EMPLOYEE bundle and
`EmployeeKintaiApi`, so `AdminPage` is never handed a refusing capability and no TypeScript source
produces `KINTAI_ADMIN_REQUIRED`. Yet `AdminPage.tsx` still carried a whole `status: "employee"`
view reached only by reading that refusal off `listEmployees()`, `errors.ts` still rewrote the code
and exported `isAdminRequired`, and `AdminPage.test.tsx` still minted the string under a comment
calling it "verbatim from `AdminRequiredError`" — a class that no longer exists.

The brief offered two ways out: delete, or keep the code as insurance and fix the comments. **Deleted.**
The insurance argument fails on the wire, and §1 below shows it live: were the bundle/capability
pairing ever wrong and the admin bundle handed an `EmployeeKintaiApi`, `listEmployees` would fail
with capnweb's *"The RPC receiver does not implement the method "listEmployees""* — a missing method,
not `KINTAI_ADMIN_REQUIRED:` — so the defensive branch could never have caught the one misrouting it
might be imagined to guard. What it would have done instead is keep a second, stale employee screen
inside the admin bundle ("Not linked yet — give the account code above to HR…") that no non-admin
can ever reach, and keep a `describeFailure` rewrite for a string nobody emits. With the branch gone,
any roster failure lands in the existing failure state — "Couldn't load the roster." with a retry —
which is the honest outcome for a misrouted page.

What changed: `AdminPage.tsx` (View loses `employee`; `load` has two answers; `AccountCard` loses
its `admin` prop and the non-admin sentence; doc comments rewritten to say why), `errors.ts` (the
`KINTAI_ADMIN_REQUIRED` rewrite and `isAdminRequired` removed), `main.tsx` (comment), and the tests:
the account card's two tests move to the administrator — its only reader now — and the four
non-admin-view tests, the "refusal reaches a form" test, and the `isAdminRequired` suite go with the
code they exercised. **App suite 149 → 138.** Both bundles changed and were committed with it:
`app.txt` because a rendered string left it, and `employee-app.txt` because it bundles `errors.ts`.

### 0b. A surprise before anything was driven — `f7335bd`

The first app-suite run on this branch's untouched `EmployeePage.test.tsx` failed:

```
× names an unpaired_in in plain language and files a correction as a REQUEST
  expected "vi.fn()" to be called with arguments: [ '2026-09-07', 'out', …(2) ]
  -   "2026-09-07",      +   "2026-09-08",
  -   1788773400000,     +   1788859800000,
```

`TodayPanel` files against `jstWorkDate(Date.now())` and the test asserted the literal
`2026-09-07` its fixtures are built on without stubbing the clock, so **"149 green" was true only
on the day it was written.** Pinned with the `vi.spyOn(Date, "now")` the AdminPage tests already
use; the existing `afterEach` restores it. Not a production change and not caused by the cleanup;
committed alone so the cleanup diff stays about one thing.

## How the session was reached (deltas from the 2026-09-04 procedure)

```
newWebSocketRpcSession("ws://localhost:8799/api")
  → createAccount(name, name, hash) → authenticate(token)        # token is already "user:secret"
  → completeOnboarding() → provisionAmbientAccount("kintai")
  → getGatekeeperApp("kintai")           # { iframeHtml, ui } — the bundle AND the capability, by role
  → newGadget() → getGatekeeperById(0).describe().url === "kintai://attendance" → openSession()
```

Three things this run had to discover that the 2026-09-04 record does not say:

1. **The ambient Kintai capsule is gatekeeper id 0** in a fresh workspace; ids 1–6 throw
   `No such gatekeeper id`. A loop starting at 1 (which is how the earlier record reads) finds
   nothing.
2. **`Target.attachedToTarget` for the srcdoc iframe is delivered on the PARENT session** (flatten
   mode), with the child in `params.sessionId`. The child's context reports `origin: "://"` and
   `location.href === "about:srcdoc"`, which is how the app frame was located.
3. **The dev server serves the bundles UNMINIFIED**, so the `srcdoc` the browser received was
   905,255 chars (admin) / 854,230 chars (employee) against the committed 430,901 / 402,285 bytes.
   Same source, different bytes; §4 is about the committed ones.

## Probe fixtures created (added to the owner's `.wrangler/state`; nothing was removed)

| Workshop user | Kintai employee | id | Notes |
| --- | --- | --- | --- |
| `probe8admin` | `PROBE-EMP-A1` Probe8 Admin | 10 | temporarily added to `config.vars.ADMINS` in `scripts/run-dev-server.ts`, **reverted** |
| `probe8emp` | `PROBE-EMP-W1` Probe8 Worker One | 11 | manager 12; drives the browser as the worker |
| `probe8mgr` | `PROBE-EMP-M1` Probe8 Manager One | 12 | no manager; designated approver 10 |
| `probe8emp2` | `PROBE-EMP-W2` Probe8 Worker Two | 13 | manager 12; the agent-punch control |

The owner's own employees (`E-01`, `A-02`) and the earlier probes (`PROBE-*`, `PROBE7-*`, ids 3–9)
were never written to. They appear in admin reads below because the dashboard is company-wide.

---

## 1. A non-admin lands on the employee screen — PASS, both halves

### 1a. The data half: `getGatekeeperApp("kintai")`, per role, verbatim

Each account, right after `provisionAmbientAccount("kintai")` and before any employee record existed:

```
probe8admin  bundle: {"length":905255,"hasAdminTabs":true, "hasEmployeeToday":false,"hasClaimsNote":false,"hasAccountCard":true}
             ui.whoAmI()          → {"accountId":"28dc5b56-…","linked":false,"employeeId":null}
             ui.listEmployees()   → 9 rows
             ui.myMonth("2026-09") → THROWS: The RPC receiver does not implement the method "myMonth".

probe8emp    bundle: {"length":854230,"hasAdminTabs":false,"hasEmployeeToday":true, "hasClaimsNote":true, "hasAccountCard":false}
             ui.whoAmI()          → {"accountId":"be4abca9-…","linked":false,"employeeId":null}
             ui.listEmployees()   → THROWS: The RPC receiver does not implement the method "listEmployees".
             ui.myMonth("2026-09") → THROWS: KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an
                                     employee record. Contact HR to be set up.
```

`probe8mgr` and `probe8emp2` matched `probe8emp` byte for byte. Three things are established:
the bundle and the capability arrive together and agree; the non-admin's capability has no
`listEmployees` **to refuse** — the failure is a missing method, which is the fact §0 rests on; and
an unlinked employee's own reads fail with the linking message, never with anything about admins.

### 1b. The browser half: the real iframe, both roles

`http://localhost:8799/gatekeepers/kintai`, `localStorage.authToken` set to the probe's own token,
the iframe `sandbox="allow-scripts allow-modals"`, no `src`, `srcdoc` only. Dumped from inside the
frame (`location.href` = `about:srcdoc`, `origin` = `null`):

| | `probe8emp` (worker) | `probe8admin` |
| --- | --- | --- |
| h1 / subtitle | `Kintai` / `Your attendance and overtime.` | `Kintai` / `Employee records, account codes and reporting lines.` |
| tabs (`*` = selected) | `["今日*","今月"]` | `["要対応*","月次","Roster"]` |
| panels | `panel-today:visible` `panel-month:hidden` — `panel-overview/monthly/roster: ABSENT` | `panel-overview:visible` `panel-monthly:hidden` `panel-roster:hidden` — `panel-today/month: ABSENT` |
| testids | `tab-today, tab-month, panel-today, today-empty, panel-month, month-label, claims-note, month-empty` | `account-id, linked, employee-id, tab-overview, …, pending-section, …, anomalies-section, …, blockers-section, …, panel-roster, roster-summary` |
| body has 要対応 / 今日の打刻 / Roster / `KINTAI_` | false / **true** / false / false | **true** / false / **true** / false |
| `form, select, textarea` count | **0** | 15 |
| buttons | `tab-today, tab-month, in, prev-month, next-month` | `copy-account-id, tab-overview, tab-monthly, tab-roster, expand-day ×3, manager-for-this, …` |
| uncaught exceptions / console errors | 0 / 0 | 0 / 0 |

The worker gets 今日/今月 and nothing else — no admin wall, no admin tabs, no forms; the
administrator's dashboard is unchanged. The original E-01 wall (a non-admin shown a refusing
dashboard) is not reachable from any role.

Not driven: what 今日 shows an **unlinked** worker in the browser. Every browser run happened after
`linkAccount`; the unlinked case was seen over RPC only (`KINTAI_ACCOUNT_NOT_LINKED`, above), which
`describeFailure` would render as *"This account is not linked to an employee record. Contact HR to
be set up."* — the code says so; this record did not watch it.

---

## 2. The shared-path proof, live — PASS

W1 pressed 出勤 in the browser (§3b); ~200 ms later W2's **agent** session ran `punch("in")`:

```
w2agent.punch('in') → {"punchId":23,"employeeId":13,"workDate":"2026-09-08"}
```

`adminUi.getEmployeeDay(...)` for both, the full stored rows:

```json
W1 (button): {"id":22,"employee_id":11,"work_date":"2026-09-08","kind":"in","occurred_at":1788827602948,
              "recorded_at":1788827602948,"source":"gadget","latitude":null,"longitude":null,"accuracy_m":null,
              "location_source":null,"matched_site_id":null,"supersedes_id":null,"amended_by":null,"amend_reason":null}
W2 (agent):  {"id":23,"employee_id":13,"work_date":"2026-09-08","kind":"in","occurred_at":1788827603157,
              "recorded_at":1788827603157,"source":"gadget", …every remaining field identical… }
```

With the four identity fields stripped (`id`, `employee_id`, `occurred_at`, `recorded_at`) the two
JSON strings are **byte-identical** (`true`), with the same key order across all 15 columns; both
carry `source: "gadget"`, both are attributed to `work_date: "2026-09-08"`, and on both
`occurred_at === recorded_at` (the server clock read once in `performPunch`). W1's own agent
session, `getDay("2026-09-08")`, sees the button punch as its own with `anomalies: ["unpaired_in"]`
— one table, one path, two doors.

---

## 3. The full employee loop — PASS, with one design fact worth knowing (3f)

All browser steps as W1 in the real iframe; all approvals as M1 over the agent session and the
Overseer's action queue (there is still no way to skip the human confirmation).

### 3a. Before anything

```
today-empty: "今日はまだ打刻がありません"   punch buttons: ["in:出勤"]   flags: null
```

### 3b. 出勤

```
click [data-punch="in"]
punches:        ["09:33:22 出勤本人打刻"]
punch buttons:  ["out:退勤","break_start:休憩開始"]        ← the control advanced
flags:          "退勤打刻なし"                             ← unpaired_in, in plain language
correction form present: true   file button disabled: true (nothing typed yet)   punch-error: null
```

`本人打刻` is the rendering of `source: "gadget"` (row 22 above). The word `gadget` did not appear.

### 3c. The gap, and filing the missing 退勤 from 今日

A punch may not be in the future (`KINTAI_FUTURE_OCCURRENCE`), so the out was filed for the next
whole minute after the in — `09:34` — once the clock had passed it (a 38 s wait):

```
set correction-time → "09:34"     set correction-reason → "Probe8: 退勤の打刻を忘れました"
file button disabled now: false
click [data-testid="file-correction"]
correction-notice: "申請しました・承認待ち"     class: "… text-kumo-success"
punches after filing (unchanged — a REQUEST): ["09:33:22 出勤本人打刻"]
flags after filing: "退勤打刻なし"
```

### 3d. The manager's queue

```
W1 listMySubmissions → [{"id":52,"kind":"amendment","state":"pending","requested_for":"2026-09-08","created_by":11}]

M1 listPendingApprovals → [{ "id": 52, "employee_id": 11, "kind": "amendment", "requested_for": "2026-09-08",
  "state": "pending", "submitted_at": 1788827641520, "current_step": 0, "minutes": 0,
  "reason": "Probe8: 退勤の打刻を忘れました", "calculation_inputs": null,
  "route_snapshot": "{\"routeId\":1,\"steps\":[{\"stepIndex\":0,\"rule\":\"any_of\",\"approverKind\":\"manager\",\"approverEmployeeId\":null}]}",
  "created_by": 11,
  "amendment": { "targetPunchId": null, "currentOccurredAt": null, "requestedOccurredAt": 1788827640000,
                 "workDate": "2026-09-08", "kind": "out", "lockedPeriod": null } }]
```

`created_by: 11` — the worker, written by the capability and never defaulted, which is what keeps
the filer out of the deciders. The administrator's `listPendingOverview` row for 52 added
`"filedByName":"Probe8 Worker One", "waitingMs":220, "eligibleActorIds":[12],
"eligibleActorNames":["Probe8 Manager One"]`.

### 3e. The manager approves

```
m1.actOnSubmission(52, "approve", "Probe8: approving the missed clock-out.")
m1.overseer.listActions(): 2 total, 1 pending
  pending action #1: title = "Approve the correction to Probe8 Worker One's attendance on 2026-09-08:
                              out punch added at 09:34 (none recorded)"
                     actionKind = {"tag":"kintai.actOnSubmission","label":"Decide a punch correction"}
m1.overseer.approveAction(1)

adminUi.getEmployeeDay(11, "2026-09-08") →
  22 in  09:33:22  gadget
  24 out 09:34:00  amendment  amended_by=12  amend_reason="Probe8: 退勤の打刻を忘れました"  recorded_at=1788827641772
  anomalies: []   workedMinutes: 1
M1 listPendingApprovals → []          W1 listMySubmissions → [[52,"approved"]]
```

### 3f. 今日 and 今月 reflect it — after a reload

```
before reload, punches still: ["09:33:22 出勤本人打刻"]
```

**今日 does not learn of the approval on its own.** Its reload token bumps only on the panel's own
writes (a punch, a filing), exactly as `TodayPanel`'s comment says; a decision made elsewhere lands
on the next load. After `Page.navigate` to the same route:

```
punches:       ["09:33:22 出勤本人打刻", "09:34 退勤修正 (承認: #12, 理由: Probe8: 退勤の打刻を忘れました)"]
punch buttons: ["in:出勤"]                    ← shift closed, control back to 出勤
flags: null    correction form present: false

click tab-month → panels: panel-today:hidden, panel-month:visible
month-label: "2026-09"   next disabled: true   prev disabled: false
claims-note: "残業時間は承認待ちの申請であり、承認されるまで支給額ではありません — overtime shown here is a claim awaiting approval, not a payout."
table headers: ["日付","労働時間","残業","要確認"]
month rows: [{"day":"2026-09-08","cells":["2026-09-08","0h 1m","",""]}]
```

`09:34` rather than `09:34:00` is `jstClockTime` dropping `:00` seconds by design. `0h 1m` for a
38-second shift is `workedMinutes` in `store/punches.ts:318` — `Math.round(grossMs / 60_000)` — not
this branch's arithmetic, recorded because a reader of 今月 might wonder.

---

## 4. Server-stopped rebuild determinism — PASS, and the hazard reproduced on both bundles

Two moments in this pass, both with no server on 8787 or 8799:

**Before the cleanup commit (no dev server had run in this checkout):** `rm -rf dist-app
dist-app-employee && node build-app.mjs` twice — `app.txt` 430,901 bytes and `employee-app.txt`
402,285 bytes, **identical across the two builds at once** (md5 `1640ffe7…` / `c2e472be…`), 42
minified lines each. Committed in `49f1ebf` as blobs `2187214f…` / `461f2935…` (the previous admin
blob `a75996b3…` is superseded on purpose — §0 removed a rendered string).

**After the dev server had run:** the first rebuild came back **11 bytes longer on BOTH bundles**
— 430,912 / 402,296 — each differing from the second build at line 37 (`cmp: … differ: char
319748, line 37` and `char 291132, line 37`), which is the Tailwind utility the 2026-09-04 record
found. The second rebuild reproduced the committed blobs byte for byte:

```
blobs now:     2187214f244585a0b56dda30e7ed1b722e293fc2   461f2935480b12887586b06ff3bbab9fad1771f2
blobs at HEAD: 2187214f244585a0b56dda30e7ed1b722e293fc2   461f2935480b12887586b06ff3bbab9fad1771f2
```

So the earlier record's "build twice" holds, and now applies to two files: whatever the dev server
leaves behind widens Tailwind's content scan for exactly one build of each entry.

---

## 5. The `#id` approver label on a real corrected punch — PASS where constructible

**今日** (§3f): `09:34 退勤修正 (承認: #12, 理由: Probe8: 退勤の打刻を忘れました)` — `amended_by`
is the approver (M1, id 12), not the filer; the reason is the worker's own sentence; no `#id`
resolver exists on this screen and the comment in `TodayPanel` says why. Neither `amendment` nor
`gadget` reached the DOM.

**The admin drill-down.** To put W1's day back into 要確認 the worker pressed 出勤 once more
(`punches: [… , "09:35:32 出勤本人打刻"]`, `flags: "退勤打刻なし"`, buttons back to 退勤/休憩開始).
Then as the administrator, `[data-day="11:2026-09-08"] [data-action="expand-day"]`:

```
anomalies summary: "5 days across 5 employees"
W1 group label:    "Probe8 Worker One · PROBE-EMP-W1 …"
button: "Show punches expanded=false"  → click →  "Hide punches expanded=true"
day-detail punches: ["09:33:22 in本人打刻",
                     "09:34 out修正 (承認: #12, 理由: Probe8: 退勤の打刻を忘れました)",
                     "09:35:32 in本人打刻"]
day-detail full text: "… Credited 1m"
contains '#12': true | raw 'amendment': false | raw 'gadget': false | 本人打刻: true
```

Same sentence on both screens from the one `describePunchSource`. The drill-down still prints the
raw kind (`in`/`out`) where 今日 prints 出勤/退勤 — pre-existing admin wording, outside this branch.
W2's agent punch, expanded the same way: `["09:33:23 in本人打刻"]`. Two day details can be open at
once (W1's and W2's) — the code never claimed otherwise.

**The null case is not constructible live.** An approval always writes `amended_by`, and
`assertRequiredText("reason", …)` refuses an empty reason at filing, so `amended_by: null` /
`amend_reason: null` on an `amendment` row (`不明` / `理由未記載`) cannot be produced through any
surface. It is jsdom-only (`PunchSource.test.tsx`), and recorded as such rather than as passing.

---

## 6. 今月 renders claims, not payouts — PASS

W1's agent session filed `submitOvertime("2026-09-08", 90, "Probe8: 月末の締め作業") → 53`
(pending; `M1 listPendingApprovals → [{ id: 53, kind: "overtime", minutes: 90 }]`). An OT-less day
was built the only way into a past day — two amendments on `2026-09-01` (in 09:00 → 54, out 18:00 →
55), both approved by M1 through the Overseer (`"… in punch added at 09:00 (none recorded)"`, `"…
out punch added at 18:00 (none recorded)"`):

```
W1 myMonth("2026-09") via the employee capability →
  {"period":"2026-09","days":[
    {"workDate":"2026-09-01","workedMinutes":540,"anomalies":[],"overtime":null},
    {"workDate":"2026-09-08","workedMinutes":1,  "anomalies":[],"overtime":{"minutes":90,"state":"pending"}}]}
```

In the browser, ← to `2026-08` (`"2026-08 には打刻がありません。"`) and → back so the panel
re-read the month:

```
month rows: [{"day":"2026-09-01","cells":["2026-09-01","9h 0m","",""]},
             {"day":"2026-09-08","cells":["2026-09-08","0h 1m","1h 30m · 承認待ち",""]}]
overtime cells (raw): [{"day":"2026-09-01","overtime":"","overtimeChildren":0},
                       {"day":"2026-09-08","overtime":"1h 30m · 承認待ち","overtimeChildren":1}]
body contains '0h 0m' in an overtime cell: false
```

The OT-less day's 残業 cell is **empty** — no text, zero child nodes — never a zero; the pending
claim reads `1h 30m · 承認待ち` under the standing claims-note. Nothing on the screen calls 90
minutes a payout.

---

## Findings

Nothing contradicted the code's promises. Worth someone's attention, none blocking:

1. **今日 does not learn of an approval until the next load** (§3f). By design — the reload token
   is bumped only by the panel's own writes — but an employee watching the screen while their
   manager approves sees the request stay `承認待ち` until they reload. A "re-read" affordance, or
   re-reading when the tab regains focus, is a later decision; recorded so it is a decision.
2. **A clock-dependent test shipped green for exactly one day** (§0b, fixed in `f7335bd`).
3. **The +11-byte first build after a dev-server run now hits both bundles** (§4). Anyone following
   this procedure builds twice per entry, not once.
4. **The live wire error for a non-admin calling an admin method is a missing method**, not a
   refusal (§1a) — the reason §0 deleted the scaffolding rather than fixing its comments.
5. **The ambient capsule is gatekeeper id 0** (deltas). The 2026-09-04 record's loop, as written,
   would miss it.
6. `workedMinutes` rounds to the nearest minute (`Math.round`), so a 38-second shift is credited
   `0h 1m` (§3f). Store arithmetic, not this branch's; the employee's own screen makes it visible.
7. The admin drill-down prints the raw punch kind (`in`/`out`) where 今日 prints 出勤/退勤 (§5).
   Same `ANOMALY_LABELS`-style copy problem the two screens' flag maps have; a shared module is the
   eventual home the code already names.

Not driven, recorded as untested rather than passing: the unlinked worker's 今日 in a browser (§1b);
the `amended_by: null` label (§5).

## State left in the owner's `.wrangler/state`

Nothing was deleted and **no period was locked**; `monthlyReport("2026-09").locked === false`.

Added: four Workshop accounts (`probe8admin`, `probe8emp`, `probe8mgr`, `probe8emp2`), all
onboarding-completed; six "Untitled Workspace" gadgets across them (each `agentSession` opened one);
four `PROBE-EMP-` employees (ids 10–13) with account links; two org edges (11→12, 13→12) and one
designated approver (12→10). Attendance:

| employee | work date | punches left in place |
| --- | --- | --- |
| `PROBE-EMP-W1` (11) | 2026-09-01 | `25 in 09:00` (amendment, by 12), `26 out 18:00` (amendment, by 12) — 540 min, no flags |
| `PROBE-EMP-W1` (11) | 2026-09-08 | `22 in 09:33:22` (gadget), `24 out 09:34` (amendment, by 12), `27 in 09:35:32` (gadget) — reads `unpaired_in`, deliberately, as the drill-down fixture |
| `PROBE-EMP-W2` (13) | 2026-09-08 | `23 in 09:33:23` (gadget), unpaired — the agent-punch control |

Submissions: 52, 54, 55 approved; **53 (W1's 90-minute overtime for 2026-09-08) left pending on
purpose**, so the owner's Part 2 opens onto 今月 showing a real `承認待ち` claim and M1's queue has
one row. `monthlyReport("2026-09")` PROBE rows: W1 2 days / 541 min / 1 flagged; W2 1 day / 0 min /
1 flagged. `listPendingOverview` total: 5 rows, of which this pass contributed exactly one (53); the other
four predate it and were not read.

Reverted before committing: `config.vars.ADMINS` back to `["admin"]`; all 18 `wrangler.dev.jsonc`;
both `src/generated/*.txt` rebuilt to their committed minified blobs (§4). Dev server stopped
(8787 and 8799 free), headless Chrome killed, `git status` clean, and 531 worker / 138 app /
`tsc --noEmit` / `typecheck:app` green afterwards.

---

## Task 7 checkboxes

- [x] **Part 1** — everything above ran: the employee screen reached by a non-admin in the real
  iframe and the admin dashboard by an admin (§1); the button punch and the agent punch stored as
  one shape (§2); punch → advance → gap → file → `申請しました・承認待ち` → manager's
  `listPendingApprovals` → approve → 今日 and 今月 (§3); both bundles rebuilt server-stopped, twice,
  to the committed blobs (§4); the `#id` label on both screens (§5); claims-not-payouts on a real
  month (§6). The cleanup (§0) and the clock pin (§0b) committed separately ahead of this record.
- [ ] **Part 2 — the owner drives it.** Not started, and deliberately not: the hand-over is the
  owner's own pass over the screen, with submission 53 waiting for them.
