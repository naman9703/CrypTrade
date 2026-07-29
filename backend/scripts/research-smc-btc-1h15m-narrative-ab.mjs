#!/usr/bin/env node
/**
 * BTC SMC — 1H narrative A/B (Phase 2) + dealing-range POI (Phase 3 concept).
 *
 * Baseline = harvest practical (invalidation OFF).
 * One premise change at a time vs baseline:
 *   - h1_narrative: soft 1H structure alignment
 *   - h1_narrative_dr: narrative + 1H dealing-range POI
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-1h15m-narrative-ab.mjs
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

const BASE = {
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
  intradaySmcRequirePdInducement: false,
  intradaySmcEnforceInvalidation: false,
  intradaySmcRequirePdAfterChoch: false,
  intradaySmcRequireHtfNarrative: false,
};

const VARIANTS = [
  { id: "baseline_practical", patch: {} },
  {
    id: "h1_narrative",
    patch: {
      intradaySmcRequireHtfNarrative: true,
      intradaySmcHtfPoiMode: "none",
    },
  },
  {
    id: "h1_narrative_dr",
    patch: {
      intradaySmcRequireHtfNarrative: true,
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
  const neverGreen = entries.filter((e) => e.netPnl <= 0 && e.mfePct <= 0.001).length;
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
    neverGreen,
  };
}

async function runVariant(label, patch) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...BASE,
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

console.log(`\n══ BTC 1H→15m narrative A/B — ${FROM}→${TO} ══`);
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
    `${r.id.padEnd(22)} n=${String(r.n).padStart(4)} td=${String(r.td).padStart(5)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% pf=${String(r.pf).padStart(5)} (${r.sec}s)`,
  );
}

const base = results[0];
const narr = results[1];
const dr = results[2];

function verdict(vs, label) {
  if (!base || !vs) return "INCONCLUSIVE";
  const better = vs.oosRet > base.oosRet && vs.ret > base.ret && vs.pf > base.pf;
  const stillRed = vs.ret <= 0 || vs.oosRet <= 0 || vs.pf < 1;
  const freqOk = vs.td >= 0.5; // soft floor; target 1.0
  const nCrush = vs.n < base.n * 0.35;
  if (nCrush && stillRed) return `${label}_NCRUSH_STILL_RED`;
  if (better && !stillRed && vs.td >= 1) return `${label}_PROMISING`;
  if (better && stillRed && freqOk) return `${label}_HELPS_STILL_RED`;
  if (better && stillRed) return `${label}_HELPS_FREQ_SOFT`;
  return `${label}_NO_EDGE`;
}

const vNarr = verdict(narr, "NARRATIVE");
const vDr = verdict(dr, "NARRATIVE_DR");
console.log(`\nverdict_narrative=${vNarr} Δn=${(narr?.n ?? 0) - (base?.n ?? 0)} Δret=${((narr?.ret ?? 0) - (base?.ret ?? 0)).toFixed(2)}`);
console.log(`verdict_dr=${vDr} Δn=${(dr?.n ?? 0) - (base?.n ?? 0)} Δret=${((dr?.ret ?? 0) - (base?.ret ?? 0)).toFixed(2)}`);

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-1h15m-narrative-ab.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      window: { FROM, TO, OOS_END },
      results,
      verdicts: { narrative: vNarr, dealingRange: vDr },
    },
    null,
    2,
  ),
);
console.log("wrote .smc-btc-1h15m-narrative-ab.json");
await closePool();
