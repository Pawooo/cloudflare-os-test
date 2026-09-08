import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmployeeMonth, EmployeeMonthDay, KintaiEmployeeClient, PunchRow } from "../src/types";
import { jstWorkDate } from "../src/work-date";
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

/** One day of the employee's own month, everything but the fields under test defaulted to inert. */
function monthDay(overrides: Partial<EmployeeMonthDay> = {}): EmployeeMonthDay {
  return {
    workDate: "2026-09-01",
    workedMinutes: 0,
    anomalies: [],
    overtime: null,
    ...overrides,
  };
}

/** A `myMonth` return for the given period built from a day list. */
function employeeMonth(period: string, days: EmployeeMonthDay[]): EmployeeMonth {
  return { period, days };
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
    // Pinned: 今日 files against `jstWorkDate(Date.now())`, and the assertion below names the day
    // the fixtures are built on. Left to the real clock this passed on the day it was written and
    // failed the morning after.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:00:00+09:00"));
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

  // ---- 今月: the month a worker reads back --------------------------------------------------
  describe("今月 (my-month)", () => {
    // The picker opens on the month the employee is in, in JST — never UTC, which reports the
    // previous month for the first nine hours of every Japanese day. `myMonth` is asked for that
    // same period on mount, so the read and the label agree.
    it("defaults the picker to the current JST month and reads it", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(
        async (period) => employeeMonth(period, []),
      );
      const api = employeeApi({ myMonth });
      await render(<EmployeePage api={api} />);

      expect(inMonth('[data-testid="month-label"]').textContent).toBe(currentMonth);
      expect(myMonth).toHaveBeenCalledWith(currentMonth);
    });

    // The same bound 月次 carries: the next button never walks past the current month (there is no
    // month there yet to read), and going backwards has no bound at all.
    it("bounds next at the current month and leaves prev unbounded, re-reading on a move", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(
        async (period) => employeeMonth(period, []),
      );
      const api = employeeApi({ myMonth });
      await render(<EmployeePage api={api} />);

      // At the current month the next button is disabled; prev is live.
      expect(inMonth<HTMLButtonElement>('[data-action="next-month"]').disabled).toBe(true);
      expect(inMonth<HTMLButtonElement>('[data-action="prev-month"]').disabled).toBe(false);

      // Stepping back moves the label and reads the earlier month; next is now live.
      const [prevYear, prevMonth] = shiftedMonth(currentMonth, -1);
      await click('[data-testid="panel-month"] [data-action="prev-month"]');
      expect(inMonth('[data-testid="month-label"]').textContent).toBe(`${prevYear}-${prevMonth}`);
      expect(myMonth).toHaveBeenCalledWith(`${prevYear}-${prevMonth}`);
      expect(inMonth<HTMLButtonElement>('[data-action="next-month"]').disabled).toBe(false);

      // Prev keeps stepping back with no floor.
      await click('[data-testid="panel-month"] [data-action="prev-month"]');
      const [prev2Year, prev2Month] = shiftedMonth(currentMonth, -2);
      expect(inMonth('[data-testid="month-label"]').textContent).toBe(`${prev2Year}-${prev2Month}`);

      // Stepping forward returns to the current month, where next disables again.
      await click('[data-testid="panel-month"] [data-action="next-month"]');
      await click('[data-testid="panel-month"] [data-action="next-month"]');
      expect(inMonth('[data-testid="month-label"]').textContent).toBe(currentMonth);
      expect(inMonth<HTMLButtonElement>('[data-action="next-month"]').disabled).toBe(true);
    });

    // One row per EmployeeMonthDay, the worked column `Xh Ym` — the 月次 convention, always both
    // units so the column stays flush.
    it("renders one row per day with 労働時間 as Xh Ym", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(async (period) => employeeMonth(period, [
        monthDay({ workDate: `${currentMonth}-01`, workedMinutes: 495 }),
        monthDay({ workDate: `${currentMonth}-02`, workedMinutes: 60 }),
      ]));
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      const rows = month().querySelectorAll("[data-month-day]");
      expect(rows).toHaveLength(2);
      expect(inMonth(`[data-month-day="${currentMonth}-01"] [data-testid="worked"]`).textContent)
        .toBe("8h 15m");
      expect(inMonth(`[data-month-day="${currentMonth}-02"] [data-testid="worked"]`).textContent)
        .toBe("1h 0m");
    });

    // A day WITH an overtime request shows the request and its state. A day WITHOUT one shows no
    // overtime — never a zero that a reader could take for a claim of no minutes owed.
    it("shows overtime + state where present, and nothing where absent", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(async (period) => employeeMonth(period, [
        monthDay({
          workDate: `${currentMonth}-01`, workedMinutes: 600,
          overtime: { minutes: 90, state: "pending" },
        }),
        monthDay({ workDate: `${currentMonth}-02`, workedMinutes: 480, overtime: null }),
      ]));
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      const withOt = inMonth(`[data-month-day="${currentMonth}-01"] [data-testid="overtime"]`);
      expect(withOt.textContent).toContain("1h 30m");
      expect(withOt.textContent).toContain("承認待ち");

      // The day with no request renders an empty overtime cell — no minutes, no state, no zero.
      const noOt = inMonth(`[data-month-day="${currentMonth}-02"] [data-testid="overtime"]`);
      expect(noOt.textContent!.trim()).toBe("");
      expect(noOt.textContent).not.toContain("0h");
      expect(noOt.textContent).not.toContain("承認");
    });

    // A flagged day carries a marker, in plain language — never the raw wire flag.
    it("marks a day whose anomalies are non-empty, in plain language", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(async (period) => employeeMonth(period, [
        monthDay({ workDate: `${currentMonth}-01`, workedMinutes: 300, anomalies: ["unpaired_in"] }),
        monthDay({ workDate: `${currentMonth}-02`, workedMinutes: 480, anomalies: [] }),
      ]));
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      const flagged = inMonth(`[data-month-day="${currentMonth}-01"] [data-testid="day-anomalies"]`);
      expect(flagged.textContent).toContain("退勤打刻なし");
      expect(flagged.textContent).not.toContain("unpaired_in");
      // The clean day carries no marker.
      expect(month().querySelector(
        `[data-month-day="${currentMonth}-02"] [data-testid="day-anomalies"]`,
      )).toBeNull();
    });

    // The guardrail against a pending number reading as money owed: the claims-not-payouts line is
    // present, and its exact wording is pinned here so it cannot quietly soften into a promise.
    it("states that overtime figures are claims awaiting approval, not payouts", async () => {
      await render(<EmployeePage api={employeeApi()} />);

      expect(inMonth('[data-testid="claims-note"]').textContent).toBe(
        "残業時間は承認待ちの申請であり、承認されるまで支給額ではありません — overtime shown here is a claim awaiting approval, not a payout.",
      );
    });

    // An empty month is a statement, not a blank space.
    it("says so when the month has no days", async () => {
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(
        async (period) => employeeMonth(period, []),
      );
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      expect(month().textContent).toContain("打刻がありません");
      expect(month().querySelectorAll("[data-month-day]")).toHaveLength(0);
    });

    // A failed read is rendered through describeFailure, next to the picker that could re-ask.
    it("renders a month read failure through describeFailure", async () => {
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(async () => {
        throw new Error("KINTAI_INVALID_INPUT: period must be YYYY-MM.");
      });
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      expect(month().textContent).toContain("Period must be YYYY-MM.");
    });

    // Nothing here navigates or submits, so every control — the picker buttons included — is an
    // inert `type="button"`, and the panel adds no form/select/textarea the host sandbox forbids.
    it("keeps every 今月 control an inert button and adds no form/select/textarea", async () => {
      const currentMonth = jstWorkDate(Date.now()).slice(0, 7);
      const myMonth = vi.fn<KintaiEmployeeClient["myMonth"]>(async (period) => employeeMonth(period, [
        monthDay({ workDate: `${currentMonth}-01`, workedMinutes: 480, anomalies: ["unpaired_in"] }),
      ]));
      await render(<EmployeePage api={employeeApi({ myMonth })} />);

      const buttons = month().querySelectorAll("button");
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute("type")).toBe("button");
      }
      expect(month().querySelectorAll("form, select, textarea")).toHaveLength(0);
    });
  });

  /** `period` moved by `delta` whole months, as `[year, month]` zero-padded strings. */
  function shiftedMonth(period: string, delta: number): [string, string] {
    const months = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + delta;
    const year = Math.floor(months / 12);
    const monthNo = months - year * 12 + 1;
    return [String(year).padStart(4, "0"), String(monthNo).padStart(2, "0")];
  }

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

  function month(): HTMLElement {
    return field<HTMLElement>('[data-testid="panel-month"]');
  }

  function inMonth<T extends Element>(selector: string): T {
    const element = month().querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector} in 今月`);
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
