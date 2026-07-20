#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { tag: "2022-23", from: "2022-06-01", to: "2023-05-31" },
  { tag: "2023-24", from: "2023-06-01", to: "2024-05-31" },
  { tag: "2025-26", from: "2025-06-01", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter, precomputeVolumeProfile } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_FREQ_ETH_15M, volumeProfilePadFromMs } = await import("../src/strategy/presets/volumeProfileOptimized.js");

function findIdx(candles, ts) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}

for (const w of WINDOWS) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: "ETHUSDT",
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
  };
  const pad = volumeProfilePadFromMs(fromMs, "15m", cfg);
  const candles = await readCandles("ETHUSDT", "15m", pad, toMs, { market: "futures" });
  const pre = precomputeVolumeProfile(candles);
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    symbol: "ETHUSDT",
    adapters,
  });
  const rows = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => String(t.entryReason ?? "") === "vp_val_breakdown" && String(t.direction ?? t.side).toUpperCase() === "SELL")
    .map((t) => {
      const idx = findIdx(candles, Number(t.entryTs ?? t.entry_time));
      const prior20d = priorPct(candles, idx, 96 * 20);
      const prior60d = priorPct(candles, idx, 96 * 60);
      return {
        tag: w.tag,
        ts: new Date(Number(t.entryTs ?? t.entry_time)).toISOString(),
        pnl: Number(t.netPnl ?? 0),
        mfe: Number(t.mfePct ?? 0),
        mae: Number(t.maePct ?? 0),
        bars: Number(t.barsHeld ?? 0),
        htfSep: Number(pre.htfSep[idx] ?? 0),
        macroBull:
          pre.macroAboveEma20d?.[idx] === true ||
          (pre.macroEma5dSlope?.[idx] ?? 0) > 0 ||
          prior20d > (cfg.vpSellMacroPrior20dBullPct ?? 0.02),
        above20d: pre.macroAboveEma20d?.[idx] === true,
        slope5d: Number(pre.macroEma5dSlope?.[idx] ?? 0),
        prior20d,
        prior60d,
      };
    })
    .filter((r) => r.htfSep < 0.008)
    .sort((a, b) => a.htfSep - b.htfSep);

  console.log(`\n=== ${w.tag} shallow-ish val shorts (<0.8% htfSep) ===`);
  console.log(JSON.stringify(rows, null, 2));
}

await closePool?.();
