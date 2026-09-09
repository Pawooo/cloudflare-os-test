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
 * the language context. The two words come in as a REQUIRED `labels` prop instead, passed by a
 * wrapper that reads `useT()` on the provider's side of the boundary — `TranslatedBoundary`, which
 * both entries now have (`main.tsx` and `employee-main.tsx`).
 *
 * THE ENGLISH DEFAULT IS GONE, AND A TEST WENT WITH IT. `DEFAULT_LABELS` existed for exactly as
 * long as the admin entry mounted this boundary with no provider above it: a fallback screen that
 * threw looking for a language context would have replaced a caught render error with an uncaught
 * one, the one failure mode a boundary must not have. Both entries resolve a language before they
 * render now, so there is no call site left with nothing to pass — and the removal was visible
 * because a test had pinned the default's exact wording, which is the whole reason that test was
 * written. There is no default to fall back to, so there is nothing left for a third test to say.
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

  it("says so in the language it is given when labels are passed", async () => {
    await render(
      <ErrorBoundary labels={{ crashed: ja.common.crashed, reload: ja.common.reload }}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(container!.textContent).toContain(ja.common.crashed);
    const reload = container!.querySelector("button")!;
    expect(reload.textContent).toBe(ja.common.reload);
    // Nothing of the other language shows through: one language per screen, the crash screen too.
    // These two literals are what `DEFAULT_LABELS` used to say, kept here as the negative so its
    // reintroduction would be red rather than silent.
    expect(container!.textContent).not.toContain("Something went wrong");
    expect(container!.textContent).not.toContain("Reload");
    // `type="button"`, like every control in this app: the host's iframe carries
    // `sandbox="allow-scripts allow-modals"` with no `allow-forms`, so a `type="submit"` here would
    // be silently inert. Not pressed — `location.reload()` is not a thing to do to a test runner.
    expect(reload.getAttribute("type")).toBe("button");
  });

  it("renders its children untouched while nothing has failed", async () => {
    await render(
      <ErrorBoundary labels={{ crashed: ja.common.crashed, reload: ja.common.reload }}>
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
