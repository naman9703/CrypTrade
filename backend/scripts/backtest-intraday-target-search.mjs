#!/usr/bin/env node
/**
 * Search intraday candidates for a portfolio-level trade frequency target.
 *
 * Goal: maximize robust return while keeping average portfolio entries/day inside
 * TARGET_MIN..TARGET_MAX (default 1..2) with realistic futures costs.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT FROM=2026-01-01 TO=2026-06-01 node scripts/backtest-intraday-target-search.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);
const RISK = Number(process.env.RISK_PCT || 2);
const TARGET_MIN = Number(process.env.TARGET_MIN || 1);
const TARGET_MAX = Number(process.env.TARGET_MAX || 2);
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  console.error("Invalid FROM/TO");
  process.exit(1);
}
const calendarDays = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_DAILY_15M,
  INTRADAY_PRO_SR_APLUS_15M,
  INTRADAY_PRO_FIB_15M,
  INTRADAY_PRO_VP_15M,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const {
  VOLUME_PROFILE_15M,
  VOLUME_PROFILE_BALANCED_15M,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const {
  CRT_TBS_BNB_15M,
  CRT_TBS_BNB_15M_BALANCED,
  CRT_TBS_BNB_15M_FREQ,
} = await import("../src/strategy/presets/crtTbsOptimized.js");
const {
  SUPERTREND_ELITE_1H_PRESET,
  SUPERTREND_ELITE_ADX_1H_PRESET,
  SUPERTREND_ELITE_AUTO_1H_PRESET,
} = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const COMMON = {
  marketMode: "FUTURES",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  futuresLeverage: 12,
};

const CANDIDATES = [
  {
    label: "LIQ classic PDH/PDL",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_LIQ_15M },
  },
  {
    label: "LIQ daily continuation",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_LIQ_DAILY_15M },
  },
  {
    label: "LIQ+SR A+ vol1.3",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_SR_APLUS_15M, intradaySrMinVolRatio: 1.3 },
  },
  {
    label: "LIQ+SR A+ rr1.5 vol1.3",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_SR_APLUS_15M, intradaySrMinVolRatio: 1.3, intradayLiqMinRr: 1.5 },
  },
  {
    label: "FIB golden-pocket",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_FIB_15M },
  },
  {
    label: "SR volume-profile soft",
    key: "SR_INTRADAY",
    tf: "15m",
    cfg: { ...INTRADAY_PRO_VP_15M },
  },
  {
    label: "VP production",
    key: "VOLUME_PROFILE",
    tf: "15m",
    cfg: { ...VOLUME_PROFILE_15M },
  },
  {
    label: "VP balanced",
    key: "VOLUME_PROFILE",
    tf: "15m",
    cfg: { ...VOLUME_PROFILE_BALANCED_15M },
  },
  {
    label: "CRT/TBS selective",
    key: "CRT_TBS",
    tf: "15m",
    cfg: { ...CRT_TBS_BNB_15M },
  },
  {
    label: "CRT/TBS balanced",
    key: "CRT_TBS",
    tf: "15m",
    cfg: { ...CRT_TBS_BNB_15M_BALANCED },
  },
  {
    label: "CRT/TBS frequency",
    key: "CRT_TBS",
    tf: "15m",
    cfg: { ...CRT_TBS_BNB_15M_FREQ },
  },
  {
    label: "ST elite 1h",
    key: "SUPERTREND_ELITE",
    tf: "1h",
    cfg: { ...SUPERTREND_ELITE_1H_PRESET },
  },
  {
    label: "ST elite 1h ADX",
    key: "SUPERTREND_ELITE",
    tf: "1h",
    cfg: { ...SUPERTREND_ELITE_ADX_1H_PRESET },
  },
  {
    label: "ST elite 1h auto",
    key: "SUPERTREND_ELITE",
    tf: "1h",
    cfg: { ...SUPERTREND_ELITE_AUTO_1H_PRESET },
  },
];

const ACTIVE_CANDIDATES = ONLY.length
  ? CANDIDATES.filter((c) => ONLY.some((needle) => c.label.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle)))
  : CANDIDATES;

const dataCache = new Map();
async function loadData(symbol, tf) {
  const k = `${symbol}|${tf}`;
  if (dataCache.has(k)) return dataCache.get(k);
  const candles = await readCandles(symbol, tf, fromMs, toMs, { market: "futures" });
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs, toMs);
  } catch {
    funding = [];
  }
  const v = { candles: candles || [], funding };
  dataCache.set(k, v);
  return v;
}

function logicalEntries(trades) {
  const byEntry = new Map();
  for (const t of trades || []) {
    const key = `${Number(t.entryTs || 0)}:${String(t.direction || t.side || "")}`;
    if (!byEntry.has(key)) byEntry.set(key, { pnl: 0, entryTs: Number(t.entryTs || 0), r: 0, rCount: 0 });
    const row = byEntry.get(key);
    row.pnl += Number(t.netPnl || 0);
    if (Number.isFinite(Number(t.rMultiple))) {
      row.r += Number(t.rMultiple);
      row.rCount += 1;
    }
  }
  return [...byEntry.values()].filter((e) => e.entryTs >= fromMs && e.entryTs < toMs);
}

async function runCandidateOnSymbol(candidate, symbol) {
  const { candles, funding } = await loadData(symbol, candidate.tf);
  if (candles.length < 500) return { symbol, skipped: "not_enough_candles", net: 0, entries: 0 };
  const cfg = {
    ...candidate.cfg,
    ...COMMON,
    symbol,
    timeframe: candidate.tf,
    manualStrategy: candidate.key,
    strategyMode: "MANUAL",
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: candidate.key,
    cfg,
    symbol,
    tf: candidate.tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: candidate.key,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: candidate.tf,
    adapters,
    symbol,
  });
  const metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: candidate.tf,
    startingEquity: START,
  });
  const entries = logicalEntries(sim.trades);
  const wins = entries.filter((e) => e.pnl > 0).length;
  const rstats = rMultipleStats(sim.trades);
  return {
    symbol,
    net: metrics.totalReturnPct || 0,
    trades: metrics.totalTrades || 0,
    entries: entries.length,
    winRate: entries.length ? (wins / entries.length) * 100 : 0,
    pf: metrics.profitFactor || 0,
    dd: metrics.maxDrawdownPct || 0,
    calmar: metrics.calmar || 0,
    expR: metrics.expectancyR || 0,
    rCount: rstats.rCount || 0,
  };
}

function scoreRow(row) {
  const freq = row.entriesPerDay;
  const targetPenalty =
    freq < TARGET_MIN ? (TARGET_MIN - freq) * 20 : freq > TARGET_MAX ? (freq - TARGET_MAX) * 20 : 0;
  const negativePenalty = row.minNet < 0 ? Math.abs(row.minNet) * 1.5 : 0;
  const ddPenalty = Math.max(0, row.maxDd - 20) * 0.5;
  const evidencePenalty = row.entries < 40 ? (40 - row.entries) * 0.15 : 0;
  const inBandBonus = freq >= TARGET_MIN && freq <= TARGET_MAX ? 10 : 0;
  return row.meanNet + inBandBonus - targetPenalty - negativePenalty - ddPenalty - evidencePenalty;
}

const rows = [];
console.log(`\n=== INTRADAY TARGET SEARCH ===`);
console.log(`symbols=${SYMBOLS.join(",")} ${FROM}->${TO} risk=${RISK}% target=${TARGET_MIN}-${TARGET_MAX} portfolio entries/day`);
if (ONLY.length) console.log(`filter=${ONLY.join(",")}`);
console.log("");

for (const candidate of ACTIVE_CANDIDATES) {
  const per = [];
  for (const symbol of SYMBOLS) {
    per.push(await runCandidateOnSymbol(candidate, symbol));
  }
  const valid = per.filter((r) => !r.skipped);
  const entries = valid.reduce((a, r) => a + r.entries, 0);
  const nets = valid.map((r) => r.net);
  const row = {
    label: candidate.label,
    key: candidate.key,
    tf: candidate.tf,
    meanNet: nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0,
    minNet: nets.length ? Math.min(...nets) : 0,
    maxNet: nets.length ? Math.max(...nets) : 0,
    entries,
    entriesPerDay: entries / calendarDays,
    trades: valid.reduce((a, r) => a + r.trades, 0),
    posSymbols: valid.filter((r) => r.net > 0).length,
    symbolCount: valid.length,
    maxDd: valid.reduce((a, r) => Math.max(a, Number(r.dd || 0)), 0),
    meanPf: valid.length ? valid.reduce((a, r) => a + Number(r.pf || 0), 0) / valid.length : 0,
    per,
  };
  row.score = scoreRow(row);
  rows.push(row);
  process.stdout.write(
    `  ${candidate.label.padEnd(26)} mean=${row.meanNet.toFixed(1).padStart(6)}% min=${row.minNet.toFixed(1).padStart(6)}% entries/day=${row.entriesPerDay.toFixed(2).padStart(5)} n=${String(row.entries).padStart(4)} score=${row.score.toFixed(1).padStart(6)}\n`,
  );
}

rows.sort((a, b) => b.score - a.score);
console.log(`\n=== RANKED BY TARGET-CONSTRAINED SCORE ===`);
console.log(`${"#".padEnd(3)}${"candidate".padEnd(28)}${"tf".padEnd(5)}${"mean%".padStart(8)}${"min%".padStart(8)}${"pos".padStart(6)}${"entries".padStart(9)}${"/day".padStart(7)}${"maxDD".padStart(8)}${"PF".padStart(7)}${"score".padStart(8)}`);
rows.forEach((r, i) => {
  console.log(
    `${String(i + 1).padEnd(3)}${r.label.padEnd(28)}${r.tf.padEnd(5)}${r.meanNet.toFixed(1).padStart(8)}${r.minNet.toFixed(1).padStart(8)}${`${r.posSymbols}/${r.symbolCount}`.padStart(6)}${String(r.entries).padStart(9)}${r.entriesPerDay.toFixed(2).padStart(7)}${r.maxDd.toFixed(1).padStart(8)}${r.meanPf.toFixed(2).padStart(7)}${r.score.toFixed(1).padStart(8)}`,
  );
});

const best = rows[0];
console.log(`\n=== BEST DETAIL: ${best?.label || "none"} ===`);
if (best) {
  console.log(`${"symbol".padEnd(9)}${"net%".padStart(8)}${"entries".padStart(9)}${"WR%".padStart(7)}${"PF".padStart(7)}${"DD%".padStart(8)}${"Calmar".padStart(8)}${"expR".padStart(8)}`);
  for (const r of best.per) {
    if (r.skipped) {
      console.log(`${r.symbol.padEnd(9)} skipped: ${r.skipped}`);
      continue;
    }
    console.log(
      `${r.symbol.padEnd(9)}${r.net.toFixed(1).padStart(8)}${String(r.entries).padStart(9)}${r.winRate.toFixed(0).padStart(7)}${r.pf.toFixed(2).padStart(7)}${r.dd.toFixed(1).padStart(8)}${r.calmar.toFixed(2).padStart(8)}${r.expR.toFixed(2).padStart(8)}`,
    );
  }
}

await closePool?.();
