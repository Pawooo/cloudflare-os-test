import { useState } from "react";
import type { KintaiEmployeeClient } from "../src/types";

/**
 * The employee gadget's own two panels: the day the employee is clocking through, and the month
 * they are reading back. 今日 is the default — it is the one an employee opening this page is here
 * to act on, not the month they only visit to check a total.
 */
type Tab = "today" | "month";

/**
 * The employee's own attendance screen.
 *
 * The minimal shell only: a tab bar and two panels, both mounted from the first render and hidden
 * rather than unmounted (matching `AdminPage`), so switching tabs never remounts a panel or drops
 * the read it holds. The panels are placeholders — Tasks 5-6 fill 今日 with the day's punches and
 * clock buttons and 今月 with the month's days — which is why `api` is threaded in now and used by
 * neither yet: the capability the page calls is the same shape whoever holds it, and this component
 * receives it exactly as `AdminPage` receives `KintaiAdminClient`.
 */
export default function EmployeePage({ api }: { api: KintaiEmployeeClient }) {
  const [tab, setTab] = useState<Tab>("today");
  // Referenced so the capability is part of this component's contract from the shell onward; the
  // panels below start calling it in Tasks 5-6.
  void api;

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Kintai</h1>
        <p className="mt-1 text-sm text-kumo-subtle">Your attendance and overtime.</p>
      </header>

      <TabBar tab={tab} onSelect={setTab} />

      <div hidden={tab !== "today"} data-testid="panel-today">
        <p className="text-sm text-kumo-subtle">今日 — coming soon.</p>
      </div>

      <div hidden={tab !== "month"} data-testid="panel-month">
        <p className="text-sm text-kumo-subtle">今月 — coming soon.</p>
      </div>
    </main>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "month", label: "今月" },
];

/**
 * The two panels' tab bar.
 *
 * Buttons, not links and not a `<select>`, for the same reason `AdminPage`'s `TabBar` uses them:
 * nothing here navigates or submits, so the host sandbox's missing `allow-forms` is no concern, and
 * `type="button"` keeps the control inert if it is ever moved inside a `<form>`.
 */
function TabBar({ tab, onSelect }: { tab: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <div role="tablist" className="flex gap-2 border-b border-kumo-line pb-px">
      {TABS.map(({ id, label }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`tab-${id}`}
            className={
              active
                ? "press rounded-t-lg border border-b-0 border-kumo-line bg-kumo-elevated px-3.5 py-2 text-sm font-medium text-kumo-default"
                : "press rounded-t-lg border border-transparent px-3.5 py-2 text-sm font-medium text-kumo-subtle hover:bg-kumo-tint"
            }
            onClick={() => onSelect(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
