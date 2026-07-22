#!/usr/bin/env node
/** SOL — surgical relief-bounce (only when prior60 deep bear). Full resim A/B. */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const { monteCarloBootstrap, acceptanceGates } = await import("../src/backtest/engine/validation.js");

const FROM = "2021-01-01";
const TO = "2026-05-31";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const fold0From = Date.parse("2021-11-26T00:00:00Z");
const fold0To = Date.parse("2022-10-21T00:00:00Z");

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "SOLUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.002,
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
  { id: "wick40_htf020", patch: {} },
  {
    id: "relief_all_0.15",
    patch: { vpValSellBlockReliefBounce: true, vpValSellReliefBounceMaxPct: 0.15 },
  },
  {
    id: "relief_0.18",
    patch: { vpValSellBlockReliefBounce: true, vpValSellReliefBounceMaxPct: 0.18 },
  },
  {
    id: "relief_0.20",
    patch: { vpValSellBlockReliefBounce: true, vpValSellReliefBounceMaxPct: 0.2 },
  },
  {
    id: "relief_deep_p60_-0.35",
    patch: {
      vpValSellBlockReliefBounce: true,
      vpValSellReliefBounceMaxPct: 0.15,
      vpValSellReliefBounceMinPrior60dPct: -0.35,
    },
  },
  {
    id: "relief_deep_p60_-0.40",
    patch: {
      vpValSellBlockReliefBounce: true,
      vpValSellReliefBounceMaxPct: 0.15,
      vpValSellReliefBounceMinPrior60dPct: -0.4,
    },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

const candles = await readCandles(
  "SOLUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", CORE),
  toMs,
  { market: "futures" },
);
let funding = [];
try {
  funding = await readFundingRates("SOLUSDT", volumeProfilePadFromMs(fromMs, "15m", CORE), toMs);
} catch {
  funding = [];
}

const rows = [];
for (const v of VARIANTS) {
  const cfg = {
    ...CORE,
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
    startingUsdt: 100,
    timeframe: "15m",
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") },
    symbol: "SOLUSDT",
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const m = computeAllMetrics({
    trades: closed,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: 100,
  });
  const mc = monteCarloBootstrap(rMultipleStats(sim.trades).rValues, {
    paths: 3000,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const years = {};
  let eq = 100;
  for (const t of closed) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += Number(t.netPnl);
    eq += Number(t.netPnl);
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? +(((r.end - r.start) / r.start) * 100).toFixed(1) : 0;
  }
  const fold0 = closed.filter((t) => {
    const ts = Number(t.entryTs);
    return ts >= fold0From && ts < fold0To;
  });
  const gate = acceptanceGates({
    oosReturnPct: m.totalReturnPct,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: 0,
  });
  const row = {
    id: v.id,
    n: closed.length,
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    cal: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(1),
    fold0: `${fold0.length}/${fold0.reduce((s, t) => s + Number(t.netPnl), 0).toFixed(1)}`,
    negYears: Object.entries(years)
      .filter(([, y]) => y.retPct < 0)
      .map(([y]) => y),
    corePass: gate.gates.mcP5Positive.pass && gate.gates.calmarOver1.pass,
    years,
  };
  rows.push(row);
  console.log(
    `${v.id.padEnd(18)} N=${row.n} ret=${row.ret}% Cal=${row.cal} DD=${row.dd}% MCp5=${row.mcP5}% fold0=${row.fold0} core=${row.corePass} neg=${row.negYears.join(",") || "none"}`,
  );
}

fs.writeFileSync(
  path.join(__dirname, ".vp-freq-sol-relief-ab.json"),
  JSON.stringify({ rows }, null, 2),
);
await closePool?.();
