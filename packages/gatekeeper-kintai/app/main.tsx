import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import AdminPage, { type KintaiAdminClient } from "./AdminPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

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

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("kintai.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      <AdminPage api={host.ui} />
    </ErrorBoundary>,
  );
}

main();
