#!/usr/bin/env node
/**
 * BTC LIQ sweep+reclaim — full pipeline autopsy (no context filter).
 * Identifies WHY results are weak and frequency is low (~0.06/day vs ~1/day target).
 *
 * Usage: cd backend && node scripts/research-liq-btc-setup-autopsy.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const SYMBOL = "BTCUSDT";
const TF = "15m";
const START = 10_000;
const RISK = Number(process.env.RISK_PCT || 2);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  mergeAdaptiveCfg,
  buildIntradayBacktestAdapter,
  precomputeIntraday,
  buildIntradayOptsFromCfg,
  selectIntradayPicks,
} = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  scanSessionLiquidityCycles,
  listSessionLiquiditySetups,
  computeLiquidityBrackets,
  utcDayId,
  dayStartIndex,
  passesLiqChochGate,
} = await import("../src/strategy/techniques/liquidity.js");
const { isBreakdownDay, isBreakoutDay, vetoClassicalLiqOnTrendDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js",
);

const WARMUP = 100;

/** Baseline BTC classical LIQ — no context filter, no BTC research preset gates. */
function btcBaselinePatch() {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayLiqBreakdownDayBias: false,
    intradayLiqDaySituationBias: false,
    intradayLiqMarketStateGate: false,
    intradayLiqRequireKillzone: false,
    intradayLiqRequireChoch: false,
    intradayLiqPdhPdlOnly: true,
    intradayLiqSessionExtreme: false,
  };
}

function matCfg(patch = {}) {
  return materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, ...btcBaselinePatch(), ...patch },
    materializeIntradayPanelOnCfg,
  );
}

function classifyFailure(trade) {
  const mfe = Number(trade.mfePct ?? 0);
  const pnl = Number(trade.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  if (String(trade.exitReason ?? "").includes("time_stop")) return "time_stop_gave_back";
  if (mfe >= 0.01) return "sl_after_profit";
  return "other_loss";
}

function funnelDiagnose(candles, pre, cfg) {
  const opts = { ...buildIntradayOptsFromCfg(cfg), ...cfg, _liqPre: pre };
  const sweepPct = Number(opts.sweepPct ?? pre.adaptive?.sweepPct ?? 0.001);
  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  const minES = Number(opts.intradayLiqMinEntryScore ?? 0);
  const useES = opts.intradayLiqUseEntryScore === true;

  const counts = {
    reclaimEvents: 0,
    failExtension: 0,
    failMaxSweepBars: 0,
    failSameBar: 0,
    failBrackets: 0,
    failMinRr: 0,
    failReclaimBody: 0,
    failEntryScore: 0,
    failMinScore: 0,
    failChoch: 0,
    failTrendDayVeto: 0,
    passSetup: 0,
    poolBeforePick: 0,
    picked: 0,
  };
  const daysWithReclaim = new Set();
  const daysWithSetup = new Set();

  for (let i = WARMUP; i < candles.length; i++) {
    const day = utcDayId(candles[i].ts);
    const dayStart = dayStartIndex(candles, i);
    const pdh = pre.prevDayHigh[i];
    const pdl = pre.prevDayLow[i];
    if (!(pdh > 0) || !(pdl > 0)) continue;

    for (const side of ["BUY", "SELL"]) {
      const level = side === "BUY" ? pdl : pdh;
      const opposing = side === "BUY" ? pdh : pdl;
      const levelType = side === "BUY" ? "pdl" : "pdh";
      const cycles = scanSessionLiquidityCycles(
        candles,
        i,
        side,
        level,
        opposing,
        levelType,
        sweepPct,
        dayStart,
        opts,
      );
      for (const c of cycles) {
        if (c.reclaimIdx !== i) continue;
        counts.reclaimEvents++;
        daysWithReclaim.add(day);

        if (minExt > 0 && c.extension + 1e-6 < minExt) {
          counts.failExtension++;
          continue;
        }
        const maxBars = Number(opts.intradayLiqMaxSweepBars ?? 40);
        if (maxBars > 0 && c.reclaimIdx - c.sweepStartIdx > maxBars) {
          counts.failMaxSweepBars++;
          continue;
        }
        if (opts.intradayLiqRejectSameBarReclaim === true && c.reclaimIdx === c.sweepStartIdx) {
          counts.failSameBar++;
          continue;
        }
        const bar = candles[i];
        const br = computeLiquidityBrackets(side, bar.close, c.wick, c.opposing, opts);
        if (!br) {
          counts.failBrackets++;
          continue;
        }
        if (minRr > 0 && br.rr < minRr) {
          counts.failMinRr++;
          continue;
        }

        const setups = listSessionLiquiditySetups(candles, i, side, pre, opts);
        const setup = setups.find((s) => s.reclaimIdx === c.reclaimIdx && s.levelType === levelType);
        if (!setup) {
          if (!passesLiqChochGate(candles, c, side, i, opts)) counts.failChoch++;
          else counts.failReclaimBody++;
          continue;
        }
        if (useES && (setup.entryContextScore ?? 0) < minES) {
          counts.failEntryScore++;
          continue;
        }
        if (setup.score < Number(opts.intradayLiqMinScore ?? 5)) {
          counts.failMinScore++;
          continue;
        }
        if (vetoClassicalLiqOnTrendDay(setup, candles, i, pre, opts)) {
          counts.failTrendDayVeto++;
          continue;
        }
        counts.passSetup++;
        daysWithSetup.add(day);
      }
    }
  }

  const picks = selectIntradayPicks(candles, cfg);
  counts.poolBeforePick = picks.candidateCount;
  counts.picked = picks.pickedCount;

  const tradingDays = new Set();
  for (let i = WARMUP; i < candles.length; i++) tradingDays.add(utcDayId(candles[i].ts));

  return {
    counts,
    days: {
      tradingDays: tradingDays.size,
      daysWithReclaim: daysWithReclaim.size,
      daysWithSetup: daysWithSetup.size,
      reclaimPerDay: (counts.reclaimEvents / tradingDays.size).toFixed(2),
      setupPerDay: (counts.passSetup / tradingDays.size).toFixed(2),
    },
  };
}

async function runSim(cfg) {
  clearIntradayAdapterCache();
  const warmup = 21 * 86_400_000;
  const candles = await readCandles(SYMBOL, TF, fromMs - warmup, toMs, { market: "futures" });
  const merged = mergeAdaptiveCfg(cfg, candles);
  const pre = precomputeIntraday(candles);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg: merged,
    gateMode: "off",
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
  });
  const closed = sim.trades.filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const slice = closed.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const m = computeAllMetrics({ trades: slice, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const tradingDays = new Set(
    candles.filter((c) => c.ts >= fromMs && c.ts < toMs).map((c) => utcDayId(c.ts)),
  );
  const tradeDays = new Set(slice.map((t) => utcDayId(t.entryTs)));
  return { candles, pre, merged, slice, m, tradingDays: tradingDays.size, tradeDays: tradeDays.size };
}

console.log(`\n=== BTC LIQ Sweep+Reclaim Autopsy ===`);
console.log(`${FROM} → ${TO} | ${SYMBOL} ${TF} | risk ${RISK}% | no context filter\n`);

const cfg = matCfg();
const { candles, pre, merged, slice, m, tradingDays, tradeDays } = await runSim(cfg);
const funnel = funnelDiagnose(candles, pre, merged);

console.log("--- Hardcoded preset values (BNB-tuned base) ---");
const keys = [
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqMinRr",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqMinEntryScore",
  "intradayLiqOnePickPerDay",
  "intradayLiqMaxTradesPerSidePerDay",
  "srIntradayMaxTradesPerDay",
  "intradayLiqRequireHtfAlign",
  "intradayLiqMaxSlPct",
  "intradayLiqMaxTpRr",
  "intradayLiqMaxHoldBars",
  "srIntradayMinBarGap",
];
for (const k of keys) console.log(`  ${k}: ${merged[k]}`);

console.log("\n--- Funnel (reclaim bar → setup → pick) ---");
console.log(JSON.stringify(funnel, null, 2));

console.log("\n--- Backtest results ---");
console.log(
  `  trades: ${slice.length} | days w/ trade: ${tradeDays}/${tradingDays} (${((tradeDays / tradingDays) * 100).toFixed(1)}%)`,
);
console.log(
  `  freq: ${(slice.length / tradingDays).toFixed(3)}/day (target ~1/day) | return: ${Number(m.totalReturnPct ?? 0).toFixed(1)}% | PF: ${Number(m.profitFactor ?? 0).toFixed(2)} | WR: ${(Number(m.winRate ?? 0) * 100).toFixed(0)}%`,
);

const losers = slice.filter((t) => Number(t.netPnl) <= 0);
const winners = slice.filter((t) => Number(t.netPnl) > 0);
console.log("\n--- Loser failure modes ---");
const failBuckets = {};
for (const t of losers) {
  const f = classifyFailure(t);
  failBuckets[f] = (failBuckets[f] ?? 0) + 1;
}
console.log(failBuckets);

console.log("\n--- Exit reasons ---");
const exits = {};
for (const t of slice) {
  const e = String(t.exitReason ?? "unknown");
  exits[e] = (exits[e] ?? 0) + 1;
}
console.log(exits);

// Breakdown/breakout day analysis on trades
let bdLong = 0;
let boShort = 0;
for (const t of slice) {
  const idx = candles.findIndex((c) => c.ts >= t.entryTs);
  if (idx < 0) continue;
  const liq = t.liqContext ?? t.meta?.liq ?? {};
  const side = t.isLong ? "BUY" : "SELL";
  const lt = liq.levelType ?? "";
  if (side === "BUY" && lt === "pdl" && isBreakdownDay(candles, idx, pre)) bdLong++;
  if (side === "SELL" && lt === "pdh" && isBreakoutDay(candles, idx, pre)) boShort++;
}
console.log("\n--- Structural mismatch (fade on trend day) ---");
console.log(`  long PDL on breakdown day: ${bdLong}/${losers.length} losers context`);
console.log(`  short PDH on breakout day: ${boShort}`);

// Counterfactual: what if we only removed ONE structural hardcoding at a time
const variants = [
  { id: "baseline", patch: {} },
  { id: "no_entry_score", patch: { intradayLiqUseEntryScore: false, intradayLiqMinQuality: 0 } },
  { id: "no_min_rr", patch: { intradayLiqMinRr: 0 } },
  { id: "no_body_ratio", patch: { intradayLiqMinReclaimBodyRatio: 0 } },
  { id: "no_extension_0.4pct", patch: { intradayLiqMinSweepExtensionPct: 0.004 } },
  { id: "no_one_pick_per_day", patch: { intradayLiqOnePickPerDay: false, srIntradayMaxTradesPerDay: 6 } },
  { id: "no_same_bar_reject", patch: { intradayLiqRejectSameBarReclaim: false } },
  { id: "breakdown_veto_only", patch: { intradayLiqBreakdownDayBias: true } },
];

console.log("\n--- Single-knob counterfactuals (not combined tightening) ---");
console.log("id                          trades  t/day  ret%    PF   WR%");
for (const v of variants) {
  const c = matCfg(v.patch);
  const r = await runSim(c);
  const td = r.tradingDays;
  const n = r.slice.length;
  const ret = Number(r.m.totalReturnPct ?? 0);
  const pf = Number(r.m.profitFactor ?? 0);
  const wr = Number(r.m.winRate ?? 0) * 100;
  console.log(
    `${v.id.padEnd(28)} ${String(n).padStart(6)}  ${(n / td).toFixed(2).padStart(5)}  ${ret.toFixed(1).padStart(6)}  ${pf.toFixed(2).padStart(4)}  ${wr.toFixed(0).padStart(3)}`,
  );
}

const out = {
  window: { from: FROM, to: TO },
  symbol: SYMBOL,
  funnel,
  results: {
    trades: slice.length,
    tradeDays,
    tradingDays,
    tradesPerDay: slice.length / tradingDays,
    returnPct: m.totalReturnPct,
    pf: m.profitFactor,
    winRate: m.winRate,
  },
  hardcoded: Object.fromEntries(keys.map((k) => [k, merged[k]])),
  failBuckets,
  exits,
};
const outPath = path.join(__dirname, ".research-liq-btc-setup-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);

await closePool();
