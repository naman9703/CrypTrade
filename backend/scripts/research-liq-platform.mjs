#!/usr/bin/env node
/**
 * LIQ Research Platform — candidate harvest → experiments → dashboard.
 *
 * Usage: cd backend && node scripts/research-liq-platform.mjs
 *        cd backend && node scripts/research-liq-platform.mjs --candidates-only
 *        cd backend && node scripts/research-liq-platform.mjs --analyze-only
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidatesOnly = process.argv.includes("--candidates-only");
const analyzeOnly = process.argv.includes("--analyze-only");
const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, script), ...args, ...extra], {
      stdio: "inherit",
      cwd: path.join(__dirname, ".."),
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

if (!analyzeOnly) {
  await run("research-liq-candidate-export.mjs");
}
if (!candidatesOnly) {
  await run("research-liq-experiments.mjs");
  await run("research-liq-decision-audit.mjs");
  await run("research-liq-family-verdict.mjs");
  await run("research-liq-feature-analysis.mjs");
}
console.log("\nLIQ research platform complete.");
