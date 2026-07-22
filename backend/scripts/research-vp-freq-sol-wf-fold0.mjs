#!/usr/bin/env node
/** Autopsy SOL lock fold-0 OOS losers (2021-11→2022-10) vs later OOS winners. */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_FREQ_SOL_15M, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js",
);
const { classifyVpMacro, classifyVpPath } = await import("../src/strategy/vpConditionCell.js");

const FROM = "2021-01-01";
const TO = "2026-05-31";
const fold0From = Date.parse("2021-11-26T00:00:00Z");
const fold0To = Date.parse("2022-10-21T00:00:00Z");
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const cfg = {
  ...VOLUME_PROFILE_FREQ_SOL_15M,
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
};

const padFrom = volumeProfilePadFromMs(fromMs, "15m", cfg);
const candles = await readCandles("SOLUSDT", "15m", padFrom, toMs, { market: "futures" });
const pre = precomputeVolumeProfile(candles, cfg);
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: "15m",
  adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") },
  symbol: "SOLUSDT",
});

const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
const tsIdx = new Map(candles.map((c, i) => [Number(c.ts), i]));

function feat(t) {
  const entryTs = Number(t.entryTs ?? t.entry_time);
  const idx = tsIdx.get(entryTs) ?? candles.findIndex((c) => Number(c.ts) === entryTs);
  const setup = String(t.setup ?? t.entrySetup ?? t.signalSetup ?? "").toLowerCase() || "?";
  const side = String(t.side ?? "").toUpperCase();
  const prior5 = Number(pre?.macroPrior5d?.[idx] ?? NaN);
  const prior20 = Number(pre?.macroPrior20d?.[idx] ?? NaN);
  const prior60 = Number(pre?.macroPrior60d?.[idx] ?? NaN);
  const htf = Number(t.htfSepPct ?? t.meta?.htfSepPct ?? NaN);
  const path = classifyVpPath({
    distPct: Number(t.pathPct ?? t.meta?.pathPct ?? 0),
    vacuumPathPct: 0.02,
  });
  const macro = classifyVpMacro({
    prior60d: prior60,
    prior20d: prior20,
    macroBull: pre?.macroAboveEma20d?.[idx] === true || Number(pre?.macroEma5dSlope?.[idx] ?? 0) > 0,
  });
  return {
    entryTs,
    pnl: Number(t.netPnl ?? 0),
    setup,
    side,
    prior5: Number.isFinite(prior5) ? +prior5.toFixed(3) : null,
    prior20: Number.isFinite(prior20) ? +prior20.toFixed(3) : null,
    prior60: Number.isFinite(prior60) ? +prior60.toFixed(3) : null,
    path,
    macro,
    exit: String(t.exitReason ?? ""),
  };
}

const fold0 = closed
  .filter((t) => {
    const ts = Number(t.entryTs ?? t.entry_time);
    return ts >= fold0From && ts < fold0To;
  })
  .map(feat);

const later = closed
  .filter((t) => Number(t.entryTs ?? t.entry_time) >= fold0To)
  .map(feat);

function bucket(rows, keyFn) {
  const m = {};
  for (const r of rows) {
    const k = keyFn(r);
    m[k] ??= { n: 0, net: 0, wins: 0 };
    m[k].n += 1;
    m[k].net += r.pnl;
    if (r.pnl > 0) m[k].wins += 1;
  }
  for (const v of Object.values(m)) {
    v.net = +v.net.toFixed(2);
    v.wr = +((v.wins / v.n) * 100).toFixed(1);
  }
  return Object.entries(m).sort((a, b) => a[1].net - b[1].net);
}

console.log(`\nFold0 trades=${fold0.length} net=${fold0.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
console.log("by setup|macro|path:");
for (const [k, v] of bucket(fold0, (r) => `${r.setup}|${r.macro}|${r.path}`)) {
  console.log(`  ${k.padEnd(42)} n=${v.n} net=${v.net} wr=${v.wr}%`);
}
console.log("by setup:");
for (const [k, v] of bucket(fold0, (r) => r.setup)) {
  console.log(`  ${k.padEnd(20)} n=${v.n} net=${v.net} wr=${v.wr}%`);
}
console.log("prior5d>0.05 chase shorts:");
const chase = fold0.filter((r) => r.side === "SELL" && r.prior5 != null && r.prior5 > 0.05);
console.log(`  n=${chase.length} net=${chase.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
console.log("weak_bear / flat60-ish prior60 in (-5%,0]:");
const flat = fold0.filter((r) => r.prior60 != null && r.prior60 > -0.05 && r.prior60 <= 0);
console.log(`  n=${flat.length} net=${flat.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
console.log("rej prior20 > -0.02 (not deep down):");
const rejShallow = fold0.filter(
  (r) => r.setup.includes("rej") && r.prior20 != null && r.prior20 > -0.05,
);
console.log(`  n=${rejShallow.length} net=${rejShallow.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);

console.log(`\nLater OOS trades=${later.length} net=${later.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
console.log("later by setup|macro|path (worst 8):");
for (const [k, v] of bucket(later, (r) => `${r.setup}|${r.macro}|${r.path}`).slice(0, 8)) {
  console.log(`  ${k.padEnd(42)} n=${v.n} net=${v.net} wr=${v.wr}%`);
}

await closePool?.();
