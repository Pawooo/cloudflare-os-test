# Keeping this fork in step with cloudflare/cloudflare-os

This repository is a fork of https://github.com/cloudflare/cloudflare-os with one product added:
`packages/gatekeeper-kintai` (and its docs under `docs/superpowers/` and `docs/kintai-*.md`).
The remote `upstream` points at Cloudflare's repository. Until 2026-09-10 the fork had no shared
history with upstream (it began as a snapshot); that was fixed by rebasing every commit onto
`upstream/main`, so from now on a sync is routine.

## The loop

1. Stop the dev server. Check nothing else is holding the tree:
   `lsof -nP -iTCP:8787 -sTCP:LISTEN; pgrep -fl "vite.js build.*--watch"` — the vite watchers the
   dev server spawns can outlive it and will rewrite `src/generated/*.txt` under you. Kill them.
2. `tar -czf ~/Documents/wrangler-state-backup-$(date +%F).tar.gz .wrangler/state` — upstream's
   Workshop changes may migrate its own local Durable Object state.
3. `git fetch upstream` and, on a branch, `git merge upstream/main` (or `git rebase upstream/main`
   if you want the fork's commits kept as a clean stack on top; merging never needs a force-push
   and is the right default once anyone else clones the fork).
4. Resolve conflicts. They land in the same few files every time, and only when upstream restructures
   its build: `.gitignore`, `pnpm-lock.yaml`, `scripts/release/manifest-lib.ts` (Kintai's entries in
   the PREINSTALL/SINGLETON sets), `scripts/release/testdata/golden-manifest.json`. Everything under
   `packages/gatekeeper-kintai` is additive and cannot conflict.
5. `pnpm install`. Then Kintai's gates from `packages/gatekeeper-kintai`:
   `pnpm exec capnweb-validate build --out .wrangler/validate && pnpm exec tsc --noEmit &&
   pnpm exec vitest run && pnpm exec vitest run -c vitest.app.config.ts && pnpm run typecheck:app`.
   And upstream's release tests, which cover the manifest we edit:
   `node --test scripts/release/*.test.ts`.
6. Read `git diff <old>..upstream/main -- packages/workshop-shared/src/gatekeeper.ts`. Two kinds of
   change bite: a new REQUIRED member on an interface Kintai implements (`Gatekeeper`,
   `GatekeeperUser`, `GatekeeperVendor`) shows up as a `tsc` error; a changed parameter list on a
   method we implement shows up as a validator refusal in tests, because `@validateRpc()` sharpens
   our signature against the interface (2026-09-10: `applyAction` gained a git-cache stub).
7. Start the dev server and open Kintai once as an admin and once as an employee.
8. Fast-forward `main`.

## What keeps the loop cheap

- **Stay additive.** Kintai is a package; its docs are new files. Registration is limited to
  `scripts/release/manifest-lib.ts` + its golden test data. `wrangler.dev.jsonc` files are generated
  by `scripts/run-dev-server.ts` and gitignored — never edit or commit them; the dev server discovers
  every `packages/gatekeeper-*` directory on its own.
- **Do not patch OS packages casually.** A line changed in `workshop-frontend` or `workshop-shared`
  is a conflict on every future sync. When something is needed there, make it one isolated commit
  and try to upstream it (the global language switcher is the model case: a `locale` on the theme
  message the shell already pushes to every gatekeeper iframe).
- **Bundles are build output.** Upstream gitignores `packages/gatekeeper-*/src/generated/app.txt`;
  the dev server runs `build:app:dev` for every gatekeeper before starting, and deploy builds them.
  Kintai's `employee-app.txt` follows the same rule.

## If Kintai outgrows the fork

`git subtree split --prefix=packages/gatekeeper-kintai` gives Kintai its own repository with its
history intact; the fork then carries only the manifest registration and stays nearly pristine.
