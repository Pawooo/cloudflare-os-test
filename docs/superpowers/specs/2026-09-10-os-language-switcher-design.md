# A language switcher in the OS shell, followed by every gatekeeper app

**Status:** approved in conversation 2026-09-10. Placement: the sidebar utility strip beside the
dark-mode picker. Kintai side: its own header toggle goes; the per-account save stays as
cross-device memory.

## Why

Kintai's i18n (2026-09-09) put an A→文 toggle inside Kintai's own iframe because the OS gave a
gatekeeper app nothing about language. The owner meant a **global** switcher in the shell. The shell
already has the exact pattern for a per-browser preference that every gatekeeper iframe follows:
dark mode — read from `localStorage`, picked in the sidebar utility strip, pushed into each iframe
as a theme message and re-pushed on change. Language is the same kind of thing and rides the same
channel.

Two commits, deliberately separate: **the OS patch** (shared type + shell), small and general enough
to offer upstream, and **the Kintai patch** that consumes it.

## The OS patch (upstreamable)

### Shared type — `packages/workshop-shared/src/theme.ts`

```ts
export const APP_LOCALES = ["en", "ja"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export interface GatekeeperAppTheme {
  mode: "light" | "dark";
  accentColor: string | null;
  /**
   * The language the person picked in the shell, or null when they left it on "system" — i.e.
   * the app should decide from its own knowledge (a saved preference, then the browser).
   */
  locale: AppLocale | null;
}
```

Additive: an app that ignores `locale` is unaffected. `APP_LOCALES` is the one list of languages
the shell offers; an app that supports a subset maps the rest to its own default.

### Shell — `packages/workshop-frontend/src`

- `locale.ts` mirrors `theme.ts`: `type LocaleChoice = "system" | AppLocale`, storage key
  `gadgets:locale`, `readLocaleChoice()`, `writeLocaleChoice()`, `resolveLocale(choice,
  navigatorLanguage): AppLocale` (`ja*` → `ja`, else `en`; `system` resolves through the browser).
  Storage failures are swallowed exactly as `writeThemeMode` swallows them.
- `LocaleContext.tsx` mirrors `ThemeContext.tsx`: `LocaleProvider` + `useLocale()` giving
  `{ localeChoice, resolvedLocale, setLocaleChoice }`. Mounted in `main.tsx` beside `ThemeProvider`.
- `components/AppShell/SidebarUtilityStrip.tsx`: a `LocaleButton` beside `ThemeModeButton`, same
  markup and classes, Phosphor `Translate` at 15px, cycling `system → en → ja → system` like the
  theme cycles. Tooltip and `aria-label` follow the theme button's sentence shape, each language
  named in its own script: `Language: system (English). Switch to English.` /
  `Language: English. Switch to 日本語.` / `Language: 日本語. Switch to system.` The shell's own
  text stays English — there is no shell translation to hook into, and this patch does not add one.
- `SandboxedGatekeeperApp.tsx`: the theme message becomes `{ mode, accentColor, locale }` where
  `locale = localeChoice === "system" ? null : localeChoice`, and the push effect re-fires on it.
  Sending null for "system" is what lets an app fall back to its OWN memory of the person (Kintai's
  account save) before the browser; sending the browser-resolved value would make that memory dead.

## The Kintai patch

- **Precedence, decided once per open and again on every push:** OS choice (`theme.locale`) →
  the choice saved on the account (`whoAmI().language`) → the browser (`navigator.language`).
  `resolveLanguage` gains the OS value as its first argument.
- **First paint waits for both** `subscribeTheme` (which returns the current theme) and `whoAmI`,
  in parallel — the same reasoning as today's wait for `whoAmI`: never paint the wrong language at
  someone who has said which one they read.
- **Live follow:** `AppIframe.setTheme` feeds `theme.locale` into the language source the provider
  subscribes to (`useSyncExternalStore`), so a switch in the shell re-renders Kintai at once, the
  way dark mode already does.
- **The account save mirrors the OS choice, null included.** `setLanguage(language: UiLanguage |
  null)` on both facets; null deletes the row. So picking "system" in the shell clears the memory
  and Kintai genuinely follows the browser again — without this, "system" would silently mean "the
  last thing you picked" for Kintai alone. A failed save is reported through `reportIssue`, not
  shown: the control belongs to the shell now and Kintai has nowhere honest to put a notice.
- **Kintai's `LanguageToggle` is deleted**, with its test; the dictionary, guard, provider and
  `useT()` stay untouched. One control, one rule.
- `UI_LANGUAGES` in `src/types.ts` stays (the zero-import leaf cannot import the shared list); a
  worker test asserts it equals `APP_LOCALES` so the two cannot drift.

## Tests

- Shell: `locale.ts` table; `LocaleButton` cycles, persists, labels; `SandboxedGatekeeperApp.test`'s
  theme pin gains `locale` (null on system, the code otherwise) and a re-push on change.
- Kintai worker: `setLanguage(null)` deletes; `UI_LANGUAGES` = `APP_LOCALES`; surface pins.
- Kintai app: precedence table incl. OS null; `setTheme({locale:"ja"})` re-renders in 日本語 and calls
  `setLanguage("ja")`; `setTheme({locale:null})` calls `setLanguage(null)` and falls back to the
  account/browser; no `language-toggle` in either header; the no-stray-literals guard unchanged.
- Live pass in headless Chrome: pick 日本語 in the strip → Kintai switches without reload; reopen in
  an `en-US` context with empty `localStorage` → still 日本語 (the account); pick system → browser
  language, and the account row is gone.

## Out of scope

Translating the shell itself; a third language (one entry in `APP_LOCALES`, one dictionary in each
app); per-user server-side storage in the Workshop (the shell has a real origin and `localStorage`,
as dark mode proves sufficient).
