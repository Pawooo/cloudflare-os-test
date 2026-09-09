/**
 * Turning what the capability threw into something an HR user can act on.
 *
 * Every error this package raises is coded, and the code is repeated inside the message because
 * `code` is a plain own property that does not survive the RPC boundary — the browser receives a
 * string like `KINTAI_INVALID_INPUT: joining date is not a real calendar date: 2026-02-31.` and
 * nothing else. Rendering that string is not finishing the job: the prefix is for logs, and some
 * of the details behind it name a method rather than describe a problem.
 *
 * The mapping is deliberately thin. Most details are already written for a person, so this strips
 * the machine prefix and leaves them; only the codes whose detail is unhelpful get a sentence of
 * their own. Anything with no recognisable code at all — a dropped session, a raw SQLite failure,
 * a thrown non-Error — gets the caller's fallback, because guessing at an unknown failure is how a
 * UI ends up confidently telling someone the wrong thing.
 */

/** Any `KINTAI_*` prefix, with the human half captured. `s` so a multi-line detail survives. */
const CODED = /^(KINTAI_[A-Z_]+): ([\s\S]+)$/;

/**
 * Codes whose own detail should not be shown.
 *
 * `KINTAI_NOT_FOUND` says "there is no employee 42", where the number came from a control the
 * reader never typed into — the useful half is that their copy of the roster is stale.
 *
 * `KINTAI_ADMIN_REQUIRED` used to be here too, rewritten because its detail named the refused RPC
 * method. Nothing produces it any more: a non-admin is handed the employee bundle and
 * `EmployeeKintaiApi`, on which the admin methods do not exist to refuse, so the entry went with
 * the refuse-all capability that threw it.
 */
const REWRITTEN: Record<string, string> = {
  KINTAI_NOT_FOUND:
    "That employee record no longer exists. Reload the roster and try again.",
  // Both mean the same thing to the person in front of the queue: the row they are looking at is
  // not the request as it now stands. The API's wording ("state 'approved' cannot be acted on";
  // "history has moved") is true and gives them nothing to do; "reload" does.
  KINTAI_INVALID_TRANSITION:
    "Somebody already decided this request. Reload the page to see where it stands.",
  KINTAI_STALE_DECISION:
    "This request changed since you read it. Reload the page, then decide again.",
};

/**
 * Details that are correct for an API caller but wrong for the person in front of this screen.
 *
 * Keyed on the detail rather than the code, because `KINTAI_INVALID_INPUT` covers everything from
 * a bad date to a blank name and almost all of it already reads well.
 *
 * The one entry so far is the empty dropdown. Every employee id this page sends comes from a
 * `<select>`, and an untouched one submits `""`, which `Number("")` turns into `0` — so the API
 * answers "employee must be a positive employee id", which is a true statement about an argument
 * and useless as a description of what the reader did, which is forget to pick somebody. It is
 * also now the LIKELIEST failure on the screen: the host's iframe sandbox forbids form submission,
 * so the browser's own `required` handling never runs (see `FormCard`). The server's message stays
 * as it is — it is right for whoever called the method directly — and this rewrites it on the way
 * to a human. Rewriting is not re-checking: nothing here decides whether the value is valid.
 */
const DETAIL_REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/ must be a positive employee id\.$/, "Choose someone from the list first."],
];

/**
 * A sentence describing why something failed, or `fallback` when there is nothing to go on.
 *
 * `fallback` is required and has no default on purpose: it should say which action failed ("Couldn’t
 * create the employee.") so an unrecognised failure still lands next to the thing that failed.
 */
export function describeFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  const match = CODED.exec(message);
  if (!match) return fallback;
  const [, code, detail] = match;
  if (REWRITTEN[code]) return REWRITTEN[code];
  const rewrite = DETAIL_REWRITES.find(([pattern]) => pattern.test(detail));
  return rewrite ? rewrite[1] : capitalize(detail);
}

/**
 * The raw text of a failure that is NOT one of Kintai's coded refusals, or undefined when it is.
 *
 * `describeFailure` deliberately hides internals behind a fallback for anything uncoded — the right
 * call for the sentence a reader acts on, and the wrong call for the line under it: the first live
 * failure of the queue's decision control showed "決定できませんでした。" and nothing else, and the
 * cause existed only in the server log. Render this beneath the fallback, small and monospaced, so
 * the person who hits it can report what actually happened.
 */
export function failureDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (message === "" || CODED.test(message)) return undefined;
  return message;
}

/**
 * Sentence-case the first character only.
 *
 * The details are written starting with a field label — "joining date must be…" — because the code
 * prefix sits in front of them on the wire. Uppercasing more than the first character would mangle
 * `管理監督者`, an employee number, or a date.
 */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
