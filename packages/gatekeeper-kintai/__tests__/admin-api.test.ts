import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The HR admin surface, reached the way the Workshop reaches it: `KintaiAccount.startAppUi({
// isAdmin })` hands back a capability, and the iframe can only ever call what that capability
// carries.
//
// The authorization property under test is structural, not a check: `startAppUi` returns a
// DIFFERENT class depending on `isAdmin`, so a non-admin's capability has no admin method to call
// in the first place. `isAdmin` is never sent to the browser and never comes back from it, which is
// why no test here passes a flag to a method — there is nowhere to pass one.
//
// Every call is forwarded through `KINTAI_FACET_HOST.callAppUi`, which performs exactly the
// production expression `ctx.exports.KintaiAccount({ props: { accountId } }).startAppUi({ isAdmin })`
// and forwards `args` verbatim, so an authorization test genuinely attempts the call rather than a
// proxy's idea of it.

const HOST = "admin-api-overseer";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let host: ReturnType<typeof env.KINTAI_FACET_HOST.getByName>;
let seq = 0;

beforeEach(() => {
  seq += 1;
  // The account resolves the singleton store, named "". Seed that same instance.
  store = env.KINTAI_STORE.getByName("");
  host = env.KINTAI_FACET_HOST.getByName(HOST);
});

/** A caller's view of the capability `startAppUi` hands the iframe for the given admin status. */
function appUi(accountId: string, isAdmin: boolean) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      // Not a thenable: `await appUi(...)` must not resolve this proxy into a call to `then`.
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callAppUi(accountId, isAdmin, method, args);
    },
  }) as any;
}

async function employee(tag: string) {
  return store.createEmployee({
    employeeNumber: `${tag}-a${seq}`,
    displayName: tag,
    joinedOn: "2026-04-01",
  });
}

// Every method that changes state, plus the two admin-only reads. Each entry is called with
// arguments that are valid for its signature, so a refusal can only come from the authorization
// shape and never from argument validation running first.
const ADMIN_ONLY: [string, unknown[]][] = [
  ["listEmployees", []],
  ["listReportingLines", []],
  ["createEmployee", [{ employeeNumber: "X-1", displayName: "X", joinedOn: "2026-04-01" }]],
  ["linkAccount", ["acct-victim", 1]],
  ["setReportingLine", [1, 2]],
];

describe("the capability a non-admin receives", () => {
  // The whole point of part 1. `linkAccount` maps an account capability onto an employee record —
  // expose it to a non-admin and anyone becomes anyone, a manager included, which bypasses every
  // authority check the approval path makes.
  it.each(ADMIN_ONLY)("refuses %s", async (method, args) => {
    const ui = appUi(`acct-nonadmin-${seq}`, false);

    await expect(() => ui[method](...args)).rejects.toThrow(/KINTAI_ADMIN_REQUIRED/);
  });

  it("names the method it refused, so the app can say what was denied", async () => {
    const ui = appUi(`acct-nonadmin-named-${seq}`, false);

    await expect(() => ui.linkAccount("acct-victim", 1)).rejects.toThrow(/linkAccount/);
  });

  // A non-admin refused `linkAccount` must not be able to reach it by any other name on the same
  // capability. This is what distinguishes "a different class" from "an admin object with a flag".
  it("leaves no admin method reachable under another name", async () => {
    const ui = appUi(`acct-nonadmin-alias-${seq}`, false);

    for (const alias of ["link", "grantIdentity", "store", "sql", "admin"]) {
      await expect(() => ui[alias]()).rejects.toThrow();
    }
  });

  it("still answers whoAmI, which is how an employee reads their code for HR", async () => {
    const accountId = `acct-unlinked-${seq}`;

    expect(await appUi(accountId, false).whoAmI())
      .toEqual({ accountId, linked: false, employeeId: null });
  });
});

describe("whoAmI", () => {
  it("reports an unlinked account for an admin too", async () => {
    const accountId = `acct-admin-unlinked-${seq}`;

    expect(await appUi(accountId, true).whoAmI())
      .toEqual({ accountId, linked: false, employeeId: null });
  });

  it("reports the linked employee, for admin and non-admin alike", async () => {
    const employeeId = await employee("Tanaka");
    const accountId = `acct-linked-${seq}`;
    await store.linkAccount(accountId, employeeId, Date.now());

    const expected = { accountId, linked: true, employeeId };
    expect(await appUi(accountId, true).whoAmI()).toEqual(expected);
    expect(await appUi(accountId, false).whoAmI()).toEqual(expected);
  });

  // The account code the employee reads off the page and hands to HR is their OWN, and it comes
  // from the capability's props. There is no argument that could make it anyone else's.
  it("reports the caller's own account and never another's", async () => {
    const employeeId = await employee("Suzuki");
    const mine = `acct-mine-${seq}`;
    const theirs = `acct-theirs-${seq}`;
    await store.linkAccount(theirs, employeeId, Date.now());

    expect(await appUi(mine, false).whoAmI())
      .toEqual({ accountId: mine, linked: false, employeeId: null });
  });
});

describe("the capability an admin receives", () => {
  it("lists the employees that were written", async () => {
    const tanaka = await employee("Tanaka");
    const ui = appUi(`acct-admin-${seq}`, true);

    const roster = await ui.listEmployees();
    expect(roster.map((row: { id: number }) => row.id)).toContain(tanaka);
    expect(roster.find((row: { id: number }) => row.id === tanaka)).toMatchObject({
      display_name: "Tanaka", status: "active", joined_on: "2026-04-01",
    });
  });

  it("lists the reporting lines that were written", async () => {
    const worker = await employee("Worker");
    const boss = await employee("Boss");
    const ui = appUi(`acct-admin-org-${seq}`, true);

    await ui.setReportingLine(worker, boss);

    expect(await ui.listReportingLines()).toContainEqual(
      expect.objectContaining({ employee_id: worker, manager_id: boss, valid_to: null }),
    );
  });

  it("creates an employee and returns its id", async () => {
    const ui = appUi(`acct-admin-create-${seq}`, true);

    const employeeId = await ui.createEmployee({
      employeeNumber: `E-new-${seq}`, displayName: "New Hire", department: "Sales",
      joinedOn: "2026-04-01",
    });

    expect(await store.resolveAccount("never-linked", Date.now())).toBeNull();
    expect(await ui.listEmployees()).toContainEqual(
      expect.objectContaining({ id: employeeId, display_name: "New Hire", department: "Sales" }),
    );
  });

  // The onboarding path this whole sub-project exists to unblock: before it, `linkAccount` lived
  // only on the store, which nothing outside the worker can reach, so every account answered
  // `linked: false` forever and nobody could be set up.
  it("onboards an employee end to end: create, link, and the account reports linked", async () => {
    const hr = appUi(`acct-hr-${seq}`, true);
    const newHire = `acct-newhire-${seq}`;

    expect(await appUi(newHire, false).whoAmI())
      .toEqual({ accountId: newHire, linked: false, employeeId: null });

    const employeeId = await hr.createEmployee({
      employeeNumber: `E-hire-${seq}`, displayName: "Yamada", joinedOn: "2026-04-01",
    });
    await hr.linkAccount(newHire, employeeId);

    expect(await appUi(newHire, false).whoAmI())
      .toEqual({ accountId: newHire, linked: true, employeeId });
  });

  // Who performed the link is the audit trail for the one operation that grants identity, and it
  // is taken from the admin's OWN capability — never from an argument naming who to credit.
  it("records the linking admin from their own capability, not from an argument", async () => {
    const adminEmployee = await employee("Admin");
    const adminAccount = `acct-hr-audited-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());
    const hr = appUi(adminAccount, true);

    const employeeId = await hr.createEmployee({
      employeeNumber: `E-audited-${seq}`, displayName: "Audited", joinedOn: "2026-04-01",
    });
    await hr.linkAccount(`acct-audited-${seq}`, employeeId);

    expect(await store.openAccountLink(`acct-audited-${seq}`))
      .toMatchObject({ employee_id: employeeId, linked_by: adminEmployee });
  });

  // Re-linking is the supported path for an email change, and it must keep working through the
  // admin surface: the employee record and its payroll history are untouched, only which account
  // resolves to it changes.
  it("re-points an employee at a new account, closing the old link", async () => {
    const employeeId = await employee("Moved");
    const oldAccount = `acct-old-${seq}`;
    const newAccount = `acct-new-${seq}`;
    const hr = appUi(`acct-hr-relink-${seq}`, true);

    await hr.linkAccount(oldAccount, employeeId);
    await hr.linkAccount(newAccount, employeeId);

    expect(await appUi(newAccount, false).whoAmI())
      .toEqual({ accountId: newAccount, linked: true, employeeId });
    expect(await appUi(oldAccount, false).whoAmI())
      .toEqual({ accountId: oldAccount, linked: false, employeeId: null });
  });
});

describe("the frame the Workshop hosts", () => {
  // The Workshop calls startAppUi() on the account stub and hands the whole frame to the browser.
  // Both halves have to survive that trip: the HTML it puts in the iframe, and the capability the
  // iframe opens a Cap'n Web session on.
  it("carries the built app and a live capability", async () => {
    const accountId = `acct-frame-${seq}`;
    const frame = await host.openAppUi(accountId, false);

    expect(frame.iframeHtml).toContain("<!doctype html>");
    // The bundle, not the un-built source: an iframe served the source would fetch nothing.
    expect(frame.iframeHtml).toContain("Generated from packages/gatekeeper-kintai/app");
    expect(frame.iframeHtml).not.toContain('src="./main.tsx"');
    expect(await frame.ui.whoAmI()).toEqual({ accountId, linked: false, employeeId: null });
  });
});
