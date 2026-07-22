#!/usr/bin/env node
/**
 * SOL H8 + wick0.40 Calmar close — one-change combos only on top of locked wick.
 * Hypothesis: weak-wick rej left-tail fixed at 0.40; residual DD needs HTF or vol-target.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "SOLUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_BASE, VOLUME_PROFILE_FREQ_CORE, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js",
);
const { monteCarloBootstrap, acceptanceGates } = await import("../src/backtest/engine/validation.js");

const LOCK = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpRejectionMinWickRatio: 0.4,
  vpNoveltyEnabled: false,
};

const VARIANTS = [
  { id: "wick40_base", patch: {} },
  { id: "wick40_htf020", patch: { vpMinHtfSepPct: 0.002 } },
  { id: "wick40_htf018", patch: { vpMinHtfSepPct: 0.0018 } },
  {
    id: "wick40_voltarget",
    patch: {
      volTargetSizing: true,
      volTargetAtrPct: 0.005,
      volTargetMinMult: 0.4,
      volTargetMaxMult: 2,
    },
  },
  {
    id: "wick40_htf020_vol",
    patch: {
      vpMinHtfSepPct: 0.002,
      volTargetSizing: true,
      volTargetAtrPct: 0.005,
      volTargetMinMult: 0.4,
      volTargetMaxMult: 2,
    },
  },
  {
    id: "wick40_chop",
    patch: {
      backtestChopMfeTrail: true,
      backtestChopMfeTrailSides: "SELL",
      backtestChopPriorMs: 60 * 86_400_000,
      backtestChopPriorAbsMax: 0.05,
      backtestChopMfeTrailActivatePct: 0.01,
      backtestChopMfeTrailGivebackFrac: 0.35,
    },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function yearTable(closed) {
  const years = {};
  let eq = START;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? +(((r.end - r.start) / r.start) * 100).toFixed(2) : 0;
  }
  return years;
}

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
console.log("Loading candles…");
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, padFrom, toMs);
} catch {
  funding = [];
}
console.log(`candles=${candles.length} funding=${funding.length}`);

const rows = [];
for (const v of VARIANTS) {
  const cfg = {
    ...LOCK,
    ...v.patch,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  process.stderr.write(`sim ${v.id}…\n`);
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
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const m = computeAllMetrics({ trades: closed, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const mc = monteCarloBootstrap(rMultipleStats(sim.trades).rValues, {
    paths: 3000,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const gate = acceptanceGates({
    oosReturnPct: m.totalReturnPct,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: 0,
  });
  const years = yearTable(closed);
  const negYears = Object.entries(years)
    .filter(([, y]) => y.retPct < 0)
    .map(([y]) => y);
  const row = {
    id: v.id,
    trades: closed.length,
    tPerWk: +((closed.length / ((toMs - fromMs) / (7 * 86_400_000)))).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    cagr: +(m.cagrPct ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(2),
    allPass: gate.allPass,
    gates: Object.entries(gate.gates)
      .map(([k, g]) => `${g.pass ? "P" : "F"}:${k}`)
      .join(" "),
    negYears,
    years,
  };
  rows.push(row);
  console.log(
    `${v.id.padEnd(20)} N=${row.trades} ret=${row.ret}% CAGR=${row.cagr}% DD=${row.dd}% Cal=${row.calmar} MCp5=${row.mcP5}% ${row.gates} neg=${negYears.join(",") || "none"}`,
  );
}

const out = path.join(__dirname, ".vp-freq-sol-wick40-calmar.json");
fs.writeFileSync(out, JSON.stringify({ from: FROM, to: TO, rows }, null, 2));
console.log("Wrote", out);
await closePool?.();
