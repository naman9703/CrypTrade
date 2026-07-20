#!/usr/bin/env node
/**
 * ETH VP FREQ — baseline vs BE-at-MFE exit (anti-whipsaw).
 *
 * Hypothesis: 2022–23 year gap vs 2025–26 is dominated by VAL follow-through —
 * same setup, but 2022 shorts print 1–2.8% MFE then give back to full SL (WHIPSAW).
 * Lock fee-BE at 1% MFE: same entries, robust exit in chop; clean trends still hit TP.
 *
 * Usage: FROM=2022-06-01 TO=2026-05-31 node scripts/backtest-vp-freq-eth-be-mfe.mjs
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
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq, whip: 0 };
    const pnl = Number(t.netPnl ?? 0);
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    if (String(t.lossPattern ?? "") === "WHIPSAW_GAVE_BACK") years[y].whip += 1;
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
    vpVacuumEntryMode: "breakout",
    vpBuyChaseFilter: false,
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
  let whip = 0;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    if (String(t.lossPattern ?? "") === "WHIPSAW_GAVE_BACK") whip += 1;
  }
  const years = summarizeByYear(closed);
  console.log(`\n=== ${label} ===`);
  console.log(
    `N=${closed.length} ret=${(eq - 100).toFixed(1)}% DD=${maxDd.toFixed(1)}% WR=${((wins / (closed.length || 1)) * 100).toFixed(0)}% whip=${whip}`,
  );
  for (const [y, r] of Object.entries(years).sort()) {
    console.log(
      `  ${y}: n=${r.n} wr=${r.wr.toFixed(0)}% ret=${r.retPct.toFixed(1)}% net=$${r.net.toFixed(1)} whip=${r.whip}`,
    );
  }
  return {
    label,
    n: closed.length,
    ret: eq - 100,
    dd: maxDd,
    wr: (wins / (closed.length || 1)) * 100,
    whip,
    beAtMfe: cfg.backtestBreakevenAtMfePct ?? 0,
    years,
  };
}

const baseline = await runCfg("baseline (no BE lock)", {
  backtestBreakevenAtMfePct: 0,
});
const be = await runCfg("BE at MFE ≥ 1%", {
  backtestBreakevenAtMfePct: 0.01,
});

const out = { from: FROM, to: TO, baseline, be };
const outPath = path.resolve(__dirname, ".vp-freq-eth-be-mfe.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\nwrote", outPath);

await closePool?.();
