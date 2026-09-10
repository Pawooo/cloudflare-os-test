import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { UiLanguage } from "../../src/types";
import { LanguageProvider, useT } from "./index";
import { createLanguageSource, type LanguageSource } from "./language-source";
import { en, ja } from "./messages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<html lang>`, WHICH NOTHING ELSE ASSERTS.
 *
 * These two assertions used to live in `LanguageToggle.test.tsx` and went with it when the OS
 * shell took the language control over on 2026-09-10. The effect they cover is still in
 * `LanguageProvider` — it is the only writer of `document.documentElement.lang` in the app — so
 * without them the attribute could stop being set and every other test in the suite would stay
 * green: no screen renders it, no sweep reads it. A screen reader picks its voice off this
 * attribute and the browser picks a font and a hyphenation dictionary from it.
 *
 * Both entry pages ship `lang="en"` as a STATIC PLACEHOLDER in their `index.html`, which is wrong
 * for one of the two languages whichever it is, and neither entry knows which until the theme
 * push and `whoAmI()` have landed. So each case here starts from that placeholder and proves the
 * provider corrects it — on the first paint, and again on a push from the shell.
 */
function Probe() {
  return <p data-testid="probe">{useT().header.appName}</p>;
}

describe("LanguageProvider and the document language", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let source: LanguageSource | undefined;
  const documentLanguage = document.documentElement.lang;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    source = undefined;
    document.documentElement.lang = documentLanguage;
  });

  /*
   * THE FIRST PAINT, before anything has changed.
   *
   * The effect is keyed on the language rather than run only on a change, which is exactly what
   * makes this case work: a Japanese first open must not declare itself English to a screen
   * reader until somebody switches away and back.
   */
  it("declares the language it opened in, correcting the page's placeholder", async () => {
    await render("ja");

    expect(document.documentElement.lang).toBe("ja");
    // The provider really is rendering that language, so the attribute is not merely a coincidence
    // of the placeholder having been overwritten with something.
    expect(text('[data-testid="probe"]')).toBe(ja.header.appName);
  });

  /*
   * The other direction, from a DELIBERATELY WRONG placeholder.
   *
   * The pages ship `lang="en"`, so an English open would agree with the placeholder by accident
   * and this case would pass with the effect deleted. Starting it at `"ja"` is what makes it an
   * assertion about the provider rather than about the fixture.
   */
  it("declares English when English is what it opened in", async () => {
    await render("en", "ja");

    expect(document.documentElement.lang).toBe("en");
    expect(text('[data-testid="probe"]')).toBe(en.header.appName);
  });

  /*
   * AND AGAIN ON EVERY PUSH FROM THE SHELL.
   *
   * `source.set` is what `main.tsx` calls from `AppIframe.setTheme` (through `followHost`), so
   * this is the live switch as the document experiences it: the words change and the attribute
   * describing them changes with them, in the same commit.
   */
  it("follows the shell's push, so the attribute never describes the previous language", async () => {
    await render("ja");
    expect(document.documentElement.lang).toBe("ja");

    await act(async () => source!.set("en"));

    expect(document.documentElement.lang).toBe("en");
    expect(text('[data-testid="probe"]')).toBe(en.header.appName);
  });

  /**
   * Mounts a probe under a provider, over a document already declaring `placeholder` — `"en"` by
   * default, which is the static value both `index.html` files ship.
   */
  async function render(language: UiLanguage, placeholder = "en"): Promise<void> {
    document.documentElement.lang = placeholder;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    source = createLanguageSource(language);
    await act(async () => {
      root!.render(<LanguageProvider source={source!}><Probe /></LanguageProvider>);
    });
  }

  function text(selector: string): string {
    const node = container!.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    return node.textContent ?? "";
  }
});
