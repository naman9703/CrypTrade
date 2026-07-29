#!/usr/bin/env node
/**
 * MLCTS Phase 0 — signal harvest frequency + layer pass rates (research checkpoint).
 *
 * Usage (backend/): node scripts/research-mlcts-phase0.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-07-01";
const TF = process.env.TF || "15m";

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildMlctsSeries, MLCTS_WARMUP } = await import("../src/strategy/techniques/mlctsLayers.js");
const { optsFromMlctsCfg, hydrateMlctsCfg, mlctsPadFromMs, resolveMlctsCfg } = await import(
  "../src/strategy/mlctsIntraday.js"
);

async function analyzeSymbol(symbol) {
  const padFrom = mlctsPadFromMs(fromMs, TF);
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateMlctsCfg(resolveMlctsCfg({ symbol, timeframe: TF }), symbol, padFrom, toMs);
  const opts = optsFromMlctsCfg(cfg);
  const { series } = buildMlctsSeries(candles, opts, {
    oiSeries: cfg._mlctsOiSeries ?? [],
    fundingSeries: cfg._mlctsFundingSeries ?? [],
  });

  const inWindow = [];
  for (let i = MLCTS_WARMUP; i < series.length; i++) {
    const sig = series[i];
    if (!sig) continue;
    const ts = Number(candles[i]?.ts);
    if (ts >= fromMs && ts < toMs) inWindow.push({ ts, action: sig.action, reason: sig.reason, ctx: sig.mlctsContext });
  }

  const coverageDays = Math.max(1, (toMs - fromMs) / (86400_000));
  const coverageWeeks = coverageDays / 7;
  return {
    symbol,
    candles: candles.length,
    signals: inWindow.length,
    perWeek: inWindow.length / coverageWeeks,
    buys: inWindow.filter((s) => s.action === "BUY").length,
    sells: inWindow.filter((s) => s.action === "SELL").length,
    sample: inWindow.slice(0, 5),
  };
}

const results = [];
for (const sym of SYMBOLS) {
  try {
    results.push(await analyzeSymbol(sym));
  } catch (err) {
    results.push({ symbol: sym, error: String(err?.message || err) });
  }
}

const outPath = path.join(__dirname, ".mlcts-phase0-screen.json");
fs.writeFileSync(outPath, JSON.stringify({ from: FROM, to: TO, tf: TF, results }, null, 2));

const decisionPath = path.join(
  __dirname,
  ".research-decisions",
  "2026-07-29-mlcts-phase0-screen.md",
);
const lines = [
  "# MLCTS — Phase 0 screen (2026-07-29)",
  "",
  "**Status:** `CHECKPOINT` — implementation complete; full WF+MC validation pending.",
  `**Window:** ${FROM} → ${TO} · TF ${TF}`,
  "",
  "| Symbol | signals | /wk | buys | sells |",
  "|--------|---------|-----|------|-------|",
  ...results.map((r) =>
    r.error
      ? `| ${r.symbol} | ERR | — | — | — |`
      : `| ${r.symbol} | ${r.signals} | ${r.perWeek.toFixed(2)} | ${r.buys} | ${r.sells} |`,
  ),
  "",
  "Next: run full backtest via `backtest-validate` harness with realistic costs; iterate only if frequency ≥2/wk and OOS return > 0.",
  "",
  `Raw: \`${path.basename(outPath)}\``,
];
fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
fs.writeFileSync(decisionPath, lines.join("\n"));

console.log(JSON.stringify({ outPath, decisionPath, results }, null, 2));
await closePool?.().catch(() => {});
