import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PunchRow } from "../src/types";
import { PunchSource } from "./PunchSource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `PunchSource` is the one renderer for a punch's provenance, shared by the admin day drill-down
 * (`OverviewTab`) and the employee 今日 tab (Task 5). HR reads this; nobody reading it should ever
 * see the platform's internal vocabulary for how a punch was recorded — `punch.source` verbatim,
 * as `OverviewTab.tsx:473` used to render it.
 */
describe("PunchSource", () => {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  async function render(element: React.ReactNode): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
  }

  /** One punch row, with every non-source field defaulted to something inert. */
  function punch(overrides: Partial<PunchRow> = {}): PunchRow {
    return {
      id: 1,
      employee_id: 1,
      work_date: "2026-09-02",
      kind: "in",
      occurred_at: Date.parse("2026-09-02T09:00:00+09:00"),
      recorded_at: Date.parse("2026-09-02T09:00:00+09:00"),
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

  it("renders 本人打刻 for a self-recorded punch, not the raw word gadget", async () => {
    await render(<PunchSource punch={punch({ source: "gadget" })} />);

    expect(container!.textContent).toContain("本人打刻");
    expect(container!.textContent).not.toContain("gadget");
  });

  it("renders an amendment's approver and stated reason, not the bare word amendment", async () => {
    await render(<PunchSource punch={punch({
      source: "amendment", amended_by: 7, amend_reason: "forgot to clock out",
    })} />);

    expect(container!.textContent).toContain("forgot to clock out");
    expect(container!.textContent).toContain("7");
    expect(container!.textContent).not.toBe("amendment");
    // The raw platform word must not appear as its own token in the rendered text.
    expect(container!.textContent!.split(/[^a-z]+/i)).not.toContain("amendment");
  });

  it("renders a neutral label for an admin-entered punch", async () => {
    await render(<PunchSource punch={punch({ source: "admin" })} />);

    expect(container!.textContent).not.toBe("admin");
    expect(container!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it("renders a neutral label for an imported punch", async () => {
    await render(<PunchSource punch={punch({ source: "import" })} />);

    expect(container!.textContent).not.toBe("import");
    expect(container!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it("falls through to the raw string for a source it does not recognise, never blank", async () => {
    await render(<PunchSource punch={punch({ source: "future_source" as PunchRow["source"] })} />);

    expect(container!.textContent).toContain("future_source");
  });
});
