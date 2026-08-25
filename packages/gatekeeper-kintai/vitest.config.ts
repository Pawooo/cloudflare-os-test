import { readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Reproduces the wrangler `Text` rule for `.txt` files (see wrangler.jsonc) inside the test pool.
 *
 * Without it `import TYPES_CODE from "./types.txt"` resolves through Vite's asset pipeline and the
 * default export is the URL "/src/types.txt", so `getTypeScriptTypes()` would return that path
 * under test while returning the actual declarations in production — the one discrepancy a test of
 * that method must not have. `enforce: "pre"` puts this ahead of the asset handling.
 */
const textModules: Plugin = {
  name: "kintai-text-modules",
  enforce: "pre",
  async load(id) {
    const path = id.split("?")[0];
    if (!path.endsWith(".txt")) return null;
    return `export default ${JSON.stringify(await readFile(path, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [
    textModules,
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
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
