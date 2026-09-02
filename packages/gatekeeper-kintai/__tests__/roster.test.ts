import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The HR roster, which is `employees` composed with the account links and the org graph.
//
// The property every test here is really about: `approverReachable` must be the SAME verdict
// `submitOvertime` will reach through `assertApproverReachable`. A roster that said otherwise
// would let HR finish onboarding, see a row that looks complete, and hand the employee a system
// that refuses them the first time they file — which is the failure this column exists to prevent.

const APR = Date.parse("2026-04-01T00:00:00Z");
const JUL = Date.parse("2026-07-01T00:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`roster-${seq++}`);
});

async function employee(number: string) {
  return store.createEmployee({
    employeeNumber: number, displayName: number, joinedOn: "2026-04-01",
  });
}

async function entry(employeeId: number, at: number) {
  const row = (await store.listRoster(at)).find((candidate) => candidate.id === employeeId);
  if (!row) throw new Error(`employee ${employeeId} is missing from the roster`);
  return row;
}

describe("the roster", () => {
  it("carries the employee record itself, unrenamed", async () => {
    const id = await store.createEmployee({
      employeeNumber: "E001", displayName: "Tanaka", department: "Sales",
      employmentType: "seishain", joinedOn: "2026-04-01",
    });

    expect(await entry(id, JUL)).toMatchObject({
      id, employee_number: "E001", display_name: "Tanaka", department: "Sales",
      employment_type: "seishain", status: "active", joined_on: "2026-04-01", departed_on: null,
    });
  });

  it("shows a brand new employee as neither linked nor able to file", async () => {
    const id = await employee("E010");

    expect(await entry(id, JUL)).toMatchObject({
      linked: false, managerIds: [], exempt: false, approverReachable: false,
    });
  });

  // The whole point of the column. HR creates the record, links the account, and would reasonably
  // believe onboarding is finished -- but `submitOvertime` will refuse this employee, because
  // nobody can approve for them.
  it("shows a linked employee with nobody to approve for them as still incomplete", async () => {
    const id = await employee("E020");
    await store.linkAccount("acct-e020", id, APR);

    expect(await entry(id, JUL)).toMatchObject({ linked: true, approverReachable: false });
    // And the runtime agrees, which is the assertion that makes the column worth trusting.
    await expect(() => store.assertApproverReachable(id, JUL)).rejects.toThrow(/KINTAI_NO_APPROVER/);
  });

  it("completes the employee once a reporting line exists", async () => {
    const worker = await employee("E030");
    const boss = await employee("E031");
    await store.linkAccount("acct-e030", worker, APR);
    await store.setReportingLine(worker, boss, APR);

    expect(await entry(worker, JUL)).toMatchObject({
      linked: true, managerIds: [boss], approverReachable: true,
    });
    await store.assertApproverReachable(worker, JUL);
  });

  // An exemption is not an approver, and the roster is where HR finds that out. It exempts the
  // employee's overtime from a premium -- `submitOvertime` refuses them, so there is nothing to
  // approve there -- but a correction to their punches is still a request that needs a human, and
  // for a 代表取締役 that is exactly the record most worth a second pair of eyes. Reported exempt
  // AND not ready, which is the truth: the determination is recorded, the row is not finished.
  it("does not complete a 管理監督者 who reports to nobody", async () => {
    const id = await employee("E040");
    await store.grantExemption(id, APR);

    expect(await entry(id, JUL))
      .toMatchObject({ managerIds: [], exempt: true, approverReachable: false });
    await expect(() => store.assertApproverReachable(id, JUL)).rejects.toThrow(/KINTAI_NO_APPROVER/);
  });

  // What actually completes the root of the org chart. Same row, same instant, one designated
  // approver later.
  it("completes that same 管理監督者 once they are given a designated approver", async () => {
    const id = await employee("E041");
    const chair = await employee("E042");
    await store.grantExemption(id, APR);
    await store.setDesignatedApprover(id, chair);

    expect(await entry(id, JUL)).toMatchObject({
      managerIds: [], exempt: true, designated_approver_id: chair, approverReachable: true,
    });
    await store.assertApproverReachable(id, JUL);
  });

  it("completes an employee whose only route is a designated approver", async () => {
    const approver = await employee("E050");
    const id = await store.createEmployee({
      employeeNumber: "E051", displayName: "Rooted", designatedApproverId: approver,
      joinedOn: "2026-04-01",
    });

    expect(await entry(id, JUL)).toMatchObject({
      managerIds: [], exempt: false, designated_approver_id: approver, approverReachable: true,
    });
  });

  // Three shapes that look like an org chart but authorise nobody. Each is a way HR could believe
  // the employee is set up; the roster has to disagree, and for the same reasons
  // `hasReachableApprover` disagrees -- see its comment.
  it("counts neither a delegate, a self-edge, nor an expired line as an approver", async () => {
    const worker = await employee("E060");
    const other = await employee("E061");
    const past = await employee("E062");
    const selfy = await employee("E063");
    const expired = await employee("E064");

    // A live delegate can sign one event but never satisfies an `all_of` step's requirement.
    await store.setDelegate(worker, other, APR, OCT);
    // A reporting line that has already closed.
    await store.setReportingLine(past, other, APR, JUL);
    // An employee recorded as their own manager: self-approval is forbidden outright.
    await store.setReportingLine(selfy, selfy, APR);
    // A line that has not opened yet.
    await store.setReportingLine(expired, other, OCT);

    for (const id of [worker, past, selfy, expired]) {
      expect(await entry(id, JUL)).toMatchObject({ managerIds: [], approverReachable: false });
    }
  });

  it("stops showing an employee as linked once their account is revoked", async () => {
    const id = await employee("E070");
    await store.linkAccount("acct-e070", id, APR);
    await store.unlinkAccount("acct-e070", JUL);

    expect(await entry(id, JUL - 1)).toMatchObject({ linked: true });
    expect(await entry(id, OCT)).toMatchObject({ linked: false });
  });

  // Re-linking is how an email change is handled: the employee keeps one open link throughout, and
  // the roster must not count the closed one.
  it("shows an employee linked exactly once across an account change", async () => {
    const id = await employee("E080");
    await store.linkAccount("acct-old", id, APR);
    await store.linkAccount("acct-new", id, JUL);

    const rows = (await store.listRoster(OCT)).filter((row) => row.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ linked: true });
  });

  // "linked" on the roster and `linked` in the employee's own `whoAmI` are the same question, and
  // `LINK_IN_FORCE` is shared so they cannot answer it differently.
  it("agrees with resolveAccount about who is linked, at every instant", async () => {
    const id = await employee("E090");
    await store.linkAccount("acct-e090", id, JUL);

    for (const at of [APR, JUL - 1, JUL, JUL + 1, OCT]) {
      const resolved = await store.resolveAccount("acct-e090", at);
      expect((await entry(id, at)).linked, `at ${at}`).toBe(resolved !== null);
    }
  });
});
