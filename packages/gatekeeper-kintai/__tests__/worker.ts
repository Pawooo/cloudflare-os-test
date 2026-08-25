import { DurableObject } from "cloudflare:workers";
import type { KintaiGatekeeper } from "../src/kintai.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { GatekeeperVendor, KintaiAccount, KintaiGatekeeper } from "../src/kintai.js";
export { KintaiStore } from "../src/store/kintai-store.js";

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
  /**
   * Invoke one method on the account-imbued facet and return its result.
   *
   * Calls are forwarded rather than the stub being returned because stubs pointing at Durable
   * Object facets are not serializable — which mirrors production, where the facet never leaves the
   * Overseer either. `args` is passed through verbatim, extra arguments included, so authorization
   * tests can genuinely try to smuggle an employee id past the facet's signature.
   */
  callFacet(accountId: string, name: string, method: string, args: unknown[]): Promise<unknown> {
    const facet = this.ctx.facets.get<KintaiGatekeeper>(name, () => ({
      class: this.ctx.exports.KintaiGatekeeper({ props: { accountId } }),
    }));
    const callable = facet as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }
}
