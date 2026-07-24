#!/usr/bin/env node
/**
 * AVAX VP FREQ — Round 2 A/B (cell denies + stack H3/H8) with IS/OOS split.
 * Uses REST candle cache from round 1.
 *
 * Usage: USE_REST=1 node scripts/backtest-vp-freq-avax-optimize-r2.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "AVAXUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const OOS_END = "2023-06-01";
const START_USDT = 100;
const RISK_PCT = 2.5;
const LEVERAGE = 12;

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
const oosEndMs = Date.parse(OOS_END);
const candleCachePath = path.join(__dirname, ".vp-freq-avax-candles-cache.json");

const BASELINE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellBlockWeakBearVacuum: true,
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: RISK_PCT,
  riskPerTradeUnit: "PCT",
  futuresLeverage: LEVERAGE,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
};

const VARIANTS = [
  { id: "R0_h0", over: {} },
  {
    id: "R1_denyBearVacVal",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|val_breakdown|bear_trend|vacuum"],
    },
  },
  {
    id: "R2_denyBullChopVacVal",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|val_breakdown|bull_chop|vacuum"],
    },
  },
  {
    id: "R3_denyBothVacValBleeds",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|val_breakdown|bear_trend|vacuum",
        "SELL|val_breakdown|bull_chop|vacuum",
      ],
    },
  },
  {
    id: "R4_h8_chase",
    over: {
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "R5_h3_flat",
    over: {
      vpValSellBlockFlatPrior60: true,
      vpValSellFlatPrior60LoPct: -0.05,
      vpValSellFlatPrior60HiPct: 0.05,
    },
  },
  {
    id: "R6_h3_h8",
    over: {
      vpValSellBlockFlatPrior60: true,
      vpValSellFlatPrior60LoPct: -0.05,
      vpValSellFlatPrior60HiPct: 0.05,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "R7_denyBoth_h8",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|val_breakdown|bear_trend|vacuum",
        "SELL|val_breakdown|bull_chop|vacuum",
      ],
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "R8_denyBoth_h3_h8",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|val_breakdown|bear_trend|vacuum",
        "SELL|val_breakdown|bull_chop|vacuum",
      ],
      vpValSellBlockFlatPrior60: true,
      vpValSellFlatPrior60LoPct: -0.05,
      vpValSellFlatPrior60HiPct: 0.05,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "R9_chopMfeTrail",
    over: {
      backtestChopMfeTrail: true,
      backtestChopMfeTrailSides: "SELL",
      backtestChopPriorMs: 60 * 86_400_000,
      backtestChopPriorAbsMax: 0.05,
      backtestChopMfeTrailActivatePct: 0.01,
      backtestChopMfeTrailGivebackFrac: 0.35,
    },
  },
  {
    id: "R10_denyBoth_h8_chopTrail",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|val_breakdown|bear_trend|vacuum",
        "SELL|val_breakdown|bull_chop|vacuum",
      ],
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
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

function metricsFor(trades) {
  let eq = START_USDT;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const years = {};
  eq = START_USDT;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq, net: 0 };
    years[y].n += 1;
    years[y].net += Number(t.netPnl ?? 0);
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

function sliceMetrics(trades, lo, hi) {
  const subset = trades.filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = START_USDT;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of subset) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: subset, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const weeks = Math.max(1, (hi - lo) / (7 * 864e5));
  return {
    trades: subset.length,
    tw: +(subset.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, BASELINE);
process.stderr.write(`load cache…\n`);
const cached = JSON.parse(fs.readFileSync(candleCachePath, "utf8"));
const candles = cached.candles.filter((c) => c.ts >= padFrom && c.ts <= toMs);
process.stderr.write(`candles=${candles.length}\n`);

async function runCfg(cfg) {
  const runCfg = { ...cfg, backtestSignalStartMs: fromMs };
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, runCfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: runCfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
    costModelOverride: {
      leverage: LEVERAGE,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const results = [];
for (const v of VARIANTS) {
  process.stderr.write(`run ${v.id}…\n`);
  const trades = await runCfg({ ...BASELINE, ...v.over });
  const full = metricsFor(trades);
  const oos = sliceMetrics(trades, fromMs, oosEndMs);
  const hold = sliceMetrics(trades, oosEndMs, toMs);
  results.push({ id: v.id, full, oos, hold });
  console.log(
    `\n${v.id} FULL tr=${full.trades} tw=${full.tw} ret=${full.ret} pf=${full.pf} dd=${full.dd} cal=${full.calmar}` +
      ` | OOS ret=${oos.ret} pf=${oos.pf} tr=${oos.trades}` +
      ` | IS ret=${hold.ret} pf=${hold.pf} tr=${hold.trades}`,
  );
  console.log(
    "  years:",
    Object.entries(full.years)
      .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
      .join(" "),
  );
}

const outPath = path.join(__dirname, ".vp-freq-avax-optimize-r2.json");
fs.writeFileSync(outPath, JSON.stringify({ symbol: SYMBOL, results }, null, 2));
console.log(`\nWrote ${outPath}`);
