# Resetting the local Kintai store

You are here because a store threw:

```
KINTAI_STALE_SCHEMA: this store predates the submission_kinds lookup table and cannot accept
amendments. There is no migration -- delete the local Durable Object state (.wrangler/state) and
re-seed. See docs/resetting-the-dev-store.md.
```

`submissions.kind` and `punches.source` used to be `CHECK` constraints and are now foreign keys
onto the seeded `submission_kinds` and `punch_sources` tables. `CREATE TABLE IF NOT EXISTS` is a
no-op on a table that already exists, so a store created before that change keeps the old
constraints forever. Converting the columns in place means rebuilding `submissions` and `punches`,
which is exactly what the lookup tables exist to avoid — and DO SQLite's immediate foreign-key
enforcement blocks it anyway. See `applySchema` in `src/store/schema.ts`.

There is no deployed Kintai store. The only store this can happen to is a local dev one, and the
fix is to delete it.

## Delete it

From the repository root, with the dev server **stopped**:

```bash
rm -rf .wrangler/state
```

That is every local Durable Object's storage, not only Kintai's — the Workshop, its gadgets and
their accounts all live in there. There is no way to delete one object's storage on its own, and
there is nothing in it worth keeping.

If `pnpm run-local` then fails on stale build output rather than starting:

```bash
rm -rf packages/*/.wrangler/validate
```

## Start it again

```bash
pnpm run-local --port 8799
```

## Re-seed

Nothing is seeded automatically; the store starts with the schema and no rows. Everything below is
done through the UI, because that is the only surface these writes have.

1. **Install the Kintai gadget** in the Workshop. Installing it mints the account, and every step
   after this one happens inside it.
2. **Open the HR admin app** (the gadget's app UI). It refuses to do anything below unless you are
   a Workshop admin.
3. **Add the employees you need**, in the "Add someone" form. Employee number and display name are
   required; a joined-on date defaults to today. Add at least two — a worker and a manager — or
   nothing can be approved.
4. **Give the worker a manager**, with "Set manager" on their roster row. Until this is done the
   roster shows them as having no reachable approver and `submitOvertime` refuses. Somebody at the
   top of the organisation gets 管理監督者 instead, which exempts them from needing one.
5. **Link your account code to an employee.** Your own code is at the top of the admin app under
   "Your account code" — copy it, then use "Link code" on the roster row you want to be. Without
   this the gadget's session has no employee and every call refuses.
6. **Punch, if you need punches.** Through the gadget, not the admin app. Test punches on a
   specific past date have no UI at all; write them from a test instead.

The roster is the check on all of this: a row with a reachable approver and a link is an employee
who can actually use the system. A row missing either is one the runtime will turn away, and the
roster says which.
