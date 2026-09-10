import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinEntry } from "@gadgets/scripts/bin-entry";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
// One-shot build that produces the same bytes `--watch` would, for the `pnpm dev-server`
// pre-flight see the `unminified` note in vite.app.config.ts.
const dev = process.argv.includes("--dev");

// The two bundles this package ships: the admin dashboard (`app.txt`) and the employee gadget
// (`employee-app.txt`). `viteSingleFile` inlines one entry per build, so each is its own Vite run
// selected by `GATEKEEPER_APP_ENTRY`; see the `ENTRIES` note in vite.app.config.ts.
const ENTRIES = ["admin", "employee"];

// Reached directly: Vite+ runs tasks with a filtered environment that drops `npm_execpath`, so on
// Windows there is no shell-free way back to pnpm. Falls back to `pnpm exec` if vite is missing.
const viteArgs = ["build", "-c", "vite.app.config.ts", ...(watch ? ["--watch"] : [])];
const viteEntry = resolveBinEntry(packageDirectory, "vite");
const [command, argv] = viteEntry
  ? [process.execPath, [viteEntry, ...viteArgs]]
  : pnpmCommand(["exec", "vite", ...viteArgs]);

function envFor(entry) {
  return {
    ...process.env,
    GATEKEEPER_APP_ENTRY: entry,
    // Always set explicitly an inherited GATEKEEPER_APP_UNMINIFIED would
    // turn a production build unminified, and Vite+ would cache that under `build:app`.
    GATEKEEPER_APP_UNMINIFIED: dev ? "true" : "false",
  };
}

if (watch) {
  // Both watchers run at once — they write to different `src/generated` files and different
  // `dist` dirs (see vite.app.config.ts), so there is nothing for them to race on. `spawn`, not
  // `execFileSync`, because a watch never returns; if either exits, tear the other down and carry
  // its code out so a crashed watcher does not leave a half-watching dev server behind.
  const children = ENTRIES.map((entry) =>
    spawn(command, argv, { cwd: packageDirectory, stdio: "inherit", env: envFor(entry) }),
  );
  let done = false;
  const shutDown = (code) => {
    if (done) return;
    done = true;
    for (const child of children) child.kill();
    process.exit(code ?? 0);
  };
  for (const child of children) {
    child.on("exit", (code) => shutDown(code));
    child.on("error", () => shutDown(1));
  }
  // The dev server stops this process with a signal, and Node's default signal action exits
  // WITHOUT running the exit path above — so the two vite watchers were reparented and kept
  // rewriting `src/generated/*.txt` after `pnpm run-local` was gone (observed 2026-09-10, four
  // orphaned watchers). Forward the signal into `shutDown` so the children die with us.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => shutDown(0));
  }
} else {
  // Sequential: each build empties its own `outDir` and writes its `.txt` in `closeBundle` before
  // the next starts, so order does not matter and neither can clobber the other's output.
  for (const entry of ENTRIES) {
    execFileSync(command, argv, {
      cwd: packageDirectory,
      stdio: "inherit",
      env: envFor(entry),
    });
  }
}
