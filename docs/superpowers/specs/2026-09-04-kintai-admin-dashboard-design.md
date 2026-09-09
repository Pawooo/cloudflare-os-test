# Kintai admin dashboard — design

**Date:** 2026-09-04
**Status:** approved, awaiting implementation plan
**Scope:** the exceptions-first admin dashboard — new admin reads, month closing, and the tabbed
screen. The overtime engine and manager-facing views are out of scope and named at the end.

## The problem

Everything in Kintai works and almost none of it is visible. Punching, corrections, approvals and
the whole closed-month machinery run over RPC and are exercised through the agent; the only screen
is the HR org page, which cannot display a punch. An administrator has no way to see what is stuck,
no way to read a month, and no way to close one — `lockPeriod` is the fourth confirmed instance of
the implemented-but-unreachable pattern, and while it is unreachable, `setAllocations` (the one
write without approval) can silently rewrite a paid month.

## Decisions

Settled with the project owner on 2026-09-04:

| Question | Decision |
| --- | --- |
| Whose eyes | **Company-wide, Workshop admins.** The admin capability deliberately widens from "manages the org" to "reads all attendance", including punch-level days. A knowing privacy decision, recorded here and in the interface header. Managers' scoped views are later work. |
| See or act | **Amended 2026-09-09: a viewer the org chart names as a decider may approve / return / reject from the row; everyone else sees triage.** See `docs/kintai-architecture-limits.md`. Original: **Triage for approvals, act on org blockers.** Approvals show WHO can decide and how long it has waited; the admin's move is to chase that person. Admin-override deciding is rejected — it would make every route guarantee conditional. Org repairs (link, approver, exemption) keep their existing buttons. |
| Reporting before the overtime engine | **Raw hours + month closing.** Per-employee monthly minutes and anomaly counts now; premium columns when the engine lands; `lockPeriod` becomes reachable, closing the `setAllocations` hole. |
| Structure | **Exceptions-first, in tabs**: 要対応 (needs a human now) · 月次 (monthly/payroll) · Roster (the existing screen, unchanged, as the third tab). Verification and reporting are different jobs at different cadences. |

## New store reads — `src/store/overview.ts`

Four focused reads, read-only, each independently testable. Not one `dashboard()` blob: each tab
composes what it renders, and nothing returns data no tab shows.

- **`pendingOverview(sql, now)`** — every `pending` submission, with: the row's `amendment` detail
  (the existing shape, same assembler), the filer, the age (from `submitted_at`), and **who can
  currently act** — computed with `authorize`/`requiredApprovers`, the same functions the queue
  uses. Never a restatement: this package has shipped enough two-copies-of-one-rule bugs that
  "who may act" is asked of exactly one implementation, everywhere.
- **`anomalousDays(sql, period)`** — each (employee, work date) in the month whose `dayAnomalies`
  is non-empty, with the flags. Scans only days that hold punches, bounded to the named month;
  the cost is O(days-with-punches) and stated in the code.
- **`monthlyTotals(sql, period)`** — per employee: worked minutes (sum of `workedMinutes`), days
  worked, anomaly count, and whether the period is locked. Live numbers, deliberately: a closed
  month's totals can still change through an approved amendment, and the report must never imply
  otherwise (the lock badge says "closed", not "frozen").
- **`employeeDay(sql, employeeId, workDate)`** — the punches (current, via the existing readers)
  and anomalies of one employee's day, for drill-down from either tab. Punch-level admin read,
  approved explicitly by the owner.

## Admin API

Five new members. Every one on the **`KintaiAdminApi` interface**, implemented on `AdminKintaiApi`,
implemented-with-throws on `ViewerKintaiApi`, covered by the surface test's `INTERFACE_MEMBERS` /
`CALL_ARGS` / `RETURN_SHAPES`. Reads are unaudited, matching `listEmployees`; the one write is
audited.

- `listPendingOverview()`, `listAnomalousDays(period)`, `monthlyReport(period)`,
  `getEmployeeDay(employeeId, workDate)` — the four reads. `monthlyReport` carries `locked` on the
  REPORT, one period per report — not per row (amended 2026-09-07 to match the code, which reads
  it once from `periodLock`: a report names one period, so a per-row copy could only ever be the
  same value repeated or a disagreement with itself). There is no separate `isPeriodLocked`
  member, because no tab renders one.
- **`lockPeriod(period)`** — the write. Audited with before/after (`before` records that the
  period was open; `after` the lock row). Refuses a period already locked with a NEW
  `KINTAI_ALREADY_LOCKED` — `PeriodLockedError`'s message tells users to file an amendment, which
  is the wrong instruction for an admin double-clicking a button. Refuses a malformed period. **No
  unlock** — a lock is one-way today, and reopening a month is a design decision nobody has made.

**The interface header gains a paragraph** stating that the admin capability now reads all
attendance including punch-level days, that this was decided knowingly on 2026-09-04, why HR gets
it while managers still do not (managers' authority is the org chart and their surface is the
session; scoped manager views are the reporting tab's later work), and that `ViewerKintaiApi`
throwing on every member is what keeps non-admins at zero attendance reads.

`period` is `YYYY-MM`; validate shape at the boundary (`assertPeriod` in `input.ts`, following
`assertWorkDate`).

## The screen

`app/AdminPage.tsx` gains a tab bar. Existing content moves under **Roster** unchanged.

**要対応** — three sections, in triage order:

1. **Approvals waiting** — one row per pending submission: who filed, for whom, what it asks
   (overtime minutes, or the correction's `kind` + current → requested times from `amendment`),
   **who can decide it**, age, and a marker naming the closed month when `lockedPeriod` is set.
   No decide control.
2. **Anomalous days** — grouped by employee: date + flags (`unpaired_in`, `long_span`, …), each
   row expandable to the day's punches via `getEmployeeDay`.
3. **Org blockers** — the existing not-ready roster rows (no approver, unlinked), with their
   existing repair buttons, rendered here as well as on Roster. Same components, not copies.

**月次** — a month picker (default: current JST month), the per-employee table (name/number,
days, hours as `Xh Ym`, anomaly count — anomaly count links back to 要対応's section 2), a
締め済み badge when locked, and **Close this month**: a deliberately sober confirmation stating
what closing means — ordinary edits refused, corrections still possible via approval, totals may
therefore still change — then `lockPeriod`. The button renders only for unlocked periods.

Sandbox rules as everywhere in this app: explicit `onClick` + Enter-via-keydown, `type="button"`,
no form submission — the Workshop iframe has no `allow-forms` and jsdom will not tell you.

Layout beyond this is deliberately unspecified: the owner steers the running screen, and the spec
freezes behaviour, not pixels.

## Testing

- Store reads unit-tested per read; `pendingOverview`'s "who can act" pinned **against the real
  queue**, property-style: for each pending submission, the set it names is exactly the set of
  actors for whom `previewActOnSubmission` succeeds. Same shape as the queue/`checkMayAct`
  property test, same reason.
- `monthlyTotals` pinned against per-day `workedMinutes` sums; a locked and an open month in one
  read; a month that gains an approved amendment changes its total (the "closed ≠ frozen" claim).
- `lockPeriod`: triad coverage, audit row, already-locked refusal, and the end-to-end that
  yesterday's verification could not drive — lock a month through the ADMIN API, then confirm an
  ordinary punch refuses and an approved correction still applies.
- App tests per tab; the blanket every-button-is-type-button test covers new controls.
- Update `docs/kintai-architecture-limits.md`: the lock entry moves from "unreachable" to
  resolved, with the date. The routes entry SPLITS: blocking half resolved, configuration half
  open (amended 2026-09-07 — the seeded catch-all fallback means no store can be left unable to
  create a submission, but `createRoute` is still on no API and behind no form, so department
  rules, minute thresholds and multi-step escalation stay unreachable). Recording it as "moves to
  resolved" would have closed an entry that is half open, and the two halves have different
  owners.

## Out of scope

- **Premium/overtime figures** — the overtime engine (sub-project 2). The 月次 table grows
  columns then; nothing reshapes.
- **Manager-scoped views** — a foreman seeing their crew. Needs the session-side capability and
  the identity-boundary allowlist entry; explicitly later.
- **Payroll export** (CSV or otherwise) — sub-project 5, and it must face the closed-≠-frozen
  reconciliation question when it lands.
- **Unlock.**
- **Notifications** — the dashboard shows what is stuck; nothing yet pushes.
