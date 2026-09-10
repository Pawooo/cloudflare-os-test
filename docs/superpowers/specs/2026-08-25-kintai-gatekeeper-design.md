# Kintai Gatekeeper — design

**Date:** 2026-08-25
**Scope:** Sub-project 1 of 5 of the kintai (勤怠) system.
**Status:** Design agreed; not yet planned or implemented.

## Why this is a Gatekeeper and not a Gadget

A Gadget's Durable Object cannot identify its caller. `getGadgetFacetFetcher()`
(`packages/workshop-backend/src/overseer.ts`) keys the facet on gadget id alone, and
`connectToGadget()` hands that facet stub straight to the client. Every collaborator on a shared
Gadget reaches the same DO, and no identity travels with the call. Cloudflare's own Docs Gadget
illustrates the consequence: its `subscribe(callback, client)` takes the caller's name as an
argument and stores `String(client.name || "Guest")` — self-asserted and unverified. That is
correct for a presence cursor and disqualifying for an approval.

A Gatekeeper resolves this. `GatekeeperVendor.createAccount()` mints an opaque per-user capability
(`{ accountId }`), which the Workshop persists in that user's Durable Object. Per `AGENTS.md`,
"the account capability — not an asserted identity — is the authority thereafter." When an
employee's own Gadget calls through their own binding, the Gatekeeper sees their `accountId`, and
no argument the Gadget passes can contradict it.

Identity therefore arrives out-of-band from the call. This is the property the whole design rests
on, and it survives an employee editing their own Gadget's code — which they are free to do, and
which we assume they will.

## Non-goals

- **Offline operation.** Investigated and found structurally impossible for Gadgets; see
  [`docs/gadget-offline-support.md`](../../gadget-offline-support.md)
  ([日本語](../../gadget-offline-support.ja.md)). All clients are assumed connected. A useful
  consequence: **server time is authoritative** for punch timestamps, eliminating device-clock
  trust, skew reconciliation, and monotonic sequencing.
- **Overtime calculation.** Sub-project 2. This spec defines where the engine is called and what
  inputs it receives, not the rules themselves.
- **Employee and manager UIs.** Sub-projects 3 and 4.
- **Payroll export and retention enforcement.** Sub-project 5.

## Deployment shape

A Gatekeeper is a Worker, and installing one is a binding change rather than a modification to the
OS. The router discovers gatekeepers by scanning its own `GATEKEEPER_*` service bindings. Locally,
`scripts/run-dev-server.ts` scans `packages/` for directories prefixed `gatekeeper-` and derives
the binding name, so creating `packages/gatekeeper-kintai/` is the entire local install.

The deployment admin then sets the vendor's mode in the admin Gatekeepers panel. Per
`provisioning-policy.ts` the modes are `disabled` / `optional` / `enabled`, defaulting to
`optional`. **Kintai requires `enabled`**: attendance is not opt-in, and an employee must not be
able to disconnect themselves from the timeclock. `enabled` is safe here because an
auto-provisioned account is inert until HR links it to an employee record.

### Authentication

Sign-in is by verified email; the `UserDurableObject` is addressed by `idFromName(email)`, so any
allowlisted auth gatekeeper yielding the same verified email resolves to the same account and thus
the same `accountId`. Recommended deployment configuration:

```
AUTH_GATEKEEPERS=google        # corporate Workspace only
DISABLE_PASSWORD_AUTH=true
```

Consumer identity providers must not be allowlisted for a deployment running kintai: it would make
a payroll input depend on a third party's email-verification policy.

**Email changes reassign identity.** A changed address yields a different `idFromName()` and
therefore a new `accountId`. This is routine in Japan (改姓 on marriage; department-prefixed
schemes on transfer). It fails closed — the employee appears unmapped and cannot punch — but it is
an HR operation that must be supported. This is why `account_links` is a table with validity
periods rather than a column on `employees`: **the employee record is the durable identity, and
accounts are credentials that come and go.**

## Components

`packages/gatekeeper-kintai/`, following the `gatekeeper-scheduler` pattern:

| Component | Responsibility |
| --- | --- |
| `GatekeeperVendor` | Vendor declaration. `autoProvisionsAccount: true`, `providesAuth: false`. Mints accounts via `createAccount()`. |
| `KintaiAccount` | Per-user capability, props `{ accountId }`. Declares `providesUi` for the HR/admin surface at `/gatekeepers/kintai`. |
| `KintaiGatekeeper` | The workspace facet — the sole entry point for Gadget code, imbued with the caller's `accountId`. |
| `KintaiStore` | One Durable Object. SQLite. All state. |
| `overtime/` | Pure calculation module (sub-project 2). No I/O. |

### Storage partitioning

One Durable Object holds everything. At the target scale (under ~200 employees) write volume is
roughly 4–6 punches per person per day, which a single DO absorbs comfortably, and every
cross-employee report — the dominant read pattern — becomes a single SQL query rather than a
fan-out plus a maintained projection.

Tables are keyed by `employee_id` throughout so that sharding per-employee later is mechanical
rather than a redesign.

## Data model

Timestamps are stored UTC. `work_date` (勤務日) is **always an explicit column, never derived from
a timestamp at query time** — a night shift crossing midnight belongs to a single work date, and
deriving it per-query gets this wrong inconsistently across queries. The business timezone is JST.

### `employees`
`(id, employee_number, display_name, department, employment_type, designated_approver_id,
status, joined_on, departed_on)`

Durable identity. `status` ∈ `active | leave | departed`. `designated_approver_id` is nullable and
used only for the root-of-organisation case below.

`department` and `employment_type` are plain columns rather than temporal ones, unlike `org_edges`.
Transfers do change them, but approval routing is the only consumer and `submissions.route_snapshot`
already preserves the route that actually applied — so history is captured where it is needed
without a second temporal table.

### `exemption_periods`
`(employee_id, kind, valid_from, valid_to)`
Temporal because people are promoted into and out of exempt roles. `kind` ∈ `kanri_kantokusha`.

> **管理監督者 are exempt from 時間外 and 休日 premiums but NOT from 深夜割増 (22:00–05:00).**
> Their punches must still be recorded and night hours still calculated. Treating "exempt" as
> "stop tracking" is the standard implementation of this rule and it is incorrect. Sub-project 2
> must test this case explicitly.

### `account_links`
`(account_id, employee_id, valid_from, valid_to, linked_by, reason)`
Maps a Gatekeeper capability to an employee. `account_id` has at most one open link at a time.
An unlinked account is inert: it can call the facet, and every call fails with a specific
"not linked" error. Re-linking on email change closes the old row and opens a new one, leaving all
history attached to the employee.

### `org_edges`
`(employee_id, manager_id, kind, valid_from, valid_to)`
Temporal. `kind` ∈ `report | delegate`. Delegation reuses the reporting-line shape with a bounded
validity window, so a manager on leave does not silently stall their team's submissions.

Temporality exists to answer "was this person actually X's manager on 3 July?" — a question an
audit asks and a non-temporal table cannot answer after any reorganisation.

### `punches` — append-only
`(id, employee_id, work_date, kind, occurred_at, recorded_at, source, latitude, longitude,
accuracy_m, location_source, matched_site_id, supersedes_id, amended_by, amend_reason)`

`kind` ∈ `in | out | break_start | break_end`. `source` ∈ `gadget | admin | import`.
`occurred_at` is **server time**. A correction is a new row whose `supersedes_id` references the
row it replaces; current state is the set of punches not superseded. Rows are never updated.

`location_source` ∈ `gps | denied | unavailable | manual`. Both the raw coordinates and the
evaluated `matched_site_id` are stored: site boundaries are redrawn over time, so a dispute needs
the evaluation as it stood *and* the underlying data.

### `sites`
`(id, name, latitude, longitude, radius_m, valid_from, valid_to)`
Temporal for the same reason.

### `day_allocations`
`(employee_id, work_date, project_code, minutes, note, version, superseded_by)`
Project/task time allocation. Versioned rather than mutated. Allocated minutes are reconciled
against worked minutes for the day; **a discrepancy is stored and surfaced, never rejected.**
People fill these in imperfectly, and a system that refuses imperfect input does not get filled in.

### `approval_routes` and `approval_route_steps`
Configuration templates. A route is an ordered list of steps; each step names eligible approvers
and a rule (`any_of` | `all_of`). Routes may key off department, employment type, or overtime
magnitude (e.g. crossing 45h/month appends a 本社 step).

### `submissions`
`(id, employee_id, kind, requested_for, state, submitted_at, current_step, computed_minutes,
calculation_inputs, route_snapshot)`

`state` ∈ `draft | pending | approved | rejected | withdrawn`. `kind` ∈ `overtime` — the only kind
in scope; the column exists so 休日出勤 requests can be added later without a migration.

`route_snapshot` is the resolved route copied onto the submission at submit time. If route
configuration changes mid-approval, in-flight submissions must not mutate under their approvers;
the configuration is a template, the submission carries its own copy.

`requested_for` alongside `submitted_at` makes 事前申請 (pre-approval) versus retroactive approval a
derived, queryable property. This is deliberately **measured rather than enforced**: 36協定 assumes
overtime is ordered by the employer, and an organisation approving all overtime after the fact has
a compliance problem that no individual record reveals — only the ratio does. Enforcing
pre-approval outright would simply be worked around.

### `approval_events` — append-only
`(submission_id, step_index, actor_employee_id, action, at, comment, authorizing_edge)`
`action` ∈ `approve | reject | return`. `authorizing_edge` records which `org_edges` row granted
the actor authority, so the audit trail answers "were they authorised at that moment?" directly
rather than by inference.

### `period_locks`
`(period, locked_at, locked_by)` — `period` is a JST calendar month, `YYYY-MM`.
After a period is locked, punches and allocations for it are writable only through the amendment
path, which requires approval and remains permanently visible. The lock is what makes append-only
storage meaningful: without it, "append-only" only means the table grows.

### `audit_log` — append-only
`(id, at, actor_employee_id, action, entity, entity_id, before, after)`
Every change to authority-relevant state: account linking, org edges, exemptions, route
configuration, and period locks. Attendance data itself is not duplicated here — `punches`,
`day_allocations` and `approval_events` are already append-only and are their own audit trail.

## Approval state machine

```
  draft ──submit──▶ pending[step 1] ──▶ pending[step n] ──▶ approved
    ▲                    │                    │
    │                    ├─── reject ─────────┴──▶ rejected
    └──── return ────────┘
```

`approved`, `rejected` and `withdrawn` are terminal. `return` is an event, not a state: it sends
the submission back to `draft` with a comment. Modelling it as a state would duplicate `draft`'s
behaviour exactly.

**Returning to draft discards prior approvals.** An approver approved specific content; if the
employee changes it, that approval no longer applies. Preserving approvals across an edit is how
approval systems get exploited.

**Authority is evaluated at approval time against the currently valid org edge**, and the edge is
recorded on the event. If a manager changes mid-month, the new manager approves — authority
correctly follows the current organisation — while the trail still shows who acted and under what
authority.

**Self-approval is structurally forbidden**: `actor_employee_id != submission.employee_id`,
enforced in the facet. This is not configurable; there is no legitimate case, and making it a
setting invites someone to enable it.

**Root-of-organisation rule.** An employee at the root of the org graph has no manager, and
self-approval is forbidden. The system therefore requires that every non-exempt employee has a
reachable approver: such an employee must either hold a `kanri_kantokusha` exemption for the
period, or have an explicit `designated_approver_id` on their employee record. Org configuration
that leaves a non-exempt employee with no reachable approver is rejected at write time, not
discovered when a submission strands.

## Facet API

Exposed to Gadget code. Every method resolves the employee from `accountId` first; **no
employee identifier supplied by a caller is ever trusted.**

| Method | Notes |
| --- | --- |
| `whoAmI()` | Resolved employee, or an explicit unlinked state. |
| `punch(kind, location?)` | Server-timestamped. Idempotency window on repeats. |
| `getDay(workDate)` | Punches, allocations, exceptions. |
| `setAllocations(workDate, entries)` | Versioned. Returns the reconciliation discrepancy. |
| `submitOvertime(requestedFor, minutes, reason)` | Resolves and snapshots the route. |
| `withdrawSubmission(id)` | Own submissions only. |
| `listMySubmissions(filter)` | Own only. |
| `listPendingApprovals()` | Derived from org edges; never accepts an employee id. |
| `actOnSubmission(id, action, comment)` | Verifies authority server-side; forbids self-approval. |

Methods naming another employee (approval) verify the reporting relationship server-side before
acting. These methods are the intended migration boundary if authority ever moves elsewhere.

## Error handling

| Case | Behaviour |
| --- | --- |
| Unlinked account | Specific, actionable message directing the user to HR — never a generic authorization failure. This is every joiner's first experience of the system. |
| Forgot to clock out | **Never auto-close the day.** Raise an exception requiring employee correction plus approval. An auto-closed shift is a fabricated record. |
| Duplicate punch | Idempotency window; respond "already clocked in" rather than erroring or creating a second row. |
| Write to locked period | Reject with the reason and direct the caller to the amendment path. |
| Location denied or unavailable | **The punch always succeeds.** Record `location_source` and flag for review. Blocking a clock-in on a declined browser prompt creates a worse problem than geofencing solves. |
| No reachable approver | Prevented at org-configuration write time (see root-of-organisation rule). |

## Privacy

Coordinates tied to an individual are personal data under 個人情報保護法. The design therefore
carries three obligations explicitly rather than discovering them later: 利用目的の特定 (a specified,
documented purpose), notification to employees, and a defined retention limit.

**Coordinates are retained on a shorter clock than punches.** A punch must survive for
labour-law retention; the location that accompanied it generally need not. Sub-project 5 owns
enforcement; this spec requires that the schema keeps them separable so a coordinate purge does
not touch attendance records.

## Testing

- **Temporal org graph** — property tests on "who was X's manager at time T" across
  reorganisations, transfers, and delegation windows.
- **Approval routes** — full state machine coverage, with explicit tests that returning
  invalidates prior approvals and that self-approval is rejected at every step.
- **Identity** — unlinked accounts are inert; re-linking on email change preserves history against
  the employee; a closed link grants nothing.
- **Append-only invariants** — no path updates a `punches` or `approval_events` row; corrections
  always produce a new row with `supersedes_id` set.
- **Period lock** — writes rejected after close; amendments accepted only through the approval
  path.
- **Reconciliation** — allocation/worked-minutes discrepancies are stored and surfaced, never
  rejected.

Following existing repository patterns (`vitest`, `packages/integration-tests`).

## Build order

1 (this spec) and 2 may proceed in parallel — the overtime engine is pure and I/O-free. Then 3, 4,
5. Each sub-project gets its own spec, plan, and implementation cycle.
