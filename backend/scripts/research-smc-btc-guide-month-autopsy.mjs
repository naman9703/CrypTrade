#!/usr/bin/env node
/**
 * BTC SMC — GUIDE_ALIGNED month tape + loss taxonomy.
 *
 * True ICT sequence (not sweep): CHoCH → MSS → FVG/OB retrace → London/NY +
 * premium/discount. Exports trades with smcMeta for concept autopsy.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-guide-month-autopsy.mjs
 *   FROM=2026-04-01 TO=2026-05-01 SL_MODE=ob_edge node ...
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-04-01";
const TO = process.env.TO || "2026-05-01";
const START = Number(process.env.START_USDT || 10_000);
const SL_MODE = process.env.SL_MODE || "structure";

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

/** Guide-aligned ICT — explicit flags; does not mutate BNB sweep preset. */
export const GUIDE_ALIGNED_ICT_15M = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradaySmcIctProfile: "sweep", // base keys; requirements override below
  intradaySmcRequireChoch: true,
  intradaySmcRequireMss: true,
  intradaySmcRequireBos: false,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcRequireConfirm: false,
  intradaySmcChochStrict: false,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcFvgEntryMode: "zone",
  intradaySmcKillzoneMode: "LONDON_NY",
  intradaySmcRequirePremiumDiscount: true,
  intradaySmcPremiumDiscountOte: false,
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 5,
  intradaySmcMinRr: 1.5,
  // Default structure; set SL_MODE=pd_array for guide OB/FVG-edge stops.
  intradaySmcSlMode: SL_MODE,
  intradaySmcMaxHoldBars: 48,
  intradaySmcMaxTpRr: 5,
};

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = fromMs - 14 * 864e5;

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
      tpPrice: Number(t.tpPrice ?? 0),
      levelType: lc.levelType ?? meta.levelType ?? null,
      plannedRr: meta.plannedRr ?? lc.rr ?? null,
      entryZone: meta.entryZone ?? null,
      chochIdx: meta.chochIdx ?? null,
      chochType: meta.chochType ?? null,
      mssIdx: meta.mssIdx ?? null,
      bosIdx: meta.bosIdx ?? null,
      fvgTop: meta.fvgTop ?? null,
      fvgBottom: meta.fvgBottom ?? null,
      fvgFormedIdx: meta.fvgFormedIdx ?? null,
      obTop: meta.obTop ?? null,
      obBottom: meta.obBottom ?? null,
      obIdx: meta.obIdx ?? null,
      barsAfterReclaim: meta.barsAfterReclaim ?? null,
      sweepExtensionPct: meta.sweepExtensionPct ?? null,
      reclaimBodyRatio: meta.reclaimBodyRatio ?? null,
      htfBiasDisagreement: meta.htfBiasDisagreement ?? null,
      killzone: meta.killzone ?? null,
      ictProfile: meta.ictProfile ?? null,
      smcSlMode: meta.smcSlMode ?? null,
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

/**
 * Named concept failure modes (guide-aligned). Losers only.
 */
function classifyLoss(t) {
  const modes = [];
  if (t.chochIdx == null) modes.push("missing_choch");
  if (t.mssIdx == null && t.bosIdx == null) modes.push("missing_mss");
  if (!t.fvgTop && !t.obTop) modes.push("missing_pd_array");
  if (t.entryZone === "reclaim" || (t.barsAfterReclaim === 0 && t.entryZone !== "fvg" && t.entryZone !== "ob" && t.entryZone !== "fvg_mid")) {
    modes.push("chase_reclaim_entry");
  }
  // SL vs PD-array far edge (guide): BUY SL <= array bottom; SELL SL >= array top
  if (t.obTop != null && t.obBottom != null && t.slPrice > 0) {
    if (t.side === "BUY" && t.slPrice > t.obBottom + 1e-6) modes.push("sl_not_beyond_ob");
    if (t.side === "SELL" && t.slPrice < t.obTop - 1e-6) modes.push("sl_not_beyond_ob");
  } else if (t.fvgTop != null && t.fvgBottom != null && t.slPrice > 0) {
    const buf = 0.002;
    if (t.side === "BUY" && t.slPrice > t.fvgBottom * (1 + buf)) modes.push("sl_not_beyond_fvg");
    if (t.side === "SELL" && t.slPrice < t.fvgTop * (1 - buf)) modes.push("sl_not_beyond_fvg");
  }
  if (t.mfePct <= 0.001) modes.push("never_green_inducement");
  if (t.sweepExtensionPct != null && t.sweepExtensionPct < 0.003) modes.push("micro_sweep");
  if (t.htfBiasDisagreement === true) modes.push("htf_disagree");
  if (t.plannedRr != null && t.plannedRr < 1.5) modes.push("sub_min_rr");
  if (!modes.length) modes.push("concept_ok_still_lost");
  return modes;
}

function primaryMode(modes) {
  const priority = [
    "chase_reclaim_entry",
    "missing_choch",
    "missing_mss",
    "missing_pd_array",
    "sl_not_beyond_ob",
    "sl_not_beyond_fvg",
    "never_green_inducement",
    "micro_sweep",
    "htf_disagree",
    "sub_min_rr",
    "concept_ok_still_lost",
  ];
  for (const p of priority) if (modes.includes(p)) return p;
  return modes[0];
}

async function runOnce(label, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...GUIDE_ALIGNED_ICT_15M,
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
  const entries = aggregateTrades(sim.trades ?? []);
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
  return {
    id: label,
    over,
    n: entries.length,
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    entries,
  };
}

console.log(`\n══ GUIDE_ALIGNED month tape — ${SYMBOL} ${TF} ${FROM}→${TO} sl=${SL_MODE} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} ${candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "?"}→${candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "?"}`);

const baseline = await runOnce("guide_aligned", {});
console.log(
  `BASE n=${baseline.n} wr=${baseline.wr}% ret=${baseline.ret}% pf=${baseline.pf} dd=${baseline.dd}%`,
);

const annotated = baseline.entries.map((t) => {
  const modes = t.netPnl <= 0 ? classifyLoss(t) : [];
  return {
    ...t,
    entryIso: new Date(t.entryTs).toISOString(),
    exitIso: new Date(t.exitTs).toISOString(),
    failureModes: modes,
    primaryFailure: t.netPnl <= 0 ? primaryMode(modes) : null,
  };
});

const losers = annotated.filter((t) => t.netPnl <= 0);
const byMode = {};
for (const t of losers) {
  const k = t.primaryFailure ?? "unknown";
  byMode[k] ??= { n: 0, pnl: 0 };
  byMode[k].n += 1;
  byMode[k].pnl += t.netPnl;
}
const rankedModes = Object.entries(byMode)
  .map(([mode, s]) => ({ mode, n: s.n, pnl: +s.pnl.toFixed(2) }))
  .sort((a, b) => a.pnl - b.pnl);

console.log("\n── Loss taxonomy (primary mode, worst PnL first) ──");
for (const r of rankedModes) {
  console.log(`  ${r.mode.padEnd(28)} n=${String(r.n).padStart(3)} pnl=${r.pnl}`);
}

const topMode = rankedModes[0]?.mode ?? null;
console.log(`\n#1 failure mode: ${topMode ?? "none"}`);

const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  tf: TF,
  window: { from: FROM, to: TO },
  guideAligned: {
    requireChoch: true,
    requireMss: true,
    requireRetrace: true,
    killzone: "LONDON_NY",
    premiumDiscount: true,
    slMode: SL_MODE,
  },
  summary: {
    n: baseline.n,
    wr: baseline.wr,
    ret: baseline.ret,
    pf: baseline.pf,
    dd: baseline.dd,
    losers: losers.length,
    winners: baseline.n - losers.length,
  },
  lossTaxonomy: rankedModes,
  topFailureMode: topMode,
  trades: annotated,
};

const jsonPath = path.join(__dirname, ".smc-btc-guide-month-autopsy.json");
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

const csvPath = path.join(__dirname, ".smc-btc-guide-month-autopsy.csv");
const cols = [
  "entryIso",
  "side",
  "netPnl",
  "exitReason",
  "primaryFailure",
  "entryZone",
  "levelType",
  "plannedRr",
  "maePct",
  "mfePct",
  "chochIdx",
  "mssIdx",
  "obIdx",
  "fvgFormedIdx",
  "slPrice",
  "obBottom",
  "obTop",
  "barsAfterReclaim",
];
const lines = [cols.join(",")];
for (const t of annotated) {
  lines.push(cols.map((c) => JSON.stringify(t[c] ?? "")).join(","));
}
fs.writeFileSync(csvPath, lines.join("\n"));

console.log(`wrote ${jsonPath}`);
console.log(`wrote ${csvPath}`);
await closePool();
