#!/usr/bin/env node
/**
 * CRT_TBS — backtest all configuration variants.
 * Usage: node scripts/backtest-crt-tbs-sweep.mjs
 * Env: SYMBOL, TF, FROM, TO, RISK
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);

const H4 = 4 * 60 * 60 * 1000;
const D1 = 24 * 60 * 60 * 1000;

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg } = await import("../src/strategy/crtTbsIntraday.js");
const { CRT_TBS_BNB_15M } = await import("../src/strategy/presets/crtTbsOptimized.js");
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padMs = 14 * 86_400_000;
const { crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const candles = await readCandles(SYMBOL, TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

function runOne(label, extra) {
  const cfg = resolveCrtTbsCfg({
    ...CRT_TBS_BNB_15M,
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    ...extra,
  });
  const adapter = buildCrtTbsBacktestAdapter(candles, cfg, TF);
  const sim = runSimulation({
    candles,
    strategyKey: "CRT_TBS",
    cfg: { ...cfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { CRT_TBS: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  return sim.then((s) => {
    const m = computeAllMetrics({
      trades: s.trades,
      equityCurve: s.equityCurve,
      tf: TF,
      startingEquity: 100,
    });
    const list = aggregateSituationEntries(s.trades, fromMs, toMs);
    const wins = list.filter((t) => t.pnlPct > 0).length;
    const wr = list.length ? (wins / list.length) * 100 : 0;
    const days = new Set(list.map((t) => new Date(t.ts).toISOString().slice(0, 10))).size;
    return {
      label,
      ret: m.totalReturnPct ?? 0,
      n: list.length,
      wr,
      dd: m.maxDrawdownPct ?? 0,
      pf: m.profitFactor ?? 0,
      calmar: m.calmar ?? 0,
      cagr: m.cagrPct ?? 0,
      tpd: days > 0 ? list.length / days : 0,
      extra,
    };
  });
}

/** Named presets + single-axis sweeps from deployed base. */
function buildConfigs() {
  const out = [];

  const add = (label, extra) => out.push({ label, extra });

  // ── Deployed & ICT reference ──
  add("01_deployed_preset", {});
  add("02_ict_full_both_choch_kz_pd", {
    crtTradeSides: "BOTH",
    crtRequireChoch: true,
    crtPremiumDiscountFilter: true,
    crtAllowDelayedEntry: true,
    intradaySmcKillzoneEnabled: true,
    intradaySmcKillzoneMode: "LONDON_NY",
  });

  // ── HTF reference candle ──
  add("03_htf_daily", { crtHtfMs: D1 });
  add("04_htf_4h", { crtHtfMs: H4 });

  // ── Trade sides ──
  add("05_sides_LONG", { crtTradeSides: "LONG" });
  add("06_sides_SHORT", { crtTradeSides: "SHORT" });
  add("07_sides_BOTH", { crtTradeSides: "BOTH" });

  // ── Structure confirm ──
  add("08_choch_off", { crtRequireChoch: false });
  add("09_choch_on", { crtRequireChoch: true });
  add("10_mss_only_no_choch", { crtRequireChoch: false, crtRequireMss: true });
  add("11_mss_and_choch", { crtRequireChoch: true, crtRequireMss: true });
  add("12_no_structure_confirm", { crtRequireChoch: false, crtRequireMss: false });

  // ── Killzone ──
  add("13_kz_off", { intradaySmcKillzoneEnabled: false });
  add("14_kz_LONDON_NY", { intradaySmcKillzoneEnabled: true, intradaySmcKillzoneMode: "LONDON_NY" });
  add("15_kz_ALL", { intradaySmcKillzoneEnabled: true, intradaySmcKillzoneMode: "ALL" });
  add("16_kz_LONDON_only", { intradaySmcKillzoneEnabled: true, intradaySmcKillzoneMode: "LONDON" });
  add("17_kz_NY_only", { intradaySmcKillzoneEnabled: true, intradaySmcKillzoneMode: "NY" });

  // ── Premium / discount ──
  add("18_pd_filter_on", { crtPremiumDiscountFilter: true });
  add("19_pd_filter_off", { crtPremiumDiscountFilter: false });

  // ── Entry timing ──
  add("20_delayed_off_immediate_only", { crtAllowDelayedEntry: false });
  add("21_delayed_on", { crtAllowDelayedEntry: true });

  // ── TBS quality ──
  for (const w of [0.25, 0.32, 0.38, 0.42, 0.50]) {
    add(`22_wick_${String(w).replace(".", "")}`, { crtMinTbsWick: w });
  }
  for (const b of [0.20, 0.28, 0.35]) {
    add(`23_body_${String(b).replace(".", "")}`, { crtMinBodyRatio: b });
  }

  // ── CRT range size ──
  for (const a of [0.35, 0.45, 0.55, 0.70]) {
    add(`24_range_atr_${String(a).replace(".", "")}`, { crtMinRangeAtr: a });
  }
  for (const p of [0.0025, 0.0035, 0.005]) {
    add(`25_range_pct_${String(p).replace(".", "")}`, { crtMinRangePct: p });
  }

  // ── Sweep depth ──
  for (const s of [0.0004, 0.0006, 0.001]) {
    add(`26_sweep_${String(s).replace(".", "")}`, { crtSweepPct: s });
  }

  // ── CHoCH window ──
  for (const c of [4, 8, 12, 16]) {
    add(`27_choch_bars_${c}`, { crtChochMaxBars: c });
  }

  // ── Trade caps ──
  add("28_max1_per_day", { crtMaxTradesPerDay: 1 });
  add("29_max2_per_day", { crtMaxTradesPerDay: 2 });
  add("30_max3_per_day", { crtMaxTradesPerDay: 3 });
  add("31_bar_gap_8", { crtMinBarGap: 8 });

  // ── Practical combos (from tuning) ──
  add("32_long_no_choch_kz", { crtTradeSides: "LONG", crtRequireChoch: false });
  add("33_long_no_choch_no_kz", {
    crtTradeSides: "LONG",
    crtRequireChoch: false,
    intradaySmcKillzoneEnabled: false,
  });
  add("34_both_pd_no_delay", {
    crtTradeSides: "BOTH",
    crtPremiumDiscountFilter: true,
    crtAllowDelayedEntry: false,
    crtRequireChoch: true,
  });
  add("35_both_no_pd_choch_kz", {
    crtTradeSides: "BOTH",
    crtPremiumDiscountFilter: false,
    crtRequireChoch: true,
    intradaySmcKillzoneEnabled: true,
  });
  add("36_relaxed_all", {
    crtTradeSides: "BOTH",
    crtRequireChoch: false,
    crtRequireMss: false,
    crtPremiumDiscountFilter: false,
    crtAllowDelayedEntry: true,
    intradaySmcKillzoneEnabled: false,
    crtMinTbsWick: 0.25,
    crtMinRangeAtr: 0.35,
  });
  add("37_strict_all", {
    crtTradeSides: "LONG",
    crtRequireChoch: true,
    crtRequireMss: true,
    crtPremiumDiscountFilter: true,
    crtAllowDelayedEntry: false,
    crtMinTbsWick: 0.42,
    crtMinRangeAtr: 0.70,
    intradaySmcKillzoneEnabled: true,
  });
  add("38_long_choch_no_delay_no_pd", {
    crtTradeSides: "LONG",
    crtRequireChoch: true,
    crtAllowDelayedEntry: false,
    crtPremiumDiscountFilter: false,
  });
  add("39_long_choch_pd_no_delay", {
    crtTradeSides: "LONG",
    crtRequireChoch: true,
    crtAllowDelayedEntry: false,
    crtPremiumDiscountFilter: true,
  });
  add("40_mss_no_kz_both", {
    crtTradeSides: "BOTH",
    crtRequireChoch: false,
    crtRequireMss: true,
    intradaySmcKillzoneEnabled: false,
  });

  // ── Risk (position sizing only) ──
  // handled separately if RISK env set — skip duplicate runs

  // ── Cross: sides × choch × kz (9 combos) ──
  for (const side of ["LONG", "SHORT", "BOTH"]) {
    for (const choch of [true, false]) {
      for (const kz of [true, false]) {
        add(`grid_${side}_choch${choch ? 1 : 0}_kz${kz ? 1 : 0}`, {
          crtTradeSides: side,
          crtRequireChoch: choch,
          intradaySmcKillzoneEnabled: kz,
          crtPremiumDiscountFilter: false,
          crtAllowDelayedEntry: true,
        });
      }
    }
  }

  return out;
}

const configs = buildConfigs();
console.log(`\n=== CRT_TBS CONFIG SWEEP ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% risk ===`);
console.log(`Configs: ${configs.length} | Bars: ${candles.length}\n`);

const results = [];
for (const { label, extra } of configs) {
  const r = await runOne(label, extra);
  results.push(r);
  process.stdout.write(".");
}
console.log("\n");

results.sort((a, b) => b.ret - a.ret);

const hdr =
  "Rank | Return% | Trades | WR%  | MaxDD% | PF    | Calmar | T/day | Config";
console.log(hdr);
console.log("-".repeat(hdr.length + 20));

let rank = 1;
for (const r of results) {
  const retStr = `${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}`.padStart(7);
  console.log(
    `${String(rank).padStart(4)} | ${retStr} | ${String(r.n).padStart(6)} | ${r.wr.toFixed(0).padStart(4)} | ${r.dd.toFixed(1).padStart(6)} | ${r.pf.toFixed(2).padStart(5)} | ${(r.calmar ?? 0).toFixed(2).padStart(6)} | ${r.tpd.toFixed(2).padStart(5)} | ${r.label}`,
  );
  rank++;
}

const positive = results.filter((r) => r.ret > 0);
const deployed = results.find((r) => r.label === "01_deployed_preset");
console.log(`\n--- Summary ---`);
console.log(`Total configs: ${results.length}`);
console.log(`Positive return: ${positive.length} (${((positive.length / results.length) * 100).toFixed(0)}%)`);
console.log(
  `Deployed preset: ${(deployed?.ret ?? 0).toFixed(2)}% | ${deployed?.n ?? 0} trades | WR ${(deployed?.wr ?? 0).toFixed(0)}% | DD ${(deployed?.dd ?? 0).toFixed(1)}%`,
);
if (positive.length) {
  const best = positive[0];
  console.log(`Best: ${best.label} → +${best.ret.toFixed(2)}% (${best.n} trades, WR ${best.wr.toFixed(0)}%, DD ${best.dd.toFixed(1)}%)`);
}
const worst = results[results.length - 1];
console.log(`Worst: ${worst.label} → ${worst.ret.toFixed(2)}% (${worst.n} trades)`);

// Top 10 by Calmar among configs with >= 5 trades
const calmarRank = results
  .filter((r) => r.n >= 5)
  .sort((a, b) => (b.calmar ?? 0) - (a.calmar ?? 0))
  .slice(0, 10);
if (calmarRank.length) {
  console.log(`\n--- Top Calmar (n≥5) ---`);
  for (const r of calmarRank) {
    console.log(`  ${r.label}: ret ${r.ret.toFixed(2)}% Calmar ${(r.calmar ?? 0).toFixed(2)} n=${r.n}`);
  }
}

await closePool();
