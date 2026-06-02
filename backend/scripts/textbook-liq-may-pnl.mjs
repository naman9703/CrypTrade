#!/usr/bin/env node
/**
 * Textbook liquidity sweep (PDH/PDL + optional session cluster) — bar-by-bar reclaim entries.
 * Not selectIntradayPicks / EOD best-cycle / quality scoring.
 *
 * Usage: node scripts/textbook-liq-may-pnl.mjs [from] [to]
 * Default: BNBUSDT 15m, 2026-05-01 → 2026-05-27
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(`${process.argv[2] || "2026-05-01"}T00:00:00.000Z`);
const toMs = Date.parse(`${process.argv[3] || "2026-05-27"}T00:00:00.000Z`);
const warmupFrom = fromMs - 10 * 86_400_000;
const WARMUP = 200;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const {
  scanSessionLiquidityCycles,
  resolveSessionExtremeLevel,
  computeLiquidityBrackets,
  dayStartIndex,
  utcDayId,
  DEFAULT_LIQ_SWEEP_PCT,
  DEFAULT_LIQ_SL_BUFFER_PCT,
} = await import("../src/strategy/techniques/liquidity.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");

/** Textbook rules only — no bot preset / EOD pick / HTF / quality score gates. */
const TEXTBOOK_OPTS = {
  sweepPct: DEFAULT_LIQ_SWEEP_PCT,
  slBufferPct: DEFAULT_LIQ_SL_BUFFER_PCT,
  intradayLiqMinSweepExtensionPct: 0.003,
  intradayLiqMaxSweepBars: 40,
  intradayLiqMinRr: 0,
  intradayLiqMaxSlPct: 0.05,
  intradayLiqPartialTp: true,
  intradayLiqPartialFrac: 0.5,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 2,
  intradayLiqSessionExtremeMinDistFromSession: 0.005,
  intradayLiqBreakevenAfterPartial: true,
  intradayLiqEntryAtSignalClose: true,
};

function buildTextbookSetup(candles, cycle, side, opts, dayStart) {
  const bar = candles[cycle.reclaimIdx];
  const brackets = computeLiquidityBrackets(side, bar.close, cycle.wick, cycle.opposing, opts);
  if (!brackets) return null;
  return {
    side,
    action: side,
    level: cycle.level,
    levelType: cycle.levelType,
    wick: cycle.wick,
    reclaimIdx: cycle.reclaimIdx,
    extension: cycle.extension,
    entry: bar.close,
    ...brackets,
    techniques: ["liq_sweep", cycle.levelType],
    score: 8,
    reason: `textbook_${cycle.levelType}`,
    liqBrackets: {
      slPct: brackets.slPct,
      tpPct: brackets.tpPct,
      tp1Pct: brackets.tp1Pct,
      slPrice: brackets.slPrice,
      tpPrice: brackets.tp2Price ?? brackets.tpPrice,
      tp1Price: brackets.tp1Price,
      tp2Price: brackets.tp2Price ?? brackets.tpPrice,
      tpMode: brackets.tpMode,
      rr: brackets.rr,
      sweepWick: brackets.sweepWick,
      opposingLevel: brackets.opposingLevel,
      level: cycle.level,
      levelType: cycle.levelType,
      partialTp: brackets.partialTp,
      partialFrac: brackets.partialFrac,
      liqQuality: Math.round(cycle.extension * 1000 + brackets.rr * 100),
    },
  };
}

/** All textbook setups whose reclaim closes within [fromMs, toMs). */
function findTextbookSetupsInRange(candles, pre, fromMs, toMs, opts) {
  const sweepPct = Number(opts.sweepPct ?? DEFAULT_LIQ_SWEEP_PCT);
  const setups = [];

  let startIdx = WARMUP;
  let endIdx = candles.length - 1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].ts >= fromMs && startIdx === WARMUP) startIdx = Math.max(WARMUP, i);
    if (candles[i].ts >= toMs) {
      endIdx = i - 1;
      break;
    }
  }

  for (let i = startIdx; i <= endIdx; i++) {
    const dayStart = dayStartIndex(candles, i);
    const pdh = pre.prevDayHigh?.[i];
    const pdl = pre.prevDayLow?.[i];

    for (const side of ["BUY", "SELL"]) {
      const level = side === "BUY" ? pdl : pdh;
      const opposing = side === "BUY" ? pdh : pdl;
      const levelType = side === "BUY" ? "pdl" : "pdh";
      if (!(level > 0) || !(opposing > 0)) continue;

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
        const s = buildTextbookSetup(candles, c, side, opts, dayStart);
        if (s) setups.push({ idx: i, setup: s });
      }

      const extreme = resolveSessionExtremeLevel(candles, i, side, dayStart, opts);
      const sessionLevel = side === "BUY" ? pdl : pdh;
      if (
        extreme &&
        sessionLevel > 0 &&
        Math.abs(extreme.level - sessionLevel) / sessionLevel >
          Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005)
      ) {
        const opp = side === "BUY" ? pdh : pdl;
        if (opp > 0) {
          const clusterCycles = scanSessionLiquidityCycles(
            candles,
            i,
            side,
            extreme.level,
            opp,
            extreme.levelType,
            sweepPct,
            dayStart,
            opts,
          );
          for (const c of clusterCycles) {
            if (c.reclaimIdx !== i) continue;
            const s = buildTextbookSetup(candles, c, side, opts, dayStart);
            if (s) setups.push({ idx: i, setup: s });
          }
        }
      }
    }
  }

  /** If PDH + session_high both fire same bar, keep higher extension. */
  const byIdxSide = new Map();
  for (const row of setups) {
    const key = `${row.idx}:${row.setup.action}`;
    const prev = byIdxSide.get(key);
    if (!prev || row.setup.extension > prev.setup.extension) byIdxSide.set(key, row);
  }
  return [...byIdxSide.values()].sort((a, b) => a.idx - b.idx);
}

function buildTextbookAdapter(candles, setups) {
  const series = new Array(candles.length).fill(null);
  for (const { idx, setup } of setups) {
    series[idx] = {
      action: setup.action,
      reason: setup.reason,
      liqBrackets: setup.liqBrackets,
    };
  }
  return function textbookAdapter(bar, idx) {
    const sig = series[idx];
    if (!sig) return null;
    return { action: sig.action, reason: sig.reason, liqBrackets: sig.liqBrackets };
  };
}

if (!getPool?.()) {
  await initPool({ info: () => {}, warn: () => {}, error: console.error });
}

let candles;
try {
  await ensureKlines(symbol, tf, { from: warmupFrom, to: toMs, market: "futures" });
} catch {
  /* use DB cache */
}
candles = await readCandles(symbol, tf, warmupFrom, toMs);
if (!candles.length) {
  console.error("No candles in DB for range — run a backtest ingest first.");
  process.exit(1);
}
const pre = precomputeIntraday(candles);

const setups = findTextbookSetupsInRange(candles, pre, fromMs, toMs, TEXTBOOK_OPTS);

console.log("=== TEXTBOOK LIQUIDITY SWEEPS (reclaim bar entries) ===");
console.log(`Symbol ${symbol} ${tf}  ${process.argv[2] || "2026-05-01"} → ${process.argv[3] || "2026-05-27"}`);
console.log(`Found ${setups.length} setup(s)\n`);

for (const { idx, setup } of setups) {
  const iso = new Date(candles[idx].ts).toISOString().slice(0, 16);
  const br = setup.liqBrackets;
  console.log(
    `${iso}  ${setup.action}  ${setup.levelType}  level=${setup.level?.toFixed(2)}  wick=${setup.wick?.toFixed(2)}  ext=${(setup.extension * 100).toFixed(2)}%  SL=${br.slPrice?.toFixed(2)}  TP1=${br.tp1Price?.toFixed(2)}  TP2=${br.tp2Price?.toFixed(2)}  RR=${br.rr?.toFixed(2)}`,
  );
}

const cfg = {
  symbol,
  timeframe: tf,
  manualStrategy: "SR_INTRADAY",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  intradayGateLiquidity: true,
  intradayLiqPartialTp: true,
  intradayLiqPartialFrac: 0.5,
  intradayLiqBreakevenAfterPartial: true,
  intradayLiqEntryAtSignalClose: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  riskPerTrade: 2.5,
  futuresLeverage: 10,
};

const adapter = buildTextbookAdapter(candles, setups);
const sim = await runSimulation({
  candles,
  strategyKey: "SR_INTRADAY",
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: tf,
  adapters: { SR_INTRADAY: adapter },
  symbol,
  costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0003 },
});

const mayTrades = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
let mayPnl = 0;
const entryKeys = new Set();
for (const t of mayTrades) {
  mayPnl += Number(t.netPnl);
  entryKeys.add(`${new Date(t.entryTs).toISOString().slice(0, 16)}:${t.direction}`);
}

const metricsMay = computeAllMetrics({
  trades: mayTrades,
  equityCurve: sim.equityCurve.filter((p) => p.ts >= fromMs && p.ts < toMs),
  tf,
  startingEquity: 100,
});

console.log("\n=== SIMULATED PnL (100 USDT start, 2% risk, 10x, fees+slippage) ===");
console.log("Trade rows in window:", mayTrades.length);
console.log("Unique entries:", entryKeys.size);
console.log("Net PnL (May window):", mayPnl.toFixed(2), "USDT");
console.log("Return % (on 100):", ((mayPnl / 100) * 100).toFixed(2) + "%");
console.log("Win rate (rows):", metricsMay.winRate != null ? (metricsMay.winRate * 100).toFixed(1) + "%" : "—");

const byExit = {};
for (const t of mayTrades) {
  byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1;
}
console.log("Exit reasons:", byExit);

console.log("\n=== PER-ENTRY (collapsed partial legs) ===");
const byEntry = new Map();
for (const t of mayTrades) {
  const k = `${new Date(t.entryTs).toISOString().slice(0, 16)}:${t.direction}`;
  if (!byEntry.has(k)) byEntry.set(k, { pnl: 0, exits: [], entry: k });
  const e = byEntry.get(k);
  e.pnl += Number(t.netPnl);
  e.exits.push(t.exitReason);
}
for (const e of [...byEntry.values()].sort((a, b) => a.entry.localeCompare(b.entry))) {
  console.log(`  ${e.entry}  pnl=${e.pnl.toFixed(2)}  ${e.exits.join(" → ")}`);
}

await closePool();
