import { describe, expect, it, vi } from "vitest";
import type { UiLanguage } from "../../src/types";
import {
  createHostFollower, createLanguageSource, followHost, localeToLanguage,
} from "./language-source";

/**
 * THE LANGUAGE AS A STORE, AND THE GLUE THAT FOLLOWS THE SHELL.
 *
 * Three things live here, and they are tested apart from React on purpose. `createLanguageSource`
 * is the tiny external store `LanguageProvider` subscribes to with `useSyncExternalStore` — the
 * shell pushes a language into a plain object and every screen below re-renders, with no page
 * holding a copy of the answer and no entry re-rendering the tree by hand. `followHost` decides
 * what one push means and does it. `createHostFollower` holds the state that makes a push readable
 * at all: the locale already being followed, the account row as this page believes it stands, and
 * whether the last save was refused.
 *
 * They are FUNCTIONS rather than lines inside `main.tsx` for exactly one reason: the entry points
 * cannot be rendered in a test — they post a handshake to `window.parent` and open an RPC session
 * over a `MessageChannel` on import — so anything worth asserting about the push has to be
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
 *
 * WHAT A PUSH IS NOT: an event about the language. The shell re-pushes the WHOLE theme whenever any
 * part of it changes, and one of those re-pushes lands on a page that has only just opened — the
 * shell's accent colour arrives from `useServerConfig()` after the first push. So the locale
 * arriving again UNCHANGED is the common case, and `previousLocale` is what separates the two: only
 * a locale that differs from the one this page is already following is somebody choosing.
 */
describe("followHost", () => {
  it("switches the screen to the pushed language and mirrors it onto the account", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: "ja", previousLocale: null, saved: null, saveFailed: false,
      navigatorLanguage: "en-US", source, save,
    });

    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenCalledWith("ja");
    expect(save).toHaveBeenCalledTimes(1);
  });

  /*
   * "SYSTEM" FORGETS, AND THE SCREEN FORGETS WITH IT — the fix for the live pass's §4.
   *
   * Picking system in the shell saves `null`, which deletes the account row. The screen must go
   * with it, to the BROWSER: resolving through the account first would show the language that is
   * being deleted, so "system" would mean "the last thing you picked" for the rest of the session
   * while `whoAmI()` already said null. The account is not consulted on a change for exactly that
   * reason — this push is what overwrites it.
   */
  it("clears the account and follows the browser at once when the shell says system", async () => {
    const source = createLanguageSource("ja");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: null, previousLocale: "ja", saved: "ja", saveFailed: false,
      navigatorLanguage: "en-US", source, save,
    });

    expect(source.get()).toBe("en");
    expect(save).toHaveBeenCalledWith(null);
  });

  it("reaches the browser on system when the account has nothing saved either", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: null, previousLocale: "en", saved: null, saveFailed: false,
      navigatorLanguage: "ja-JP", source, save,
    });

    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenCalledWith(null);
  });

  /*
   * AN EXPLICIT CHOICE DOES NOT ASK THE ACCOUNT ANYTHING.
   *
   * `saved` is passed and deliberately unread on a change: the reader has just said which language
   * they want, and the row is about to say the same thing. Pinned with an account and a browser
   * that both disagree with the choice, so consulting either would show.
   */
  it("resolves an explicit choice without consulting the account it overwrites", async () => {
    const source = createLanguageSource("ja");
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: "en", previousLocale: null, saved: "ja", saveFailed: false,
      navigatorLanguage: "ja-JP", source, save,
    });

    expect(source.get()).toBe("en");
    expect(save).toHaveBeenCalledWith("en");
  });

  /*
   * THE RE-PUSH THAT MUST DO NOTHING AT ALL — the defect this wave exists for.
   *
   * A fresh device, an account that says 日本語, the shell on system: the page opens in Japanese off
   * the account. Then the shell re-pushes the same theme (its accent colour landing late, or the
   * reader flipping dark mode). Saving `localeToLanguage(null)` here would DELETE the account row
   * that is the only reason this screen is in Japanese — cross-device memory gone, with nobody
   * having touched the language.
   */
  it("does nothing when a re-push carries the locale already being followed", () => {
    const source = createLanguageSource("ja");
    const listener = vi.fn();
    source.subscribe(listener);
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    const pending = followHost({
      locale: null, previousLocale: null, saved: "ja", saveFailed: false,
      navigatorLanguage: "en-US", source, save,
    });

    expect(pending).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(source.get()).toBe("ja");
    expect(listener).not.toHaveBeenCalled();
  });

  /*
   * ...UNLESS THE LAST SAVE WAS REFUSED, in which case the re-push is the retry.
   *
   * The screen is already right and must not be disturbed — the reader chose this language and can
   * see it. What is wrong is the account, and any push at all is a chance to fix it.
   */
  it("retries a refused save on an unchanged re-push, without touching the screen", async () => {
    const source = createLanguageSource("ja");
    const listener = vi.fn();
    source.subscribe(listener);
    const save = vi.fn(async (_language: UiLanguage | null) => {});

    await followHost({
      locale: "ja", previousLocale: "ja", saved: null, saveFailed: true,
      navigatorLanguage: "en-US", source, save,
    });

    expect(save).toHaveBeenCalledWith("ja");
    expect(save).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(source.get()).toBe("ja");
  });

  /*
   * A REFUSED SAVE COSTS THE MEMORY, NEVER THE SWITCH.
   *
   * The promise is returned rather than swallowed so the caller can report it — `createHostFollower`
   * sends it to `onSaveError`, which is `reportIssue` in both entries, and shows nothing: the
   * control now belongs to the shell and Kintai has nowhere honest to put a notice about a button
   * that is not on its screen. Reverting the source instead would take away the thing that worked
   * because the thing that did not work failed.
   */
  it("rejects when the save is refused, leaving the switch that already happened alone", async () => {
    const source = createLanguageSource("en");
    const save = vi.fn(async (_language: UiLanguage | null) => {
      throw new Error("the session went away");
    });

    const pending = followHost({
      locale: "ja", previousLocale: null, saved: null, saveFailed: false,
      navigatorLanguage: "en-US", source, save,
    });
    if (pending === null) throw new Error("a change must attempt a save");
    await expect(pending).rejects.toThrow("the session went away");

    expect(source.get()).toBe("ja");
  });
});

/**
 * THE STATE BETWEEN PUSHES, which is what makes a push readable at all.
 *
 * `followHost` is pure and therefore cannot know whether the locale it is handed is news. The
 * follower is the three values that make that decision possible — the locale this page is already
 * following, what it believes is on the account row, and whether the last save was refused — and it
 * is a factory rather than lines in the entry points because both entries had the same bookkeeping
 * and only one of them could be tested (an entry posts a handshake to `window.parent` on import).
 */
describe("createHostFollower", () => {
  it("stays quiet on an opening re-push, then follows every change the shell makes", async () => {
    // A fresh device: nothing in the shell's storage (system), 日本語 on the account, an English
    // browser. The page opened in Japanese because of the account row.
    const source = createLanguageSource("ja");
    const save = vi.fn(async (_language: UiLanguage | null) => {});
    const onSaveError = vi.fn();
    const follower = createHostFollower({
      initialLocale: null, saved: "ja", navigatorLanguage: "en-US", source, save, onSaveError,
    });

    // The shell's accent colour arrives late and the whole theme is pushed again. Nobody chose
    // anything, so nothing is written and nothing moves.
    follower.follow(null);
    expect(save).not.toHaveBeenCalled();
    expect(source.get()).toBe("ja");
    expect(follower.saved).toBe("ja");

    follower.follow("en");
    expect(source.get()).toBe("en");
    expect(save).toHaveBeenLastCalledWith("en");
    await vi.waitFor(() => expect(follower.saved).toBe("en"));

    follower.follow("ja");
    expect(source.get()).toBe("ja");
    expect(save).toHaveBeenLastCalledWith("ja");
    await vi.waitFor(() => expect(follower.saved).toBe("ja"));

    // Back to system: the row goes, and the screen goes with it — to the browser, not to the row
    // it just deleted.
    follower.follow(null);
    expect(source.get()).toBe("en");
    expect(save).toHaveBeenLastCalledWith(null);
    await vi.waitFor(() => expect(follower.saved).toBeNull());

    expect(save).toHaveBeenCalledTimes(3);
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("reports a refused save once, retries it on the next push, and remembers only on success", async () => {
    const source = createLanguageSource("ja");
    const save = vi.fn<(language: UiLanguage | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("the session went away"))
      .mockResolvedValue(undefined);
    const onSaveError = vi.fn();
    const follower = createHostFollower({
      initialLocale: null, saved: "ja", navigatorLanguage: "en-US", source, save, onSaveError,
    });

    follower.follow("en");
    expect(source.get()).toBe("en");
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1));
    // The switch stands; the account still says what it said, because the write never landed.
    expect(source.get()).toBe("en");
    expect(follower.saved).toBe("ja");

    // The next re-push carries the same locale — normally a no-op, here the retry.
    follower.follow("en");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("en");
    await vi.waitFor(() => expect(follower.saved).toBe("en"));

    // And once the account is right again, an unchanged re-push is a no-op once more.
    follower.follow("en");
    expect(save).toHaveBeenCalledTimes(2);
    expect(onSaveError).toHaveBeenCalledTimes(1);
  });
});
