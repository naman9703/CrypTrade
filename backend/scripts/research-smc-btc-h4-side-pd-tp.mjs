#!/usr/bin/env node
/**
 * BTC SMC H4 — entry-quality / exit-geometry follow-ups (one change each).
 *
 * H3 Asia/HTF/SL all still red. Named failure remains: reclaim entries stop out
 * (PF~0.3). Test: SELL-only, BUY-only, premium/discount ON, internal TP2,
 * maxHold16 baseline compare + MFE/MAE autopsy on baseline losers.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-h4-side-pd-tp.mjs
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
    const meta = t.liqContext?.smcMeta ?? null;
    const cur = m.get(ts) ?? {
      entryTs: ts,
      exitTs: Number(t.exitTs ?? ts),
      netPnl: 0,
      side: String(t.direction ?? t.side ?? "").toUpperCase(),
      exitReason: t.exitReason,
      mae: Number(t.maePct ?? 0),
      mfe: Number(t.mfePct ?? 0),
      plannedRr: meta?.plannedRr ?? t.liqContext?.rr ?? null,
      barsHeld: Number(t.barsHeld ?? 0),
      levelType: t.liqContext?.levelType ?? meta?.levelType ?? null,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.exitReason = t.exitReason ?? cur.exitReason;
    cur.mae = Math.max(cur.mae, Number(t.maePct ?? 0));
    cur.mfe = Math.max(cur.mfe, Number(t.mfePct ?? 0));
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

function autopsyMfe(entries) {
  const losers = entries.filter((e) => e.netPnl <= 0);
  const winners = entries.filter((e) => e.netPnl > 0);
  const avg = (arr, fn) => (arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0);
  const neverGreen = losers.filter((e) => e.mfe <= 0.001).length;
  const touched1R = losers.filter((e) => e.mfe >= 0.005).length; // rough 0.5% proxy
  const byLevel = {};
  for (const e of losers) {
    const k = e.levelType ?? "unk";
    byLevel[k] ??= { n: 0, pnl: 0, avgMfe: 0, avgMae: 0 };
    byLevel[k].n += 1;
    byLevel[k].pnl += e.netPnl;
    byLevel[k].avgMfe += e.mfe;
    byLevel[k].avgMae += e.mae;
  }
  for (const s of Object.values(byLevel)) {
    s.avgMfe = +(s.avgMfe / s.n).toFixed(4);
    s.avgMae = +(s.avgMae / s.n).toFixed(4);
    s.pnl = +s.pnl.toFixed(0);
  }
  return {
    nLosers: losers.length,
    nWinners: winners.length,
    loserAvgMfe: +avg(losers, (e) => e.mfe).toFixed(4),
    loserAvgMae: +avg(losers, (e) => e.mae).toFixed(4),
    winnerAvgMfe: +avg(winners, (e) => e.mfe).toFixed(4),
    winnerAvgMae: +avg(winners, (e) => e.mae).toFixed(4),
    neverGreenLosers: neverGreen,
    losersTouchedHalfPct: touched1R,
    loserByLevel: byLevel,
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
  const entries = aggregateEntries(sim.trades ?? []);
  return { id: label, over, ...metricsFor(entries), entries };
}

console.log(`\n══ BTC SMC H4 side/PD/TP — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

console.error("run baseline");
const baseline = await runPreset("baseline", {});
const auto = autopsyMfe(baseline.entries);
console.log(
  `BASE n=${baseline.trades} tw=${baseline.tw} wr=${baseline.wr}% ret=${baseline.ret}% oos=${baseline.oosRet}%`,
);
console.log("── MFE/MAE autopsy ──");
console.log(JSON.stringify(auto, null, 2));

const variants = [
  { id: "sell_only", over: { intradaySmcAllowedSides: "SELL" } },
  { id: "buy_only", over: { intradaySmcAllowedSides: "BUY" } },
  { id: "premium_discount", over: { intradaySmcRequirePremiumDiscount: true } },
  { id: "tp2_internal", over: { intradaySmcTp2Mode: "internal" } },
  { id: "maxHold16", over: { intradaySmcMaxHoldBars: 16 } },
  { id: "pdh_pdl_only", over: { intradayLiqSessionExtreme: false } },
  {
    id: "pd_ote",
    over: {
      intradaySmcRequirePremiumDiscount: true,
      intradaySmcPremiumDiscountOte: true,
    },
  },
];

const results = [baseline];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  const r = await runPreset(v.id, v.over);
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  results.push(r);
  console.log(
    `${v.id.padEnd(20)} n=${String(r.trades).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% (${sec}s) | ${r.redYears.join(",") || "none"}`,
  );
  console.log(
    `  exits: ${Object.entries(r.byExit)
      .map(([k, s]) => `${k}:${s.n}/${s.pnl.toFixed(0)}`)
      .join(" ")}`,
  );
}

// Post-filter SELL/BUY if AllowedSides not wired — apply on baseline entries
function filterSide(side) {
  const entries = baseline.entries.filter((e) => e.side === side);
  return { id: `postfilter_${side}`, over: { post: true }, ...metricsFor(entries) };
}
for (const side of ["BUY", "SELL"]) {
  const r = filterSide(side);
  results.push(r);
  console.log(
    `${r.id.padEnd(20)} n=${String(r.trades).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% (post) | ${r.redYears.join(",") || "none"}`,
  );
}

const ranked = [...results]
  .map(({ entries, ...r }) => r)
  .sort((a, b) => {
    const aOk = a.oosRet > 0 && a.ret > 0 ? 1 : 0;
    const bOk = b.oosRet > 0 && b.ret > 0 ? 1 : 0;
    if (bOk !== aOk) return bOk - aOk;
    if (b.oosRet !== a.oosRet) return b.oosRet - a.oosRet;
    return b.ret - a.ret;
  });

console.log("\n══ Rank ══");
for (const r of ranked) {
  console.log(`${r.id.padEnd(20)} ret=${r.ret}% oos=${r.oosRet}% tw=${r.tw} n=${r.trades}`);
}

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-h4-side-pd-tp.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), autopsy: auto, ranked }, null, 2),
);
console.log("wrote .smc-btc-h4-side-pd-tp.json");
console.log(`Best: ${ranked[0]?.id}`);
await closePool();
