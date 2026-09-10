import {
  createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore,
  type ReactNode,
} from "react";
import type { UiLanguage } from "../../src/types";
import { DICTIONARIES, type Messages } from "./messages";
import type { LanguageSource } from "./language-source";

export { en, ja, DICTIONARIES, type Messages } from "./messages";
export {
  createLanguageSource, followHost, localeToLanguage, resolveLanguage, type LanguageSource,
} from "./language-source";

/**
 * Which language this screen is in, and every word it says in that language.
 *
 * The whole i18n mechanism, and there is no library behind it: one code held outside React, and
 * `useT()` returning one of two frozen objects. Call sites read `t.today.emptyDay` and
 * `t.pending.summary(n, m)` — typed property access, checked at compile time, with no key strings
 * and no lookup at runtime.
 *
 * WHERE THE LANGUAGE COMES FROM, and why this component does not decide it: the OS shell pushes
 * its picker's value into this iframe (`theme.locale`), the choice saved against the account
 * arrives on `whoAmI()`'s `KintaiIdentity.language`, and the browser's own preference is
 * `navigator.language`. `resolveLanguage` combines the three, and it is the ENTRY POINT that
 * calls it — the entry is what holds the host capability and the identity, and a provider that
 * read `navigator` itself would be a global for every test of every screen to stub. This
 * component takes the answer.
 *
 * WHY A SOURCE AND NOT A PROP. The answer changes AFTER the first render, whenever somebody
 * touches the picker in the sidebar, and the push lands in `AppIframe.setTheme` — outside React
 * entirely, in an entry point that has no state and no component of its own. `useSyncExternalStore`
 * over a `LanguageSource` is how that reaches the tree without re-rendering it from the root: a
 * `root.render` per push would remount every panel and re-run every read behind it.
 */
type LanguageState = {
  language: UiLanguage;
  /** Switch the whole screen. Presentation only: saving the choice is the caller's own business. */
  setLanguage: (language: UiLanguage) => void;
  t: Messages;
};

const LanguageContext = createContext<LanguageState | undefined>(undefined);

export function LanguageProvider({
  source, children,
}: {
  /**
   * The language, held outside React so the host can change it — built by the entry point from
   * `resolveLanguage(theme.locale, identity.language, navigator.language)` and written to on
   * every theme push. See `language-source.ts`.
   */
  source: LanguageSource;
  children: ReactNode;
}) {
  /*
   * `source.subscribe` and `source.get` are passed unbound, which is safe because
   * `createLanguageSource` builds them as closures over its own state rather than as methods
   * reading `this`. Their identity is stable for the life of the source, so React subscribes once
   * — a fresh `subscribe` on each render would unsubscribe and resubscribe on every one.
   */
  const language = useSyncExternalStore(source.subscribe, source.get);

  const setLanguage = useCallback((next: UiLanguage) => source.set(next), [source]);

  /*
   * `<html lang>`, owned here and in one place.
   *
   * It belongs to whoever knows the current language, which is this component: an effect keyed on
   * the language covers the FIRST paint as well as every switch, where an assignment made where
   * the language is CHOSEN would leave a Japanese first open declaring itself English until
   * something changed it. A screen reader picks its voice off this attribute, and the browser
   * picks a font and a hyphenation dictionary.
   *
   * `document.documentElement` and not `localStorage`: the host's iframe is an opaque origin with
   * no storage at all, which is the reason the choice lives server-side in the first place.
   */
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageState>(
    () => ({ language, setLanguage, t: DICTIONARIES[language] }),
    [language, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/**
 * Every word this screen says, in the language it is in.
 *
 * Throws outside a provider rather than falling back to English, and that is deliberate: a silent
 * fallback would render a Japanese employee's screen in English with nothing anywhere to say why,
 * which is precisely the failure this whole exercise exists to remove.
 */
export function useT(): Messages {
  return useLanguageState().t;
}

/**
 * The current language and the way to change it.
 *
 * NO CONTROL IN THIS APP CALLS THE SETTER ANY MORE — the language is the shell's to change, and
 * Kintai's own toggle was deleted on 2026-09-10. The pair is kept because the setter is the
 * honest counterpart of the source (a component that needed to switch would write to the same
 * place the host writes to, rather than inventing a second answer), and because a reader of this
 * module should be able to see that the two directions exist.
 */
export function useLanguage(): [UiLanguage, (language: UiLanguage) => void] {
  const { language, setLanguage } = useLanguageState();
  return [language, setLanguage];
}

function useLanguageState(): LanguageState {
  const state = useContext(LanguageContext);
  if (state === undefined) {
    throw new Error("Kintai i18n: this component is outside a <LanguageProvider>.");
  }
  return state;
}
