import type { PunchRow } from "../src/types";

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
 * reachable from a bare `PunchRow`, so the id is what is shown; a reader who needs the name behind
 * it already has the roster this screen is drawn beside. What must never happen is the id or reason
 * going missing and leaving the sentence to read as the internal word "amendment" alone.
 *
 * `admin` and `import` get a neutral label rather than `gadget`'s treatment, because neither word is
 * platform jargon the way `gadget` is — an HR reader already knows what "an administrator entered
 * this" or "this was imported" means. `gadget` is the one word that names Cloudflare's own
 * capability-hosting mechanism, which is meaningless (and confusing) to HR.
 *
 * An unrecognised `source` falls through to the raw string rather than blanking or throwing: a
 * worker-side source addition must surface visibly on this screen, not disappear from it.
 */
export function describePunchSource(
  punch: Pick<PunchRow, "source" | "amended_by" | "amend_reason">,
): string {
  switch (punch.source) {
    case "gadget":
      return "本人打刻";
    case "amendment": {
      const approver = punch.amended_by === null ? "不明" : `#${punch.amended_by}`;
      const reason = punch.amend_reason ?? "理由未記載";
      return `修正 (承認: ${approver}, 理由: ${reason})`;
    }
    case "admin":
      return "管理者による記録 (admin)";
    case "import":
      return "取り込み (import)";
    default:
      return punch.source;
  }
}

/**
 * Drop-in replacement for `{punch.source}` — same wrapper, human wording. Pure and display-only:
 * no capability, no control, nothing for the sandbox rules to say anything about.
 */
export function PunchSource(
  { punch }: { punch: Pick<PunchRow, "source" | "amended_by" | "amend_reason"> },
) {
  return <span className="ml-2 text-kumo-inactive">{describePunchSource(punch)}</span>;
}
