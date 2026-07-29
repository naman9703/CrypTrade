#!/usr/bin/env node
/**
 * BTC SMC H5 — reclaim quality + confirm + SELL-only (wired AllowedSides).
 *
 * MFE autopsy: losers avg MFE +0.51% then reverse; 68 never-green.
 * Hypothesis: weak reclaim / no confirm candle → fake sweeps. Also re-test
 * SELL-only with real AllowedSides (postfilter was approximate).
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-h5-reclaim-confirm.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = process.env.TF || "15m";
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
  INTRADAY_PRO_ICT_RESEARCH_1H,
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

async function runPreset(label, preset, over = {}, tf = TF) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...preset,
    ...over,
    symbol: SYMBOL,
    timeframe: tf,
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
  const merged = mergeAdaptiveCfg(cfg, candlesByTf[tf]);
  const sim = await runSimulation({
    candles: candlesByTf[tf],
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: SYMBOL,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: tf,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candlesByTf[tf], merged, tf) },
    costModelOverride: {
      leverage: 12,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  return { id: label, over, tf, ...metricsFor(aggregateEntries(sim.trades ?? [])) };
}

console.log(`\n══ BTC SMC H5 reclaim/confirm — ${FROM}→${TO} ══`);
const candles15 = await readCandles(SYMBOL, "15m", padFrom, toMs, { market: "futures" });
const candles1h = await readCandles(SYMBOL, "1h", padFrom, toMs, { market: "futures" }).catch(() => []);
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
const candlesByTf = { "15m": candles15, "1h": candles1h };
console.error(`candles15=${candles15.length} candles1h=${candles1h.length}`);

const variants = [
  { id: "baseline", preset: INTRADAY_PRO_ICT_15M, over: {}, tf: "15m" },
  {
    id: "reclaim_body_50",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradayLiqMinReclaimBodyRatio: 0.5 },
    tf: "15m",
  },
  {
    id: "reclaim_body_60",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradayLiqMinReclaimBodyRatio: 0.6 },
    tf: "15m",
  },
  {
    id: "require_confirm",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcRequireConfirm: true },
    tf: "15m",
  },
  {
    id: "sell_only",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcAllowedSides: "SELL" },
    tf: "15m",
  },
  {
    id: "sell_maxHold16",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcAllowedSides: "SELL", intradaySmcMaxHoldBars: 16 },
    tf: "15m",
  },
  {
    id: "maxHold16",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcMaxHoldBars: 16 },
    tf: "15m",
  },
];

if (candles1h.length > 1000) {
  variants.push({
    id: "research_1h",
    preset: INTRADAY_PRO_ICT_RESEARCH_1H,
    over: { symbol: SYMBOL },
    tf: "1h",
  });
  variants.push({
    id: "sweep_1h",
    preset: { ...INTRADAY_PRO_ICT_15M, timeframe: "1h", intradaySmcLookbackBars: 24, intradaySmcMaxHoldBars: 24 },
    over: {},
    tf: "1h",
  });
}

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  const r = await runPreset(v.id, v.preset, v.over, v.tf);
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  results.push(r);
  console.log(
    `${v.id.padEnd(18)} n=${String(r.trades).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% (${sec}s) | ${r.redYears.join(",") || "none"}`,
  );
  console.log(
    `  exits: ${Object.entries(r.byExit)
      .map(([k, s]) => `${k}:${s.n}/${s.pnl.toFixed(0)}`)
      .join(" ")}`,
  );
}

const ranked = [...results].sort((a, b) => {
  const aOk = a.oosRet > 0 && a.ret > 0 ? 1 : 0;
  const bOk = b.oosRet > 0 && b.ret > 0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  if (b.oosRet !== a.oosRet) return b.oosRet - a.oosRet;
  return b.ret - a.ret;
});

console.log("\n══ Rank ══");
for (const r of ranked) {
  console.log(`${r.id.padEnd(18)} ret=${r.ret}% oos=${r.oosRet}% tw=${r.tw} n=${r.trades}`);
}

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-h5-reclaim-confirm.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), ranked }, null, 2),
);
console.log("wrote .smc-btc-h5-reclaim-confirm.json");
console.log(`Best: ${ranked[0]?.id} ret=${ranked[0]?.ret}% oos=${ranked[0]?.oosRet}%`);
await closePool();
