import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminKintaiApi, ViewerKintaiApi } from "../src/admin-api.js";

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

// Valid arguments for every member of `KintaiAdminApi`, so a refusal can only come from the
// authorization shape and never from argument validation running first.
const CALL_ARGS: Record<string, unknown[]> = {
  whoAmI: [],
  listEmployees: [],
  listReportingLines: [],
  createEmployee: [{ employeeNumber: "X-1", displayName: "X", joinedOn: "2026-04-01" }],
  linkAccount: ["acct-victim", 1],
  setReportingLine: [1, 2],
};

/**
 * Every member of `KintaiAdminApi`, written out.
 *
 * A literal list rather than something derived, because it is pinning the two classes against the
 * interface and anything derived from those classes would move with them. Adding a member to the
 * interface means adding it here and deciding what it does to a non-admin.
 */
const INTERFACE_MEMBERS = [
  "createEmployee", "linkAccount", "listEmployees", "listReportingLines", "setReportingLine",
  "whoAmI",
];

/** The names a caller can actually invoke on `cls` over RPC. */
function callableSurface(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter((name) => name !== "constructor")
    .toSorted();
}

// Everything admin-only: the mutations plus the two admin-only reads.
const ADMIN_ONLY: [string, unknown[]][] =
  INTERFACE_MEMBERS.filter((name) => name !== "whoAmI").map((name) => [name, CALL_ARGS[name]]);

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

  /**
   * The guard the `implements` check does NOT give us.
   *
   * `implements KintaiAdminApi` catches a method added to the INTERFACE — both classes then fail
   * to compile until someone decides. It does not catch a method added to the CLASS: an extra
   * public method on `ViewerKintaiApi` that is absent from the interface compiles clean and is
   * callable over RPC. (Nor does an OPTIONAL interface member, which satisfies both classes
   * without either implementing it.) Narrowing the decorator to `@validateRpc<KintaiAdminApi>()`
   * does generate a narrowed `methods` map, but capnweb-validate 0.3.0's runtime wrapper
   * dispatches the extra method anyway, so there is no decorator-level fix today.
   *
   * So the surface is pinned here instead, and pinned by *calling* rather than by reflection
   * alone: every name reachable on the viewer must be a member of the interface, and every member
   * but `whoAmI` must come back refused. The previous version of this test only tried invented
   * names, which passed on "no such method" and never distinguished refused from absent — it would
   * not have caught the hole this test exists for.
   */
  it("exposes exactly the interface, and refuses every member of it but whoAmI", async () => {
    expect(callableSurface(ViewerKintaiApi)).toEqual(INTERFACE_MEMBERS.toSorted());

    const ui = appUi(`acct-surface-${seq}`, false);
    for (const method of callableSurface(ViewerKintaiApi)) {
      const args = CALL_ARGS[method];
      expect(args, `no arguments recorded for ${method}`).toBeDefined();
      if (method === "whoAmI") {
        expect(await ui.whoAmI()).toMatchObject({ linked: false });
        continue;
      }
      // Refused, not absent: "no such method" would throw too, and would pass a weaker assertion.
      await expect(() => ui[method](...args)).rejects.toThrow(/KINTAI_ADMIN_REQUIRED/);
    }
  });

  // The admin class is pinned to the same interface, so an unreviewed public method cannot appear
  // on the administrator's capability either.
  it("keeps the admin capability to exactly the interface too", () => {
    expect(callableSurface(AdminKintaiApi)).toEqual(INTERFACE_MEMBERS.toSorted());
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

describe("the roster an admin reads", () => {
  // The roster is the screen HR works from, so what it returns is what HR believes. These pin the
  // two computed columns at the API boundary; `roster.test.ts` pins the rules behind them.
  it("reports who is linked and who can actually file", async () => {
    const hr = appUi(`acct-admin-roster-${seq}`, true);
    const unlinked = await employee("Unlinked");
    const stranded = await employee("Stranded");
    const working = await employee("Working");
    const boss = await employee("Boss");
    await hr.linkAccount(`acct-stranded-${seq}`, stranded);
    await hr.linkAccount(`acct-working-${seq}`, working);
    await hr.setReportingLine(working, boss);

    const roster: Record<string, any> = Object.fromEntries(
      (await hr.listEmployees()).map((row: { id: number }) => [row.id, row]),
    );

    expect(roster[unlinked])
      .toMatchObject({ linked: false, managerIds: [], approverReachable: false });
    // Linked and still unable to use the system: the state an HR user would otherwise call done.
    expect(roster[stranded]).toMatchObject({ linked: true, approverReachable: false });
    expect(roster[working])
      .toMatchObject({ linked: true, managerIds: [boss], approverReachable: true });
  });

  // The roster is the whole headcount, and every row of it carries a display name and an employee
  // number. It must not also carry anybody's account code: HR learns those from the employee, one
  // at a time, and a list of them would be a list of identities waiting to be pointed somewhere.
  it("never puts another employee's account code on the roster", async () => {
    const hr = appUi(`acct-admin-noleak-${seq}`, true);
    const id = await employee("Secretive");
    const accountId = `acct-secret-${seq}`;
    await hr.linkAccount(accountId, id);

    expect(JSON.stringify(await hr.listEmployees())).not.toContain(accountId);
  });
});

describe("what an admin may write", () => {
  // `joinedOn` is now typed into a form. `@validateRpc()` only knows it is a string, and the
  // column has no CHECK, so a date that does not exist would persist and every later reader would
  // treat it as real. The check is `assertWorkDate`, imported from `input.ts` -- the same one the
  // session facet applies to every other date in this package, not a second copy of the rule.
  it.each(["2026-02-31", "2026-13-01", "01/04/2026", "2026-4-1", ""])(
    "refuses %o as a joining date", async (joinedOn) => {
      const hr = appUi(`acct-admin-date-${seq}`, true);

      await expect(() => hr.createEmployee({
        employeeNumber: `E-date-${seq}`, displayName: "Bad Date", joinedOn,
      })).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    },
  );

  it("refuses a nameless employee, who nobody could pick out of an approval queue", async () => {
    const hr = appUi(`acct-admin-blank-${seq}`, true);

    await expect(() => hr.createEmployee({
      employeeNumber: `E-blank-${seq}`, displayName: "   ", joinedOn: "2026-04-01",
    })).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    await expect(() => hr.createEmployee({
      employeeNumber: "", displayName: "No Number", joinedOn: "2026-04-01",
    })).rejects.toThrow(/KINTAI_INVALID_INPUT/);
  });

  it("refuses an oversized field rather than writing it into the shared store", async () => {
    const hr = appUi(`acct-admin-long-${seq}`, true);

    await expect(() => hr.createEmployee({
      employeeNumber: `E-long-${seq}`, displayName: "x".repeat(201), joinedOn: "2026-04-01",
    })).rejects.toThrow(/KINTAI_INVALID_INPUT/);
  });

  // The UNIQUE index is the authority; this is about the message HR reads when they hit it. An
  // uncoded SQLite failure is a 500 in the iframe and tells them nothing.
  it("refuses a duplicate employee number in a sentence, not a constraint violation", async () => {
    const hr = appUi(`acct-admin-dup-${seq}`, true);
    const number = `E-dup-${seq}`;
    await hr.createEmployee({ employeeNumber: number, displayName: "First", joinedOn: "2026-04-01" });

    await expect(() => hr.createEmployee({
      employeeNumber: number, displayName: "Second", joinedOn: "2026-04-01",
    })).rejects.toThrow(/KINTAI_INVALID_INPUT.*already belongs/);
  });

  // A designated approver is one of only three ways an employee can ever have anything approved.
  // Pointing it at a record that does not exist builds exactly the silently-unusable employee the
  // roster exists to expose.
  it("refuses a designated approver who does not exist", async () => {
    const hr = appUi(`acct-admin-noapprover-${seq}`, true);

    await expect(() => hr.createEmployee({
      employeeNumber: `E-ghost-${seq}`, displayName: "Ghost Boss", joinedOn: "2026-04-01",
      designatedApproverId: 999_999,
    })).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  it("refuses to link an account to an employee who does not exist", async () => {
    const hr = appUi(`acct-admin-linkghost-${seq}`, true);

    await expect(() => hr.linkAccount(`acct-ghost-${seq}`, 999_999))
      .rejects.toThrow(/KINTAI_NOT_FOUND/);
    // And refused before anything was written: the account still resolves to nobody.
    expect(await store.resolveAccount(`acct-ghost-${seq}`, Date.now())).toBeNull();
  });

  it("refuses a blank account code", async () => {
    const hr = appUi(`acct-admin-blankcode-${seq}`, true);
    const id = await employee("Waiting");

    await expect(() => hr.linkAccount("   ", id)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
  });

  // A self-edge looks like progress and grants nothing: self-approval is refused outright by
  // `actOnSubmission`, so the employee would stay unable to file with a reporting line on screen.
  it("refuses a reporting line from an employee to themselves", async () => {
    const hr = appUi(`acct-admin-self-${seq}`, true);
    const id = await employee("Loner");

    await expect(() => hr.setReportingLine(id, id)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    expect((await store.listReportingLines()).filter((row) => row.employee_id === id)).toEqual([]);
  });

  it("refuses a reporting line naming an employee or a manager who does not exist", async () => {
    const hr = appUi(`acct-admin-orgghost-${seq}`, true);
    const id = await employee("Real");

    await expect(() => hr.setReportingLine(id, 999_999)).rejects.toThrow(/KINTAI_NOT_FOUND/);
    await expect(() => hr.setReportingLine(999_999, id)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  // Validation runs ahead of the mutation AND ahead of its audit entry, so a refused call leaves
  // no trace suggesting something happened.
  it("writes no audit entry for a call it refused", async () => {
    const hr = appUi(`acct-admin-noaudit-${seq}`, true);
    const before = (await store.auditEntries()).length;

    await expect(() => hr.createEmployee({
      employeeNumber: `E-refused-${seq}`, displayName: "Refused", joinedOn: "2026-02-31",
    })).rejects.toThrow(/KINTAI_INVALID_INPUT/);

    expect((await store.auditEntries()).length).toBe(before);
  });
});

describe("the audit trail", () => {
  // src/store/audit.ts promises to record "account linking, org edges, exemptions, route
  // configuration and period locks". Before part 1 nothing in the runtime called `appendAudit` at
  // all -- only tests did. These are the first three runtime callers, and each records an actor
  // taken from the acting admin's own capability.
  async function entriesFor(action: string, entityId: number) {
    return (await store.auditEntries())
      .filter((row) => row.action === action && row.entity_id === entityId);
  }

  it("records who created an employee", async () => {
    const adminEmployee = await employee("Creator");
    const adminAccount = `acct-audit-create-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());

    const employeeId = await appUi(adminAccount, true).createEmployee({
      employeeNumber: `E-ac-${seq}`, displayName: "Created", joinedOn: "2026-04-01",
    });

    const [entry] = await entriesFor("create_employee", employeeId);
    expect(entry).toMatchObject({ entity: "employees", actor_employee_id: adminEmployee });
    expect(JSON.parse(entry.after!)).toMatchObject({ displayName: "Created" });
  });

  it("records who linked an account, and what it resolved to before", async () => {
    const adminEmployee = await employee("Linker");
    const adminAccount = `acct-audit-link-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());
    const hr = appUi(adminAccount, true);

    const first = await employee("First");
    const second = await employee("Second");
    const subject = `acct-audit-subject-${seq}`;

    await hr.linkAccount(subject, first);
    await hr.linkAccount(subject, second);

    const [opened] = await entriesFor("link_account", first);
    expect(opened).toMatchObject({ entity: "account_links", actor_employee_id: adminEmployee });
    // Nothing was there before, so `before` is SQL NULL rather than the JSON text "null".
    expect(opened.before).toBeNull();
    expect(JSON.parse(opened.after!)).toEqual({ accountId: subject, employeeId: first });

    // Re-pointing records what the account resolved to beforehand -- unrecoverable once the old
    // link is closed, and the first question an auditor asks about an identity change.
    const [moved] = await entriesFor("link_account", second);
    expect(JSON.parse(moved.before!)).toEqual({ accountId: subject, employeeId: first });
    expect(JSON.parse(moved.after!)).toEqual({ accountId: subject, employeeId: second });
  });

  it("records who granted approval authority, naming the edge it created", async () => {
    const adminEmployee = await employee("Granter");
    const adminAccount = `acct-audit-org-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());

    const worker = await employee("Reportee");
    const boss = await employee("Manager");
    await appUi(adminAccount, true).setReportingLine(worker, boss);

    const edge = (await store.listReportingLines())
      .find((row) => row.employee_id === worker && row.manager_id === boss)!;
    const [entry] = await entriesFor("set_reporting_line", edge.id);
    // entity_id is the org_edges row itself, so the entry joins back to the authority it granted.
    expect(entry).toMatchObject({ entity: "org_edges", actor_employee_id: adminEmployee });
    expect(JSON.parse(entry.after!)).toMatchObject({ employeeId: worker, managerId: boss });
  });

  // A real case: the first administrator acts before anybody is onboarded, so they have no
  // employee record to be the actor. The column is nullable for exactly this.
  it("leaves the actor null when the acting admin has no employee record", async () => {
    const employeeId = await appUi(`acct-audit-noemp-${seq}`, true).createEmployee({
      employeeNumber: `E-first-${seq}`, displayName: "First Hire", joinedOn: "2026-04-01",
    });

    const [entry] = await entriesFor("create_employee", employeeId);
    expect(entry.actor_employee_id).toBeNull();
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
