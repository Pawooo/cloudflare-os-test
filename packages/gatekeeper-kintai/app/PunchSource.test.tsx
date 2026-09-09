import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PunchRow, UiLanguage } from "../src/types";
import { PunchSource } from "./PunchSource";
import { LanguageProvider, en, ja } from "./i18n";

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

  /**
   * One explicit language per render, 日本語 by default. `PunchSource` reads the language off the
   * provider (`useT()`) rather than taking a prop, so that the admin drill-down and 今日 both get
   * their own screen's language without either call site passing anything.
   */
  async function render(element: React.ReactNode, language: UiLanguage = "ja"): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanguageProvider initial={language}>{element}</LanguageProvider>);
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

    expect(container!.textContent).toContain(ja.punchSource.gadget);
    expect(container!.textContent).not.toContain("gadget");
  });

  // The same punch on an English screen says it in English — the provenance line follows the
  // screen's language like every other word on it, and neither language leaks into the other.
  it("renders the same punch in English on an English screen", async () => {
    await render(<PunchSource punch={punch({ source: "gadget" })} />, "en");

    expect(container!.textContent).toContain(en.punchSource.gadget);
    expect(container!.textContent).not.toContain(ja.punchSource.gadget);
  });

  it("builds the amendment sentence out of the dictionary, in the screen's language", async () => {
    await render(<PunchSource punch={punch({
      source: "amendment", amended_by: null, amend_reason: null,
    })} />);

    // No approver recorded and no reason given: both hold the dictionary's words for the gap,
    // never a blank that would read as an amendment nobody made for no reason.
    expect(container!.textContent).toBe(
      ja.punchSource.amendment(ja.punchSource.unknownApprover, ja.punchSource.noReason),
    );
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

  // Task 4's review ruling: the amendment label carries the APPROVER's employee id, and a screen
  // that has a way to turn that id into a name should show the name. The prop is how it passes one.
  it("renders the approver's NAME when a resolver is given, not the bare #id", async () => {
    await render(<PunchSource
      punch={punch({ source: "amendment", amended_by: 7, amend_reason: "forgot to clock out" })}
      resolveApprover={(id) => (id === 7 ? "山田 花子" : `#${id}`)}
    />);

    expect(container!.textContent).toContain("山田 花子");
    expect(container!.textContent).not.toContain("#7");
  });

  // No resolver — the admin drill-down passes none, and this is the honest fallback: the id, never
  // a blank. The whole point of keeping the prop optional.
  it("falls back to #id for an amendment when no resolver is given", async () => {
    await render(<PunchSource punch={punch({
      source: "amendment", amended_by: 7, amend_reason: "forgot to clock out",
    })} />);

    expect(container!.textContent).toContain("#7");
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
