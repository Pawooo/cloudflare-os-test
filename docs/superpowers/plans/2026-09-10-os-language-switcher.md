# OS Language Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A language picker in the OS shell's sidebar utility strip, pushed to every gatekeeper iframe on the existing theme channel, with Kintai following it live and remembering it per account.

**Architecture:** Two commits. The OS patch (upstreamable): `GatekeeperAppTheme.locale`, a `locale.ts`/`LocaleContext` mirroring the theme ones, a `LocaleButton` beside `ThemeModeButton`, and the iframe host composing `locale` into the message. The Kintai patch: precedence OS → account → browser, live follow via an external language source, `setLanguage(UiLanguage | null)` mirroring the OS choice, Kintai's own toggle deleted.

**Tech Stack:** TypeScript, React, `@tanstack/react-router` shell, `@cloudflare/kumo` Tooltip, `@phosphor-icons/react`, capnweb RPC, vitest (shell: jsdom; Kintai: workers pool + jsdom).

**Spec:** `docs/superpowers/specs/2026-09-10-os-language-switcher-design.md` — read it first.

## Global Constraints

- **OS files get exactly ONE commit (Task 1), written as an upstream PR would be**: minimal, mirroring the theme code line for line, no Kintai-specific words anywhere in `workshop-shared`/`workshop-frontend`. Everything Kintai is Tasks 2–3.
- **Additive type**: `locale` is added to `GatekeeperAppTheme`; nothing else on the message changes; existing gatekeepers compile untouched (they never read it).
- **Mirror, don't invent**: `locale.ts` ↔ `theme.ts`, `LocaleContext.tsx` ↔ `ThemeContext.tsx`, `LocaleButton` ↔ `ThemeModeButton` (same classes, same Tooltip, same aria sentence shape). Storage key `gadgets:locale`. Swallow storage failures the same way.
- **The shell sends `null` for "system"** — never the browser-resolved value (see spec: it is what keeps Kintai's account memory alive).
- **Kintai precedence**: OS → account → browser, decided before first paint and re-decided on every `setTheme`. `setLanguage(null)` deletes the row. Kintai's `LanguageToggle` + test deleted; dictionary/guard/provider untouched.
- **Kintai identity from the capability**; no localStorage in the iframe; `type="button"` everywhere; bundles are build output (not committed) — do NOT run `build-app.mjs` to commit anything.
- **No worktree; commit incrementally.** Baselines: shell **360** tests (`packages/workshop-frontend`: `pnpm exec vitest run`); Kintai **548 worker / 196 app**; `tsc --noEmit` + `typecheck:app` + `capnweb-validate build` for Kintai. Shell typecheck: whatever `packages/workshop-frontend/package.json` declares (`tsc -b` or `typecheck`); read it.
- The owner's dev server may be running; the watchers now die with it, but check `pgrep -fl "vite.js build.*--watch"` before any branch switch.

---

## File Structure

**Created**
- `packages/workshop-frontend/src/locale.ts`, `locale.test.ts`
- `packages/workshop-frontend/src/LocaleContext.tsx`
- `packages/workshop-frontend/src/components/AppShell/SidebarUtilityStrip.test.tsx` (if none exists; else extend)
- `packages/gatekeeper-kintai/app/i18n/language-source.ts` (the external store the provider subscribes to)

**Modified**
- `packages/workshop-shared/src/theme.ts` (`APP_LOCALES`, `AppLocale`, `locale` field)
- `packages/workshop-frontend/src/main.tsx` (mount `LocaleProvider`), `components/AppShell/SidebarUtilityStrip.tsx`, `SandboxedGatekeeperApp.tsx` + `.test.tsx`
- Kintai: `src/types.ts` (`setLanguage` client types accept null), `src/store/preferences.ts` (+ delete), `src/admin-api.ts`, `src/kintai.ts` (both `setLanguage`s), `app/i18n/index.tsx` (provider reads the source), `app/i18n/messages.ts` (`resolveLanguage(os, saved, navigator)`), `app/main.tsx`, `app/employee-main.tsx`, `app/AdminPage.tsx`, `app/EmployeePage.tsx` (toggle removed), tests; **deleted**: `app/i18n/LanguageToggle.tsx` + `.test.tsx`.

---

## Task 1: The OS patch — type, shell picker, theme push (ONE commit)

**Files:** `packages/workshop-shared/src/theme.ts`; `packages/workshop-frontend/src/{locale.ts,locale.test.ts,LocaleContext.tsx,main.tsx,components/AppShell/SidebarUtilityStrip.tsx,SandboxedGatekeeperApp.tsx,SandboxedGatekeeperApp.test.tsx}` (+ a strip test).

**Produces:** `APP_LOCALES`, `AppLocale`, `GatekeeperAppTheme.locale: AppLocale | null`; shell `LocaleChoice`, `readLocaleChoice/writeLocaleChoice/resolveLocale`, `LocaleProvider/useLocale`; the strip's `LocaleButton`; the host pushing `{ mode, accentColor, locale }`.

- [ ] **Step 1: Failing tests.** `locale.test.ts`: `resolveLocale` table (`("system","ja-JP")→ja`, `("system","en-GB")→en`, `("system",undefined)→en`, `("en","ja-JP")→en`, `("ja","en")→ja`); read/write round-trip through a stubbed `localStorage`, unknown stored value → `system`, throwing storage → `system`/no throw. Strip test: renders inside `ThemeProvider`+`LocaleProvider`; the locale button's `aria-label` for `system` under `navigator.language="en-US"` is `Language: system (English). Switch to English.`; click → `en` → label `Language: English. Switch to 日本語.`; click → `ja` → `Language: 日本語. Switch to system.`; `localStorage` holds the choice; `type="button"`. `SandboxedGatekeeperApp.test.tsx`: the existing `subscribeTheme` pin gains `locale: null` (system default); with the provider set to `ja` the message carries `locale: "ja"`; changing the choice re-pushes via `setTheme`. Run: red.
- [ ] **Step 2: Shared type.** `APP_LOCALES`, `AppLocale`, `locale` with the spec's doc comment.
- [ ] **Step 3: `locale.ts` + `LocaleContext.tsx`** mirroring `theme.ts`/`ThemeContext.tsx` (no media-query branch is needed; `resolvedLocale` recomputes from `navigator.language` when `system`). Mount `LocaleProvider` inside `ThemeProvider` in `main.tsx`.
- [ ] **Step 4: `LocaleButton`** in `SidebarUtilityStrip.tsx`, placed immediately before `ThemeModeButton`; `Translate` icon; the three-way cycle; labels per spec.
- [ ] **Step 5: Host push.** In `SandboxedGatekeeperApp.tsx` read `useLocale()`, compose `locale`, add it to `themeRef.current`, the `updateTheme` effect's payload and dependency list.
- [ ] **Step 6: Gates.** Shell: `pnpm exec vitest run` (360 + yours), shell typecheck; `packages/workshop-shared` typecheck if it has one; Kintai `tsc --noEmit` still passes (it only reads `mode`/`accentColor` today). **ONE commit**: `feat(workshop): a language picker in the utility strip, pushed to gatekeeper apps with the theme`.

## Task 2: Kintai remembers the OS choice — `setLanguage(UiLanguage | null)`

**Files:** `src/store/preferences.ts`, `src/store/kintai-store.ts`, `src/admin-api.ts`, `src/kintai.ts`, `src/types.ts` (client types), `__tests__/admin-api.test.ts`, `__tests__/employee-api.test.ts`, a new `__tests__/locales.test.ts`.

- [ ] **Step 1: Failing tests.** `setLanguage(null)` after `setLanguage("ja")` → `whoAmI().language === null`; `setLanguage(null)` on an account with no row is a no-op that succeeds; `"fr"` still refused before any write. `locales.test.ts`: `UI_LANGUAGES` deep-equals `APP_LOCALES` from `@gadgets/workshop-shared/theme` (the drift guard). Update `CALL_ARGS` if needed. Run: red.
- [ ] **Step 2: Implement.** `setLanguage(sql, accountId, language | null, now)`: null → `DELETE FROM account_preferences WHERE account_id = ?`. Both facets accept `UiLanguage | null`; `@validateRpc()` regenerates. Client types in `src/types.ts` and `app/AdminPage.tsx`'s `KintaiAdminClient` accept null. Doc: why null means "forget" (the OS's "system").
- [ ] **Step 3: Gates** incl. `capnweb-validate build`; commit — `feat(kintai): forgetting a language is a choice too`.

## Task 3: Kintai follows the shell — precedence, live switch, toggle removed

**Files:** `app/i18n/messages.ts` (`resolveLanguage`), `app/i18n/language-source.ts` (new), `app/i18n/index.tsx`, `app/main.tsx`, `app/employee-main.tsx`, `app/AdminPage.tsx`, `app/EmployeePage.tsx`; tests `app/i18n/messages.test.ts`, `app/EmployeePage.test.tsx`, `app/AdminPage.test.tsx`, a new `app/i18n/language-source.test.ts`; **delete** `app/i18n/LanguageToggle.tsx`, `app/i18n/LanguageToggle.test.tsx`.

**Produces:** `resolveLanguage(os: AppLocale | null, saved: UiLanguage | null, navigatorLanguage: string | undefined): UiLanguage`; `createLanguageSource(initial)` with `get/set/subscribe` for `useSyncExternalStore`; `LanguageProvider({ source, children })`.

- [ ] **Step 1: Failing tests.** `resolveLanguage` table with the OS first: `("ja", "en", "en-US")→ja`, `(null,"ja","en-US")→ja`, `(null,null,"ja-JP")→ja`, `(null,null,"en-US")→en`. `language-source.test.ts`: set notifies subscribers, get reflects. Page tests: render with a source; `source.set("en")` re-renders English (both pages); no `[data-testid="language-toggle"]` anywhere. Entry-level behaviour (the RPC glue lives in `main.tsx`, which the page tests don't render) — cover the mapping function `localeToLanguage(theme.locale)` and the "on setTheme: set source + call `setLanguage(mapped)`" glue as a small exported function tested in isolation (`app/i18n/follow-host.ts` or inside `language-source.ts`). Run: red.
- [ ] **Step 2: Implement.** Provider takes `source` and uses `useSyncExternalStore`; `useLanguage()`'s setter writes the source. Entries: `Promise.allSettled([host.subscribeTheme(iframe), host.ui.whoAmI()])`, then `source = createLanguageSource(resolveLanguage(theme?.locale ?? null, identity?.language ?? null, navigator.language))`; `AppIframe.setTheme(theme)` → `applyAppTheme(theme)` + `followHost(theme.locale)` which sets the source to `resolveLanguage(theme.locale, lastSaved, navigator.language)` and calls `api.setLanguage(theme.locale ? mapped : null)`, reporting a rejection via `reportIssue`. Remove `<LanguageToggle>` from both headers, delete the component + test, drop the `KintaiAdminClient`/comment references to it.
- [ ] **Step 3: Guard + gates.** `no-stray-literals` still green (the deleted toggle was the only file exempt-by-inclusion); app suite (196 − toggle tests + yours); worker 548+; `tsc`; `typecheck:app`. Commit — `feat(kintai): follow the shell's language, remember it per account, one control`.

## Task 4: Live pass

Own stack on 8799 (see `docs/superpowers/plans/2026-09-07-kintai-employee-gadget-verification.md` for the procedure; `PROBE-EMP-` users; owner data untouched; the dev server generates `wrangler.dev.jsonc` itself now — nothing to revert there). In headless Chrome against the real shell: (1) the utility strip shows the Translate button; system + `en-US` → Kintai English; (2) click to 日本語 → Kintai re-renders in Japanese WITHOUT reload, `whoAmI().language === "ja"`; (3) new context, empty `localStorage`, `en-US` → Kintai 日本語 (the account); (4) click to system → Kintai English, `language === null`; (5) admin and employee both. Record to `docs/superpowers/plans/2026-09-10-os-language-switcher-verification.md`; commit.

- [x] **Live pass driven and recorded** — `2026-09-10-os-language-switcher-verification.md`. (1)–(3), (5)–(7) pass verbatim; (4) passes on the row (`language === null`) and **fails on the open screen**, which stays in the deleted language until the next push or open (finding 1 there, not fixed). Also: `packages/gatekeeper-kintai/wrangler.dev.jsonc` is still tracked (finding 2).
