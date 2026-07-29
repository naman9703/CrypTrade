#!/usr/bin/env node
/**
 * XAUUSDT SMC/ICT Phase 0 — coin-native screen (short history).
 *
 * XAU futures onboard ~2025-12-11 (~7mo). Multi-year cert impossible.
 * Tests sweep / practical ICT / guide-ish / research on available window.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-xau-phase0.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "XAUUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2025-12-15";
const TO = process.env.TO || "2026-07-20";
const OOS_END = process.env.OOS_END || "2026-04-01";
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
  INTRADAY_PRO_ICT_RESEARCH_15M,
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
};

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
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    neverGreen,
  };
}

async function run(label, preset, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...preset,
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
  return { id: label, ...metrics(aggregate(sim.trades ?? [])) };
}

console.log(`\n══ XAU SMC/ICT Phase 0 — ${FROM}→${TO} (OOS ${OOS_END}) ══`);
console.error("NOTE: ~7mo history only — exploratory checkpoint, not multi-year cert.");

const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(
  `candles=${candles.length} funding=${funding.length} ${candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "?"}→${candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "?"}`,
);

const variants = [
  { id: "sweep_default", preset: INTRADAY_PRO_ICT_15M, over: {} },
  { id: "practical_ict", preset: PRACTICAL, over: {} },
  {
    id: "practical_inducement",
    preset: PRACTICAL,
    over: { intradaySmcRequirePdInducement: true },
  },
  {
    id: "guide_mss_kz",
    preset: PRACTICAL,
    over: {
      intradaySmcRequireMss: true,
      intradaySmcKillzoneMode: "LONDON_NY",
      intradaySmcRequirePremiumDiscount: true,
    },
  },
  {
    id: "research_preset",
    preset: INTRADAY_PRO_ICT_RESEARCH_15M,
    over: {
      symbol: SYMBOL,
      intradaySmcOneTradePerDay: false,
      intradayLiqOnePickPerDay: false,
      srIntradayMaxTradesPerDay: 8,
      intradaySmcSlMode: "pd_array",
      intradaySmcKillzoneMode: "ALL",
    },
  },
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  const r = await run(v.id, v.preset, v.over);
  results.push(r);
  const tag = r.n >= 30 && r.ret > 0 && r.oosRet > 0 ? "INTEREST" : r.n < 10 ? "THIN" : r.ret > 0 ? "IS_ONLY" : "RED";
  console.log(
    `${r.id.padEnd(22)} n=${String(r.n).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% pf=${r.pf} ng=${r.neverGreen} ${tag} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}

results.sort((a, b) => {
  const score = (r) => (r.oosRet > 0 && r.ret > 0 ? 2 : 0) + (r.n >= 30 ? 1 : 0);
  if (score(b) !== score(a)) return score(b) - score(a);
  return b.oosRet - a.oosRet || b.ret - a.ret;
});

console.log("\n══ Rank ══");
for (const r of results) {
  console.log(`${r.id.padEnd(22)} ret=${r.ret}% oos=${r.oosRet}% tw=${r.tw} n=${r.n} oosN=${r.oosN}`);
}

const best = results[0];
const verdict =
  best?.ret > 0 && best?.oosRet > 0 && best?.n >= 30
    ? "CHECKPOINT_INTEREST"
    : best?.ret > 0 && best?.n >= 10
      ? "THIN_OR_NO_OOS"
      : "REJECT_PHASE0";

fs.writeFileSync(
  path.join(__dirname, ".smc-xau-phase0.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      window: { from: FROM, to: TO, oosEnd: OOS_END },
      historyNote: "XAUUSDT futures ~2025-12-11 onboard; multi-year cert impossible",
      verdict,
      results,
    },
    null,
    2,
  ),
);
console.log(`\nverdict=${verdict} best=${best?.id}`);
console.log("wrote .smc-xau-phase0.json");
await closePool();
