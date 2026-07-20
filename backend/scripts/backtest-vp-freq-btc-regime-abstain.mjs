#!/usr/bin/env node
/**
 * BTC VP FREQ — abstain outside prepared regimes.
 *
 * Principle: do not invent year filters. Encode "this setup was validated for
 * condition X, not Y" as bar-time gates.
 *
 * 2021-07→2022-06 OOS autopsy:
 * - Vacuum VAH even in bull (blow-off) → −$19.8 / 11t
 * - Structured VAH still OK → +$3.1 / 3t
 * - Vacuum VAL in early-bear squeeze → −$17.4 / 13t
 * - Deep-bear VAL still mixed; 2025 clean bear VAL is a paid runner
 *
 * Hypotheses (one family, isolated variants):
 * A) Longs prepared only for structured VAH (block vacuum path in ALL macros)
 * B) Shorts: block vacuum VAL (path≥2%) — may hurt 2025; measure both windows
 * C) A+B combined
 * D) Longs: keep bull vacuum, but block extreme prior5d chase (>8%) — soft abstain
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { tag: "oos_2021-22", from: "2021-07-21", to: "2022-06-30" },
  { tag: "lock_2022-26", from: "2022-06-01", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function summarize(trades, fromMs, toMs) {
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  const bySetup = {};
  const years = {};
  for (const t of trades) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const side = String(t.direction ?? t.side).toUpperCase();
    const setup = String(t.entryReason ?? "?").replace(/^vp_/, "");
    const k = `${side}:${setup}`;
    bySetup[k] ??= { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq - pnl };
    years[y].n += 1;
    years[y].net += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return {
    n: trades.length,
    tPerWk: trades.length / ((toMs - fromMs) / (7 * 86_400_000)),
    ret: eq - 100,
    dd: maxDd,
    wr: trades.length ? (wins / trades.length) * 100 : 0,
    bySetup,
    years,
  };
}

const VARIANTS = [
  { label: "0_locked", patch: {} },
  {
    label: "A_no_vacuum_vah_any_macro",
    patch: {
      // Prepared longs = structured VAH only; abstain vacuum in bull AND bear.
      vpBuyBreakoutMaxPathPct: 0.02,
      vpBuyBreakoutMaxPathNonBullOnly: false,
    },
  },
  {
    label: "B_block_vacuum_val",
    patch: {
      vpSellBreakdownMaxPathPct: 0.02,
    },
  },
  {
    label: "C_A_plus_B",
    patch: {
      vpBuyBreakoutMaxPathPct: 0.02,
      vpBuyBreakoutMaxPathNonBullOnly: false,
      vpSellBreakdownMaxPathPct: 0.02,
    },
  },
  {
    label: "D_bull_vah_chase08",
    patch: {
      vpBuyChaseFilter: true,
      vpBuyChaseMaxPrior5dPct: 0.08,
      vpBuyChaseNonBullOnly: false,
    },
  },
  {
    label: "E_A_plus_chase",
    patch: {
      vpBuyBreakoutMaxPathPct: 0.02,
      vpBuyBreakoutMaxPathNonBullOnly: false,
      vpBuyChaseFilter: true,
      vpBuyChaseMaxPrior5dPct: 0.08,
    },
  },
];

const cache = new Map();
async function candlesFor(fromMs, toMs) {
  const key = `${fromMs}:${toMs}`;
  if (cache.has(key)) return cache.get(key);
  const candles = await readCandles(
    "BTCUSDT",
    "15m",
    volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
    toMs,
    { market: "futures" },
  );
  cache.set(key, candles);
  return candles;
}

async function runOne(window, variant) {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const candles = await candlesFor(fromMs, toMs);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_BTC_15M,
    ...variant.patch,
    symbol: "BTCUSDT",
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    symbol: "BTCUSDT",
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const summary = summarize(closed, fromMs, toMs);
  console.log(
    `${window.tag.padEnd(12)} ${variant.label.padEnd(28)} N=${String(summary.n).padStart(3)} ${summary.tPerWk.toFixed(2)}/wk ret=${summary.ret.toFixed(1).padStart(7)}% DD=${summary.dd.toFixed(1).padStart(5)}% WR=${summary.wr.toFixed(0).padStart(3)}%`,
  );
  return { window: window.tag, ...variant, ...summary };
}

const results = [];
for (const w of WINDOWS) {
  console.error(`\n=== ${w.tag} ${w.from} → ${w.to} ===`);
  for (const v of VARIANTS) {
    results.push(await runOne(w, v));
  }
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-regime-abstain.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      principle:
        "Abstain outside prepared regimes via measurable bar-time conditions, not calendar year hardcodes.",
      results,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
