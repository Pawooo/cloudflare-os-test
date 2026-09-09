# What the Gatekeeper architecture permits, and what it does not

Findings from trying to build a demo-org seeder for `packages/gatekeeper-kintai` entirely through
compliant surfaces — no direct SQLite, no reaching past the capability model. The seeder itself was
dropped (real onboarding starts from scratch, with users creating their own accounts), but what it
established about the architecture is worth keeping.

Each limit is classified **essential** — a consequence of the capability model, and therefore
correct — or **incidental** — a missing API that could be added without weakening anything. That
distinction is the point of this document. An essential limit is a design to respect; an incidental
one is a backlog item, and confusing the two leads either to building workarounds nobody needed or
to punching holes in the model to save an afternoon.

## The one door

`AdminKintaiApi` is handed out **only** by `KintaiSession.startAppUi`, gated on `context.isAdmin`,
which the Workshop computes fresh on every open and which never travels further — not into the
frame, not to the iframe, not accepted back from it. A non-admin receives `ViewerKintaiApi`, whose
methods throw.

The consequence: **there is no headless admin path.** Anything that administers Kintai must
authenticate to the Workshop as an admin and open the app. An external script cannot hold the admin
capability without doing what a browser does. This is essential, and it is why the seeder became a
button rather than a script.

## Account linking — ESSENTIAL

`linkAccount(accountId, employeeId)` validates its argument only as text. Nothing stops a caller
inventing a UUID and writing an `account_links` row.

It would be useless and actively harmful. `GatekeeperVendor.createAccount()` mints the id with
`crypto.randomUUID()`, and **the Workshop**, not Kintai, records which user holds it. An invented
code is held by nobody, so no browser can ever present it — while the roster's `linked` column
would show green for an employee no human can sign in as. That column exists precisely to
distinguish "onboarded" from "not yet", and a fabricated link makes it lie.

So the identity boundary holds not because Kintai guards it, but because Kintai is not where
identity lives. Nothing to fix.

## Historical punches — INCIDENTAL, and deliberately left closed

This one corrects an earlier claim in this project's own notes.

`KintaiSession.punch()` reads `Date.now()` internally and takes no time argument, and no member of
`KintaiAdminApi` writes a punch. Both true — from which it is tempting to conclude that backdated
punches are architecturally impossible.

They are not. `AdminKintaiApi` holds a full `DurableObjectStub<KintaiStore>`, and
`KintaiStore.recordPunch` is public and takes caller-supplied `workDate`, `now` and `source` —
with `'admin'` and `'import'` already among the seeded `punch_sources`. An admin surface could
write history today without leaving the capability model.

The reason not to is product safety, not architecture. `recordPunch` is documented as *the
unguarded write*: it skips `assertWritable` (period locks) and `workDateFor` (attribution).
Exposing it would ship **"HR can forge a punch at any past instant, into a closed month, with no
approval"** as a reviewed product surface, in a system whose entire compliance story rests on
punches being append-only and attributable.

The honest route to a backdated punch is the amendment flow: `requestMissingPunch` states a time
and a reason, a second person approves it, and the resulting row carries `amended_by`,
`amend_reason` and `source = 'amendment'`. Same outcome, with the trail that makes it defensible.

**Stating the limit accurately matters.** "Impossible" invites nobody to think about it.
"Possible, and closed on purpose" tells the next person what they would be giving up.

## Employee creation cannot set a work-date policy — INCIDENTAL

`NewEmployee` has no `workDatePolicy` field; `work_date_policy` is a column default and the only
writer is `setWorkDatePolicy`, an UPDATE. So a night worker is created on `calendar` and then
moved — two calls, with a window in between where they are on the wrong policy, and one UPDATE on
a freshly created row.

Harmless today, and worth closing when onboarding is built out: getting the policy right at hire
is the whole point of having it per employee.

## Approval routes had no configuration surface — WAS INCIDENTAL, unblocked 2026-09-04

`createRoute` existed on the store with no admin method, no session method and no UI. On a store
with no routes, `resolveRoute` threw `KINTAI_NO_ROUTE` and **no submission could be created at
all** — with nothing in any API able to fix it.

`applySchema` now seeds a catch-all fallback (one step, any manager, lowest specificity) so a fresh
store can route an approval. That unblocks the flow; it does not make routes configurable.

Be precise about which half closed, because the two halves have different owners. The BLOCKING
half is gone: a fresh store routes an approval, and no state of the configuration can leave the
system unable to create any submission at all. The CONFIGURATION half is untouched — there is
still no `createRoute` on `KintaiAdminApi`, no session method and no form, so department rules,
minute thresholds and multi-step escalation remain unreachable. Every submission in the system
currently routes through one seeded fallback step. That is a working default, not a feature, and it
belongs on the HR screen.

## The root of the org chart could not be given an approver — WAS REAL, now closed

`designated_approver_id` is described in `store/employees.ts` as "the escape hatch for employees at
the root of the reporting tree". It was settable **only** in `createEmployee`'s INSERT, with no
update path anywhere — and the employee who needs it is typically employee 1, created when the
table is empty and there is nobody to point at. Implemented, documented, and unreachable by exactly
the person it was written for.

It looked survivable only because `hasReachableApprover` counted a 管理監督者 exemption as "needs
nobody", so HR could make the row green by recording an exemption. That was the wrong green: an
exemption grants nobody authority to sign, and a punch correction for an exempt officer needs a
person like anyone else's. The exemption arm is gone and
`KintaiAdminApi.setDesignatedApprover(employeeId, approverId)` is the update path, with a form on
the HR screen beside "Set a reporting line".

Still open in the same area: there is no way to CLEAR a designated approver, close a reporting
line, or end an exemption. All three are de-authorisations, all three belong together, and none
exists.

## No month could ever be closed — WAS REAL, closed 2026-09-04

The same shape as the two above and the most consequential of the three, because this one was load
bearing rather than merely absent.

`period_locks` has been enforced from the beginning. `assertWritable` reads it, `KintaiSession.punch`
calls `assertWritable`, and a closed month refuses every ordinary write into it — the mechanism was
complete, tested, and correct. What no surface could do was write a ROW into that table.
`KintaiStore.lockPeriod` was public on the store and called by nothing but its own tests, so in
practice **no month could ever be closed**, and the lock enforced a state the system could not
enter.

What that cost is not abstract. `setAllocations` is the one write in this package with no approval
behind it, and the period lock is the only thing that ever stops it. With no way to close a month,
it could rewrite a month somebody had already been paid on, indefinitely, with nothing in the
architecture to say otherwise. "Append-only" only meant the table grows.

`KintaiAdminApi.lockPeriod(period)` is the call, and 月次's 「この月を締める」 is the button. It is
audited, `locked_by` is the caller's OWN employee id resolved from their own capability rather than
an argument, and it is one-way: there is no unlock here and none on the store.

Three things about it are worth having written down, because each looks like an omission and is
not:

- **No unlock, deliberately.** Reopening a month would have to say what happens to the amendments
  filed against it and to a payroll run already made from it. Nobody has made that decision, and a
  reopen that did not answer both would be worse than the absence.
- **Closed is not frozen.** Applying an approved amendment is the one write a closed month still
  accepts, so its totals can still move afterwards — by exactly the route that leaves a trail. The
  confirmation on the HR screen says so in as many words, because "closed" reads as "final" to
  everybody who has not read `actOnAmendment`.
- **An administrator with no employee record cannot close a month at all**
  (`KINTAI_ADMIN_NOT_LINKED`). `period_locks.locked_by` is NOT NULL, and unlike `linkAccount` this
  write has no honest "unset" to fall back on: the whole point of the row is who closed the month.
  The refusal is the column being right, not a gap — and it is one more reason the account card
  shows an admin their own code whether or not they are linked.

## The dashboard could not decide a request — WAS A RULING, reversed 2026-09-09

The admin dashboard's 要対応 tab was designed triage-only: it named WHO could decide a waiting
request and how long it had waited, and sent that person to the agent to decide it. The ruling was
made to keep administrators out of the approval chain — admin does not equal approver — and it was
sound on that point. It failed on another: in the owner's own manual pass, the screen named the
decider and then offered nothing to do. "What am I supposed to start then?"

Reversed as follows. A row shows 承認・差し戻し・却下 only when the org chart names the viewer among
its deciders (`eligibleActorIds`, computed by the same `checkMayAct` the write runs). Being an
administrator still buys nothing: an unlisted caller is refused at the write whatever the screen
showed. The write is `AdminKintaiApi.decideSubmission`, confirmed inline and written directly.

Two things this surfaced that are limits of the OS, not of Kintai:

- **`startAppUi` receives only `{ isAdmin }`.** The Overseer's `ApprovalQueue` — the confirmation
  card the agent path stages every decision through — goes to `startSession` alone. An app UI
  cannot stage an action; it can only write. So a dashboard decision is confirmed by Kintai's own
  two-step control, like every other dashboard write, and the OS card is reserved for the agent.
  The gate's purpose (a human in the loop for a possibly prompt-injected agent) is served either
  way: on the dashboard the human IS the initiator. But if the Workshop ever hands app UIs a queue,
  this is the write that should move onto it first.
- **Managers who are not Workshop admins have no dashboard.** They receive the employee gadget, so
  for them the agent stays the only path to a decision until a manager-scoped view exists.

And a principle the owner stated, which changes the earlier "LLM-first" framing and should steer
every surface decision from here: **conventional UI for routine flows, the agent for the long
tail.** The cost of a manager reasoning through a routine approval in natural language outpaces a
button many times over; the agent earns its tokens on the questions a form cannot anticipate.

## The pattern worth noticing

Four of the six limits above are the same shape: **a capability implemented on the store, tested,
and reachable from nowhere.** `createRoute` was one, `designated_approver_id`'s escape hatch
another, `recordPunch`'s historical-write ability a third — and that one should stay unreachable.
`lockPeriod` is the fourth, and it is the one that shows what the shape actually costs: the lock it
writes was enforced everywhere, so the gap did not read as a missing feature. It read as a system
whose central compliance guarantee was watertight and permanently inert.

`correctPunch` is a fifth instance with no heading of its own, because it never became a limit
anybody hit: it is what the amendment work exists to reach, and it was reached before this document
had to record it as unreachable.

A store method with no caller is not a feature. It is either a gap that will surface as
"the system cannot do X and nothing can fix it", or a hole waiting for someone in a hurry.
Worth asking of anything new here: *who calls this, through which capability, and what stops
everyone else?*
