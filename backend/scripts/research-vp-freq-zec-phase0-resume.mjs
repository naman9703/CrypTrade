#!/usr/bin/env node
/**
 * Resume ZEC Phase 0 one-change A/Bs that died mid-run + prepared keep-only probe.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-zec-phase0-resume.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ZECUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const OOS_END = "2023-06-01";
const START_USDT = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
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

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
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
  vpAllowedSetups: ["va_rejection"],
};

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
    pf: +(m.profitFactor ?? 0).toFixed(2),
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
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function print(id, trades) {
  const full = metricsFor(trades);
  const oos = sliceMetrics(trades, fromMs, oosEndMs);
  console.log(
    `${id}\n  FULL n=${full.trades} tw=${full.tw} ret=${full.ret} cal=${full.calmar} pf=${full.pf} | OOS n=${oos.trades} ret=${oos.ret} pf=${oos.pf}`,
  );
  console.log(
    `  years ${Object.entries(full.years)
      .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
      .join(" ")}`,
  );
  return { id, full, oos };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
if (process.env.SKIP_ENSURE !== "1") {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
  try {
    await ensureFunding(SYMBOL, { from: padFrom, to: toMs });
  } catch (e) {
    console.error("funding ensure:", e.message || e);
  }
}
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const variants = [
  { id: "H0_F3_rej_only", over: {} },
  {
    id: "deny_SELL_weak_bear_vacuum",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|weak_bear|vacuum"],
    },
  },
  {
    id: "deny_SELL_bull_chop_vacuum",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|bull_chop|vacuum"],
    },
  },
  {
    id: "deny_BUY_bull_chop_tight",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["BUY|va_rejection|bull_chop|tight"],
    },
  },
  {
    id: "deny_top2_bleeds",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|weak_bear|vacuum",
        "SELL|va_rejection|bull_chop|vacuum",
      ],
    },
  },
  {
    id: "deny_top3_bleeds",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|weak_bear|vacuum",
        "SELL|va_rejection|bull_chop|vacuum",
        "BUY|va_rejection|bull_chop|tight",
      ],
    },
  },
  {
    // Keep only cells that showed positive full PnL in Phase 0 autopsy (tiny N — probe only)
    id: "keep_positive_cells_only",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|weak_bear|vacuum",
        "SELL|va_rejection|bull_chop|vacuum",
        "BUY|va_rejection|bull_chop|tight",
        "BUY|va_rejection|bull_chop|vacuum",
        "SELL|va_rejection|bear_trend|structured",
        "BUY|va_rejection|bull_chop|structured",
        "BUY|va_rejection|bull_trend|tight",
      ],
    },
  },
];

const rows = [];
console.log(`\n══ ZECUSDT Phase 0 resume A/B ══ ${FROM}→${TO}`);
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  rows.push(print(v.id, trades));
}

const outPath = path.join(__dirname, ".vp-freq-zec-phase0-resume.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, rows }, null, 2),
);
console.error("wrote", outPath);
await closePool?.();
