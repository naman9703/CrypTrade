#!/usr/bin/env node
/**
 * BTC SMC — prerequisite concept A/B (invalidation + PD-after-CHoCH).
 *
 * Baseline = prior practical ICT with concept flags forced OFF (legacy behaviour).
 * Concept  = defaults ON when RequireChoch (reclaimed CHoCH / blown OB /
 *            mitigated FVG / continuation sweep + PD formed after CHoCH).
 *
 * One concept package (not a knob grid) — frozen in docs/SMC_ICT_FROZEN_RULESET.md
 *
 *   SKIP_ENSURE=1 FROM=2025-01-01 TO=2026-06-01 node scripts/research-smc-btc-prerequisite-ab.mjs
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
const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));

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
  intradaySmcRequirePdInducement: false,
};

const VARIANTS = [
  {
    id: "legacy_no_invalidation",
    note: "Prior practical path — concept flags forced OFF",
    patch: {
      intradaySmcEnforceInvalidation: false,
      intradaySmcRequirePdAfterChoch: false,
      intradaySmcInvalidateReclaimedChoch: false,
      intradaySmcInvalidateBlownOb: false,
      intradaySmcRequireUnmitigatedFvgAtEntry: false,
      intradaySmcRejectContinuationSweeps: false,
    },
  },
  {
    id: "prerequisite_concept",
    note: "Invalidation + PD-after-CHoCH (defaults for RequireChoch)",
    patch: {
      // leave flags undefined → resolve* defaults ON with RequireChoch
    },
  },
];

function aggregate(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const cur = m.get(ts) ?? {
      entryTs: ts,
      netPnl: 0,
      mfePct: Number(t.mfePct ?? 0),
    };
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
    ...PRACTICAL,
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

console.log(`\n══ BTC SMC prerequisite A/B — ${FROM}→${TO} (OOS ${OOS_END}) ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.log(`candles=${candles.length} funding=${funding.length}`);
if (!candles.length) {
  console.error("No candles — abort");
  await closePool?.();
  process.exit(1);
}

const results = [];
for (const v of VARIANTS) {
  console.log(`run ${v.id}`);
  const t0 = Date.now();
  const m = await runVariant(v.id, v.patch);
  const sec = Math.round((Date.now() - t0) / 1000);
  const row = { ...m, note: v.note, sec };
  results.push(row);
  console.log(
    `${v.id.padEnd(28)} n=${String(m.n).padStart(4)} tw=${String(m.tw).padStart(5)} wr=${String(m.wr).padStart(5)}% ret=${String(m.ret).padStart(8)}% oos=${String(m.oosRet).padStart(7)}% pf=${String(m.pf).padStart(5)} ng=${m.neverGreen} (${sec}s)`,
  );
}

const outPath = path.join(__dirname, ".smc-btc-prerequisite-ab.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), window: { FROM, TO, OOS_END }, results }, null, 2),
);
console.log(`\nwrote ${path.basename(outPath)}`);

const legacy = results.find((r) => r.id === "legacy_no_invalidation");
const concept = results.find((r) => r.id === "prerequisite_concept");
if (legacy && concept) {
  const better =
    concept.oosRet > legacy.oosRet && concept.ret > legacy.ret && concept.pf > legacy.pf;
  const stillRed = concept.ret <= 0 || concept.oosRet <= 0 || concept.pf < 1;
  console.log(
    `\nverdict=${stillRed ? (better ? "CONCEPT_HELPS_STILL_RED" : "CONCEPT_NO_EDGE") : "CONCEPT_GREEN_CHECK"} ` +
      `Δret=${(concept.ret - legacy.ret).toFixed(2)} Δoos=${(concept.oosRet - legacy.oosRet).toFixed(2)} Δn=${concept.n - legacy.n}`,
  );
}

await closePool?.();
