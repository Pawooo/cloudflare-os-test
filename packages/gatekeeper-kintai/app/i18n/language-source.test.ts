import { describe, expect, it, vi } from "vitest";
import type { UiLanguage } from "../../src/types";
import { createLanguageSource, followHost, localeToLanguage } from "./language-source";

/**
 * THE LANGUAGE AS A STORE, AND THE GLUE THAT FOLLOWS THE SHELL.
 *
 * Two things live here, and they are tested apart from React on purpose. `createLanguageSource` is
 * the tiny external store `LanguageProvider` subscribes to with `useSyncExternalStore` — the shell
 * pushes a language into a plain object and every screen below re-renders, with no page holding a
 * copy of the answer and no entry re-rendering the tree by hand. `followHost` is the four lines
 * that run on each push: resolve the new language, put it in the store, mirror the OS choice onto
 * the account.
 *
 * `followHost` is a FUNCTION rather than lines inside `main.tsx` for exactly one reason: the entry
 * points cannot be rendered in a test — they post a handshake to `window.parent` and open an RPC
 * session over a `MessageChannel` on import — so anything worth asserting about the push has to be
 * reachable without them. What is left in the entries is wiring: a stub call and a `reportIssue`.
 */
describe("createLanguageSource", () => {
  it("hands back the language it was created with", () => {
    expect(createLanguageSource("ja").get()).toBe("ja");
    expect(createLanguageSource("en").get()).toBe("en");
  });

  it("notifies every subscriber on a switch, and reports the new language", () => {
    const source = createLanguageSource("ja");
    const first = vi.fn();
    const second = vi.fn();
    source.subscribe(first);
    source.subscribe(second);

    source.set("en");

    expect(source.get()).toBe("en");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  /*
   * A push that changes nothing notifies nobody.
   *
   * The shell re-pushes the WHOLE theme on any of its parts — flipping dark mode sends the locale
   * again unchanged — so "set to what it already is" is the common case, not a corner one.
   * `useSyncExternalStore` would bail out on the identical snapshot anyway; not waking it at all
   * is cheaper and makes the store honest about what a notification means.
   */
  it("says nothing when the language set is the one already showing", () => {
    const source = createLanguageSource("ja");
    const listener = vi.fn();
    source.subscribe(listener);

    source.set("ja");

    expect(listener).not.toHaveBeenCalled();
    expect(source.get()).toBe("ja");
  });

  // `subscribe` returns its own unsubscribe, the shape `useSyncExternalStore` requires, and one
  // subscriber leaving must not silence the others.
  it("stops notifying a subscriber that has unsubscribed, and only that one", () => {
    const source = createLanguageSource("ja");
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = source.subscribe(leaving);
    source.subscribe(staying);

    unsubscribe();
    source.set("en");

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });
});

/**
 * The shell's locale, read as one of Kintai's two languages — or as "no answer".
 *
 * `AppLocale` and `UiLanguage` are the same two codes today and are still two types: `APP_LOCALES`
 * is the list the OS offers and `UI_LANGUAGES` is the list this bundle has a dictionary for, and
 * the day those differ this function is the one place that has to decide what an unsupported
 * locale becomes. `null` is not a language and must not become one: it is the shell saying
 * "system", which is a question for `resolveLanguage`, not an answer.
 */
describe("localeToLanguage", () => {
  it("passes a locale this app has words for straight through", () => {
    expect(localeToLanguage("ja")).toBe("ja");
    expect(localeToLanguage("en")).toBe("en");
  });

  it("keeps system as no answer at all, rather than a language", () => {
    expect(localeToLanguage(null)).toBeNull();
  });
});

/**
 * ONE PUSH FROM THE SHELL, END TO END.
 *
 * Two things happen and they are independent: the screen switches (free — both dictionaries are
 * already in the bundle) and the account row is brought into line with the OS choice (a round
 * trip that can fail). The switch never waits on the save and is never undone by it, which is the
 * same rule Kintai's own toggle followed before the shell took the control over.
 */
describe("followHost", () => {
  it("switches the screen to the pushed language and mirrors it onto the account", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: "ja", saved: null, navigatorLanguage: "en-US", source, save,
    });

    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenCalledWith("ja");
    expect(save).toHaveBeenCalledTimes(1);
  });

  /*
   * "SYSTEM" FORGETS, IT DOES NOT REMEMBER.
   *
   * Picking system in the shell saves `null`, which deletes the account row. Without that, system
   * would quietly mean "the last language you picked" for Kintai alone — the reader would ask for
   * the browser's language and keep getting the old one, on every device, forever. The screen
   * meanwhile falls back through the account (as it stood a moment ago) to the browser.
   */
  it("clears the account and falls back to it, then the browser, when the shell says system", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: null, saved: "ja", navigatorLanguage: "en-US", source, save,
    });

    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenCalledWith(null);
  });

  it("reaches the browser on system when the account has nothing saved either", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: null, saved: null, navigatorLanguage: "ja-JP", source, save,
    });

    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenCalledWith(null);
  });

  /*
   * A REFUSED SAVE COSTS THE MEMORY, NEVER THE SWITCH.
   *
   * The promise is returned rather than swallowed so the caller can report it — `main.tsx` sends
   * it to `reportIssue` and shows nothing, because the control now belongs to the shell and Kintai
   * has nowhere honest to put a notice about a button that is not on its screen. Reverting the
   * source instead would take away the thing that worked because the thing that did not work
   * failed.
   */
  it("rejects when the save is refused, leaving the switch that already happened alone", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {
      throw new Error("the session went away");
    });

    await expect(followHost({
      locale: "ja", saved: null, navigatorLanguage: "en-US", source, save,
    })).rejects.toThrow("the session went away");

    expect(source.get()).toBe("ja");
  });
});
