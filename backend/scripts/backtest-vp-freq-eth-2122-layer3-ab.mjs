#!/usr/bin/env node
/**
 * ETH VP FREQ — Layer-3 abstain thin/unknown (fix residual 2021–22).
 *
 * Autopsy under Layer-1: 2021–22 still −$12.5. Prepared cells are mostly fine;
 * thin/unknown cells (full n<4) are −$11.7 of that bleed. Same BTC doctrine:
 * untrained/novel → abstain. Harvest CF: drop thin → 21–22 +$3.4, full better.
 *
 * Full-sim A/B (no session filters):
 *   v1  Layer-1 deny only (current lock)
 *   v3  Layer-1 + deny known thin multi-year bleed keys
 *   v4  Layer-1 + allowlist cells with n>=4 & net>0 (abstain unknown)
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const SYMBOL = "ETHUSDT";
const START_USDT = 100;

const LAYER1 = [
  "SELL|val_breakdown|weak_bear|vacuum",
  "BUY|vah_breakout|bull_trend|vacuum",
  "SELL|val_breakdown|bull_trend|structured",
  "SELL|val_breakdown|weak_bear|structured",
  "SELL|val_breakdown|bull_chop|structured",
];

/** Thin / unknown multi-year bleeders (autopsy under Layer-1). */
const THIN_BLEED = [
  "BUY|va_rejection|bull_trend|structured", // 3t / −8.7 / 0+ 3−
  "BUY|va_rejection|bull_trend|vacuum", // 2t / −8.2
  "SELL|val_breakdown|bull_chop|tight", // 3t / −11.2
  "SELL|val_breakdown|bull_trend|tight", // 3t / −1.3
  "BUY|poc_bounce|bull_trend|vacuum", // 1t / −3.4
  "BUY|va_rejection|bear_trend|vacuum", // 1t / −2.3
];

/** Cells with full n≥4 and net>0 under Layer-1 (trained positive set). */
const TRAINED_POSITIVE = [
  "SELL|val_breakdown|bull_trend|vacuum",
  "BUY|va_rejection|bull_trend|tight",
  "SELL|val_breakdown|bull_chop|vacuum",
  "BUY|vah_breakout|weak_bear|vacuum",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
  "SELL|val_breakdown|bear_trend|vacuum",
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|va_rejection|bull_chop|tight",
];

const WINDOWS = [
  { label: "full", from: "2020-01-01", to: "2026-05-31" },
  { label: "y20_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "y21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y22_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y23_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "y24_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "y25_26", from: "2025-06-01", to: "2026-05-31" },
];

const VARIANTS = [
  {
    label: "v1_layer1",
    patch: {
      vpPreparedBlockCellKeys: LAYER1,
      vpPreparedAllowlistOnly: false,
      vpPreparedCellKeys: [],
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
    },
  },
  {
    label: "v3_deny_thin_bleed",
    patch: {
      vpPreparedBlockCellKeys: [...LAYER1, ...THIN_BLEED],
      vpPreparedAllowlistOnly: false,
      vpPreparedCellKeys: [],
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
    },
  },
  {
    label: "v4_abstain_unknown",
    patch: {
      vpPreparedBlockCellKeys: LAYER1,
      vpPreparedAllowlistOnly: true,
      vpPreparedCellKeys: TRAINED_POSITIVE,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
    },
  },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

const cache = new Map();
async function load(from, to) {
  const k = `${from}|${to}`;
  if (cache.has(k)) return cache.get(k);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try {
    funding = await readFundingRates(SYMBOL, padFrom, toMs);
  } catch {
    funding = [];
  }
  const v = { candles, funding, fromMs, toMs };
  cache.set(k, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs, toMs } = await load(from, to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: SYMBOL,
    timeframe: TF,
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
    ...patch,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START_USDT;
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
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return {
    n: closed.length,
    tPerWk: closed.length / weeks,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    calmar: m.calmar,
    years,
  };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = {
  generatedAt: new Date().toISOString(),
  layer1: LAYER1,
  thinBleed: THIN_BLEED,
  trainedPositive: TRAINED_POSITIVE,
  windows: {},
};

console.log("\n=== ETH Layer-3 OOS A/B (fix 2021–22 thin/unknown bleed) ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} (${w.from} → ${w.to}) ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.patch);
    out.windows[w.label][v.label] = r;
    console.log(
      `  ${v.label.padEnd(22)} N=${String(r.n).padStart(3)} ${fmt(r.tPerWk, 2)}/wk ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`,
    );
    if (w.label === "full") {
      console.log(
        `    years: ${Object.entries(r.years)
          .map(([y, v2]) => `${y}=${fmt(v2.retPct)}%/${v2.n}`)
          .join("  ")}`,
      );
    }
  }
  console.log("");
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-2122-layer3-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("wrote", outPath);
await closePool?.();
