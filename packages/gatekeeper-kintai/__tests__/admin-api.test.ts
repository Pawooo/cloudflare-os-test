import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminKintaiApi } from "../src/admin-api.js";
import { jstWorkDate } from "../src/work-date.js";

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

/** A caller's view of the session a Gadget holds, so a test can attempt an ordinary punch. */
function sessionFor(accountId: string) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) =>
        host.callSession(accountId, `session-${accountId}-${seq}`, method, args);
    },
  }) as any;
}

/**
 * One employee with a manager, a worked day, a flagged day, a pending overtime request and a
 * pending correction — the smallest store state in which all four attendance reads return
 * something.
 *
 * `period` is a parameter, and every test that calls this passes its OWN month. This file shares
 * one store (`getByName("")`, matching production, because that is the instance the account
 * resolves) and there is no unlock anywhere in this package, so a test that closes a month closes
 * it for every test that runs after it. Months are therefore rationed here rather than reused.
 */
async function attendance(tag: string, period: string) {
  const worker = await employee(`${tag}-worker`);
  const boss = await employee(`${tag}-boss`);
  await store.setReportingLine(worker, boss, 0);

  // 09:00 JST on the second of the month, out eight hours later: one complete, unflagged day.
  const day = `${period}-02`;
  const nine = Date.parse(`${day}T00:00:00Z`);
  await store.recordPunch({
    employeeId: worker, workDate: day, kind: "in", now: nine, source: "gadget",
  });
  const outId = await store.recordPunch({
    employeeId: worker, workDate: day, kind: "out", now: nine + 8 * 3_600_000, source: "gadget",
  });
  // The next day, a clock-in and nothing else: `unpaired_in`, which is what the flagged-day read
  // exists to surface.
  const flaggedDay = `${period}-03`;
  await store.recordPunch({
    employeeId: worker, workDate: flaggedDay, kind: "in", now: nine + 86_400_000,
    source: "gadget",
  });

  const overtimeId = await store.submitOvertime({
    employeeId: worker, requestedFor: day, minutes: 120, reason: "site overrun",
    now: nine + 9 * 3_600_000, department: null, employmentType: null,
  });
  const correctionId = await store.fileAmendment({
    employeeId: worker, targetPunchId: outId, occurredAt: nine + 9 * 3_600_000,
    reason: "left at six; the terminal was tapped when clocking out at five",
    now: nine + 10 * 3_600_000, department: null, employmentType: null, createdBy: worker,
  });

  return { worker, boss, day, flaggedDay, nine, outId, overtimeId, correctionId };
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
  setDesignatedApprover: [1, 2],
  grantExemption: [1],
  setWorkDatePolicy: [1, "shift_start"],
  listPendingOverview: [],
  listAnomalousDays: ["2026-07"],
  monthlyReport: ["2026-07"],
  getEmployeeDay: [1, "2026-07-03"],
  // A past month nothing else in this file closes. A non-admin's call never reaches the write, but
  // a period named here must still be one no later test wants open, because a refusal that stopped
  // working would silently close it. See the note on "closing a month" for the 2025 convention.
  lockPeriod: ["2025-11"],
};

/**
 * Every member of `KintaiAdminApi`, written out.
 *
 * A literal list rather than something derived, because it is pinning the two classes against the
 * interface and anything derived from those classes would move with them. Adding a member to the
 * interface means adding it here and deciding what it does to a non-admin.
 */
const INTERFACE_MEMBERS = [
  "createEmployee", "getEmployeeDay", "grantExemption", "linkAccount", "listAnomalousDays",
  "listEmployees", "listPendingOverview", "listReportingLines", "lockPeriod", "monthlyReport",
  "setDesignatedApprover", "setReportingLine", "setWorkDatePolicy", "whoAmI",
];

/**
 * The exact fields every reading method hands the browser.
 *
 * `INTERFACE_MEMBERS` pins method NAMES, and that turned out to be half a pin: `listEmployees`
 * went from returning the raw `employees` row to returning `RosterEntry` — four more fields,
 * including every employee's position in the org chart — without a single name changing, so
 * nothing here had to move and nothing noticed. `toMatchObject` elsewhere in the suite is
 * permissive in the same direction: it cannot see a field that was added.
 *
 * So the shapes are written out too. Widening what an admin-only read returns is a decision about
 * what leaves the worker, and it should have to be made here, in the file a reviewer already opens
 * to see what this surface exposes. Pinned by CALLING each method, as the surface test is, rather
 * than against a type that would move with the code.
 */
const RETURN_SHAPES: Record<string, string[]> = {
  whoAmI: ["accountId", "employeeId", "linked"],
  listEmployees: [
    "approverReachable", "departed_on", "department", "designated_approver_id", "display_name",
    "employee_number", "employment_type", "exempt", "id", "joined_on", "linked", "managerIds",
    "status", "work_date_policy",
  ],
  listReportingLines: ["employee_id", "id", "manager_id", "valid_from", "valid_to"],
  listAnomalousDays: ["anomalies", "displayName", "employeeId", "employeeNumber", "workDate"],
  monthlyReport: ["locked", "period", "rows"],
  getEmployeeDay: ["anomalies", "punches", "workedMinutes"],
  // Every column of `submissions` plus the six the dashboard adds. An amendment row carries one
  // more key, `amendment`, and ABSENCE of it is the discriminator — see the assertion below.
  listPendingOverview: [
    "calculation_inputs", "created_by", "current_step", "eligibleActorIds", "eligibleActorNames",
    "employeeName", "employeeNumber", "employee_id", "filedByName", "id", "kind", "minutes",
    "reason", "requested_for", "route_snapshot", "state", "submitted_at", "waitingMs",
  ],
};

/**
 * The shapes NESTED inside the four attendance reads, pinned for the same reason as the top-level
 * ones.
 *
 * These are where the widening actually lands. `monthlyReport` and `getEmployeeDay` hand back
 * objects whose interesting fields are one level down — a punch row is fifteen columns of one
 * named person's day, including where they were standing — so a pin on the three or four keys at
 * the top would say almost nothing about what leaves the worker. A field added to `PunchRow`, or
 * to the amendment detail, must be a decision made in this file.
 */
const NESTED_RETURN_SHAPES: Record<string, string[]> = {
  monthlyRow: [
    "anomalousDays", "daysWorked", "displayName", "employeeId", "employeeNumber", "workedMinutes",
  ],
  punchRow: [
    "accuracy_m", "amend_reason", "amended_by", "employee_id", "id", "kind", "latitude",
    "location_source", "longitude", "matched_site_id", "occurred_at", "recorded_at", "source",
    "supersedes_id", "work_date",
  ],
  amendmentDetail: [
    "currentOccurredAt", "kind", "lockedPeriod", "requestedOccurredAt", "targetPunchId",
    "workDate",
  ],
};

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
  // The whole point of part 1, now held in a stronger way than a refusal. A non-admin holds
  // `EmployeeKintaiApi` — a DIFFERENT capability (see `kintai.ts`) scoped to their own attendance —
  // so `linkAccount` and every other admin method is not refused, it does not exist to call. That
  // is what `startAppUi` chooses server-side from `isAdmin`; the browser holds one object or the
  // other and there is no flag on it to forge. (It used to be `ViewerKintaiApi`, a refuse-all twin
  // that implemented this interface and threw on all but `whoAmI`; the employee gadget gave
  // non-admins a real capability, and the throwing twin — the admin methods still spelled out on it
  // — was then both dead and a wider surface than "the methods are absent".)
  it.each(ADMIN_ONLY)("does not expose %s to a non-admin at all", async (method, args) => {
    const ui = appUi(`acct-nonadmin-${seq}`, false);

    // Absent, not refused: the method is not on the employee capability, so the RPC layer itself
    // reports it missing. That is a stronger guarantee than a `KINTAI_ADMIN_REQUIRED` stub would be.
    await expect(() => ui[method](...args)).rejects.toThrow(/does not implement the method/);
  });

  it("hands a non-admin the employee capability, scoped to their own record", async () => {
    const id = await employee("Nonadmin Employee");
    const accountId = `acct-nonadmin-emp-${seq}`;
    await store.linkAccount(accountId, id, Date.now());
    const ui = appUi(accountId, false);

    // whoAmI, the one method every caller may reach, still answers — and an employee read it DOES
    // carry works, bounded to this employee's own record. The employee surface is exercised in full
    // in `employee-api.test.ts`; here it is only that the repoint landed on the right object.
    expect(await ui.whoAmI()).toMatchObject({ linked: true, employeeId: id });
    expect(await ui.myMonth("2026-07")).toEqual({ period: "2026-07", days: [] });
  });

  // The admin class is pinned to the interface, so an unreviewed public method cannot appear on the
  // administrator's capability. The parallel pin for the non-admin capability —
  // `EmployeeKintaiApi` exposes none of these — lives in `employee-api.test.ts`.
  it("keeps the admin capability to exactly the interface", () => {
    expect(callableSurface(AdminKintaiApi)).toEqual(INTERFACE_MEMBERS.toSorted());
  });

  /**
   * The other half of the pin: not just which methods exist, but what they hand back.
   *
   * A method that starts returning more fields widens this surface without touching a single name,
   * which is exactly how `listEmployees` grew four fields in part 2. Every reading method is called
   * for real and its keys compared against a written-out list; the writes are checked to return
   * nothing, so one cannot start leaking an id or a row on the way out.
   */
  it("returns exactly the fields written down for each read, and nothing from the writes",
    async () => {
      const hr = appUi(`acct-shape-${seq}`, true);
      const employeeId = await employee("Shape");
      const managerId = await employee("ShapeBoss");
      await hr.linkAccount(`acct-shape-linked-${seq}`, employeeId);
      await hr.setReportingLine(employeeId, managerId);

      expect(Object.keys(await hr.whoAmI()).toSorted()).toEqual(RETURN_SHAPES.whoAmI);
      for (const method of ["listEmployees", "listReportingLines"]) {
        const rows = await hr[method]();
        expect(rows.length, `${method} returned nothing to inspect`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(Object.keys(row).toSorted(), method).toEqual(RETURN_SHAPES[method]);
        }
      }

      // The mutations answer with nothing. `createEmployee` is the one exception and answers with
      // the id it created, which the caller has no other way to learn.
      expect(await hr.linkAccount(`acct-shape-two-${seq}`, employeeId)).toBeUndefined();
      expect(await hr.setReportingLine(managerId, employeeId)).toBeUndefined();
      expect(await hr.grantExemption(employeeId)).toBeUndefined();
      expect(await hr.setWorkDatePolicy(employeeId, "shift_start")).toBeUndefined();
      expect(typeof await hr.createEmployee({
        employeeNumber: `E-shape-${seq}`, displayName: "Shaped", joinedOn: "2026-04-01",
      })).toBe("number");
    });

  /**
   * The same pin for the four attendance reads, which needed a store with attendance in it.
   *
   * Separate from the test above rather than folded into it: these four return nothing at all
   * until somebody has punched, been flagged and filed something, so the seeding is most of the
   * test. The point is unchanged — every field these hand the browser is written down here, in the
   * file a reviewer opens to see what this surface exposes, and this is the surface that reads the
   * whole company's worked hours.
   */
  it("returns exactly the fields written down for each attendance read", async () => {
    // Linked, because `lockPeriod` records who closed the month and refuses an admin who has no
    // employee record to be that person. See "closing a month" below.
    const adminAccount = `acct-shape-attendance-${seq}`;
    await store.linkAccount(adminAccount, await employee("Shape Admin"), Date.now());
    const hr = appUi(adminAccount, true);
    const { worker, day, correctionId } = await attendance("shape", "2026-06");

    for (const [method, args] of [
      ["listAnomalousDays", ["2026-06"]], ["listPendingOverview", []],
    ] as [string, unknown[]][]) {
      const rows = await hr[method](...args);
      expect(rows.length, `${method} returned nothing to inspect`).toBeGreaterThan(0);
      for (const row of rows) {
        // An amendment row carries the request's own detail and an overtime row does not, so the
        // discriminator is part of the pin rather than something the comparison tolerates.
        const expected = row.kind === "amendment"
          ? [...RETURN_SHAPES[method], "amendment"].toSorted()
          : RETURN_SHAPES[method];
        expect(Object.keys(row).toSorted(), method).toEqual(expected);
      }
    }

    const report = await hr.monthlyReport("2026-06");
    expect(Object.keys(report).toSorted()).toEqual(RETURN_SHAPES.monthlyReport);
    expect(report.rows.length, "monthlyReport returned no rows").toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(Object.keys(row).toSorted()).toEqual(NESTED_RETURN_SHAPES.monthlyRow);
    }

    const employeeDay = await hr.getEmployeeDay(worker, day);
    expect(Object.keys(employeeDay).toSorted()).toEqual(RETURN_SHAPES.getEmployeeDay);
    expect(employeeDay.punches.length, "getEmployeeDay returned no punches").toBeGreaterThan(0);
    for (const punch of employeeDay.punches) {
      expect(Object.keys(punch).toSorted()).toEqual(NESTED_RETURN_SHAPES.punchRow);
    }

    const correction = (await hr.listPendingOverview())
      .find((item: { id: number }) => item.id === correctionId)!;
    expect(Object.keys(correction.amendment).toSorted())
      .toEqual(NESTED_RETURN_SHAPES.amendmentDetail);

    // The one new write answers with nothing, like every other write here. Its own month, and a
    // past one: see the note on "closing a month" for why every month closed in this file is a
    // 2025 month.
    expect(await hr.lockPeriod("2025-12")).toBeUndefined();
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

describe("designating an approver", () => {
  // The case this method exists for. A company officer reports to nobody, and the only honest way
  // to complete their row is to name the person who signs for them -- previously impossible,
  // because `designated_approver_id` was settable only in `createEmployee`'s INSERT and employee 1
  // is created when there is nobody in the table to point at.
  it("completes an employee who reports to nobody, without inventing a manager", async () => {
    const hr = appUi(`acct-admin-designate-${seq}`, true);
    const officer = await employee("Officer");
    const chair = await employee("Chair");
    await hr.linkAccount(`acct-officer-${seq}`, officer);

    const before = (await hr.listEmployees()).find((row: { id: number }) => row.id === officer);
    expect(before).toMatchObject({ linked: true, approverReachable: false });

    await hr.setDesignatedApprover(officer, chair);

    const after = (await hr.listEmployees()).find((row: { id: number }) => row.id === officer);
    // Ready, and with an EMPTY manager list: nothing false was written into the org chart.
    expect(after).toMatchObject({
      designated_approver_id: chair, approverReachable: true, managerIds: [],
    });
    expect(await store.listReportingLines())
      .not.toContainEqual(expect.objectContaining({ employee_id: officer }));
  });

  // `hasReachableApprover` is what every filing path enforces through, so the roster's verdict has
  // to be the runtime's verdict and not a second reading that happens to agree today.
  it("makes the runtime agree that the employee can now file", async () => {
    const hr = appUi(`acct-admin-designate-runtime-${seq}`, true);
    const officer = await employee("Runtime Officer");
    const chair = await employee("Runtime Chair");

    await expect(() => store.assertApproverReachable(officer, Date.now()))
      .rejects.toThrow(/KINTAI_NO_APPROVER/);
    await hr.setDesignatedApprover(officer, chair);
    await store.assertApproverReachable(officer, Date.now());
  });

  // Re-pointing overwrites, so the previous value survives only in the audit trail. That is the
  // whole reason `before` is read ahead of the write.
  it("audits the change with what it was and what it became", async () => {
    const hr = appUi(`acct-admin-designate-audit-${seq}`, true);
    const officer = await employee("Audited Officer");
    const first = await employee("First Approver");
    const second = await employee("Second Approver");

    await hr.setDesignatedApprover(officer, first);
    await hr.setDesignatedApprover(officer, second);

    const entries = (await store.auditEntries())
      .filter((row) => row.action === "set_designated_approver" && row.entity_id === officer);
    expect(entries).toHaveLength(2);
    expect(JSON.parse(entries[0].before!)).toEqual({ employeeId: officer, approverId: null });
    expect(JSON.parse(entries[0].after!)).toEqual({ employeeId: officer, approverId: first });
    expect(JSON.parse(entries[1].before!)).toEqual({ employeeId: officer, approverId: first });
    expect(JSON.parse(entries[1].after!)).toEqual({ employeeId: officer, approverId: second });
  });

  // Nobody may approve their own submissions, so a self-designation grants no authority at all.
  // `hasReachableApprover` and `requiredApprovers` both already collapse it to "no approver" and
  // fail closed -- writing one would hand HR a green-looking field that changes nothing, which is
  // the silent no-op `setReportingLine` refuses a self-edge to avoid.
  it("refuses an employee designated as their own approver", async () => {
    const hr = appUi(`acct-admin-designate-self-${seq}`, true);
    const officer = await employee("Self Officer");

    await expect(() => hr.setDesignatedApprover(officer, officer))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);
    expect(await store.designatedApproverOf(officer)).toBeNull();
  });

  it("refuses an approver who does not exist", async () => {
    const hr = appUi(`acct-admin-designate-ghost-${seq}`, true);
    const officer = await employee("Ghost Officer");

    await expect(() => hr.setDesignatedApprover(officer, 999_999))
      .rejects.toThrow(/KINTAI_NOT_FOUND/);
    expect(await store.designatedApproverOf(officer)).toBeNull();
  });

  it("refuses an employee who does not exist", async () => {
    await expect(() => appUi(`acct-admin-designate-noemp-${seq}`, true)
      .setDesignatedApprover(999_999, 1)).rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  // Two officers who sign for each other is a legitimate arrangement and not a cycle anything
  // walks: nothing follows `designated_approver_id` transitively -- `authorize` and
  // `requiredApprovers` each take exactly one hop, and self-approval is what actually strands.
  it("allows two employees to be each other's designated approver", async () => {
    const hr = appUi(`acct-admin-designate-pair-${seq}`, true);
    const one = await employee("Director A");
    const two = await employee("Director B");

    await hr.setDesignatedApprover(one, two);
    await hr.setDesignatedApprover(two, one);

    await store.assertApproverReachable(one, Date.now());
    await store.assertApproverReachable(two, Date.now());
  });

  // A designated approver can sign for the employee at the root of the tree. Reachable by that
  // employee, it would be a way to appoint whoever is most likely to say yes to their own record.
  // A non-admin holds `EmployeeKintaiApi`, on which this method does not exist to call at all.
  it("is not on a non-administrator's capability", async () => {
    const officer = await employee("Nonadmin Officer");
    const chair = await employee("Nonadmin Chair");

    await expect(() => appUi(`acct-nonadmin-designate-${seq}`, false)
      .setDesignatedApprover(officer, chair)).rejects.toThrow(/does not implement the method/);
    expect(await store.designatedApproverOf(officer)).toBeNull();
  });
});

describe("recording 管理監督者", () => {
  // 管理監督者 says the employee's overtime bears no premium. It does NOT say anybody can approve
  // for them, and the roster must not report it as though it did: their punches still need
  // correcting, and a correction is a request that needs a human. Recorded, and still not ready.
  it("does not complete an employee who reports to nobody", async () => {
    const hr = appUi(`acct-admin-exempt-${seq}`, true);
    const officer = await employee("Officer");
    await hr.linkAccount(`acct-officer-${seq}`, officer);

    await hr.grantExemption(officer);

    const after = (await hr.listEmployees()).find((row: { id: number }) => row.id === officer);
    expect(after).toMatchObject({ exempt: true, approverReachable: false, managerIds: [] });
    await expect(() => store.assertApproverReachable(officer, Date.now()))
      .rejects.toThrow(/KINTAI_NO_APPROVER/);
  });

  it("opens the period now and leaves it open", async () => {
    const hr = appUi(`acct-admin-exempt-open-${seq}`, true);
    const officer = await employee("Open Officer");
    const before = Date.now();

    await hr.grantExemption(officer);

    expect(await store.isExempt(officer, before - 1)).toBe(false);
    expect(await store.isExempt(officer, Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  // Not a new rule: the check is `isExempt`, the same function the premium calculation asks. A
  // second open period changes no answer and leaves two rows claiming to be the determination.
  it("refuses a second exemption for someone who already has one", async () => {
    const hr = appUi(`acct-admin-exempt-twice-${seq}`, true);
    const officer = await employee("Twice Officer");
    await hr.grantExemption(officer);

    await expect(() => hr.grantExemption(officer))
      .rejects.toThrow(/KINTAI_INVALID_INPUT.*already recorded as 管理監督者/);
  });

  it("refuses an employee who does not exist", async () => {
    await expect(() => appUi(`acct-admin-exempt-ghost-${seq}`, true).grantExemption(999_999))
      .rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  // 管理監督者 exempts overtime from a premium under 労働基準法 §37. An employee who could record
  // it for themselves could write their own exemption into the payroll record — so it is not on the
  // employee capability at all.
  it("is not on a non-administrator's capability", async () => {
    const officer = await employee("Self Officer");

    await expect(() => appUi(`acct-nonadmin-exempt-${seq}`, false).grantExemption(officer))
      .rejects.toThrow(/does not implement the method/);
    expect(await store.isExempt(officer, Date.now())).toBe(false);
  });
});

describe("recording an employee's work-date policy", () => {
  it("sets it, and the roster then reports it", async () => {
    const hr = appUi(`acct-admin-policy-${seq}`, true);
    const crew = await employee("Night Crew");

    const before = (await hr.listEmployees()).find((row: { id: number }) => row.id === crew);
    // The default is what every employee already has, and it is not something HR had to choose.
    expect(before).toMatchObject({ work_date_policy: "calendar" });

    await hr.setWorkDatePolicy(crew, "shift_start");

    const after = (await hr.listEmployees()).find((row: { id: number }) => row.id === crew);
    expect(after).toMatchObject({ work_date_policy: "shift_start" });
  });

  it("changes what the runtime attributes the next punch to, and nothing already recorded",
    async () => {
      const hr = appUi(`acct-admin-policy-runtime-${seq}`, true);
      const crew = await employee("Runtime Crew");
      // 22:00 JST on 2026-07-03, and 06:00 JST the next morning.
      const tenPm = Date.parse("2026-07-03T13:00:00Z");
      const sixAm = Date.parse("2026-07-03T21:00:00Z");

      await store.recordPunch({
        employeeId: crew, workDate: await store.workDateFor(crew, tenPm, "in"), kind: "in",
        now: tenPm, source: "gadget",
      });
      // On `calendar`, the clock-out is dated by the clock: a different day.
      expect(await store.workDateFor(crew, sixAm, "out")).toBe("2026-07-04");

      await hr.setWorkDatePolicy(crew, "shift_start");

      // The SAME open shift now attracts the clock-out onto its own start date...
      expect(await store.workDateFor(crew, sixAm, "out")).toBe("2026-07-03");
      // ...and the punch already recorded did not move.
      expect((await store.currentPunches(crew, "2026-07-03")).map((p) => p.kind)).toEqual(["in"]);
    });

  it("can be set back to calendar", async () => {
    const hr = appUi(`acct-admin-policy-back-${seq}`, true);
    const crew = await employee("Reverting Crew");

    await hr.setWorkDatePolicy(crew, "shift_start");
    await hr.setWorkDatePolicy(crew, "calendar");

    expect((await hr.listEmployees()).find((row: { id: number }) => row.id === crew))
      .toMatchObject({ work_date_policy: "calendar" });
  });

  // Refused by `@validateRpc()`, not by a check in the method body: the policy is a string-literal
  // union, so the decorator is what enforces it and a hand-written check would be a second opinion
  // that could drift from the type. Pinned here because "the decorator covers it" is a claim.
  it("refuses a policy that is not one of the two", async () => {
    const hr = appUi(`acct-admin-policy-junk-${seq}`, true);
    const crew = await employee("Junk Crew");

    await expect(() => hr.setWorkDatePolicy(crew, "whenever"))
      .rejects.toThrow(/capnweb-validate.*setWorkDatePolicy\[1\]: expected union/);
    // Refused before the write: the record is untouched.
    expect((await hr.listEmployees()).find((row: { id: number }) => row.id === crew))
      .toMatchObject({ work_date_policy: "calendar" });
  });

  it("refuses an employee who does not exist", async () => {
    await expect(() =>
      appUi(`acct-admin-policy-ghost-${seq}`, true).setWorkDatePolicy(999_999, "shift_start"))
      .rejects.toThrow(/KINTAI_NOT_FOUND/);
  });

  // Which day a punch is filed against decides what a night worker's hours are worth. An employee
  // who could set it for themselves could move their own overnight hours onto another day — so it
  // is not on the employee capability at all.
  it("is not on a non-administrator's capability", async () => {
    const crew = await employee("Self Crew");

    await expect(() =>
      appUi(`acct-nonadmin-policy-${seq}`, false).setWorkDatePolicy(crew, "shift_start"))
      .rejects.toThrow(/does not implement the method/);
    expect((await store.listEmployees()).find((row) => row.id === crew))
      .toMatchObject({ work_date_policy: "calendar" });
  });
});

describe("the attendance an admin can now read", () => {
  // The four reads are unit-tested at store level in `overview.test.ts`; what is asserted here is
  // that the ADMIN CAPABILITY reaches them and hands back what was actually seeded — the boundary,
  // not the composition. Each test asks about its own month, for the reason `attendance` explains.
  it("lists the flagged days of a month, with the flags themselves", async () => {
    const hr = appUi(`acct-admin-flags-${seq}`, true);
    const { worker, flaggedDay } = await attendance("flags", "2026-03");

    const days = await hr.listAnomalousDays("2026-03");

    expect(days.filter((row: { employeeId: number }) => row.employeeId === worker)).toEqual([
      expect.objectContaining({
        employeeId: worker, workDate: flaggedDay, anomalies: ["unpaired_in"],
        displayName: "flags-worker",
      }),
    ]);
  });

  it("reports the month per employee, and whether it is closed", async () => {
    const hr = appUi(`acct-admin-month-${seq}`, true);
    const { worker } = await attendance("month", "2026-04");

    const report = await hr.monthlyReport("2026-04");

    expect(report).toMatchObject({ period: "2026-04", locked: false });
    expect(report.rows.find((row: { employeeId: number }) => row.employeeId === worker))
      .toMatchObject({
        employeeNumber: `month-worker-a${seq}`, daysWorked: 2, workedMinutes: 480,
        anomalousDays: 1,
      });
  });

  // The punch-level read, and the whole reason the interface header now carries a paragraph about
  // what this capability sees: one named person's clock times on one named day.
  it("shows one employee's day: the punches, the flags and the credited minutes", async () => {
    const hr = appUi(`acct-admin-day-${seq}`, true);
    const { worker, day, flaggedDay, nine } = await attendance("day", "2026-05");

    const worked = await hr.getEmployeeDay(worker, day);
    expect(worked.punches.map((punch: { kind: string }) => punch.kind)).toEqual(["in", "out"]);
    expect(worked.punches[0].occurred_at).toBe(nine);
    expect(worked.anomalies).toEqual([]);
    expect(worked.workedMinutes).toBe(480);

    const flagged = await hr.getEmployeeDay(worker, flaggedDay);
    expect(flagged.anomalies).toEqual(["unpaired_in"]);
    expect(flagged.workedMinutes).toBe(0);
  });

  // The one read no other surface can answer: `pendingApprovalsFor` shows an approver what they
  // may act on, and a request nobody may act on appears in nobody's queue.
  it("lists every waiting request, naming who could decide it", async () => {
    const hr = appUi(`acct-admin-pending-${seq}`, true);
    const { boss, overtimeId, correctionId } = await attendance("pending", "2026-07");

    const items = await hr.listPendingOverview();

    const overtime = items.find((item: { id: number }) => item.id === overtimeId);
    expect(overtime).toMatchObject({
      kind: "overtime", state: "pending", minutes: 120, employeeName: "pending-worker",
      filedByName: null, eligibleActorIds: [boss], eligibleActorNames: ["pending-boss"],
    });
    expect(items.find((item: { id: number }) => item.id === correctionId)).toMatchObject({
      kind: "amendment", filedByName: "pending-worker", eligibleActorIds: [boss],
    });
  });

  // `assertPeriod` at the boundary, on all three members that take one. `anomalousDays` and
  // `monthlyTotals` assert it again inside the store (the same imported function, not a second
  // copy); `lockPeriod` does not, so for that one this boundary is the only thing standing between
  // a typo and a lock row nothing could ever match.
  it.each(["2026-13", "2026-1", "banana", "", "2026-00", "2026-07-03"])(
    "refuses %o as a period", async (period) => {
      const hr = appUi(`acct-admin-badperiod-${seq}`, true);

      await expect(() => hr.listAnomalousDays(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => hr.monthlyReport(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => hr.lockPeriod(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    },
  );

  // The store's `employeeDay` takes its work date on trust, exactly as its neighbours do, because
  // every worker-side caller has already derived it. This is the surface untrusted input reaches,
  // so it is where the date is checked — `assertWorkDate`, the same one the session facet applies
  // to every other date in this package. "2026-02-31" is the case a regex alone accepts and
  // `Date.parse` rolls silently into March.
  it.each(["2026-02-31", "2026-13-01", "01/04/2026", "2026-4-1", "2026-07", ""])(
    "refuses %o as a work date", async (workDate) => {
      const hr = appUi(`acct-admin-badday-${seq}`, true);

      await expect(() => hr.getEmployeeDay(1, workDate)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    },
  );

  it.each([0, -1, 1.5])("refuses %o as an employee id", async (employeeId) => {
    const hr = appUi(`acct-admin-badid-${seq}`, true);

    await expect(() => hr.getEmployeeDay(employeeId, "2026-07-03"))
      .rejects.toThrow(/KINTAI_INVALID_INPUT/);
  });
});

// EVERY MONTH CLOSED IN THIS FILE IS A 2025 MONTH, and that is not decoration. This file shares
// one store, there is no unlock, and the end-to-end at the bottom has to close the LIVE month —
// the only one an ordinary punch can land in. A test that closed a fixed 2026 month would
// therefore be a time bomb: run the suite in that month and the end-to-end finds it already
// closed and fails on `KINTAI_ALREADY_LOCKED`. A month in the past can never be the live one.
// (The attendance seeds below stay in 2026; nothing closes those.)
describe("closing a month", () => {
  /** An admin whose own account is linked, which closing a month requires. */
  async function closer(tag: string) {
    const adminEmployee = await employee(tag);
    const adminAccount = `acct-${tag}-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());
    return { adminEmployee, hr: appUi(adminAccount, true) };
  }

  async function lockEntries(period: string) {
    return (await store.auditEntries()).filter((row) =>
      row.action === "lock_period" && (row.after ?? "").includes(`"${period}"`));
  }

  // `lockPeriod` was the fourth confirmed instance of implemented-but-unreachable: the store has
  // had it since the beginning and nothing outside the worker could call it, so no month could
  // ever be closed and `setAllocations` — the one write with no approval behind it — could rewrite
  // a paid month indefinitely.
  it("writes the lock, with the acting admin as the one who closed it", async () => {
    const { adminEmployee, hr } = await closer("Closer");
    const before = Date.now();

    expect(await hr.lockPeriod("2025-01")).toBeUndefined();

    const lock = await store.periodLock("2025-01");
    expect(lock).toMatchObject({ lockedBy: adminEmployee });
    expect(lock!.lockedAt).toBeGreaterThanOrEqual(before);
    // And the report says so, from the same table rather than from a second opinion.
    expect(await hr.monthlyReport("2025-01")).toMatchObject({ locked: true });
  });

  // Who closed a month is the first question asked of a closed month, and it is taken from the
  // admin's own capability — there is no argument that could credit somebody else.
  it("audits the close, recording that the period was open before", async () => {
    const { adminEmployee, hr } = await closer("Auditing Closer");
    const before = Date.now();

    await hr.lockPeriod("2025-02");

    const [entry] = await lockEntries("2025-02");
    expect(entry).toMatchObject({ entity: "period_locks", actor_employee_id: adminEmployee });
    // `period_locks` is keyed on the period, which is TEXT; `audit_log.entity_id` is an INTEGER,
    // so the period travels in before/after and this column stays null rather than carrying a
    // number that would join back to the wrong table.
    expect(entry.entity_id).toBeNull();
    expect(JSON.parse(entry.before!)).toEqual({ period: "2025-02", locked: false });
    expect(JSON.parse(entry.after!)).toMatchObject({
      period: "2025-02", lockedBy: adminEmployee,
    });
    expect(JSON.parse(entry.after!).lockedAt).toBeGreaterThanOrEqual(before);
  });

  // An admin double-clicks the button, or works from a screen a colleague has already acted on.
  // They are told it is already done — NOT `PeriodLockedError`'s "file an amendment", which is an
  // instruction to correct a record they never meant to touch.
  it("refuses a second close, and keeps the first one intact", async () => {
    const { adminEmployee, hr } = await closer("Double Closer");
    await hr.lockPeriod("2025-08");
    const first = await store.periodLock("2025-08");
    const { hr: other } = await closer("Late Closer");

    const refusal: Error = await other.lockPeriod("2025-08").catch((error: Error) => error);

    // The period, who closed it and when: enough for the admin to see whether it was them a
    // moment ago or a colleague last week.
    expect(refusal.message).toMatch(/KINTAI_ALREADY_LOCKED/);
    expect(refusal.message).toContain("2025-08");
    expect(refusal.message).toContain(`employee ${adminEmployee}`);
    expect(refusal.message).toContain(jstWorkDate(first!.lockedAt));
    // And NOT `PeriodLockedError`'s instruction, which is written for whoever tried to write into
    // a closed month: telling this caller to file an amendment would send them to correct a record
    // they never meant to touch.
    expect(refusal.message).not.toContain("amendment");

    // Nothing written: the row still names the first admin and the first instant, and the refused
    // calls left no audit entry claiming a second close happened.
    expect(await store.periodLock("2025-08")).toEqual(first);
    expect(await lockEntries("2025-08")).toHaveLength(1);
  });

  // `period_locks.locked_by` is NOT NULL, so there is no honest row to write for an admin who has
  // no employee record of their own — a real state, and the first administrator's normal one. The
  // refusal names the fix, which is theirs to make: they are HR.
  it("refuses an admin with no employee record, naming the fix", async () => {
    const hr = appUi(`acct-admin-nolink-${seq}`, true);

    await expect(() => hr.lockPeriod("2025-09"))
      .rejects.toThrow(/KINTAI_ADMIN_NOT_LINKED/);
    await expect(() => hr.lockPeriod("2025-09")).rejects.toThrow(/whoAmI/);
    // Refused before anything was written, audit entry included.
    expect(await store.periodLock("2025-09")).toBeNull();
    expect(await lockEntries("2025-09")).toEqual([]);
  });

  /**
   * The month names here are COMPUTED, not written down, because "in the future" is relative to
   * the wall clock — which is also why this is the one lock test that cannot use a fixed 2025
   * month. The scenario is HR closing 2026-08 on the last day of the month and typing 2027-08:
   * the confirmation says closed, and nobody notices until August 2027, when every punch in the
   * company is refused and there is no unlock.
   */
  it("refuses a month that has not happened yet, naming the month given and the current one",
    async () => {
      const { hr } = await closer("Mistyping Closer");
      const current = jstWorkDate(Date.now()).slice(0, 7);
      const year = Number(current.slice(0, 4));
      const month = Number(current.slice(5));
      // Both shapes worth refusing: the month after this one — the nearest thing to a legitimate
      // request, and the boundary of the rule — and the mistyped year, which is the real accident.
      const nextMonth = month === 12
        ? `${year + 1}-01`
        : `${year}-${String(month + 1).padStart(2, "0")}`;
      const mistypedYear = `${year + 1}-${current.slice(5)}`;

      for (const period of [nextMonth, mistypedYear]) {
        const refusal: Error = await hr.lockPeriod(period).catch((error: Error) => error);

        expect(refusal.message, period).toMatch(/KINTAI_FUTURE_PERIOD/);
        expect(refusal.message, period).toContain(period);
        expect(refusal.message, period).toContain(current);
        // Nothing written, either half: no lock row, and no audit entry claiming a close.
        expect(await store.periodLock(period), period).toBeNull();
        expect(await lockEntries(period), period).toEqual([]);
      }
    });

  it("writes nothing for a malformed period", async () => {
    const { hr } = await closer("Typing Closer");

    await expect(() => hr.lockPeriod("2026-13")).rejects.toThrow(/KINTAI_INVALID_INPUT/);

    expect(await store.periodLock("2026-13")).toBeNull();
    expect(await lockEntries("2026-13")).toEqual([]);
  });

  // Closing a month is the write that makes every punch in it final. Reachable by an employee, it
  // would be a way to freeze a month before a colleague's correction could be filed against it —
  // so it is not on the employee capability at all.
  it("is not on a non-administrator's capability", async () => {
    await expect(() => appUi(`acct-nonadmin-lock-${seq}`, false).lockPeriod("2025-10"))
      .rejects.toThrow(/does not implement the method/);

    expect(await store.periodLock("2025-10")).toBeNull();
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

  // `audit.ts` names exemptions among the authority-relevant changes it exists to record, and
  // until now nothing wrote one. 管理監督者 decides whether an employee's overtime bears a premium
  // at all, so who recorded it, and which period, is what an inspection asks for.
  it("records who recorded a 管理監督者 exemption, naming the period it opened", async () => {
    const adminEmployee = await employee("Determiner");
    const adminAccount = `acct-audit-exempt-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());
    const officer = await employee("Audited Officer");

    await appUi(adminAccount, true).grantExemption(officer);

    const entries = (await store.auditEntries())
      .filter((row) => row.action === "grant_exemption");
    const entry = entries.at(-1)!;
    expect(entry).toMatchObject({ entity: "exemption_periods", actor_employee_id: adminEmployee });
    // entity_id is the exemption_periods row itself, so the entry joins back to the determination.
    expect(entry.entity_id).toEqual(expect.any(Number));
    expect(JSON.parse(entry.after!))
      .toMatchObject({ employeeId: officer, kind: "kanri_kantokusha" });
  });

  // The setting is not retroactive, so "what was it before, and from when" is the only way to
  // tell which of an employee's existing punches were filed under a different rule.
  it("records who changed a work-date policy, and what it was before", async () => {
    const adminEmployee = await employee("Policy Setter");
    const adminAccount = `acct-audit-policy-${seq}`;
    await store.linkAccount(adminAccount, adminEmployee, Date.now());
    const crew = await employee("Audited Crew");

    await appUi(adminAccount, true).setWorkDatePolicy(crew, "shift_start");

    const [entry] = await entriesFor("set_work_date_policy", crew);
    expect(entry).toMatchObject({ entity: "employees", actor_employee_id: adminEmployee });
    expect(JSON.parse(entry.before!)).toEqual({ employeeId: crew, workDatePolicy: "calendar" });
    expect(JSON.parse(entry.after!)).toEqual({ employeeId: crew, workDatePolicy: "shift_start" });
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

// MUST BE LAST IN THIS FILE. `punch()` derives its work date from the wall clock, so the only
// month an ordinary punch can land in is the live one — and there is no unlock anywhere in this
// package, so closing it closes it for every test that runs afterwards. Same constraint, same
// placement, and the same comment as "period locks close the live period, irreversibly" in
// `facet.test.ts`, which is the store-level version of this.
//
// This is the end-to-end that yesterday's live verification could not drive, because nothing could
// close a month: the admin API closes one, and then the four things that must follow are checked
// through the real facet and the real store rather than asserted about the lock row.
describe("closing the live month, end to end", () => {
  it("refuses the next punch, still admits an approved correction, and says so on both reads",
    async () => {
      const adminAccount = `acct-e2e-hr-${seq}`;
      await store.linkAccount(adminAccount, await employee("E2E HR"), Date.now());
      const hr = appUi(adminAccount, true);

      const worker = await employee("E2E Worker");
      const boss = await employee("E2E Boss");
      const workerAccount = `acct-e2e-worker-${seq}`;
      await store.linkAccount(workerAccount, worker, Date.now());
      await store.setReportingLine(worker, boss, 0);

      // The live month, because that is the one an ordinary punch attributes itself to.
      const workDate = jstWorkDate(Date.now());
      const period = workDate.slice(0, 7);
      const nine = Date.parse(`${workDate}T00:00:00Z`);
      await store.recordPunch({
        employeeId: worker, workDate, kind: "in", now: nine, source: "gadget",
      });
      const outId = await store.recordPunch({
        employeeId: worker, workDate, kind: "out", now: nine + 8 * 3_600_000, source: "gadget",
      });
      expect(await hr.monthlyReport(period)).toMatchObject({ locked: false });

      await hr.lockPeriod(period);

      // (a) An ordinary punch, through the session a Gadget actually holds, is refused.
      await expect(() => sessionFor(workerAccount).punch("in"))
        .rejects.toThrow(/KINTAI_PERIOD_LOCKED/);

      // (d) A correction filed against the closed month names the month it would write into —
      // the one thing an approver most needs told and is least able to infer.
      const correctionId = await store.fileAmendment({
        employeeId: worker, targetPunchId: outId, occurredAt: nine + 9 * 3_600_000,
        reason: "left at six; the terminal was tapped when clocking out at five",
        now: nine + 10 * 3_600_000, department: null, employmentType: null, createdBy: worker,
      });
      const waiting = (await hr.listPendingOverview())
        .find((item: { id: number }) => item.id === correctionId)!;
      expect(waiting.amendment).toMatchObject({ lockedPeriod: period, targetPunchId: outId });
      expect(waiting.eligibleActorIds).toEqual([boss]);

      // (b) Approved, it applies anyway: the one write a closed period admits.
      expect(await store.actOnSubmission({
        submissionId: correctionId, actorId: boss, action: "approve", now: nine + 11 * 3_600_000,
      })).toBe("approved");

      // (c) The month still reads closed, and its total moved regardless. Closed is not frozen,
      // and there is no stored aggregate for a stale number to hide in.
      const after = await hr.monthlyReport(period);
      expect(after.locked).toBe(true);
      expect(after.rows.find((row: { employeeId: number }) => row.employeeId === worker))
        .toMatchObject({ workedMinutes: 540 });
    });
});
