#!/usr/bin/env node
/**
 * BNB LIQ_CORE — root-cause autopsy + optimum liquidity fix A/B.
 *
 * Named failure: false-reclaim / no-follow takes full 1R.
 * Hypothesis: structure re-break of swept level = thesis invalidate (≠ MFE dead-trade).
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-rootcause-optimum.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2023-07-01";
const TO = process.env.TO || "2026-07-01";
const HOLD_FROM = process.env.HOLD_FROM || "2025-07-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdFromMs = Date.parse(HOLD_FROM);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  if (String(t.exitReason || "").includes("time_stop")) return "time_stop_gave_back";
  if (mfe >= 0.01) return "gave_back_after_mfe";
  return "other_loss";
}

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  const byFail = {};
  for (const t of s) {
    const k = failClass(t);
    byFail[k] ??= { n: 0, pnl: 0 };
    byFail[k].n += 1;
    byFail[k].pnl += Number(t.netPnl ?? 0);
  }
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    cal: +(m.calmar ?? 0).toFixed(2),
    byFail,
  };
}

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const t = Number(ts);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].ts);
    if (ct === t) return mid;
    if (ct < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function baseCfg(over = {}) {
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  return materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
}

async function runSim(candles, funding, over = {}) {
  clearIntradayAdapterCache?.();
  const cfg = baseCfg(over);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

/**
 * Soft counterfactual: if swept level re-breaks within maxBars after entry,
 * replace trade PnL with exit at that bar's close (slip approx).
 */
function softLevelRebreak(trades, candles, maxBars, useWick = false) {
  const out = [];
  let rebreakN = 0;
  let rebreakWasInstant = 0;
  let rebreakWasWinner = 0;
  let saved = 0;
  let clipped = 0;

  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const entryIdx = findIdx(candles, t.entryBarTs ?? t.entryTs);
    const level = Number(t.liqLevel ?? t.level ?? t.signalMeta?.level ?? NaN);
    const isLong = !(t.direction === -1 || t.direction === "SELL" || t.direction === "short");
    const entry = Number(t.entryPrice ?? 0);
    const originalPnl = Number(t.netPnl ?? 0);
    const fc = failClass(t);

    if (!(entryIdx >= 0) || !(level > 0) || !(entry > 0)) {
      out.push(t);
      continue;
    }

    let rebreakIdx = -1;
    const end = Math.min(candles.length - 1, entryIdx + maxBars);
    for (let j = entryIdx + 1; j <= end; j++) {
      const b = candles[j];
      const pierced = useWick
        ? isLong
          ? Number(b.low) < level
          : Number(b.high) > level
        : isLong
          ? Number(b.close) < level
          : Number(b.close) > level;
      if (pierced) {
        rebreakIdx = j;
        break;
      }
    }

    if (rebreakIdx < 0) {
      out.push(t);
      continue;
    }

    rebreakN += 1;
    if (fc === "never_green" || fc === "sl_no_follow") rebreakWasInstant += 1;
    if (fc === "winner") rebreakWasWinner += 1;

    const exitPx = Number(candles[rebreakIdx].close);
    const movePct = isLong ? (exitPx - entry) / entry : (entry - exitPx) / entry;
    // Approximate PnL using same risk sizing: scale by original |pnl|/|price move to SL|
    const sl = Number(t.slPrice ?? t.initialSlPrice ?? 0);
    const riskPct = sl > 0 ? Math.abs(entry - sl) / entry : 0.01;
    const riskUsd = Math.abs(originalPnl) > 0 && Number(t.rMultiple ?? 0) !== 0
      ? Math.abs(originalPnl / Number(t.rMultiple))
      : Math.abs(originalPnl) / Math.max(0.01, Math.abs(Number(t.rMultiple ?? 1) || 1));
    // Prefer r-based: newR = movePct / riskPct
    const newR = riskPct > 0 ? movePct / riskPct : movePct / 0.01;
    const approxPnl =
      Number.isFinite(Number(t.rMultiple)) && Math.abs(Number(t.rMultiple)) > 1e-6
        ? (originalPnl / Number(t.rMultiple)) * newR
        : originalPnl * (newR / Math.max(0.01, Math.abs(Number(t.rMultiple) || 1)));

    // Fallback simpler: if we can't scale, use fraction of original loss
    let pnl = Number.isFinite(approxPnl) ? approxPnl : originalPnl * 0.5;
    if (fc === "winner" && pnl < originalPnl) clipped += originalPnl - pnl;
    if ((fc === "never_green" || fc === "sl_no_follow") && pnl > originalPnl) saved += pnl - originalPnl;

    out.push({
      ...t,
      netPnl: pnl,
      exitReason: "soft_level_rebreak",
      rMultiple: newR,
    });
  }

  return {
    trades: out,
    rebreakN,
    rebreakWasInstant,
    rebreakWasWinner,
    saved: +saved.toFixed(2),
    clipped: +clipped.toFixed(2),
  };
}

const pad = 21 * 864e5;
const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
console.log(`BNB rootcause | ${candles.length} bars | ${FROM}→${TO} hold ${HOLD_FROM}+`);

console.log("\n========== 1) BASELINE ==========");
const baseline = await runSim(candles, funding, {});
const baseFull = metrics(baseline, fromMs, toMs);
const baseHold = metrics(baseline, holdFromMs, toMs);
console.log("FULL", baseFull);
console.log("HOLD", baseHold);
console.log("fail $", Object.fromEntries(
  Object.entries(baseFull.byFail).map(([k, v]) => [k, { n: v.n, pnl: +v.pnl.toFixed(2) }]),
));

// Attach level from trade meta if present
const sample = baseline[0] || {};
console.log("\ntrade keys sample:", Object.keys(sample).filter((k) => /liq|level|sl|mfe|reason|meta/i.test(k)));

console.log("\n========== 2) SOFT LEVEL-REBREAK COUNTERFACTUAL ==========");
for (const [label, bars, wick] of [
  ["close@1", 1, false],
  ["close@2", 2, false],
  ["close@3", 3, false],
  ["close@4", 4, false],
  ["wick@2", 2, true],
  ["wick@3", 3, true],
]) {
  const withLevel = baseline.map((t) => {
    const lvl =
      Number(t.liqContext?.level) ||
      Number(t.liqLevel) ||
      Number(t.level) ||
      NaN;
    return { ...t, liqLevel: lvl };
  });
  const hasLevel = withLevel.filter((t) => Number(t.liqLevel) > 0).length;
  const soft = softLevelRebreak(withLevel, candles, bars, wick);
  const f = metrics(soft.trades, fromMs, toMs);
  const h = metrics(soft.trades, holdFromMs, toMs);
  console.log(
    `${label.padEnd(10)} levels=${hasLevel}/${baseline.length} rebreak=${soft.rebreakN} (inst=${soft.rebreakWasInstant} win=${soft.rebreakWasWinner}) | FULL pf=${f.pf} ret=${f.ret} | HOLD pf=${h.pf} ret=${h.ret} | saved=${soft.saved} clipped=${soft.clipped}`,
  );
}

console.log("\n========== 3) HARD A/B (liquidity concepts) ==========");
const variants = [
  ["H0_CORE", {}],
  ["R1_rebreakClose2", { intradayLiqLevelRebreakExitBars: 2, intradayLiqLevelRebreakMode: "close" }],
  ["R2_rebreakClose3", { intradayLiqLevelRebreakExitBars: 3, intradayLiqLevelRebreakMode: "close" }],
  ["R3_rebreakWick2", { intradayLiqLevelRebreakExitBars: 2, intradayLiqLevelRebreakMode: "wick" }],
  ["R4_rebreakClose4", { intradayLiqLevelRebreakExitBars: 4, intradayLiqLevelRebreakMode: "close" }],
  ["E1_maxSl1.2pct", { intradayLiqMaxSlPct: 0.012 }],
  ["E2_maxSl0.8pct", { intradayLiqMaxSlPct: 0.008 }],
  ["E3_postReclaimDisp", { intradayLiqRequirePostReclaimDisplacement: true, intradayLiqPostReclaimDispAtrMult: 0.8 }],
  ["E4_minExt0.5pct", { intradayLiqMinSweepExtensionPct: 0.005 }],
  ["E5_body35", { intradayLiqMinReclaimBodyRatio: 0.35 }],
  ["E6_pokeWick0.4", { intradayLiqMinSweepPokeWickRatio: 0.4 }],
  ["E7_firstCycle", { intradayLiqFirstCycleOnly: true }],
  ["E8_noSameBar", { intradayLiqRejectSameBarReclaim: true }],
  ["E9_hold3", { intradayLiqReclaimHoldBars: 3 }],
  ["E10_hold3_maxSl1.2", { intradayLiqReclaimHoldBars: 3, intradayLiqMaxSlPct: 0.012 }],
  ["E11_hold3_noSame", { intradayLiqReclaimHoldBars: 3, intradayLiqRejectSameBarReclaim: true }],
  ["E12_disp_noSame", { intradayLiqRequirePostReclaimDisplacement: true, intradayLiqPostReclaimDispAtrMult: 0.8, intradayLiqRejectSameBarReclaim: true }],
  ["E13_minRr1.5", { intradayLiqMinRr: 1.5 }],
  ["E14_minRr2", { intradayLiqMinRr: 2 }],
  ["C1_rebreak3_noSame", { intradayLiqLevelRebreakExitBars: 3, intradayLiqRejectSameBarReclaim: true }],
  ["C2_rebreak3_maxSl", { intradayLiqLevelRebreakExitBars: 3, intradayLiqMaxSlPct: 0.012 }],
  ["C3_rebreak3_disp", { intradayLiqLevelRebreakExitBars: 3, intradayLiqRequirePostReclaimDisplacement: true, intradayLiqPostReclaimDispAtrMult: 0.8 }],
];

const rows = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}\n`);
  const trades = await runSim(candles, funding, over);
  const full = metrics(trades, fromMs, toMs);
  const hold = metrics(trades, holdFromMs, toMs);
  const is = metrics(trades, fromMs, holdFromMs);
  const freqOk = full.tw >= baseFull.tw * 0.4; // user accepts bigger N cut
  const holdBetter = hold.pf > baseHold.pf && hold.ret > baseHold.ret;
  const fullBetter = full.pf > baseFull.pf && full.ret > baseFull.ret;
  const promote = holdBetter && (fullBetter || full.pf >= 0.9) && freqOk && hold.n >= 30;
  rows.push({ id, full, hold, is, freqOk, holdBetter, fullBetter, promote });
  console.log(
    `${id.padEnd(22)} FULL n=${full.n} ${full.tw}/wk pf=${full.pf} ret=${full.ret} | HOLD n=${hold.n} pf=${hold.pf} ret=${hold.ret} | promote=${promote}`,
  );
}

const outPath = path.join(__dirname, ".liq-bnb-rootcause-optimum.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      from: FROM,
      to: TO,
      holdFrom: HOLD_FROM,
      baseline: { full: baseFull, hold: baseHold },
      ab: rows,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);
await closePool?.();
