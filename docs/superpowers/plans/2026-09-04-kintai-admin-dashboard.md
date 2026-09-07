# Kintai Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The exceptions-first admin dashboard — company-wide reads for Workshop admins, a reachable month close, and the three-tab screen the owner steers.

**Architecture:** Four focused read functions in a new `store/overview.ts` (never one `dashboard()` blob), surfaced through five new `KintaiAdminApi` members with the interface/implements/throws triad this package enforces, rendered as tabs in the existing `app/AdminPage.tsx`. "Who can act" is asked of `checkMayAct` — the one implementation of that rule — never restated. `lockPeriod` becomes reachable, audited, closing the known `setAllocations`-into-a-paid-month hole.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite, Cap'n Web RPC (`@validateRpc()`), React + Vite single-file app in the Workshop's sandboxed iframe, vitest (`@cloudflare/vitest-pool-workers` for worker tests, jsdom for app tests).

**Spec:** `docs/superpowers/specs/2026-09-04-kintai-admin-dashboard-design.md` — read it first; this plan argues from it.

## Global Constraints

Battle-tested in this package this week; every task inherits them.

- **`punches`, `approval_events`, `audit_log` are append-only.** No UPDATE, no DELETE, ever.
- **Admin members live on the `KintaiAdminApi` interface**, implemented on `AdminKintaiApi`, implemented-with-throws on `ViewerKintaiApi`, and added to `INTERFACE_MEMBERS`/`CALL_ARGS`/`RETURN_SHAPES` in `__tests__/admin-api.test.ts`. A method on the class but not the interface is reachable by non-admins over RPC — that defect has shipped here.
- **One rule, one implementation.** "Who may act" is `checkMayAct`; work-date arithmetic is `work-date.ts`; period arithmetic is `periods.ts`. Restating any of them is how this package's worst bugs happened.
- **The Workshop iframe has no `allow-forms`.** Every control is `type="button"` with explicit `onClick` plus Enter-via-keydown (`FormCard` carries the mechanism). jsdom does not enforce this; 46 green tests once sat over an unusable page.
- **Do not commit `src/generated/app.txt` from a dev build.** The dev server rewrites it unminified (~23k lines); production is ~42 lines via `rm -rf dist-app && node build-app.mjs` with the server stopped. A pre-commit hook refuses the dev build.
- **Do not create a git worktree** (a symlinked worktree once destroyed the checkout's dependency tree). **Commit incrementally** — machine-sleep has killed several long agents; a death should cost a step.
- **Test-store scoping:** `__tests__/approval-queue.test.ts` shares ONE store (`getByName("")`) — state, including period locks, leaks across its tests. `submissions.test.ts` / `amendments.test.ts` / new files give each test its own DO via a `seq` name.
- **A test route with no `department` silently loses to the catch-all route `applySchema` seeds** (ties on specificity, loses on id). Scope test routes to a department and name it in filings.
- **Rejection assertions:** `await expect(() => store.method(...)).rejects.toThrow(...)` — never pass the promise directly.
- **Errors carry their `KINTAI_` code as the message's first token** (codes do not survive the RPC boundary). Follow `PeriodLockedError`.
- Gates for every task: `pnpm exec vitest run` · `pnpm exec vitest run -c vitest.app.config.ts` · `pnpm exec tsc --noEmit` · `pnpm run typecheck:app` (plus `pnpm exec capnweb-validate build --out .wrangler/validate` on tasks touching RPC surfaces). Baseline entering this plan: **470 worker, 69 app** at `5ce27df`. Re-check `git log` before trusting counts.

---

## File Structure

**Created**
- `src/store/overview.ts` — the dashboard's read side: `anomalousDays`, `monthlyTotals`, `employeeDay`, `pendingOverview`. Read-only; knows nothing of RPC or React.
- `app/OverviewTab.tsx` — 要対応: approvals triage, anomalous days, org blockers.
- `app/MonthlyTab.tsx` — 月次: month picker, totals table, close-month.
- `__tests__/overview.test.ts` — store-level tests for the four reads.

**Modified**
- `src/store/submissions.ts` — export `eligibleActors` (built on `checkMayAct`).
- `src/store/kintai-store.ts` — delegates for the new reads.
- `src/store/periods.ts` — `AlreadyLockedError`.
- `src/input.ts` — `assertPeriod`.
- `src/admin-api.ts` — the five members + the widening paragraph.
- `app/AdminPage.tsx` — tab bar; existing content becomes the Roster tab, unchanged.
- `__tests__/admin-api.test.ts`, `app/AdminPage.test.tsx` — surface + tab tests.
- `docs/kintai-architecture-limits.md` — the lock entry moves to resolved (Task 6).

---

## Task 1: The three plain reads — `anomalousDays`, `monthlyTotals`, `employeeDay`

**Files:**
- Create: `packages/gatekeeper-kintai/src/store/overview.ts`, `packages/gatekeeper-kintai/__tests__/overview.test.ts`
- Modify: `packages/gatekeeper-kintai/src/store/kintai-store.ts`, `packages/gatekeeper-kintai/src/input.ts`

**Interfaces:**
- Consumes (verify signatures against the files; line numbers drift): `currentPunches(sql, employeeId, workDate)`, `workedMinutes(sql, employeeId, workDate)`, `dayAnomalies(sql, employeeId, workDate)` from `store/punches.ts`; `periodLock(sql, period)` from `store/periods.ts`; `employeeLabel(sql, employeeId)` from `store/employees.ts`.
- Produces:
  ```ts
  export type AnomalousDay = {
    employeeId: number; displayName: string; employeeNumber: string;
    workDate: string; anomalies: string[];
  };
  export function anomalousDays(sql: SqlStorage, period: string): AnomalousDay[];

  export type MonthlyTotalRow = {
    employeeId: number; displayName: string; employeeNumber: string;
    daysWorked: number; workedMinutes: number; anomalousDays: number;
  };
  export type MonthlyReport = { period: string; locked: boolean; rows: MonthlyTotalRow[] };
  export function monthlyTotals(sql: SqlStorage, period: string): MonthlyReport;

  export type EmployeeDay = {
    punches: PunchRow[]; anomalies: string[]; workedMinutes: number;
  };
  export function employeeDay(sql: SqlStorage, employeeId: EmployeeId, workDate: string): EmployeeDay;
  ```
  And in `input.ts`: `assertPeriod(label: string, value: string): void` — `YYYY-MM`, real month, following `assertWorkDate`'s shape (reject `2026-13`, `2026-1`, `banana`; a `KINTAI_INVALID_INPUT` via `InvalidInputError`).

- [ ] **Step 1: Write the failing tests**

`__tests__/overview.test.ts`, per-test DO (`overview-${seq++}`), seeding through the store's real methods (`createEmployee`, `recordPunch` — check their signatures in `kintai-store.ts` before writing):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const DAY = "2026-07-03";
const NINE = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`overview-${seq++}`);
  worker = await store.createEmployee({
    employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01",
  });
});

describe("anomalousDays", () => {
  it("lists exactly the days whose anomaly list is non-empty, with the flags", async () => {
    await store.recordPunch({ employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget" });
    // no out: unpaired_in
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-04", kind: "out", now: NINE + 86_400_000 + 8 * 3_600_000, source: "gadget" });

    const days = await store.anomalousDays("2026-07");
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      employeeId: worker, displayName: "Yamada", employeeNumber: "W1",
      workDate: DAY, anomalies: ["unpaired_in"],
    });
  });

  it("is bounded to the month it was asked about", async () => {
    await store.recordPunch({ employeeId: worker, workDate: "2026-06-30", kind: "in", now: NINE - 3 * 86_400_000, source: "gadget" });
    expect(await store.anomalousDays("2026-07")).toHaveLength(0);
  });
});

describe("monthlyTotals", () => {
  it("sums each employee's month and counts their anomalous days", async () => {
    await store.recordPunch({ employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: DAY, kind: "out", now: NINE + 8 * 3_600_000, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000, source: "gadget" });
    // day 2 unpaired

    const report = await store.monthlyTotals("2026-07");
    expect(report.period).toBe("2026-07");
    expect(report.locked).toBe(false);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      employeeId: worker, daysWorked: 2, workedMinutes: 480, anomalousDays: 1,
    });
  });

  it("carries the lock, and a total that an approved correction can still change", async () => {
    // Seed a paired day, lock the month AT STORE LEVEL (admin API reachability is Task 3),
    // then apply a correction through fileAmendment/actOnSubmission and watch the total move.
    // This is the spec's "closed ≠ frozen" pin. Setup needs a manager and a departmented route --
    // remember the catch-all trap. Assert: locked true, workedMinutes changed after apply.
  });
});

describe("employeeDay", () => {
  it("returns the current punches, the flags and the credited minutes of one day", async () => {
    await store.recordPunch({ employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget" });
    const day = await store.employeeDay(worker, DAY);
    expect(day.punches).toHaveLength(1);
    expect(day.anomalies).toEqual(["unpaired_in"]);
    expect(day.workedMinutes).toBe(0);
  });
});
```

Write the "closed ≠ frozen" test out in full — the comment above says what to assert, not what to paste. Also add `assertPeriod` tests in the existing input-validation suite (find where `assertWorkDate`'s live).

- [ ] **Step 2: Run and watch them fail** — `pnpm exec vitest run __tests__/overview.test.ts`, expect `store.anomalousDays is not a function`.

- [ ] **Step 3: Implement `store/overview.ts`**

Shape (adjust to real signatures; the doc comments are load-bearing prose in this package — explain *why*, notably: why per-day recomputation rather than a stored aggregate — anomalies and minutes derive from append-only punches, so a stored total would be a second copy of the truth):

```ts
import { currentPunches, dayAnomalies, workedMinutes, type PunchRow } from "./punches.js";
import { periodLock } from "./periods.js";
import type { EmployeeId } from "../types.js";

/** Every (employee, day) in the month that holds punches — the only days that can have state. */
function daysWithPunches(sql: SqlStorage, period: string): { employee_id: number; work_date: string }[] {
  return sql.exec<{ employee_id: number; work_date: string }>(
    `SELECT DISTINCT employee_id, work_date FROM punches
     WHERE work_date LIKE ? ORDER BY employee_id, work_date`,
    `${period}-%`,
  ).toArray();
}
```

then the three exports iterating `daysWithPunches` and delegating per-day to the existing readers, joining names once via a single employees query (not `employeeLabel` per row). `monthlyTotals.locked` = `periodLock(sql, period) !== null`.

- [ ] **Step 4: Delegate on `KintaiStore`** — three one-line async delegates beside `listRoster`, following the file's pattern.

- [ ] **Step 5: Run the file's tests, then all gates.**

- [ ] **Step 6: Commit** — `feat(kintai): the dashboard's plain reads`.

---

## Task 2: `pendingOverview`, and "who can act" asked of the one implementation

**Files:**
- Modify: `packages/gatekeeper-kintai/src/store/submissions.ts` (export `eligibleActors`), `src/store/overview.ts`, `src/store/kintai-store.ts`, `__tests__/overview.test.ts`

**Interfaces:**
- Consumes: `checkMayAct` (exported), `listRoster` or an active-employees query, `SubmissionRow` with its `amendment` detail, `SUBMISSION_LIST_*` fragments if reusable.
- Produces:
  ```ts
  // submissions.ts
  export function eligibleActors(sql: SqlStorage, submissionId: number, now: number): EmployeeId[];
  // overview.ts
  export type PendingItem = SubmissionRow & {
    employeeName: string; employeeNumber: string;
    filedByName: string | null;
    /** epoch ms it has waited, from submitted_at to `now`. */
    waitingMs: number;
    /** Who can decide it right now. Empty means STRANDED — surface loudly, never hide. */
    eligibleActorIds: EmployeeId[];
    eligibleActorNames: string[];
  };
  export function pendingOverview(sql: SqlStorage, now: number): PendingItem[];
  ```

- [ ] **Step 1: Write the failing tests.** Three at minimum, written out fully:
  - A pending overtime and a pending amendment: rows carry names, ages, and the amendment's detail (reuse the shapes `listPendingApprovals` already returns — assert `item.amendment` deep-equals the queue row's).
  - **The property test, the point of the task:** for every pending submission and every employee, `eligibleActors` contains that employee iff `previewActOnSubmission(id, employee)` succeeds. Build the same kind of labelled matrix as "the queue lists exactly what the act check accepts" (in `submissions.test.ts` — read it first) with a manager step, a pinned step, a filed-by-approver case, and a designated-approver fallback.
  - **A stranded submission** (filed by its only approver) shows `eligibleActorIds: []` — present in the output, not filtered away. The dashboard exists to surface exactly this.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement `eligibleActors` in `submissions.ts`**

```ts
/**
 * Everyone who may act on this submission right now.
 *
 * Implemented as `checkMayAct` per candidate — a probe of the one implementation, NOT a parallel
 * derivation from routes and edges. O(active employees) per submission, which is the honest price
 * of having exactly one copy of the rule; at the headcounts a single company store holds, that is
 * tens of probes over indexed reads. If it ever matters, the fix is a faster checkMayAct, not a
 * second one.
 */
export function eligibleActors(sql: SqlStorage, submissionId: number, now: number): EmployeeId[] {
  // active employees only; read the roster/employees table directly.
  // try { checkMayAct(sql, { submissionId, actorId, now }); return true }
  // catch: SelfApprovalError | FiledBySelfError | NotAuthorizedError -> false; anything else rethrows.
}
```

Enumerate the caught refusals exactly as `pendingApprovalsFor`'s filter does (read `isQueueRefusal` there and reuse or mirror it deliberately — reusing is better; say which you did and why). `InvalidTransitionError` cannot occur (the caller feeds only `pending` ids) but decide its handling consciously.

- [ ] **Step 4: Implement `pendingOverview`** in `overview.ts`: the pending rows (reuse the list query fragments from `submissions.ts` if exported, else the store's `pendingApprovalsFor`-shaped SELECT without the per-actor filter), names joined in one query, `waitingMs = now - (submitted_at ?? now)`, `eligibleActors` per row.

- [ ] **Step 5: Delegate on `KintaiStore`, run all gates, commit** — `feat(kintai): pendingOverview names who can act, from the one rule`.

---

## Task 3: `lockPeriod` reachable, and the four reads on the admin API

**Files:**
- Modify: `src/admin-api.ts`, `src/store/periods.ts`, `src/store/kintai-store.ts` (only if the lock delegate needs reshaping — check its current `lockPeriod(period, lockedBy, now)`), `src/input.ts` (if `assertPeriod` not landed in Task 1), `__tests__/admin-api.test.ts`

**Interfaces:**
- Produces on `KintaiAdminApi` (interface + `AdminKintaiApi` + throwing `ViewerKintaiApi`):
  ```ts
  listPendingOverview(): Promise<PendingItem[]>;
  listAnomalousDays(period: string): Promise<AnomalousDay[]>;
  monthlyReport(period: string): Promise<MonthlyReport>;
  getEmployeeDay(employeeId: EmployeeId, workDate: string): Promise<EmployeeDay>;
  lockPeriod(period: string): Promise<void>;
  ```
- Produces in `periods.ts`: `AlreadyLockedError`, code `KINTAI_ALREADY_LOCKED`, message naming the period, who locked it and when — an admin double-clicked a button; tell them it is already done, not to file an amendment (`PeriodLockedError`'s message is for a different audience; do not reuse it).

- [ ] **Step 1: Failing tests.** Extend `__tests__/admin-api.test.ts`: the five members into `INTERFACE_MEMBERS`/`CALL_ARGS`/`RETURN_SHAPES` (read the file header — the surface test calls every `ViewerKintaiApi` member and expects `KINTAI_ADMIN_REQUIRED`); reads return real data as seeded; `lockPeriod` writes the lock (actor = the admin's linked employee via `#actor` — decide and document what happens when the admin is UNLINKED: `#actor` returns null, and `period_locks.locked_by` — check its nullability; if NOT NULL, an unlinked admin must be refused with a message naming the fix, and that needs a test); audited with before/after; double-lock → `KINTAI_ALREADY_LOCKED` with nothing written; malformed period → `KINTAI_INVALID_INPUT`.

- [ ] **Step 2: The end-to-end the live verification could not drive.** In `__tests__/admin-api.test.ts` or `overview.test.ts`, through real store + facet calls: lock a month **via the admin API**, then (a) an ordinary `punch()` whose work date lands in it refuses `KINTAI_PERIOD_LOCKED`, (b) an approved correction still applies, (c) `monthlyReport(period).locked` is true, (d) the pending row's `amendment.lockedPeriod` names it. Watch it fail before implementing.

- [ ] **Step 3: Implement.** Admin methods are thin: validate (`assertPeriod`, `assertWorkDate`, `assertEmployeeId`), delegate, audit the write (follow `setWorkDatePolicy`'s read-before-write audit shape). Add the widening paragraph to the interface header — the spec's wording requirements: reads all attendance including punch-level days, decided knowingly 2026-09-04, why HR and not managers, `ViewerKintaiApi` throwing is what keeps non-admins at zero.

- [ ] **Step 4: All gates including `capnweb-validate build`, commit** — `feat(kintai): the admin can finally close a month, and see what is stuck`.

---

## Task 4: The tab bar, with Roster unchanged

**Files:**
- Modify: `app/AdminPage.tsx`, `app/AdminPage.test.tsx`

**Interfaces:**
- Produces: a `Tab = "overview" | "monthly" | "roster"` state in `AdminPage`; tab buttons labelled `要対応` / `月次` / `Roster`; content components receive the `ui` capability (match how the page currently passes `api`) . Default tab: `overview`.

- [ ] **Step 1: Failing app tests** — the three tab buttons render (`type="button"`; the blanket test covers it, add explicit `data-testid="tab-roster"` etc.); clicking `Roster` shows the existing roster (reuse an existing roster assertion); clicking between tabs preserves nothing surprising (state lives in `AdminPage`, not remounted-and-lost forms — decide: keep all three mounted with `hidden`, or remount; **prefer `hidden` via the element's `hidden` attribute** so in-progress form state survives a tab flip, and test that: type into a roster form, flip tabs, flip back, the text is still there).
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.** The tab bar is buttons + `aria-selected`; existing content wraps in the Roster panel untouched — the diff for the existing JSX should be indentation and a wrapper, nothing else. `OverviewTab`/`MonthlyTab` render placeholders this task (`<p>…</p>` is fine; Tasks 5–6 replace them).
- [ ] **Step 4: All app + worker gates. Do NOT rebuild `app.txt` yet** — one rebuild at the end (Task 6) keeps the dev-server dance to once.
- [ ] **Step 5: Commit** — `feat(kintai): the admin page grows tabs, roster unchanged`.

---

## Task 5: 要対応 — the needs-a-human tab

**Files:**
- Create: `app/OverviewTab.tsx` · Modify: `app/AdminPage.tsx`, `app/AdminPage.test.tsx` (or a new `app/OverviewTab.test.tsx` following the existing harness)

**Interfaces:**
- Consumes: `listPendingOverview()`, `listAnomalousDays(period)`, `getEmployeeDay(employeeId, workDate)`; the existing roster data + repair controls.
- Produces: three sections in triage order. Behaviour that must hold (tests for each):
  1. **Approvals waiting**: per row — who filed and for whom; what it asks (overtime `Xh Ym`, or the correction rendered as `in 09:00 → 08:30` / `out added at 18:00` — reuse `jstClockTime` FROM THE WORKER BUNDLE? No: app code cannot import worker modules that pull `SqlStorage` types; check what `app/` already imports from `src/` (`types`, `input` limits) and put a small time formatter in the app if needed, with a comment naming the duplication and why it is tolerated or — better — import `jstClockTime` directly if `work-date.ts` is a clean leaf, which it is; verify `typecheck:app` accepts it); **who can decide it**, rendered as names; age (`3日` / `5時間` coarse buckets, not live-ticking); a closed-month marker when `amendment.lockedPeriod` is set; **a stranded row (`eligibleActorNames` empty) renders a loud warning naming the fix** (set a designated approver / route problem), not an empty cell.
  2. **Anomalous days**: grouped by employee; each row `date + flags`; expanding a row calls `getEmployeeDay` lazily and shows punches (`kind` + `jstClockTime(occurred_at)` + `source`) and credited minutes. No decide/repair controls here.
  3. **Org blockers**: the not-ready roster rows and their existing repair buttons — **the same components the Roster tab renders, not copies**. If the current markup is inline in `AdminPage`, extract the row component so both tabs render one implementation (smallest extraction that achieves it; no broader refactor).
- Empty states for all three sections say what "nothing here" means (e.g. `承認待ちはありません`) — a blank dashboard must read as good news, not as broken.

- [ ] Steps: failing tests (each behaviour above; jsdom, follow the file's `render`/`text()` helpers) → fail → implement → gates → commit `feat(kintai): 要対応 — what needs a human, and who that human is`.

---

## Task 6: 月次 — the monthly tab, closing the month, and the bundle

**Files:**
- Create: `app/MonthlyTab.tsx` · Modify: `app/AdminPage.tsx`, tests, `docs/kintai-architecture-limits.md`, `src/generated/app.txt` (rebuilt)

**Interfaces:**
- Consumes: `monthlyReport(period)`, `lockPeriod(period)`, `getEmployeeDay` (row drill-down optional — include only if trivial with Task 5's component; otherwise leave it out and say so).
- Produces:
  - Month picker: `型 YYYY-MM`, default current JST month (`jstWorkDate(Date.now()).slice(0, 7)`), prev/next buttons — no free-text field to validate.
  - The table: name/number, days, `Xh Ym` hours, anomaly count. Anomaly count > 0 is a link/button switching to 要対応 (pass a callback from `AdminPage`; do not duplicate anomaly rendering).
  - Locked: a `締め済み` badge, and the close control hidden. Unlocked: **「この月を締める」** with a two-step confirm — the button arms a confirmation block (no `window.confirm`; check whether the iframe sandbox allows modals — it has `allow-modals`, but an inline confirm matches the app's existing notice pattern better and is testable in jsdom) whose text states: ordinary edits refused; corrections via approval still possible; totals can therefore still change after closing. Then `lockPeriod`, refresh, badge appears.
  - `KINTAI_ALREADY_LOCKED` from a race renders through `describeFailure` like every other error on the page.
- [ ] Steps: failing tests (picker default; table numbers from a seeded fixture — app tests mock the `ui` capability, follow how `AdminPage.test.tsx` fakes `api`; the confirm two-step; locked hides the control; the confirmation text pinned) → fail → implement → gates.
- [ ] **Update `docs/kintai-architecture-limits.md`:** the approval-routes and lockPeriod entries move to resolved-with-date, pointing at the admin members. Keep the pattern section — it caught four instances; the doc's value is the question, not the inventory.
- [ ] **Rebuild the bundle** (dev server stopped): `rm -rf packages/gatekeeper-kintai/dist-app && cd packages/gatekeeper-kintai && node build-app.mjs` → `src/generated/app.txt` ~42 lines → commit it with this task.
- [ ] Commit — `feat(kintai): 月次 — the month read, and finally closed`.

---

## Task 7: Live verification, with the owner steering

Not a code task, and deliberately last: the owner said they steer the screen. Two parts.

- [x] **Part 1 — scripted, before the owner looks** (same procedure as `docs/superpowers/plans/2026-09-01-kintai-punch-amendments-verification.md`: own `pnpm run-local --port 8799`, probe users, revert `wrangler.dev.jsonc` ×18 + `ADMINS` before commit): drive `listPendingOverview`/`listAnomalousDays`/`monthlyReport`/`getEmployeeDay`/`lockPeriod` over real RPC; lock an old probe month and confirm (a) `setAllocations` into it now refuses — **the hole this closes; record it explicitly** — (b) a correction still applies, (c) the report flips to locked. Then load the built app in the real Workshop iframe (headless browser, as the sandbox bug history demands) and click each tab, one control per section. Record in a sibling verification file; tick checkboxes only for what ran.
  Ran 2026-09-07 — record in `2026-09-04-kintai-admin-dashboard-verification.md`.
- [ ] **Part 2 — the owner.** *Unticked on purpose: the owner drives this one.* Stop everything, leave `main` merged and green, and hand over with: what to start, which tab shows their existing data, and the one thing to try per tab. Their feedback drives the next iteration — that loop is the product of this plan, not an afterthought.

---

## Out of scope (from the spec — do not add)

Premium/overtime figures · manager-scoped views · payroll export · unlock · notifications.
