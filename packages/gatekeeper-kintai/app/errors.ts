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
 *
 * THE SENTENCES ARE THE DICTIONARY'S, THE MATCHING IS THIS MODULE'S. Every rewrite this module
 * chooses is looked up in the caller's `Messages` — `t.errors.byCode` for a code, `t.errors.details`
 * for a detail — so a refusal is refused in the language the reader is reading. What stays here is
 * the wire: the `KINTAI_*` grammar, and the patterns that recognise a detail. Those patterns are
 * matched against the ENGLISH text the server sent and never against a translation, which is why
 * they belong beside the parser rather than in the dictionary beside the words.
 *
 * AN UNMAPPED DETAIL IS SHOWN IN ENGLISH, to a Japanese reader too. Server-side details are
 * agent-facing as well as human-facing and most are already written for a person; the alternative
 * is guessing at a translation of a sentence nobody has read. The common codes are all mapped, and
 * `failureDetail`'s raw text is untouched for the same reason: it is for reporting, not reading.
 */
import type { Messages } from "./i18n";

/** Any `KINTAI_*` prefix, with the human half captured. `s` so a multi-line detail survives. */
const CODED = /^(KINTAI_[A-Z_]+): ([\s\S]+)$/;

/**
 * Details that are correct for an API caller but wrong for the person in front of this screen,
 * as a pattern over the server's English detail and the dictionary entry that replaces it.
 *
 * Keyed on the detail rather than the code, because `KINTAI_INVALID_INPUT` covers everything from
 * a bad date to a blank name and almost all of it already reads well.
 *
 * The FIRST entry is the empty dropdown. Every employee id this page sends comes from a
 * `<select>`, and an untouched one submits `""`, which `Number("")` turns into `0` — so the API
 * answers "employee must be a positive employee id", which is a true statement about an argument
 * and useless as a description of what the reader did, which is forget to pick somebody. It is
 * also now the LIKELIEST failure on the screen: the host's iframe sandbox forbids form submission,
 * so the browser's own `required` handling never runs (see `FormCard`). The server's message stays
 * as it is — it is right for whoever called the method directly — and this rewrites it on the way
 * to a human. Rewriting is not re-checking: nothing here decides whether the value is valid.
 *
 * The SECOND is the exemption pressed twice, and it is here for a different reason: the detail is
 * not unhelpful, it is in the wrong language. `grantExemption` refuses a second open period with
 * an English sentence that spells out 管理監督者 (`admin-api.ts`), so an English screen dropped
 * into 漢字 for the word the refusal turns on — the same fault `KINTAI_NO_APPROVER` had, arriving
 * under a code whose other twenty details are fine as they are. Which is exactly why it is keyed
 * on the DETAIL: `KINTAI_INVALID_INPUT` must keep falling through for everything else.
 *
 * ITS PATTERN HAS A HOLE WHERE THE TERM IS, and that is deliberate twice over. The pattern is
 * pinned by the English on either side of 管理監督者 — the determination it names and the sentence
 * about ending it — rather than by the word, so it stays ASCII: a Japanese character in this file
 * would trip `no-stray-literals`, whose premise is that Japanese outside the dictionary is a label
 * that did not make the move, and evading that guard by escaping the codepoints would make its
 * green sweep mean less. Matching the whole sentence is also STRICTER than matching the term: a
 * future "already recorded as" about something other than an exemption falls through to its own
 * detail instead of being told it is about Article 41.
 *
 * The second element is a KEY and not a sentence, which is the whole point: the pattern is about
 * the wire and the words are about the reader, and a `keyof` makes a key that no longer exists in
 * the dictionary a compile error rather than a blank line on a payroll screen.
 */
const DETAIL_REWRITES: ReadonlyArray<[RegExp, keyof Messages["errors"]["details"]]> = [
  [/ must be a positive employee id\.$/, "employeeIdRequired"],
  [/^this employee is already recorded as .+\. Ending an exemption is not supported/, "alreadyExempt"],
];

/**
 * A sentence describing why something failed, or `fallback` when there is nothing to go on.
 *
 * `fallback` is required and has no default on purpose: it should say which action failed ("Couldn’t
 * create the employee.") so an unrecognised failure still lands next to the thing that failed. It
 * is the CALLER's, already chosen out of `t.errors.fallbacks` at the call site, because only the
 * caller knows which action was attempted.
 *
 * `t` is a parameter and not a hook: this is a pure function, called from render bodies and
 * testable against either dictionary. Callers that catch a failure inside an effect or a write
 * store what they CAUGHT and call this where they render it — see `useSectionRead` — so a language
 * switch retranslates a message already on screen instead of freezing it in the language it was
 * written in.
 */
export function describeFailure(error: unknown, fallback: string, t: Messages): string {
  const message = error instanceof Error ? error.message : "";
  const match = CODED.exec(message);
  if (!match) return fallback;
  const [, code, detail] = match;
  // Codes whose own detail should not be shown: see `errors.byCode` in `messages.ts` for which
  // ones and why. A code with no entry falls through to its detail, which is the thin default.
  const rewritten = t.errors.byCode[code];
  if (rewritten) return rewritten;
  const rewrite = DETAIL_REWRITES.find(([pattern]) => pattern.test(detail));
  return rewrite ? t.errors.details[rewrite[1]] : capitalize(detail);
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
