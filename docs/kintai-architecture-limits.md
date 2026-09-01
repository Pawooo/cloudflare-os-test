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

## Approval routes had no configuration surface — WAS INCIDENTAL, now mitigated

`createRoute` existed on the store with no admin method, no session method and no UI. On a store
with no routes, `resolveRoute` threw `KINTAI_NO_ROUTE` and **no submission could be created at
all** — with nothing in any API able to fix it.

`applySchema` now seeds a catch-all fallback (one step, any manager, lowest specificity) so a fresh
store can route an approval. That unblocks the flow; it does not make routes configurable. Real
route management — department rules, minute thresholds, multi-step escalation — still belongs on
the HR screen and is unbuilt.

## The pattern worth noticing

Three of the four limits above are the same shape: **a capability implemented on the store, tested,
and reachable from nowhere.** `createRoute` was one. `correctPunch` was another — it is what the
amendment work exists to reach. `recordPunch`'s historical-write ability is a third, and that one
should stay unreachable.

A store method with no caller is not a feature. It is either a gap that will surface as
"the system cannot do X and nothing can fix it", or a hole waiting for someone in a hurry.
Worth asking of anything new here: *who calls this, through which capability, and what stops
everyone else?*
