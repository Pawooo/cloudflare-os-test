import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiLanguage } from "../../src/types";
import { LanguageProvider, useLanguage, useT } from "./index";
import { LanguageToggle } from "./LanguageToggle";
import { en, ja } from "./messages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the toggle needs from the capability, and nothing else.
 *
 * Both real clients carry `setLanguage` (`KintaiAdminClient`, `KintaiEmployeeClient`), so the
 * toggle takes the narrowest shape either satisfies rather than one of the two: it sits in the
 * header of both pages and must not know which one it is on.
 */
function toggleApi(setLanguage = vi.fn(async (_language: UiLanguage) => {})) {
  return { setLanguage };
}

/** Reads the provider back out, so a test can assert the switch and not just the button. */
function Probe() {
  const [language] = useLanguage();
  const t = useT();
  return (
    <p data-testid="probe">
      {language}
      {" · "}
      {t.header.appName}
      {" · "}
      {t.tabs.roster}
    </p>
  );
}

describe("LanguageToggle", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const documentLanguage = document.documentElement.lang;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.documentElement.lang = documentLanguage;
    vi.restoreAllMocks();
  });

  it("offers the OTHER language, by its own name, on a button that cannot submit", async () => {
    await render(<LanguageToggle api={toggleApi()} />, "en");

    const button = toggle();
    // Never "submit": the host's iframe sandbox omits `allow-forms`, so a submit button in this
    // frame does nothing at all — the property every control in this app is written around.
    expect(button.getAttribute("type")).toBe("button");
    // 日本語 while in English: the word a reader looking for their language would write.
    expect(button.textContent).toContain("日本語");
    expect(button.textContent).not.toContain("English");
    // The label is for the reader who is HERE, so it is in the language they are reading.
    expect(button.getAttribute("aria-label")).toBe(en.header.language.switchTo("日本語"));
    // The A→文 glyph, at the 18px the design fixes.
    const glyph = button.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("width")).toBe("18");
  });

  it("offers English, in English, while the screen is in Japanese", async () => {
    await render(<LanguageToggle api={toggleApi()} />, "ja");

    expect(toggle().textContent).toContain("English");
    expect(toggle().getAttribute("aria-label")).toBe(ja.header.language.switchTo("English"));
  });

  it("switches the screen, sets the document language, and saves the choice", async () => {
    const api = toggleApi();
    await render(
      <>
        <LanguageToggle api={api} />
        <Probe />
      </>,
      "en",
    );
    expect(text('[data-testid="probe"]')).toContain("Roster");

    await click();

    // The provider flipped, so everything reading `useT` is now Japanese.
    expect(text('[data-testid="probe"]')).toContain("ja · Kintai · 名簿");
    // The document says which language it is in, for the browser and for assistive technology.
    expect(document.documentElement.lang).toBe("ja");
    expect(api.setLanguage).toHaveBeenCalledWith("ja");
    expect(api.setLanguage).toHaveBeenCalledTimes(1);
    // And the button now offers the way back.
    expect(toggle().textContent).toContain("English");
  });

  /*
   * A REFUSED SAVE DOES NOT UNDO THE SWITCH.
   *
   * The switch is what the reader asked for and it costs nothing to honour: the dictionary is
   * already in the bundle. What failed is the part that would have remembered it for next time, so
   * that — and only that — is what the notice says. Reverting the screen instead would take away
   * the thing that worked because the thing that did not work failed.
   */
  it("keeps the switch when the save is refused, and says so in the new language", async () => {
    const api = toggleApi(vi.fn(async (_language: UiLanguage) => {
      throw new Error("the session went away");
    }));
    await render(
      <>
        <LanguageToggle api={api} />
        <Probe />
      </>,
      "en",
    );

    await click();

    expect(text('[data-testid="probe"]')).toContain("ja · Kintai · 名簿");
    expect(document.documentElement.lang).toBe("ja");
    // In the NEW language: the reader is now reading Japanese, so the one sentence explaining
    // what did not happen must be Japanese too.
    expect(text('[data-testid="language-not-saved"]')).toBe(ja.header.language.notSaved);
  });

  // The notice is about the last press, not a standing state of the screen: switching back after a
  // refusal that then succeeds must not leave a warning about a choice that did get saved.
  it("clears the notice when a later save succeeds", async () => {
    let fail = true;
    const api = toggleApi(vi.fn(async (_language: UiLanguage) => {
      if (fail) throw new Error("the session went away");
    }));
    await render(<LanguageToggle api={api} />, "en");

    await click();
    expect(container!.querySelector('[data-testid="language-not-saved"]')).not.toBeNull();

    fail = false;
    await click();

    expect(container!.querySelector('[data-testid="language-not-saved"]')).toBeNull();
    expect(api.setLanguage).toHaveBeenNthCalledWith(2, "en");
    expect(document.documentElement.lang).toBe("en");
  });

  // The page above the provider is told, so a screen holding the identity can keep its own copy in
  // step without reaching into the provider's state.
  it("tells the page which language the reader chose", async () => {
    const onChange = vi.fn<(language: UiLanguage) => void>();
    await render(<LanguageToggle api={toggleApi()} />, "en", onChange);

    await click();

    expect(onChange).toHaveBeenCalledWith("ja");
  });

  async function render(
    element: React.ReactNode,
    initial: UiLanguage,
    onChange?: (language: UiLanguage) => void,
  ): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LanguageProvider initial={initial} onChange={onChange}>{element}</LanguageProvider>,
      );
    });
    await settle();
  }

  // The press switches synchronously and calls `setLanguage` after, so the notice (or its absence)
  // is one microtask behind the click.
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function click(): Promise<void> {
    const button = toggle();
    await act(async () => button.click());
    await settle();
  }

  function toggle(): HTMLButtonElement {
    const button = container!.querySelector<HTMLButtonElement>('[data-testid="language-toggle"]');
    if (!button) throw new Error("Missing the language toggle");
    return button;
  }

  function text(selector: string): string {
    const node = container!.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    return node.textContent ?? "";
  }
});
