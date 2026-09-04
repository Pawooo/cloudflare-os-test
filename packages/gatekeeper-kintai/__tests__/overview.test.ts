import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The admin dashboard's three plain reads, at store level. Every rule they report on is asserted
// elsewhere -- `dayAnomalies`, `workedMinutes` and `periodLock` in their own test files -- so what
// is tested here is only the composition: which days get counted, how they roll up per employee,
// and that a lock on the period reports itself honestly without freezing the numbers beside it.

const DAY = "2026-07-03";
const NINE = Date.parse("2026-07-03T00:00:00Z"); // 09:00 JST

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;
let worker: number;

beforeEach(async () => {
  store = env.KINTAI_STORE.getByName(`overview-${seq++}`);
  worker = await store.createEmployee({
    employeeNumber: "W1", displayName: "Yamada", joinedOn: "2026-04-01",
  });
});

describe("anomalousDays", () => {
  it("lists exactly the days whose anomaly list is non-empty, with the flags", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    // no out: unpaired_in
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000,
      source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "out",
      now: NINE + 86_400_000 + 8 * 3_600_000, source: "gadget",
    });

    const days = await store.anomalousDays("2026-07");
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      employeeId: worker, displayName: "Yamada", employeeNumber: "W1",
      workDate: DAY, anomalies: ["unpaired_in"],
    });
  });

  it("is bounded to the month it was asked about", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: "2026-06-30", kind: "in", now: NINE - 3 * 86_400_000,
      source: "gadget",
    });
    expect(await store.anomalousDays("2026-07")).toHaveLength(0);
  });
});

describe("monthlyTotals", () => {
  it("sums each employee's month and counts their anomalous days", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "out", now: NINE + 8 * 3_600_000, source: "gadget",
    });
    await store.recordPunch({
      employeeId: worker, workDate: "2026-07-04", kind: "in", now: NINE + 86_400_000,
      source: "gadget",
    });
    // day 2 unpaired

    const report = await store.monthlyTotals("2026-07");
    expect(report.period).toBe("2026-07");
    expect(report.locked).toBe(false);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      employeeId: worker, daysWorked: 2, workedMinutes: 480, anomalousDays: 1,
    });
  });

  it("carries the lock, and a total that an approved correction can still change", async () => {
    // "Closed ≠ frozen": a locked month refuses ordinary writes but still admits an approved
    // amendment, and the very next read of `monthlyTotals` has to show what that amendment wrote --
    // there is no stored aggregate to have gone stale. Setup needs a manager (to approve) and a
    // route scoped to a department: an unscoped route ties the seeded catch-all on specificity and
    // `selectRoute` keeps the lower id, which is the seed -- so an unscoped test route would
    // silently exercise the seed instead of itself. Scoping to DEPT, and naming DEPT when filing,
    // is what makes this test's own route the one that actually resolves.
    const DEPT = "OVERVIEW-DEPT";
    const manager = await store.createEmployee({
      employeeNumber: "M1", displayName: "Sato", joinedOn: "2026-04-01",
    });
    const employeeId = await store.createEmployee({
      employeeNumber: "W2", displayName: "Suzuki", joinedOn: "2026-04-01", department: DEPT,
    });
    await store.setReportingLine(employeeId, manager, 0);
    await store.createRoute({
      name: `overview-route-${seq}`,
      department: DEPT,
      steps: [{ rule: "any_of", approverKind: "manager", approverEmployeeId: null }],
    });

    await store.recordPunch({
      employeeId, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const outId = await store.recordPunch({
      employeeId, workDate: DAY, kind: "out", now: NINE + 8 * 3_600_000, source: "gadget",
    });

    await store.lockPeriod("2026-07", manager, NINE + 20 * 3_600_000);

    const before = await store.monthlyTotals("2026-07");
    expect(before.locked).toBe(true);
    expect(before.rows.find((row: { employeeId: number }) => row.employeeId === employeeId))
      .toMatchObject({ workedMinutes: 480 });

    // The lock refuses an ordinary write against this period...
    await expect(() => store.assertWritable(DAY)).rejects.toThrow(/KINTAI_PERIOD_LOCKED/);

    // ...but a correction, filed and approved, still applies -- the one write the lock never sees.
    const submissionId = await store.fileAmendment({
      employeeId, targetPunchId: outId, occurredAt: NINE + 9 * 3_600_000,
      reason: "left at six; the terminal was tapped when clocking out at five",
      now: NINE + 21 * 3_600_000, department: DEPT, employmentType: null, createdBy: employeeId,
    });
    const state = await store.actOnSubmission({
      submissionId, actorId: manager, action: "approve", now: NINE + 22 * 3_600_000,
    });
    expect(state).toBe("approved");

    const after = await store.monthlyTotals("2026-07");
    expect(after.locked).toBe(true);
    expect(after.rows.find((row: { employeeId: number }) => row.employeeId === employeeId))
      .toMatchObject({ workedMinutes: 540 });
  });
});

describe("employeeDay", () => {
  it("returns the current punches, the flags and the credited minutes of one day", async () => {
    await store.recordPunch({
      employeeId: worker, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const day = await store.employeeDay(worker, DAY);
    expect(day.punches).toHaveLength(1);
    expect(day.anomalies).toEqual(["unpaired_in"]);
    expect(day.workedMinutes).toBe(0);
  });
});

describe("assertPeriod at the boundary", () => {
  // `assertPeriod` has no unit-test file of its own -- `assertWorkDate`, its sibling in
  // `input.ts`, has none either; both are exercised only through the callers that reach them
  // (`facet.test.ts`'s "input validation at the boundary", `admin-api.test.ts`'s date tests). This
  // is the equivalent for `assertPeriod`: it is reached here through the readers that call it,
  // `anomalousDays` and `monthlyTotals`, rather than imported and called directly.
  it.each(["2026-13", "2026-1", "banana", "", "2026-00"])(
    "refuses %o as a period", async (period) => {
      await expect(() => store.anomalousDays(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
      await expect(() => store.monthlyTotals(period)).rejects.toThrow(/KINTAI_INVALID_INPUT/);
    },
  );

  it("accepts a real calendar month", async () => {
    await expect(store.anomalousDays("2026-07")).resolves.toEqual([]);
    await expect(store.monthlyTotals("2026-07"))
      .resolves.toMatchObject({ period: "2026-07", locked: false, rows: [] });
  });
});

/**
 * The fourth read, and the only one that answers a question about AUTHORITY rather than about
 * punches: who can decide each pending request right now.
 *
 * Everything asserted here about who may act is asserted against `previewActOnSubmission`, never
 * against a hand-written expectation of the org rules. That is the whole point of the middle test:
 * `eligibleActors` is `checkMayAct` probed once per candidate, so the only property worth holding
 * is that the two agree over every pair -- the same shape, and for the same reason, as "the queue
 * lists exactly what the act check accepts" in `submissions.test.ts`. The fixed expectations in
 * the first and third tests are there to prove the matrix is not vacuously true (a set that was
 * always empty would satisfy the property if the act check refused everything too).
 */
describe("pendingOverview", () => {
  const DASH_DEPT = "DASH-DEPT";
  /** An hour after the punch: when every request below is filed. */
  const FILED = NINE + 3_600_000;
  /** Two hours after that: when the dashboard is read. Every `waitingMs` is this gap. */
  const READ = FILED + 7_200_000;

  let boss: number;
  let director: number;
  let staff: number;
  let chief: number;
  let both: number;
  let outsider: number;

  /**
   * The org shapes that make the act check answer differently, all in one store: a plain reporting
   * line, a step pinned to a named employee, a root employee reachable only through the designated
   * approver, somebody who has BOTH a manager and a designated approver (where the fallback must
   * NOT apply -- the shape that shipped a real bug once), and somebody with authority over nobody.
   *
   * The route is scoped to `DASH_DEPT` and every filing names `DASH_DEPT`: an unscoped route ties
   * the seeded catch-all on specificity and `selectRoute` keeps the lower id, which is the seed --
   * so an unscoped test route would silently exercise the seed instead of this one.
   */
  async function seedCast() {
    director = await store.createEmployee({
      employeeNumber: "D-DASH", displayName: "Tanaka", joinedOn: "2026-04-01",
    });
    boss = await store.createEmployee({
      employeeNumber: "M-DASH", displayName: "Sato", joinedOn: "2026-04-01",
    });
    staff = await store.createEmployee({
      employeeNumber: "W-DASH", displayName: "Suzuki", joinedOn: "2026-04-01",
      department: DASH_DEPT,
    });
    chief = await store.createEmployee({
      employeeNumber: "C-DASH", displayName: "Chief", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    both = await store.createEmployee({
      employeeNumber: "BO-DASH", displayName: "Both", joinedOn: "2026-04-01",
      designatedApproverId: director,
    });
    outsider = await store.createEmployee({
      employeeNumber: "O-DASH", displayName: "Outsider", joinedOn: "2026-04-01",
    });
    await store.setReportingLine(boss, director, NINE - 86_400_000);
    await store.setReportingLine(staff, boss, NINE - 86_400_000);
    await store.setReportingLine(both, boss, NINE - 86_400_000);
    await store.setReportingLine(outsider, boss, NINE - 86_400_000);
    await store.createRoute({
      name: `dash-route-${seq}`,
      department: DASH_DEPT,
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
      ],
    });
  }

  async function fileOvertime(
    employeeId: number, minutes: number, createdBy?: number,
  ): Promise<number> {
    return store.submitOvertime({
      employeeId, requestedFor: DAY, minutes, reason: "site overrun", now: FILED,
      department: DASH_DEPT, employmentType: null, createdBy,
    });
  }

  it("names the employee, the filer, the wait and the amendment's own detail", async () => {
    await seedCast();
    const overtimeId = await fileOvertime(staff, 120);
    const punchId = await store.recordPunch({
      employeeId: staff, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const amendmentId = await store.fileAmendment({
      employeeId: staff, targetPunchId: punchId, occurredAt: NINE - 1_800_000,
      reason: "started early on site", now: FILED,
      department: DASH_DEPT, employmentType: null, createdBy: staff,
    });

    const items = await store.pendingOverview(READ);
    // Both rows, in the queue's own order -- nothing filtered by who happens to be reading.
    expect(items.map((item: { id: number }) => item.id)).toEqual([overtimeId, amendmentId]);

    const overtime = items.find((item: { id: number }) => item.id === overtimeId)!;
    expect(overtime).toMatchObject({
      employee_id: staff, kind: "overtime", state: "pending", minutes: 120,
      employeeName: "Suzuki", employeeNumber: "W-DASH",
      // `submitOvertime` was called without `createdBy`, so no filer was captured. Null means
      // "nobody recorded", which is not the same as "the employee" -- see `FiledBySelfError`.
      filedByName: null,
      waitingMs: READ - FILED,
      eligibleActorIds: [boss], eligibleActorNames: ["Sato"],
    });
    // Absent, not empty, exactly as on the queue rows: absence is the discriminator, and a branch
    // on `item.amendment` must not be fooled by an overtime row carrying a hollow one.
    expect(overtime.amendment).toBeUndefined();

    const amendment = items.find((item: { id: number }) => item.id === amendmentId)!;
    expect(amendment).toMatchObject({
      kind: "amendment", employeeName: "Suzuki", filedByName: "Suzuki",
      waitingMs: READ - FILED, eligibleActorIds: [boss], eligibleActorNames: ["Sato"],
    });
    // The SAME detail the approver's own queue shows, field for field. One assembler, one query
    // shape: a dashboard that summarised a correction differently from the queue an approver acts
    // in would be two answers about one request.
    const queued = (await store.pendingApprovalsFor(boss, READ))
      .find((row: { id: number }) => row.id === amendmentId)!;
    expect(amendment.amendment).toEqual(queued.amendment);
    expect(amendment.amendment).toMatchObject({
      targetPunchId: punchId, currentOccurredAt: NINE,
      requestedOccurredAt: NINE - 1_800_000, workDate: DAY, kind: "in", lockedPeriod: null,
    });
  });

  it("holds an employee for a row exactly when the act check would let them act", async () => {
    /**
     * The refusals that mean "not this person, not this one, not now" -- the only errors that may
     * read as "no". Anything else is a real failure and must reach the test rather than be counted
     * as a refusal: an eligible set that was empty because every probe threw would otherwise pass
     * this file.
     *
     * Three, where the queue's own property test lists four. `KINTAI_INVALID_TRANSITION` cannot be
     * reached from here -- `pendingOverview` feeds only `pending` ids -- and `eligibleActors`
     * still catches it, because it reuses `isQueueRefusal` rather than trimming the list to what
     * today's caller can provoke. The assertion at the end of this test is over what is reachable,
     * not over what is caught.
     */
    const REFUSALS = [
      "KINTAI_SELF_APPROVAL", "KINTAI_FILED_BY_APPROVER", "KINTAI_NOT_AUTHORIZED",
    ];
    const seen = new Set<string>();

    /**
     * Does the authority prologue accept this actor for this submission? `previewActOnSubmission`
     * is `checkMayAct` with nothing after it, so this asks the exact question `actOnSubmission`
     * asks, without writing. Awaited inside the try, so no rejected promise is left for a turn.
     */
    async function mayAct(submissionId: number, actorId: number): Promise<boolean> {
      try {
        await store.previewActOnSubmission({ submissionId, actorId, now: READ });
        return true;
      } catch (err) {
        const message = (err as Error).message;
        const code = REFUSALS.find((candidate) => message.startsWith(`${candidate}:`));
        if (code === undefined) throw err;
        seen.add(code);
        return false;
      }
    }

    await seedCast();

    // A manager step, decidable by the one manager.
    const plain = await fileOvertime(staff, 120);
    // Filed by the only person who could have decided it: decidable by nobody.
    const filed = await fileOvertime(staff, 90, boss);
    // Advanced to a step pinned to a named employee rather than to a relationship.
    const pinned = await fileOvertime(staff, 60);
    await store.actOnSubmission({
      submissionId: pinned, actorId: boss, action: "approve", now: FILED + 1000,
    });
    // Reachable only through the root-of-organisation fallback.
    const root = await fileOvertime(chief, 45);
    // A manager AND a designated approver: the manager decides, the designated approver may not.
    const fallbackDenied = await fileOvertime(both, 30);
    // Not every pending row is overtime; an amendment inherits the same approval stack.
    const punchId = await store.recordPunch({
      employeeId: staff, workDate: DAY, kind: "in", now: NINE, source: "gadget",
    });
    const correction = await store.fileAmendment({
      employeeId: staff, targetPunchId: punchId, occurredAt: NINE - 1_800_000,
      reason: "started early on site", now: FILED,
      department: DASH_DEPT, employmentType: null, createdBy: staff,
    });

    const labels = new Map<number, string>([
      [plain, "plain"], [filed, "filed by the approver"], [pinned, "at a pinned step"],
      [root, "root employee"], [fallbackDenied, "manager and approver"],
      [correction, "amendment"],
    ]);

    const items = await store.pendingOverview(READ);
    // Every pending row, and nothing else: a row missing from the dashboard is a submission whose
    // stranding nobody can see, which is the failure this whole feature exists to prevent.
    expect([...items.map((item: { id: number }) => item.id)].sort((a, b) => a - b))
      .toEqual([...labels.keys()].sort((a, b) => a - b));

    // EVERY employee in the store, not a hand-picked set: the candidate set inside
    // `eligibleActors` is the roster, so anyone the act check would accept has to appear.
    const employees = await store.listEmployees();
    for (const item of items) {
      const eligible = new Set<number>(item.eligibleActorIds);
      for (const employee of employees) {
        const allowed = await mayAct(item.id, employee.id);
        // Compared as strings so a failure names the pair rather than reporting `true !== false`.
        const pair = `${labels.get(item.id)} / ${employee.display_name}`;
        expect(`${pair}: eligible=${eligible.has(employee.id)}`)
          .toBe(`${pair}: eligible=${allowed}`);
      }
      // The names travel with the ids, in the same order, or a dashboard row would attribute a
      // decision to the wrong person.
      expect(item.eligibleActorNames).toEqual(
        item.eligibleActorIds.map(
          (id: number) => employees.find((e: { id: number }) => e.id === id)!.display_name,
        ),
      );
    }

    // And the matrix is not weaker than it looks: every refusal reachable from a pending row was
    // reached by a real pair above. One that stopped being exercised would be one that stopped
    // being guarded, silently.
    expect([...seen].sort()).toEqual([...REFUSALS].sort());
  });

  it("surfaces a stranded submission loudly, with nobody eligible", async () => {
    // The case the dashboard exists for. A manager files a request for their own report, and they
    // are that report's only approver: `FiledBySelfError` refuses the one person the route can
    // reach, and the submission sits in `pending` for ever. Nobody's queue shows it -- not the
    // employee's (it is not theirs to decide), not the manager's (they filed it) -- so before this
    // read there was no surface in the system on which it appeared at all.
    await seedCast();
    const strandedId = await fileOvertime(staff, 120, boss);

    const items = await store.pendingOverview(READ);
    const stranded = items.find((item: { id: number }) => item.id === strandedId)!;
    // Present, not filtered away, and empty rather than absent: an empty eligible set IS the
    // finding, and a read that dropped the row would hide exactly what it was built to show.
    expect(stranded).toBeDefined();
    expect(stranded.eligibleActorIds).toEqual([]);
    expect(stranded.eligibleActorNames).toEqual([]);
    expect(stranded).toMatchObject({ state: "pending", filedByName: "Sato", employeeName: "Suzuki" });

    // Not a defect in the read: the act check refuses every employee in the store for this row.
    for (const employee of await store.listEmployees()) {
      await expect(() => store.previewActOnSubmission({
        submissionId: strandedId, actorId: employee.id, now: READ,
      })).rejects.toThrow(/KINTAI_SELF_APPROVAL|KINTAI_FILED_BY_APPROVER|KINTAI_NOT_AUTHORIZED/);
    }
  });
});
