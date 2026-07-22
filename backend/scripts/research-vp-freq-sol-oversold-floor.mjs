#!/usr/bin/env node
/** SOL — oversold VAL floor harvest filter for WF fold0 bleed. */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter, precomputeVolumeProfile } = await import(
  "../src/strategy/volumeProfileStrategy.js",
);
const { VOLUME_PROFILE_FREQ_SOL_15M, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js",
);
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { monteCarloBootstrap } = await import("../src/backtest/engine/validation.js");

const fromMs = Date.parse("2021-01-01");
const toMs = Date.parse("2026-05-31");
const fold0From = Date.parse("2021-11-26T00:00:00Z");
const fold0To = Date.parse("2022-10-21T00:00:00Z");

const LOCK = { ...VOLUME_PROFILE_FREQ_SOL_15M };
const cfg = {
  ...LOCK,
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

console.log("loading…");
const candles = await readCandles(
  "SOLUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", LOCK),
  toMs,
  { market: "futures" },
);
const pre = precomputeVolumeProfile(candles, LOCK);
const byTs = new Map(candles.map((c, i) => [Number(c.ts), i]));
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: "15m",
  adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") },
  symbol: "SOLUSDT",
});
const all = (sim.trades ?? [])
  .filter((t) => String(t.exitReason) !== "tp1_partial")
  .map((t) => {
    const idx = byTs.get(Number(t.entryTs));
    return {
      ...t,
      prior60: Number(pre.macroPrior60d?.[idx]),
      prior20: Number(pre.macroPrior20d?.[idx]),
      prior5: Number(pre.macroPrior5d?.[idx]),
    };
  });

const tests = [
  { id: "base", fn: null },
  {
    id: "block_p60<-0.55",
    fn: ({ prior60, setup }) => !(setup === "val_breakdown" && prior60 < -0.55),
  },
  {
    id: "block_p60<-0.50",
    fn: ({ prior60, setup }) => !(setup === "val_breakdown" && prior60 < -0.5),
  },
  {
    id: "block_p60<-0.45",
    fn: ({ prior60, setup }) => !(setup === "val_breakdown" && prior60 < -0.45),
  },
  {
    id: "block_p60<-0.40",
    fn: ({ prior60, setup }) => !(setup === "val_breakdown" && prior60 < -0.4),
  },
  {
    id: "block_p60<-0.35",
    fn: ({ prior60, setup }) => !(setup === "val_breakdown" && prior60 < -0.35),
  },
  { id: "drop_rej", fn: ({ setup }) => setup !== "va_rejection" },
  {
    id: "block_rej_p5>0",
    fn: ({ setup, prior5 }) => !(setup === "va_rejection" && prior5 > 0),
  },
];

for (const test of tests) {
  const closed = test.fn
    ? all.filter((t) =>
        test.fn({ prior60: t.prior60, prior20: t.prior20, prior5: t.prior5, setup: t.vpSetup }),
      )
    : all;
  let eq = 100;
  const curve = [{ equity: 100 }];
  for (const t of closed) {
    eq += Number(t.netPnl);
    curve.push({ equity: eq });
  }
  const m = computeAllMetrics({ trades: closed, equityCurve: curve, tf: "15m", startingEquity: 100 });
  const mc = monteCarloBootstrap(rMultipleStats(closed).rValues, {
    paths: 2000,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const fold0 = closed.filter((t) => {
    const ts = Number(t.entryTs);
    return ts >= fold0From && ts < fold0To;
  });
  console.log(
    `${test.id.padEnd(22)} N=${String(closed.length).padStart(3)} ret=${(m.totalReturnPct ?? 0).toFixed(1).padStart(6)}% Cal=${(m.calmar ?? 0).toFixed(2)} MCp5=${mc.insufficient ? "—" : mc.p5ReturnPct.toFixed(1).padStart(5)}% fold0=${fold0.length}/${fold0.reduce((s, t) => s + Number(t.netPnl), 0).toFixed(1)}`,
  );
}

await closePool?.();
