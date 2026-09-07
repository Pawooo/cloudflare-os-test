# Kintai offboarding — decisions captured, spec pending

**Date:** 2026-09-07
**Status:** NOT a spec. Decisions settled with the owner in conversation, recorded so the design
session starts from them rather than re-deriving. The full brainstorm → spec → plan cycle runs
after the owner's dashboard steering session, because the roster UI this lands on is about to be
reshaped by hand.

## The gap this closes

`employees.status` (`active`/`leave`/`departed`) and `departed_on` have been in the schema since
day one, and **nothing can write to them** — the fifth instance of the implemented-but-unreachable
pattern (`docs/kintai-architecture-limits.md`). Consequences today, verified during the dashboard
work: nobody can be marked as having left; the approval system reads only the org chart and never
status, so a foreman who quits remains a truthfully-listed eligible approver for his old crew and,
with a live account link, could still decide payroll input.

## Decisions

1. **Admin-only, v1.** Recording a departure is HR's act. Managers currently hold zero
   org-management powers and this would be the first and most destructive one — it stays on
   `KintaiAdminApi` with the triad, audited before/after, widened later only if a real workflow
   demands it. Self-departure is allowed (it is a fact, and admins may record their own), subject
   to the fallout rule below.

2. **Departure is a status change, never any form of delete.** No soft delete, no moved-away
   category, no hidden rows. The punches are the 賃金台帳 and must remain readable for years after
   departure; the roster's existing deliberate rule ("a roster that hid departed rows would hide
   exactly the records an admin needs") stands. "Delisting" means exactly three things:
   - `status = 'departed'` + `departed_on` written, audited;
   - removed from AUTHORITY — not an eligible approver, not counted by reachability, cannot punch
     or file (where those refusals live is the spec's main question; the standing constraint is
     one rule, one implementation — `checkMayAct` and `hasReachableApprover` are the two owners);
   - GROUPED on the roster (a 退職済み section or toggle), every record intact.

3. **Departure is always recordable; the fallout is computed and shown first, never used to
   refuse.** You cannot refuse to record that someone quit — blocking the write only makes the
   record false. The two-step confirmation (the close-month pattern) must list, before the admin
   confirms: who below them loses their only approver (the stranding machinery already computes
   this), which pending submissions only they could decide, and what they themselves have in
   flight. The write then proceeds; the dashboard's stranded warnings catch anything the admin
   chose not to fix first. This satisfies the standing code-comment obligation from the
   approver-reachability work: the first write that can orphan an employee must run the
   reachability check at that write.

## Known interactions the spec must face

- `eligibleActors`/`pendingOverview` currently probe the whole roster BECAUSE status was
  unwritable (ledgered ruling, 2026-09-04). Once departure exists, the ruling's stated condition
  is met: the filter belongs in `checkMayAct` itself, never in the dashboard's display — a screen
  that filters what the system still accepts is lying.
- Mid-route submissions where the departed was one approver of several: fine, others decide.
  Where they were the ONLY approver: surfaces as stranded; the confirmation names it in advance.
- Their own pending filings: withdrawable by them until the account link closes; decide whether
  departure auto-closes the link (`unlinkAccount` exists and is reachable).
- `AmendmentDetail`/queue rows rendering a departed name: names stay (history), the authority
  lists stop including them.
- 管理監督者 who departs: exemption periods get `valid_to` semantics or stand as history — decide
  in spec.
