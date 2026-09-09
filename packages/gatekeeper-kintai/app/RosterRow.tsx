import type { RosterEntry } from "../src/types";
import { useT, type Messages } from "./i18n";

/**
 * One employee's row, and the verdict on whether they can use Kintai at all.
 *
 * Its own module because TWO tabs render it. The Roster tab lists everybody; 要対応's third
 * section lists exactly the rows this one reports as not ready, with the same repair buttons,
 * because "who cannot use the system yet" is a thing needing a human and belongs on the queue an
 * administrator opens. A second implementation there would have been a second opinion about
 * readiness — the precise failure this row's own comments are a record of — so the row moved out
 * of `AdminPage.tsx` unchanged rather than being described twice.
 *
 * Nothing else moved with it. The forms, the reveal plumbing and the roster section itself are
 * still `AdminPage`'s, and the callbacks below are how it keeps them: this component decides which
 * repairs a row needs and nothing about where they happen.
 *
 * `useT()` rather than a `t` prop, deliberately: two call sites render this row and a prop would
 * have to be threaded through `RowFixes`'s neighbours in both of them, which is the drift the
 * shared module exists to prevent. Both call sites are inside the dashboard's provider (see
 * `main.tsx`), so there is no tree this component can be reached from that has no language.
 */
export function RosterRow({
  employee, names, canSetManager, onLink, onSetManager, onSetApprover, onExempt, onSetPolicy,
}: {
  employee: RosterEntry;
  names: Map<number, string>;
  canSetManager: boolean;
  onLink: () => void;
  onSetManager: () => void;
  onSetApprover: () => void;
  onExempt: () => void;
  onSetPolicy: () => void;
}) {
  const t = useT();
  const ready = isReady(employee);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3" data-employee={employee.id}>
      <div className="min-w-48 flex-1">
        <p className="truncate text-sm font-medium text-kumo-default">{employee.display_name}</p>
        <p className="truncate text-xs text-kumo-subtle">
          {[employee.employee_number, employee.department, employee.employment_type]
            .filter(Boolean).join(" · ")}
        </p>
        {/* Shown only when it is NOT the default. A badge on every row would be noise, and the
            thing HR needs to be able to spot is the handful of people whose punches are filed
            somewhere other than the day they happened on. */}
        {employee.work_date_policy === "shift_start" && (
          <p className="truncate text-xs text-kumo-subtle" data-testid="work-date-policy">
            {t.roster.row.nightShift}
          </p>
        )}
        {/* Here, and only here, for the same reason: a 労働基準法41条 determination is one of the
            handful of exceptions HR has to be able to spot, and the alternative was pressing the
            管理監督者 button to see whether it answered "already recorded". Deliberately NOT in
            the readiness column — it is a fact about the person's overtime, not a verdict about
            whether anybody can approve for them, and reporting it as the latter is the bug the
            row beside this one was written to fix. */}
        {employee.exempt && (
          <p className="truncate text-xs text-kumo-subtle" data-testid="exempt">
            {t.roster.row.exempt}
          </p>
        )}
      </div>

      <div className="min-w-56 flex-1">
        {ready ? (
          <p className="text-xs text-kumo-subtle" data-testid="status">
            {t.roster.row.ready(approverReason(employee, names, t))}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="status">
            {!employee.linked && (
              <li className="text-xs text-kumo-danger" data-issue="unlinked">
                {t.roster.row.notLinked}
              </li>
            )}
            {!employee.approverReachable && (
              <li className="text-xs text-kumo-danger" data-issue="no-approver">
                {/* Not "overtime". A punch correction needs approval too, and naming only
                    overtime is what made an exempt officer look finished: they file no overtime,
                    so the warning read as inapplicable to them. */}
                {employee.exempt ? t.roster.row.noApproverExempt : t.roster.row.noApprover}
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
            {t.roster.row.linkCode}
          </button>
        )}
        {!employee.approverReachable && canSetManager && (
          <button
            type="button"
            data-action="manager-for-this"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={onSetManager}
          >
            {t.roster.row.setManager}
          </button>
        )}
        {/* The other honest way to complete this row, and the only one for somebody at the top of
            the organisation. Gated on the same `canSetManager`: a designated approver is another
            employee, so with one record on the roster there is nobody to name and the form would
            have nothing in its dropdown. */}
        {!employee.approverReachable && canSetManager && (
          <button
            type="button"
            data-action="approver-for-this"
            className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            onClick={onSetApprover}
          >
            {t.roster.row.setApprover}
          </button>
        )}
        {/* Offered on every row, and NOT as a repair — which is what it used to look like, sitting
            beside "Set manager" on exactly the rows that had no approver. 管理監督者 exempts an
            employee's overtime from a premium; it grants nobody authority to sign, so it never
            finished a row, and pointing HR at it from a row that needed an approver was pointing
            them at a button that would not have fixed what they were looking at. It belongs with
            "Work dates": a determination about one employee that HR makes on its own terms. */}
        <button
          type="button"
          data-action="exempt-this"
          className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={onExempt}
        >
          {t.roster.row.exemptAction}
        </button>
        {/* Always offered, unlike the two above: an employee on the wrong work-date policy is not
            a broken row — the roster cannot tell, because both answers are legitimate — so there
            is no "issue" for this button to appear in response to. It is the only way HR can see
            or change the setting, so it is always reachable. */}
        <button
          type="button"
          data-action="policy-for-this"
          className="press rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={onSetPolicy}
        >
          {t.roster.row.workDates}
        </button>
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
function approverReason(
  employee: RosterEntry, names: Map<number, string>, t: Messages,
): string {
  if (employee.managerIds.length > 0) {
    return t.roster.row.reportsTo(employee.managerIds.map((id) => label(names, id)).join(", "));
  }
  // No 管理監督者 arm, and it is not an omission. This function mirrors `hasReachableApprover`,
  // which stopped counting an exemption: it exempts overtime from a premium and authorises nobody
  // to sign anything. Reported here it read as "Ready · 管理監督者" on a row whose punch
  // corrections nobody could have approved -- observed live on 2026-09-01, on the Admin record.
  // The exemption is still on the row, as a neutral badge in the identity column beside 夜勤;
  // what it no longer does is answer this question.
  if (employee.designated_approver_id !== null) {
    return t.roster.row.approvedBy(label(names, employee.designated_approver_id));
  }
  return t.roster.row.approvable;
}

/**
 * The name behind a manager or approver id — a NAME LOOKUP, and left out of the dictionary on
 * instruction.
 *
 * `common.employeeFallback(id)` exists and `AdminPage`'s `nameOf` reads it; this one deliberately
 * does not. The fallback fires only when a row names somebody the `names` map does not carry,
 * which the roster read cannot produce (every id here comes from a row in the same read), so the
 * two are not the same call in practice. Flagged in the task report as the one string on this
 * screen that is not the dictionary's.
 */
function label(names: Map<number, string>, id: number): string {
  return names.get(id) ?? `employee ${id}`;
}

/**
 * Linked AND able to have something approved. Either one alone is an unfinished onboarding.
 *
 * The one definition of readiness on this side of the wire, which is why it lives beside the row
 * that renders it: the Roster tab counts the rows it says no about, and 要対応 lists them.
 */
export function isReady(employee: RosterEntry): boolean {
  return employee.linked && employee.approverReachable;
}
