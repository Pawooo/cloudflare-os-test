import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KintaiEmployeeClient, PunchRow } from "../src/types";
import EmployeePage, { nextPunchKind } from "./EmployeePage";

/** One current punch on today's day, everything but the fields under test defaulted to inert. */
function punchRow(overrides: Partial<PunchRow> = {}): PunchRow {
  return {
    id: 1,
    employee_id: 7,
    work_date: "2026-09-07",
    kind: "in",
    occurred_at: Date.parse("2026-09-07T09:00:00+09:00"),
    recorded_at: Date.parse("2026-09-07T09:00:00+09:00"),
    source: "gadget",
    latitude: null,
    longitude: null,
    accuracy_m: null,
    location_source: null,
    matched_site_id: null,
    supersedes_id: null,
    amended_by: null,
    amend_reason: null,
    ...overrides,
  };
}

/** A `getDay` return built from a punch list, with sensible day defaults. */
function day(punches: PunchRow[], overrides: Partial<Awaited<ReturnType<KintaiEmployeeClient["getDay"]>>> = {}) {
  return {
    punches, allocations: [], anomalies: [], locked: false,
    reconciliation: { allocatedMinutes: 0, workedMinutes: 0, discrepancyMinutes: 0 },
    ...overrides,
  };
}

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

  // ---- nextPunchKind: the shift state, read off the punches the way the store's pairing reads it.
  describe("nextPunchKind", () => {
    it("offers 出勤 (in) on a day with no punches", () => {
      expect(nextPunchKind([])).toEqual(["in"]);
    });

    it("offers 退勤 (out) and 休憩開始 (break_start) once a shift is open", () => {
      expect(nextPunchKind([punchRow({ kind: "in" })])).toEqual(["out", "break_start"]);
    });

    it("offers only 休憩終了 (break_end) inside an open break", () => {
      expect(nextPunchKind([
        punchRow({ id: 1, kind: "in" }),
        punchRow({ id: 2, kind: "break_start" }),
      ])).toEqual(["break_end"]);
    });

    it("returns to 出勤 after a clock-out closes the shift", () => {
      expect(nextPunchKind([
        punchRow({ id: 1, kind: "in" }),
        punchRow({ id: 2, kind: "out" }),
      ])).toEqual(["in"]);
    });

    it("reads a resumed shift the way pairing does: break ended, shift still open", () => {
      expect(nextPunchKind([
        punchRow({ id: 1, kind: "in" }),
        punchRow({ id: 2, kind: "break_start" }),
        punchRow({ id: 3, kind: "break_end" }),
      ])).toEqual(["out", "break_start"]);
    });
  });

  it("shows 出勤 on an empty day and punches `in` when pressed", async () => {
    const api = employeeApi({ getDay: vi.fn(async () => day([])) });
    await render(<EmployeePage api={api} />);

    expect(inToday('[data-punch="in"]').textContent).toBe("出勤");
    await click('[data-testid="panel-today"] [data-punch="in"]');

    expect(api.punch).toHaveBeenCalledWith("in");
  });

  it("shows 退勤 and 休憩開始 once clocked in, and punches the pressed kind", async () => {
    const api = employeeApi({ getDay: vi.fn(async () => day([punchRow({ kind: "in" })])) });
    await render(<EmployeePage api={api} />);

    expect(inToday('[data-punch="out"]').textContent).toBe("退勤");
    expect(inToday('[data-punch="break_start"]').textContent).toBe("休憩開始");
    await click('[data-testid="panel-today"] [data-punch="break_start"]');

    expect(api.punch).toHaveBeenCalledWith("break_start");
  });

  it("shows only 休憩終了 inside a break, and punches break_end", async () => {
    const api = employeeApi({ getDay: vi.fn(async () => day([
      punchRow({ id: 1, kind: "in" }), punchRow({ id: 2, kind: "break_start" }),
    ])) });
    await render(<EmployeePage api={api} />);

    expect(inToday('[data-punch="break_end"]').textContent).toBe("休憩終了");
    expect(today().querySelector('[data-punch="out"]')).toBeNull();
    await click('[data-testid="panel-today"] [data-punch="break_end"]');

    expect(api.punch).toHaveBeenCalledWith("break_end");
  });

  it("renders today's punches through PunchSource, not the raw source word", async () => {
    const api = employeeApi({ getDay: vi.fn(async () => day([
      punchRow({ id: 1, kind: "in", source: "gadget" }),
    ])) });
    await render(<EmployeePage api={api} />);

    const punches = today().querySelectorAll('[data-testid="punch"]');
    expect(punches).toHaveLength(1);
    expect(punches[0].textContent).toContain("本人打刻");
    expect(punches[0].textContent).not.toContain("gadget");
  });

  it("shows the empty-state line when there are no punches", async () => {
    const api = employeeApi({ getDay: vi.fn(async () => day([])) });
    await render(<EmployeePage api={api} />);

    expect(today().textContent).toContain("今日はまだ打刻がありません");
  });

  it("names an unpaired_in in plain language and files a correction as a REQUEST", async () => {
    const requestMissingPunch = vi.fn(async () => 1);
    const api = employeeApi({
      getDay: vi.fn(async () => day([punchRow({ kind: "in" })], { anomalies: ["unpaired_in"] })),
      requestMissingPunch,
    });
    await render(<EmployeePage api={api} />);

    // Plain language, never the wire flag.
    expect(today().textContent).toContain("退勤打刻なし");
    expect(today().textContent).not.toContain("unpaired_in");

    await setInput('[data-testid="correction-time"]', "18:30");
    await setInput('[data-testid="correction-reason"]', "退勤の打刻を忘れました");
    await click('[data-testid="panel-today"] [data-testid="file-correction"]');

    expect(requestMissingPunch).toHaveBeenCalledWith(
      "2026-09-07", "out", Date.parse("2026-09-07T18:30:00+09:00"), "退勤の打刻を忘れました",
    );
    // A request, awaiting a decision — never "fixed".
    expect(today().textContent).toContain("申請しました・承認待ち");
    expect(today().textContent!.toLowerCase()).not.toContain("fixed");
  });

  it("renders a punch failure through describeFailure", async () => {
    const api = employeeApi({
      getDay: vi.fn(async () => day([])),
      punch: vi.fn(async () => {
        throw new Error("KINTAI_INVALID_INPUT: you already clocked in.");
      }),
    });
    await render(<EmployeePage api={api} />);

    await click('[data-testid="panel-today"] [data-punch="in"]');

    expect(today().textContent).toContain("You already clocked in.");
  });

  // The core interaction: a punch must re-read the day so the control advances. Sequence `getDay`
  // — an empty day, then a day carrying the new `in` — and prove the UI reflects the SECOND read
  // (出勤 → 退勤/休憩開始), not just the first. If the reload after a punch is dropped, the button
  // stays 出勤 and this goes red.
  it("re-reads the day after a punch so the shift control advances", async () => {
    const getDay = vi.fn<KintaiEmployeeClient["getDay"]>();
    getDay.mockResolvedValueOnce(day([]));
    getDay.mockResolvedValue(day([punchRow({ kind: "in" })]));
    const api = employeeApi({ getDay });
    await render(<EmployeePage api={api} />);

    expect(getDay).toHaveBeenCalledTimes(1);
    expect(inToday('[data-punch="in"]').textContent).toBe("出勤");

    await click('[data-testid="panel-today"] [data-punch="in"]');

    // The write re-read the day, and the control redrew from what came back the second time.
    expect(getDay).toHaveBeenCalledTimes(2);
    expect(inToday('[data-punch="out"]').textContent).toBe("退勤");
    expect(inToday('[data-punch="break_start"]').textContent).toBe("休憩開始");
    expect(today().querySelector('[data-punch="in"]')).toBeNull();
  });

  // A filed correction is a write too, and the same reload must follow it — otherwise a day that
  // changed under an approver would keep showing the stale read. Assert the second `getDay`.
  it("re-reads the day after filing a correction", async () => {
    const getDay = vi.fn<KintaiEmployeeClient["getDay"]>(
      async () => day([punchRow({ kind: "in" })], { anomalies: ["unpaired_in"] }),
    );
    const api = employeeApi({ getDay, requestMissingPunch: vi.fn(async () => 1) });
    await render(<EmployeePage api={api} />);

    expect(getDay).toHaveBeenCalledTimes(1);

    await setInput('[data-testid="correction-time"]', "18:30");
    await setInput('[data-testid="correction-reason"]', "退勤の打刻を忘れました");
    await click('[data-testid="panel-today"] [data-testid="file-correction"]');

    expect(api.requestMissingPunch).toHaveBeenCalledTimes(1);
    expect(getDay).toHaveBeenCalledTimes(2);
    expect(today().textContent).toContain("申請しました・承認待ち");
  });

  it("keeps every 今日 control an inert button and adds no form/select/textarea", async () => {
    const api = employeeApi({
      getDay: vi.fn(async () => day([punchRow({ kind: "in" })], { anomalies: ["unpaired_in"] })),
    });
    await render(<EmployeePage api={api} />);

    for (const button of today().querySelectorAll("button")) {
      expect(button.getAttribute("type")).toBe("button");
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
    await settle();
  }

  // Let the mount read (and any read a click kicked off) resolve and flush its setState. The panel
  // loads `getDay` in an effect, so nothing it shows is on screen until the microtasks settle.
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function today(): HTMLElement {
    return field<HTMLElement>('[data-testid="panel-today"]');
  }

  function inToday<T extends Element>(selector: string): T {
    const element = today().querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector} in 今日`);
    return element;
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
    await settle();
  }

  async function setInput(selector: string, value: string): Promise<void> {
    const input = inToday<HTMLInputElement>(selector);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});
