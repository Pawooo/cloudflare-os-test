import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KintaiEmployeeClient } from "../src/types";
import EmployeePage from "./EmployeePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The employee capability, every method a `vi.fn`. The minimal shell calls none of them — the
 * panels are placeholders Tasks 5-6 fill — so nothing here has a return of consequence; the mock
 * exists only so `EmployeePage`'s one prop is the real `KintaiEmployeeClient` shape rather than a
 * cast, which is what will catch a method's signature drifting out from under the page.
 */
function employeeApi(overrides: Partial<KintaiEmployeeClient> = {}): KintaiEmployeeClient {
  return {
    whoAmI: vi.fn<KintaiEmployeeClient["whoAmI"]>(async () => ({
      accountId: "acct-emp", linked: true, employeeId: 7,
    })),
    getDay: vi.fn<KintaiEmployeeClient["getDay"]>(async () => ({
      punches: [], allocations: [], anomalies: [], locked: false,
      reconciliation: { allocatedMinutes: 0, workedMinutes: 0, discrepancyMinutes: 0 },
    })),
    myMonth: vi.fn<KintaiEmployeeClient["myMonth"]>(async (period) => ({ period, days: [] })),
    punch: vi.fn<KintaiEmployeeClient["punch"]>(async () => ({
      punchId: 1, employeeId: 7, workDate: "2026-09-07",
    })),
    requestMissingPunch: vi.fn<KintaiEmployeeClient["requestMissingPunch"]>(async () => 1),
    requestPunchCorrection: vi.fn<KintaiEmployeeClient["requestPunchCorrection"]>(async () => 1),
    listMySubmissions: vi.fn<KintaiEmployeeClient["listMySubmissions"]>(async () => []),
    withdrawSubmission: vi.fn<KintaiEmployeeClient["withdrawSubmission"]>(async () => {}),
    resubmit: vi.fn<KintaiEmployeeClient["resubmit"]>(async () => {}),
    ...overrides,
  };
}

describe("EmployeePage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  // 今日 is the tab an employee opens this page to act on, so it is the one showing first, and 今月
  // is already in the document behind it — mounted-and-hidden, exactly as `AdminPage`'s panels are,
  // so a switch reveals a panel rather than mounting one and re-running its read.
  it("opens on 今日 with 今月 mounted and hidden", async () => {
    await render(<EmployeePage api={employeeApi()} />);

    expect(tab("today").getAttribute("aria-selected")).toBe("true");
    expect(tab("month").getAttribute("aria-selected")).toBe("false");
    expect(panel("today").hidden).toBe(false);
    expect(panel("month").hidden).toBe(true);
    // Both mounted from the first render — the hidden one is present, not absent.
    expect(panel("month")).not.toBeNull();
    expect(tab("today").textContent).toBe("今日");
    expect(tab("month").textContent).toBe("今月");
  });

  it("reveals 今月 on click and hides 今日, without remounting either", async () => {
    await render(<EmployeePage api={employeeApi()} />);
    const monthPanelBefore = panel("month");

    await click('[data-testid="tab-month"]');

    expect(tab("month").getAttribute("aria-selected")).toBe("true");
    expect(tab("today").getAttribute("aria-selected")).toBe("false");
    expect(panel("month").hidden).toBe(false);
    expect(panel("today").hidden).toBe(true);
    // The same node, not a fresh mount: switching tabs hides and shows, it does not rebuild.
    expect(panel("month")).toBe(monthPanelBefore);
  });

  // Nothing here navigates or submits, so the tabs are `type="button"` — inert if ever moved into
  // a `<form>`, which the host sandbox would otherwise silently break. The same guard `AdminPage`'s
  // tab bar carries.
  it("uses inert buttons for the tabs, not form controls", async () => {
    await render(<EmployeePage api={employeeApi()} />);

    for (const id of ["today", "month"] as const) {
      expect(tab(id).tagName).toBe("BUTTON");
      expect(tab(id).getAttribute("type")).toBe("button");
    }
    expect(container!.querySelectorAll("form, select, textarea")).toHaveLength(0);
  });

  async function render(element: React.ReactNode): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
  }

  function field<T extends Element>(selector: string): T {
    const element = container!.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }

  function tab(id: "today" | "month"): HTMLElement {
    return field<HTMLElement>(`[data-testid="tab-${id}"]`);
  }

  function panel(id: "today" | "month"): HTMLElement {
    return field<HTMLElement>(`[data-testid="panel-${id}"]`);
  }

  async function click(selector: string): Promise<void> {
    const element = field<HTMLElement>(selector);
    await act(async () => element.click());
  }
});
