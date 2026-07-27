#!/usr/bin/env node
/**
 * AAVE F3 — fine HTF ladder on sellExt+bleed for year-clean frontier.
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-f3-htf-fine.mjs
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
const BLEED = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_chop|structured",
  "SELL|va_rejection|bull_chop|vacuum",
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_BASE, VOLUME_PROFILE_FREQ_CORE, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js"
);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const LOCK = {
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
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpPreparedBlockCellKeys: BLEED,
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
  for (const y of Object.values(years)) y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return { trades: trades.length, tw: +(trades.length / weeks).toFixed(2), ret: +(m.totalReturnPct ?? 0).toFixed(2), calmar: +(m.calmar ?? 0).toFixed(2), dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2), pf: +(m.profitFactor ?? 0).toFixed(2), years };
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
  return (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial").filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);

const seps = [0.0032, 0.0034, 0.0035, 0.0036, 0.0037, 0.0038];
const ab = [];
console.log("══ AAVE fine HTF on sellExt+bleed ══");
for (const sep of seps) {
  const id = `htf_${String(sep).replace("0.", "")}`;
  console.error(`run ${id}`);
  const trades = await run(candles, funding, { vpMinHtfSepPct: sep });
  const m = metricsFor(trades);
  const red = Object.entries(m.years).filter(([, s]) => s.retPct < 0).map(([y, s]) => `${y}=${s.retPct}%`);
  const clean = red.length === 0 && m.trades >= 20;
  ab.push({ id, sep, ...m, red, clean });
  console.log(`${id} n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} dd=${m.dd} | ${Object.entries(m.years).map(([y,s])=>`${y}:${s.retPct}%/${s.n}`).join(" ")} | RED:${red.join(",")||"none"} clean=${clean}`);
}

// also: htf35 + deny structured bleeds only (not vacuum)
console.error("run htf35+deny_struct");
{
  const trades = await run(candles, funding, {
    vpMinHtfSepPct: 0.0035,
    vpPreparedBlockCellKeys: [
      ...BLEED,
      "SELL|va_rejection|bull_trend|structured",
      "BUY|va_rejection|bull_trend|structured",
    ],
  });
  const m = metricsFor(trades);
  const red = Object.entries(m.years).filter(([, s]) => s.retPct < 0).map(([y, s]) => `${y}=${s.retPct}%`);
  ab.push({ id: "htf35+deny_struct", sep: 0.0035, ...m, red, clean: red.length === 0 && m.trades >= 20 });
  console.log(`htf35+deny_struct n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} | RED:${red.join(",")||"none"}`);
}

ab.sort((a, b) => Number(b.clean) - Number(a.clean) || b.calmar - a.calmar || b.ret - a.ret);
const best = ab.find((r) => r.clean) || ab[0];
fs.writeFileSync(path.join(__dirname, ".vp-freq-aave-f3-htf-fine.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ab, best }, null, 2));
console.log(`\nBest: ${best.id} clean=${best.clean} cal=${best.calmar}`);
await closePool?.();
