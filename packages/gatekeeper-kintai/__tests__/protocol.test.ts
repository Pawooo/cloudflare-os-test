import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeKintaiAccount } from "../src/kintai.js";

// The Workshop provisioning protocol: the vendor mints an account, the account hands out an imbued
// Gatekeeper class, the Overseer installs it as a facet, and `startSession()` produces the surface
// the agent sees. These tests exercise that chain against the real runtime rather than the domain
// behind it — `facet.test.ts` covers the domain.
//
// A host instance of its own ("protocol-overseer"), NOT the "overseer" that facet.test.ts uses:
// the approval-queue state lives on the host, and the refusing-queue test below would otherwise
// reach into another file's sessions.
const HOST = "protocol-overseer";

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let host: ReturnType<typeof env.KINTAI_FACET_HOST.getByName>;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  store = env.KINTAI_STORE.getByName("");
  host = env.KINTAI_FACET_HOST.getByName(HOST);
  await host.resetQueue();
});

afterEach(async () => {
  // Never leave a refusing queue behind for the next test in this file.
  await env.KINTAI_FACET_HOST.getByName(HOST).resetQueue();
});

/** A caller's view of a session opened on a facet named for this test. */
function sessionFor(accountId: string) {
  const name = `protocol-${accountId}-${seq}`;
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callSession(accountId, name, method, args);
    },
  }) as any;
}

/** A caller's view of the Gatekeeper facet itself — the protocol surface the Overseer calls. */
function facetFor(accountId: string) {
  const name = `protocol-${accountId}-${seq}`;
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<any>>, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => host.callFacet(accountId, name, method, args);
    },
  }) as any;
}

async function linkedEmployee(tag: string) {
  const employeeId = await store.createEmployee({
    employeeNumber: `${tag}-p${seq}`,
    displayName: tag,
    joinedOn: "2026-04-01",
  });
  const accountId = `acct-${tag}-p${seq}`;
  await store.linkAccount(accountId, employeeId, Date.now());
  return { employeeId, accountId };
}

describe("GatekeeperVendor", () => {
  it("advertises no URL-addressed resources, so the admin panel can still list it", async () => {
    // Not a formality: the admin Gatekeepers panel resolves every vendor with
    // Promise.all([describe(), getSupportedResources()]) and silently drops any vendor whose entry
    // rejects. A vendor missing this method never appears at all.
    expect(await env.KINTAI_VENDOR.getSupportedResources()).toEqual([]);
    expect(await env.KINTAI_VENDOR.getSupportedResources({ userId: "someone@example.com" }))
      .toEqual([]);
  });

  it("publishes the agent-facing declarations", async () => {
    const types = await env.KINTAI_VENDOR.getTypeScriptTypes();

    expect(types).toContain("export interface KintaiSession");
    // describe().tsType must name an export of this file, or the agent's Code Mode has nothing to
    // resolve the binding to.
    for (const method of [
      "whoAmI", "punch", "getDay", "setAllocations", "submitOvertime", "withdrawSubmission",
      "resubmit", "listMySubmissions", "listPendingApprovals", "actOnSubmission",
    ]) {
      expect(types).toContain(`${method}(`);
    }
  });

  it("refuses an interactive connection", async () => {
    // A real stub, not null: RPC validation rejects a null callback before the body runs, and the
    // point here is that the BODY refuses rather than that the validator does.
    const stub = await env.KINTAI_VENDOR.createAccount();

    await expect(() => env.KINTAI_VENDOR.connectAccount(stub as never))
      .rejects.toThrow(/auto-provisioned/);
  });

  it("mints an account that describes the Kintai singleton", async () => {
    const account = await env.KINTAI_VENDOR.createAccount();

    const description = await account.describe();
    expect(description.singleton).toEqual({ tsType: "KintaiSession" });
    expect(description.displayName).toBe("Kintai");
    // Dropped deliberately: there is no HR/admin app in this package yet, and declaring it would
    // make the Workshop open a nav entry onto a startAppUi() that does not exist.
    expect(description.providesUi).toBeUndefined();
    expect(description).toEqual(describeKintaiAccount());
  });
});

describe("GatekeeperUser", () => {
  it("implements the resourceless account protocol", async () => {
    const account = await env.KINTAI_VENDOR.createAccount();

    expect(await account.getSupportedResources()).toEqual([]);
    expect(await account.ensureResources([])).toEqual({});
    expect(await account.getAuthenticatedEmail()).toBeNull();
    await expect(() => account.getGatekeeperClassFor("https://example.com/"))
      .rejects.toThrow(/no URL-addressed resources/);
    await expect(() => account.startResourceConfigurator("https://example.com/*"))
      .rejects.toThrow(/no URL-addressed resources/);
    await expect(() => account.reconnect()).rejects.toThrow(/no connect flow/);
  });

  it("mints a verifier the observer policy can accept", async () => {
    const account = await env.KINTAI_VENDOR.createAccount();

    const verifier = await account.getVerifier();
    // GatekeeperUserVerifier has no methods by contract; what matters is that a live capability
    // comes back and that addObserver accepts it.
    expect(verifier).toBeTruthy();
    const { accountId } = await linkedEmployee("observed");
    await expect(facetFor(accountId).addObserver("collaborator", verifier)).resolves.toBeUndefined();
    await expect(facetFor(accountId).removeObserver("collaborator")).resolves.toBeUndefined();
  });

  it("revokes by closing the account link, never by deleting the record", async () => {
    const { employeeId, accountId } = await linkedEmployee("revoked");
    await store.recordPunch({
      employeeId, workDate: "2026-05-11", kind: "in", now: Date.parse("2026-05-11T00:00:00Z"),
      source: "gadget",
    });

    expect((await sessionFor(accountId).whoAmI()).linked).toBe(true);

    expect(await host.callAccount(accountId, "revoke", [])).toBeUndefined();

    // A fresh facet name, so this is a new session resolving the account from scratch rather than
    // anything cached from before the revoke.
    seq += 1;
    const after = sessionFor(accountId);
    expect(await after.whoAmI()).toEqual({ linked: false, employeeId: null });
    await expect(() => after.listMySubmissions()).rejects.toThrow(/KINTAI_ACCOUNT_NOT_LINKED/);

    // The payroll record survives: revocation ends a capability, it does not erase attendance.
    expect(await store.currentPunches(employeeId, "2026-05-11")).toHaveLength(1);
    expect(await store.employeeProfile(employeeId)).toMatchObject({ id: employeeId });
  });

  it("makes a second revoke a no-op, and lets HR re-link afterwards", async () => {
    const { employeeId, accountId } = await linkedEmployee("relinked");
    await host.callAccount(accountId, "revoke", []);
    await host.callAccount(accountId, "revoke", []);

    await store.linkAccount(accountId, employeeId, Date.now());

    seq += 1;
    expect((await sessionFor(accountId).whoAmI()).employeeId).toBe(employeeId);
  });
});

describe("Gatekeeper<KintaiSession>", () => {
  it("describes the ambient attendance binding", async () => {
    const { accountId } = await linkedEmployee("described");

    const description = await facetFor(accountId).describe();

    expect(description).toEqual({
      url: "kintai://attendance",
      title: "Kintai",
      snippet: "Record attendance, allocate hours, and route overtime for approval.",
      suggestedBindingName: "KINTAI",
      tsType: "KintaiSession",
    });
    // The Overseer stores describe().title/url on the gatekeeper record before anything else runs;
    // tsType must resolve inside the facet's own getTypeScriptTypes(), not just the vendor's.
    expect(await facetFor(accountId).getTypeScriptTypes())
      .toContain(`export interface ${description.tsType}`);
  });

  it("has no auto-approvable actions and no catalog", async () => {
    const { accountId } = await linkedEmployee("catalogued");

    expect(await facetFor(accountId).getAutoApprovableActions()).toEqual([]);
    // Called unconditionally by the Overseer on every ambient capsule; returning null is how a
    // gatekeeper says "nothing to index", and a missing method would log a failure on every chat.
    expect(await host.getAgentCatalog(accountId, `protocol-${accountId}-${seq}`)).toBeNull();
  });

  it("refuses the action callbacks, because it never submits an action", async () => {
    const { accountId } = await linkedEmployee("actionless");
    const facet = facetFor(accountId);

    await expect(() => facet.applyAction(1)).rejects.toThrow(/submits no actions/);
    await expect(() => facet.rejectAction(1)).rejects.toThrow(/submits no actions/);
    await expect(() => facet.revertAction(1)).rejects.toThrow(/submits no actions/);
  });
});

describe("the provisioning chain, end to end", () => {
  it("carries a minted account's capability into a working session", async () => {
    // Exactly the Workshop's sequence: vendor.createAccount() -> account.describe() ->
    // account.getSingletonGatekeeperClass() -> Overseer installs it as a facet -> startSession().
    const account = await env.KINTAI_VENDOR.createAccount();
    expect((await account.describe()).singleton?.tsType).toBe("KintaiSession");

    const gatekeeperClass = await account.getSingletonGatekeeperClass();
    const identity = await host.callProvisionedSession(
      gatekeeperClass as never, `provisioned-${seq}`, "whoAmI", [],
    );

    // The verification the plan actually asks for: the capability arrives and the domain layer is
    // reachable through the real protocol, and a brand-new account is inert until HR links it.
    expect(identity).toEqual({ linked: false, employeeId: null });
  });

  it("mints a capability that resolves to nobody, even alongside linked employees", async () => {
    // The store already holds this employee and an open link for their account. A minted account
    // must not land on an existing employee — which is what a shared, empty or defaulted accountId
    // would look like from the outside. accountIds are never exposed, so this is the only way the
    // property can be observed at all.
    const { employeeId } = await linkedEmployee("incumbent");
    expect(employeeId).toBeGreaterThan(0);

    const account = await env.KINTAI_VENDOR.createAccount();
    const identity = await host.callProvisionedSession(
      await account.getSingletonGatekeeperClass() as never, `mint-${seq}`, "whoAmI", [],
    );

    expect(identity).toEqual({ linked: false, employeeId: null });
  });
});

describe("observation authorization", () => {
  it("authorizes every read through the approval queue", async () => {
    const { accountId } = await linkedEmployee("observer");
    const session = sessionFor(accountId);

    await host.resetQueue();
    await session.whoAmI();
    await session.getDay("2026-05-12");
    await session.listMySubmissions();
    await session.listPendingApprovals();

    const { observations, actions } = await host.readQueue();
    expect(observations.map((o) => o.title)).toEqual([
      "Kintai identity",
      "Kintai day record for 2026-05-12",
      "Kintai submissions",
      "Kintai approval queue",
    ]);
    for (const observation of observations) expect(observation.description).toBeTruthy();
    // Kintai submits nothing to the approval queue; see the facet's action callbacks.
    expect(actions).toEqual([]);
  });

  it("returns no data when the queue refuses the observation", async () => {
    const { employeeId, accountId } = await linkedEmployee("refused");
    await store.recordPunch({
      employeeId, workDate: "2026-05-13", kind: "in", now: Date.parse("2026-05-13T00:00:00Z"),
      source: "gadget",
    });
    const session = sessionFor(accountId);
    // Prove the read works first, so the refusal below is the only thing that changed.
    expect((await session.getDay("2026-05-13")).punches).toHaveLength(1);

    await host.resetQueue(true);

    await expect(() => session.getDay("2026-05-13")).rejects.toThrow(/OBSERVATION_DENIED/);
    await expect(() => session.whoAmI()).rejects.toThrow(/OBSERVATION_DENIED/);
    await expect(() => session.listMySubmissions()).rejects.toThrow(/OBSERVATION_DENIED/);
    await expect(() => session.listPendingApprovals()).rejects.toThrow(/OBSERVATION_DENIED/);
  });
});
