#!/usr/bin/env node
/**
 * FALS-001 platform — candidate harvest → experiments → family verdict.
 *
 * Usage: cd backend && node scripts/research-fals-platform.mjs
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exportOnly = process.argv.includes("--export-only");
const experimentsOnly = process.argv.includes("--experiments-only");
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

if (!experimentsOnly) {
  await run("research-fals-candidate-export.mjs");
}
if (!exportOnly) {
  await run("research-fals-experiments.mjs");
  await run("research-governance.mjs");
}

console.log("\nFALS-001 platform complete.");
