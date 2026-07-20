#!/usr/bin/env node
/**
 * Smoke-check critical frontend modules after build (catches dropped imports on store paths).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const tests = spawnSync(
  process.execPath,
  ["--test", "src/ws/storeChartFocusDepth.test.mjs", "src/lib/configPatchInFlight.test.mjs", "src/lib/instanceConfigView.test.mjs"],
  { cwd: root, stdio: "inherit" },
);

if (tests.status !== 0) {
  process.exit(tests.status ?? 1);
}

console.log("verify-app-modules: ok");
