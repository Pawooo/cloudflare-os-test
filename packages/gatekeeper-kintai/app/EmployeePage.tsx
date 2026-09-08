import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EmployeeMonth, EmployeeMonthDay, KintaiEmployeeClient, PunchKind, PunchRow, SubmissionState,
} from "../src/types";
import { jstClockTime, jstWorkDate } from "../src/work-date";
import { describeFailure } from "./errors";
import { PunchSource } from "./PunchSource";

/**
 * The employee gadget's own two panels: the day the employee is clocking through, and the month
 * they are reading back. 今日 is the default — it is the one an employee opening this page is here
 * to act on, not the month they only visit to check a total.
 */
type Tab = "today" | "month";

/**
 * The employee's own attendance screen.
 *
 * A tab bar and two panels, both mounted from the first render and hidden rather than unmounted
 * (matching `AdminPage`), so switching tabs never remounts a panel or drops the read it holds. 今日
 * is live (this task); 今月 is still a placeholder (Task 6).
 */
export default function EmployeePage({ api }: { api: KintaiEmployeeClient }) {
  const [tab, setTab] = useState<Tab>("today");

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Kintai</h1>
        <p className="mt-1 text-sm text-kumo-subtle">Your attendance and overtime.</p>
      </header>

      <TabBar tab={tab} onSelect={setTab} />

      <div hidden={tab !== "today"} data-testid="panel-today">
        <TodayPanel api={api} />
      </div>

      <div hidden={tab !== "month"} data-testid="panel-month">
        <MonthPanel api={api} />
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

/** How each punch kind reads on a button an employee presses. */
const PUNCH_LABELS: Record<PunchKind, string> = {
  in: "出勤",
  out: "退勤",
  break_start: "休憩開始",
  break_end: "休憩終了",
};

/**
 * How each anomaly flag reads to a human on the employee's own day.
 *
 * The keys are the strings `dayAnomalies` pushes, and an unknown one falls through to the flag
 * itself rather than to nothing — a flag added on the worker side must surface as an ugly line
 * rather than as a day that looks clean. This is a deliberate parallel to `OverviewTab`'s own
 * `ANOMALY_LABELS`: the flags are plain wire strings both screens translate, and the two maps say
 * the same thing about the same flag. A shared module is the eventual home; keeping a second small
 * copy here is scoped to this task rather than reaching into the admin tab to extract one.
 */
const ANOMALY_LABELS: Record<string, string> = {
  unpaired_in: "退勤打刻なし",
  unpaired_break: "休憩終了の打刻なし",
  orphan_out: "出勤打刻のない退勤",
  duplicate_in: "出勤打刻の重複",
  negative_gross: "休憩が労働時間を超過",
  long_span: "14時間以上の勤務",
};

/**
 * The legal next punches, read off the day's current punches the SAME way the store's `pairSpans`
 * reads them — never a second pairing state machine. Walk the punches in order (they arrive ordered
 * by `occurred_at`, see `currentPunches`) tracking the two open spans the store tracks: the in/out
 * shift and the break. The two open flags then decide what may come next:
 *
 *  - no open shift             → 出勤 (`in`): the empty day, and the day after a clock-out.
 *  - open shift, no open break → 退勤 (`out`) and 休憩開始 (`break_start`).
 *  - open break                → 休憩終了 (`break_end`) only: you end the break before anything else.
 *
 * A second `in` while a shift is already open is `duplicate_in` to the store and leaves the shift
 * open here too — the LAST in/out decides, exactly as `pairSpans`'s `openAt` does. Pure and export
 * so it is tested on its own.
 */
export function nextPunchKind(punches: Pick<PunchRow, "kind">[]): PunchKind[] {
  let shiftOpen = false;
  let breakOpen = false;
  for (const { kind } of punches) {
    if (kind === "in") shiftOpen = true;
    else if (kind === "out") shiftOpen = false;
    else if (kind === "break_start") breakOpen = true;
    else if (kind === "break_end") breakOpen = false;
  }
  if (breakOpen) return ["break_end"];
  if (shiftOpen) return ["out", "break_start"];
  return ["in"];
}

type DayRead = Awaited<ReturnType<KintaiEmployeeClient["getDay"]>>;

/**
 * 今日 — the day the employee is clocking through.
 *
 * The day is read on mount and again whenever a write (a punch, or a filed correction) bumps the
 * reload token — the same reload-token pattern the dashboard's sections settled on. The previous
 * answer stays on screen while a re-read is in flight rather than blanking to a spinner; a `readId`
 * guard drops an out-of-order landing, and a `live` guard drops a set after unmount.
 *
 * `today` is `jstWorkDate(now)` decided ONCE for the life of the panel — recomputing it every
 * render would silently name a different day the moment a page left open crosses JST midnight, and
 * the punches below it are the day the read was taken for.
 */
function TodayPanel({ api }: { api: KintaiEmployeeClient }) {
  const [today] = useState(() => jstWorkDate(Date.now()));
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((count) => count + 1), []);
  const [state, setState] = useState<{ day?: DayRead; error?: string }>({});

  const live = useRef(true);
  const readId = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    const id = ++readId.current;
    void (async () => {
      try {
        const day = await api.getDay(today);
        if (live.current && id === readId.current) setState({ day });
      } catch (caught) {
        if (live.current && id === readId.current) {
          setState({ error: describeFailure(caught, "今日の打刻を読み込めませんでした。") });
        }
      }
    })();
  }, [api, today, reloadToken]);

  if (state.error !== undefined) {
    return <p className="text-sm text-kumo-danger" role="alert">{state.error}</p>;
  }
  if (state.day === undefined) {
    return <p className="text-sm text-kumo-subtle">読み込み中…</p>;
  }

  const { punches, anomalies } = state.day;

  return (
    <div className="flex flex-col gap-6">
      <ShiftControl api={api} punches={punches} reload={reload} live={live} />

      <section>
        <h2 className="text-sm font-medium text-kumo-default">今日の打刻</h2>
        {punches.length === 0 ? (
          <p className="mt-2 text-sm text-kumo-subtle" data-testid="today-empty">
            今日はまだ打刻がありません
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-0.5">
            {punches.map((punch) => (
              <li
                key={punch.id}
                className="font-mono text-xs text-kumo-default"
                data-testid="punch"
              >
                {jstClockTime(punch.occurred_at)} {PUNCH_LABELS[punch.kind] ?? punch.kind}
                {/* No `resolveApprover`: `amended_by` is the APPROVER — a manager, not the viewing
                    employee — and this screen has no roster to name one against. `whoAmI` carries
                    the viewer's own id but no display name, and an employee never approves their
                    own amendment, so even a self-match would not apply. `#id` is the honest label
                    here; the prop stays a no-op fallback. */}
                <PunchSource punch={punch} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {anomalies.length > 0 && (
        <section data-testid="today-anomalies">
          <p className="text-xs text-kumo-danger" data-testid="today-flags">
            {anomalies.map((flag) => ANOMALY_LABELS[flag] ?? flag).join(" · ")}
          </p>
          {anomalies.includes("unpaired_in") && (
            <MissingOutForm api={api} workDate={today} reload={reload} live={live} />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The always-visible shift control: the next legal punch(es) for right now, from `nextPunchKind`.
 * Pressing one calls `api.punch` and, on success, reloads the day so the control redraws for the
 * new state. A failure is shown through `describeFailure` and the day is left as it was.
 */
function ShiftControl(
  { api, punches, reload, live }: {
    api: KintaiEmployeeClient;
    punches: PunchRow[];
    reload: () => void;
    live: React.RefObject<boolean>;
  },
) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const kinds = nextPunchKind(punches);

  const doPunch = async (kind: PunchKind) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.punch(kind);
      if (live.current) reload();
    } catch (caught) {
      if (live.current) setError(describeFailure(caught, "打刻できませんでした。"));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <section>
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind, index) => {
          // The FIRST kind is the next legal action (`nextPunchKind` returns it first: 出勤 when
          // out, 退勤 when in, 休憩終了 within a break). It is what the worker opened the app to do,
          // so it is the primary control — filled and larger; 休憩開始 stays a muted secondary
          // beside 退勤. `data-primary` carries the intent for tests without pinning Tailwind classes.
          const primary = index === 0;
          return (
            <button
              key={kind}
              type="button"
              data-punch={kind}
              data-primary={primary ? "true" : undefined}
              disabled={busy}
              className={primary
                ? "press rounded-lg bg-kumo-brand px-5 py-2.5 text-base font-semibold text-white hover:bg-kumo-brand-hover disabled:opacity-60"
                : "press rounded-lg border border-kumo-line bg-kumo-control px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-60"}
              onClick={() => void doPunch(kind)}
            >
              {PUNCH_LABELS[kind]}
            </button>
          );
        })}
      </div>
      {error !== undefined && (
        <p className="mt-2 text-xs text-kumo-danger" role="alert" data-testid="punch-error">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * File the forgotten clock-out as a REQUEST, never an edit — `requestMissingPunch` asks for an
 * `out` to be added, and nothing changes until an approver applies it, which is why success reads
 * `申請しました・承認待ち` and never "fixed".
 *
 * The employee states two things themselves: WHEN they actually clocked out (a time input, honestly
 * their own — never a fabricated "now") and WHY (the reason the server requires). Both are plain
 * `<input>`s, not a `<form>` and not a `<textarea>`/`<select>` — the host sandbox forbids form
 * submission, and the file button is `type="button"`, inert if ever moved inside a form.
 */
function MissingOutForm(
  { api, workDate, reload, live }: {
    api: KintaiEmployeeClient;
    workDate: string;
    reload: () => void;
    live: React.RefObject<boolean>;
  },
) {
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok?: string; error?: string }>();

  const ready = time !== "" && reason.trim() !== "";

  const file = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const occurredAt = Date.parse(`${workDate}T${time}:00+09:00`);
      await api.requestMissingPunch(workDate, "out", occurredAt, reason);
      if (live.current) {
        setNotice({ ok: "申請しました・承認待ち" });
        reload();
      }
    } catch (caught) {
      if (live.current) setNotice({ error: describeFailure(caught, "申請できませんでした。") });
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-kumo-tint px-3 py-3">
      <p className="text-xs text-kumo-subtle">退勤の打刻漏れを申請します。</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-xs text-kumo-default">
          退勤時刻
          <input
            type="time"
            data-testid="correction-time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="ml-2 rounded border border-kumo-line bg-kumo-control px-2 py-1 text-xs"
          />
        </label>
        <label className="flex-1 text-xs text-kumo-default">
          理由
          <input
            type="text"
            data-testid="correction-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="ml-2 w-full min-w-40 rounded border border-kumo-line bg-kumo-control px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          data-testid="file-correction"
          disabled={busy || !ready}
          className="press rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-60"
          onClick={() => void file()}
        >
          退勤の打刻漏れを申請
        </button>
      </div>
      {notice?.ok !== undefined && (
        <p className="mt-2 text-xs text-kumo-success" data-testid="correction-notice">
          {notice.ok}
        </p>
      )}
      {notice?.error !== undefined && (
        <p className="mt-2 text-xs text-kumo-danger" role="alert" data-testid="correction-notice">
          {notice.error}
        </p>
      )}
    </div>
  );
}

/**
 * How each overtime state reads to the employee whose request it is.
 *
 * The keys are `SubmissionState`; an unknown one falls through to the raw state rather than to
 * nothing, on the same principle as `ANOMALY_LABELS` above — a state added on the worker side must
 * surface as an ugly word, never as a request that looks stateless. Every one of these is a CLAIM,
 * which is why the panel carries a standing line saying so; the label names where in approval the
 * claim currently sits, not what will be paid.
 */
const OVERTIME_STATE_LABELS: Record<SubmissionState, string> = {
  draft: "下書き",
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  withdrawn: "取り下げ",
};

/**
 * `8h 15m`, and always both units — the 月次 convention (`formatWorkedHours`), not `OverviewTab`'s
 * `formatDuration` which drops the empty half. Both the worked column and the overtime column are
 * numbers a reader runs their eye down, and `8h` beside `8h 15m` makes the column ragged.
 *
 * Arithmetic on a number that arrived already computed — `workedMinutes` in `store/punches.ts` is
 * the only place worked time is decided, and the overtime minutes are the request's own figure.
 * Nothing here recomputes anything.
 */
function formatHoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * `period` moved by `delta` months, carrying across a year boundary.
 *
 * The same month arithmetic `MonthlyTab.shiftMonth` uses, and for the same reason: months counted
 * from year zero rather than through a `Date`, so no timezone is dragged into an operation on a
 * `YYYY-MM` string that has no instant in it, and `setMonth` on the 31st cannot go wrong.
 */
function shiftMonth(period: string, delta: number): string {
  const months = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + delta;
  const year = Math.floor(months / 12);
  const month = months - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * 今月 — the month a worker reads back.
 *
 * A picker over one employee's own months and a table of their days. Every number arrives from
 * `myMonth` — the employee-side view of the same `monthlyTotals` rollup the admin 月次 tab reads,
 * seen from the day side. This panel formats and it navigates; it owns no arithmetic over
 * attendance.
 *
 * The month is read on mount and again whenever the picker moves — the same `live`/`readId` guard
 * `TodayPanel` uses, so a reader stepping through months quickly cannot have an out-of-order
 * landing paint the wrong month, and a set after unmount is dropped. There is no write on this
 * screen, so no reload token: the picker is the only thing that re-reads.
 *
 * `currentMonth` is `jstWorkDate(now).slice(0,7)` decided ONCE for the life of the panel — the same
 * hold 月次 keeps, so the future bound below cannot shift under a page left open across JST midnight
 * on the 1st, which would silently turn the next button on for a month that has not started.
 */
function MonthPanel({ api }: { api: KintaiEmployeeClient }) {
  const [currentMonth] = useState(() => jstWorkDate(Date.now()).slice(0, 7));
  const [period, setPeriod] = useState(currentMonth);
  const [state, setState] = useState<{ month?: EmployeeMonth; error?: string }>({});
  // Bumped when a correction is filed from a flagged row, so the month re-reads and the fixed day's
  // flag clears — the same reload-token pattern 今日 uses, and the reason the read effect below
  // lists it as a dependency.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((n) => n + 1);

  const live = useRef(true);
  const readId = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    const id = ++readId.current;
    // Deliberately NOT blanking to a spinner on re-read: the previous month stays on screen while
    // the new read lands, matching 今日. A blank-on-reload would unmount a flagged row's open
    // correction form — and its 申請しました confirmation — the instant filing triggered the reload
    // that clears the flag. The `readId` guard already drops an out-of-order landing.
    void (async () => {
      try {
        const someMonth = await api.myMonth(period);
        if (live.current && id === readId.current) setState({ month: someMonth });
      } catch (caught) {
        if (live.current && id === readId.current) {
          setState({ error: describeFailure(caught, "今月の勤怠を読み込めませんでした。") });
        }
      }
    })();
  }, [api, period, reloadToken]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-action="prev-month"
          aria-label="前の月"
          className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={() => setPeriod((current) => shiftMonth(current, -1))}
        >
          ←
        </button>
        {/* A label, not a field: the only months a reader can ask for are one step either side, so
            there is no free text to validate. `YYYY-MM` is exactly what `myMonth` takes. */}
        <h2
          data-testid="month-label"
          className="min-w-20 text-center font-mono text-base font-semibold text-kumo-default"
        >
          {period}
        </h2>
        <button
          type="button"
          data-action="next-month"
          aria-label="次の月"
          /* Disabled AT the current month, not after it — there is no month past this one to read
             yet. Going backwards has no bound. The same rule 月次's next button follows. */
          disabled={period >= currentMonth}
          className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-kumo-control"
          onClick={() => setPeriod((current) => shiftMonth(current, 1))}
        >
          →
        </button>
      </div>

      {/* The guardrail: every overtime figure below is a CLAIM awaiting a decision, not a payout.
          A pending number in a column headed 残業 reads as money owed unless something says
          otherwise, and this is that something. Pinned in a test so it cannot soften. */}
      <p data-testid="claims-note" className="text-xs text-kumo-subtle">
        残業時間は承認待ちの申請であり、承認されるまで支給額ではありません — overtime shown here is a claim awaiting approval, not a payout.
      </p>

      <MonthTable state={state} api={api} reload={reload} live={live} />
    </div>
  );
}

/** One row per day the employee has punches in the month. Table, not cards. */
function MonthTable(
  { state, api, reload, live }: {
    state: { month?: EmployeeMonth; error?: string };
    api: KintaiEmployeeClient;
    reload: () => void;
    live: React.RefObject<boolean>;
  },
) {
  if (state.error !== undefined) {
    return <p className="text-sm text-kumo-danger" role="alert">{state.error}</p>;
  }
  if (state.month === undefined) {
    return <p className="text-sm text-kumo-subtle">読み込み中…</p>;
  }

  const { period, days } = state.month;
  if (days.length === 0) {
    /* What "nothing here" means, never a blank space — the same rule 今日's empty day follows.
       `myMonth` returns a row per day WITH punches, so an empty month is one nobody clocked into. */
    return (
      <p
        className="rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle"
        data-testid="month-empty"
      >
        {period} には打刻がありません。
      </p>
    );
  }

  return (
    /* A real table: worked and overtime are numbers a reader compares down the column, which a
       list of cards cannot do. It scrolls inside its own box rather than pushing the page sideways. */
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-kumo-line text-left text-xs text-kumo-subtle">
            <th scope="col" className="py-2 pr-4 font-medium">日付</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">労働時間</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">残業</th>
            <th scope="col" className="py-2 font-medium">要確認</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-kumo-line">
          {days.map((eachDay) => (
            <MonthDayRow key={eachDay.workDate} day={eachDay} api={api} reload={reload} live={live} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthDayRow(
  { day, api, reload, live }: {
    day: EmployeeMonthDay;
    api: KintaiEmployeeClient;
    reload: () => void;
    live: React.RefObject<boolean>;
  },
) {
  const [open, setOpen] = useState(false);
  // A forgotten clock-out is the one flag a worker can fix themselves from here — it needs a 退勤
  // time. Other flags (an unclosed 休憩, say) are not resolvable by adding an `out`, so the row
  // stays informational for those; only `unpaired_in` earns the fix control.
  const fixable = day.anomalies.includes("unpaired_in");

  return (
    <>
      <tr data-month-day={day.workDate}>
        <td className="py-2 pr-4 font-mono text-kumo-default">{day.workDate}</td>
        <td className="py-2 pr-4 text-right font-mono text-kumo-default" data-testid="worked">
          {formatHoursMinutes(day.workedMinutes)}
        </td>
        {/* A day with no request renders an EMPTY cell — never a zero, which in a 残業 column reads
            as a claim of no minutes owed rather than as the absence of a claim. */}
        <td className="py-2 pr-4 text-right font-mono text-kumo-default" data-testid="overtime">
          {day.overtime !== null && (
            <span>
              {formatHoursMinutes(day.overtime.minutes)}
              {" · "}
              <span className="text-kumo-subtle">
                {OVERTIME_STATE_LABELS[day.overtime.state] ?? day.overtime.state}
              </span>
            </span>
          )}
        </td>
        {/* A marker only where the day is flagged, in plain language — the same `ANOMALY_LABELS`
            translation 今日 uses, never the raw wire flag. No cell content at all on a clean day.
            Where the flag is a forgotten clock-out, the marker is a button that expands the same
            correction form 今日 uses, keyed to THIS day — the gap you need to fix is rarely today's. */}
        <td className="py-2 text-xs text-kumo-danger">
          {day.anomalies.length > 0 && (
            fixable ? (
              <button
                type="button"
                data-action="fix-day"
                aria-expanded={open}
                className="press text-xs font-medium text-kumo-danger underline hover:text-kumo-brand-hover"
                onClick={() => setOpen((was) => !was)}
              >
                <span data-testid="day-anomalies">
                  {day.anomalies.map((flag) => ANOMALY_LABELS[flag] ?? flag).join(" · ")}
                </span>
              </button>
            ) : (
              <span data-testid="day-anomalies">
                {day.anomalies.map((flag) => ANOMALY_LABELS[flag] ?? flag).join(" · ")}
              </span>
            )
          )}
        </td>
      </tr>
      {open && fixable && (
        <tr data-month-day={day.workDate}>
          <td colSpan={4} className="pb-3">
            <MissingOutForm api={api} workDate={day.workDate} reload={reload} live={live} />
          </td>
        </tr>
      )}
    </>
  );
}
