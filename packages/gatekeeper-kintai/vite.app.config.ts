import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import tsconfigPaths from "vite-tsconfig-paths";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Minification is the only thing that differs between the watch build and the one-shot build, so
// it is the only reason their `src/generated/app.txt` bytes differ -- and that difference is what
// makes `pnpm dev-server` rebuild the app twice and restart Wrangler mid-startup: the cached
// one-shot build lands first, then the watcher's initial build overwrites it. `build:app:dev` sets
// this so the pre-flight produces exactly what the watcher will, letting the write be skipped.
const unminified = watch || process.env.GATEKEEPER_APP_UNMINIFIED === "true";

/**
 * Which of the two bundles this invocation builds. `viteSingleFile` inlines exactly one entry per
 * build and `emitAppText` writes exactly one `.txt`, so the two bundles are two Vite runs, not one
 * multi-entry build -- `build-app.mjs` runs this config once per entry, passing the name here.
 *
 * Each entry owns a SEPARATE `outDir`: the admin build is byte-for-byte what it was before this
 * file grew a second entry (same input, same `dist-app`, same `emitAppText` output), which is what
 * keeps `app.txt` from shifting. Separate dirs also let `--watch` run both watchers at once without
 * two `emptyOutDir` builds racing on one `dist` tree; the two write to different `src/generated`
 * files, so those never collide.
 */
type EntryName = "admin" | "employee";
const ENTRIES = {
  admin: {
    input: "app/index.html",
    outDir: "dist-app",
    builtHtml: "index.html",
    output: "app.txt",
    jsFile: "gatekeeper-kintai.js",
    sourceUrl: "app:///gatekeeper/kintai/gatekeeper-kintai.js",
  },
  employee: {
    input: "app/employee-index.html",
    outDir: "dist-app-employee",
    builtHtml: "employee-index.html",
    output: "employee-app.txt",
    jsFile: "gatekeeper-kintai-employee.js",
    sourceUrl: "app:///gatekeeper/kintai/gatekeeper-kintai-employee.js",
  },
} as const satisfies Record<EntryName, unknown>;

const entryName: EntryName =
  process.env.GATEKEEPER_APP_ENTRY === "employee" ? "employee" : "admin";
const entry = ENTRIES[entryName];

function emitAppText(errorReporting: boolean): Plugin {
  return {
    name: "emit-app-text",
    closeBundle() {
      const builtHtml = resolve(packageDirectory, entry.outDir, "app", entry.builtHtml);
      const html = readFileSync(builtHtml, "utf8").replace(
        /(<script type="module"[^>]*>)([\s\S]*?)(<\/script>)/,
        `$1$2\n//# sourceURL=${entry.sourceUrl}\n$3`,
      );
      const script = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      if (script && errorReporting) {
        writeFileSync(
          resolve(packageDirectory, entry.outDir, entry.jsFile),
          `${script}\n//# sourceMappingURL=${entry.jsFile}.map\n`,
        );
      }
      const output = resolve(packageDirectory, "src", "generated", entry.output);
      const contents =
        "<!-- Generated from packages/gatekeeper-kintai/app. Do not edit. -->\n" + html;
      if (existsSync(output) && readFileSync(output, "utf8") === contents) return;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, contents);
    },
  };
}

export default defineConfig(({ mode }) => {
  const errorReporting = loadEnv(mode, packageDirectory).VITE_FRONTEND_ERROR_REPORTING === "true";
  return {
    plugins: [
      react(),
      tailwindcss(),
      tsconfigPaths(),
      viteSingleFile(),
      emitAppText(errorReporting),
    ],
    build: {
      outDir: entry.outDir,
      emptyOutDir: true,
      minify: unminified ? false : "terser",
      terserOptions: { compress: { passes: 2 }, format: { comments: false } },
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: errorReporting ? "hidden" : false,
      rollupOptions: {
        input: entry.input,
        output: { entryFileNames: entry.jsFile },
      },
      watch: watch
        ? {
            exclude: [
              "**/node_modules/**",
              "**/dist-app/**",
              "**/dist-app-employee/**",
              "**/.wrangler/**",
              "**/generated/**",
            ],
          }
        : undefined,
    },
  };
});
