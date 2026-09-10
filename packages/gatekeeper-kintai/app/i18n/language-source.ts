import type { AppLocale } from "@gadgets/workshop-shared/theme";
import { UI_LANGUAGES, type UiLanguage } from "../../src/types";
import { resolveLanguage } from "./messages";

export { resolveLanguage } from "./messages";

/**
 * The language of the screen, held outside React so the HOST can change it.
 *
 * `LanguageProvider` reads this through `useSyncExternalStore`. That indirection exists because
 * the thing that changes the language is no longer inside the tree: it is the OS shell's picker,
 * arriving over RPC at `AppIframe.setTheme` in an entry point that has already rendered and holds
 * no state of its own. The alternatives were worse — a `root.render` per push remounts the whole
 * dashboard and every read it holds, and an entry-owned `useState` needs a component to live in
 * that does not exist above the provider.
 *
 * `get` and `subscribe` are stable closures, not methods reading `this`: `useSyncExternalStore`
 * takes them unbound and resubscribes whenever `subscribe`'s identity changes.
 */
export type LanguageSource = {
  /** The language showing now. `useSyncExternalStore`'s snapshot, so it must be cheap and stable. */
  get(): UiLanguage;
  /** Switch every screen below the provider. Presentation only — saving is `followHost`'s job. */
  set(next: UiLanguage): void;
  /** Listen for switches; the returned function stops listening. */
  subscribe(onChange: () => void): () => void;
};

export function createLanguageSource(initial: UiLanguage): LanguageSource {
  let language = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => language,
    set: (next) => {
      /*
       * A set to the language already showing is dropped rather than announced.
       *
       * The shell re-pushes the WHOLE theme whenever any part of it changes, so flipping dark
       * mode sends the same locale again — "unchanged" is the common case here, not a corner one.
       * `useSyncExternalStore` would bail out on the identical snapshot anyway; not waking it is
       * cheaper, and it keeps a notification meaning "the language changed".
       */
      if (next === language) return;
      language = next;
      for (const listener of listeners) listener();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

/**
 * The shell's locale as one of this bundle's languages — or as no answer at all.
 *
 * `AppLocale` and `UiLanguage` are the same two codes today and are deliberately two types:
 * `APP_LOCALES` is what the OS offers and `UI_LANGUAGES` is what this bundle has a dictionary for.
 * The day they differ, this is the one place that decides what an unsupported locale becomes, and
 * the `includes` guard below is what will fail the build until somebody does.
 *
 * `null` STAYS `null`. It is the shell on "system" — a refusal to answer, not an answer — and
 * turning it into a language here would erase the whole point of the OS sending it: the app is
 * being asked to fall back to what IT knows about this person.
 */
export function localeToLanguage(locale: AppLocale | null): UiLanguage | null {
  if (locale === null) return null;
  return UI_LANGUAGES.includes(locale) ? locale : null;
}

/**
 * One push from the shell: switch the screen, and bring the account row into line with it.
 *
 * TWO INDEPENDENT THINGS, and the order matters. The switch is free — both dictionaries are
 * already in the bundle — so it happens first and unconditionally. The save is a round trip that
 * can fail, and a failure costs the reader the memory of their choice, never the switch they can
 * already see. That is the same rule Kintai's own toggle followed before the shell took the
 * control over; what changed is where the failure is reported, because there is no longer a
 * button on this screen to put a notice under (`main.tsx` sends it to `reportIssue`).
 *
 * WHY THE SAVE MIRRORS `null` TOO. Picking "system" in the shell must DELETE the account row, not
 * leave the last choice sitting there: otherwise "system" would quietly mean "whatever you last
 * picked" for Kintai alone, on every device, and the reader could never get back to their
 * browser's language. So the value saved is `localeToLanguage(locale)` — the OS choice verbatim,
 * `null` included — while the value SHOWN falls through to the account and then the browser.
 *
 * The promise is returned rather than swallowed so the caller can report a rejection. Nothing
 * here catches it: this function has no way to tell a reader anything.
 */
export function followHost({
  locale, saved, navigatorLanguage, source, save,
}: {
  /** `theme.locale` as pushed: one of the OS locales, or null for "system". */
  locale: AppLocale | null;
  /** The language on the account as it stands right now — see `main.tsx` on keeping this current. */
  saved: UiLanguage | null;
  /** `navigator.language`, passed in so this stays a pure function of its arguments. */
  navigatorLanguage: string | undefined;
  source: LanguageSource;
  /** `setLanguage` on either facet: the account row, written or deleted. */
  save: (language: UiLanguage | null) => Promise<void>;
}): Promise<void> {
  source.set(resolveLanguage(locale, saved, navigatorLanguage));
  return save(localeToLanguage(locale));
}
