import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EmployeeId, KintaiIdentity, NewEmployee, RosterEntry } from "../src/types";
import { describeFailure, isAdminRequired } from "./errors";

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
  grantExemption(employeeId: EmployeeId): Promise<void>;
};

type View =
  | { status: "loading" }
  | { status: "failed"; message: string }
  /** Not an administrator: their own account code, and nothing else. */
  | { status: "employee"; identity: KintaiIdentity }
  | { status: "admin"; identity: KintaiIdentity; roster: RosterEntry[] };

/** Which form a message or a spinner belongs to. Failures must land beside what failed. */
type FormKey = "create" | "link" | "report" | "exempt";
type Notice = { kind: "ok" | "error"; text: string };

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
  const [pending, setPending] = useState<FormKey>();
  const [notices, setNotices] = useState<Partial<Record<FormKey, Notice>>>({});
  // Set by the roster's row actions so a form opens on the employee whose row was clicked.
  const [linkTarget, setLinkTarget] = useState<string>("");
  const [reportTarget, setReportTarget] = useState<string>("");
  const [exemptTarget, setExemptTarget] = useState<string>("");
  const linkCodeRef = useRef<HTMLInputElement>(null);
  const managerRef = useRef<HTMLSelectElement>(null);
  const exemptRef = useRef<HTMLSelectElement>(null);
  const live = useRef(true);

  useEffect(() => () => { live.current = false; }, []);

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
        if (live.current) setNotices((current) => ({ ...current, [key]: { kind: "ok", text: done } }));
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
    [load],
  );

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
          <Roster
            roster={view.roster}
            // A reporting line needs somebody to report TO, so with one employee on the roster the
            // form has nothing to offer and says so. The row's button is hidden to match: rendering
            // it would leave a control that looks like the fix, is clickable, and does nothing —
            // the same silent no-op this page went to some trouble to stop producing.
            canSetManager={view.roster.length >= 2}
            onLink={(employee) => {
              setLinkTarget(String(employee.id));
              reveal(linkCodeRef.current, "link-account");
            }}
            onSetManager={(employee) => {
              setReportTarget(String(employee.id));
              reveal(managerRef.current, "set-reporting-line");
            }}
            onExempt={(employee) => {
              setExemptTarget(String(employee.id));
              reveal(exemptRef.current, "grant-exemption");
            }}
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
        </>
      )}
    </main>
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
 * A linked employee with no reachable approver is not done. `submitOvertime` calls
 * `assertApproverReachable` and will refuse them the first time they file, so showing a link as
 * completion would be a promise the system does not keep. `approverReachable` comes from the
 * server, computed by the same function that enforcement calls; nothing here re-derives it from
 * the manager list, because that list is shown to explain the verdict rather than to reach it.
 */
function Roster({
  roster, canSetManager, onLink, onSetManager, onExempt,
}: {
  roster: RosterEntry[];
  canSetManager: boolean;
  onLink: (employee: RosterEntry) => void;
  onSetManager: (employee: RosterEntry) => void;
  onExempt: (employee: RosterEntry) => void;
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
              onLink={() => onLink(employee)}
              onSetManager={() => onSetManager(employee)}
              onExempt={() => onExempt(employee)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RosterRow({
  employee, names, canSetManager, onLink, onSetManager, onExempt,
}: {
  employee: RosterEntry;
  names: Map<number, string>;
  canSetManager: boolean;
  onLink: () => void;
  onSetManager: () => void;
  onExempt: () => void;
}) {
  const ready = isReady(employee);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3" data-employee={employee.id}>
      <div className="min-w-48 flex-1">
        <p className="truncate text-sm font-medium text-kumo-default">{employee.display_name}</p>
        <p className="truncate text-xs text-kumo-subtle">
          {[employee.employee_number, employee.department, employee.employment_type]
            .filter(Boolean).join(" · ")}
        </p>
      </div>

      <div className="min-w-56 flex-1">
        {ready ? (
          <p className="text-xs text-kumo-subtle" data-testid="status">
            Ready · {approverReason(employee, names)}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="status">
            {!employee.linked && (
              <li className="text-xs text-kumo-danger" data-issue="unlinked">
                No account code linked — they cannot sign in as themselves.
              </li>
            )}
            {!employee.approverReachable && (
              <li className="text-xs text-kumo-danger" data-issue="no-approver">
                Nobody can approve for them — overtime they file will be refused.
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 gap-2">
        {!employee.linked && (
          <button
            type="button"
            data-action="link-this"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={onLink}
          >
            Link code
          </button>
        )}
        {!employee.approverReachable && canSetManager && (
          <button
            type="button"
            data-action="manager-for-this"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={onSetManager}
          >
            Set manager
          </button>
        )}
        {/* The other honest way to complete this row, and the only one for somebody at the top of
            the organisation. Offered beside "Set manager" so the choice is visible at the moment
            HR would otherwise reach for a reporting line that does not exist. */}
        {!employee.approverReachable && (
          <button
            type="button"
            data-action="exempt-this"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={onExempt}
          >
            管理監督者
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Why this employee counts as approvable, in the order `hasReachableApprover` decides it.
 *
 * Display only, and never a second opinion: it is only ever called for a row the server already
 * said is reachable, and it explains that verdict rather than reaching one.
 */
function approverReason(employee: RosterEntry, names: Map<number, string>): string {
  if (employee.managerIds.length > 0) {
    return `reports to ${employee.managerIds.map((id) => label(names, id)).join(", ")}`;
  }
  if (employee.exempt) return "管理監督者 (exempt from overtime approval)";
  if (employee.designated_approver_id !== null) {
    return `approver ${label(names, employee.designated_approver_id)}`;
  }
  return "approvable";
}

function label(names: Map<number, string>, id: number): string {
  return names.get(id) ?? `employee ${id}`;
}

/** Linked AND able to have something approved. Either one alone is an unfinished onboarding. */
function isReady(employee: RosterEntry): boolean {
  return employee.linked && employee.approverReachable;
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
      hint="For a manager or officer who reports to nobody: it marks them exempt from overtime premiums, and from needing anybody to approve for them. Recorded from now and open-ended — there is no way to end it here yet, so use it only where the determination has actually been made."
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
