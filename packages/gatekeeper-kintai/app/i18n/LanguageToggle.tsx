import { useEffect, useRef, useState } from "react";
import { Translate } from "@phosphor-icons/react";
import { UI_LANGUAGES, type UiLanguage } from "../../src/types";
import { useLanguage, useT } from "./index";

/**
 * What the toggle needs from the capability, and deliberately nothing else.
 *
 * Both real clients satisfy it — `KintaiAdminClient` (`AdminPage.tsx`) and `KintaiEmployeeClient`
 * (`src/types.ts`) each declare `setLanguage` — so this control sits in the header of both pages
 * without knowing which one it is on, and a test hands it one method rather than a whole fake
 * dashboard.
 */
export type LanguageApi = {
  setLanguage(language: UiLanguage): Promise<void>;
};

/**
 * The one control that changes the language of the whole screen.
 *
 * THE SWITCH IS OPTIMISTIC, AND THE SAVE IS NOT PART OF IT. Pressing this changes the language
 * immediately — both dictionaries are already in the bundle, so there is nothing to wait for — and
 * THEN asks the capability to remember it. If that save is refused, the switch stands and a small
 * notice says what did not happen. Reverting the screen instead would take away the thing that
 * worked because the thing that did not work failed, and the reader would be left pressing a
 * button that appears to do nothing.
 *
 * The notice is in the NEW language, which is the only language the reader is now reading.
 *
 * The glyph is Phosphor's `Translate` (the A→文 mark) at 18px, beside the OTHER language's own
 * name: "日本語" while in English, "English" while in 日本語. Its own name, never a translation of
 * it — a reader hunting for their language looks for the word they would write it with, and
 * "Japanese" is no use to somebody who cannot read the screen it is printed on. `aria-label` is in
 * the CURRENT language, because it is read by somebody who is still on this side of the switch.
 *
 * `type="button"`, like every control in this app: the host's iframe carries
 * `sandbox="allow-scripts allow-modals"` with no `allow-forms`, so Chrome blocks form submission
 * outright and a `type="submit"` button in this frame is silently inert.
 *
 * `<html lang>` is NOT set here. It is set by `LanguageProvider`, in an effect keyed on the
 * language, so the first paint declares itself correctly too rather than only after a press.
 */
export function LanguageToggle({ api }: { api: LanguageApi }) {
  const [language, setLanguage] = useLanguage();
  const t = useT();
  const [notSaved, setNotSaved] = useState(false);
  // The same guard every read on these screens uses, re-armed in the effect body rather than only
  // by `useRef`: a header unmounted mid-save must not set state, and a mount → unmount → remount
  // (React StrictMode double-invokes exactly this pair) must not leave the ref stuck false.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  /*
   * The language this button offers. Written as "the first one that is not the current one" rather
   * than `language === "en" ? "ja" : "en"` so that adding a third language is a row in
   * `UI_LANGUAGES` and a dictionary file, exactly as the design says — at which point this control
   * becomes a menu and this line is where that starts, instead of a hidden two-language assumption.
   */
  const other: UiLanguage = UI_LANGUAGES.find((code) => code !== language) ?? language;
  const otherName = t.labels.languageNames[other];

  const switchTo = async () => {
    setLanguage(other);
    // Cleared before the call, not after: the notice is about the press that is happening now, and
    // leaving a stale warning up would report a choice as unsaved after it had been saved.
    setNotSaved(false);
    try {
      await api.setLanguage(other);
    } catch {
      // Nothing is reported to the error channel and nothing is rethrown: a preference that did
      // not persist is not a failure of the screen, and the reader has already been told.
      if (live.current) setNotSaved(true);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="language-toggle"
        aria-label={t.header.language.switchTo(otherName)}
        className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
        onClick={() => void switchTo()}
      >
        {/* Decorative: the name beside it already says what this does, and the `aria-label` on the
            button says it in a sentence. */}
        <Translate size={18} aria-hidden="true" />
        {otherName}
      </button>
      {notSaved && (
        <p
          data-testid="language-not-saved"
          role="status"
          className="max-w-56 text-right text-xs text-kumo-subtle"
        >
          {t.header.language.notSaved}
        </p>
      )}
    </div>
  );
}
