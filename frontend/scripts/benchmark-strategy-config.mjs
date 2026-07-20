/**
 * Measure main-thread cost of strategy config paths (no browser).
 * Run from frontend/: node scripts/benchmark-strategy-config.mjs
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url);

async function loadModule(rel) {
  return import(pathToFileURL(`${ROOT.pathname}${rel}`).href);
}

function bench(label, fn, iterations = 50) {
  // warmup
  for (let i = 0; i < 5; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = (performance.now() - t0) / iterations;
  console.log(`${label.padEnd(48)} ${ms.toFixed(2)} ms/call (n=${iterations})`);
  return ms;
}

const sampleBot = JSON.parse(
  readFileSync(new URL("../src/lib/strategyConfigProfile.data.json", import.meta.url), "utf8"),
);
// Flatten profile sample into bot-like shape
const bot = { ...(sampleBot.bot ?? sampleBot), strategyMode: "MANUAL", manualStrategy: "LIQUIDITY_MAP" };

const {
  canonicalCfgRawFromUiBot,
  instanceOperationalFromUiBot,
  signalBrainBotFingerprint,
  signalBrainPersistBotsEqual,
} = await loadModule("/src/lib/strategyBrainSnapshot.ts");

const cfgRaw = { v: 1, bot: { manualStrategy: "LIQUIDITY_MAP", strategyMode: "MANUAL" } };

console.log("Strategy config CPU benchmarks (main thread)\n");
bench("signalBrainBotFingerprint", () => signalBrainBotFingerprint(bot));
bench("canonicalCfgRawFromUiBot", () => canonicalCfgRawFromUiBot(bot));
bench("instanceOperationalFromUiBot", () => instanceOperationalFromUiBot(bot));
bench("signalBrainPersistBotsEqual", () => signalBrainPersistBotsEqual(bot, cfgRaw));
bench("JSON.stringify(canonicalCfgRaw)", () => JSON.stringify(canonicalCfgRawFromUiBot(bot)));

const payload = canonicalCfgRawFromUiBot(bot);
const payloadBytes = JSON.stringify({ action: "save", cfgRaw: payload, instanceOperational: instanceOperationalFromUiBot(bot) }).length;
console.log(`\nTypical save POST body size: ${(payloadBytes / 1024).toFixed(1)} KB`);
