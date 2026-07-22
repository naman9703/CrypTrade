#!/usr/bin/env node
/** SOL fold0 — bounce/relief VAL harvest filters. */
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

const cfg = {
  ...VOLUME_PROFILE_FREQ_SOL_15M,
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

const candles = await readCandles(
  "SOLUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", cfg),
  toMs,
  { market: "futures" },
);
const pre = precomputeVolumeProfile(candles, cfg);
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
    const p5 = Number(pre.macroPrior5d?.[idx]);
    const p20 = Number(pre.macroPrior20d?.[idx]);
    const p60 = Number(pre.macroPrior60d?.[idx]);
    return {
      ...t,
      p5,
      p20,
      p60,
      bounce5: Number.isFinite(p5) && Number.isFinite(p20) ? p5 - p20 : null,
      exit: String(t.exitReason),
      path: String(t.vpConditionCellKey || "").split("|")[3] || "?",
    };
  });

const f0 = all.filter((t) => {
  const ts = Number(t.entryTs);
  return ts >= fold0From && ts < fold0To;
});
console.log(
  "fold0 exit counts",
  [...f0.reduce((m, t) => (m.set(t.exit, (m.get(t.exit) || 0) + 1), m), new Map())],
);
console.log(
  "fold0 loser $ by exit",
  [...f0.filter((t) => t.netPnl < 0).reduce((m, t) => (m.set(t.exit, (m.get(t.exit) || 0) + Number(t.netPnl)), m), new Map())].map(
    ([k, v]) => [k, +v.toFixed(1)],
  ),
);

const rules = [
  { id: "base", fn: null },
  {
    id: "block_bounce>0.10",
    fn: (t) => !(t.vpSetup === "val_breakdown" && t.bounce5 != null && t.bounce5 > 0.1),
  },
  {
    id: "block_bounce>0.15",
    fn: (t) => !(t.vpSetup === "val_breakdown" && t.bounce5 != null && t.bounce5 > 0.15),
  },
  {
    id: "block_bounce>0.20",
    fn: (t) => !(t.vpSetup === "val_breakdown" && t.bounce5 != null && t.bounce5 > 0.2),
  },
  {
    id: "block_p5>-0.05_bear",
    fn: (t) => !(t.vpSetup === "val_breakdown" && t.p60 <= -0.05 && t.p5 > -0.05),
  },
  {
    id: "require_p5<=-0.05",
    fn: (t) => !(t.vpSetup === "val_breakdown" && !(t.p5 <= -0.05)),
  },
  {
    id: "require_p5<=-0.08",
    fn: (t) => !(t.vpSetup === "val_breakdown" && !(t.p5 <= -0.08)),
  },
  {
    id: "block_vac_p60<-0.45",
    fn: (t) => !(t.vpSetup === "val_breakdown" && t.path === "vacuum" && t.p60 < -0.45),
  },
];

function score(label, closed) {
  let eq = 100;
  const curve = [{ equity: 100 }];
  for (const t of closed) {
    eq += Number(t.netPnl);
    curve.push({ equity: eq });
  }
  const m = computeAllMetrics({ trades: closed, equityCurve: curve, tf: "15m", startingEquity: 100 });
  const mc = monteCarloBootstrap(rMultipleStats(closed).rValues, {
    paths: 1500,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const fold0 = closed.filter((t) => {
    const ts = Number(t.entryTs);
    return ts >= fold0From && ts < fold0To;
  });
  console.log(
    `${label.padEnd(28)} N=${String(closed.length).padStart(3)} ret=${(m.totalReturnPct ?? 0).toFixed(1).padStart(6)}% Cal=${(m.calmar ?? 0).toFixed(2)} MCp5=${mc.insufficient ? "—" : mc.p5ReturnPct.toFixed(1).padStart(5)}% fold0=${fold0.length}/${fold0.reduce((s, t) => s + Number(t.netPnl), 0).toFixed(1)}`,
  );
}

for (const r of rules) score(r.id, r.fn ? all.filter(r.fn) : all);

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const val0 = f0.filter((t) => t.vpSetup === "val_breakdown");
const valL = all.filter((t) => Number(t.entryTs) >= fold0To && t.vpSetup === "val_breakdown");
console.log("fold0 bounce5/p5", +avg(val0.map((t) => t.bounce5)).toFixed(3), +avg(val0.map((t) => t.p5)).toFixed(3));
console.log("later bounce5/p5", +avg(valL.map((t) => t.bounce5)).toFixed(3), +avg(valL.map((t) => t.p5)).toFixed(3));

await closePool?.();
