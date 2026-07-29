#!/usr/bin/env node
/**
 * BTC SMC 1H→15m Phase 0 — frequency-viable harvest tape (autopsy fuel).
 *
 * Practical ICT with prerequisite N-crush stack forced OFF so n stays usable.
 * Does not claim edge — success = n≥30 trade tape with smcMeta.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-1h15m-phase0-harvest.mjs
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
const { attachSmcHtfToPre } = await import("../src/strategy/techniques/htfBias.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);
const padFrom = fromMs - 14 * 864e5;
const days = Math.max(1, (toMs - fromMs) / 864e5);
const weeks = Math.max(1, days / 7);

/** Harvest baseline: practical ICT, invalidation/PD-after-CHoCH OFF (N-viable). */
export const HARVEST_PRACTICAL = {
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

function aggregateTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const meta = t.liqContext?.smcMeta ?? {};
    const lc = t.liqContext ?? {};
    const cur = m.get(ts) ?? {
      entryTs: ts,
      exitTs: Number(t.exitTs ?? ts),
      netPnl: 0,
      side: String(t.direction ?? t.side ?? "").toUpperCase(),
      exitReason: t.exitReason,
      entryReason: t.entryReason,
      maePct: Number(t.maePct ?? 0),
      mfePct: Number(t.mfePct ?? 0),
      barsHeld: Number(t.barsHeld ?? 0),
      entryPrice: Number(t.entryPrice ?? 0),
      slPrice: Number(t.initialSlPrice ?? t.slPrice ?? 0),
      levelType: lc.levelType ?? meta.levelType ?? null,
      plannedRr: meta.plannedRr ?? lc.rr ?? null,
      entryZone: meta.entryZone ?? null,
      chochIdx: meta.chochIdx ?? null,
      mssIdx: meta.mssIdx ?? null,
      bosIdx: meta.bosIdx ?? null,
      fvgTop: meta.fvgTop ?? null,
      fvgBottom: meta.fvgBottom ?? null,
      obTop: meta.obTop ?? null,
      obBottom: meta.obBottom ?? null,
      barsAfterReclaim: meta.barsAfterReclaim ?? null,
      sweepExtensionPct: meta.sweepExtensionPct ?? null,
      reclaimBodyRatio: meta.reclaimBodyRatio ?? null,
      htfBiasDisagreement: meta.htfBiasDisagreement ?? null,
      htfStructureState: meta.htfStructureState ?? null,
      h1StructureState: meta.h1StructureState ?? null,
      h1LastEvent: meta.h1LastEvent ?? null,
      h1DrHigh: meta.h1DrHigh ?? null,
      h1DrLow: meta.h1DrLow ?? null,
      h1DrEq: meta.h1DrEq ?? null,
      killzone: meta.killzone ?? null,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.exitTs = Number(t.exitTs ?? cur.exitTs);
    cur.exitReason = t.exitReason ?? cur.exitReason;
    cur.maePct = Math.min(cur.maePct, Number(t.maePct ?? cur.maePct));
    cur.mfePct = Math.max(cur.mfePct, Number(t.mfePct ?? 0));
    m.set(ts, cur);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function enrichWithH1(entries, candles) {
  const pre = precomputeIntraday(candles);
  attachSmcHtfToPre(candles, pre, {});
  const narr = pre._smcH1Narr;
  for (const e of entries) {
    let idx = candles.findIndex((c) => c.ts >= e.entryTs);
    if (idx < 0) idx = candles.length - 1;
    // prefer exact/nearest bar at or before entry
    while (idx > 0 && candles[idx].ts > e.entryTs) idx -= 1;
    e.h1StructureState = narr?.h1StructureState?.[idx] ?? e.h1StructureState;
    e.h1LastEvent = narr?.h1LastEvent?.[idx] ?? e.h1LastEvent;
    e.h1DrHigh = narr?.h1DrHigh?.[idx] ?? e.h1DrHigh;
    e.h1DrLow = narr?.h1DrLow?.[idx] ?? e.h1DrLow;
    e.h1DrEq = narr?.h1DrEq?.[idx] ?? e.h1DrEq;
    e.entryBarIdx = idx;
    e.utcHour = new Date(e.entryTs).getUTCHours();
    if (e.h1DrEq != null && e.entryPrice > 0) {
      e.h1InDiscount = e.entryPrice <= e.h1DrEq;
      e.h1SideAligned =
        e.h1StructureState === "UNKNOWN" ||
        e.h1StructureState === "NEUTRAL" ||
        (e.side === "BUY" && e.h1StructureState !== "BEARISH") ||
        (e.side === "SELL" && e.h1StructureState !== "BULLISH");
      e.h1PoiAligned =
        (e.side === "BUY" && e.h1InDiscount) || (e.side === "SELL" && !e.h1InDiscount);
    }
  }
  return entries;
}

console.log(`\n══ BTC 1H→15m Phase 0 harvest — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.log(`candles=${candles.length} funding=${funding.length}`);

clearIntradayAdapterCache?.();
const raw = {
  ...HARVEST_PRACTICAL,
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

const entries = enrichWithH1(aggregateTrades(sim.trades ?? []), candles);
let eq = START;
const curve = [{ ts: fromMs, equity: eq }];
for (const e of entries) {
  eq += e.netPnl;
  curve.push({ ts: e.entryTs, equity: eq });
}
const m = computeAllMetrics({
  trades: entries.map((e) => ({ entryTs: e.entryTs, exitTs: e.exitTs, netPnl: e.netPnl })),
  equityCurve: curve,
  tf: TF,
  startingEquity: START,
});
const wins = entries.filter((e) => e.netPnl > 0).length;
const oos = entries.filter((e) => e.entryTs >= oosEndMs);
let oosEq = START;
for (const e of oos) oosEq += e.netPnl;

const summary = {
  n: entries.length,
  tw: +(entries.length / weeks).toFixed(2),
  td: +(entries.length / days).toFixed(2),
  wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
  ret: +(m.totalReturnPct ?? 0).toFixed(2),
  pf: +(m.profitFactor ?? 0).toFixed(2),
  dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  oosN: oos.length,
  oosRet: +(((oosEq - START) / START) * 100).toFixed(2),
  sampleOk: entries.length >= 30,
};

console.log(
  `HARVEST n=${summary.n} td=${summary.td}/day tw=${summary.tw}/wk wr=${summary.wr}% ret=${summary.ret}% pf=${summary.pf} oos=${summary.oosRet}% sampleOk=${summary.sampleOk}`,
);

const jsonlPath = path.join(__dirname, ".smc-btc-1h15m-phase0-tape.jsonl");
const summaryPath = path.join(__dirname, ".smc-btc-1h15m-phase0-harvest.json");
fs.writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      window: { FROM, TO, OOS_END },
      note: "Practical ICT harvest; invalidation OFF. Not an edge claim.",
      summary,
      profile: "HARVEST_PRACTICAL",
    },
    null,
    2,
  ),
);
console.log(`wrote ${path.basename(jsonlPath)} + ${path.basename(summaryPath)}`);
await closePool();
