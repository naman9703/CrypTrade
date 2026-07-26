#!/usr/bin/env node
/**
 * DOGE — post-cert freq optimize (gates pass; freq FAIL at 0.21/wk).
 * Keep bleed-POC deny. Try REJ-bleed deny + ATR loosen / score — never open VAL.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-postcert-freq.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "DOGEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  VOLUME_PROFILE_FREQ_DOGE_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const POC_BLEED = [
  "SELL|poc_bounce|weak_bear|structured",
  "SELL|poc_bounce|bear_trend|tight",
  "SELL|poc_bounce|bull_trend|vacuum",
  "SELL|poc_bounce|bear_trend|structured",
  "BUY|poc_bounce|bull_trend|vacuum",
  "SELL|poc_bounce|bear_trend|vacuum",
];

const REJ_BLEED = [
  "SELL|va_rejection|bull_trend|vacuum",
  "BUY|va_rejection|bull_chop|structured",
];

const LOCK = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpNoveltyEnabled: false,
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...LOCK, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const VARIANTS = [
  { id: "H0_locked", over: {} },
  {
    id: "deny_rej_bleed",
    over: {
      vpPreparedBlockCellKeys: [...POC_BLEED, ...REJ_BLEED],
    },
  },
  {
    id: "deny_rej_bleed+atr007",
    over: {
      vpPreparedBlockCellKeys: [...POC_BLEED, ...REJ_BLEED],
      vpMinAtrPct: 0.007,
    },
  },
  {
    id: "deny_rej_bleed+atr0065",
    over: {
      vpPreparedBlockCellKeys: [...POC_BLEED, ...REJ_BLEED],
      vpMinAtrPct: 0.0065,
    },
  },
  {
    id: "deny_sell_bull_vac_rej+atr007",
    over: {
      vpPreparedBlockCellKeys: [...POC_BLEED, "SELL|va_rejection|bull_trend|vacuum"],
      vpMinAtrPct: 0.007,
    },
  },
  {
    id: "add_naked",
    over: { vpAllowedSetups: ["va_rejection", "poc_bounce", "naked_poc"] },
  },
  {
    id: "add_lvn",
    over: { vpAllowedSetups: ["va_rejection", "poc_bounce", "lvn_vacuum"] },
  },
  {
    id: "maxDay3",
    over: { vpMaxTradesPerDay: 3 },
  },
  {
    id: "htf_0010",
    over: { vpMinHtfSepPct: 0.001 },
  },
  {
    id: "deny_rej_bleed+htf10+atr007",
    over: {
      vpPreparedBlockCellKeys: [...POC_BLEED, ...REJ_BLEED],
      vpMinHtfSepPct: 0.001,
      vpMinAtrPct: 0.007,
    },
  },
];

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);

const results = [];
let h0 = null;
for (const v of VARIANTS) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  if (!h0) h0 = m;
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const calmarOk = m.calmar > 1;
  const retOk = m.ret >= h0.ret - 50;
  const twUp = m.tw >= 0.35; // meaningful step toward deployable
  results.push({ id: v.id, ...m, red, allNonNeg, calmarOk, retOk, twUp });
  console.log(
    `${v.id}\n  n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${red.join(" ") || "none"} | clean=${allNonNeg} cal>1=${calmarOk}`,
  );
}

results.sort(
  (a, b) =>
    Number(b.allNonNeg && b.calmarOk) - Number(a.allNonNeg && a.calmarOk) ||
    b.tw - a.tw ||
    b.ret - a.ret,
);
console.log("\n══ Ranked ══");
for (const r of results) {
  console.log(
    `${r.id.padEnd(36)} clean=${r.allNonNeg} cal>1=${r.calmarOk} tw=${r.tw} ret=${r.ret}% | ${r.red.join(",") || "none"}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-postcert-freq.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), h0, results }, null, 2));
console.error("wrote", outPath);
await closePool?.();
