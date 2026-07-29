#!/usr/bin/env node
/**
 * BTC SMC/ICT Phase 0 baseline — coin-native SR_INTRADAY SMC profiles.
 *
 * Presets today are BNB-tuned. This screens BTCUSDT 15m across sweep / balanced /
 * research / full profiles with realistic costs + funding + OOS holdout.
 *
 *   node scripts/research-smc-btc-phase0-baseline.mjs
 *   SKIP_ENSURE=1 FROM=2023-01-01 TO=2026-05-31 node scripts/research-smc-btc-phase0-baseline.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2023-01-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2024-06-01";
const START = Number(process.env.START_USDT || 10_000);
const RISK = 2.5;
const LEV = 12;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
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
    const cur = m.get(ts) ?? { entryTs: ts, netPnl: 0, side: t.direction ?? t.side, reason: t.entryReason };
    cur.netPnl += Number(t.netPnl ?? 0);
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
    exitTs: e.entryTs,
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
  const is_ = entries.filter((e) => e.entryTs < oosEndMs);
  let isEq = START;
  for (const e of is_) isEq += e.netPnl;
  const wins = entries.filter((e) => e.netPnl > 0).length;
  const redYears = Object.entries(years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
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
    isN: is_.length,
    isRet: is_.length ? +(((isEq - START) / START) * 100).toFixed(2) : 0,
    years,
    redYears,
  };
}

async function runPreset(label, preset, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...preset,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEV,
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
      riskPerTrade: RISK,
      futuresLeverage: LEV,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: LEV,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const entries = aggregateEntries(sim.trades ?? []);
  const m = metricsFor(entries);
  return { id: label, over, ...m, entries };
}

const BALANCED = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcIctProfile: "balanced",
  intradaySmcRequireMss: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireChoch: false,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradaySmcKillzoneMode: "ALL",
};

console.log(`\n══ BTC SMC/ICT Phase 0 — ${SYMBOL} ${TF} ${FROM}→${TO} (OOS ${OOS_END}) ══`);

if (process.env.SKIP_ENSURE !== "1") {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
  try {
    await ensureFunding(SYMBOL, { from: padFrom, to: toMs });
  } catch (e) {
    console.error(`funding ensure fail: ${e.message || e}`);
  }
}

const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(
  `candles=${candles.length} funding=${funding.length} ${candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "none"}→${candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "none"}`,
);

/** CHoCH/MSS/full stacks are O(n·lookback) per bar on BTC multi-year — opt-in only. */
const INCLUDE_STRICT = process.env.INCLUDE_STRICT === "1";

const variants = [
  { id: "sweep_default", preset: INTRADAY_PRO_ICT_15M, over: {} },
  {
    id: "sweep_kz_london_ny",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcKillzoneMode: "LONDON_NY" },
  },
  {
    id: "sweep_maxHold24",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcMaxHoldBars: 24 },
  },
  {
    id: "sweep_minRr2",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcMinRr: 2, intradayLiqMinRr: 2 },
  },
  {
    id: "sweep_adx18",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcMinAdx: 18 },
  },
  {
    id: "sweep_htf_parallel",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcHtfBiasMode: "parallel", intradaySmcHtfStrictness: "either" },
  },
  {
    id: "sweep_score9",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradaySmcMinScore: 9, srIntradayMinScore: 9 },
  },
  {
    id: "sweep_ext005",
    preset: INTRADAY_PRO_ICT_15M,
    over: { intradayLiqMinSweepExtensionPct: 0.005 },
  },
  ...(INCLUDE_STRICT
    ? [
        {
          id: "sweep_choch_on",
          preset: INTRADAY_PRO_ICT_15M,
          over: { intradaySmcRequireChoch: true },
        },
        { id: "balanced", preset: BALANCED, over: {} },
        { id: "research_fvg_ce", preset: INTRADAY_PRO_ICT_RESEARCH_15M, over: {} },
        { id: "full_ict", preset: INTRADAY_PRO_ICT_FULL_15M, over: {} },
      ]
    : []),
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const r = await runPreset(v.id, v.preset, v.over);
  results.push(r);
  console.log(
    `${v.id.padEnd(22)} n=${String(r.trades).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% is=${String(r.isRet).padStart(7)}% cal=${String(r.calmar).padStart(6)} pf=${r.pf} dd=${r.dd}% | ${r.redYears.join(",") || "none"}`,
  );
}

const ranked = [...results].sort((a, b) => {
  const aOk = a.oosRet > 0 && a.ret > 0 ? 1 : 0;
  const bOk = b.oosRet > 0 && b.ret > 0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  if (b.calmar !== a.calmar) return b.calmar - a.calmar;
  return b.ret - a.ret;
});

console.log("\n══ Rank (OOS>0 & FULL>0 first) ══");
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(22)} ret=${r.ret}% oos=${r.oosRet}% tw=${r.tw} n=${r.trades} oosN=${r.oosN} cal=${r.calmar}`,
  );
}

const best = ranked.find((r) => r.ret > 0 && r.oosRet > 0) || ranked[0];
const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  tf: TF,
  window: { from: FROM, to: TO, oosEnd: OOS_END },
  note: "BNB-tuned SMC presets applied to BTC — Phase 0 coin-native screen",
  results: results.map(({ entries, ...rest }) => rest),
  best: best ? { id: best.id, ret: best.ret, oosRet: best.oosRet, tw: best.tw, trades: best.trades } : null,
};
fs.writeFileSync(path.join(__dirname, ".smc-btc-phase0-baseline.json"), JSON.stringify(out, null, 2));
console.log(`\n══ Best: ${best?.id ?? "NONE"} ret=${best?.ret}% oos=${best?.oosRet}% tw=${best?.tw} ══`);
await closePool?.();
