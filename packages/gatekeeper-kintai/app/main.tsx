import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type { UiLanguage } from "../src/types";
import AdminPage, { type KintaiAdminClient } from "./AdminPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { LanguageProvider, resolveLanguage, useT } from "./i18n";
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
 * It follows a toggle too: a switch rerenders this, so a crash after a switch speaks the language
 * the reader chose rather than the one the page opened in.
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

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
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
  host
    .subscribeTheme(iframe)
    .then(applyAppTheme)
    .catch(() => {});

  const root = createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("kintai.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  });

  const start = (language: UiLanguage) => {
    root.render(
      <LanguageProvider initial={language}>
        <TranslatedBoundary>
          <AdminPage api={host.ui} />
        </TranslatedBoundary>
      </LanguageProvider>,
    );
  };

  /*
   * WHICH LANGUAGE THIS SCREEN OPENS IN, decided here and once.
   *
   * `whoAmI()` carries the choice saved against this account (`null` if the person has never
   * pressed the toggle) and `navigator.language` is the browser's own preference;
   * `resolveLanguage` combines them, saved choice first. `AdminPage` is not asked to work this out
   * — it takes the answer through the provider — and nothing below reads `navigator`.
   *
   * The first render waits for that one round trip, deliberately: rendering earlier would mean
   * painting the wrong language at somebody who has told us which one they read, and then either
   * leaving it wrong or remounting the whole dashboard — and all three of its panels' reads —
   * underneath them. The frame before it lands is the host's own background, which the page's
   * `<style>` already paints.
   *
   * A REFUSED OR DROPPED `whoAmI` STILL RENDERS, on the browser's language. `AdminPage` calls
   * `whoAmI` again itself and shows its own failure where an administrator can read it (the retry
   * beside it is the way out); withholding the screen here would replace that with a blank page
   * and no explanation.
   */
  void (async () => {
    let chosen: UiLanguage | null = null;
    try {
      chosen = (await host.ui.whoAmI()).language;
    } catch {
      // Nothing to report: the preference is a nicety, and `AdminPage`'s own `load` reports this
      // same failure through `describeFailure` where the reader can see it.
    }
    start(resolveLanguage(chosen, navigator.language));
  })();
}

main();
