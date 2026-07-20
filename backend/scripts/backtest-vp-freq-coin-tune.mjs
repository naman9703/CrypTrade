#!/usr/bin/env node
/**
 * Per-coin VP FREQ setup autopsy + coin-resolved variant compare.
 * Goal: lift BNB/BTC expectancy without crushing frequency below ~1.2 trades/week.
 *
 * Usage (backend/):
 *   FROM=2025-06-01 TO=2026-05-31 node scripts/backtest-vp-freq-coin-tune.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-05-31";
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
  VOLUME_PROFILE_FREQ_CORE,
  VOLUME_PROFILE_BASE,
  resolveVolumeProfileFreqPreset,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

/** Uniform open funnel — what UI accidentally applied to all coins (ETH-shaped). */
const UNIFORM_ETH_SHAPED = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  timeframe: TF,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpBuyBreakoutMinHtfSep: 0,
  vpBuyRelaxedMinHtfSep: 0,
  vpBuyHighPathMinPct: 0,
  vpSellBreakdownMinHtfSep: 0,
};

function setupBreakdown(trades) {
  const acc = {};
  for (const t of trades) {
    const k = t.vpSetup || t.reason?.replace(/^vp_/, "") || "?";
    if (!acc[k]) acc[k] = { n: 0, pnl: 0, wins: 0 };
    acc[k].n += 1;
    const pnl = Number(t.netPnl ?? 0);
    acc[k].pnl += pnl;
    if (pnl > 0) acc[k].wins += 1;
  }
  return acc;
}

async function runOne(symbol, id, label, preset) {
  await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs);
  if (candles.length < 700) return { symbol, variant: id, error: `candles=${candles.length}` };

  const cfg = {
    ...preset,
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
  const m = computeAllMetrics({
    trades: windowTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const setups = setupBreakdown(windowTrades);

  return {
    symbol,
    variant: id,
    label,
    candidates: picks.candidateCount,
    picks: picks.pickedCount,
    trades: windowTrades.length,
    tradesPerWeek: +(windowTrades.length / weeks).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    setups,
    allowed: cfg.vpAllowedSetups,
    htfAlign: cfg.vpRequireHtfAlign,
    htfSep: cfg.vpMinHtfSepPct,
  };
}

/** Build coin variants: baseline uniform + resolved + setup ablations for losers. */
function variantsFor(symbol) {
  const resolved = resolveVolumeProfileFreqPreset(symbol);
  const base = [
    { id: "uniform_eth_shaped", label: "Uniform ETH-shaped (all setups + soft HTF)", preset: UNIFORM_ETH_SHAPED },
    { id: "resolved", label: "Coin-resolved FREQ preset", preset: resolved },
  ];

  if (symbol === "BNBUSDT") {
    base.push(
      {
        id: "bnb_long_bias",
        label: "BNB long bias (vah + lvn + naked)",
        preset: {
          ...UNIFORM_ETH_SHAPED,
          vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "naked_poc"],
          vpRequireHtfAlign: true,
          vpMinHtfSepPct: 0.0015,
        },
      },
      {
        id: "bnb_no_val_bd",
        label: "BNB drop val_breakdown only",
        preset: {
          ...UNIFORM_ETH_SHAPED,
          vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "poc_bounce", "va_rejection", "naked_poc"],
        },
      },
      {
        id: "bnb_no_rej_no_bd",
        label: "BNB drop val_bd + va_rejection",
        preset: {
          ...UNIFORM_ETH_SHAPED,
          vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "poc_bounce", "naked_poc"],
        },
      },
      {
        id: "bnb_soft_htf_tighter",
        label: "BNB all setups + HTF sep 0.25%",
        preset: { ...UNIFORM_ETH_SHAPED, vpMinHtfSepPct: 0.0025 },
      },
    );
  }

  if (symbol === "BTCUSDT") {
    base.push(
      {
        id: "btc_no_poc_rej",
        label: "BTC drop poc_bounce + va_rejection",
        preset: {
          ...UNIFORM_ETH_SHAPED,
          vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "naked_poc"],
        },
      },
      {
        id: "btc_a_plus_b_breaks",
        label: "BTC breaks + lvn + naked only",
        preset: {
          ...UNIFORM_ETH_SHAPED,
          vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "naked_poc"],
        },
      },
      {
        id: "btc_htf_tighter",
        label: "BTC all setups + HTF sep 0.25%",
        preset: { ...UNIFORM_ETH_SHAPED, vpMinHtfSepPct: 0.0025 },
      },
    );
  }

  return base;
}

console.log(`\n══ VP FREQ coin tune ══`);
console.log(`${FROM} → ${TO}  (${days.toFixed(0)}d)  ${TF}  risk ${RISK}%\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const v of variantsFor(sym)) {
    process.stderr.write(`Running ${sym} ${v.id}…\n`);
    rows.push(await runOne(sym, v.id, v.label, v.preset));
  }
}

function pad(s, w) {
  return String(s).padEnd(w);
}

console.log("Results:");
console.log(
  `${pad("symbol", 10)} ${pad("variant", 22)} ${pad("tr", 4)} ${pad("t/wk", 5)} ${pad("WR%", 6)} ${pad("ret%", 8)} ${pad("PF", 6)} DD%`,
);
console.log("─".repeat(88));
for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.symbol, 10)} ${pad(r.variant, 22)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${pad(r.symbol, 10)} ${pad(r.variant, 22)} ${pad(r.trades, 4)} ${pad(r.tradesPerWeek, 5)} ${pad(r.wr, 6)} ${pad(r.ret, 8)} ${pad(r.pf, 6)} ${r.dd}`,
  );
}

console.log("\nSetup PnL (uniform_eth_shaped):");
for (const r of rows.filter((x) => x.variant === "uniform_eth_shaped" && !x.error)) {
  console.log(`  ${r.symbol}:`, JSON.stringify(r.setups));
}

const outPath = path.join(__dirname, ".vp-freq-coin-tune-results.json");
fs.writeFileSync(outPath, JSON.stringify({ window: `${FROM}→${TO}`, risk: RISK, rows }, null, 2));
console.log(`\nWrote ${outPath}`);
await closePool?.();
