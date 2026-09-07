import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
/*
 * The wire shapes, imported for real — not restated here, which is what this file did until
 * 2026-09-04.
 *
 * `src/types.ts` is the one module both TypeScript programs can reach: it imports nothing, so it
 * pulls no `SqlStorage` into `tsconfig.app.json`'s graph, and every row shape the dashboard renders
 * now lives there beside `EmployeeRow` and `KintaiIdentity`. The store modules that QUERY these
 * rows re-export them under the same names, so a rename is one edit that breaks both sides at once
 * — where the hand-written copies compiled clean in both projects and left this page rendering
 * `undefined` at runtime, i.e. a white screen, with no error boundary above it.
 *
 * `src/types.txt` is still a hand-written copy of some of these and has no mechanical tie to them.
 * See the note in `src/types.ts`.
 */
import type {
  AnomalousDay, EmployeeDay, EmployeeId, KintaiIdentity, MonthlyReport, NewEmployee, PendingItem,
  RosterEntry, WorkDatePolicy,
} from "../src/types";
import { WORK_DATE_POLICIES, WORK_DATE_POLICY_LABELS } from "../src/work-date";
import { describeFailure, isAdminRequired } from "./errors";
import { MonthlyTab } from "./MonthlyTab";
import { OverviewTab } from "./OverviewTab";
import { isReady, RosterRow } from "./RosterRow";

/**
 * The capability this page calls, as the page sees it.
 *
 * The same shape whoever is looking: `startAppUi` decides server-side which class is behind it,
 * and both implement `KintaiAdminApi`. There is no admin flag on this side to branch on and
 * nothing to ask — a non-admin's stub simply refuses, which is why `listEmployees` doubles as the
 * probe below.
 */
export type KintaiAdminClient = {
  whoAmI(): Promise<KintaiIdentity>;
  listEmployees(): Promise<RosterEntry[]>;
  createEmployee(input: NewEmployee): Promise<EmployeeId>;
  linkAccount(accountId: string, employeeId: EmployeeId): Promise<void>;
  setReportingLine(employeeId: EmployeeId, managerId: EmployeeId): Promise<void>;
  setDesignatedApprover(employeeId: EmployeeId, approverId: EmployeeId): Promise<void>;
  grantExemption(employeeId: EmployeeId): Promise<void>;
  setWorkDatePolicy(employeeId: EmployeeId, policy: WorkDatePolicy): Promise<void>;
  /** Every submission waiting on somebody, with who — if anybody — can decide it. */
  listPendingOverview(): Promise<PendingItem[]>;
  /** Every (employee, day) in `period` (`YYYY-MM`) carrying an anomaly flag, with the flags. */
  listAnomalousDays(period: string): Promise<AnomalousDay[]>;
  /** One employee's one day: the punches, the flags they raise, the minutes they credit. */
  getEmployeeDay(employeeId: EmployeeId, workDate: string): Promise<EmployeeDay>;
  /** One month per employee — days, minutes, flagged days — plus whether the month is closed. */
  monthlyReport(period: string): Promise<MonthlyReport>;
  /**
   * Close `period`. ONE-WAY: there is no unlock anywhere in this package.
   *
   * Refuses a month already closed (`KINTAI_ALREADY_LOCKED`, a race no caller can pre-empt), a
   * month that has not started (`KINTAI_FUTURE_PERIOD`), a malformed one, and an administrator
   * whose own account is not linked to an employee record (`KINTAI_ADMIN_NOT_LINKED` — the close
   * records who performed it).
   */
  lockPeriod(period: string): Promise<void>;
};

/**
 * The five repairs a roster row can ask for.
 *
 * One object rather than five props because TWO tabs pass them now: the Roster tab's list and
 * 要対応's third section render the same `RosterRow`, so the set has to travel as a unit or the
 * two call sites drift the next time a sixth repair appears.
 */
export type RowFixes = {
  onLink: (employee: RosterEntry) => void;
  onSetManager: (employee: RosterEntry) => void;
  onSetApprover: (employee: RosterEntry) => void;
  onExempt: (employee: RosterEntry) => void;
  onSetPolicy: (employee: RosterEntry) => void;
};

type View =
  | { status: "loading" }
  | { status: "failed"; message: string }
  /** Not an administrator: their own account code, and nothing else. */
  | { status: "employee"; identity: KintaiIdentity }
  | { status: "admin"; identity: KintaiIdentity; roster: RosterEntry[] };

/** Which form a message or a spinner belongs to. Failures must land beside what failed. */
type FormKey = "create" | "link" | "report" | "approver" | "exempt" | "policy";
type Notice = { kind: "ok" | "error"; text: string };

/**
 * The admin dashboard's three panels. 要対応 ("needs attention") is the default: it is the queue
 * an administrator opening this page is most likely here for, not the roster they only visit to
 * onboard or repair somebody.
 */
type Tab = "overview" | "monthly" | "roster";

/**
 * The Kintai HR screens.
 *
 * Two views in one component, deliberately. Which one a person gets is a single piece of state
 * derived from one probe, and both share the account card, the loading state, the failure state
 * and the retry — splitting them into two roots would mean two copies of all of that, and the
 * thing most likely to drift is precisely the boundary between them. The admin half is a subtree
 * that is present or absent; it is not a permission this component decides, and there is nothing
 * it could decide differently, because a non-admin's capability has no admin behaviour behind it.
 *
 * How it learns which it is: it calls `listEmployees()` and reads the refusal. There is no admin
 * flag in the frame and no way to ask for one — `startAppUi` consumes `isAdmin` server-side and
 * never sends it — so a refusal IS the answer. Only `KINTAI_ADMIN_REQUIRED` means "not an
 * administrator"; any other failure is a failure, and is shown as one rather than quietly
 * degrading an administrator into a viewer.
 */
export default function AdminPage({ api }: { api: KintaiAdminClient }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [pending, setPending] = useState<FormKey>();
  const [notices, setNotices] = useState<Partial<Record<FormKey, Notice>>>({});
  // Set by the roster's row actions so a form opens on the employee whose row was clicked.
  const [linkTarget, setLinkTarget] = useState<string>("");
  const [reportTarget, setReportTarget] = useState<string>("");
  const [approverTarget, setApproverTarget] = useState<string>("");
  const [exemptTarget, setExemptTarget] = useState<string>("");
  const [policyTarget, setPolicyTarget] = useState<string>("");
  const linkCodeRef = useRef<HTMLInputElement>(null);
  const managerRef = useRef<HTMLSelectElement>(null);
  const approverRef = useRef<HTMLSelectElement>(null);
  const exemptRef = useRef<HTMLSelectElement>(null);
  const policyRef = useRef<HTMLSelectElement>(null);
  const live = useRef(true);
  // A repair asked for by a row, waiting for the render that shows the form it belongs to. The
  // nonce is what makes pressing the SAME button twice a second request rather than a no-op.
  const [toReveal, setToReveal] = useState<{
    action: string; ref: React.RefObject<HTMLElement | null>; nonce: number;
  }>();
  const nonce = useRef(0);
  /*
   * HOW MANY WRITES THIS SCREEN HAS MADE THAT 要対応'S QUEUE READ DEPENDS ON.
   *
   * Bumped, never read for its value. `OverviewTab` threads it into the dependency list of
   * section 1's read (see `useSectionRead`), so a bump re-runs that one read and nothing else.
   *
   * It exists because all three panels are mounted from the first admin render and each read
   * independently on mount — which meant the screen went on asserting facts its own writes had
   * already undone, with a full reload of the iframe the only way out. Two of those, both probed
   * on the running page:
   *
   *  - Repair a stranded employee from 要対応's own third section and section 1 kept saying
   *    "Nobody can decide this — it will wait for ever" about the request that repair had just
   *    unblocked. Section 3 updated, because it renders the `roster` prop that `load` re-reads;
   *    sections 1 and 2 had no equivalent. `eligibleActorNames` is not a stored column —
   *    `pendingOverview` asks `eligibleActors`, a probe of the live org chart — so every repair
   *    below can change that answer.
   *  - Close a month in 月次 and a pending correction dated inside it still rendered without its
   *    締め済み marker. `amendment.lockedPeriod` is a join onto `period_locks`, not a property of
   *    the request.
   *
   * WHICH READS ARE DELIBERATELY NOT WIRED TO IT, because a blanket "re-read everything after any
   * write" would be shorter to write and would put the two mount-once tests in permanent tension
   * with this fix:
   *
   *  - The flagged days (`listAnomalousDays`). Nothing on this dashboard writes a punch, and a
   *    flag is computed from punches grouped by their stored `work_date`. See the argument in
   *    `AnomaliesSection`, including why `setWorkDatePolicy` is not the exception it resembles.
   *  - 月次's report (`monthlyReport`). A roster repair moves no worked minutes and no day count:
   *    every number there is arithmetic over punches, and an exemption or a reporting line
   *    changes neither. A close DOES change that panel — and that panel already re-reads its own
   *    month, with a guard for the picker having moved that this token must not disturb.
   *  - The roster itself. `submit` already calls `load`, which is what section 3 reacts to.
   *
   * A tab flip bumps nothing, which is what keeps "reads once on mount, hidden or not, and never
   * again on a tab flip" true and meaningful rather than merely still passing.
   */
  const [queueToken, setQueueToken] = useState(0);
  const invalidateQueue = useCallback(() => setQueueToken((count) => count + 1), []);

  // Armed in the effect body, not only by `useRef`: the ref outlives a mount → unmount → remount
  // (React StrictMode double-invokes exactly this pair) and a `live` left false would discard
  // every read and every notice on arrival — the page stuck on "Loading your account…" for good.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (toReveal) reveal(toReveal.ref.current, toReveal.action);
  }, [toReveal]);

  const load = useCallback(async () => {
    // Both calls are started together, each with its own handler attached synchronously, so a
    // refusal from one is never an unhandled rejection while the other is in flight.
    const identityCall = api.whoAmI();
    const rosterCall = api.listEmployees().then(
      (roster) => ({ roster }),
      (error: unknown) => ({ error }),
    );
    let identity: KintaiIdentity;
    try {
      identity = await identityCall;
    } catch (caught) {
      await rosterCall;
      if (live.current) {
        setView({
          status: "failed",
          message: describeFailure(caught, "Couldn’t read your Kintai account."),
        });
      }
      return;
    }
    const result = await rosterCall;
    if (!live.current) return;
    if ("roster" in result) {
      setView({ status: "admin", identity, roster: result.roster });
    } else if (isAdminRequired(result.error)) {
      setView({ status: "employee", identity });
    } else {
      setView({
        status: "failed",
        message: describeFailure(result.error, "Couldn’t load the roster."),
      });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Perform one form's action, then re-read everything it could have changed.
   *
   * The reload is not a nicety: `linkAccount` and `setReportingLine` both change whether other
   * employees are usable, and the roster is the only place this screen tells the truth about that.
   * `action` returns the sentence to show on success, so the confirmation can name what happened.
   */
  const submit = useCallback(
    async (key: FormKey, fallback: string, action: () => Promise<string>): Promise<boolean> => {
      setPending(key);
      setNotices((current) => ({ ...current, [key]: undefined }));
      try {
        const done = await action();
        await load();
        if (live.current) {
          // Every repair here changes the org chart, and 要対応's queue answers "who can decide
          // this" by probing that chart. See `queueToken`.
          invalidateQueue();
          setNotices((current) => ({ ...current, [key]: { kind: "ok", text: done } }));
        }
        return true;
      } catch (caught) {
        if (live.current) {
          setNotices((current) => ({
            ...current, [key]: { kind: "error", text: describeFailure(caught, fallback) },
          }));
        }
        return false;
      } finally {
        if (live.current) setPending(undefined);
      }
    },
    [load, invalidateQueue],
  );

  /**
   * Bring the reader to the form that performs a repair, from whichever tab asked for it.
   *
   * Switching to the Roster tab is load-bearing, not a courtesy: every form lives in that panel,
   * which is `hidden` while 要対応 is open, and focusing a field inside a hidden subtree does
   * nothing at all in a real browser. A row in 要対応's third section that only preselected an
   * employee would be exactly the silent no-op this page keeps going out of its way not to ship.
   * Harmless when the reader is already on the Roster tab.
   *
   * The reveal itself happens in the effect above rather than here, because at this instant the
   * panel may still be hidden and the field one state update away from being focusable.
   */
  const openForm = useCallback(
    (action: string, ref: React.RefObject<HTMLElement | null>) => {
      setTab("roster");
      nonce.current += 1;
      setToReveal({ action, ref, nonce: nonce.current });
    },
    [],
  );

  /** The row repairs, wired once and rendered by two tabs. See `RowFixes`. */
  const fixes: RowFixes = {
    onLink: (employee) => {
      setLinkTarget(String(employee.id));
      openForm("link-account", linkCodeRef);
    },
    onSetManager: (employee) => {
      setReportTarget(String(employee.id));
      openForm("set-reporting-line", managerRef);
    },
    onSetApprover: (employee) => {
      setApproverTarget(String(employee.id));
      openForm("set-designated-approver", approverRef);
    },
    onExempt: (employee) => {
      setExemptTarget(String(employee.id));
      openForm("grant-exemption", exemptRef);
    },
    onSetPolicy: (employee) => {
      setPolicyTarget(String(employee.id));
      openForm("set-work-date-policy", policyRef);
    },
  };

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Kintai</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          {view.status === "admin"
            ? "Employee records, account codes and reporting lines."
            : "Attendance and overtime."}
        </p>
      </header>

      {view.status === "loading" && (
        <p className="text-sm text-kumo-subtle">Loading your account…</p>
      )}

      {view.status === "failed" && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-kumo-danger" data-testid="error">{view.message}</p>
          <button
            type="button"
            data-action="retry"
            className="text-sm font-medium text-kumo-link hover:text-kumo-brand-hover"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {(view.status === "employee" || view.status === "admin") && (
        <AccountCard identity={view.identity} admin={view.status === "admin"} />
      )}

      {view.status === "admin" && (
        <>
          <TabBar tab={tab} onSelect={setTab} />

          <div hidden={tab !== "overview"} data-testid="panel-overview">
            <OverviewTab
              api={api} roster={view.roster} fixes={fixes} queueToken={queueToken}
            />
          </div>

          <div hidden={tab !== "monthly"} data-testid="panel-monthly">
            {/* 月次's flagged-day counts are a way INTO 要対応, not a second rendering of it — so
                the tab switch is this component's to perform, exactly as the roster repairs'
                `openForm` is. Passing the setter down would let that panel decide which tab is
                showing, which is the one piece of state this component exists to own. */}
            <MonthlyTab
              api={api}
              onShowOverview={() => setTab("overview")}
              // A close changes `period_locks`, which 要対応's queue read joins against. This
              // component owns the token because it owns both writes that invalidate that read;
              // handing the panel the setter would let it decide what else on the page is stale.
              onLockAttempted={invalidateQueue}
            />
          </div>

          <div
            hidden={tab !== "roster"} data-testid="panel-roster" className="flex flex-col gap-8"
          >
            <Roster
              roster={view.roster}
              // A reporting line needs somebody to report TO, so with one employee on the roster the
              // form has nothing to offer and says so. The row's button is hidden to match: rendering
              // it would leave a control that looks like the fix, is clickable, and does nothing —
              // the same silent no-op this page went to some trouble to stop producing.
              canSetManager={view.roster.length >= 2}
              fixes={fixes}
            />

            <div className="flex flex-col gap-4">
              <LinkAccountForm
                roster={view.roster}
                employeeId={linkTarget}
                onEmployeeId={setLinkTarget}
                codeRef={linkCodeRef}
                busy={pending === "link"}
                notice={notices.link}
                onSubmit={(accountId, employeeId) =>
                  submit("link", "Couldn’t link that account code.", async () => {
                    await api.linkAccount(accountId, employeeId);
                    return `Linked ${nameOf(view.roster, employeeId)} to that account code.`;
                  })}
              />
              <ReportingLineForm
                roster={view.roster}
                employeeId={reportTarget}
                onEmployeeId={setReportTarget}
                managerRef={managerRef}
                busy={pending === "report"}
                notice={notices.report}
                onSubmit={(employeeId, managerId) =>
                  submit("report", "Couldn’t set that reporting line.", async () => {
                    await api.setReportingLine(employeeId, managerId);
                    return `${nameOf(view.roster, employeeId)} now reports to ` +
                      `${nameOf(view.roster, managerId)}.`;
                  })}
              />
              <DesignatedApproverForm
                roster={view.roster}
                employeeId={approverTarget}
                onEmployeeId={setApproverTarget}
                approverRef={approverRef}
                busy={pending === "approver"}
                notice={notices.approver}
                onSubmit={(employeeId, approverId) =>
                  submit("approver", "Couldn’t set that designated approver.", async () => {
                    await api.setDesignatedApprover(employeeId, approverId);
                    return `${nameOf(view.roster, approverId)} can now approve for ` +
                      `${nameOf(view.roster, employeeId)}.`;
                  })}
              />
              <ExemptionForm
                roster={view.roster}
                employeeId={exemptTarget}
                onEmployeeId={setExemptTarget}
                selectRef={exemptRef}
                busy={pending === "exempt"}
                notice={notices.exempt}
                onSubmit={(employeeId) =>
                  submit("exempt", "Couldn’t record that exemption.", async () => {
                    await api.grantExemption(employeeId);
                    return `${nameOf(view.roster, employeeId)} is recorded as 管理監督者 from now.`;
                  })}
              />
              <WorkDatePolicyForm
                roster={view.roster}
                employeeId={policyTarget}
                onEmployeeId={setPolicyTarget}
                selectRef={policyRef}
                busy={pending === "policy"}
                notice={notices.policy}
                onSubmit={(employeeId, policy) =>
                  submit("policy", "Couldn’t change that work-date policy.", async () => {
                    await api.setWorkDatePolicy(employeeId, policy);
                    return `${nameOf(view.roster, employeeId)}: new punches will be filed ` +
                      `${policy === "shift_start" ? "against the date their shift started" : "against the date they happen on"}.` +
                      " Punches already recorded are unchanged.";
                  })}
              />
              <CreateEmployeeForm
                roster={view.roster}
                busy={pending === "create"}
                notice={notices.create}
                onSubmit={(input) =>
                  submit("create", "Couldn’t create that employee.", async () => {
                    await api.createEmployee(input);
                    return `Added ${input.displayName}. They still need an account code` +
                      " and someone who can approve for them.";
                  })}
              />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "要対応" },
  { id: "monthly", label: "月次" },
  { id: "roster", label: "Roster" },
];

/**
 * The three panels, all mounted at once — see `hidden` on each panel above.
 *
 * Buttons, not links and not a `<select>`: nothing here navigates or submits, so there is no
 * sandbox concern the way `FormCard`'s fields have one — a native `<button>` already answers
 * Enter and Space without any extra handling, and `type="button"` only keeps it inert if it is
 * ever moved inside a `<form>`.
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

/**
 * Move the reader to the control that fixes the row they just clicked.
 *
 * Falls back to the form's card when the field is not rendered — a disabled `FormCard` renders its
 * explanation instead of its fields, so the ref is null and focusing nothing would make the row's
 * button look broken. Scrolling to the card at least shows the reader why the form is not there.
 * The row hides the button in that case anyway; this is the belt to that pair of braces.
 *
 * `scrollIntoView` is optional-called because it is absent in jsdom and, more to the point,
 * because nothing about jumping to a field is worth throwing out of a click handler if a host ever
 * disagrees about it. Focus is what actually matters; the scroll is a courtesy.
 */
function reveal(node: HTMLElement | null, formAction: string): void {
  const target = node ?? document.querySelector<HTMLElement>(`[data-form="${formAction}"]`);
  node?.focus();
  target?.scrollIntoView?.({ block: "center" });
}

/**
 * The caller's own account code.
 *
 * Shown to administrators too, and not as a courtesy: an admin whose own account is not linked to
 * an employee record is recorded as `null` on every audit entry they write, so linking themselves
 * is a real first step — and this is the only place their code appears. There is no registry of
 * provisioned accounts for anyone to look one up in, which is the whole reason this card exists.
 */
function AccountCard({ identity, admin }: { identity: KintaiIdentity; admin: boolean }) {
  const [copied, setCopied] = useState<"copied" | "select" | undefined>();
  const codeRef = useRef<HTMLParagraphElement>(null);

  // Best effort: the app runs in a sandboxed, opaque-origin iframe, where the async clipboard can
  // be unavailable however the host is configured. Falling back to selecting the text means the
  // button always does something the reader can finish by hand, rather than failing silently.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(identity.accountId);
      setCopied("copied");
    } catch {
      const node = codeRef.current;
      const selection = node && window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.addRange(range);
      }
      setCopied("select");
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4"
      aria-labelledby="account-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="account-heading" className="text-xs font-medium text-kumo-subtle">
            Your account code
          </h2>
          <p
            ref={codeRef}
            className="mt-1 font-mono text-sm break-all text-kumo-default select-all"
            data-testid="account-id"
          >
            {identity.accountId}
          </p>
        </div>
        <button
          type="button"
          data-action="copy-account-id"
          className="press shrink-0 rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={() => void copy()}
        >
          {copied === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "select" && (
        <p className="text-xs text-kumo-subtle" data-testid="copy-fallback">
          Selected the code — press ⌘C or Ctrl+C to copy it.
        </p>
      )}
      <p className="text-sm text-kumo-default" data-testid="linked">
        {identity.linked ? (
          <>
            {/* The id, not a name: `whoAmI` is the one method a non-admin may call, and it answers
                from `account_links` alone — the roster that holds display names is admin-only. The
                number is still what HR asks for when someone needs help. */}
            You’re set up — this account is employee record{" "}
            <span data-testid="employee-id">{identity.employeeId}</span>.
          </>
        ) : admin ? (
          "Not linked to an employee record yet, so your changes are recorded without a name" +
          " against them. Link this code to your own record below."
        ) : (
          "Not linked yet — give the account code above to HR. Nobody can look it up for you."
        )}
      </p>
    </section>
  );
}

/**
 * Who exists, who is linked, and — the column this screen exists for — who still cannot use the
 * system.
 *
 * A linked employee with no reachable approver is not done. `submitOvertime` and `fileAmendment`
 * both call `assertApproverReachable` and will refuse them the first time they file, so showing a
 * link as completion would be a promise the system does not keep. `approverReachable` comes from
 * the server, computed by the same function that enforcement calls; nothing here re-derives it
 * from the manager list or from `exempt`, because those are shown to explain the verdict rather
 * than to reach it — and `exempt` is not even an input to it. This screen once showed "Ready ·
 * 管理監督者" for an employee whose punch corrections nobody could have approved.
 */
function Roster({
  roster, canSetManager, fixes,
}: {
  roster: RosterEntry[];
  canSetManager: boolean;
  fixes: RowFixes;
}) {
  const names = new Map(roster.map((row) => [row.id, row.display_name]));
  const incomplete = roster.filter((row) => !isReady(row)).length;

  return (
    <section aria-labelledby="roster-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="roster-heading" className="text-sm font-semibold text-kumo-default">Roster</h2>
        <p className="text-xs text-kumo-subtle" data-testid="roster-summary">
          {roster.length === 0
            ? "Nobody yet"
            : `${roster.length} ${roster.length === 1 ? "employee" : "employees"}` +
              (incomplete > 0 ? ` · ${incomplete} not ready to use Kintai` : " · all ready")}
        </p>
      </div>

      {roster.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-kumo-line px-4 py-8 text-center text-sm text-kumo-subtle">
          No employee records yet. Add the first one below.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-kumo-line border-y border-kumo-line">
          {roster.map((employee) => (
            <RosterRow
              key={employee.id}
              employee={employee}
              names={names}
              canSetManager={canSetManager}
              onLink={() => fixes.onLink(employee)}
              onSetManager={() => fixes.onSetManager(employee)}
              onSetApprover={() => fixes.onSetApprover(employee)}
              onExempt={() => fixes.onExempt(employee)}
              onSetPolicy={() => fixes.onSetPolicy(employee)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function nameOf(roster: RosterEntry[], id: EmployeeId): string {
  return roster.find((row) => row.id === id)?.display_name ?? `employee ${id}`;
}

/** The core onboarding action: point an account code the employee read out at their record. */
function LinkAccountForm({
  roster, employeeId, onEmployeeId, codeRef, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  employeeId: string;
  onEmployeeId: (value: string) => void;
  codeRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  notice?: Notice;
  onSubmit: (accountId: string, employeeId: EmployeeId) => Promise<boolean>;
}) {
  const [accountId, setAccountId] = useState("");
  const id = useId();

  return (
    <FormCard
      title="Link an account code"
      hint="The employee reads this off their own Kintai page and gives it to you — there is no way to look one up. Linking replaces whatever code they had before, which is how an email change is handled."
      disabled={roster.length === 0}
      disabledHint="Add an employee record first."
      busy={busy}
      notice={notice}
      action="link-account"
      submitLabel="Link account"
      onSubmit={async () => {
        if (!await onSubmit(accountId.trim(), Number(employeeId))) return;
        setAccountId("");
        onEmployeeId("");
      }}
    >
      <Field label="Account code" htmlFor={`${id}-code`}>
        <input
          id={`${id}-code`}
          ref={codeRef}
          name="accountId"
          required
          value={accountId}
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          placeholder="00000000-0000-0000-0000-000000000000"
          className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-3 font-mono text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:ring-2 focus:ring-kumo-ring"
          onChange={(event) => setAccountId(event.currentTarget.value)}
        />
      </Field>
      <Field label="Employee" htmlFor={`${id}-employee`}>
        <EmployeeSelect
          id={`${id}-employee`}
          name="employeeId"
          roster={roster}
          value={employeeId}
          onChange={onEmployeeId}
        />
      </Field>
    </FormCard>
  );
}

/** Who reports to whom — and, in practice, who is allowed to approve whose overtime. */
function ReportingLineForm({
  roster, employeeId, onEmployeeId, managerRef, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  employeeId: string;
  onEmployeeId: (value: string) => void;
  managerRef: React.RefObject<HTMLSelectElement | null>;
  busy: boolean;
  notice?: Notice;
  onSubmit: (employeeId: EmployeeId, managerId: EmployeeId) => Promise<boolean>;
}) {
  const [managerId, setManagerId] = useState("");
  const id = useId();

  return (
    <FormCard
      title="Set a reporting line"
      hint="A reporting line is what lets the manager approve this employee’s overtime. It opens now and stays open; nobody can approve their own submissions."
      disabled={roster.length < 2}
      disabledHint="Two employee records are needed before anyone can report to anyone."
      busy={busy}
      notice={notice}
      action="set-reporting-line"
      submitLabel="Set reporting line"
      onSubmit={async () => {
        if (!await onSubmit(Number(employeeId), Number(managerId))) return;
        onEmployeeId("");
        setManagerId("");
      }}
    >
      <Field label="Employee" htmlFor={`${id}-employee`}>
        <EmployeeSelect
          id={`${id}-employee`}
          name="employeeId"
          roster={roster}
          value={employeeId}
          onChange={onEmployeeId}
        />
      </Field>
      <Field label="Reports to" htmlFor={`${id}-manager`}>
        <EmployeeSelect
          id={`${id}-manager`}
          name="managerId"
          selectRef={managerRef}
          roster={roster}
          value={managerId}
          onChange={setManagerId}
        />
      </Field>
    </FormCard>
  );
}

/**
 * Name the person who may approve for an employee who reports to nobody.
 *
 * The other half of a reporting line, and the only half that reaches the top of the org chart.
 * Whoever sits there has no manager by definition, and until this form existed the column that
 * exists for them — `designated_approver_id` — was settable only when the record was created, so
 * employee 1, created before anybody exists to name, could never be given one.
 *
 * Its own form rather than a control on the row, for the reason the exemption is: this hands one
 * person authority to sign for another, on the record of the employee nobody else reviews. The
 * row's button brings the reader here with the employee already chosen; the deliberate press is
 * the one that writes.
 */
function DesignatedApproverForm({
  roster, employeeId, onEmployeeId, approverRef, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  employeeId: string;
  onEmployeeId: (value: string) => void;
  approverRef: React.RefObject<HTMLSelectElement | null>;
  busy: boolean;
  notice?: Notice;
  onSubmit: (employeeId: EmployeeId, approverId: EmployeeId) => Promise<boolean>;
}) {
  const [approverId, setApproverId] = useState("");
  const id = useId();

  return (
    <FormCard
      title="Set a designated approver"
      hint="For an employee at the top of the organisation, who reports to nobody: it names the one person who may approve what they file — overtime, and corrections to their punches. Use a reporting line instead wherever one honestly exists. Nobody may approve their own submissions, so an employee cannot be their own approver."
      disabled={roster.length < 2}
      disabledHint="Two employee records are needed before anyone can approve for anyone."
      busy={busy}
      notice={notice}
      action="set-designated-approver"
      submitLabel="Set approver"
      onSubmit={async () => {
        if (!await onSubmit(Number(employeeId), Number(approverId))) return;
        onEmployeeId("");
        setApproverId("");
      }}
    >
      <Field label="Employee" htmlFor={`${id}-employee`}>
        <EmployeeSelect
          id={`${id}-employee`}
          name="employeeId"
          roster={roster}
          value={employeeId}
          onChange={onEmployeeId}
        />
      </Field>
      <Field label="Approved by" htmlFor={`${id}-approver`}>
        <EmployeeSelect
          id={`${id}-approver`}
          name="approverId"
          selectRef={approverRef}
          roster={roster}
          value={approverId}
          onChange={setApproverId}
        />
      </Field>
    </FormCard>
  );
}

/**
 * Record that somebody is 管理監督者.
 *
 * Its own form rather than a button that writes straight from the roster row, and not only for
 * consistency with the other two. This is a determination under 労働基準法 §41 that exempts the
 * person's overtime from a premium; it is additive, cannot be undone here, and lands in a table an
 * inspection reads. A control that does all that on one click from a list, next to two buttons
 * that merely scroll somewhere, is the wrong shape. The row's button brings the reader here; the
 * second, deliberate press is the one that writes.
 */
function ExemptionForm({
  roster, employeeId, onEmployeeId, selectRef, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  employeeId: string;
  onEmployeeId: (value: string) => void;
  selectRef: React.RefObject<HTMLSelectElement | null>;
  busy: boolean;
  notice?: Notice;
  onSubmit: (employeeId: EmployeeId) => Promise<boolean>;
}) {
  const id = useId();

  return (
    <FormCard
      title="Record a 管理監督者 exemption"
      hint="For a manager or officer whose authority and treatment make them 管理監督者 under 労働基準法 §41: it marks them exempt from overtime premiums, so they file no overtime requests. It does NOT give them an approver — their punches still need correcting sometimes, and a correction needs a person, so they still need a manager or a designated approver. Recorded from now and open-ended — there is no way to end it here yet, so use it only where the determination has actually been made."
      disabled={roster.length === 0}
      disabledHint="Add an employee record first."
      busy={busy}
      notice={notice}
      action="grant-exemption"
      submitLabel="Record exemption"
      onSubmit={async () => {
        if (await onSubmit(Number(employeeId))) onEmployeeId("");
      }}
    >
      <Field label="Employee" htmlFor={`${id}-employee`}>
        <EmployeeSelect
          id={`${id}-employee`}
          name="employeeId"
          selectRef={selectRef}
          roster={roster}
          value={employeeId}
          onChange={onEmployeeId}
        />
      </Field>
    </FormCard>
  );
}

/**
 * Record which day an employee's punches are filed against.
 *
 * Its own form beside the exemption's, and for the same reason: this decides what a night worker's
 * hours are worth and it is NOT retroactive, so it is a deliberate press rather than a toggle in a
 * list. Get it wrong for a month and that month's records are wrong in a way only an
 * administrative correction can fix — which is why the hint says so and why the confirmation names
 * what will happen to punches from now on rather than claiming a repair.
 *
 * The dropdown is filled from `WORK_DATE_POLICIES`, the same list the worker's own types are built
 * from, so the form cannot offer a value the server would refuse.
 *
 * The hint warns about the mid-shift case because nothing else does and nothing refuses it.
 * Switching a night worker off `shift_start` while they are clocked in strands that one
 * shift: the `in` is already filed against the shift's date, the `out` lands on the calendar
 * date, and the day splits into `unpaired_in` + `orphan_out` — the very bug the setting
 * exists to prevent. It fails safe and it is one shift, so the server allows it (see
 * `AdminKintaiApi.setWorkDatePolicy`); HR just has to be told, and this is where they read.
 */
function WorkDatePolicyForm({
  roster, employeeId, onEmployeeId, selectRef, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  employeeId: string;
  onEmployeeId: (value: string) => void;
  selectRef: React.RefObject<HTMLSelectElement | null>;
  busy: boolean;
  notice?: Notice;
  onSubmit: (employeeId: EmployeeId, policy: WorkDatePolicy) => Promise<boolean>;
}) {
  // The dropdown DERIVES from the selected employee, with a local override that is tied to the
  // employee it was made for. Held as plain state rather than an effect, and keyed this way for a
  // reason a test caught: the roster row's button selects an employee from OUTSIDE this component,
  // and a dropdown holding its own independent value would then sit on `calendar` while showing a
  // night worker's name — one press and their policy is silently reverted. Changing the selected
  // employee retires the override automatically, because it no longer matches.
  const [choice, setChoice] = useState<{ employeeId: string; policy: WorkDatePolicy }>();
  const id = useId();

  const selected = roster.find((row) => String(row.id) === employeeId);
  const current = selected?.work_date_policy;
  const policy: WorkDatePolicy =
    choice?.employeeId === employeeId ? choice.policy : current ?? "calendar";

  return (
    <FormCard
      title="Set which day punches are filed against"
      hint="Office staff finish before midnight, so the calendar date is right for them and it is the default. A night shift crossing midnight has to be filed against the date it started, or it splits across two days and both get flagged. This applies to punches made from now on — it does not move anything already recorded, so set it when you onboard someone who works nights. Do not change it while the employee is clocked in: their current shift is stranded half on each day and both halves get flagged, and only an administrative correction can tidy that up. Wait until they have clocked out."
      disabled={roster.length === 0}
      disabledHint="Add an employee record first."
      busy={busy}
      notice={notice}
      action="set-work-date-policy"
      submitLabel="Set policy"
      onSubmit={async () => {
        if (await onSubmit(Number(employeeId), policy)) onEmployeeId("");
      }}
    >
      <Field label="Employee" htmlFor={`${id}-employee`}>
        <EmployeeSelect
          id={`${id}-employee`}
          name="employeeId"
          selectRef={selectRef}
          roster={roster}
          value={employeeId}
          onChange={onEmployeeId}
        />
      </Field>
      <Field
        label="Work date"
        htmlFor={`${id}-policy`}
        note={current ? `Currently ${WORK_DATE_POLICY_LABELS[current]}.` : undefined}
      >
        <select
          id={`${id}-policy`}
          name="policy"
          required
          value={policy}
          className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-2 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-ring"
          onChange={(event) =>
            setChoice({ employeeId, policy: event.currentTarget.value as WorkDatePolicy })}
        >
          {WORK_DATE_POLICIES.map((value) => (
            <option key={value} value={value}>{WORK_DATE_POLICY_LABELS[value]}</option>
          ))}
        </select>
      </Field>
    </FormCard>
  );
}

/** A new employee record. Creating one does not make anybody able to use Kintai on its own. */
function CreateEmployeeForm({
  roster, busy, notice, onSubmit,
}: {
  roster: RosterEntry[];
  busy: boolean;
  notice?: Notice;
  onSubmit: (input: NewEmployee) => Promise<boolean>;
}) {
  const empty = {
    employeeNumber: "", displayName: "", department: "", employmentType: "",
    joinedOn: "", designatedApproverId: "",
  };
  const [form, setForm] = useState(empty);
  const id = useId();
  const set = (key: keyof typeof empty) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <FormCard
      title="Add an employee"
      hint="Creates the record only. They still need an account code linked, and somebody who can approve for them, before they can use Kintai."
      busy={busy}
      notice={notice}
      action="create-employee"
      submitLabel="Add employee"
      onSubmit={async () => {
        const ok = await onSubmit({
          employeeNumber: form.employeeNumber.trim(),
          displayName: form.displayName.trim(),
          department: form.department.trim() || undefined,
          employmentType: form.employmentType.trim() || undefined,
          designatedApproverId: form.designatedApproverId
            ? Number(form.designatedApproverId)
            : undefined,
          joinedOn: form.joinedOn,
        });
        if (ok) setForm(empty);
      }}
    >
      <Field label="Employee number" htmlFor={`${id}-number`}>
        <TextInput
          id={`${id}-number`} name="employeeNumber" required maxLength={64}
          value={form.employeeNumber} onChange={set("employeeNumber")} placeholder="E-1001"
        />
      </Field>
      <Field label="Name" htmlFor={`${id}-name`}>
        <TextInput
          id={`${id}-name`} name="displayName" required maxLength={200}
          value={form.displayName} onChange={set("displayName")} placeholder="田中 太郎"
        />
      </Field>
      <Field label="Joining date" htmlFor={`${id}-joined`}>
        <TextInput
          id={`${id}-joined`} name="joinedOn" required type="date" maxLength={10}
          value={form.joinedOn} onChange={set("joinedOn")}
        />
      </Field>
      <Field label="Department" htmlFor={`${id}-department`} optional>
        <TextInput
          id={`${id}-department`} name="department" maxLength={120}
          value={form.department} onChange={set("department")}
        />
      </Field>
      <Field label="Employment type" htmlFor={`${id}-type`} optional>
        <TextInput
          id={`${id}-type`} name="employmentType" maxLength={64}
          value={form.employmentType} onChange={set("employmentType")} placeholder="正社員"
        />
      </Field>
      <Field
        label="Designated approver"
        htmlFor={`${id}-approver`}
        optional
        // The escape hatch for someone at the top of the org chart, who has no manager and would
        // otherwise be permanently unable to have anything approved.
        note="For an employee who reports to nobody."
      >
        <EmployeeSelect
          id={`${id}-approver`}
          name="designatedApproverId"
          roster={roster}
          value={form.designatedApproverId}
          onChange={set("designatedApproverId")}
          placeholder="Nobody"
        />
      </Field>
    </FormCard>
  );
}

/**
 * One form, with its message directly beneath its own button.
 *
 * Every failure this screen can show belongs to one action, and putting it here is the point: a
 * refused link and a refused reporting line are different problems with different fixes, and a
 * shared banner at the top of the page would make the reader work out which one they are reading.
 *
 * THE BUTTON IS `type="button"`, AND THAT IS LOAD-BEARING. The Workshop hosts this app in an
 * iframe with `sandbox="allow-scripts allow-modals"` — no `allow-forms` (see
 * `SandboxedGatekeeperApp.tsx`). Chrome does not merely block the resulting navigation there: it
 * blocks form submission outright, so the `submit` event never fires at all. A `type="submit"`
 * button, `form.requestSubmit()` and the implicit Enter-key submission are all silently inert,
 * with no error anywhere — the button simply does nothing, which is how this shipped once and was
 * only caught by clicking it in a real browser.
 *
 * So every action runs from an explicit `onClick`, and Enter is handled here rather than left to
 * the browser. `onSubmit` is kept because it costs nothing and is the correct behaviour if a host
 * ever does allow forms; with no submit button in the form it cannot fire twice.
 *
 * The `<form>` element itself stays. It is what groups the fields for assistive technology, and
 * `required` still marks the fields even though nothing will pop a native bubble. Emptiness is NOT
 * re-checked here: the API's own messages are written for a person ("Employee number is
 * required."), and a second copy of that rule in the browser is how the two drift apart.
 */
function FormCard({
  title, hint, disabled, disabledHint, busy, notice, action, submitLabel, onSubmit, children,
}: {
  title: string;
  hint: string;
  disabled?: boolean;
  disabledHint?: string;
  busy: boolean;
  notice?: Notice;
  action: string;
  submitLabel: string;
  onSubmit: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <details
      className="group rounded-lg border border-kumo-line bg-kumo-elevated"
      data-form={action}
      open
    >
      <summary className="flex items-center justify-between px-4 py-3 text-sm font-medium text-kumo-default">
        {title}
        <span className="text-xs font-normal text-kumo-inactive group-open:hidden">Show</span>
      </summary>
      <form
        className="flex flex-col gap-4 border-t border-kumo-line px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void onSubmit();
        }}
        // Enter in a field is how anybody types a code and moves on, and the sandbox took the
        // browser's version of that away along with submission.
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
          event.preventDefault();
          if (!busy) void onSubmit();
        }}
      >
        <p className="text-xs leading-5 text-kumo-subtle">{hint}</p>
        {disabled ? (
          <p className="text-xs text-kumo-inactive">{disabledHint}</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">{children}</div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                // Never "submit": see this component's comment. The host sandbox omits
                // `allow-forms`, so a submit button in this iframe does nothing at all.
                type="button"
                data-action={action}
                disabled={busy}
                className="press inline-flex h-9 items-center rounded-lg bg-kumo-brand px-3.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
                onClick={() => void onSubmit()}
              >
                {busy ? "Saving…" : submitLabel}
              </button>
              {notice && (
                <p
                  data-testid={`${action}-notice`}
                  role={notice.kind === "error" ? "alert" : "status"}
                  className={`text-xs ${notice.kind === "error" ? "text-kumo-danger" : "text-kumo-subtle"}`}
                >
                  {notice.text}
                </p>
              )}
            </div>
          </>
        )}
      </form>
    </details>
  );
}

function Field({
  label, htmlFor, optional, note, children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-kumo-subtle">
        {label}
        {optional && <span className="ml-1 font-normal text-kumo-inactive">optional</span>}
      </label>
      {children}
      {note && <p className="text-xs text-kumo-inactive">{note}</p>}
    </div>
  );
}

function TextInput({
  id, name, value, onChange, required, maxLength, type, placeholder,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  maxLength?: number;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      id={id}
      name={name}
      type={type ?? "text"}
      required={required}
      maxLength={maxLength}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-3 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:ring-2 focus:ring-kumo-ring"
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/**
 * Pick an employee by name.
 *
 * A select rather than a typed id, because every employee id this screen sends came from a row the
 * server returned. That is not a security property — the API validates and audits regardless — but
 * it is the difference between HR granting a manager authority over the person they meant and over
 * whoever happens to be number 34.
 */
function EmployeeSelect({
  id, name, roster, value, onChange, placeholder, selectRef,
}: {
  id: string;
  name: string;
  roster: RosterEntry[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  selectRef?: React.RefObject<HTMLSelectElement | null>;
}) {
  return (
    <select
      id={id}
      name={name}
      ref={selectRef}
      required={placeholder === undefined}
      value={value}
      className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-2 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-ring"
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">{placeholder ?? "Choose an employee…"}</option>
      {roster.map((employee) => (
        <option key={employee.id} value={employee.id}>
          {employee.display_name} · {employee.employee_number}
        </option>
      ))}
    </select>
  );
}
