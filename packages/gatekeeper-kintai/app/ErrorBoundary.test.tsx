import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";
import { ja } from "./i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The crash screen, and specifically WHOSE WORDS IT SAYS.
 *
 * `ErrorBoundary` is a class component, so it cannot call `useT()` — a hook is the only way into
 * the language context. The two words come in as an optional `labels` prop instead, passed by a
 * wrapper that reads `useT()` on the provider's side of the boundary (see `employee-main.tsx`).
 *
 * THE DEFAULT IS TRANSITIONAL, AND THAT IS WHY THE FIRST TEST EXISTS. `main.tsx` (the admin entry)
 * still mounts this boundary with no provider above it, and a fallback screen that threw looking
 * for a language context would replace a caught render error with an uncaught one — the one failure
 * mode a boundary must not have. So the default stands until the admin screen is migrated, at which
 * point the prop should become required and the default should go. The English strings are
 * duplicated here on purpose rather than imported: an assertion that read `DEFAULT_LABELS` would
 * agree with whatever the default happened to say, where these pin the wording and make both
 * REMOVING and REWORDING the default a visible, deliberate change to this file.
 */
describe("ErrorBoundary", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    // React logs a caught render error through `console.error`, twice. The throw below is the
    // subject of the test, not a surprise, so its noise is silenced rather than read.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
    vi.restoreAllMocks();
  });

  /** A child that fails on render — the only way in to the state this component exists for. */
  function Boom(): React.ReactNode {
    throw new Error("kintai test: a render that fails");
  }

  it("says so in English when no labels are given, and offers an inert reload", async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(container!.textContent).toContain("Something went wrong");
    const reload = container!.querySelector("button")!;
    expect(reload.textContent).toBe("Reload");
    // `type="button"`, like every control in this app: the host's iframe carries
    // `sandbox="allow-scripts allow-modals"` with no `allow-forms`, so a `type="submit"` here would
    // be silently inert. Not pressed — `location.reload()` is not a thing to do to a test runner.
    expect(reload.getAttribute("type")).toBe("button");
  });

  it("says so in the language it is given when labels are passed", async () => {
    await render(
      <ErrorBoundary labels={{ crashed: ja.common.crashed, reload: ja.common.reload }}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(container!.textContent).toContain(ja.common.crashed);
    expect(container!.querySelector("button")!.textContent).toBe(ja.common.reload);
    // The default is not showing through anywhere: one language per screen, the crash screen too.
    expect(container!.textContent).not.toContain("Something went wrong");
    expect(container!.textContent).not.toContain("Reload");
  });

  it("renders its children untouched while nothing has failed", async () => {
    await render(
      <ErrorBoundary>
        <p data-testid="child">still fine</p>
      </ErrorBoundary>,
    );

    expect(container!.querySelector('[data-testid="child"]')!.textContent).toBe("still fine");
    expect(container!.querySelector("button")).toBeNull();
  });

  async function render(element: React.ReactNode): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
  }
});
