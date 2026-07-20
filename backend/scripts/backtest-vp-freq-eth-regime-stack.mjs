#!/usr/bin/env node
/**
 * ETH VP FREQ — regime robustness stack A/B.
 *
 * Baseline: macro-adapt SELL HTF + chop SELL MFE trail (already locked).
 * +A: va_rejection wick + close-depth quality
 * +B: A + structured VAH only (max path 2%)
 *
 * Usage: node scripts/backtest-vp-freq-eth-regime-stack.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2022-06-01";
const TO = process.env.TO || "2026-05-31";
const TF = "15m";
const SYMBOL = "ETHUSDT";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function yearBucket(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function summarizeByYear(trades) {
  const years = {};
  let eq = 100;
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const y = yearBucket(Number(t.entryTs ?? t.entry_time));
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq };
    const pnl = Number(t.netPnl ?? 0);
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    eq += pnl;
    years[y].end = eq;
  }
  for (const y of Object.keys(years)) {
    const r = years[y];
    r.wr = r.n ? (r.wins / r.n) * 100 : 0;
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

async function runCfg(label, patch) {
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    // Start from "pre-geometry" baseline unless patch says otherwise
    vpRejectionMinWickRatio: 0,
    vpRejectionMinCloseDepth: 0,
    vpBuyBreakoutMaxPathPct: 0,
    ...patch,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
    vpBuyChaseFilter: false,
    backtestBreakevenAtMfePct: 0,
  };
  const padFrom = volumeProfilePadFromMs(fromMs, TF, cfg);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  const bySetup = {};
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const k = String(t.entryReason ?? t.vpSetup ?? "?");
    if (!bySetup[k]) bySetup[k] = { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  const years = summarizeByYear(closed);
  console.log(`\n=== ${label} ===`);
  console.log(
    `N=${closed.length} ret=${(eq - 100).toFixed(1)}% DD=${maxDd.toFixed(1)}% WR=${((wins / (closed.length || 1)) * 100).toFixed(0)}%`,
  );
  for (const [y, r] of Object.entries(years).sort()) {
    console.log(`  ${y}: n=${r.n} wr=${r.wr.toFixed(0)}% ret=${r.retPct.toFixed(1)}% net=$${r.net.toFixed(1)}`);
  }
  console.log(
    "  setups:",
    Object.entries(bySetup)
      .map(([k, v]) => `${k}:${v.n}/$${v.net.toFixed(0)}`)
      .join(" "),
  );
  return {
    label,
    n: closed.length,
    ret: eq - 100,
    dd: maxDd,
    wr: (wins / (closed.length || 1)) * 100,
    years,
    bySetup,
  };
}

const baseline = await runCfg("0 baseline (macro+chop trail)", {});
const rej = await runCfg("+A rejection quality", {
  vpRejectionMinWickRatio: 0.35,
  vpRejectionMinCloseDepth: 0.35,
});
const stack = await runCfg("+A+B rejection + structured VAH", {
  vpRejectionMinWickRatio: 0.35,
  vpRejectionMinCloseDepth: 0.35,
  vpBuyBreakoutMaxPathPct: 0.02,
});

const out = { from: FROM, to: TO, baseline, rej, stack };
const outPath = path.resolve(__dirname, ".vp-freq-eth-regime-stack.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\nwrote", outPath);

await closePool?.();
