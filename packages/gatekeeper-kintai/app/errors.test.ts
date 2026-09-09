import { describe, expect, it } from "vitest";
import { describeFailure } from "./errors";
import { en, ja } from "./i18n";

// The messages are the real ones this package throws, spelled out rather than constructed, so a
// change to any of them fails here rather than quietly changing what an HR user reads.
//
// WHAT IS ASSERTED IN BOTH LANGUAGES, and what is not. The two things this module chooses out of
// the dictionary — a code's rewrite and a detail's rewrite — are asserted against `en` AND `ja`,
// because picking one language's sentence for both readers is exactly the bug the dictionary
// exists to remove. Everything else here is asserted once and deliberately: a SERVER-SIDE DETAIL
// stays English in both languages (see `errors` in `messages.ts`), so a test that expected a
// Japanese sentence out of `capitalize` would be pinning a translation nobody wrote.

/**
 * Hiragana, katakana, CJK ideographs, halfwidth katakana — the same class `no-stray-literals`
 * sweeps `app/` with, used here for the opposite direction: an `en` rewrite must contain NONE of
 * it, and its `ja` twin must contain some. The two rewrites this file adds both exist because the
 * server's English detail drops into 漢字 for its most consequential word, so "one language per
 * screen" has to be asserted and not merely intended.
 */
const JAPANESE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

describe("describeFailure", () => {
  it.each([["en", en], ["ja", ja]] as const)(
    "strips the machine prefix and shows the sentence behind it (%s)",
    (_language, t) => {
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: joining date is not a real calendar date: 2026-02-31."),
        t.errors.fallbacks.createEmployee,
        t,
      )).toBe("Joining date is not a real calendar date: 2026-02-31.");
    },
  );

  it("never leaves a code on screen, in either language", () => {
    const codes = [
      "KINTAI_INVALID_INPUT: employee number is required.",
      "KINTAI_NOT_FOUND: there is no employee 42.",
      "KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an employee record.",
      "KINTAI_ADMIN_NOT_LINKED: your account is not linked to an employee record.",
      "KINTAI_NO_APPROVER: employee 3 has no manager, no designated approver, and no 管理監督者 " +
      "exemption. Give them one before saving this organisation.",
    ];

    for (const t of [en, ja]) {
      for (const message of codes) {
        expect(describeFailure(new Error(message), "fallback", t)).not.toContain("KINTAI_");
      }
    }
  });

  // The id in a not-found came from a control, never from a keystroke, so quoting it back tells
  // the reader nothing they can act on. What they can act on is reloading — in their language.
  it.each([["en", en], ["ja", ja]] as const)(
    "replaces a not-found with what to do about it (%s)",
    (_language, t) => {
      expect(describeFailure(
        new Error("KINTAI_NOT_FOUND: there is no employee 42."), "fallback", t,
      )).toBe(t.errors.byCode.KINTAI_NOT_FOUND);
    },
  );

  // The one by-code rewrite that names a FIX rather than a reload: the reader's own account card
  // is one tab away, which the server's detail has no way to know.
  it.each([["en", en], ["ja", ja]] as const)(
    "tells an unlinked administrator where to repair it (%s)",
    (_language, t) => {
      expect(describeFailure(
        new Error("KINTAI_ADMIN_NOT_LINKED: this account is not linked to an employee record."),
        "fallback",
        t,
      )).toBe(t.errors.byCode.KINTAI_ADMIN_NOT_LINKED);
    },
  );

  /*
   * The first sentence a new hire reads. `#requireEmployee` throws this on EVERY read and write an
   * unlinked worker attempts, so it is the whole of the 今日 tab for somebody HR has not linked
   * yet — and the server's own detail ("Contact HR to be set up") names no fix they can carry out,
   * because it cannot know they are holding an account code nobody has pointed at a record.
   */
  it.each([["en", en], ["ja", ja]] as const)(
    "tells an unlinked worker what to hand HR (%s)",
    (_language, t) => {
      expect(describeFailure(
        new Error(
          "KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an employee record. " +
          "Contact HR to be set up.",
        ),
        t.errors.fallbacks.readToday,
        t,
      )).toBe(t.errors.byCode.KINTAI_ACCOUNT_NOT_LINKED);
    },
  );

  it("writes the unlinked-worker sentence in one language each", () => {
    expect(en.errors.byCode.KINTAI_ACCOUNT_NOT_LINKED).not.toMatch(JAPANESE);
    expect(ja.errors.byCode.KINTAI_ACCOUNT_NOT_LINKED).toMatch(JAPANESE);
  });

  /*
   * The detail that is not merely unhelpful but WRONG-LANGUAGE. `NoApproverError`'s English text
   * contains 管理監督者, so before this rewrite an English screen dropped into 漢字 for the word
   * its sentence turns on — reachable from an employee filing a missing punch (`fileAmendment`
   * calls `assertApproverReachable`) as well as from an administrator saving an organisation.
   * Spelled out here exactly as `src/store/org.ts` throws it, so a change to either side lands.
   */
  const NO_APPROVER =
    "KINTAI_NO_APPROVER: employee 3 has no manager and no designated approver, so nobody could " +
    "approve anything they file -- a punch correction included, which a 管理監督者 exemption does " +
    "not excuse them from needing. Ask an administrator to set a reporting line, or a designated " +
    "approver if they report to nobody.";

  it.each([["en", en], ["ja", ja]] as const)(
    "replaces the no-approver detail rather than showing its 管理監督者 to an English reader (%s)",
    (_language, t) => {
      expect(describeFailure(new Error(NO_APPROVER), t.errors.fallbacks.fileRequest, t))
        .toBe(t.errors.byCode.KINTAI_NO_APPROVER);
    },
  );

  // One language per screen, on the one rewrite that exists because the server's own English was
  // not: the English side glosses the term as Article 41, the way `roster.row.exempt` does.
  it("writes the no-approver sentence in one language each", () => {
    expect(en.errors.byCode.KINTAI_NO_APPROVER).not.toMatch(JAPANESE);
    expect(ja.errors.byCode.KINTAI_NO_APPROVER).toMatch(JAPANESE);
    expect(en.errors.byCode.KINTAI_NO_APPROVER).not.toContain("管理監督者");
  });

  // The rewrite must still SAY what the server said: an exemption is not an approver, and the fix
  // is a reporting line or a designated approver. Kept as a substring check per language rather
  // than a second copy of the whole sentence.
  it("keeps the detail's substance in both languages", () => {
    expect(en.errors.byCode.KINTAI_NO_APPROVER).toContain("Article 41");
    expect(en.errors.byCode.KINTAI_NO_APPROVER).toContain("designated approver");
    expect(ja.errors.byCode.KINTAI_NO_APPROVER).toContain("管理監督者");
    expect(ja.errors.byCode.KINTAI_NO_APPROVER).toContain("指定承認者");
  });

  // Every employee id this page sends comes from a select, so `Number("")` is `0` and the API
  // answers with a fact about an argument. What the reader did was forget to pick somebody — and
  // with the sandbox making `required` inert, this is the likeliest failure on the screen. The
  // pattern is matched against the ENGLISH detail on the wire; the sentence comes from the
  // dictionary, so both readers are told to pick somebody in their own language.
  it.each([
    "KINTAI_INVALID_INPUT: employee must be a positive employee id.",
    "KINTAI_INVALID_INPUT: manager must be a positive employee id.",
    "KINTAI_INVALID_INPUT: designated approver must be a positive employee id.",
  ])("turns %o into something the reader can act on, in either language", (message) => {
    for (const t of [en, ja]) {
      expect(describeFailure(new Error(message), "fallback", t))
        .toBe(t.errors.details.employeeIdRequired);
    }
  });

  /*
   * The exemption pressed twice. `grantExemption` refuses a second open period, and says so with
   * an `InvalidInputError` whose English detail carries 管理監督者 — the same wrong-language
   * problem `KINTAI_NO_APPROVER` had, arriving under a code that is right for its other twenty
   * details. So it is keyed on the DETAIL, and its neighbours under `KINTAI_INVALID_INPUT` are
   * unaffected (the case below). Spelled out as `src/admin-api.ts` throws it.
   */
  const ALREADY_EXEMPT =
    "KINTAI_INVALID_INPUT: this employee is already recorded as 管理監督者. Ending an exemption " +
    "is not supported here yet.";

  it.each([["en", en], ["ja", ja]] as const)(
    "rewrites the second exemption rather than showing its 管理監督者 to an English reader (%s)",
    (_language, t) => {
      expect(describeFailure(new Error(ALREADY_EXEMPT), t.errors.fallbacks.grantExemption, t))
        .toBe(t.errors.details.alreadyExempt);
    },
  );

  it("writes the second-exemption sentence in one language each", () => {
    expect(en.errors.details.alreadyExempt).not.toMatch(JAPANESE);
    expect(ja.errors.details.alreadyExempt).toMatch(JAPANESE);
  });

  // The rewrite is keyed on the detail, so it must not swallow its neighbours under the same code.
  // Unmapped details stay as the server wrote them — English, capitalised, in both languages.
  it("leaves other invalid-input details alone", () => {
    for (const t of [en, ja]) {
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: employee number is required."), "fallback", t,
      )).toBe("Employee number is required.");
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: joining date is required."), "fallback", t,
      )).toBe("Joining date is required.");
      // The exemption pattern is pinned by the whole sentence, not by "already recorded as", so a
      // future determination about something else is not told it is about Article 41.
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: this employee is already recorded as a night-shift worker."),
        "fallback",
        t,
      )).toBe("This employee is already recorded as a night-shift worker.");
    }
  });

  /*
   * `capitalize` uppercases the first character ONLY, so a detail that opens on 漢字 survives it.
   * Pinned against `KINTAI_EXEMPT_EMPLOYEE`, which `submitOvertime` throws and which has no
   * by-code rewrite — this case used to use `KINTAI_NO_APPROVER`, and now that that code IS
   * rewritten the assertion would have been about the dictionary rather than about capitalising.
   */
  it("keeps 管理監督者 and other non-Latin text intact when capitalising", () => {
    expect(describeFailure(
      new Error(
        "KINTAI_EXEMPT_EMPLOYEE: 管理監督者-exempt for the requested period and may not raise an " +
        "overtime request for it.",
      ),
      "fallback",
      ja,
    )).toBe(
      "管理監督者-exempt for the requested period and may not raise an overtime request for it.",
    );
  });

  it("keeps a multi-line detail whole", () => {
    expect(describeFailure(
      new Error("KINTAI_INVALID_INPUT: first line.\nsecond line."), "fallback", en,
    )).toBe("First line.\nsecond line.");
  });

  // Guessing at an unrecognised failure is how a UI ends up confidently saying the wrong thing.
  // The fallback is the CALLER's, already chosen out of the caller's own dictionary, so this is
  // the one path that hands back a sentence this module never looked at.
  it.each([
    new Error("Internal error; reference = 6f1c"),
    new Error("UNIQUE constraint failed: employees.employee_number"),
    new Error(""),
    new Error("NOT_KINTAI_AT_ALL: something"),
    "a thrown string",
    undefined,
    { message: "KINTAI_INVALID_INPUT: not an Error at all" },
  ])("falls back for %o", (thrown) => {
    expect(describeFailure(thrown, en.errors.fallbacks.linkAccount, en))
      .toBe(en.errors.fallbacks.linkAccount);
    expect(describeFailure(thrown, ja.errors.fallbacks.linkAccount, ja))
      .toBe(ja.errors.fallbacks.linkAccount);
  });
});
