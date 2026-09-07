# Kintai employee gadget — design

**Date:** 2026-09-07
**Status:** approved, awaiting implementation plan
**Requirements captured:** `docs/superpowers/specs/2026-09-07-kintai-employee-gadget-capture.md`
**Scope:** the employee-facing surface (sub-project 3) — a my-day / my-month gadget for one
employee, with manual punch fallback and self-service missed-punch filing. NOT the overtime engine
(premium math stays out; the tables show what exists and grow columns when the engine lands).

## The problem

The management app is admin-only by deliberate design; an employee who opens Kintai hits
`KINTAI_ADMIN_REQUIRED`. So employees have no visual surface at all — the agent is their only way
to see or fix their attendance, and an employee's own approved overtime is visible on no screen.
The owner hit this as E-01 during the dashboard steering session. This builds the surface.

## Decisions (settled with the owner, 2026-09-07)

| Question | Decision |
| --- | --- |
| Delivery | `startAppUi` serves the employee OR the admin bundle by `context.isAdmin` — the same server-side flag that already gates the capability. One nav entry everyone already has; the E-01 wall becomes the employee screen. No second install, no client-trusted role. |
| Punch buttons | Always visible, top of 今日. The screen's primary control is the current shift state: one prominent button showing the next legal action. "Fallback" means the agent is the other path, not that the buttons hide. |
| Month table row | Per day: worked hours, any overtime request with its state, an anomaly marker. Not OT-only (a mostly-blank month reads as broken), not hours-only (splits my-hours from my-overtime). |

## Architecture

`startAppUi` (`src/kintai.ts:658`) already branches: admins get `AdminKintaiApi`, non-admins get
`ViewerKintaiApi` (implements-the-admin-interface-with-throws). The employee gadget slots in at
exactly that fork:

- Non-admins receive a **new `EmployeeKintaiApi`** in place of the throw-wall, plus a **second
  bundle** (`EMPLOYEE_APP_HTML`), both emitted from the same Vite pipeline that produces
  `APP_HTML`. `startAppUi` returns the role-appropriate `{ iframeHtml, ui }`.
- `EmployeeKintaiApi` resolves the employee from `this.ctx.props.accountId` exactly as
  `AdminKintaiApi` does — no employee-id parameter (the identity-boundary rule; the on-behalf
  methods are not on this surface).
- Its methods: `getDay`, `myMonth` (new), `punch`, `requestMissingPunch`, `requestPunchCorrection`,
  `listMySubmissions`, `withdrawSubmission`, `resubmit`. NOT `listPendingApprovals`/`actOnSubmission`
  (approval is the agent's `KintaiSession` path, needs the ApprovalQueue, and an employee does not
  approve their own record), NOT the on-behalf filing pair (manager authority).

### The sharpest implementation constraint — one punch implementation, not two

`KintaiSession.punch` (the agent's path) carries facet-level logic ABOVE the store call: the
`workDateFor` → `assertWritable` → `commitPunch` sequence with its one retry on
`KINTAI_WORK_DATE_RACED`. `EmployeeKintaiApi.punch` must reach that same sequence, not
re-implement it. The store (`KintaiStore`) already owns the atomic half (`commitPunch` recomputes
and refuses under its own gate); what needs sharing is the facet-level orchestration. The plan
decides the shape — extract the sequence into something both facets call, or have one delegate to
the other — but the review's hardest verification target is that a punch made from the employee
button and a punch made through the agent traverse identical code, including the race retry and
the period-lock check. This is the same class of risk as the wire-types duplication: two copies of
one rule that agree until they drift.

## The new read: `myMonth(period)`

`getDay(workDate)` answers one day; 今日 uses it unchanged. `myMonth(period)` is the one new
capability: the employee-scoped sibling of the admin's `monthlyTotals`. It must SHARE
`monthlyTotals`' per-day iteration (`daysWithPunches` + the per-day readers in
`src/store/overview.ts`), scoped to the one employee, not fork it. Returns per day:
`workDate`, `workedMinutes`, `anomalies`, and the day's own overtime submission state if any
(joined from `submissions`/`listMySubmissions` data, `requested`/`approved`/`pending`/`rejected`).
`period` validated by `assertPeriod` at the boundary. On the interface with the same triad
discipline the admin members follow.

## The screen — two tabs

**今日 (my-day):**
- Top: the shift-state control — one prominent button for the next legal action (出勤 when out,
  退勤 when in, 休憩開始/終了 within a shift), derived from today's current punches. Always present.
- Today's punches, each with the CORRECTED source label — `本人打刻` for `gadget`, and a corrected
  punch surfaces its `amended_by` and reason (the row already carries them), not the bare word
  `amendment`. This rendering is SHARED with the admin day-drill-down (Task 5's surface), solved
  once.
- Any anomaly in plain language (`退勤がありません`), and where a gap admits it, a
  file-a-correction control that submits `requestMissingPunch`. The screen states
  `申請しました・承認待ち` — a request, never "fixed" (the types.txt rule, now with pixels).

**今月 (my-month):**
- Month picker (default current JST month via `jstWorkDate(Date.now()).slice(0,7)`; next never past
  the current month, matching 月次's bound; prev unbounded).
- The table: per day — 労働時間 (`Xh Ym` from `myMonth`), overtime request + state, an anomaly
  marker linking to that day (or opening it in 今日). Premium yen is a column the overtime engine
  adds later; the table's shape does not change then.
- A line stating that overtime figures are claims awaiting approval, not payouts, so a pending
  number is never mistaken for money owed.

## Errors, testing, out of scope

- Every failure through `describeFailure`; the request-not-edit wording carried in; sandbox rules
  (`type="button"` + onClick, no `<form>`); empty states say what nothing means
  (`今日はまだ打刻がありません`).
- App tests per the house `AdminPage.test.tsx` fake-`ui` pattern, per tab and per control;
  `EmployeeKintaiApi` gets the interface/throws-on-admin-side triad tests; `myMonth` pinned against
  per-day `workedMinutes` sums and sharing verified against `monthlyTotals`; the punch-sharing
  constraint gets a test asserting the employee punch path hits the lock check and the race retry.
- A live pass at the end: open the app as a NON-admin in the real iframe, punch via button, file a
  missed 打刻, see it in the manager's queue, watch 今月 reflect an approved correction.
- **In scope, shared:** the corrected source-label rendering (`本人打刻` etc.) is built here and the
  admin day-drill-down switched to it in the same change — one renderer, both screens.
- **Out of scope:** premium/overtime calculation (the engine); manager-scoped views; and the other
  two admin-side steering items — the flagged-row "file on their behalf" action and the
  yours-to-decide badge — which ride whichever cycle next touches the admin dashboard. They are
  recorded in the capture; they are not this spec's.
