import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  AppLocale,
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type { UiLanguage } from "../src/types";
import AdminPage, { type KintaiAdminClient } from "./AdminPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { LanguageProvider, useT } from "./i18n";
import {
  createHostFollower, createLanguageSource, resolveLanguage, type LanguageSource,
} from "./i18n/language-source";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

/**
 * The boundary, with its crash screen in the language the reader is reading.
 *
 * `ErrorBoundary` is a class component, so it cannot call `useT()` itself. This wrapper sits on the
 * PROVIDER's side of the boundary — inside `<LanguageProvider>`, outside `<ErrorBoundary>` — reads
 * the two words with a hook, and hands them down as props. Which is why the provider is the
 * outermost of the two: it has no failure mode of its own (a `useState`, an effect that assigns
 * `<html lang>`, and two frozen objects), so putting it above the boundary costs nothing, and
 * putting it below would have left the crash screen with keys it could not reach.
 *
 * It follows the shell too: a language push rerenders this, so a crash after a switch speaks the
 * language the reader chose rather than the one the page opened in.
 *
 * `employee-main.tsx` has the same four lines, unshared for the reason stated there.
 */
function TranslatedBoundary({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <ErrorBoundary labels={{ crashed: t.common.crashed, reload: t.common.reload }}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * What the Workshop pushes appearance into: light/dark, the accent seed, and — since 2026-09-10 —
 * the language picked in the shell's sidebar.
 *
 * `follow` is set AFTER the first render's inputs have landed, because the language source it
 * writes to does not exist until then. A push that arrives before that is not lost: it is kept in
 * `latest`, which is what the first render resolves from — and the locale it resolved from is what
 * the follower starts from, so the identical push that follows is correctly read as no news.
 * Deliberately not replayed through `follow` when it is set — the mirror onto the account is what
 * a person CHANGING the language asks for, and merely opening the page must not write to their
 * account.
 */
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  /** The newest theme the host has pushed, or undefined while none has arrived. */
  latest: GatekeeperAppTheme | undefined;
  /** Where the pushed locale goes once there is a language source to write to. */
  follow: ((locale: AppLocale | null) => void) | undefined;

  setTheme(theme: GatekeeperAppTheme): void {
    this.latest = theme;
    applyAppTheme(theme);
    this.follow?.(theme.locale);
  }
}

/**
 * What the Workshop exposes to this iframe. `ui` is the admin capability `startAppUi` handed this
 * viewer; on this entry it is always `AdminKintaiApi`, because the Workshop only ever serves this
 * bundle to an administrator (a non-admin gets `employee-main.tsx`'s). There is no admin flag on
 * this side to read and nothing to probe — the same property `employee-main.tsx` documents.
 *
 * The host also offers workspace navigation to gatekeeper apps that want it. None is declared here
 * because this page opens nothing.
 */
interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<KintaiAdminClient>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Kintai app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);

  const root = createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("kintai.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  });

  const start = (source: LanguageSource) => {
    root.render(
      <LanguageProvider source={source}>
        <TranslatedBoundary>
          <AdminPage api={host.ui} />
        </TranslatedBoundary>
      </LanguageProvider>,
    );
  };

  /*
   * WHICH LANGUAGE THIS SCREEN OPENS IN, decided here, and again on every push from the shell.
   *
   * THREE INPUTS IN A FIXED ORDER (`resolveLanguage`): the language picked in the OS shell
   * (`theme.locale`, arriving with the rest of the appearance), then the choice saved against
   * this account (`whoAmI().language`, `null` if there has never been one), then the browser's
   * own preference. `AdminPage` is not asked to work any of this out — it takes the answer
   * through the provider — and nothing below reads `navigator`.
   *
   * BOTH ROUND TRIPS, IN PARALLEL, BEFORE THE FIRST RENDER. `allSettled` rather than `all`
   * because neither is allowed to withhold the screen; parallel because they are independent and
   * the wait is what the reader sees. Rendering earlier would mean painting the wrong language at
   * somebody who has told us which one they read, and then either leaving it wrong or remounting
   * the whole dashboard — and all three of its panels' reads — underneath them. The frame before
   * they land is the host's own background, which the page's `<style>` already paints.
   *
   * A REFUSED OR DROPPED `whoAmI` STILL RENDERS, on the OS choice or the browser's language.
   * `AdminPage` calls `whoAmI` again itself and shows its own failure where an administrator can
   * read it (the retry beside it is the way out); withholding the screen here would replace that
   * with a blank page and no explanation. A refused `subscribeTheme` likewise costs the appearance
   * and nothing else.
   */
  void (async () => {
    const [pushed, identity] = await Promise.allSettled([
      host.subscribeTheme(iframe),
      host.ui.whoAmI(),
    ]);
    // `iframe.latest` first: a push can beat `subscribeTheme`'s own answer back, and it is the
    // newer of the two.
    const theme = iframe.latest
      ?? (pushed.status === "fulfilled" ? pushed.value : undefined);
    if (theme !== undefined) applyAppTheme(theme);

    const saved: UiLanguage | null =
      identity.status === "fulfilled" ? identity.value.language : null;
    const initialLocale = theme?.locale ?? null;

    const source = createLanguageSource(
      resolveLanguage(initialLocale, saved, navigator.language),
    );

    /*
     * WHAT HAPPENS ON EVERY LATER PUSH, and the state it is read against — all of it in
     * `createHostFollower`, where it can be tested (this file cannot be imported by one).
     *
     * `initialLocale` is the locale the paint above actually used, NOT null-for-nothing-yet: the
     * follower compares each push against it, and the shell re-pushes the whole theme when its
     * accent colour lands from `useServerConfig()`. Starting from the wrong value would make that
     * opening re-push look like a choice and write to the account of somebody who only opened
     * the page — deleting the row, when the shell is on "system".
     */
    const follower = createHostFollower({
      initialLocale,
      saved,
      navigatorLanguage: navigator.language,
      source,
      save: (language) => host.ui.setLanguage(language),
      onSaveError: (caught) => reportIssue("kintai.language-save", caught),
    });
    iframe.follow = follower.follow;

    start(source);
  })();
}

main();
