import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminPage, { type KintaiAdminClient } from "./AdminPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdminPage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  // The account code is the whole point of showing an unlinked employee this page: there is no
  // registry of provisioned accounts, so onboarding begins with them reading this string to HR.
  it("shows the account code and how to get onboarded when the account is unlinked", async () => {
    const whoAmI = vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
      accountId: "acct-1234", linked: false, employeeId: null,
    }));
    await render(<AdminPage api={{ whoAmI }} />);

    expect(container!.querySelector('[data-testid="account-id"]')!.textContent).toBe("acct-1234");
    expect(container!.querySelector('[data-testid="linked"]')!.textContent).toContain("HR");
    expect(container!.querySelector('[data-testid="employee-id"]')).toBeNull();
  });

  it("reports the employee record once the account is linked", async () => {
    const whoAmI = vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
      accountId: "acct-5678", linked: true, employeeId: 42,
    }));
    await render(<AdminPage api={{ whoAmI }} />);

    expect(container!.querySelector('[data-testid="account-id"]')!.textContent).toBe("acct-5678");
    expect(container!.querySelector('[data-testid="employee-id"]')!.textContent).toBe("42");
  });

  // A refusal from the capability must render as a message, not as an unhandled rejection that
  // takes the ErrorBoundary down — a non-admin reaching a refused method is an ordinary state.
  it("renders a message when the capability refuses", async () => {
    const whoAmI = vi.fn<KintaiAdminClient["whoAmI"]>(async () => {
      throw new Error("KINTAI_ADMIN_REQUIRED: nope");
    });
    await render(<AdminPage api={{ whoAmI }} />);

    expect(container!.querySelector('[data-testid="error"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="account-id"]')).toBeNull();
  });

  // It is a placeholder and has to stay one until the authorization gate behind it is reviewed.
  // Any control here would be the first thing built on an unreviewed identity-granting API.
  it("offers no controls at all", async () => {
    const whoAmI = vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
      accountId: "acct-9", linked: false, employeeId: null,
    }));
    await render(<AdminPage api={{ whoAmI }} />);

    expect(container!.querySelectorAll("button, input, form, select, textarea")).toHaveLength(0);
    expect(whoAmI).toHaveBeenCalledTimes(1);
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
