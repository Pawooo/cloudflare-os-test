import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  ApprovalAction,
  AnomalousDay, EmployeeDay, EmployeeId, PendingItem, RosterEntry,
} from "../src/types";
import { jstClockTime, jstWorkDate } from "../src/work-date";
import type { KintaiAdminClient, RowFixes } from "./AdminPage";
import { PunchSource } from "./PunchSource";
import { isReady, RosterRow } from "./RosterRow";
import { describeFailure } from "./errors";

/**
 * 要対応: what needs a human right now, and who that human is.
 *
 * Three sections in triage order, and the order is the argument for the screen. An administrator
 * opening Kintai is answering "is anything stuck?", and the three ways something gets stuck are
 * not equivalent:
 *
 *  1. A request waiting on a decision. Somebody is owed an answer, and — the reason this section
 *     is first — some of these rows are waiting on NOBODY. `listPendingOverview` is the only read
 *     in this system that can see that (see `pendingOverview`); every other surface is scoped to a
 *     person, so a stranded request appears on none of them.
 *  2. A day whose punches do not make sense. Nobody is blocked, but the month cannot be closed
 *     honestly until somebody looks.
 *  3. An employee the system will turn away the first time they file anything. Upstream of both
 *     of the above: a row here is why a request that should exist does not.
 *
 * WHAT THIS TAB MAY DECIDE. Section 2 is a read. Section 3's writes are the Roster tab's own
 * controls rendered here rather than copied. Section 1 shows 承認・差し戻し・却下 on a row ONLY when
 * the org chart names the viewer as one of its deciders (`eligibleActorIds`, computed by the same
 * `checkMayAct` the write runs) — being an administrator buys nothing, and the store refuses an
 * unlisted caller regardless of what the screen showed. So an administrator who is also the
 * employee's manager decides here; an administrator who is not sees who can, and the honest fix
 * for a stranded request is still section 3: repair the organisation until somebody is eligible.
 *
 * This replaced the original triage-only rule (decide through the agent, never here) once the
 * owner's own use showed the rule's cost: the screen named the decider and then sent them to
 * a chat to do it. Routine decisions belong on a button; the agent is for the long tail. See
 * `AdminKintaiApi.decideSubmission` for why the decision is confirmed here rather than on the OS
 * card the agent path uses.
 */
export function OverviewTab({
  api, roster, fixes, queueToken, viewerEmployeeId, onDecided,
}: {
  api: KintaiAdminClient;
  roster: RosterEntry[];
  fixes: RowFixes;
  /**
   * The viewer's own employee id, or null when their account is not linked. Section 1 shows its
   * decision controls only on rows whose `eligibleActorIds` name this id — the list the store
   * computed with the same `checkMayAct` the write runs, so the buttons promise exactly what the
   * write will accept. Presentation only: an unlinked or unlisted viewer who somehow called the
   * method anyway is refused by the store.
   */
  viewerEmployeeId: EmployeeId | null;
  /** A decision was written: the owner of `queueToken` should bump it so section 1 re-reads. */
  onDecided: () => void;
  /**
   * How many writes the screen has made that section 1's read depends on. See `queueToken` in
   * `AdminPage`, which owns it and states which writes bump it and why the other reads are left
   * alone.
   *
   * Section 3 needs nothing like this: it renders the `roster` prop, so it already reacts to the
   * re-read `AdminPage.submit` performs. That asymmetry is the whole shape of the bug this prop
   * fixes — an administrator who repaired a stranded employee watched section 3 update and was
   * still told by section 1 that the request would wait for ever.
   */
  queueToken: number;
}) {
  return (
    <div className="flex flex-col gap-8">
      <PendingSection
        api={api} queueToken={queueToken} viewerEmployeeId={viewerEmployeeId} onDecided={onDecided}
      />
      <AnomaliesSection api={api} />
      <BlockersSection roster={roster} fixes={fixes} />
    </div>
  );
}

/**
 * One section's read: started on mount whether or not the tab is being looked at, and again when
 * `reloadOn` changes — which only a write can make it do.
 *
 * All three panels are mounted from the first admin render (see the `hidden` panels in
 * `AdminPage`), which is what makes this the right shape rather than a compromise: the same
 * `useEffect` that loads the roster loads this, and there is no "became visible" event to hang a
 * fetch on. Fetching on tab focus would need a visibility hack, would re-read on every flip, and
 * would leave the queue's first paint behind a click.
 *
 * `reloadOn` is how a WRITE asks for the read again — never a render, and never a tab flip. It is
 * a counter owned by `AdminPage`, and every caller states its own answer to "what could make this
 * stale": a section no write on this screen can invalidate passes a constant and stays mount-once.
 * A required argument rather than an optional one for exactly that reason — the next section added
 * here has to answer the question rather than inherit an answer.
 *
 * `read` and `fallback` stay OUT of the dependency list, for the reason they always did: `read`
 * closes over the `api` capability, which never changes for the life of the page, and re-running
 * on a new closure would re-read the whole company's queue every time an ancestor rerenders —
 * which `AdminPage` does on every keystroke in a roster form.
 *
 * The previous answer stays on screen while a re-read is in flight rather than being cleared to a
 * spinner: the re-read follows a write the reader just performed, and blanking the queue in front
 * of them to redraw almost the same rows reports nothing they need. A failure still replaces it —
 * a section that cannot be read must say so rather than keep showing an answer it can no longer
 * stand behind.
 *
 * `live` is the same guard `AdminPage.load` uses: a panel unmounted mid-flight must not set state.
 * It is re-armed on mount rather than only on the initial `useRef`, so a mount → unmount → remount
 * (React StrictMode, or any future remount of this subtree) does not leave the panel permanently
 * blank behind a `live` that is stuck false.
 *
 * `readId` is the same guard `MonthlyTab.readMonth` uses, and it earns its place here now that
 * there can be two reads in flight: the first to come back is not necessarily the newer one, and
 * an out-of-order landing would restore precisely the stale answer `reloadOn` exists to replace.
 */
function useSectionRead<T>(read: () => Promise<T>, fallback: string, reloadOn: number) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
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
        const data = await read();
        if (live.current && id === readId.current) setState({ data });
      } catch (caught) {
        if (live.current && id === readId.current) {
          setState({ error: describeFailure(caught, fallback) });
        }
      }
    })();
  }, [reloadOn]);

  return state;
}

// ---- 1. waiting on a decision ------------------------------------------------------------------

function PendingSection(
  { api, queueToken, viewerEmployeeId, onDecided }: {
    api: KintaiAdminClient;
    queueToken: number;
    viewerEmployeeId: EmployeeId | null;
    onDecided: () => void;
  },
) {
  const read = useCallback(() => api.listPendingOverview(), [api]);
  /*
   * The one read on this tab that the screen's own writes can invalidate, in two ways.
   *
   * `eligibleActorNames` is not a stored column: `pendingOverview` asks `eligibleActors`, which
   * probes `checkMayAct` against the live org chart — so every roster repair in section 3 can
   * change whether a row is stranded. `amendment.lockedPeriod` is not a property of the request
   * either: it is a join onto `period_locks` — so closing a month in 月次 can change whether a
   * pending correction is marked as writing into a closed month. Both are facts about the rest of
   * the system as of the instant of the read, which is exactly what a mount-once read cannot tell
   * the truth about once the reader starts writing.
   */
  const { data, error } = useSectionRead(read, "Couldn’t read the 承認待ち queue.", queueToken);
  const stranded = data?.filter((item) => item.eligibleActorNames.length === 0).length ?? 0;

  return (
    <Section
      testId="pending-section"
      heading="承認待ち · waiting on a decision"
      summary={data === undefined
        ? undefined
        : `${data.length} ${data.length === 1 ? "request" : "requests"}` +
          (stranded > 0 ? ` · ${stranded} with nobody able to decide` : "")}
    >
      {error !== undefined ? (
        <SectionError testId="pending-error" message={error} />
      ) : data === undefined ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty testId="pending-empty">
          承認待ちはありません — nothing is waiting on anybody’s decision.
        </Empty>
      ) : (
        <ul className="divide-y divide-kumo-line border-y border-kumo-line">
          {data.map((item) => (
            <PendingRow
              key={item.id} item={item} api={api} viewerEmployeeId={viewerEmployeeId}
              onDecided={onDecided}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function PendingRow(
  { item, api, viewerEmployeeId, onDecided }: {
    item: PendingItem;
    api: KintaiAdminClient;
    viewerEmployeeId: EmployeeId | null;
    onDecided: () => void;
  },
) {
  const closed = item.amendment?.lockedPeriod ?? null;
  const mine = viewerEmployeeId !== null && item.eligibleActorIds.includes(viewerEmployeeId);
  return (
    <li
      className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3"
      data-submission={item.id}
    >
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium text-kumo-default">
          {item.employeeName} · {item.employeeNumber}
        </p>
        <p className="text-xs text-kumo-subtle" data-testid="asks">{describeAsk(item)}</p>
        {/* Whose hand filed it, which is not always whose request it is — and a null here records
            that no filer was captured rather than that they filed it themselves. Conflating those
            would hide the commonest way a request stalls: whoever files one cannot decide it, so
            a request filed by its only possible approver is stranded by construction. */}
        <p className="text-xs text-kumo-inactive" data-testid="filed-by">
          {item.filedByName === null
            ? "Who filed it was not recorded."
            : `Filed by ${item.filedByName}.`}
        </p>
        {closed !== null && (
          <p className="text-xs text-kumo-danger" data-testid="closed-period">
            {/* Same fact `describeCorrectionApproval` states twice to the approver: applying an
                approved correction is the only write allowed into a closed month, and a month is
                closed precisely when somebody has already been paid on its totals. */}
            締め済み {closed} — the period {closed} is closed. Approving this changes a month that
            has already been closed off.
          </p>
        )}
      </div>

      <div className="min-w-56 flex-1">
        {item.eligibleActorNames.length === 0 ? (
          <p className="text-xs font-medium text-kumo-danger" data-testid="stranded" role="alert">
            Nobody can decide this — it will wait for ever. Give {item.employeeName} a manager or a
            designated approver on the Roster tab, or look at who filed it: whoever files a request
            can never be the one who decides it.
          </p>
        ) : mine ? (
          <>
            <p className="text-xs font-medium text-kumo-default" data-testid="deciders">
              Yours to decide
              {item.eligibleActorNames.length > 1
                ? ` — you are one of: ${item.eligibleActorNames.join(", ")}`
                : ""}
            </p>
            <DecisionControls item={item} api={api} onDecided={onDecided} />
          </>
        ) : (
          <p className="text-xs text-kumo-subtle" data-testid="deciders">
            Can be decided by {item.eligibleActorNames.join(", ")} — not by you, and not here: one
            of them decides it from their own dashboard, or by asking their assistant for their
            pending approvals.
          </p>
        )}
      </div>

      {/* A bucket, not a clock. An age that ticked would rerender the whole queue every second to
          report a precision nobody can act on, and "3日" is the entire decision this column
          informs: chase it, or leave it. */}
      <p className="shrink-0 text-xs text-kumo-subtle" data-testid="waiting">
        {formatAge(item.waitingMs)}
      </p>
    </li>
  );
}

const DECISION_LABELS: Record<ApprovalAction, string> = {
  approve: "承認",
  return: "差し戻し",
  reject: "却下",
};

/**
 * The three decisions, two-step and inline — the same shape as 月次's month close, and for the same
 * reasons: never `window.confirm`, and the confirmation is pinned to ONE request, restating it in
 * the words the agent's OS card would have used (`describeAsk`), so a manager reads what they are
 * about to decide before they decide it. 差し戻し and 却下 require a comment: the employee reads it
 * as the reason, and a bare rejection tells them nothing they can act on. 承認 does not, matching
 * the agent path where the comment is optional.
 *
 * On success this calls `onDecided` and otherwise leaves the row alone: the queue is re-read and
 * the store's answer decides whether the row disappears (decided) or stays (a multi-step route
 * advanced to somebody else's step). Optimistically removing it here would be the panel
 * contradicting the write beside it, which is the bug `queueToken` exists to prevent.
 */
function DecisionControls(
  { item, api, onDecided }: { item: PendingItem; api: KintaiAdminClient; onDecided: () => void },
) {
  const [armed, setArmed] = useState<ApprovalAction | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const commentId = useId();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const needsComment = armed !== null && armed !== "approve";
  const ready = armed !== null && (!needsComment || comment.trim() !== "");

  const arm = (action: ApprovalAction) => {
    setArmed(action);
    setError(undefined);
  };
  const cancel = () => {
    setArmed(null);
    setComment("");
    setError(undefined);
  };
  const decide = async () => {
    if (armed === null || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = comment.trim();
      await api.decideSubmission(item.id, armed, trimmed === "" ? undefined : trimmed);
      if (live.current) {
        setArmed(null);
        setComment("");
        setBusy(false);
      }
      onDecided();
    } catch (caught) {
      if (live.current) {
        setError(describeFailure(caught, "決定できませんでした。"));
        setBusy(false);
      }
    }
  };

  return (
    <div className="mt-2" data-testid="decision-controls">
      {armed === null ? (
        <div className="flex flex-wrap gap-2">
          {(["approve", "return", "reject"] as const).map((action) => (
            <button
              key={action}
              type="button"
              data-action={`decide-${action}`}
              className={action === "approve"
                ? "press rounded-lg bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-kumo-brand-hover"
                : "press rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"}
              onClick={() => arm(action)}
            >
              {DECISION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg bg-kumo-tint px-3 py-3" data-testid="decision-confirm">
          <p className="text-xs text-kumo-default">
            <span className="font-medium">{DECISION_LABELS[armed]}</span>
            {` — ${item.employeeName}: ${describeAsk(item)}`}
          </p>
          {needsComment && (
            <div className="mt-2 flex flex-col gap-1">
              <label htmlFor={commentId} className="text-xs font-medium text-kumo-default">
                理由（本人に表示されます）
              </label>
              <input
                id={commentId}
                type="text"
                data-testid="decision-comment"
                placeholder={armed === "return"
                  ? "例: 退勤時刻を確認して再申請してください"
                  : "例: 現場の記録と一致しません"}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                className="w-full rounded border border-kumo-line bg-kumo-control px-2 py-1.5 text-sm text-kumo-default placeholder:text-kumo-inactive"
              />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-action="confirm-decision"
              disabled={busy || !ready}
              className={armed === "approve"
                ? "press rounded-lg bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-60"
                : "press rounded-lg border border-kumo-danger bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-danger hover:bg-kumo-tint disabled:opacity-60"}
              onClick={() => void decide()}
            >
              {DECISION_LABELS[armed]}する
            </button>
            <button
              type="button"
              data-action="cancel-decision"
              disabled={busy}
              className="press rounded-lg px-3 py-1.5 text-xs font-medium text-kumo-subtle hover:bg-kumo-tint"
              onClick={cancel}
            >
              取り消す
            </button>
          </div>
          {error !== undefined && (
            <p className="mt-2 text-xs text-kumo-danger" role="alert" data-testid="decision-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the request asks for, in the words the approver's own confirmation uses.
 *
 * The correction arm mirrors `describeCorrectionApproval` in `src/kintai.ts` term for term — the
 * arrow, "added at", "(none recorded)" — deliberately, and NOT because the string is shared: it
 * cannot be (that module reaches the store, which the app cannot compile). What must never happen
 * is a third phrasing, where the queue describes a correction one way and the confirmation the
 * administrator or approver then reads describes it another. The only word dropped is "punch",
 * because the row already sits under a heading that says what these are and the kind is right
 * there.
 *
 * An amendment's `minutes` is 0 BY DESIGN and means nothing, so this branches on the amendment
 * detail's presence, exactly as `describeApproval` does. Rendering every row through the overtime
 * shape is how an approver's queue once reported a punch correction as a request for zero minutes.
 */
function describeAsk(item: PendingItem): string {
  const amendment = item.amendment;
  if (amendment === undefined) {
    return `${formatDuration(item.minutes)} of overtime on ${item.requested_for}`;
  }
  const requested = jstClockTime(amendment.requestedOccurredAt);
  // An addition has no left-hand side. "(none recorded)" is the honest comparison; a fabricated
  // 00:00 would read as a punch that exists.
  const change = amendment.currentOccurredAt === null
    ? `${amendment.kind} added at ${requested} (none recorded)`
    : `${amendment.kind} ${jstClockTime(amendment.currentOccurredAt)} → ${requested}`;
  return `${amendment.workDate}: ${change}`;
}

/**
 * `2h 30m`, `45m`, `3h`.
 *
 * The same shape as `formatDuration` in `src/kintai.ts`, and a genuine second copy of six lines of
 * arithmetic. It is tolerated because the alternative is worse in both directions: `kintai.ts`
 * imports the store, so importing it here fails `typecheck:app` on every `SqlStorage` in the
 * transitive graph, and moving the formatter into a leaf module (as `jstClockTime` legitimately
 * was) would put a payroll-confirmation string in a module whose other job is arithmetic on
 * instants. Nothing depends on the two agreeing to the character: this labels a triage row, that
 * one titles an approval a manager signs. If they ever must agree, the fix is a shared leaf, not a
 * third copy.
 */
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * How long it has waited, as a bucket: `3日`, `5時間`, or `1時間未満`.
 *
 * Truncated rather than rounded, so a row never claims to be older than it is, and coarse on
 * purpose — see the column's comment. `waitingMs` is measured server-side against one instant for
 * the whole read, so every row on one dashboard open is judged against the same moment; this
 * function reads no clock of its own and there is nothing for it to drift against.
 */
function formatAge(waitingMs: number): string {
  // Clamped at zero. `submitted_at` is nullable and reports 0 rather than a fifty-six-year wait
  // (see `pendingOverview`), but a clock that moved backwards between the write and the read can
  // still hand this a negative, and "-1時間" would read as a bug in the queue rather than in a
  // clock.
  const hours = Math.max(0, Math.floor(waitingMs / (60 * 60 * 1000)));
  if (hours >= 24) return `${Math.floor(hours / 24)}日`;
  return hours === 0 ? "1時間未満" : `${hours}時間`;
}

// ---- 2. days that need a look ------------------------------------------------------------------

/**
 * How each anomaly flag reads to a human.
 *
 * The keys are the strings `dayAnomalies` pushes, and an unknown one falls through to the flag
 * itself rather than to nothing: a flag added on the worker side must surface as an ugly row
 * rather than as a day that looks clean. Same reason this map has no `Record<Anomaly, string>`
 * type to enforce completeness — the flags are plain strings on the wire, and being exhaustive
 * against a list this module cannot see would be a compile-time promise about somebody else's
 * enumeration.
 */
const ANOMALY_LABELS: Record<string, string> = {
  unpaired_in: "退勤打刻なし",
  unpaired_break: "休憩終了の打刻なし",
  orphan_out: "出勤打刻のない退勤",
  duplicate_in: "出勤打刻の重複",
  negative_gross: "休憩が労働時間を超過",
  long_span: "14時間以上の勤務",
};

function AnomaliesSection({ api }: { api: KintaiAdminClient }) {
  /*
   * The month the administrator is in, in JST, decided ONCE for the life of the panel.
   *
   * `jstWorkDate` rather than `toISOString().slice(0, 7)`: the latter is UTC and would report the
   * previous month for the first nine hours of every Japanese day — the same nine hours
   * `workDateStart` exists because of. Read once and held so the heading cannot come to name a
   * month the rows below it are not from: the read happens on mount and never again, so a `period`
   * recomputed on every render would silently disagree with its own data the moment a page left
   * open crosses midnight on the 1st.
   */
  const [period] = useState(() => jstWorkDate(Date.now()).slice(0, 7));
  const read = useCallback(() => api.listAnomalousDays(period), [api, period]);
  /*
   * No invalidator, so a constant: this read stays mount-once, and that is an argument rather
   * than an omission.
   *
   * A flag comes from `dayAnomalies`, which groups punches by the stored `work_date` COLUMN and
   * reads neither the org chart nor a policy — and NOTHING on this dashboard writes a punch. A
   * roster repair changes who may approve; closing a month changes what may be written into it;
   * neither moves a flag. `setWorkDatePolicy` is not the exception it looks like: the policy
   * decides a punch's `work_date` at the moment that punch is recorded, and changing it never
   * re-attributes a punch already stored.
   *
   * What would genuinely invalidate this is a new punch or an applied correction, and both of
   * those happen elsewhere — by design, see this module's header. If a decide control ever lands
   * on this tab, this is the paragraph that has to be redone rather than quietly outgrown.
   */
  const { data, error } = useSectionRead(read, "Couldn’t read the flagged days.", 0);

  // Grouped by employee, in the order the read returned them: one row per flagged day, but the
  // person named once. The read is already ordered by employee then date, so this preserves it.
  const groups: { employeeId: EmployeeId; label: string; days: AnomalousDay[] }[] = [];
  for (const day of data ?? []) {
    const last = groups.at(-1);
    if (last?.employeeId === day.employeeId) last.days.push(day);
    else {
      groups.push({
        employeeId: day.employeeId,
        label: `${day.displayName} · ${day.employeeNumber}`,
        days: [day],
      });
    }
  }

  return (
    <Section
      testId="anomalies-section"
      heading={`要確認の勤務日 · days that need a look (${period})`}
      summary={data === undefined
        ? undefined
        : `${data.length} ${data.length === 1 ? "day" : "days"} across ` +
          `${groups.length} ${groups.length === 1 ? "employee" : "employees"}`}
    >
      {error !== undefined ? (
        <SectionError testId="anomalies-error" message={error} />
      ) : data === undefined ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty testId="anomalies-empty">
          フラグの立った勤務日はありません — every day with punches this month pairs up.
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.employeeId} data-anomaly-employee={group.employeeId}>
              <p className="text-sm font-medium text-kumo-default">{group.label}</p>
              <ul className="mt-1 divide-y divide-kumo-line border-y border-kumo-line">
                {group.days.map((day) => (
                  <AnomalousDayRow key={day.workDate} day={day} api={api} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * One flagged day, with its punches one press away.
 *
 * Lazily, and the laziness is a privacy decision as much as a performance one: `getEmployeeDay` is
 * the punch-level read — the clock times one named person tapped in and out on one named day — and
 * a dashboard that prefetched it for every flagged row would pull the whole company's punches to
 * render a list of dates. A SUCCESSFUL read is kept: pressing the button again folds the detail
 * away without discarding it, so a reader comparing two days does not re-read either. A FAILED one
 * is discarded on the way out, so re-expanding retries — see `toggle`.
 *
 * No decide or repair control here, and that is not an omission. A wrong punch is fixed by an
 * amendment, which belongs to the employee and to whoever may approve for them; a button here
 * would either bypass that approval or pretend to start it. What this section owes the reader is
 * the truth about the day.
 */
function AnomalousDayRow({ day, api }: { day: AnomalousDay; api: KintaiAdminClient }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ day?: EmployeeDay; error?: string }>();
  const live = useRef(true);
  // Armed here, not only by `useRef`: on a mount → unmount → remount of this row the ref survives
  // with `false` in it, and every later read would then be discarded on arrival — a row whose
  // punches never appear, with no error to explain it. See the same guard in `useSectionRead`.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const toggle = () => {
    if (open) {
      setOpen(false);
      // A failure is thrown away on the way out, and that asymmetry with a successful read is the
      // whole point. The guard below skips the read whenever ANY state is stored for this day,
      // and a stored error is state — so one transient blip used to make a day unreadable for the
      // life of the page, on the section whose entire job is "look at this day". Collapsing is
      // the only control the row has; it is therefore also the retry.
      if (detail?.error !== undefined) setDetail(undefined);
      return;
    }
    setOpen(true);
    if (detail !== undefined) return;
    // Marked as in flight before the await, so a double press cannot start two reads.
    setDetail({});
    void (async () => {
      try {
        const read = await api.getEmployeeDay(day.employeeId, day.workDate);
        if (live.current) setDetail({ day: read });
      } catch (caught) {
        if (live.current) {
          setDetail({ error: describeFailure(caught, "Couldn’t read that day’s punches.") });
        }
      }
    })();
  };

  return (
    <li className="py-3" data-day={`${day.employeeId}:${day.workDate}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="font-mono text-xs text-kumo-default">{day.workDate}</p>
        <p className="min-w-48 flex-1 text-xs text-kumo-danger" data-testid="flags">
          {day.anomalies.map((flag) => ANOMALY_LABELS[flag] ?? flag).join(" · ")}
        </p>
        <button
          type="button"
          data-action="expand-day"
          aria-expanded={open}
          className="press shrink-0 rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={toggle}
        >
          {open ? "Hide punches" : "Show punches"}
        </button>
      </div>

      {open && (
        <div className="mt-2 rounded-lg bg-kumo-tint px-3 py-2" data-testid="day-detail">
          {detail?.error !== undefined ? (
            <p className="text-xs text-kumo-danger" role="alert">{detail.error}</p>
          ) : detail?.day === undefined ? (
            <p className="text-xs text-kumo-subtle">Reading the punches…</p>
          ) : (
            <>
              <ul className="flex flex-col gap-0.5">
                {detail.day.punches.map((punch) => (
                  <li key={punch.id} className="font-mono text-xs text-kumo-default" data-testid="punch">
                    {jstClockTime(punch.occurred_at)} {punch.kind}
                    <PunchSource punch={punch} />
                  </li>
                ))}
              </ul>
              {detail.day.punches.length === 0 && (
                <p className="text-xs text-kumo-subtle">No punches on this day any more.</p>
              )}
              {/* The minutes and the punches are one read, taken now; the flags on the row above
                  came with the list. They can disagree if a correction was applied in between,
                  and the fresher pair is the one to believe — which is the reason the drill-down
                  reads the day rather than being handed a cached copy of it. */}
              <p className="mt-1 text-xs text-kumo-subtle" data-testid="credited">
                Credited {formatDuration(detail.day.workedMinutes)}
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---- 3. who cannot use Kintai yet --------------------------------------------------------------

/**
 * The roster rows that block somebody from using the system, with the Roster tab's own repairs.
 *
 * `RosterRow` and `isReady` are imported, not reimplemented — see `RosterRow.tsx`. This section is
 * upstream of the other two: an employee with nobody able to approve for them files nothing, so
 * their overtime never reaches section 1 and never becomes a row anybody can see as missing. It is
 * last because it is the least urgent thing on the screen and the most easily fixed.
 *
 * `canSetManager` carries the roster's rule unchanged: a reporting line needs somebody to report
 * TO, so with one record the button that would scroll to an empty form is not rendered.
 */
function BlockersSection({ roster, fixes }: { roster: RosterEntry[]; fixes: RowFixes }) {
  const names = new Map(roster.map((row) => [row.id, row.display_name]));
  const blocked = roster.filter((row) => !isReady(row));

  return (
    <Section
      testId="blockers-section"
      heading="未整備 · not ready to use Kintai"
      summary={blocked.length === 0
        ? undefined
        : `${blocked.length} ${blocked.length === 1 ? "employee" : "employees"}`}
    >
      {blocked.length === 0 ? (
        <Empty testId="blockers-empty">
          {roster.length === 0
            ? "従業員がまだ登録されていません — add the first record on the Roster tab."
            : "全員 Kintai を使える状態です — everybody is linked and has somebody who can" +
              " approve for them."}
        </Empty>
      ) : (
        <ul className="divide-y divide-kumo-line border-y border-kumo-line">
          {blocked.map((employee) => (
            <RosterRow
              key={employee.id}
              employee={employee}
              names={names}
              canSetManager={roster.length >= 2}
              onLink={() => fixes.onLink(employee)}
              onSetManager={() => fixes.onSetManager(employee)}
              onSetApprover={() => fixes.onSetApprover(employee)}
              onExempt={() => fixes.onExempt(employee)}
              onSetPolicy={() => fixes.onSetPolicy(employee)}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---- the furniture -----------------------------------------------------------------------------

function Section({
  testId, heading, summary, children,
}: {
  testId: string;
  heading: string;
  summary?: string;
  children: ReactNode;
}) {
  // Named by its own heading, the way the roster section is: a `<section>` with no accessible
  // name is not a landmark, and this screen is three of them stacked.
  const headingId = useId();
  return (
    <section data-testid={testId} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-kumo-default">{heading}</h2>
        {summary !== undefined && <p className="text-xs text-kumo-subtle">{summary}</p>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * What "nothing here" means, never a blank space.
 *
 * A dashboard with three empty sections is the best possible state of this system, and it has to
 * read that way. Three silent gaps read as a screen that failed to load — which is the reading
 * that gets a real queue ignored the day it is not empty.
 */
function Empty({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p
      className="rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

/**
 * One section's failure, in that section.
 *
 * Beside what failed and nowhere else, for the reason the forms' notices are: a queue that could
 * not be read and a flagged-days read that could not be read are different problems, and neither
 * of them is a reason to blank the other two sections or to take down the page.
 */
function SectionError({ testId, message }: { testId: string; message: string }) {
  return (
    <p className="text-sm text-kumo-danger" data-testid={testId} role="alert">{message}</p>
  );
}

function Loading() {
  return <p className="text-sm text-kumo-subtle">Loading…</p>;
}
