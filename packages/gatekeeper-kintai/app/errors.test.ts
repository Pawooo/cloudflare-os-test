import { describe, expect, it } from "vitest";
import { describeFailure, isAdminRequired } from "./errors";

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
      "KINTAI_ADMIN_REQUIRED: linkAccount is available to Workshop administrators only.",
      "KINTAI_ACCOUNT_NOT_LINKED: this account is not linked to an employee record.",
      "KINTAI_NO_APPROVER: employee 3 has no manager, no designated approver, and no 管理監督者 " +
      "exemption. Give them one before saving this organisation.",
    ];

    for (const message of codes) {
      expect(describeFailure(new Error(message), "fallback")).not.toContain("KINTAI_");
    }
  });

  // The detail names the refused RPC method, which is a fact about our surface and not about
  // anything the reader did.
  it("replaces the admin refusal rather than repeating which method was refused", () => {
    expect(describeFailure(
      new Error(
        "KINTAI_ADMIN_REQUIRED: linkAccount is available to Workshop administrators only. " +
        "Ask an administrator to make this change.",
      ),
      "fallback",
    )).toBe("Only a Workshop administrator can do this. Ask an administrator to make the change.");
  });

  // The id in a not-found came from a control, never from a keystroke, so quoting it back tells
  // the reader nothing they can act on. What they can act on is reloading.
  it("replaces a not-found with what to do about it", () => {
    expect(describeFailure(new Error("KINTAI_NOT_FOUND: there is no employee 42."), "fallback"))
      .toBe("That employee record no longer exists. Reload the roster and try again.");
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

describe("isAdminRequired", () => {
  it("recognises the refusal a non-administrator's capability throws", () => {
    expect(isAdminRequired(new Error(
      "KINTAI_ADMIN_REQUIRED: listEmployees is available to Workshop administrators only. " +
      "Ask an administrator to make this change.",
    ))).toBe(true);
  });

  // Anything else must NOT read as "not an administrator": the page uses this to decide whether to
  // hide every admin control, and a dropped connection is not a demotion.
  it.each([
    new Error("KINTAI_INVALID_INPUT: employee number is required."),
    new Error("KINTAI_NOT_FOUND: there is no employee 42."),
    new Error("connection lost"),
    new Error("the word KINTAI_ADMIN_REQUIRED: appears late in this message"),
    "KINTAI_ADMIN_REQUIRED: thrown as a string",
    undefined,
  ])("does not mistake %o for a refusal", (thrown) => {
    expect(isAdminRequired(thrown)).toBe(false);
  });
});
