import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import type { UiLanguage } from "../../src/types";
import { DICTIONARIES, type Messages } from "./messages";

export { en, ja, resolveLanguage, DICTIONARIES, type Messages } from "./messages";

/**
 * Which language this screen is in, and every word it says in that language.
 *
 * The whole i18n mechanism, and there is no library behind it: a `useState` holding one of two
 * codes, and `useT()` returning one of two frozen objects. Call sites read `t.today.emptyDay` and
 * `t.pending.summary(n, m)` — typed property access, checked at compile time, with no key strings
 * and no lookup at runtime.
 *
 * WHERE THE INITIAL LANGUAGE COMES FROM, and why this component does not decide it: the choice
 * saved against the account arrives on `whoAmI()`'s `KintaiIdentity.language`, and the browser's
 * own preference is `navigator.language`. `resolveLanguage` combines them, and it is the PAGE that
 * calls it — the page is what holds the identity, and a provider that read `navigator` itself would
 * be a global for every test of every screen to stub. This component takes the answer.
 */
type LanguageState = {
  language: UiLanguage;
  /** Switch the whole screen. Presentation only: saving the choice is the toggle's own business. */
  setLanguage: (language: UiLanguage) => void;
  t: Messages;
};

const LanguageContext = createContext<LanguageState | undefined>(undefined);

export function LanguageProvider({
  initial, onChange, children,
}: {
  /** The language to open in — `resolveLanguage(identity.language, navigator.language)`. */
  initial: UiLanguage;
  /**
   * A switch happened. For the page that holds the identity, so its own copy of `language` can
   * follow without reaching into this component's state.
   *
   * NOT how the choice is saved: the toggle calls the capability, because a failed save is its
   * notice to render and the provider has nothing useful to do with the rejection.
   */
  onChange?: (language: UiLanguage) => void;
  children: ReactNode;
}) {
  const [language, setLanguageState] = useState<UiLanguage>(initial);

  /*
   * `onChange` read through a ref rather than closed over.
   *
   * Every page below will pass an inline arrow, so a fresh function identity arrives on every
   * ancestor render — and `AdminPage` rerenders on every keystroke in a roster form. Closing over
   * it would rebuild `setLanguage`, and with it the context value, on each of those, remounting
   * nothing but making every consumer of this context rerender for no reason.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next);
    onChangeRef.current?.(next);
  }, []);

  /*
   * `<html lang>`, owned here and in one place.
   *
   * It belongs to whoever knows the current language, which is this component and not the toggle:
   * an effect keyed on `language` covers the FIRST paint as well as every switch, where a
   * toggle-only assignment would leave a Japanese first open declaring itself English until
   * somebody pressed the button. A screen reader picks its voice off this attribute, and the
   * browser picks a font and a hyphenation dictionary.
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

/** The current language and the way to change it — what the toggle needs and nothing more. */
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
