import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type { KintaiEmployeeClient, UiLanguage } from "../src/types";
import EmployeePage from "./EmployeePage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { LanguageProvider, useT } from "./i18n";
import {
  createLanguageSource, followHost, localeToLanguage, resolveLanguage, type LanguageSource,
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
 * `main.tsx` has the same four lines. Not shared, deliberately: a module holding it would have to
 * be imported by both entries to save four lines that say nothing either entry does not already
 * say, and the two entry points otherwise share nothing at all.
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
 * `latest`, which is what the first render resolves from. Deliberately not replayed through
 * `follow` when it is set — the mirror onto the account is what a person CHANGING the language
 * asks for, and merely opening the page must not write to their account.
 */
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  /** The newest theme the host has pushed, or undefined while none has arrived. */
  latest: GatekeeperAppTheme | undefined;
  /** Where a push goes once there is a language source to write to. */
  follow: ((theme: GatekeeperAppTheme) => void) | undefined;

  setTheme(theme: GatekeeperAppTheme): void {
    this.latest = theme;
    applyAppTheme(theme);
    this.follow?.(theme);
  }
}

/**
 * What the Workshop exposes to this iframe. `ui` is the capability `startAppUi` handed this viewer;
 * on this entry it is always the employee one (`EmployeeKintaiApi`), because the Workshop only ever
 * serves this bundle to a non-admin. The page still cannot tell which class is behind the stub, by
 * design — the same property `main.tsx` documents — it just has no admin methods to reach for.
 *
 * The host also offers workspace navigation to gatekeeper apps that want it. None is declared here
 * because this page opens nothing.
 */
interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<KintaiEmployeeClient>;
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
          <EmployeePage api={host.ui} />
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
   * own preference. The page is not asked to work any of this out — it takes the answer through
   * the provider — and nothing below reads `navigator`.
   *
   * BOTH ROUND TRIPS, IN PARALLEL, BEFORE THE FIRST RENDER. `allSettled` rather than `all`
   * because neither is allowed to withhold the screen; parallel because they are independent and
   * the wait is what the reader sees. Rendering earlier would mean painting the wrong language at
   * somebody who has told us which one they read, and then either leaving it wrong or remounting
   * the whole screen (and its `getDay` read) underneath them. The frame before they land is the
   * host's own background, which the page's `<style>` already paints.
   *
   * A REFUSED OR DROPPED `whoAmI` STILL RENDERS, on the OS choice or the browser's language: the
   * screen a worker needs to clock in on must not be withheld because a preference could not be
   * read, and `EmployeePage`'s own reads report their own failures where they happen. A refused
   * `subscribeTheme` likewise costs the appearance and nothing else.
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

    /*
     * `saved` is the account row as it stands, and it is BOOKKEEPING, not a constant.
     *
     * Every mirror that succeeds changes what is on the account, and the next push that says
     * "system" falls back through this value — so if it were left at what `whoAmI` returned, a
     * reader who picked 日本語 in the shell and then picked system would fall back to whatever
     * they had saved months ago instead of to the 日本語 they just asked for and had saved.
     * Updated only after the save resolves: a refused save changed nothing on the server, and
     * this must go on describing the server.
     */
    let saved: UiLanguage | null = identity.status === "fulfilled" ? identity.value.language : null;

    const source = createLanguageSource(
      resolveLanguage(theme?.locale ?? null, saved, navigator.language),
    );

    iframe.follow = (next) => {
      const mirrored = localeToLanguage(next.locale);
      void followHost({
        locale: next.locale,
        saved,
        navigatorLanguage: navigator.language,
        source,
        save: (language) => host.ui.setLanguage(language),
      }).then(
        () => { saved = mirrored; },
        // REPORTED, NOT SHOWN. The control that caused this is the shell's, in another frame;
        // Kintai has nowhere honest to put a notice about a button that is not on its screen, and
        // the switch the reader actually asked for has already happened either way.
        (caught: unknown) => reportIssue("kintai.language-save", caught),
      );
    };

    start(source);
  })();
}

main();
