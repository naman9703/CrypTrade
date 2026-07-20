#!/usr/bin/env node
/**
 * Phase 1 — Funding arb opportunity monitor (no trading).
 *
 * Usage:
 *   cd backend && node scripts/research-funding-arb-monitor.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT DAYS=30 node scripts/research-funding-arb-monitor.mjs
 *   --live  (also poll Binance premiumIndex via fundingCollector)
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const DAYS = Number(process.env.DAYS || 30);
const USE_LIVE = process.argv.includes("--live") || process.env.LIVE === "1";
const toMs = Date.now();
const fromMs = toMs - DAYS * 864e5;

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  scanFundingOpportunities,
  formatOpportunityTable,
  resolveFundingArbCfg,
  DEFAULT_FUNDING_ARB_SYMBOLS,
} = await import("../src/strategy/fundingArb/index.js");

let liveMap = {};
if (USE_LIVE) {
  try {
    const { fundingCollector } = await import("../src/intelligence/collectors/fundingCollector.js");
    liveMap = await fundingCollector.collect(SYMBOLS);
  } catch (err) {
    console.warn("[funding-arb-monitor] live collector failed:", err.message);
  }
}

const cfg = resolveFundingArbCfg({
  symbols: SYMBOLS.length ? SYMBOLS : [...DEFAULT_FUNDING_ARB_SYMBOLS],
  minAnnualizedYieldPct: Number(process.env.MIN_ANN ?? 8),
  exitAnnualizedYieldPct: Number(process.env.EXIT_ANN ?? 2),
  stabilityIntervals: Number(process.env.STABILITY ?? 2),
});

const rows = [];
for (const symbol of cfg.symbols) {
  try {
    await ensureFunding(symbol, { from: fromMs, to: toMs });
  } catch (err) {
    console.warn(`[funding-arb-monitor] ensureFunding ${symbol}:`, err.message);
  }
  const rates = await readFundingRates(symbol, fromMs, toMs);

  let spotPx = null;
  let perpPx = null;
  try {
    // Do not ensure spot into ohlcv — PK overlaps futures and would overwrite archive.
    await ensureKlines(symbol, "1h", { from: toMs - 2 * 864e5, to: toMs, market: "futures" });
    const fut = await readCandles(symbol, "1h", toMs - 2 * 864e5, toMs, { market: "futures" });
    perpPx = fut.length ? Number(fut[fut.length - 1].close) : null;
    spotPx = perpPx; // monitor basis≈0 until spot series stored separately
  } catch (err) {
    console.warn(`[funding-arb-monitor] prices ${symbol}:`, err.message);
  }

  rows.push({
    symbol,
    rates,
    live: liveMap[symbol] ?? null,
    spotPx,
    perpPx,
  });
}

const opportunities = scanFundingOpportunities(rows, cfg);
const enterable = opportunities.filter((o) => o.enter);

const report = {
  generatedAt: new Date().toISOString(),
  window: { fromMs, toMs, days: DAYS },
  live: USE_LIVE,
  cfg: {
    minAnnualizedYieldPct: cfg.minAnnualizedYieldPct,
    exitAnnualizedYieldPct: cfg.exitAnnualizedYieldPct,
    stabilityIntervals: cfg.stabilityIntervals,
  },
  symbols: cfg.symbols,
  opportunities,
  enterableCount: enterable.length,
};

const jsonPath = path.resolve(__dirname, ".funding-arb-monitor.json");
const mdPath = path.resolve(__dirname, ".funding-arb-monitor.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const md = [
  `# Funding arb monitor`,
  ``,
  `Generated: ${report.generatedAt}`,
  `Window: last ${DAYS}d | live=${USE_LIVE}`,
  `Enter threshold: ≥${cfg.minAnnualizedYieldPct}% ann | stability=${cfg.stabilityIntervals}`,
  ``,
  "```",
  formatOpportunityTable(opportunities),
  "```",
  ``,
  `Enterable now: **${enterable.length}** / ${opportunities.length}`,
  ``,
  enterable.length
    ? enterable.map((o) => `- ${o.symbol}: ${o.annualizedPct?.toFixed(1)}% ann (${o.side})`).join("\n")
    : "_No symbols clear entry threshold._",
  ``,
].join("\n");
fs.writeFileSync(mdPath, md);

console.log("\n═══ Funding arb opportunity monitor ═══");
console.log(formatOpportunityTable(opportunities));
console.log(`\nEnterable: ${enterable.length}/${opportunities.length}`);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);

await closePool();
