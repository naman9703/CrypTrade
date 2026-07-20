#!/usr/bin/env node
/**
 * Market Hypothesis Testing Platform — Phase 2 orchestrator.
 *
 * Usage: cd backend && node scripts/research-platform-phase2.mjs
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, script), ...args], {
      stdio: "inherit",
      cwd: path.join(__dirname, ".."),
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

await run("research-liq-platform.mjs", ["--analyze-only"]);
await run("research-expected-outcome.mjs");
await run("research-governance.mjs");
console.log("\nPhase 2 platform complete.");
