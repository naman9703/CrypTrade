#!/usr/bin/env node
/**
 * BTC VP FREQ — 5m frequency/playbook research.
 *
 * Hypothesis: BTC 15m is profitable but too sparse after honest gates. A 5m
 * timeframe may expose more valid auction interactions if macro lookbacks and
 * temporal gaps are scaled to the same real-world duration.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM ?? "2025-06-01";
const TO = process.env.TO ?? "2026-05-31";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const MS_PER_WEEK = 7 * 86_400_000;

const BASE_RUN = {
  symbol: "BTCUSDT",
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

function scaled5mCfg(patch = {}) {
  return {
    ...VOLUME_PROFILE_FREQ_BTC_15M,
    timeframe: "5m",
    vpLookbackBars: 384 * 3,
    vpMinBarGap: 3,
    vpBuyVacuumPriorLookback: 288 * 60,
    ...patch,
  };
}

function bucketMonth(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function summarizeClosed(closed) {
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  let buyN = 0;
  let buyNet = 0;
  let sellN = 0;
  let sellNet = 0;
  const bySetup = {};
  const byMonth = {};

  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const side = String(t.direction ?? t.side).toUpperCase();
    const setup = String(t.entryReason ?? "?").replace(/^vp_/, "");
    const month = bucketMonth(t.entryTs ?? t.entry_time);

    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;

    if (side === "BUY") {
      buyN += 1;
      buyNet += pnl;
    } else {
      sellN += 1;
      sellNet += pnl;
    }

    const setupKey = `${side}:${setup}`;
    bySetup[setupKey] ??= { n: 0, net: 0 };
    bySetup[setupKey].n += 1;
    bySetup[setupKey].net += pnl;

    byMonth[month] ??= { n: 0, net: 0, wins: 0 };
    byMonth[month].n += 1;
    byMonth[month].net += pnl;
    if (pnl > 0) byMonth[month].wins += 1;
  }

  return {
    n: closed.length,
    tPerWk: closed.length / ((toMs - fromMs) / MS_PER_WEEK),
    ret: eq - 100,
    dd: maxDd,
    wr: closed.length ? (wins / closed.length) * 100 : 0,
    buyN,
    buyNet,
    sellN,
    sellNet,
    bySetup,
    byMonth,
  };
}

async function loadCandles(tf, cfg) {
  const pad = volumeProfilePadFromMs(fromMs, tf, cfg);
  const candles = await readCandles("BTCUSDT", tf, pad, toMs, { market: "futures" });
  console.error(
    `${tf} candles=${candles.length} first=${candles[0]?.ts ? new Date(candles[0].ts).toISOString() : "n/a"}`,
  );
  return candles;
}

async function runCfg(label, tf, cfg, candles) {
  const runCfg = { ...cfg, ...BASE_RUN, timeframe: tf };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, runCfg, tf) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: runCfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    symbol: "BTCUSDT",
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const summary = summarizeClosed(closed);
  console.log(
    `${label.padEnd(30)} tf=${tf} N=${String(summary.n).padStart(3)} ${summary.tPerWk.toFixed(2)}/wk ret=${summary.ret.toFixed(1).padStart(6)}% DD=${summary.dd.toFixed(1).padStart(5)}% WR=${summary.wr.toFixed(0).padStart(3)}%`,
  );
  console.log(`  BUY ${summary.buyN}/$${summary.buyNet.toFixed(1)} | SELL ${summary.sellN}/$${summary.sellNet.toFixed(1)}`);
  console.log(`  setups ${JSON.stringify(summary.bySetup)}`);
  return { label, tf, ...summary };
}

const cfg15 = { ...VOLUME_PROFILE_FREQ_BTC_15M };
const cfg5Same = scaled5mCfg();
const candles15 = await loadCandles("15m", cfg15);
const candles5 = await loadCandles("5m", cfg5Same);

const results = [];
results.push(await runCfg("15m_locked_window", "15m", cfg15, candles15));
results.push(await runCfg("5m_same_scaled", "5m", cfg5Same, candles5));
results.push(await runCfg("5m_gap1", "5m", scaled5mCfg({ vpMinBarGap: 1 }), candles5));
results.push(
  await runCfg(
    "5m_add_poc_bounce",
    "5m",
    scaled5mCfg({
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
    }),
    candles5,
  ),
);
results.push(
  await runCfg(
    "5m_add_poc_gap1",
    "5m",
    scaled5mCfg({
      vpMinBarGap: 1,
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
    }),
    candles5,
  ),
);
results.push(await runCfg("5m_max3_same", "5m", scaled5mCfg({ vpMaxTradesPerDay: 3 }), candles5));

const outPath = path.resolve(__dirname, ".vp-freq-btc-5m-playbook.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      from: FROM,
      to: TO,
      hypothesis:
        "BTC 15m FREQ has low N; 5m with duration-scaled macro/lookback gates may improve frequency without loosening the 15m edge gates.",
      results,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
