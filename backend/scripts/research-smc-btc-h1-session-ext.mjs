#!/usr/bin/env node
/**
 * BTC SMC — H1: session-cluster micro-sweep floor.
 *
 * Autopsy: ~45% of BTC SMC entries have extension <0.3% via session soft-pass
 * (MinExtensionPct alone is a no-op). H1b: `intradayLiqSessionExtremeHardMinExt`.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-h1-session-ext.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2023-01-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2024-06-01";
const START = 10_000;
const RISK = 2.5;
const LEV = 12;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  INTRADAY_PRO_ICT_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);
const padFrom = fromMs - 14 * 864e5;

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function aggregateEntries(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const meta = t.liqContext?.smcMeta ?? t.smcMeta ?? null;
    const cur = m.get(ts) ?? {
      entryTs: ts,
      exitTs: Number(t.exitTs ?? ts),
      netPnl: 0,
      side: t.direction ?? t.side,
      reason: t.entryReason,
      exitReason: t.exitReason,
      levelType: t.liqContext?.levelType ?? meta?.levelType ?? null,
      extension: meta?.sweepExtensionPct ?? t.liqContext?.features?.extension ?? null,
      htfDisagree: meta?.htfBiasDisagreement ?? null,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.exitTs = Number(t.exitTs ?? cur.exitTs);
    cur.exitReason = t.exitReason ?? cur.exitReason;
    m.set(ts, cur);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function metricsFor(entries) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  const years = {};
  for (const e of entries) {
    const y = yearBucket(e.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += e.netPnl;
    years[y].end = eq;
    curve.push({ ts: e.entryTs, equity: eq });
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const fakeTrades = entries.map((e) => ({
    entryTs: e.entryTs,
    exitTs: e.exitTs ?? e.entryTs,
    netPnl: e.netPnl,
  }));
  const m = computeAllMetrics({
    trades: fakeTrades,
    equityCurve: curve,
    tf: TF,
    startingEquity: START,
  });
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  const oos = entries.filter((e) => e.entryTs >= oosEndMs);
  let oosEq = START;
  for (const e of oos) oosEq += e.netPnl;
  const wins = entries.filter((e) => e.netPnl > 0).length;
  const byLevel = {};
  for (const e of entries) {
    const k = e.levelType ?? "unk";
    byLevel[k] ??= { n: 0, pnl: 0 };
    byLevel[k].n += 1;
    byLevel[k].pnl += e.netPnl;
  }
  const shallow = entries.filter((e) => e.extension != null && e.extension < 0.003).length;
  const disagree = entries.filter((e) => e.htfDisagree === true).length;
  return {
    trades: entries.length,
    tw: +(entries.length / weeks).toFixed(2),
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    years,
    redYears: Object.entries(years)
      .filter(([, s]) => s.retPct < 0)
      .map(([y, s]) => `${y}=${s.retPct}%`),
    byLevel,
    shallowN: shallow,
    htfDisagreeN: disagree,
  };
}

async function runPreset(label, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...INTRADAY_PRO_ICT_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEV,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
  const cfg = materializeIntradayEngineCfgSync(raw, materializeIntradayPanelOnCfg);
  const merged = mergeAdaptiveCfg(cfg, candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: LEV,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: LEV,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const entries = aggregateEntries(sim.trades ?? []);
  return { id: label, over, ...metricsFor(entries), entries };
}

console.log(`\n══ BTC SMC H1 session-ext — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

const variants = [
  { id: "baseline", over: {} },
  // Soft-pass makes MinExtensionPct a no-op for directional shallow pokes — need HardMinExt.
  {
    id: "hardMin_008",
    over: {
      intradayLiqSessionExtremeHardMinExt: true,
      intradayLiqSessionExtremeMinExtensionPct: 0.008,
    },
  },
  {
    id: "hardMin_003",
    over: {
      intradayLiqSessionExtremeHardMinExt: true,
      intradayLiqSessionExtremeMinExtensionPct: 0.003,
      intradayLiqMinSweepExtensionPct: 0.003,
    },
  },
  {
    id: "hardMin_005",
    over: {
      intradayLiqSessionExtremeHardMinExt: true,
      intradayLiqSessionExtremeMinExtensionPct: 0.005,
      intradayLiqMinSweepExtensionPct: 0.005,
    },
  },
  { id: "maxHold16", over: { intradaySmcMaxHoldBars: 16 } },
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const r = await runPreset(v.id, v.over);
  results.push(r);
  const lvl = Object.entries(r.byLevel)
    .map(([k, s]) => `${k}:${s.n}/${s.pnl.toFixed(0)}`)
    .join(" ");
  console.log(
    `${v.id.padEnd(18)} n=${String(r.trades).padStart(4)} tw=${r.tw} wr=${r.wr}% ret=${r.ret}% oos=${r.oosRet}% shallow=${r.shallowN} disagree=${r.htfDisagreeN} | ${r.redYears.join(",") || "none"}`,
  );
  console.log(`  levels: ${lvl}`);
}

const outPath = path.join(__dirname, ".smc-btc-h1-session-ext.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      hypothesis:
        "Session-cluster micro-sweeps (minExt soft floor 0.05%) dominate losers; raise floor.",
      results: results.map(({ entries, ...r }) => r),
    },
    null,
    2,
  ),
);
console.log(`wrote ${outPath}`);
await closePool();
