#!/usr/bin/env node
/**
 * BTC SMC 1H→15m — frequency path (expand opportunity, keep 1H context).
 *
 * Practical+CHoCH cannot hit ≥1/day. Sweep reclaim is the high-N engine;
 * soft 1H narrative is context (not a one-shot gate). Still no ship claim.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-1h15m-freq-path.mjs
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
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);
const padFrom = fromMs - 14 * 864e5;
const days = Math.max(1, (toMs - fromMs) / 864e5);
const weeks = Math.max(1, days / 7);

const SWEEP = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradaySmcIctProfile: "sweep",
  intradaySmcRequireChoch: false,
  intradaySmcRequireMss: false,
  intradaySmcRequireBos: false,
  intradaySmcRequireRetrace: false,
  intradaySmcRequireFvgRetrace: false,
  intradaySmcKillzoneMode: "ALL",
  intradaySmcRequirePremiumDiscount: false,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 8,
  intradaySmcMinRr: 1.5,
  intradaySmcSlMode: "structure",
  intradaySmcMaxHoldBars: 48,
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcEnforceInvalidation: false,
  intradaySmcRequirePdAfterChoch: false,
  intradaySmcRequireHtfNarrative: false,
};

const VARIANTS = [
  { id: "sweep_base", patch: {} },
  {
    id: "sweep_h1_narr",
    patch: { intradaySmcRequireHtfNarrative: true, intradaySmcHtfPoiMode: "none" },
  },
  {
    id: "sweep_h1_dr",
    patch: { intradaySmcRequireHtfNarrative: true, intradaySmcHtfPoiMode: "dealing_range" },
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

async function runVariant(label, patch) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...SWEEP,
    ...patch,
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

console.log(`\n══ BTC 1H→15m freq path (sweep+H1) — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.log(`candles=${candles.length}`);

const results = [];
for (const v of VARIANTS) {
  console.log(`run ${v.id}`);
  const t0 = Date.now();
  const r = await runVariant(v.id, v.patch);
  r.sec = Math.round((Date.now() - t0) / 1000);
  results.push(r);
  console.log(
    `${r.id.padEnd(16)} n=${String(r.n).padStart(4)} td=${String(r.td).padStart(5)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% pf=${String(r.pf).padStart(5)} (${r.sec}s)`,
  );
}

const best = [...results].sort((a, b) => b.ret - a.ret)[0];
const freqOk = results.some((r) => r.td >= 1);
const anyGreen = results.some((r) => r.ret > 0 && r.oosRet > 0 && r.pf >= 1);
const verdict = anyGreen
  ? "FREQ_PATH_PROMISING"
  : freqOk
    ? "FREQ_OK_STILL_RED"
    : "FREQ_SHORT_STILL_RED";

console.log(`\nverdict=${verdict} best=${best?.id} freqOk=${freqOk}`);
fs.writeFileSync(
  path.join(__dirname, ".smc-btc-1h15m-freq-path.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), window: { FROM, TO, OOS_END }, results, verdict }, null, 2),
);
console.log("wrote .smc-btc-1h15m-freq-path.json");
await closePool();
