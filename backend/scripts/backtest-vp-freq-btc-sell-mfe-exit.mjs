#!/usr/bin/env node
/**
 * BTC VP FREQ — SELL exit redesign.
 *
 * Hypothesis: current BTC 15m entries are already selective, but some VAL short
 * losers reach useful MFE then give it back. Test a SELL-only MFE giveback trail
 * as an exit-only change, without adding entry filters or reducing N.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = "2022-06-01";
const TO = "2026-05-31";

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

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function summarizeByYear(trades) {
  const years = {};
  let eq = 100;
  for (const t of trades) {
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, wins: 0, net: 0, start: eq, mfeTrail: 0 };
    const pnl = Number(t.netPnl ?? 0);
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    if (String(t.exitReason ?? "") === "mfe_trail") years[y].mfeTrail += 1;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.wr = r.n ? (r.wins / r.n) * 100 : 0;
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

const baseRun = {
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

console.error("loading candles once…");
const candles = await readCandles(
  "BTCUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", { ...VOLUME_PROFILE_FREQ_BTC_15M, ...baseRun }),
  toMs,
  { market: "futures" },
);
console.error(`candles=${candles.length}`);

async function runCfg(label, patch) {
  const cfg = { ...VOLUME_PROFILE_FREQ_BTC_15M, ...baseRun, ...patch };
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
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  let mfeTrail = 0;
  const bySetup = {};
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    if (String(t.exitReason ?? "") === "mfe_trail") mfeTrail += 1;
    const key = `${String(t.direction ?? t.side).toUpperCase()}:${String(t.entryReason ?? "?").replace(/^vp_/, "")}`;
    bySetup[key] ??= { n: 0, net: 0, mfeTrail: 0 };
    bySetup[key].n += 1;
    bySetup[key].net += pnl;
    if (String(t.exitReason ?? "") === "mfe_trail") bySetup[key].mfeTrail += 1;
  }
  const years = summarizeByYear(closed);
  const focus = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const negYears = focus.filter((y) => (years[y]?.retPct ?? 0) < 0);
  const out = {
    label,
    n: closed.length,
    tPerWk: closed.length / ((toMs - fromMs) / (7 * 86_400_000)),
    ret: eq - 100,
    dd: maxDd,
    wr: closed.length ? (wins / closed.length) * 100 : 0,
    mfeTrail,
    negYears,
    years,
    bySetup,
  };
  console.log(
    `${label.padEnd(30)} N=${String(out.n).padStart(3)} ${out.tPerWk.toFixed(2)}/wk ret=${out.ret.toFixed(1).padStart(6)}% DD=${out.dd.toFixed(1).padStart(5)}% WR=${out.wr.toFixed(0).padStart(3)}% mfe=${String(mfeTrail).padStart(2)} neg=${negYears.join(",") || "none"}`,
  );
  for (const y of focus) {
    const r = years[y];
    if (r) console.log(`  ${y}: n=${r.n} ret=${r.retPct.toFixed(1)}% mfe=${r.mfeTrail}`);
  }
  console.log(`  setups ${JSON.stringify(bySetup)}`);
  return out;
}

const allSellTrail = {
  backtestChopMfeTrail: true,
  backtestChopMfeTrailSides: "SELL",
  // Large prior cap makes this a SELL-exit test instead of chop-only.
  backtestChopPriorAbsMax: 10,
};

const results = [];
results.push(await runCfg("locked_no_mfe", { backtestChopMfeTrail: false }));
results.push(
  await runCfg("sell_mfe_1p_gb35", {
    ...allSellTrail,
    backtestChopMfeTrailActivatePct: 0.01,
    backtestChopMfeTrailGivebackFrac: 0.35,
  }),
);
results.push(
  await runCfg("sell_mfe_1p_gb50", {
    ...allSellTrail,
    backtestChopMfeTrailActivatePct: 0.01,
    backtestChopMfeTrailGivebackFrac: 0.5,
  }),
);
results.push(
  await runCfg("sell_mfe_08p_gb35", {
    ...allSellTrail,
    backtestChopMfeTrailActivatePct: 0.008,
    backtestChopMfeTrailGivebackFrac: 0.35,
  }),
);
results.push(
  await runCfg("sell_mfe_12p_gb35", {
    ...allSellTrail,
    backtestChopMfeTrailActivatePct: 0.012,
    backtestChopMfeTrailGivebackFrac: 0.35,
  }),
);
results.push(
  await runCfg("chop_sell_mfe_1p_gb35", {
    backtestChopMfeTrail: true,
    backtestChopMfeTrailSides: "SELL",
    backtestChopPriorMs: 60 * 86_400_000,
    backtestChopPriorAbsMax: 0.05,
    backtestChopMfeTrailActivatePct: 0.01,
    backtestChopMfeTrailGivebackFrac: 0.35,
  }),
);

const outPath = path.resolve(__dirname, ".vp-freq-btc-sell-mfe-exit.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      hypothesis:
        "Exit-only BTC redesign: SELL losers with useful MFE are giveback failures, so lock a fraction of MFE without changing entries or trade count.",
      results,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
