import type { PunchRow } from "../src/types";
import type { Messages } from "./i18n";

/**
 * How a punch got into the record, in words an HR reader can act on — never the raw value stored
 * in `punches.source`. Both the admin day drill-down (`OverviewTab`) and the employee 今日 tab
 * (Task 5) render a punch's provenance through this one function, so the two screens cannot drift
 * and the platform's internal vocabulary — `gadget` foremost — never reaches an HR-facing screen.
 *
 * `amendment` is the one source with a story worth telling: it is an approved correction, and what
 * matters to the reader is WHO approved it and WHY, not the bare fact that it differs from what was
 * first recorded. `punch.amended_by` is the approver's employee id (see the comment beside its
 * write in `store/amendments.ts`, "the APPROVER, not the filer") — there is no employee-name table
 * reachable from a bare `PunchRow`, so the id is the fallback; a reader who needs the name behind it
 * already has the roster this screen is drawn beside. `resolveApprover` is how a screen that CAN
 * turn that id into a name hands one in: given it, the name is shown; absent it, the `#id` fallback
 * stands. It is deliberately optional — the admin day drill-down (`OverviewTab`) passes none and is
 * unaffected. What must never happen is the id or reason going missing and leaving the sentence to
 * read as the internal word "amendment" alone.
 *
 * `admin` and `import` get a neutral label rather than `gadget`'s treatment, because neither word is
 * platform jargon the way `gadget` is — an HR reader already knows what "an administrator entered
 * this" or "this was imported" means. `gadget` is the one word that names Cloudflare's own
 * capability-hosting mechanism, which is meaningless (and confusing) to HR.
 *
 * An unrecognised `source` falls through to the raw string rather than blanking or throwing: a
 * worker-side source addition must surface visibly on this screen, not disappear from it.
 *
 * `t` is passed rather than read from the context, because this half is a pure function a test can
 * call with either dictionary; the component below is what reaches for the screen's language.
 */
export function describePunchSource(
  punch: Pick<PunchRow, "source" | "amended_by" | "amend_reason">,
  t: Messages,
  resolveApprover?: (id: number) => string,
): string {
  switch (punch.source) {
    case "gadget":
      return t.punchSource.gadget;
    case "amendment": {
      const approver =
        punch.amended_by === null
          ? t.punchSource.unknownApprover
          : resolveApprover
            ? resolveApprover(punch.amended_by)
            : `#${punch.amended_by}`;
      const reason = punch.amend_reason ?? t.punchSource.noReason;
      return t.punchSource.amendment(approver, reason);
    }
    case "admin":
      return t.punchSource.admin;
    case "import":
      return t.punchSource.import;
    default:
      return punch.source;
  }
}

/**
 * Drop-in replacement for `{punch.source}` — same wrapper, human wording. Pure and display-only:
 * no capability, no control, nothing for the sandbox rules to say anything about.
 *
 * `t` IS A PROP AND NOT `useT()`, and it is REQUIRED. A prop rather than the hook because this
 * half of the module is a pure function a test calls with either dictionary, and the component is
 * the thin wrapper around it; required because both screens now have a `<LanguageProvider>` above
 * them and there is no call site left with nothing to pass. There used to be a transitional `ja`
 * default here, for the weeks when the admin day drill-down had no provider to ask and `useT()`
 * would have crashed the panel; a default outliving that is only a way for a screen to end up in
 * the wrong language silently.
 */
export function PunchSource(
  { punch, t, resolveApprover }: {
    punch: Pick<PunchRow, "source" | "amended_by" | "amend_reason">;
    /** The screen's language, from its own `useT()`. */
    t: Messages;
    /** Turn an approver's employee id into a name; omitted where no roster is at hand (`#id` shows). */
    resolveApprover?: (id: number) => string;
  },
) {
  return (
    <span className="ml-2 text-kumo-inactive">
      {describePunchSource(punch, t, resolveApprover)}
    </span>
  );
}
