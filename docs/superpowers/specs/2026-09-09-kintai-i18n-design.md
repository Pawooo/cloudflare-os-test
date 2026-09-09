# Kintai i18n — English and Japanese, one language per screen

**Status:** approved in conversation 2026-09-09 (owner: "at least Eng/Jap"; language rule: browser
default + per-person toggle saved server-side).

## Why

Both Kintai bundles mix 日本語 labels with English prose in the same sentence ("承認待ち · waiting on a
decision"). That was a reasonable placeholder while the screens were being shaped; it is not a
product. A worker reads one language. The owner wants at least English and Japanese, and prefers a
toggle over a Japanese-only translation.

## Two facts the design rests on

1. **The Workshop exposes no locale to a gatekeeper app.** `startAppUi` receives `{ isAdmin }`; the
   theme channel carries light/dark and an accent colour. Kintai must decide the language itself.
2. **The sandboxed iframe has no storage.** `sandbox="allow-scripts allow-modals"` gives the page an
   opaque origin: no localStorage, no IndexedDB, no cookies. A toggle cannot be remembered in the
   browser. The only place a per-person choice can live is server-side, behind the capability.

## Decision

- **First open follows the browser**: `navigator.language` starting with `ja` → 日本語, anything else →
  English. Pure function `resolveLanguage(chosen, navigatorLanguage)`.
- **A toggle in the header** (Phosphor `Translate` glyph, the A→文 icon, plus the name of the OTHER
  language) switches the whole screen at once and **saves the choice per account** in the store, so it
  survives reopening on any device. Saving failing does not undo the switch; the screen says the
  choice may not persist.
- **One language per screen.** The bilingual labels go. Dates stay `YYYY-MM-DD` and clocks `HH:MM` in
  both languages; durations and ages are translated (`8h 15m` / `8時間15分`, `3d` / `3日`).

## Storage

Two tables in `KintaiStore`, created with `CREATE TABLE IF NOT EXISTS` (additive; no reset needed):

```sql
CREATE TABLE IF NOT EXISTS ui_languages (code TEXT PRIMARY KEY) STRICT;         -- seeded: 'en','ja'
CREATE TABLE IF NOT EXISTS account_preferences (
  account_id TEXT PRIMARY KEY,
  language   TEXT NOT NULL REFERENCES ui_languages(code),
  updated_at INTEGER NOT NULL
) STRICT;
```

`ui_languages` is a lookup table, not a CHECK, per the package rule for growing enumerations (a
Durable Object cannot ALTER a CHECK). It is seeded from `UI_LANGUAGES = ["en", "ja"] as const` in
`src/types.ts`, so the seed and the type are one list. `account_preferences` is keyed by the opaque
account id, not by employee: an unlinked person keeps their choice too, and nothing here touches
`employees`.

Store methods: `languageFor(accountId): UiLanguage | null`, `setLanguage(accountId, language, now)`.

## RPC surface

- `KintaiIdentity` gains `language: UiLanguage | null` (`null` = never chosen). `identify()` reads
  it, so both `whoAmI()`s carry it and the page needs no extra round trip to start.
- `setLanguage(language: UiLanguage): Promise<void>` on **both** `KintaiAdminApi` and
  `EmployeeKintaiApi`. Identity from the capability, as everywhere. `@validateRpc()` refuses anything
  but the two literals.
- Surface pins updated: `INTERFACE_MEMBERS`, the employee surface list, `RETURN_SHAPES.whoAmI`.

## The dictionary

`app/i18n/messages.ts` exports `en` (the source of truth for keys) and `ja` declared `satisfies
Messages` where `type Messages = typeof en`. Values are strings or functions of typed parameters
(`count: (n: number) => string`). No string-key lookup, no library: `useT()` returns the messages
object for the current language and call sites read `t.pending.heading` / `t.pending.count(n)`.
Type-checked at compile time, zero runtime cost, nothing new in the bundle but the strings.

Groups: `common`, `tabs`, `header`, `today`, `month`, `pending`, `anomalies`, `blockers`, `roster`,
`monthly`, `punchSource`, `errors`, and `labels` (`punchKinds`, `anomalies`, `overtimeStates`,
`decisions`, `durations`, `ages`). Every helper that manufactures copy today takes `t`: `describeAsk`,
`formatDuration`, `formatAge`, `formatHoursMinutes`, `formatWorkedHours`, `describePunchSource`,
`describeFailure`, and the five `*_LABELS` maps become dictionary entries.

Keys are named by meaning, never by English text (`today.emptyDay`, not `noPunchesYet`).

## Errors

`describeFailure(error, fallback, t)`. The by-code rewrites (`KINTAI_NOT_FOUND`, `KINTAI_INVALID_TRANSITION`,
`KINTAI_STALE_DECISION`, `KINTAI_ADMIN_NOT_LINKED`, …) move into `t.errors.byCode`; the detail rewrites
into `t.errors.details`. **Server-side detail texts stay English** (they are agent-facing too), so an
unmapped detail shows in English to a Japanese reader — honest, and the common codes are all mapped.
`failureDetail` (the raw text under a non-coded failure) is unchanged: it is for reporting, not reading.

## The toggle

`app/i18n/LanguageToggle.tsx`: `type="button"`, `data-testid="language-toggle"`, Phosphor `Translate`
at 18px + the other language's own name ("日本語" while in English, "English" while in 日本語),
`aria-label` in the current language. Press: switch the provider immediately, set
`document.documentElement.lang`, call `api.setLanguage`; on failure render a small notice in the new
language ("この選択は保存されませんでした" / "This choice could not be saved") and keep the switch for
the session. Sits in the header of both pages, right-aligned.

## Tests

- **Parity:** `ja satisfies Messages` fails the build on a missing key; a runtime test also walks both
  objects and asserts the same shape and the same function arity (a `string` on one side and a
  function on the other would type-check through `satisfies`? No — but the walk costs nothing and
  catches a key that is a function of the wrong arity).
- **No stray literals:** a test reads every `app/*.tsx`/`app/*.ts` outside `app/i18n/` and the tests,
  and fails on any Japanese character. This is the mechanical guard that a label did not escape the
  dictionary. English has no such scan; the review carries it.
- **Existing tests render in one explicit language.** The API fakes' `whoAmI` returns
  `language: "ja"` by default; a test asserting English copy sets `"en"`. Assertions on long copy
  reference the dictionary (`ja.today.emptyDay`); short labels may stay literal.
- **Resolution and toggle:** `resolveLanguage` table test; the toggle switches copy, sets `lang`,
  calls `setLanguage`, and survives a failed save.
- Worker: `languageFor`/`setLanguage` round-trip, unknown code refused, `whoAmI` carries it, surface
  pins, `capnweb-validate build`.

## Out of scope

Agent-facing text (`types.txt`, the OS confirmation card, server error details), the Workshop shell,
calendar/number localisation beyond the formats above, right-to-left, a third language (adding one is
a dictionary file plus a row in `UI_LANGUAGES`).

## Dependency

`@phosphor-icons/react` (already in the workspace: workshop-frontend, gatekeeper-context,
gatekeeper-scheduler) added to `gatekeeper-kintai` at the same version. One named import; the
single-file bundles tree-shake the rest.
