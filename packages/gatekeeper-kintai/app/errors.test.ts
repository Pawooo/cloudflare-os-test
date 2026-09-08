import { describe, expect, it } from "vitest";
import { describeFailure } from "./errors";

// The messages are the real ones this package throws, spelled out rather than constructed, so a
// change to any of them fails here rather than quietly changing what an HR user reads.

describe("describeFailure", () => {
  it("strips the machine prefix and shows the sentence behind it", () => {
    expect(describeFailure(
      new Error("KINTAI_INVALID_INPUT: joining date is not a real calendar date: 2026-02-31."),
      "Couldn’t create that employee.",
    )).toBe("Joining date is not a real calendar date: 2026-02-31.");
  });

  it("never leaves a code on screen", () => {
    const codes = [
      "KINTAI_INVALID_INPUT: employee number is required.",
      "KINTAI_NOT_FOUND: there is no employee 42.",
      "KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an employee record.",
      "KINTAI_NO_APPROVER: employee 3 has no manager, no designated approver, and no 管理監督者 " +
      "exemption. Give them one before saving this organisation.",
    ];

    for (const message of codes) {
      expect(describeFailure(new Error(message), "fallback")).not.toContain("KINTAI_");
    }
  });

  // The id in a not-found came from a control, never from a keystroke, so quoting it back tells
  // the reader nothing they can act on. What they can act on is reloading.
  it("replaces a not-found with what to do about it", () => {
    expect(describeFailure(new Error("KINTAI_NOT_FOUND: there is no employee 42."), "fallback"))
      .toBe("That employee record no longer exists. Reload the roster and try again.");
  });

  // Every employee id this page sends comes from a select, so `Number("")` is `0` and the API
  // answers with a fact about an argument. What the reader did was forget to pick somebody — and
  // with the sandbox making `required` inert, this is the likeliest failure on the screen.
  it.each([
    "KINTAI_INVALID_INPUT: employee must be a positive employee id.",
    "KINTAI_INVALID_INPUT: manager must be a positive employee id.",
    "KINTAI_INVALID_INPUT: designated approver must be a positive employee id.",
  ])("turns %o into something the reader can act on", (message) => {
    expect(describeFailure(new Error(message), "fallback"))
      .toBe("Choose someone from the list first.");
  });

  // The rewrite is keyed on the detail, so it must not swallow its neighbours under the same code.
  it("leaves other invalid-input details alone", () => {
    expect(describeFailure(
      new Error("KINTAI_INVALID_INPUT: employee number is required."), "fallback",
    )).toBe("Employee number is required.");
    expect(describeFailure(
      new Error("KINTAI_INVALID_INPUT: this employee is already recorded as 管理監督者."),
      "fallback",
    )).toBe("This employee is already recorded as 管理監督者.");
  });

  it("keeps 管理監督者 and other non-Latin text intact when capitalising", () => {
    expect(describeFailure(
      new Error("KINTAI_NO_APPROVER: 管理監督者 exemption missing for employee 3."),
      "fallback",
    )).toBe("管理監督者 exemption missing for employee 3.");
  });

  it("keeps a multi-line detail whole", () => {
    expect(describeFailure(new Error("KINTAI_INVALID_INPUT: first line.\nsecond line."), "fallback"))
      .toBe("First line.\nsecond line.");
  });

  // Guessing at an unrecognised failure is how a UI ends up confidently saying the wrong thing.
  it.each([
    new Error("Internal error; reference = 6f1c"),
    new Error("UNIQUE constraint failed: employees.employee_number"),
    new Error(""),
    new Error("NOT_KINTAI_AT_ALL: something"),
    "a thrown string",
    undefined,
    { message: "KINTAI_INVALID_INPUT: not an Error at all" },
  ])("falls back for %o", (thrown) => {
    expect(describeFailure(thrown, "Couldn’t link that account code."))
      .toBe("Couldn’t link that account code.");
  });
});
