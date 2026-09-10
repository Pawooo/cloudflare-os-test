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
 * One push from the shell: switch the screen if the language changed, and bring the account row
 * into line with it if it did.
 *
 * A PUSH IS NOT AN EVENT ABOUT THE LANGUAGE. The shell re-pushes the WHOLE theme whenever any part
 * of it changes, so the locale arrives again unchanged when the reader flips dark mode — and, more
 * quietly, on a plain page open, because the shell's accent colour comes from `useServerConfig()`
 * and lands after the first push. Treating every push as a choice made `save(localeToLanguage(
 * null))` run on a fresh device whose account said 日本語, deleting the cross-device memory with
 * nobody having touched anything. `previousLocale` is the whole difference between the two, which
 * is why it is a parameter and not something this function could work out.
 *
 * SO THERE ARE THREE CASES:
 *
 *   changed — somebody chose. Switch, then mirror the choice onto the account.
 *   unchanged, last save refused — the screen is already right, the account is not. Retry only.
 *   unchanged, nothing owed — do nothing at all, and say so by returning null.
 *
 * ON A CHANGE THE ACCOUNT IS NOT CONSULTED: the language is resolved as `(locale, null, browser)`.
 * The row is about to be overwritten or deleted by this very push, so falling back through it
 * would show the value being thrown away — which is exactly how "system" left the open screen in
 * the language it had just deleted (the live pass's §4), while `whoAmI()` already said null.
 * `saved` is still taken, and still deliberately unread here, because it is the value the tests
 * prove does not matter.
 *
 * WHY THE SAVE MIRRORS `null` TOO. Picking "system" in the shell must DELETE the account row, not
 * leave the last choice sitting there: otherwise "system" would quietly mean "whatever you last
 * picked" for Kintai alone, on every device, and the reader could never get back to their
 * browser's language.
 *
 * TWO INDEPENDENT THINGS, and the order matters. The switch is free — both dictionaries are
 * already in the bundle — so it happens first and unconditionally. The save is a round trip that
 * can fail, and a failure costs the reader the memory of their choice, never the switch they can
 * already see. That is the same rule Kintai's own toggle followed before the shell took the
 * control over; what changed is where the failure is reported, because there is no longer a button
 * on this screen to put a notice under (`createHostFollower` sends it to `onSaveError`).
 *
 * The promise is returned rather than swallowed so the caller can report a rejection. Nothing here
 * catches it: this function has no way to tell a reader anything.
 */
export function followHost({
  locale, previousLocale, saveFailed, navigatorLanguage, source, save,
}: {
  /** `theme.locale` as pushed: one of the OS locales, or null for "system". */
  locale: AppLocale | null;
  /** The locale this page is already following — the one the last push (or the first paint) used. */
  previousLocale: AppLocale | null;
  /**
   * The language on the account as this page believes it stands.
   *
   * Taken and NOT read. A change overwrites the row, so resolving through it would show the value
   * being replaced; an unchanged push does not touch the screen at all. It stays in the shape
   * because the caller holds it and because "the account is ignored here" is a claim worth being
   * able to test.
   */
  saved: UiLanguage | null;
  /** Whether the last save was refused — if so, an unchanged push is this one's retry. */
  saveFailed: boolean;
  /** `navigator.language`, passed in so this stays a pure function of its arguments. */
  navigatorLanguage: string | undefined;
  source: LanguageSource;
  /** `setLanguage` on either facet: the account row, written or deleted. */
  save: (language: UiLanguage | null) => Promise<void>;
}): Promise<void> | null {
  if (locale === previousLocale) {
    return saveFailed ? save(localeToLanguage(locale)) : null;
  }
  source.set(resolveLanguage(locale, null, navigatorLanguage));
  return save(localeToLanguage(locale));
}

/**
 * What a page reads a push AGAINST: the locale it is already following, its picture of the account
 * row, and whether the last save was refused.
 *
 * `followHost` is pure and so cannot know any of it. Both entry points kept this bookkeeping by
 * hand and kept it identically, and neither could be tested — an entry posts a handshake to
 * `window.parent` and opens an RPC session on import — so the state that decides whether a push
 * means anything lived in the one place no test could reach. It lives here instead.
 */
export type HostFollower = {
  /** Called with `theme.locale` on every push from the shell. */
  follow(locale: AppLocale | null): void;
  /**
   * What is on the account row, as far as this page knows: advanced only when a save resolves,
   * because a refused save changed nothing on the server and this must go on describing it.
   */
  readonly saved: UiLanguage | null;
};

export function createHostFollower({
  initialLocale, saved, navigatorLanguage, source, save, onSaveError,
}: {
  /**
   * The locale the FIRST PAINT used — `theme?.locale ?? null`, where `theme` is `iframe.latest`
   * or `subscribeTheme`'s answer. Not "null because nothing has been pushed yet": a push can beat
   * the reply back, and if this said null while the screen was painted from a real locale, the
   * next identical push would read as a change and write to the account.
   */
  initialLocale: AppLocale | null;
  /** `whoAmI().language`, or null when that read was refused or there has never been a choice. */
  saved: UiLanguage | null;
  navigatorLanguage: string | undefined;
  source: LanguageSource;
  save: (language: UiLanguage | null) => Promise<void>;
  /**
   * REPORTED, NOT SHOWN. The control that caused the failure is the shell's, in another frame;
   * Kintai has nowhere honest to put a notice about a button that is not on its screen, and the
   * switch the reader asked for has already happened either way. Both entries pass `reportIssue`.
   */
  onSaveError: (error: unknown) => void;
}): HostFollower {
  let lastLocale = initialLocale;
  let savedLanguage = saved;
  let saveFailed = false;

  return {
    /*
     * A closure, not a method reading `this`: the entries hand this straight to `AppIframe.follow`,
     * where it is called unbound.
     */
    follow: (locale) => {
      const pending = followHost({
        locale,
        previousLocale: lastLocale,
        saved: savedLanguage,
        saveFailed,
        navigatorLanguage,
        source,
        save,
      });
      lastLocale = locale;
      if (pending === null) return;

      // Read before the await: `locale` is what this save is writing, whatever arrives next.
      const mirrored = localeToLanguage(locale);
      void pending.then(
        () => {
          savedLanguage = mirrored;
          saveFailed = false;
        },
        (caught: unknown) => {
          saveFailed = true;
          onSaveError(caught);
        },
      );
    },
    get saved() {
      return savedLanguage;
    },
  };
}
