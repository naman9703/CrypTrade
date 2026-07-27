#!/usr/bin/env node
/**
 * AAVE F3 round-2 — cell/vacuum denies + stacks on Phase 0 HTF base.
 *
 * Round-1: no single lever year-cleaned. Soft drop_vacuum → only 2021-22 red;
 * sticky hard reds under HTF/ATR: 2023-24 + 2025-26. Best midFix keepGood:
 * sellExtDown (+115% cal 0.39) still 3 red years.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-f3-cell-clean.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "AAVEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const GOOD_YEARS = ["2020-21", "2024-25"];

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
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["va_rejection"],
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
};

const ALL_VACUUM = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bull_chop|vacuum",
  "SELL|va_rejection|bull_trend|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_trend|vacuum",
  "BUY|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|weak_bear|tight",
  "BUY|va_rejection|weak_bear|vacuum",
];

const BLEED_SELECT = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_chop|structured",
  "SELL|va_rejection|bull_chop|vacuum",
];

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
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...CORE, ...over, backtestSignalStartMs: fromMs };
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

function score(m, h0) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const keepGood = GOOD_YEARS.every((y) => {
    const a = m.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    return a >= b - 25;
  });
  return { red, allNonNeg, keepGood, accept: allNonNeg && keepGood };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const variants = [
  { id: "H0", over: {} },
  { id: "deny_bleed_select", over: { vpPreparedBlockCellKeys: BLEED_SELECT } },
  { id: "deny_all_vacuum", over: { vpPreparedBlockCellKeys: ALL_VACUUM.filter((k) => k.includes("|vacuum")) } },
  {
    id: "deny_vac+chopStruct",
    over: {
      vpPreparedBlockCellKeys: [
        ...ALL_VACUUM.filter((k) => k.includes("|vacuum")),
        "BUY|va_rejection|bull_chop|structured",
      ],
    },
  },
  {
    id: "deny_SELL_vac",
    over: {
      vpPreparedBlockCellKeys: ALL_VACUUM.filter((k) => k.startsWith("SELL|") && k.includes("|vacuum")),
    },
  },
  {
    id: "deny_SELL_bull_vac",
    over: {
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|bull_trend|vacuum",
        "SELL|va_rejection|bull_chop|vacuum",
        "SELL|va_rejection|weak_bear|vacuum",
      ],
    },
  },
  { id: "sellExtDown", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  {
    id: "sellExt+bleed",
    over: {
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
      vpPreparedBlockCellKeys: BLEED_SELECT,
    },
  },
  {
    id: "htf50+atr008",
    over: { vpMinHtfSepPct: 0.005, vpMinAtrPct: 0.008 },
  },
  {
    id: "htf50+atr008+bleed",
    over: {
      vpMinHtfSepPct: 0.005,
      vpMinAtrPct: 0.008,
      vpPreparedBlockCellKeys: BLEED_SELECT,
    },
  },
  {
    id: "htf50+atr008+denyVac",
    over: {
      vpMinHtfSepPct: 0.005,
      vpMinAtrPct: 0.008,
      vpPreparedBlockCellKeys: ALL_VACUUM.filter((k) => k.includes("|vacuum")),
    },
  },
  {
    id: "htf50+atr008+sellExt+bleed",
    over: {
      vpMinHtfSepPct: 0.005,
      vpMinAtrPct: 0.008,
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
      vpPreparedBlockCellKeys: BLEED_SELECT,
    },
  },
  {
    id: "deny_vac+chop+sellExt",
    over: {
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
      vpPreparedBlockCellKeys: [
        ...ALL_VACUUM.filter((k) => k.includes("|vacuum")),
        "BUY|va_rejection|bull_chop|structured",
      ],
    },
  },
  // SELL-only rej (soft drop_BUY was mixed)
  { id: "SELL_only", over: { vpAllowedSides: ["SELL"] } },
  {
    id: "SELL_only+bleed",
    over: { vpAllowedSides: ["SELL"], vpPreparedBlockCellKeys: BLEED_SELECT },
  },
];

console.log(`\n══ AAVE F3 cell/vacuum clean A/B ══`);
const ab = [];
let h0 = null;
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  if (!h0) h0 = m;
  const sc = score(m, h0);
  ab.push({ id: v.id, over: v.over, ...m, ...sc });
  console.log(
    `${v.id}\n  n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} pf=${m.pf} dd=${m.dd}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | clean=${sc.allNonNeg} keepGood=${sc.keepGood} → ${sc.accept ? "ACCEPT" : "reject"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.accept) - Number(a.accept) ||
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.keepGood) - Number(a.keepGood) ||
    b.calmar - a.calmar ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(28)} accept=${r.accept} clean=${r.allNonNeg} keep=${r.keepGood} n=${r.trades} tw=${r.tw} ret=${r.ret}% cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best = ab.find((r) => r.accept) || ab.find((r) => r.allNonNeg);
const outPath = path.join(__dirname, ".vp-freq-aave-f3-cell-clean.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, h0, ab, best: best ? { id: best.id, over: best.over, tw: best.tw, ret: best.ret, calmar: best.calmar, years: best.years, red: best.red } : null }, null, 2),
);
console.error("wrote", outPath);
console.log(`\n══ Best: ${best?.id ?? "none"} ══`);
await closePool?.();
