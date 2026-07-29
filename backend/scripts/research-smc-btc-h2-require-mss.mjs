#!/usr/bin/env node
/**
 * BTC SMC H2 — require MSS (displacement) after reclaim.
 *
 * Named failure: sweep profile enters on reclaim bar without structure shift;
 * SL massacre (179 SL / −19k vs 50 TP2). Hypothesis: RequireMss alone improves
 * expectancy without CHoCH (CHoCH multi-year is pathological CPU).
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-h2-require-mss.mjs
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
    const cur = m.get(ts) ?? {
      entryTs: ts,
      exitTs: Number(t.exitTs ?? ts),
      netPnl: 0,
      side: t.direction ?? t.side,
      exitReason: t.exitReason,
      reason: t.entryReason,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
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
  const byExit = {};
  for (const e of entries) {
    const k = String(e.exitReason ?? "?");
    byExit[k] ??= { n: 0, pnl: 0 };
    byExit[k].n += 1;
    byExit[k].pnl += e.netPnl;
  }
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
    byExit,
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
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
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
      riskPerTrade: 2.5,
      futuresLeverage: 12,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: 12,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  return { id: label, over, ...metricsFor(aggregateEntries(sim.trades ?? [])) };
}

console.log(`\n══ BTC SMC H2 RequireMss — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

const variants = [
  { id: "baseline", over: {} },
  { id: "require_mss", over: { intradaySmcRequireMss: true } },
  {
    id: "require_mss_retrace",
    over: { intradaySmcRequireMss: true, intradaySmcRequireRetrace: true },
  },
  { id: "require_retrace_only", over: { intradaySmcRequireRetrace: true } },
  { id: "require_bos", over: { intradaySmcRequireBos: true } },
  {
    id: "mss_maxHold16",
    over: { intradaySmcRequireMss: true, intradaySmcMaxHoldBars: 16 },
  },
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  const r = await runPreset(v.id, v.over);
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  results.push(r);
  console.log(
    `${v.id.padEnd(22)} n=${String(r.trades).padStart(4)} tw=${r.tw} wr=${r.wr}% ret=${r.ret}% oos=${r.oosRet}% cal=${r.calmar} pf=${r.pf} (${sec}s) | ${r.redYears.join(",") || "none"}`,
  );
  console.log(
    `  exits: ${Object.entries(r.byExit)
      .map(([k, s]) => `${k}:${s.n}/${s.pnl.toFixed(0)}`)
      .join(" ")}`,
  );
}

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-h2-require-mss.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
console.log("wrote .smc-btc-h2-require-mss.json");
await closePool();
