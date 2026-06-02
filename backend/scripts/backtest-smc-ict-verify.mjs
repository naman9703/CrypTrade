#!/usr/bin/env node
/**
 * SMC/ICT 7-layer verification framework.
 * Usage: node scripts/backtest-smc-ict-verify.mjs [from] [to] [--layers=1,2,3,4,5,6]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const argv = process.argv.slice(2);
const layerArg = argv.find((a) => a.startsWith("--layers="));
const layers = new Set(
  (layerArg ? layerArg.split("=")[1] : "1,2,3,4,5,6").split(",").map((x) => Number(x.trim())),
);
const args = argv.filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const WARMUP = 100;
const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";

const {
  INTRADAY_PRO_ICT_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  buildIntradayBacktestAdapter,
  mergeAdaptiveCfg,
  precomputeIntraday,
  buildIntradayOptsFromCfg,
  selectIntradayPicks,
} = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { evaluateSmcIctSetup, countSmcFunnelStages } = await import("../src/strategy/evaluateSmcIctSetup.js");
const { scanSessionLiquidityCycles, computeLiquidityBrackets, dayStartIndex } = await import("../src/strategy/techniques/liquidity.js");
const { detectChochInRange } = await import("../src/strategy/techniques/bosChoch.js");
const { attachSmcHtfToPre } = await import("../src/strategy/techniques/htfBias.js");

function barIdx(candles, tsMs) {
  const t = Number(tsMs);
  let idx = candles.findIndex((c) => c.ts === t);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs(candles[0].ts - t);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD <= 60_000 ? best : -1;
}

function utcHour(tsMs) {
  return new Date(tsMs).getUTCHours() + new Date(tsMs).getUTCMinutes() / 60;
}

function killzoneBucket(tsMs) {
  const h = utcHour(tsMs);
  if (h >= 7 && h < 10) return "london";
  if (h >= 13.5 && h < 16) return "ny";
  return "other";
}

function wilsonCi(wins, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lo: Math.round(((centre - margin) / denom) * 1000) / 10,
    hi: Math.round(((centre + margin) / denom) * 1000) / 10,
  };
}

async function loadCandles(sym, timeframe, startMs, endMs) {
  return readCandles(sym, timeframe, startMs - 5 * 864e5, endMs);
}

async function runCfg(rawCfg, candles, windowFrom, windowTo, label) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...rawCfg, symbol: symFrom(rawCfg, candles), timeframe: tfFrom(rawCfg) },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: cfg.timeframe,
    symbol: cfg.symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, cfg.timeframe) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = out.trades.filter((t) => t.entryTs >= windowFrom && t.entryTs <= windowTo);
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  return {
    label,
    cfg: merged,
    trades,
    entries: n,
    wins,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    pnls,
    wrCi95: wilsonCi(wins, n),
  };
}

function symFrom(raw, candles) {
  return raw.symbol || symbol;
}
function tfFrom(raw) {
  return raw.timeframe || tf;
}

function forensicTrade(trade, candles, pre, cfg) {
  const liq = trade.liqContext ?? {};
  const meta = liq.smcMeta ?? {};
  const side = trade.direction;
  const entryIdx = meta.entryIdx ?? barIdx(candles, trade.entryTs);
  const reclaimIdx = meta.sweepReclaimIdx ?? meta.reclaimIdx;
  const sweepWickIdx = meta.sweepWickIdx;
  const level = Number(meta.sweepLevel ?? liq.level ?? 0);
  const levelType = meta.levelType ?? liq.levelType ?? "";
  const wick = Number(liq.sweepWick ?? meta.sweepWick ?? 0);
  const opposing = Number(liq.opposingLevel ?? 0);
  const sl = Number(trade.slPrice ?? 0);
  const tp = Number(trade.tpPrice ?? 0);
  const buf = Number(cfg.intradayLiqSlBufferPct ?? cfg.slBufferPct ?? 0.001);
  const maxTpRr = Number(cfg.intradaySmcMaxTpRr ?? cfg.intradayLiqMaxTpRr ?? 0);

  const issues = [];
  const checks = {};

  if (!meta.entryIdx && !liq.smcMeta) {
    issues.push("MISSING_smcMeta — cannot reconstruct trade");
    return { tradeId: trade.entryTs, side, issues, checks, pass: false };
  }

  const wBar = candles[sweepWickIdx];
  const rBar = candles[reclaimIdx];
  const eBar = candles[entryIdx];
  if (!wBar || !rBar || !eBar) {
    issues.push("INVALID_bar_indices_in_meta");
    return { tradeId: trade.entryTs, side, issues, checks, pass: false };
  }

  // 1. Sweep wick poked through PDH/PDL
  if (side === "BUY") {
    checks.sweepWickBelowLevel = wBar.low < level;
    checks.levelTypePdl = levelType === "pdl";
    if (!checks.sweepWickBelowLevel) issues.push("sweep_wick_did_not_poke_below_level");
  } else {
    checks.sweepWickAboveLevel = wBar.high > level;
    checks.levelTypePdh = levelType === "pdh";
    if (!checks.sweepWickAboveLevel) issues.push("sweep_wick_did_not_poke_above_level");
  }

  // 2. Reclaim close through level (same bar as entry for sweep)
  if (side === "BUY") {
    checks.reclaimCloseAboveLevel = rBar.close > level;
    if (!checks.reclaimCloseAboveLevel) issues.push("reclaim_close_not_above_level");
  } else {
    checks.reclaimCloseBelowLevel = rBar.close < level;
    if (!checks.reclaimCloseBelowLevel) issues.push("reclaim_close_not_below_level");
  }
  checks.reclaimSameBarAsEntry = reclaimIdx === entryIdx;
  checks.reclaimWithinOneBarOfEntry = Math.abs(reclaimIdx - entryIdx) <= 1;
  if (!checks.reclaimWithinOneBarOfEntry) issues.push("entry_not_on_reclaim_bar");

  // 3. SL beyond sweep wick
  if (side === "BUY") {
    checks.slBeyondWick = sl > 0 && sl < wick;
    checks.slHasBuffer = sl <= wick * (1 - buf * 0.5);
    if (!checks.slBeyondWick) issues.push("SL_not_below_sweep_wick");
  } else {
    checks.slBeyondWick = sl > 0 && sl > wick;
    checks.slHasBuffer = sl >= wick * (1 + buf * 0.5);
    if (!checks.slBeyondWick) issues.push("SL_not_above_sweep_wick");
  }

  // 4. TP at opposing liquidity (may be capped)
  const entry = Number(trade.entryPrice);
  const risk = Math.abs(entry - sl);
  let expectedTpRaw = opposing;
  let expectedTpCapped = opposing;
  if (maxTpRr > 0 && risk > 0) {
    expectedTpCapped =
      side === "BUY" ? Math.min(opposing, entry + maxTpRr * risk) : Math.max(opposing, entry - maxTpRr * risk);
  }
  checks.tpAtOpposingPool = opposing > 0 && Math.abs(tp - opposing) / opposing < 0.002;
  checks.tpCappedByMaxRr = maxTpRr > 0 && Math.abs(tp - expectedTpCapped) / Math.max(expectedTpCapped, 1e-9) < 0.005;
  checks.tpUsesOpposingNotFixedMultiple = opposing > 0;
  if (!checks.tpAtOpposingPool && !checks.tpCappedByMaxRr) {
    issues.push("TP_neither_opposing_nor_maxRr_cap");
  }
  if (checks.tpCappedByMaxRr && !checks.tpAtOpposingPool) {
    checks.tpNote = `TP capped at ${maxTpRr}R (intradaySmcMaxTpRr), not raw PDH/PDL`;
  }

  // 5. Entry bar index matches smcMeta
  const tsIdx = barIdx(candles, trade.entryTs);
  checks.metaEntryIdx = entryIdx;
  checks.entryTsBarIdx = tsIdx;
  checks.entryIdxMatches = tsIdx === entryIdx || Math.abs(tsIdx - entryIdx) <= 1;
  if (!checks.entryIdxMatches) issues.push("entry_bar_index_mismatch");

  return {
    tradeId: new Date(trade.entryTs).toISOString(),
    side,
    levelType,
    level,
    wick,
    opposing,
    sl,
    tp,
    entryIdx,
    reclaimIdx,
    sweepWickIdx,
    netPnl: trade.netPnl,
    checks,
    issues,
    pass: issues.length === 0,
    metaComplete: Boolean(meta.sweepLevel && meta.sweepReclaimIdx != null && meta.entryIdx != null),
  };
}

function expectancyLayer(trades) {
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.entries()].map(([ts, pnl]) => ({ ts, pnl, roiPct: (pnl / 10_000) * 100 }));
  pnls.sort((a, b) => b.pnl - a.pnl);
  const wins = pnls.filter((p) => p.pnl > 0);
  const losses = pnls.filter((p) => p.pnl <= 0);
  const n = pnls.length;
  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? wins.reduce((s, p) => s + p.roiPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, p) => s + p.roiPct, 0) / losses.length) : 0;
  const expectancyPct = winRate * avgWin - (1 - winRate) * avgLoss;
  const totalReturn = pnls.reduce((s, p) => s + p.roiPct, 0);
  const top3Share = pnls.slice(0, 3).reduce((s, p) => s + Math.max(0, p.pnl), 0);
  const grossWin = wins.reduce((s, p) => s + p.pnl, 0);
  return {
    trades: n,
    winRatePct: Math.round(winRate * 1000) / 10,
    avgWinRoiPct: Math.round(avgWin * 100) / 100,
    avgLossRoiPct: Math.round(avgLoss * 100) / 100,
    expectancyPerTradePct: Math.round(expectancyPct * 100) / 100,
    totalReturnPct: Math.round(totalReturn * 100) / 100,
    top3TradesShareOfGrossWinPct:
      grossWin > 0 ? Math.round((top3Share / grossWin) * 1000) / 10 : null,
    edgeFragile: grossWin > 0 && top3Share / grossWin > 0.8,
    pnlDistribution: pnls.map((p) => ({
      ts: new Date(p.ts).toISOString().slice(0, 16),
      roiPct: Math.round(p.roiPct * 100) / 100,
    })),
  };
}

function simulateRandomBatch(candles, entryTemplate, nTrades, startingEquity = 10_000, riskPct = 2.5) {
  const validFrom = WARMUP;
  const validTo = candles.length - 50;
  const hours = entryTemplate.map((e) => utcHour(e.ts));
  let equity = startingEquity;
  for (let k = 0; k < nTrades; k++) {
    const tpl = entryTemplate[Math.floor(Math.random() * entryTemplate.length)];
    const targetHour = hours[Math.floor(Math.random() * hours.length)];
    let idx = validFrom + Math.floor(Math.random() * (validTo - validFrom));
    for (let attempt = 0; attempt < 30; attempt++) {
      const h = utcHour(candles[idx].ts);
      if (Math.abs(h - targetHour) < 1.5) break;
      idx = validFrom + Math.floor(Math.random() * (validTo - validFrom));
    }
    const side = tpl.side;
    const entry = candles[idx].close;
    const slPct = tpl.slPct;
    const tpPct = tpl.tpPct;
    const sl = side === "BUY" ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = side === "BUY" ? entry * (1 + tpPct) : entry * (1 - tpPct);
    const riskUsd = equity * (riskPct / 100);
    const riskPerUnit = Math.abs(entry - sl);
    if (riskPerUnit <= 0) continue;
    const qty = riskUsd / riskPerUnit;
    let exitPx = entry;
    for (let j = idx + 1; j < Math.min(idx + 48, candles.length); j++) {
      const b = candles[j];
      if (side === "BUY") {
        if (b.low <= sl) {
          exitPx = sl;
          break;
        }
        if (b.high >= tp) {
          exitPx = tp;
          break;
        }
      } else {
        if (b.high >= sl) {
          exitPx = sl;
          break;
        }
        if (b.low <= tp) {
          exitPx = tp;
          break;
        }
      }
      exitPx = b.close;
    }
    const pnl = side === "BUY" ? (exitPx - entry) * qty : (entry - exitPx) * qty;
    equity += pnl * 0.999;
  }
  return Math.round(((equity - startingEquity) / startingEquity) * 10000) / 100;
}

function randomnessLayer(candles, trades, cfg, iterations = 200) {
  const template = [];
  for (const t of trades) {
    const liq = t.liqContext ?? {};
    const entry = Number(t.entryPrice);
    const sl = Number(t.slPrice);
    if (!entry || !sl) continue;
    const slPct = Math.abs(entry - sl) / entry;
    const tp = Number(t.tpPrice);
    const tpPct = tp ? Math.abs(tp - entry) / entry : slPct * (liq.rr ?? 2);
    template.push({ ts: t.entryTs, side: t.direction, slPct, tpPct });
  }
  if (!template.length) return { error: "no_trades_for_template" };
  const actualReturn = trades.reduce((s, t) => s + Number(t.netPnl ?? 0), 0) / 100;
  const randomReturns = [];
  for (let i = 0; i < iterations; i++) {
    randomReturns.push(simulateRandomBatch(candles, template, template.length));
  }
  randomReturns.sort((a, b) => a - b);
  const pct = (p) => randomReturns[Math.floor(p * (randomReturns.length - 1))];
  const rank = randomReturns.filter((r) => r < actualReturn).length / randomReturns.length;
  return {
    actualReturnPct: Math.round(actualReturn * 100) / 100,
    randomIterations: iterations,
    randomMedianPct: pct(0.5),
    randomP5Pct: pct(0.05),
    randomP95Pct: pct(0.95),
    actualPercentile: Math.round(rank * 1000) / 10,
    passes95th: rank >= 0.95,
    interpretation:
      rank >= 0.95
        ? "Actual return above 95th pct of random — evidence of edge beyond drift"
        : rank >= 0.75
          ? "Actual return elevated but may partly reflect market drift"
          : "Actual return not distinguishable from random bar entries",
  };
}

function killzoneLayer(trades) {
  const buckets = { london: [], ny: [], other: [] };
  for (const t of trades) {
    const b = killzoneBucket(t.entryTs);
    buckets[b].push(Number(t.netPnl ?? 0));
  }
  function stats(arr) {
    const n = arr.length;
    const wins = arr.filter((p) => p > 0).length;
    const pnl = arr.reduce((a, b) => a + b, 0);
    return {
      trades: n,
      winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
      returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(buckets)) out[k] = stats(v);
  out.recommendKillzoneFilter =
    out.london.trades + out.ny.trades >= 10 &&
    out.london.winRatePct + out.ny.winRatePct > out.other.winRatePct * 2 - 20;
  return out;
}

function findNearMiss(candles, pre, opts, pickedEntryTs) {
  const nearMisses = [];
  for (let i = WARMUP; i < candles.length; i++) {
    if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
    for (const side of ["BUY", "SELL"]) {
      const st = countSmcFunnelStages(candles, i, side, pre, opts);
      if (!st.hasCycle) continue;
      const setup = evaluateSmcIctSetup(candles, i, side, pre, opts);
      if (setup && setup.entryIdx === i) continue;
      let reason = "unknown";
      if (!st.passHtf) reason = "failed_htf_bias";
      else if (!st.passVol) reason = "failed_volatility";
      else if (!setup) reason = "setup_eval_null";
      else if (setup.entryIdx !== i) reason = "entry_not_this_bar";
      nearMisses.push({
        ts: new Date(candles[i].ts).toISOString(),
        idx: i,
        side,
        reason,
        funnel: st,
      });
      if (nearMisses.length >= 200) break;
    }
    if (nearMisses.length >= 200) break;
  }
  const picked = new Set(pickedEntryTs);
  const scoredButNotPicked = [];
  const { series } = selectIntradayPicks(candles, opts);
  const pickedIdx = new Set();
  for (let pi = 0; pi < series.length; pi++) {
    if (series[pi]?.action) pickedIdx.add(pi);
  }
  for (let i = WARMUP; i < candles.length; i++) {
    if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
    for (const side of ["BUY", "SELL"]) {
      const setup = evaluateSmcIctSetup(candles, i, side, pre, opts);
      if (!setup || setup.entryIdx !== i) continue;
      if (!pickedIdx.has(i)) {
        scoredButNotPicked.push({
          ts: new Date(candles[i].ts).toISOString(),
          idx: i,
          side,
          score: setup.score,
          reason: "valid_setup_not_picked",
        });
      }
    }
  }
  return {
    funnelRejectSample: nearMisses.slice(0, 3),
    notPickedSample: scoredButNotPicked.slice(0, 3),
    totalFunnelRejects: nearMisses.length,
    totalValidNotPicked: scoredButNotPicked.length,
  };
}

function forensicNearMiss(candles, pre, miss, opts) {
  const i = miss.idx;
  const side = miss.side;
  const dayStart = dayStartIndex(candles, i);
  const pdh = pre.prevDayHigh?.[i];
  const pdl = pre.prevDayLow?.[i];
  const level = side === "BUY" ? pdl : pdh;
  const opposing = side === "BUY" ? pdh : pdl;
  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? 0.003);
  const levelType = side === "BUY" ? "pdl" : "pdh";
  const cycles = scanSessionLiquidityCycles(candles, i, side, level, opposing, levelType, sweepPct, dayStart, opts);
  const cycle = cycles.find((c) => c.reclaimIdx <= i) ?? cycles.at(-1);
  return {
    ...miss,
    hadCycle: Boolean(cycle),
    cycleReclaimIdx: cycle?.reclaimIdx ?? null,
    rejectReason: miss.reason,
  };
}

function chochForensic(trade, candles, opts) {
  const meta = trade.liqContext?.smcMeta ?? {};
  const chochIdx = meta.chochIdx;
  const side = trade.direction;
  if (chochIdx == null || chochIdx < 0) return { pass: false, issue: "no_choch_in_meta" };
  const bar = candles[chochIdx];
  const chochLevel = Number(meta.chochLevel ?? 0);
  const reclaimIdx = meta.sweepReclaimIdx ?? 0;
  const redetect = detectChochInRange(candles, reclaimIdx, meta.entryIdx ?? chochIdx, side, {
    ...opts,
    intradaySmcChochStrict: opts.intradaySmcChochStrict,
    intradaySmcChochRequireTrend: opts.intradaySmcChochRequireTrend,
  });
  const bodyBreak =
    side === "BUY"
      ? bar.close > chochLevel && bar.close > bar.open
      : bar.close < chochLevel && bar.close < bar.open;
  return {
    chochIdx,
    chochLevel,
    chochType: meta.chochType,
    bodyCloseBreak: bodyBreak,
    redetectOk: redetect.ok,
    redetectIdx: redetect.chochIdx,
    idxMatch: redetect.chochIdx === chochIdx,
    pass: redetect.ok && bodyBreak,
  };
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await loadCandles(symbol, tf, fromMs, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles");
  process.exit(1);
}

const report = {
  window: { symbol, tf, from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10) },
  layers: {},
};

const pre = precomputeIntraday(candles);
attachSmcHtfToPre(candles, pre);
const sweepCfg = materializeIntradayEngineCfgSync(
  { ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf },
  materializeIntradayPanelOnCfg,
);
const sweepOpts = buildIntradayOptsFromCfg(mergeAdaptiveCfg(sweepCfg, candles));

if (layers.has(1) || layers.has(2) || layers.has(3) || layers.has(6)) {
  process.stderr.write("Running sweep preset backtest...\n");
  const sweepRun = await runCfg(INTRADAY_PRO_ICT_15M, candles, fromMs, toMs, "preset_sweep");
  report.layers.sweepBaseline = {
    entries: sweepRun.entries,
    winRatePct: sweepRun.winRatePct,
    returnPct: sweepRun.returnPct,
  };

  if (layers.has(1)) {
    const sorted = [...sweepRun.trades].sort((a, b) => Number(b.netPnl ?? 0) - Number(a.netPnl ?? 0));
    const winners = sorted.filter((t) => Number(t.netPnl) > 0).slice(0, 2);
    const losers = sorted.filter((t) => Number(t.netPnl) <= 0).slice(-2);
    const nearMissInfo = findNearMiss(
      candles,
      pre,
      sweepOpts,
      sweepRun.trades.map((t) => t.entryTs),
    );
    const nearMiss = nearMissInfo.funnelRejectSample[0] ?? nearMissInfo.notPickedSample[0];
    const forensicSamples = [
      ...winners.map((t, i) => ({ kind: `winner_${i + 1}`, ...forensicTrade(t, candles, pre, sweepRun.cfg) })),
      ...losers.map((t, i) => ({ kind: `loser_${i + 1}`, ...forensicTrade(t, candles, pre, sweepRun.cfg) })),
    ];
    if (nearMiss) {
      forensicSamples.push({
        kind: "near_miss_rejected",
        ...forensicNearMiss(candles, pre, nearMiss, sweepOpts),
      });
    }
    const passCount = forensicSamples.filter((f) => f.pass).length;
    report.layers.layer1_forensics = {
      samples: forensicSamples,
      passRate: `${passCount}/${forensicSamples.filter((f) => f.kind !== "near_miss_rejected").length}`,
      nearMissStats: nearMissInfo,
      finding:
        passCount === forensicSamples.filter((f) => f.kind !== "near_miss_rejected").length
          ? "All sampled trades reconstruct from smcMeta; sweep/reclaim/SL logic consistent"
          : "Signal-level issues found — see issues[] per trade",
      tpCapNote:
        "Preset uses intradaySmcMaxTpRr=3 — TP is often capped at 3R, not raw opposing PDH/PDL (by design for intraday hold horizon)",
    };
  }

  if (layers.has(2)) {
    report.layers.layer2_expectancy = expectancyLayer(sweepRun.trades);
  }

  if (layers.has(3)) {
    process.stderr.write("Layer 3 randomness test (200 iter)...\n");
    report.layers.layer3_randomness = randomnessLayer(candles, sweepRun.trades, sweepRun.cfg, 200);
  }

  if (layers.has(6)) {
    report.layers.layer6_killzone = killzoneLayer(sweepRun.trades);
  }
}

if (layers.has(4)) {
  process.stderr.write("Layer 4 out-of-sample...\n");
  const oos = [];
  await initPool({ info: () => {}, warn: () => {}, error: console.error });
  const bnbEarly = await loadCandles("BNBUSDT", "15m", Date.parse("2025-06-01"), Date.parse("2025-12-31"));
  const ethSame = await loadCandles("ETHUSDT", "15m", fromMs, toMs);
  const bnb5m = await loadCandles("BNBUSDT", "5m", fromMs, toMs);
  const bnb1h = await loadCandles("BNBUSDT", "1h", fromMs, toMs);
  await closePool();

  if (bnbEarly.length) {
    oos.push(
      await runCfg(
        INTRADAY_PRO_ICT_15M,
        bnbEarly,
        Date.parse("2025-06-01"),
        Date.parse("2025-12-31"),
        "BNB_15m_2025H2_OOS",
      ),
    );
  }
  if (ethSame.length) {
    oos.push(await runCfg({ ...INTRADAY_PRO_ICT_15M, symbol: "ETHUSDT" }, ethSame, fromMs, toMs, "ETH_15m_same_window"));
  }
  if (bnb5m.length) {
    oos.push(await runCfg({ ...INTRADAY_PRO_ICT_15M, timeframe: "5m" }, bnb5m, fromMs, toMs, "BNB_5m_same_window"));
  }
  if (bnb1h.length) {
    oos.push(await runCfg({ ...INTRADAY_PRO_ICT_15M, timeframe: "1h" }, bnb1h, fromMs, toMs, "BNB_1h_same_window"));
  }
  report.layers.layer4_oos = oos.map((r) => ({
    label: r.label,
    entries: r.entries,
    winRatePct: r.winRatePct,
    returnPct: r.returnPct,
    wrCi95: r.wrCi95,
  }));
  const inSample = report.layers.sweepBaseline;
  report.layers.layer4_oosVerdict =
    oos.every((r) => r.returnPct < 0) && inSample?.returnPct > 0
      ? "Likely curve-fit to BNB 15m tuning window — OOS configs all negative"
      : oos.some((r) => r.returnPct > 10 && r.entries >= 20)
        ? "Edge transfers across at least one OOS slice"
        : "Mixed OOS — edge may be period/asset specific";
}

if (layers.has(5)) {
  process.stderr.write("Layer 5 CHoCH diagnostic...\n");
  const chochOnly = {
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRequireChoch: true,
    intradaySmcChochStrict: false,
  };
  const chochRetrace = {
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRequireChoch: true,
    intradaySmcRequireRetrace: true,
    intradaySmcChochStrict: false,
  };
  const base = await runCfg(INTRADAY_PRO_ICT_15M, candles, fromMs, toMs, "sweep_base");
  const choch = await runCfg(chochOnly, candles, fromMs, toMs, "sweep_choch_only");
  const both = await runCfg(chochRetrace, candles, fromMs, toMs, "sweep_choch_retrace");
  const chochForensics = choch.trades.slice(0, 5).map((t, i) => ({
    n: i + 1,
    ...chochForensic(t, candles, choch.cfg),
    netPnl: t.netPnl,
    entryTs: new Date(t.entryTs).toISOString(),
  }));
  report.layers.layer5_choch = {
    configs: [
      { label: base.label, entries: base.entries, winRatePct: base.winRatePct, returnPct: base.returnPct, wrCi95: base.wrCi95 },
      { label: choch.label, entries: choch.entries, winRatePct: choch.winRatePct, returnPct: choch.returnPct, wrCi95: choch.wrCi95 },
      { label: both.label, entries: both.entries, winRatePct: both.winRatePct, returnPct: both.returnPct, wrCi95: both.wrCi95 },
    ],
    chochForensicsSample: chochForensics,
    interpretation:
      both.returnPct > choch.returnPct && both.entries < choch.entries
        ? "Interpretation C likely — CHoCH+Retrace partially recovers vs CHoCH alone (entry timing)"
        : choch.wrCi95.lo < 40 && choch.entries >= 40
          ? "Interpretation A possible — WR drop may be noise (wide CI)"
          : chochForensics.filter((f) => !f.pass).length >= 3
            ? "Interpretation B possible — CHoCH detector may misfire on shallow pullbacks"
            : "CHoCH collapse likely structural filter + late reclaim entry, not detector bug",
  };
}

report.layers.layer7_liveTracking = {
  status: "not_applicable_offline",
  trackOnLive: [
    "entryPrice vs signalBar nextOpen (slippage gap)",
    "actual SL distance % vs liqBrackets.slPct logged in backtest",
    "days to TP/SL vs backtest avg barsHeld",
  ],
  thresholds: {
    slippageGapWarnPct: 0.3,
    slDistanceDriftWarnPct: 15,
    holdTimeDriftWarnFactor: 1.5,
  },
};

const outPath = path.resolve(__dirname, "../.data/smc-ict-verify.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.stderr.write(`Wrote ${outPath}\n`);
