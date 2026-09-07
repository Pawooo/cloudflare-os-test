# Kintai employee gadget — decisions captured, spec pending

**Date:** 2026-09-07
**Status:** NOT a spec. The owner's requirements from the dashboard steering session, recorded so
the design cycle starts from them. This is the original plan's sub-project 3 — the employee-facing
surface — promoted to next-in-queue ahead of the overtime engine, on the owner's finding below.

## The finding that reprioritised it

The owner opened the app as their test employee (E-01, who had a conflicting 打刻 with no 退勤)
and hit the deliberate `KINTAI_ADMIN_REQUIRED` wall: **employees have no visual surface at all.**
The agent is their only interface — fine for filing, wrong for "is my day broken?" Their words:
"are normal users expected to constantly hit the api to figure out/fix their kintai sitch?"
Verified: an employee's own approved overtime (E-01, 180 min, 2026-09-01) is visible on no screen
in the system.

## Owner requirements (verbatim intent)

1. **As simple as possible.** My-day / my-month screens or tabs. Nothing the admin dashboard has
   needs repeating here; this is a worker's glance, not a manager's triage.
2. **Manual punch-in/punch-out buttons** as an alternative/fallback to the agent. (`punch()` on
   the session exists; a button calls it. The server clock stays the only clock.)
3. **File a missed 打刻** — the forgotten clock-out, from the day that shows the gap.
   (`requestMissingPunch` exists; the UI's job is making the flagged day offer it.)
4. **Overtime amount per day, table view.** v1 renders what exists: requested/approved overtime
   minutes per day with their state, from the employee's own submissions. COMPUTED premiums
   (深夜/時間外) arrive with the overtime engine — the table grows columns then, same pattern as
   月次. Stated plainly in the UI so a claim is never mistaken for a payout.

## Also from the steering session (admin side, separate small item)

要対応's flagged-day rows show what's wrong but not the move. The manager's actual next step —
file the missing punch on the employee's behalf (`requestCorrectionFor`/`requestMissingPunchFor`,
built and tested) — is not offered from the row. Cheap fix; belongs with this cycle or as a
standalone steering fix, spec's call.

Second finding, same session: the approvals rows name WHO can decide but never tell the viewing
admin "this one is yours" versus "chase that person" — the owner, logged in as an admin who was
not the eligible approver, spent real minutes working out why a decidable-looking row was not
theirs to decide. The page already holds the admin's linked employee id (`whoAmI`) and the row
already carries `eligibleActorIds`, so a "yours to decide" badge is a client-side comparison, no
new reads. Company-wide visibility with route-held authority is the DESIGN (triage, not override,
per the 2026-09-04 ruling) — the badge makes the design legible instead of puzzling.

## Constraints the spec inherits

- This surface is a GADGET-side session UI: identity from the capability, no employee id
  parameters except the two allowlisted on-behalf methods (identity-boundary test).
- A correction is a request — the screen must say "filed, waiting for approval", never "fixed"
  (the types.txt rule, now with pixels).
- Everything the session can render exists already: `getDay`, `listMySubmissions` (with
  `amendment` detail and `lockedPeriod`), `punch`, `requestMissingPunch`, `requestPunchCorrection`.
  The spec's main questions are shape and wording, not new capabilities — with one exception: a
  MONTH view for one's own days needs a session read that does not exist yet (`getDay` is
  one day; a `myMonth(period)` on the session is new surface, same one-rule constraints).
