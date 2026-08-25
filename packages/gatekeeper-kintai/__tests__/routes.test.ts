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

  it("throws when no route matches", async () => {
    // Wrapped in a thunk rather than passed as an already-created promise: passing the settled
    // promise straight to `expect(...).rejects` races the RPC layer's own error reporting and can
    // trip a spurious "unhandled rejection" even though this assertion does catch it (see Task 6).
    await expect(() => store.resolveRoute({
      department: "SALES", employmentType: null, minutes: 60,
    })).rejects.toThrow(/KINTAI_NO_ROUTE|no approval route/i);
  });
});
