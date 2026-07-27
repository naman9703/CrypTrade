#!/usr/bin/env node
/**
 * NEAR VP FREQ — F3 va_rejection round-2: HTF-sep ladder for max-N year-clean.
 *
 * Round-1 autopsy finding: NEAR F3 needs HTF align to exist at all (open book
 * = -99.99%, 1117 trades). HTF sep is the master lever and monotonically cleans
 * years + lifts Calmar:
 *   sep 0.0015 (n93) reds 23-24,24-25 · 0.0035 (n50) reds 21-22,24-25
 *   0.005 (n34) CLEAN cal 1.66 +204%
 * Sticky reds: 2024-25 (then 2023-24). This round finds the highest-frequency
 * year-clean point (fine sep ladder 0.0035..0.0050) + atr008 which lifts Calmar.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-near-f3-htf-ladder.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "NEARUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
// Reds under the real HTF-aligned baseline (sep 0.0015); everything else green.
const GOOD_YEARS = ["2020-21", "2021-22", "2022-23", "2025-26"];

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
  // HTF align is the required base for NEAR.
  vpRequireHtfAlign: true,
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

function score(m) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  return { red, allNonNeg };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const variants = [
  { id: "sep_0015 (base)", over: { vpMinHtfSepPct: 0.0015 } },
  { id: "sep_0040", over: { vpMinHtfSepPct: 0.004 } },
  { id: "sep_0045", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "sep_0050", over: { vpMinHtfSepPct: 0.005 } },
  { id: "sep_0040+atr008", over: { vpMinHtfSepPct: 0.004, vpMinAtrPct: 0.008 } },
  { id: "sep_0045+atr008", over: { vpMinHtfSepPct: 0.0045, vpMinAtrPct: 0.008 } },
  { id: "sep_0050+atr008", over: { vpMinHtfSepPct: 0.005, vpMinAtrPct: 0.008 } },
  { id: "sep_0040+atr008+buyP60", over: { vpMinHtfSepPct: 0.004, vpMinAtrPct: 0.008, vpBuyRejectionMaxPrior60dPct: 1.0 } },
];

console.log(`\n══ NEAR F3 HTF-sep ladder (HTF-aligned base) ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = score(m);
  ab.push({ id: v.id, over: v.over, ...m, ...sc });
  console.log(
    `${v.id}\n  n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} pf=${m.pf} dd=${m.dd}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | clean=${sc.allNonNeg}`,
  );
}

// rank: clean first, then most trades, then Calmar
ab.sort((a, b) => Number(b.allNonNeg) - Number(a.allNonNeg) || b.trades - a.trades || b.calmar - a.calmar);
console.log("\n══ Ranked (clean → max-N → Calmar) ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(26)} clean=${r.allNonNeg} n=${r.trades} tw=${r.tw} ret=${r.ret}% cal=${r.calmar} dd=${r.dd} | ${r.red.join(",") || "none"}`,
  );
}

const best = ab.find((r) => r.allNonNeg);
const outPath = path.join(__dirname, ".vp-freq-near-f3-htf-ladder.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, ab, best: best ? { id: best.id, over: best.over, tw: best.tw, ret: best.ret, calmar: best.calmar, years: best.years } : null }, null, 2));
console.error("wrote", outPath);
console.log(`\n══ Best clean (max-N): ${best?.id ?? "none"} ══`);
await closePool?.();
