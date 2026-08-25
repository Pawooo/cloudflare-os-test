import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_als"],
        serviceBindings: {
          KINTAI_VENDOR: { name: kCurrentWorker, entrypoint: "GatekeeperVendor" },
        },
        durableObjects: {
          KINTAI_STORE: { className: "KintaiStore", useSQLite: true },
          // Registration only, never used as a binding. Without it workerd does not classify
          // KintaiGatekeeper as a Durable Object, and `ctx.exports.KintaiGatekeeper({ props })`
          // constructs it as a plain entrypoint ("constructor parameter 1 is not of type
          // 'DurableObjectState'"). Tests must not mint facets through this binding: a namespace
          // binding cannot carry `ctx.props`. See `KintaiFacetHost` in `__tests__/worker.ts`.
          KINTAI_FACET: { className: "KintaiGatekeeper", useSQLite: true },
          // Test-only parent, standing in for the Overseer that hosts the facet in production.
          KINTAI_FACET_HOST: { className: "KintaiFacetHost", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
