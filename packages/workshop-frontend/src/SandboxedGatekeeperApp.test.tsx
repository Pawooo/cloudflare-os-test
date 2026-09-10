// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import { LocaleProvider, useLocale } from "./LocaleContext";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

const listGadgets = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);
const authenticatedApi = { listGadgets };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  setPresenting(active: boolean): Promise<{
    rect: { left: number; top: number; width: number; height: number } | null;
    willResize: boolean;
  }>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
}

class EmptyUi extends RpcTarget {}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  readonly themes: GatekeeperAppTheme[] = [];
  setTheme(theme: GatekeeperAppTheme): void {
    this.themes.push(theme);
  }
}

// Lets a test drive the shell's language choice from inside the provider the host reads.
function LocaleSwitch({ to }: { to: "system" | "en" | "ja" }) {
  const { setLocaleChoice } = useLocale();
  return (
    <button type="button" data-testid="switch" onClick={() => setLocaleChoice(to)}>
      {`Switch to ${to}`}
    </button>
  );
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listGadgets.mockClear();
    window.localStorage.clear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => (
        <LocaleProvider>
          <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />
        </LocaleProvider>
      ),
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
      // "system" is sent as null so the app can consult its own memory of the person first.
      locale: null,
    });
    /*
     * SUBSCRIBING IS NOT A PUSH, and an app is entitled to rely on that.
     *
     * `subscribeTheme` answers with the current theme; `setTheme` is only ever a CHANGE afterwards.
     * Kintai reads a push against the locale it is already showing and writes to the account when
     * they differ, so a push that merely repeated the reply would look like a person choosing.
     * (What does arrive later, unbidden, is the deployment's accent colour resolving from
     * `useServerConfig()` — the same theme with the same locale. That one is why the app has to
     * compare rather than trust.)
     */
    expect(themeReceiver.themes).toEqual([]);

    await act(async () => {
      await host!.setPresenting(true);
    });
    expect(iframe.style.position).toBe("fixed");
    expect(iframe.style.top).toBe("calc(var(--app-top) + env(safe-area-inset-top))");
    expect(iframe.style.bottom).toBe("calc(var(--app-bottom) + env(safe-area-inset-bottom))");
    expect(iframe.style.width).toBe(
      "calc(100vw - (env(safe-area-inset-left) + env(safe-area-inset-right)))",
    );
    expect(iframe.style.height).toBe(
      "calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    );

    await act(async () => {
      await host!.setPresenting(false);
    });
    expect(iframe.style.position).toBe("");
    expect(iframe.style.width).toBe("100%");
    expect(iframe.style.height).toBe("100%");

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listGadgets
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(2);

    await expect(host.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });

  it("carries the shell's language choice and re-pushes it when it changes", async () => {
    window.localStorage.setItem("gadgets:locale", "ja");
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => (
        <LocaleProvider>
          <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />
          <LocaleSwitch to="system" />
        </LocaleProvider>
      ),
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({ history, routeTree: rootRoute.addChildren([indexRoute]) });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
      locale: "ja",
    });
    // Again: the reply is not a push. Nothing has been sent to the receiver yet.
    expect(themeReceiver.themes).toEqual([]);

    const switchButton = container.querySelector<HTMLButtonElement>('[data-testid="switch"]');
    await act(async () => switchButton!.click());
    await vi.waitFor(() =>
      expect(themeReceiver.themes.at(-1)).toEqual({
        mode: "light",
        accentColor: "#7c3aed",
        locale: null,
      }),
    );
    // One change, one push — the app must not be told twice about a single click either.
    expect(themeReceiver.themes).toHaveLength(1);
  });
});
