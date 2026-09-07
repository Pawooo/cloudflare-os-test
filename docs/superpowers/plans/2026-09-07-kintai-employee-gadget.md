# Kintai Employee Gadget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give employees a my-day/my-month gadget — punch buttons, self-service missed-punch filing, per-day hours + OT state — served to non-admins at the same `startAppUi` fork that gates the admin dashboard.

**Architecture:** A new `EmployeeKintaiApi` facet (symmetric with `AdminKintaiApi`) replaces the non-admin throw-wall; a second Vite bundle (`employee-app.txt`) is emitted beside `app.txt` and `startAppUi` serves the role-appropriate one. The one punch implementation is shared between the employee button and the agent's session; the new `myMonth` read shares `monthlyTotals`' per-day iteration; source labels get one renderer across both screens.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite, Cap'n Web RPC (`@validateRpc()`), React + Vite single-file bundles in the Workshop's sandboxed iframe, vitest (`@cloudflare/vitest-pool-workers` for worker tests, jsdom for app tests).

**Spec:** `docs/superpowers/specs/2026-09-07-kintai-employee-gadget-design.md` — read it first; this plan argues from it.

## Global Constraints

Battle-tested in this package; every task inherits them.

- **`punches`, `approval_events`, `audit_log` are append-only.** No UPDATE/DELETE.
- **One rule, one implementation.** The two named in the spec are load-bearing and are the review's hardest targets: (a) the employee punch and the agent punch traverse identical facet logic — the `#attemptPunch` sequence and its one race retry (`src/kintai.ts` `punch`) — not two copies; (b) `myMonth` shares `monthlyTotals`' iteration (`daysWithPunches` + per-day readers in `src/store/overview.ts`), not a fork.
- **Identity from the capability.** `EmployeeKintaiApi` resolves the employee from `ctx.props.accountId`, never an employee-id argument (the identity-boundary test in `__tests__/amendment-flow.test.ts` — anything new taking an `employeeId` must earn its allowlist entry with a server-owned gate, and this surface has none of those).
- **A correction is a request, not an edit.** Any filing UI says `申請しました・承認待ち`, never "fixed".
- **The Workshop iframe has no `allow-forms`.** Every control `type="button"` + `onClick` (+ Enter-keydown only where a text field needs it). jsdom does not enforce this; 46 green tests once sat over an unusable page.
- **Admin surface unchanged in behaviour.** This plan must not alter what an admin sees except the source-label rendering (Task 4), which is a like-for-like swap.
- **Do not commit a dev build of any `*.txt` bundle.** The dev server rewrites them unminified (~23k lines); production is ~42 lines via `node build-app.mjs` with the server stopped. A pre-commit hook refuses dev builds. The first rebuild after a dev-server run is non-deterministic by ~11 bytes (a stray Tailwind utility); build twice and compare.
- **Do not create a git worktree; commit incrementally** (machine-sleep has killed several long agents; a death should cost a step).
- **Test-store scoping:** per-test DO via a `seq` name; never `getByName("")` except in the one file that already shares it (`approval-queue.test.ts`).
- **A test route with no `department` loses to the seeded catch-all** — scope test routes, name the department in filings.
- Rejection convention: `await expect(() => store.method(...)).rejects.toThrow(...)`.
- Errors carry their `KINTAI_` code as the message's first token.
- Gates every task: `pnpm exec vitest run` · `pnpm exec vitest run -c vitest.app.config.ts` · `pnpm exec tsc --noEmit` · `pnpm run typecheck:app` (+ `pnpm exec capnweb-validate build --out .wrangler/validate` on tasks touching an RPC surface). Baseline entering this plan: **519 worker, 115 app** at `f98bc4f`. Re-check `git log` before trusting counts.

---

## File Structure

**Created**
- `app/EmployeePage.tsx` — the employee root: the 今日/今月 tab shell and the two tab components (kept in one file until it grows unwieldy, mirroring how `AdminPage.tsx` began).
- `app/employee-main.tsx` — the employee bundle's entry (mirror of `app/main.tsx`), mounting `EmployeePage` with the `ui` capability.
- `app/employee-index.html` — the employee bundle's HTML entry.
- `app/PunchSource.tsx` — the shared source-label renderer, consumed by both `EmployeePage` and `OverviewTab`.
- `src/generated/employee-app.txt` — the second emitted bundle (generated; do not hand-edit).
- `__tests__/employee-api.test.ts` — `EmployeeKintaiApi` surface + `myMonth`.
- `app/EmployeePage.test.tsx` — the two tabs.

**Modified**
- `src/store/overview.ts` — `employeeMonth(sql, employeeId, period)` sharing `monthlyTotals`' iteration.
- `src/store/kintai-store.ts` — the delegate.
- `src/kintai.ts` — extract the shared punch orchestration; `EmployeeKintaiApi`; `startAppUi` serves by role.
- `src/admin-api.ts` — `EmployeeKintaiApi` lives here beside `AdminKintaiApi`/`ViewerKintaiApi` (or a sibling module if the file is already large — check and decide).
- `vite.app.config.ts` + `build-app.mjs` — emit two bundles.
- `app/OverviewTab.tsx` — switch the raw `{punch.source}` render (`:473`) to `PunchSource`.
- `__tests__/admin-api.test.ts` — `EmployeeKintaiApi` triad; `startAppUi`-by-role.

---

## Task 1: `employeeMonth` — one employee's month, sharing the admin iteration

**Files:**
- Modify: `src/store/overview.ts`, `src/store/kintai-store.ts`
- Test: `__tests__/employee-api.test.ts` (new; store-level here, facet added in Task 2)

**Interfaces:**
- Consumes: `monthlyTotals`/`daysWithPunches` and the per-day readers already in `overview.ts`; `listSubmissionsFor` (or the submissions read the admin queue uses) for per-day OT state; `assertPeriod` (`src/input.ts`).
- Produces:
  ```ts
  export type EmployeeMonthDay = {
    workDate: string;
    workedMinutes: number;
    anomalies: string[];
    /** The day's own overtime submission state, or null if none. One request per day is the
     *  common case; if several exist, the most recent by submission id. */
    overtime: { minutes: number; state: SubmissionState } | null;
  };
  export type EmployeeMonth = { period: string; days: EmployeeMonthDay[] };
  export function employeeMonth(sql: SqlStorage, employeeId: EmployeeId, period: string): EmployeeMonth;
  ```

- [ ] **Step 1: Write the failing tests**

`__tests__/employee-api.test.ts`, per-test DO (`empmonth-${seq++}`), seeding via real store methods (verify their signatures first):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NINE = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST
let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`empmonth-${seq++}`);
  worker = await store.createEmployee({ employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01" });
});

describe("employeeMonth", () => {
  it("returns one row per day the employee has punches in the month, with worked minutes and flags", async () => {
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-03", kind: "in", now: NINE, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-03", kind: "out", now: NINE + 8 * 3_600_000, source: "gadget" });
    await store.recordPunch({ employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000, source: "gadget" }); // unpaired

    const month = await store.employeeMonth(worker, "2026-07");
    expect(month.period).toBe("2026-07");
    expect(month.days).toHaveLength(2);
    expect(month.days[0]).toMatchObject({ workDate: "2026-07-03", workedMinutes: 480, anomalies: [], overtime: null });
    expect(month.days[1]).toMatchObject({ workDate: "2026-07-04", anomalies: ["unpaired_in"], overtime: null });
  });

  it("carries the day's own overtime request state", async () => {
    // clock a paired day, submit overtime for it through a departmented route (catch-all trap),
    // assert that day's `overtime` is { minutes, state: "pending" }, and a day without a request is null.
  });

  it("is bounded to the month and to this employee", async () => {
    // a punch in 2026-06 and another employee's punch in 2026-07 must not appear.
  });
});
```

Write the second and third out fully — the comments say what to assert, not what to paste. Also add `assertPeriod` rejection cases if not already covered where `assertWorkDate`'s are.

- [ ] **Step 2: Run and watch fail** — `pnpm exec vitest run __tests__/employee-api.test.ts`, expect `store.employeeMonth is not a function`.

- [ ] **Step 3: Implement `employeeMonth`** in `overview.ts`. It MUST reuse `daysWithPunches` (scoped to `employee_id = ?`) and the same per-day `workedMinutes`/`dayAnomalies` calls `monthlyTotals` uses — a reviewer will diff this against `monthlyTotals` and reject a second iteration. Per-day OT state comes from the employee's submissions for that `requested_for`; document the most-recent-wins choice. Doc-comment prose explains *why* the read is per-day-derived (append-only punches; no stored aggregate).

- [ ] **Step 4: Pin the sharing, not just the output.** Add a test that `employeeMonth(worker, period)`'s per-day `workedMinutes` equal the same days read one-by-one through `workedMinutes` directly — so a future divergence between this read and the per-day source fails here (the spec's "pinned against per-day sums"). A reviewer separately diffs the iteration against `monthlyTotals` by eye; the test guards the arithmetic.

- [ ] **Step 5: Delegate on `KintaiStore`** — one async delegate beside the others.

- [ ] **Step 6: Gates, commit** — `feat(kintai): one employee's own month, from the admin iteration`.

---

## Task 2: `EmployeeKintaiApi`, and one punch implementation for both facets

**Files:**
- Modify: `src/kintai.ts`, `src/admin-api.ts`, `src/store/kintai-store.ts` (if the delegate list needs it)
- Test: `__tests__/employee-api.test.ts`, `__tests__/admin-api.test.ts`

**Interfaces:**
- Consumes: `employeeMonth` (Task 1); the existing store reads/writes (`getDay`, `recordPunch`/`commitPunch`, `fileAmendment`, `listSubmissionsFor`, etc.); the `#attemptPunch` orchestration currently private to `KintaiSession`.
- Produces:
  ```ts
  export interface EmployeeKintaiApi {
    whoAmI(): Promise<KintaiIdentity>;
    getDay(workDate: string): Promise<{ punches: PunchRow[]; allocations: AllocationRow[]; reconciliation: Reconciliation; anomalies: string[]; locked: boolean }>;
    myMonth(period: string): Promise<EmployeeMonth>;
    punch(kind: PunchKind, location?: PunchLocation): Promise<{ punchId: number; employeeId: EmployeeId; workDate: string }>;
    requestMissingPunch(workDate: string, kind: PunchKind, occurredAt: number, reason: string): Promise<number>;
    requestPunchCorrection(punchId: number, occurredAt: number, reason: string): Promise<number>;
    listMySubmissions(): Promise<SubmissionRow[]>;
    withdrawSubmission(submissionId: number): Promise<void>;
    resubmit(submissionId: number): Promise<void>;
  }
  ```
  Implemented on `EmployeeKintaiApi` (a concrete class); NO on-behalf methods, NO `listPendingApprovals`/`actOnSubmission`.

- [ ] **Step 1: The punch-sharing test first.** In `__tests__/employee-api.test.ts`, assert the employee punch path enforces the period lock and the race retry — the two things the shared orchestration owns. Concretely: an `EmployeeKintaiApi.punch` into a locked period refuses `KINTAI_PERIOD_LOCKED` (proving it runs `assertWritable`, not a bare insert), and a `shift_start` employee's overnight punch attributes correctly (proving it runs `workDateFor`). These are the behaviours that differ between "shared the real path" and "reimplemented a shortcut". Watch them fail.

- [ ] **Step 2: Extract the shared orchestration.** `KintaiSession.punch`/`#attemptPunch` currently live on the session (which also holds the ApprovalQueue). Move the employee-relevant orchestration — resolve employee, `#attemptPunch` with its one `isWorkDateRaced` retry — to something both facets call: a free function taking `(store, accountId, kind, location, now)`, or a shared base. **`KintaiSession.punch` must be repointed at it in the same task** so the review sees both callers and can confirm they are one path. Do not leave `KintaiSession` with its own copy.

- [ ] **Step 3: Write `EmployeeKintaiApi`.** Each method resolves the employee from `accountId` (mirror `AdminKintaiApi`'s `#actor`/`identify`) and delegates to the store or the shared punch path. `requestMissingPunch`/`requestPunchCorrection` call the same store `fileAmendment` the session does — for the caller's OWN employee only, `createdBy = self` (never defaulted). Follow `KintaiSession`'s existing method bodies for these; they are the reference implementation, now for one employee with no on-behalf.

- [ ] **Step 4: Triad + surface tests.** `EmployeeKintaiApi` is a concrete class, not the throw-with-interface pattern (there is no "employee viewer" to refuse) — but its surface must be pinned: a test enumerating its callable methods against an expected list, and asserting it does NOT expose `listPendingApprovals`, `actOnSubmission`, or any `...For` on-behalf method. Add `myMonth`/`getDay` return-shape pins.

- [ ] **Step 5: `startAppUi` serves the employee capability.** Change the non-admin branch of `startAppUi` (`src/kintai.ts:658`) from `ViewerKintaiApi` to `new EmployeeKintaiApi(this.#store(), this.ctx.props.accountId)`. Keep `ViewerKintaiApi` only if something else still uses it (grep; if nothing does, its removal is in scope and a reviewer will expect it gone or a note why it stays). The bundle is still `APP_HTML` at this step — Task 3 splits it.

- [ ] **Step 6: Gates including `capnweb-validate build`, commit** — `feat(kintai): an employee capability, sharing the one punch path`.

---

## Task 3: Two bundles, and `startAppUi` serves the right one

**Files:**
- Create: `app/employee-index.html`, `app/employee-main.tsx`, `app/EmployeePage.tsx` (minimal shell this task), `src/generated/employee-app.txt` (emitted)
- Modify: `vite.app.config.ts`, `build-app.mjs`, `src/kintai.ts`
- Test: `__tests__/admin-api.test.ts` (startAppUi-by-role)

**Interfaces:**
- Produces: `EMPLOYEE_APP_HTML` importable in `kintai.ts` from `./generated/employee-app.txt`; a minimal `EmployeePage` rendering a 今日/今月 tab bar with placeholder panels (Tasks 5-6 fill them).

This is the riskiest task — the build pipeline assumes one entry (`app/index.html` → `src/generated/app.txt`). Read `vite.app.config.ts` and `build-app.mjs` fully before touching them.

- [ ] **Step 1: The minimal employee shell.** `EmployeePage.tsx` with a `Tab = "today" | "month"` bar (labels 今日/月次... use 今日/今月 per spec), two placeholder panels, mounted-and-hidden like `AdminPage`. `employee-main.tsx` mirrors `main.tsx` (handshake, theme, `createRoot`, `ErrorBoundary`) mounting `EmployeePage` with `api={host.ui}` typed to a new `KintaiEmployeeClient` (the plain-type client mirror of `EmployeeKintaiApi`, in `src/types.ts` per the wire-types lesson — a client interface the app imports, not the `cloudflare:workers`-bearing `EmployeeKintaiApi`). `employee-index.html` mirrors `index.html` pointing at `employee-main.tsx`.

- [ ] **Step 2: Emit two bundles.** `vite.app.config.ts`'s `emitAppText` and `rollupOptions.input` are single-entry. Make the build produce both `app/index.html`→`src/generated/app.txt` AND `app/employee-index.html`→`src/generated/employee-app.txt`. `viteSingleFile` inlines per build, so the cleanest shape is likely two Vite invocations (one per entry) rather than one multi-entry build that singlefile can't inline — decide, and make `build-app.mjs` run both. Verify both `.txt` files come out minified (~40+ lines each, one long script line).

- [ ] **Step 2b: Watch the pipeline.** After the build, confirm `src/generated/employee-app.txt` exists, is minified, and contains the employee shell's testids and not the admin tabs' (`要対応`). Confirm `app.txt` is unchanged from HEAD (the admin bundle must not shift).

- [ ] **Step 3: `startAppUi` returns the right bundle.** `import EMPLOYEE_APP_HTML from "./generated/employee-app.txt"`; the non-admin branch returns `{ iframeHtml: EMPLOYEE_APP_HTML, ui: <EmployeeKintaiApi> }`, admin branch unchanged. Write the test: a facet-host call to `startAppUi` with `isAdmin: false` returns the employee bundle (assert a marker string present in it and absent from `APP_HTML`) and an `EmployeeKintaiApi`-shaped `ui`; with `isAdmin: true`, the admin bundle and `AdminKintaiApi`. This is the security-relevant assertion — the role decides the bundle server-side.

- [ ] **Step 4: Gates + both bundles committed, minified.** Rebuild with the server stopped; commit both `.txt` files. Commit — `feat(kintai): a second bundle, served to employees by role`.

---

## Task 4: One source-label renderer, both screens

**Files:**
- Create: `app/PunchSource.tsx`
- Modify: `app/OverviewTab.tsx` (`:473`), `app/EmployeePage.tsx` (when 今日 lands, Task 5 imports it)
- Test: `app/EmployeePage.test.tsx` or a dedicated `app/PunchSource.test.tsx`

**Interfaces:**
- Produces: `<PunchSource punch={row} />` (or `renderSource(row)`) — renders `本人打刻` for `source === "gadget"`, `修正 (承認: <name>, 理由: <reason>)`-style for `amendment` using the row's `amended_by`/`amend_reason`, and a neutral label for `admin`/`import`. Reads only fields already on `PunchRow`.

- [ ] **Step 1: Failing test.** Assert each source value renders its human label, not the raw string; assert `gadget` → `本人打刻`; assert an amendment punch shows the reason and not the word `amendment`. Include a punch whose `source` is an unexpected value → falls through to the raw string (a worker-side source addition surfaces visibly, never blank).

- [ ] **Step 2: Watch fail; implement `PunchSource.tsx`.** Small, pure, no capability. Wording is HR-facing Japanese/English — match the app's register.

- [ ] **Step 3: Switch the admin drill-down.** Replace `OverviewTab.tsx:473`'s `{punch.source}` with `<PunchSource>`. The existing OverviewTab tests must still pass; if one asserted the raw `gadget` string, update it deliberately and say so — that assertion was pinning the bug the spec calls out.

- [ ] **Step 4: Gates, commit** — `feat(kintai): render a punch's provenance, not its platform word`.

---

## Task 5: 今日 — the my-day tab

**Files:**
- Modify: `app/EmployeePage.tsx`, `app/EmployeePage.test.tsx`

**Interfaces:**
- Consumes: `api.getDay(today)`, `api.punch(kind, location?)`, `api.requestMissingPunch(...)`, `PunchSource` (Task 4), `jstWorkDate` (`../src/work-date`, imports clean).

- [ ] **Step 1: Failing tests**, each a spec behaviour:
  - The shift-state control shows the next legal action from today's current punches: no punches → 出勤; after an `in` → 退勤 and 休憩開始; within a break → 休憩終了. Pressing it calls `api.punch` with the right kind. (Derive next-action from the punch list the same way `dayAnomalies`/pairing reasons about it — do not invent a second state machine; a small pure `nextPunchKind(punches)` helper is fine and testable.)
  - Today's punches render via `PunchSource`.
  - A flagged day (`unpaired_in`) shows the plain-language anomaly and a file-a-correction control that calls `requestMissingPunch`; on success the screen shows `申請しました・承認待ち`, not "fixed".
  - Empty state: `今日はまだ打刻がありません`.
  - A `punch` failure renders through `describeFailure`.

- [ ] **Step 2: Watch fail; implement.** Sandbox rules (`type="button"`, no forms). Always-visible punch control at the top. Data loads on mount like `AdminPage`'s `view` pattern; a punch or a filing refreshes today's read (a reload token, the pattern the dashboard's final fix established).

- [ ] **Step 3: Gates, rebuild the employee bundle** (server stopped; both bundles stay minified), commit — `feat(kintai): 今日 — punch, see your day, fix a gap`.

---

## Task 6: 今月 — the my-month tab

**Files:**
- Modify: `app/EmployeePage.tsx`, `app/EmployeePage.test.tsx`

**Interfaces:**
- Consumes: `api.myMonth(period)`, `jstWorkDate`.

- [ ] **Step 1: Failing tests:**
  - Picker defaults to current JST month (`jstWorkDate(Date.now()).slice(0,7)`); prev unbounded; next never past the current month (the 月次 bound).
  - The table: one row per `EmployeeMonthDay` — `労働時間` as `Xh Ym`, OT request + state where present, an anomaly marker where flagged. A day with no OT shows no OT, not a zero that reads as a claim.
  - The claims-not-payouts line is present.
  - Empty month says so.

- [ ] **Step 2: Watch fail; implement.** Table, not cards. The anomaly marker may link to 今日 for that date (optional; only if it reuses 今日's day view rather than duplicating it — otherwise omit and say so).

- [ ] **Step 3: Gates, rebuild bundle, commit** — `feat(kintai): 今月 — the month a worker actually sees`.

---

## Task 7: Live pass

Not a code task. Same procedure as `docs/superpowers/plans/2026-09-04-kintai-admin-dashboard-verification.md`: own stack on `--port 8799` (revert the ~18 `wrangler.dev.jsonc` and any `ADMINS` edit before commit), probe employees prefixed `PROBE-EMP-`, 2025 months for anything locked, never delete `.wrangler/state`.

- [ ] Open the app as a **non-admin** in the real Workshop iframe (headless browser, as the sandbox history demands): confirm they get the EMPLOYEE screen, not the admin wall or the admin tabs.
- [ ] Punch in and out via the buttons; confirm the shift-state control advances; confirm `source` renders 本人打刻.
- [ ] Leave a gap; file the missing 打刻 from 今日; confirm it appears in a manager's `listPendingApprovals`, the screen says 承認待ち, and after the manager approves, 今日 and 今月 reflect it.
- [ ] Confirm an admin still gets the admin dashboard unchanged, and the punch made from the employee button is byte-indistinguishable from an agent punch (same `source`, same `work_date` attribution) — the shared-path proof, live.
- [ ] Rebuild both bundles server-stopped (build twice, compare — the 11-byte non-determinism), everything reverted, gates green (worker / app / tsc / typecheck:app). Record to `docs/superpowers/plans/2026-09-07-kintai-employee-gadget-verification.md`; commit.

---

## Out of scope (do not add)

Premium/overtime calculation (the engine); manager-scoped views; the admin-side flagged-row action and yours-to-decide badge (captured, ride the next admin cycle); offboarding.
