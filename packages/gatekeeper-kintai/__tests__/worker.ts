import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { KintaiGatekeeper, KintaiSession } from "../src/kintai.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export {
  GatekeeperVendor, KintaiAccount, KintaiGatekeeper, KintaiVerifier,
} from "../src/kintai.js";
export { KintaiStore } from "../src/store/kintai-store.js";

/** What the test-side queue recorded, read back through `KintaiFacetHost.readQueue()`. */
export type QueueLog = {
  observations: { title: string; description: string; prohibitAllSharing: boolean }[];
  actions: { action: number; title: string }[];
};

/**
 * Stands in for the Overseer's ApprovalQueue.
 *
 * Permissive by default so the domain suites see the behaviour they always did; `denyObservations`
 * flips it into a refusing queue so a test can prove a read is actually gated on it and not merely
 * accompanied by a call.
 */
class TestApprovalQueue extends RpcTarget {
  constructor(private readonly state: { log: QueueLog; denyObservations: boolean }) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.state.log.observations.push({
      title: description.title,
      description: description.description,
      // Recorded as a definite boolean: an observation that leaves the flag off is asserting it is
      // shareable, and a test must be able to tell that from "the harness dropped the field".
      prohibitAllSharing: description.prohibitAllSharing === true,
    });
    if (this.state.denyObservations) throw new Error("OBSERVATION_DENIED: test queue refused.");
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.state.log.actions.push({ action, title: description.title });
  }

  async bindHook(): Promise<void> {
    throw new Error("Kintai registers no hooks.");
  }
}

/**
 * Test-only stand-in for the Overseer, so tests reach the facet the way a Gadget does.
 *
 * There is no way to mint an account-imbued facet from a test's `env`:
 *
 *  - `getByName(name, { accountId })` does not exist. `getByName` takes a name only, and a
 *    `durableObjects` namespace binding cannot carry `ctx.props` at all — a facet reached that way
 *    would see `ctx.props === undefined`, which production never produces.
 *  - `ctx.exports.KintaiGatekeeper({ props })` returns a `DurableObjectClass`, not a namespace, so
 *    it has no `getByName`. An imbued class can only be instantiated as a FACET under a parent
 *    Durable Object, via `ctx.facets.get(name, () => ({ class }))`.
 *  - `ctx.exports` exists only inside a Durable Object or WorkerEntrypoint, never in a test.
 *
 * That is exactly the production shape: `KintaiAccount.getSingletonGatekeeperClass()` hands the
 * imbued class to the Overseer, which installs it as a facet under itself. This class is that
 * parent, and nothing more.
 */
export class KintaiFacetHost extends DurableObject<Cloudflare.Env> {
  readonly #queueState = {
    log: { observations: [], actions: [] } as QueueLog,
    denyObservations: false,
  };

  /** One live session per facet name, as a Gadget holds one session for as long as it runs. */
  readonly #sessions = new Map<string, Promise<KintaiSession>>();

  #facet(accountId: string, name: string): KintaiGatekeeper {
    return this.ctx.facets.get<KintaiGatekeeper>(name, () => ({
      class: this.ctx.exports.KintaiGatekeeper({ props: { accountId } }),
    }));
  }

  /**
   * Invoke one method on the account-imbued facet itself — the `Gatekeeper<KintaiSession>`
   * protocol surface the Overseer calls, not the agent-facing session.
   */
  callFacet(accountId: string, name: string, method: string, args: unknown[]): Promise<unknown> {
    const callable =
      this.#facet(accountId, name) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Invoke one method on the session the facet opens, which is the only surface a Gadget reaches.
   *
   * Calls are forwarded rather than the session being returned because a stub that transitively
   * points at a Durable Object facet is not serializable out — which mirrors production, where the
   * facet never leaves the Overseer either. `args` is passed through verbatim, extra arguments
   * included, so authorization tests can genuinely try to smuggle an employee id past the session's
   * signature.
   */
  async callSession(
    accountId: string, name: string, method: string, args: unknown[],
  ): Promise<unknown> {
    let session = this.#sessions.get(name);
    if (!session) {
      // startSession() is reached through the facet exactly as the Overseer reaches it, so the
      // session under test is bound to the facet's own ctx.props and to nothing the caller said.
      session = Promise.resolve(
        this.#facet(accountId, name).startSession(
          new TestApprovalQueue(this.#queueState) as never,
        ),
      );
      this.#sessions.set(name, session);
    }
    const callable =
      (await session) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Install a class handed out by `KintaiAccount.getSingletonGatekeeperClass()` and call one
   * method on the session it opens.
   *
   * This is the whole provisioning protocol end to end, with nothing stubbed: the vendor minted the
   * account, the account chose the accountId and imbued the class with it, and the class arrives
   * here as opaque data. Nothing in this method knows or can say which account it is speaking for.
   */
  async callProvisionedSession(
    gatekeeperClass: DurableObjectClass<KintaiGatekeeper>,
    name: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const facet = this.ctx.facets.get<KintaiGatekeeper>(name, () => ({ class: gatekeeperClass }));
    const session = await facet.startSession(new TestApprovalQueue(this.#queueState) as never);
    const callable = session as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Call one method on a `KintaiAccount` imbued with a known accountId.
   *
   * Production mints the accountId inside `createAccount()` and never reveals it, which is right
   * but leaves `revoke()` untestable against a linked employee. Building the account here with an
   * id the test also linked closes that gap without adding any way to read an accountId back out
   * of a real account.
   */
  callAccount(accountId: string, method: string, args: unknown[]): Promise<unknown> {
    const account = this.ctx.exports.KintaiAccount({ props: { accountId } });
    const callable =
      account as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Call `getAgentCatalog()` with a live authorizer.
   *
   * It takes an `ObservationAuthorizer` stub and RPC validation rejects anything else, so a test
   * cannot reach it through `callFacet` — a stub can only be minted inside a worker.
   */
  getAgentCatalog(accountId: string, name: string): Promise<unknown> {
    return this.#facet(accountId, name)
      .getAgentCatalog(new TestApprovalQueue(this.#queueState) as never);
  }

  /** Everything the approval queue has been asked to authorize since the last `resetQueue()`. */
  readQueue(): QueueLog {
    return {
      observations: [...this.#queueState.log.observations],
      actions: [...this.#queueState.log.actions],
    };
  }

  /** Clear the recorded calls and choose whether the queue permits or refuses observations. */
  resetQueue(denyObservations = false): void {
    this.#queueState.log.observations.length = 0;
    this.#queueState.log.actions.length = 0;
    this.#queueState.denyObservations = denyObservations;
  }
}
