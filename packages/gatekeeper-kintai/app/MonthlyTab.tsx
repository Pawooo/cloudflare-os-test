import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MonthlyReport, MonthlyTotalRow } from "../src/types";
import { jstWorkDate } from "../src/work-date";
import type { KintaiAdminClient } from "./AdminPage";
import { describeFailure } from "./errors";
import { useT } from "./i18n";

/**
 * 月次: one month's hours per employee, and the one write that closes it.
 *
 * Two jobs, and the second is the reason this tab exists at all. Reading a month is useful; being
 * able to CLOSE one is what makes this package's append-only storage mean anything. Until
 * `lockPeriod` became reachable, no month could ever be closed, and `setAllocations` — the one
 * write in this system with no approval behind it — could rewrite a month somebody had already
 * been paid on, indefinitely. See `AdminKintaiApi.lockPeriod`.
 *
 * NOTHING HERE RECOMPUTES ANYTHING. Every number on the screen arrives from `monthlyReport`, which
 * walks the punches through the same `workedMinutes` and `dayAnomalies` the employee's own day view
 * uses. This module links, and it no longer even formats: the hours column reads
 * `t.labels.durations.full`, because `162h 30m` and `162時間30分` are one column each language
 * fills its own way, and a local formatter would have made that choice for both.
 *
 * ONE LANGUAGE, and this panel does not choose it — `main.tsx` resolves it and every word below
 * comes off `useT()`.
 */
export function MonthlyTab({
  api, onShowOverview, onLockAttempted,
}: {
  api: KintaiAdminClient;
  /**
   * Switch the page to 要対応, which is where a flagged day is actually looked at.
   *
   * A callback rather than a second rendering of the flagged days here: that panel already lists
   * every one of them with its punches one press away, and two screens over one query are two
   * screens to keep in agreement. `AdminPage` owns which tab is showing, so it owns this.
   */
  onShowOverview: () => void;
  /**
   * Tell the page that `period_locks` may have changed, so panels that read it can read it again.
   *
   * NOT named `onClosed`, and not called only on success, deliberately. See the call site: the
   * likeliest refusal from `lockPeriod` is `KINTAI_ALREADY_LOCKED`, which means the month IS
   * closed — by somebody else, between this page's read and this press — so the rest of the
   * screen is stale on exactly that path too. What this reports is "a close was attempted against
   * a month, and the lock table is no longer necessarily what anybody here last read".
   */
  onLockAttempted: () => void;
}) {
  /*
   * The month the administrator is in, in JST, read ONCE for the life of the panel.
   *
   * `jstWorkDate` rather than `toISOString().slice(0, 7)`: the latter is UTC and reports the
   * previous month for the first nine hours of every Japanese day — the same nine hours
   * `workDateStart` exists because of. Held rather than recomputed so the future bound below
   * cannot shift under a page left open across midnight on the 1st, which would silently turn the
   * next button on for a month that has still not started as far as this render is concerned.
   */
  const [currentMonth] = useState(() => jstWorkDate(Date.now()).slice(0, 7));
  const [period, setPeriod] = useState(currentMonth);
  /*
   * A read holds its FAILURE, never the sentence describing it.
   *
   * Putting `t` inside `readMonth` would make the language a dependency of the read — a toggle
   * re-running `monthlyReport`, or, with the dependency omitted, an error frozen in the language
   * it was written in. Described at render time instead, so a switch retranslates a message
   * already on screen and the read stays about reading. Wrapped rather than a bare `unknown` so a
   * thrown `undefined` is still a failure.
   */
  const [report, setReport] = useState<{ data?: MonthlyReport; failure?: { caught: unknown } }>({});
  const [armed, setArmed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeFailure, setCloseFailure] = useState<{ caught: unknown }>();

  const live = useRef(true);
  // Armed in the effect body, not only by `useRef`: the ref survives a mount → unmount → remount
  // (React StrictMode double-invokes exactly this pair), and a `live` stuck false would discard
  // every read on arrival — a panel that spins for ever with nothing to explain it.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  // Which read is the current one. A reader pressing prev twice quickly has two reads in flight,
  // and the first to come back is not necessarily the month they are now looking at.
  const readId = useRef(0);
  /*
   * Which month the picker is on, readable from inside an async continuation.
   *
   * `close()` captures `period` in its closure and cannot see a later one, and the picker is
   * deliberately NOT disabled while a close is in flight — the new test below moves it mid-close
   * on purpose, because that is what a reader on a slow link does. So the continuation needs to
   * ask where the picker is NOW, and `period` in scope is where it was THEN.
   *
   * Written by `goToMonth`, synchronously, which is the only thing in this component that moves
   * the month. That is what makes it safe to read after an await: the assignment happens in the
   * click handler, long before any pending promise resumes, so there is no window in which the
   * ref and the rendered picker disagree.
   */
  const periodRef = useRef(period);
  const goToMonth = (next: string) => {
    periodRef.current = next;
    setPeriod(next);
  };

  const readMonth = useCallback(async (target: string) => {
    const id = ++readId.current;
    setReport({});
    try {
      const data = await api.monthlyReport(target);
      if (live.current && id === readId.current) setReport({ data });
    } catch (caught) {
      if (live.current && id === readId.current) setReport({ failure: { caught } });
    }
  }, [api]);

  /*
   * Read on mount, and again whenever the month changes — never on a tab flip.
   *
   * All three panels are mounted from the first admin render (see the `hidden` panels in
   * `AdminPage`), so there is no "became visible" event to hang a fetch on and nothing to wait
   * for. `readMonth` closes over `api`, which never changes for the life of the page, so this
   * fires once per month looked at rather than once per ancestor rerender — and `AdminPage`
   * rerenders on every keystroke in a roster form.
   */
  useEffect(() => {
    void readMonth(period);
  }, [readMonth, period]);

  /*
   * An armed confirmation names ONE month, so moving the picker takes it back.
   *
   * Leaving it armed would put a confirmation about September in front of a reader now looking at
   * August, one press away from closing the wrong month — and closing one cannot be undone. The
   * close failure goes with it for the same reason: it is a sentence about the month that was on
   * screen when it was pressed.
   */
  useEffect(() => {
    setArmed(false);
    setCloseFailure(undefined);
  }, [period]);

  const data = report.data;
  const locked = data?.locked ?? false;
  /*
   * The close control exists only for an open month that has actually started.
   *
   * The second half is belt to the picker's braces: `next-month` never walks past `currentMonth`,
   * so `period` cannot be in the future — but `lockPeriod` refuses a future month
   * (`KINTAI_FUTURE_PERIOD`) and a button that could only ever fail should not be rendered. While
   * the month is unread, `locked` is false and this stays hidden anyway, because `data` is
   * undefined and the panel is showing a spinner.
   */
  const closable = data !== undefined && !locked && period <= currentMonth;

  const close = async () => {
    // The month this close is ABOUT, named once. Everything below is judged against it rather
    // than against `period`, which is a closure variable from the render that armed the button.
    const target = period;
    setClosing(true);
    setCloseFailure(undefined);
    try {
      await api.lockPeriod(target);
    } catch (caught) {
      if (live.current) setCloseFailure({ caught });
    } finally {
      if (live.current) {
        setArmed(false);
        setClosing(false);
      }
    }
    if (!live.current) return;
    /*
     * 要対応 read `period_locks` too, on mount, and its copy is now suspect.
     *
     * `amendment.lockedPeriod` on a pending correction is a join onto the very table this press
     * writes, so closing the month a correction is dated in changes that row's answer — and the
     * marker it gains ("approving this changes a month that has already been closed off") is the
     * one thing about that decision its approver is least able to infer. Section 1 read once on
     * mount and never again, so 月次 said 締め済み while the row beside it, one press from
     * approving the write, said nothing at all.
     *
     * Announced BEFORE the picker guard below on purpose: where the picker now sits decides which
     * month's REPORT this panel renders and says nothing about whether a lock changed. And not
     * gated on success, for the reason on `onLockAttempted` — a refusal is the path where the
     * screen is already KNOWN to be out of date. A refusal that really changed nothing (a future
     * month, an unlinked administrator) costs one re-read of the queue, which then says what it
     * said before.
     */
    onLockAttempted();
    /*
     * Re-read either way, and the failure case is the one that needs it.
     *
     * On success the badge has to come from the store rather than from this component assuming its
     * own write landed. On failure the LIKELIEST refusal is `KINTAI_ALREADY_LOCKED` — somebody
     * else closed the month between this page's read and this press, which is a race the store
     * settles inside the same run as the INSERT and no caller can pre-empt. That means the
     * `locked` on screen is already wrong, so the honest response to the refusal is to go and
     * find out what the month actually says.
     *
     * UNLESS THE PICKER HAS MOVED, and this guard is the whole fix for a real bug. Nothing
     * disables the picker while a close is in flight, so a reader on a slow link can press ← in
     * between — and the `[period]` effect has then ALREADY read the new month. Re-reading `target`
     * here would win the `readId` race with that effect and leave the panel holding September's
     * report while the picker says August: an open month rendering 締め済み, with its close control
     * gone, on the one irreversible write in this package. The new month's read is already correct
     * and already in flight or landed; there is nothing for this call to add.
     */
    if (periodRef.current !== target) return;
    await readMonth(target);
  };

  const headingId = useId();
  const t = useT();
  return (
    <section className="flex flex-col gap-6" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-action="prev-month"
            aria-label={t.common.prevMonth}
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={() => goToMonth(shiftMonth(period, -1))}
          >
            ←
          </button>
          {/* A label, not a field: the only two months a reader can ask for are the one before
              and the one after, so there is no free text to validate and no typo to refuse.
              `YYYY-MM` is exactly what `monthlyReport` and `lockPeriod` take. */}
          <h2
            id={headingId}
            data-testid="month-label"
            className="min-w-20 text-center font-mono text-base font-semibold text-kumo-default"
          >
            {period}
          </h2>
          <button
            type="button"
            data-action="next-month"
            aria-label={t.common.nextMonth}
            /* Disabled AT the current month, not after it. `lockPeriod` refuses a month that has
               not started, and a next button that reached October would offer a reader an empty
               month and a close control that could only fail. Going backwards has no bound. */
            disabled={period >= currentMonth}
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-kumo-control"
            onClick={() => goToMonth(shiftMonth(period, 1))}
          >
            →
          </button>
        </div>

        {data !== undefined && data.locked && (
          <p
            data-testid="monthly-locked"
            className="rounded-lg bg-kumo-tint px-3 py-1.5 text-xs font-medium text-kumo-default"
          >
            {/* Closed, and NOT frozen — the same distinction the confirmation spells out. An
                approved correction is still applied into this month, so these numbers can still
                move; what has stopped is everything else.

                The month named is `data.period`, THE ONE THIS REPORT IS FOR, never the one the
                picker is showing. They agree in every ordinary render, and the point of not
                relying on that is the case where they briefly would not: a badge that took its
                month from the picker once claimed 締め済み over an open month's report. A lock is
                the one claim on this screen that must come from the same read as the verdict. */}
            {t.monthly.closedBadge(data.period)}
          </p>
        )}

        {closable && !armed && (
          <button
            type="button"
            data-action="close-month"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={() => setArmed(true)}
          >
            {t.monthly.closeMonth}
          </button>
        )}
      </div>

      {armed && (
        <CloseConfirmation
          period={period}
          busy={closing}
          onClose={close}
          onCancel={() => setArmed(false)}
        />
      )}

      {/* Beside the control that failed, like every notice on this page. A close that was refused
          is not a reason to blank the month's numbers — and after a refused close those numbers
          have just been re-read, which is the most useful thing on the screen. */}
      {closeFailure !== undefined && (
        <p className="text-sm text-kumo-danger" data-testid="close-error" role="alert">
          {describeFailure(closeFailure.caught, t.errors.fallbacks.closeMonth, t)}
        </p>
      )}

      <MonthTable
        report={report}
        /* Only for the month 要対応 is actually reading. That panel reads `listAnomalousDays` once,
           for the month the page opened in, and never again — so a jump from an August row would
           switch tabs to September's flagged days and look like it had done nothing. */
        linkAnomalies={period === currentMonth}
        onShowOverview={onShowOverview}
        onRetry={() => void readMonth(period)}
      />
    </section>
  );
}

/**
 * The two-step close, inline — never `window.confirm`.
 *
 * The host's iframe carries `allow-modals`, so a native confirm would in fact open; it is still
 * the wrong control. Every other confirmation and notice on this page is rendered markup, a modal
 * cannot say four sentences legibly, and a browser dialog is untestable in jsdom — which for the
 * one irreversible write in this package is the argument that settles it.
 *
 * WHAT IT HAS TO SAY, and why all four sentences are load-bearing: "closed" in this system does
 * not mean frozen. `assertWritable` refuses ordinary writes into a closed month, but applying an
 * APPROVED amendment is the one write still allowed in (see `actOnAmendment`), and the next
 * `monthlyTotals` walks the punches that write left behind. An administrator who read "closed" as
 * "these numbers are final" would hand payroll a total that can still move. And there is no
 * unlock anywhere in this package, so the press is one-way.
 */
function CloseConfirmation({
  period, busy, onClose, onCancel,
}: {
  period: string;
  busy: boolean;
  onClose: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="close-confirm"
      role="group"
      aria-label={t.monthly.confirm.ariaLabel(period)}
      className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-tint px-4 py-3"
    >
      <p className="text-sm font-medium text-kumo-default">
        {t.monthly.confirm.heading(period)}
      </p>
      <ul className="flex flex-col gap-1 text-xs text-kumo-subtle">
        <li>{t.monthly.confirm.ordinaryEdits}</li>
        <li>{t.monthly.confirm.approvedCorrections}</li>
        <li>{t.monthly.confirm.totalsMove}</li>
      </ul>
      <p className="text-xs font-medium text-kumo-danger">
        {t.monthly.confirm.irreversible}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="confirm-close-month"
          disabled={busy}
          className="press rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void onClose()}
        >
          {busy ? t.monthly.closing : t.monthly.confirm.close(period)}
        </button>
        <button
          type="button"
          data-action="cancel-close-month"
          disabled={busy}
          className="press rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onCancel}
        >
          {t.common.cancel}
        </button>
      </div>
    </div>
  );
}

/** One row per employee with punches in the month. */
function MonthTable({
  report, linkAnomalies, onShowOverview, onRetry,
}: {
  report: { data?: MonthlyReport; failure?: { caught: unknown } };
  linkAnomalies: boolean;
  onShowOverview: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  if (report.failure !== undefined) {
    /*
     * Not a dead end, which is the whole reason the button is here.
     *
     * The picker is the only other control on this panel, so a month whose read failed would stay
     * unreadable for the life of the page unless the reader happened to walk away from it and
     * back. Same finding as the flagged-day drill-down's, one tab over.
     */
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-kumo-danger" data-testid="monthly-error" role="alert">
          {describeFailure(report.failure.caught, t.errors.fallbacks.readMonth, t)}
        </p>
        <button
          type="button"
          data-action="retry-month"
          className="text-sm font-medium text-kumo-link hover:text-kumo-brand-hover"
          onClick={onRetry}
        >
          {t.common.tryAgain}
        </button>
      </div>
    );
  }

  if (report.data === undefined) {
    return <p className="text-sm text-kumo-subtle">{t.monthly.reading}</p>;
  }

  const { period, rows } = report.data;
  if (rows.length === 0) {
    /*
     * What "nothing here" means, never a blank space — the same rule 要対応's three sections
     * follow. `monthlyTotals` returns a row per employee WITH PUNCHES, so an empty report is a
     * month nobody clocked into, which for a past month is a finding and not a healthy silence.
     */
    return (
      <p
        className="rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle"
        data-testid="monthly-empty"
      >
        {t.monthly.empty(period)}
      </p>
    );
  }

  /*
   * No summary line above this table, on purpose.
   *
   * The obvious one — employees, days, hours — has a number in it that cannot be labelled
   * honestly in a word: days summed across people is person-days, and beside a column headed
   * 出勤日数 it reads as a count of calendar days in the month. Payroll totals are not the place
   * for a figure whose unit a reader has to infer. The per-employee rows are the report; a total
   * row is a separate decision, needs a unit on it, and belongs to whoever asks for one.
   */
  return (
    <div className="flex flex-col gap-3">
      {/* A real table: three of these four columns are numbers a reader compares down the column,
          which is the one thing a list of cards cannot do. It scrolls inside its own box rather
          than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-kumo-line text-left text-xs text-kumo-subtle">
              <th scope="col" className="py-2 pr-4 font-medium">
                {t.monthly.columns.employee}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                {t.monthly.columns.daysWorked}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                {t.monthly.columns.workedHours}
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                {t.monthly.columns.needsALook}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kumo-line">
            {rows.map((row) => (
              <MonthRow
                key={row.employeeId}
                row={row}
                linkAnomalies={linkAnomalies}
                onShowOverview={onShowOverview}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonthRow({
  row, linkAnomalies, onShowOverview,
}: {
  row: MonthlyTotalRow;
  linkAnomalies: boolean;
  onShowOverview: () => void;
}) {
  const t = useT();
  return (
    <tr data-monthly-employee={row.employeeId}>
      <td className="py-2 pr-4">
        <span className="font-medium text-kumo-default">{row.displayName}</span>
        <span className="ml-2 text-xs text-kumo-subtle">{row.employeeNumber}</span>
      </td>
      <td className="py-2 pr-4 text-right font-mono text-kumo-default" data-testid="days">
        {row.daysWorked}
      </td>
      <td className="py-2 pr-4 text-right font-mono text-kumo-default" data-testid="hours">
        {t.labels.durations.full(row.workedMinutes)}
      </td>
      <td className="py-2 text-right font-mono" data-testid="anomalies">
        <AnomalyCount row={row} linkAnomalies={linkAnomalies} onShowOverview={onShowOverview} />
      </td>
    </tr>
  );
}

/**
 * How many of the month's days need a look, and — sometimes — a way to go and look at them.
 *
 * A BUTTON ONLY WHEN IT WOULD DO SOMETHING. 要対応 reads its flagged days once, for the month the
 * page opened in, so a jump from a row in any other month would switch tabs and show the reader
 * September's days under an August question — the clickable-but-inert control this page has gone
 * to some trouble never to ship (see the roster's `canSetManager`). The count still reads either
 * way, because the number is the finding; the link is only the convenience.
 */
function AnomalyCount({
  row, linkAnomalies, onShowOverview,
}: {
  row: MonthlyTotalRow;
  linkAnomalies: boolean;
  onShowOverview: () => void;
}): ReactNode {
  const t = useT();
  if (row.anomalousDays === 0) return <span className="text-kumo-inactive">0</span>;
  if (!linkAnomalies) return <span className="text-kumo-danger">{row.anomalousDays}</span>;
  return (
    <button
      type="button"
      data-action="show-anomalies"
      aria-label={t.monthly.anomalyLink(row.anomalousDays, row.displayName)}
      className="press font-medium text-kumo-link underline hover:text-kumo-brand-hover"
      onClick={onShowOverview}
    >
      {row.anomalousDays}
    </button>
  );
}

/**
 * `period` moved by `delta` months, carrying across a year boundary.
 *
 * Months counted from year zero rather than a `Date`, on purpose: a `Date` would drag a timezone
 * into an operation on a `YYYY-MM` string that has no instant in it, and `setMonth` on the 31st of
 * a month is the classic way this arithmetic goes wrong. One expression, no special case for
 * January or December in either direction.
 */
function shiftMonth(period: string, delta: number): string {
  const months = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + delta;
  const year = Math.floor(months / 12);
  const month = months - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}
