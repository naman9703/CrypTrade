#!/usr/bin/env node
/**
 * VP frequency funnel experiment — Tier-A (over-gated) vs FREQ (~1 trade/day).
 *
 * Hypothesis: filters that only crush N (ADX/HTF/Tier-A/regime/vol) removed;
 * keep real auction setups; picker capped at 1/day.
 *
 * Usage (from backend/):
 *   node scripts/backtest-vp-freq-funnel.mjs
 *   FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BNBUSDT,ETHUSDT node scripts/backtest-vp-freq-funnel.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const TF = process.env.TF || "15m";
const RISK = Number(process.env.RISK || 2.5);
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT,BTCUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);
const weeks = days / 7;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectVolumeProfilePicks } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_15M,
  resolveVolumeProfileFreqPreset,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

/** Additive quality: FREQ base + one soft confirm at a time (for next iteration if FREQ loses). */
const VARIANTS = [
  {
    id: "tier_a",
    label: "Tier-A baseline (over-gated)",
    presetFor: () => VOLUME_PROFILE_15M,
  },
  {
    id: "freq",
    label: "FREQ coin-resolved (BNB no-rej / ETH soft HTF)",
    presetFor: (sym) => resolveVolumeProfileFreqPreset(sym),
  },
];

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${t.entryTs}_${t.direction ?? t.side}`;
    if (!m.has(k)) m.set(k, { pnl: 0, win: false, setup: t.vpSetup });
    const row = m.get(k);
    row.pnl += Number(t.netPnl ?? 0);
    if (row.pnl > 0) row.win = true;
  }
  return [...m.values()];
}

function setupBreakdown(trades) {
  const acc = {};
  for (const t of trades) {
    const k = t.vpSetup || t.reason || "?";
    if (!acc[k]) acc[k] = { n: 0, pnl: 0 };
    acc[k].n += 1;
    acc[k].pnl += Number(t.netPnl ?? 0);
  }
  return acc;
}

async function runVariant(symbol, variant) {
  await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs);
  if (candles.length < 700) return { symbol, variant: variant.id, error: `candles=${candles.length}` };

  const cfg = {
    ...(typeof variant.presetFor === "function" ? variant.presetFor(symbol) : variant.preset),
    symbol,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
  };

  const picks = selectVolumeProfilePicks(candles, cfg);
  const adapters = await buildBacktestAdapters({
    strategyKey: "VOLUME_PROFILE",
    cfg,
    symbol,
    tf: TF,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters,
    symbol,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });

  const windowTrades = (sim.trades ?? []).filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const logical = logicalTrades(windowTrades);
  const m = computeAllMetrics({
    trades: windowTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });

  return {
    symbol,
    variant: variant.id,
    label: variant.label,
    candidates: picks.candidateCount,
    picks: picks.pickedCount,
    trades: logical.length,
    tradesPerDay: +(logical.length / days).toFixed(3),
    tradesPerWeek: +(logical.length / weeks).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    setups: setupBreakdown(windowTrades),
  };
}

console.log(`\n══ VP FREQUENCY FUNNEL ══`);
console.log(`${FROM} → ${TO}  (${days.toFixed(0)}d)  ${TF}  risk ${RISK}%`);
console.log(`Target: ~1 trade/day/coin, return>0, PF≥1\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const v of VARIANTS) {
    process.stderr.write(`Running ${sym} ${v.id}…\n`);
    rows.push(await runVariant(sym, v));
  }
}

function pad(s, w) {
  return String(s).padEnd(w);
}

console.log("Results:");
console.log(
  `${pad("symbol", 10)} ${pad("variant", 18)} ${pad("cand", 5)} ${pad("tr", 5)} ${pad("t/day", 6)} ${pad("t/wk", 5)} ${pad("WR%", 6)} ${pad("ret%", 8)} ${pad("PF", 6)} DD%`,
);
console.log("─".repeat(90));
for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.symbol, 10)} ${pad(r.variant, 18)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${pad(r.symbol, 10)} ${pad(r.variant, 18)} ${pad(r.candidates, 5)} ${pad(r.trades, 5)} ${pad(r.tradesPerDay, 6)} ${pad(r.tradesPerWeek, 5)} ${pad(r.wr, 6)} ${pad(r.ret, 8)} ${pad(r.pf, 6)} ${r.dd}`,
  );
}

const targetDay = 0.8; // ~1/day with some slack
console.log("\nVs target (≥0.8 t/day, ret>0, PF≥1):");
for (const r of rows.filter((x) => x.variant === "freq" && !x.error)) {
  const okFreq = r.tradesPerDay >= targetDay;
  const okEdge = r.ret > 0 && r.pf >= 1;
  console.log(
    `  ${r.symbol} freq: ${okFreq ? "FREQ_OK" : "FREQ_LOW"} ${r.tradesPerDay}/day | ${okEdge ? "EDGE_OK" : "EDGE_FAIL"} ret=${r.ret}% PF=${r.pf}`,
  );
  console.log(`    setups: ${JSON.stringify(r.setups)}`);
}

const outPath = path.join(__dirname, ".vp-freq-funnel-results.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      window: `${FROM}→${TO}`,
      risk: RISK,
      symbols: SYMBOLS,
      target: { tradesPerDay: 1, minReturnPct: 0, minPf: 1 },
      rows,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);

await closePool?.();
