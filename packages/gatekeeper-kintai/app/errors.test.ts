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

  // The rewrite is keyed on the detail, so it must not swallow its neighbours under the same code.
  // Unmapped details stay as the server wrote them — English, capitalised, in both languages.
  it("leaves other invalid-input details alone", () => {
    for (const t of [en, ja]) {
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: employee number is required."), "fallback", t,
      )).toBe("Employee number is required.");
      expect(describeFailure(
        new Error("KINTAI_INVALID_INPUT: this employee is already recorded as 管理監督者."),
        "fallback",
        t,
      )).toBe("This employee is already recorded as 管理監督者.");
    }
  });

  it("keeps 管理監督者 and other non-Latin text intact when capitalising", () => {
    expect(describeFailure(
      new Error("KINTAI_NO_APPROVER: 管理監督者 exemption missing for employee 3."),
      "fallback",
      ja,
    )).toBe("管理監督者 exemption missing for employee 3.");
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
