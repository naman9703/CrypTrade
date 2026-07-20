#!/usr/bin/env node
/**
 * BTC VP FREQ — frequency restore experiments (one change each).
 * Never reopen vacuum bleed. Expand positive cells / structured-only / playbook.
 *
 * Usage: node scripts/backtest-vp-freq-btc-frequency-restore.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { tag: "oos_2020-21", from: "2020-01-01", to: "2021-07-20" },
  { tag: "oos_2021-22", from: "2021-07-21", to: "2022-06-30" },
  { tag: "lock_2022-26", from: "2022-06-01", to: "2026-05-31" },
  { tag: "full_2020-26", from: "2020-01-01", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const VARIANTS = [
  { label: "0_locked_baseline", patch: {} },
  {
    label: "1_buy_rej_score5",
    // Isolated: slightly lower score floor to admit more BUY va_rejection (and others).
    // Documented as frequency probe — promote only if OOS+lock both improve.
    patch: { vpMinScore: 5 },
  },
  {
    label: "2_rej_wick_soft",
    // Soften rejection wick only — targets BUY va_rejection expansion.
    patch: { vpRejectionMinWickRatio: 0.35, vpRejectionMinCloseDepth: 0.15 },
  },
  {
    label: "3_add_poc_bounce",
    patch: {
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
    },
  },
  {
    label: "4_max3_gap0",
    patch: { vpMaxTradesPerDay: 3, vpMinBarGap: 0 },
  },
];

function summarize(trades, fromMs, toMs) {
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  const bySetup = {};
  for (const t of trades) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const k = `${String(t.direction ?? t.side).toUpperCase()}:${String(t.entryReason ?? "?").replace(/^vp_/, "")}`;
    bySetup[k] ??= { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  return {
    n: trades.length,
    tPerWk: trades.length / ((toMs - fromMs) / (7 * 86_400_000)),
    ret: eq - 100,
    dd: maxDd,
    wr: trades.length ? (wins / trades.length) * 100 : 0,
    bySetup,
  };
}

async function runOne(window, variant) {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const candles = await readCandles(
    "BTCUSDT",
    "15m",
    volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
    toMs,
    { market: "futures" },
  );
  let funding = [];
  try {
    funding = await readFundingRates("BTCUSDT", fromMs, toMs);
  } catch {
    funding = [];
  }
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
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: "15m",
    symbol: "BTCUSDT",
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const s = summarize(closed, fromMs, toMs);
  console.log(
    `${window.tag.padEnd(14)} ${variant.label.padEnd(22)} N=${String(s.n).padStart(3)} ${s.tPerWk.toFixed(2)}/wk ret=${s.ret.toFixed(1).padStart(7)}% DD=${s.dd.toFixed(1).padStart(5)}%`,
  );
  return { window: window.tag, label: variant.label, ...s };
}

const results = [];
for (const w of WINDOWS) {
  console.error(`\n=== ${w.tag} ===`);
  for (const v of VARIANTS) results.push(await runOne(w, v));
}

// Promotion rule: lock ret >= baseline AND oos_2021-22 ret >= baseline AND N up without DD blowup.
const byLabel = {};
for (const r of results) {
  byLabel[r.label] ??= {};
  byLabel[r.label][r.window] = r;
}
const baseline = byLabel["0_locked_baseline"];
const verdicts = [];
for (const [label, windows] of Object.entries(byLabel)) {
  if (label === "0_locked_baseline") continue;
  const lockOk = (windows["lock_2022-26"]?.ret ?? -999) >= (baseline["lock_2022-26"]?.ret ?? 0) - 5;
  const oosOk = (windows["oos_2021-22"]?.ret ?? -999) >= (baseline["oos_2021-22"]?.ret ?? 0) - 2;
  const nUp =
    (windows["full_2020-26"]?.n ?? 0) > (baseline["full_2020-26"]?.n ?? 0) ||
    (windows["lock_2022-26"]?.tPerWk ?? 0) > (baseline["lock_2022-26"]?.tPerWk ?? 0);
  const ddOk = (windows["lock_2022-26"]?.dd ?? 99) <= (baseline["lock_2022-26"]?.dd ?? 0) + 5;
  const promote = lockOk && oosOk && nUp && ddOk;
  verdicts.push({
    label,
    promote,
    lockOk,
    oosOk,
    nUp,
    ddOk,
    lockRet: windows["lock_2022-26"]?.ret,
    oosRet: windows["oos_2021-22"]?.ret,
    fullN: windows["full_2020-26"]?.n,
  });
  console.log(
    `VERDICT ${label}: ${promote ? "PROMOTE_CANDIDATE" : "REJECT"} lockOk=${lockOk} oosOk=${oosOk} nUp=${nUp} ddOk=${ddOk}`,
  );
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-frequency-restore.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), results, verdicts }, null, 2),
);
console.error("wrote", outPath);
await closePool?.();
