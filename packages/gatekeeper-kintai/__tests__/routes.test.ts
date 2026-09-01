import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { selectRoute, type RouteConfig } from "../src/routes.js";

const GENERIC: RouteConfig = {
  id: 1, name: "default", department: null, employmentType: null, minMinutes: 0,
};
const SITE: RouteConfig = {
  id: 2, name: "site", department: "CONSTRUCTION", employmentType: null, minMinutes: 0,
};
const HEAVY: RouteConfig = {
  id: 3, name: "heavy", department: "CONSTRUCTION", employmentType: null, minMinutes: 2700,
};
const FULL_TIME: RouteConfig = {
  id: 4, name: "full-time", department: null, employmentType: "FULL_TIME", minMinutes: 0,
};

describe("selectRoute", () => {
  it("prefers a department match over the catch-all", () => {
    const picked = selectRoute([GENERIC, SITE], {
      department: "CONSTRUCTION", employmentType: null, minutes: 60,
    });
    expect(picked?.id).toBe(SITE.id);
  });

  it("prefers the highest threshold the request clears", () => {
    const picked = selectRoute([GENERIC, SITE, HEAVY], {
      department: "CONSTRUCTION", employmentType: null, minutes: 3000,
    });
    expect(picked?.id).toBe(HEAVY.id);
  });

  it("ignores a threshold the request does not reach", () => {
    const picked = selectRoute([GENERIC, SITE, HEAVY], {
      department: "CONSTRUCTION", employmentType: null, minutes: 100,
    });
    expect(picked?.id).toBe(SITE.id);
  });

  it("falls back to the catch-all for an unmatched department", () => {
    const picked = selectRoute([GENERIC, SITE], {
      department: "SALES", employmentType: null, minutes: 60,
    });
    expect(picked?.id).toBe(GENERIC.id);
  });

  it("returns null when nothing matches", () => {
    expect(selectRoute([SITE], {
      department: "SALES", employmentType: null, minutes: 60,
    })).toBeNull();
  });

  it("prefers an employment-type match over the catch-all", () => {
    const picked = selectRoute([GENERIC, FULL_TIME], {
      department: null, employmentType: "FULL_TIME", minutes: 60,
    });
    expect(picked?.id).toBe(FULL_TIME.id);
  });

  it("prefers a department match over an employment-type match — department is strictly dominant", () => {
    const picked = selectRoute([FULL_TIME, SITE], {
      department: "CONSTRUCTION", employmentType: "FULL_TIME", minutes: 60,
    });
    expect(picked?.id).toBe(SITE.id);
  });
});

describe("resolveRoute", () => {
  let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
  let seq = 0;

  beforeEach(() => {
    store = env.KINTAI_STORE.getByName(`routes-${seq++}`);
  });

  it("snapshots the ordered steps of the selected route", async () => {
    const routeId = await store.createRoute({
      name: "site", department: "CONSTRUCTION", minMinutes: 0,
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "all_of", approverKind: "manager", approverEmployeeId: null },
      ],
    });

    const snapshot = await store.resolveRoute({
      department: "CONSTRUCTION", employmentType: null, minutes: 120,
    });

    expect(snapshot.routeId).toBe(routeId);
    expect(snapshot.steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(snapshot.steps[1].rule).toBe("all_of");
  });

  it("preserves a pinned employee approver alongside a manager step through the snapshot", async () => {
    const director = await store.createEmployee({
      employeeNumber: "D1", displayName: "Director", joinedOn: "2026-04-01",
    });

    const routeId = await store.createRoute({
      name: "director-signoff", department: "CONSTRUCTION", minMinutes: 0,
      steps: [
        { rule: "any_of", approverKind: "manager", approverEmployeeId: null },
        { rule: "any_of", approverKind: "employee", approverEmployeeId: director },
      ],
    });

    const snapshot = await store.resolveRoute({
      department: "CONSTRUCTION", employmentType: null, minutes: 120,
    });

    expect(snapshot.routeId).toBe(routeId);
    expect(snapshot.steps).toHaveLength(2);
    expect(snapshot.steps[0].approverKind).toBe("manager");
    expect(snapshot.steps[0].approverEmployeeId).toBeNull();
    expect(snapshot.steps[1].approverKind).toBe("employee");
    expect(snapshot.steps[1].approverEmployeeId).toBe(director);
  });

  it("selects nothing when there are no candidates at all", () => {
    // The pure half of "no route". A store can no longer reach it -- `applySchema` seeds a
    // catch-all -- but the selection rule still has to say null rather than pick arbitrarily,
    // and `resolveRoute` still turns that into `KINTAI_NO_ROUTE`.
    expect(selectRoute([], { department: "SALES", employmentType: null, minutes: 60 }))
      .toBeNull();
  });

  it("falls back to the seeded default for a department nobody configured", async () => {
    // Was: this threw `KINTAI_NO_ROUTE`. `applySchema` now seeds a catch-all, so an unconfigured
    // department routes to the employee's manager instead of being unable to submit at all. The
    // signal is not lost, it moved: an employee with NO manager is still refused, by
    // `assertApproverReachable` rather than by route resolution.
    const snapshot = await store.resolveRoute({
      department: "SALES", employmentType: null, minutes: 60,
    });

    expect(snapshot.steps).toEqual([
      { stepIndex: 0, rule: "any_of", approverKind: "manager", approverEmployeeId: null },
    ]);
  });
});
