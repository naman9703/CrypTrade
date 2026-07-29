#!/usr/bin/env node
/**
 * BTC SMC — H1-aligned raid contract A/B (15m entry).
 *
 * Contract: completed-1H narrative + liquidity raid → 15m displacement leg →
 * FVG/OB retrace. No mandatory 15m CHoCH (freq-preserving).
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-h1-aligned-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const OOS_END = process.env.OOS_END || "2025-10-01";
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
  INTRADAY_PRO_ICT_H1_ALIGNED_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);
const padFrom = fromMs - 14 * 864e5;
const days = Math.max(1, (toMs - fromMs) / 864e5);
const weeks = Math.max(1, days / 7);

const PRACTICAL = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcRequireMss: false,
  intradaySmcRequireBos: false,
  intradaySmcChochStrict: false,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcFvgEntryMode: "zone",
  intradaySmcKillzoneMode: "ALL",
  intradaySmcRequirePremiumDiscount: false,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 8,
  intradaySmcMinRr: 1.5,
  intradaySmcSlMode: "pd_array",
  intradaySmcMaxHoldBars: 48,
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcEnforceInvalidation: false,
  intradaySmcRequirePdAfterChoch: false,
  intradaySmcRequireHtfNarrative: false,
};

const VARIANTS = [
  { id: "baseline_practical", base: PRACTICAL, patch: {} },
  { id: "h1_aligned_soft", base: INTRADAY_PRO_ICT_H1_ALIGNED_15M, patch: {} },
  {
    id: "h1_aligned_strict",
    base: INTRADAY_PRO_ICT_H1_ALIGNED_15M,
    patch: { intradaySmcHtfNarrativeStrictness: "strict" },
  },
  {
    id: "h1_aligned_strict_dr",
    base: INTRADAY_PRO_ICT_H1_ALIGNED_15M,
    patch: {
      intradaySmcHtfNarrativeStrictness: "strict",
      intradaySmcHtfPoiMode: "dealing_range",
    },
  },
];

function aggregate(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const cur = m.get(ts) ?? { entryTs: ts, netPnl: 0, mfePct: Number(t.mfePct ?? 0) };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.mfePct = Math.max(cur.mfePct, Number(t.mfePct ?? 0));
    m.set(ts, cur);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function metrics(entries) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const e of entries) {
    eq += e.netPnl;
    curve.push({ ts: e.entryTs, equity: eq });
  }
  const m = computeAllMetrics({
    trades: entries.map((e) => ({ entryTs: e.entryTs, exitTs: e.entryTs, netPnl: e.netPnl })),
    equityCurve: curve,
    tf: TF,
    startingEquity: START,
  });
  const wins = entries.filter((e) => e.netPnl > 0).length;
  const oos = entries.filter((e) => e.entryTs >= oosEndMs);
  let oosEq = START;
  for (const e of oos) oosEq += e.netPnl;
  return {
    n: entries.length,
    tw: +(entries.length / weeks).toFixed(2),
    td: +(entries.length / days).toFixed(2),
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: +(((oosEq - START) / START) * 100).toFixed(2),
  };
}

async function runVariant(label, base, patch) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...base,
    ...patch,
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
  return { id: label, ...metrics(aggregate(sim.trades ?? [])) };
}

console.log(`\n══ BTC H1-aligned raid A/B — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.log(`candles=${candles.length}`);

const results = [];
for (const v of VARIANTS) {
  console.log(`run ${v.id}`);
  const t0 = Date.now();
  const r = await runVariant(v.id, v.base, v.patch);
  r.sec = Math.round((Date.now() - t0) / 1000);
  results.push(r);
  console.log(
    `${r.id.padEnd(24)} n=${String(r.n).padStart(4)} td=${String(r.td).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% pf=${String(r.pf).padStart(5)} (${r.sec}s)`,
  );
}

const base = results[0];
const best = [...results].sort((a, b) => {
  const aOk = a.ret > 0 && a.oosRet > 0 && a.pf >= 1 ? 1 : 0;
  const bOk = b.ret > 0 && b.oosRet > 0 && b.pf >= 1 ? 1 : 0;
  if (aOk !== bOk) return bOk - aOk;
  return b.ret - a.ret;
})[0];

function verdictFor(r) {
  if (!r) return "NONE";
  if (r.ret > 0 && r.oosRet > 0 && r.pf >= 1 && r.n >= 30) {
    return r.td >= 1 ? "PROMISING_FREQ_OK" : "PROMISING_FREQ_SHORT";
  }
  if (r.ret > base.ret && r.pf > base.pf && r.ret <= 0) return "HELPS_STILL_RED";
  if (r.n < (base?.n ?? 0) * 0.35 && r.ret <= 0) return "NCRUSH_STILL_RED";
  return "NO_EDGE";
}

const verdicts = Object.fromEntries(results.map((r) => [r.id, verdictFor(r)]));
console.log(`\nbest=${best?.id} verdicts=${JSON.stringify(verdicts)}`);

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-h1-aligned-ab.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), window: { FROM, TO, OOS_END }, results, verdicts, best: best?.id }, null, 2),
);
console.log("wrote .smc-btc-h1-aligned-ab.json");
await closePool();
