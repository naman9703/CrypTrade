#!/usr/bin/env node
/**
 * DOGE F3 — hard A/B: bear-trend-scoped SELL rej HTF floor
 * (vpRejectionSellBearMinHtfSepPct) vs H0 / global sell HTF.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-bear-htf-ab.mjs
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
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
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

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const variants = [
  { id: "H0_baseline", over: {} },
  { id: "global_sell_htf_035", over: { vpSellMinHtfSepPct: 0.0035 } },
  { id: "bear_rej_htf_035", over: { vpRejectionSellBearMinHtfSepPct: 0.0035 } },
  { id: "bear_rej_htf_050", over: { vpRejectionSellBearMinHtfSepPct: 0.005 } },
  { id: "bear_rej_htf_025", over: { vpRejectionSellBearMinHtfSepPct: 0.0025 } },
];

console.log(`\n══ DOGE F3 bear-scoped SELL rej HTF A/B ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, ...m });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} dd=${m.dd}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}`,
  );
}

const h0 = ab[0];
console.log("\n══ Accept vs H0 (bad↑, 21-22/25-26 keep, full↑, tw≥70%) ══");
for (const r of ab.slice(1)) {
  const bad0 = h0.years["2024-25"]?.retPct ?? -999;
  const bad1 = r.years["2024-25"]?.retPct ?? -999;
  const y21 = r.years["2021-22"]?.retPct ?? 0;
  const y21b = h0.years["2021-22"]?.retPct ?? 0;
  const y25 = r.years["2025-26"]?.retPct ?? 0;
  const y25b = h0.years["2025-26"]?.retPct ?? 0;
  const accept =
    bad1 > bad0 + 5 &&
    y21 >= y21b - 10 &&
    y25 >= y25b - 15 &&
    r.ret > h0.ret &&
    r.tw >= h0.tw * 0.7;
  console.log(
    `${r.id.padEnd(22)} accept=${accept} bad ${bad0}→${bad1} | 21-22 ${y21b}→${y21} | 25-26 ${y25b}→${y25} | full ${h0.ret}→${r.ret} tw ${h0.tw}→${r.tw}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-bear-htf-ab.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), ab }, null, 2));
console.error("wrote", outPath);
await closePool?.();
