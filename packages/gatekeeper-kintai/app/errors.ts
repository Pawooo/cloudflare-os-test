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
 * `KINTAI_ADMIN_REQUIRED` names the refused method (`linkAccount is available to…`), which is a
 * fact about our RPC surface and not about anything the reader did. `KINTAI_NOT_FOUND` says "there
 * is no employee 42", where the number came from a control the reader never typed into — the
 * useful half is that their copy of the roster is stale.
 */
const REWRITTEN: Record<string, string> = {
  KINTAI_ADMIN_REQUIRED:
    "Only a Workshop administrator can do this. Ask an administrator to make the change.",
  KINTAI_NOT_FOUND:
    "That employee record no longer exists. Reload the roster and try again.",
};

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
  return REWRITTEN[code] ?? capitalize(detail);
}

/** Whether this failure is the capability refusing a non-administrator. */
export function isAdminRequired(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("KINTAI_ADMIN_REQUIRED:");
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
