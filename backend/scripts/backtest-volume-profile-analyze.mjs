#!/usr/bin/env node
/**
 * Deep autopsy of VOLUME_PROFILE backtest — setup funnel, brackets, per-setup PnL.
 * Usage: node scripts/backtest-volume-profile-analyze.mjs [SYMBOL] [TF] [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.argv[4] || "2026-01-01").getTime();
const toMs = new Date(process.argv[5] || "2026-05-18").getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  selectVolumeProfilePicks,
  evaluateVolumeProfileBar,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { detectVolumeProfileSetup, buildVolumeProfile } = await import(
  "../src/strategy/techniques/volumeProfile.js",
);
const { VOLUME_PROFILE_15M } = await import("../src/strategy/presets/volumeProfileOptimized.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const cfg = {
  ...VOLUME_PROFILE_15M,
  symbol,
  timeframe: tf,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
};

const pre = precomputeVolumeProfile(candles);
const lookback = cfg.vpLookbackBars ?? 672;
const startIdx = Math.max(lookback, 120);

// ── 1. Raw setup frequency (no filters) ─────────────────────────────────────
const rawSetupCounts = {};
let rawAny = 0;
for (let i = startIdx; i < candles.length; i++) {
  const vp = buildVolumeProfile(candles, i, { lookback, bins: 50 });
  if (!vp) continue;
  for (const side of ["BUY", "SELL"]) {
    const s = detectVolumeProfileSetup(candles, i, side, vp, cfg);
    if (s) {
      rawSetupCounts[s.setup] = (rawSetupCounts[s.setup] || 0) + 1;
      rawAny++;
    }
  }
}

// ── 2. Candidates after full evaluate ───────────────────────────────────────
const candidates = [];
for (let i = startIdx; i < candles.length; i++) {
  const sig = evaluateVolumeProfileBar(candles, i, cfg, pre);
  if (sig) candidates.push({ idx: i, sig });
}
const candBySetup = {};
for (const c of candidates) {
  const k = c.sig.vpSetup ?? c.sig.setup ?? "?";
  candBySetup[k] = (candBySetup[k] || 0) + 1;
}

const picks = selectVolumeProfilePicks(candles, cfg);

// ── 3. Backtest + match trades to signal bar ────────────────────────────────
const adapters = await buildBacktestAdapters({
  strategyKey: "VOLUME_PROFILE",
  cfg,
  symbol,
  tf,
  candles,
  fromMs,
});
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: tf,
  adapters,
  symbol,
});

function findSignalIdx(entryTs) {
  const t = typeof entryTs === "number" ? entryTs : new Date(entryTs).getTime();
  let i = candles.findIndex((c) => c.ts >= t);
  if (i > 0) i -= 1;
  return Math.max(startIdx, Math.min(candles.length - 1, i));
}

const tradeBySetup = {};
const bracketStats = { sl: [], tp: [], rr: [] };
let wins = 0;
let losses = 0;

for (const t of sim.trades) {
  const idx = findSignalIdx(t.entryTs);
  const sig = evaluateVolumeProfileBar(candles, idx, cfg, pre);
  const setup = sig?.vpSetup ?? sig?.setup ?? "unknown_at_entry";
  if (!tradeBySetup[setup]) tradeBySetup[setup] = { n: 0, wins: 0, loss: 0, pnl: 0 };
  tradeBySetup[setup].n++;
  tradeBySetup[setup].pnl += Number(t.netPnl ?? 0);
  if (Number(t.netPnl) > 0) {
    tradeBySetup[setup].wins++;
    wins++;
  } else {
    tradeBySetup[setup].loss++;
    losses++;
  }
  if (sig?.vpBrackets) {
    bracketStats.sl.push(sig.vpBrackets.slPct);
    bracketStats.tp.push(sig.vpBrackets.tpPct);
    bracketStats.rr.push(sig.vpBrackets.rr);
  }
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// ── 4. Fixed SL/TP vs structure brackets A/B ───────────────────────────────
const cfgFixed = { ...cfg, intradayVpBrackets: false };
const adaptersFixed = await buildBacktestAdapters({
  strategyKey: "VOLUME_PROFILE",
  cfg: cfgFixed,
  symbol,
  tf,
  candles,
  fromMs,
});
const simFixed = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg: cfgFixed,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: tf,
  adapters: adaptersFixed,
  symbol,
});
const retFixed =
  ((simFixed.equityCurve.at(-1)?.equity ?? 100) - 100);
const retStruct =
  ((sim.equityCurve.at(-1)?.equity ?? 100) - 100);

console.log(`\n══ VOLUME_PROFILE autopsy: ${symbol} ${tf} ══`);
console.log(`${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}  (${candles.length} bars, lookback ${lookback})\n`);

console.log("1) RAW setup hits per bar-side (no HTF/ADX/session filter):");
console.log("   total bar-side hits:", rawAny);
for (const [k, v] of Object.entries(rawSetupCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(16)} ${v}`);
}

console.log("\n2) Candidates after filters (HTF + ADX + gates + minScore):");
console.log("   total:", candidates.length);
for (const [k, v] of Object.entries(candBySetup).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(16)} ${v}`);
}

console.log("\n3) Daily pick filter:");
console.log(`   picks: ${picks.pickedCount}  candidates: ${picks.candidateCount}  executed trades: ${sim.trades.length}`);

console.log("\n4) Per-setup trade results (matched at entry bar):");
for (const [k, v] of Object.entries(tradeBySetup).sort((a, b) => b[1].n - a[1].n)) {
  const wr = v.n ? ((v.wins / v.n) * 100).toFixed(0) : "—";
  console.log(`   ${k.padEnd(16)} n=${String(v.n).padStart(3)}  WR=${wr}%  pnl=${v.pnl.toFixed(2)}`);
}

console.log("\n5) Structure brackets at entry (when used):");
console.log(
  `   avg SL ${(avg(bracketStats.sl) * 100).toFixed(2)}%  avg TP ${(avg(bracketStats.tp) * 100).toFixed(2)}%  avg RR ${avg(bracketStats.rr).toFixed(2)}  (n=${bracketStats.sl.length})`,
);
console.log(
  `   fixed SL/TP preset: ${(cfg.supertrendFuturesFixedSlPct * 100).toFixed(2)}% / ${(cfg.supertrendFuturesFixedTpPct * 100).toFixed(2)}%`,
);

console.log("\n6) A/B return — same picks, bracket mode:");
console.log(`   structure brackets (intradayVpBrackets=true):  ${retStruct.toFixed(2)}%  (${sim.trades.length} trades)`);
console.log(`   fixed % SL/TP (intradayVpBrackets=false):       ${retFixed.toFixed(2)}%  (${simFixed.trades.length} trades)`);

console.log("\n7) Exit reasons:");
const exits = {};
for (const t of sim.trades) {
  exits[t.exitReason ?? "?"] = (exits[t.exitReason ?? "?"] || 0) + 1;
}
console.log("  ", exits);

console.log("\n── Diagnosis ──");
const topRaw = Object.entries(rawSetupCounts).sort((a, b) => b[1] - a[1])[0];
if (topRaw && topRaw[1] > rawAny * 0.35) {
  console.log(`• "${topRaw[0]}" dominates raw signals (${((topRaw[1] / rawAny) * 100).toFixed(0)}%) — likely too loose.`);
}
if (picks.candidateCount > 50 && picks.pickedCount > 40) {
  console.log("• Too many candidates/picks for a selective VP strategy — tighten setup rules or raise vpMinScore.");
}
if (avg(bracketStats.sl) > 0.05) {
  console.log("• Structure SL often very wide (>5%) — HVN-based stops inflate risk and shrink position size oddly.");
}
if (Math.abs(retStruct) < Math.abs(retFixed) && retFixed > retStruct) {
  console.log("• Fixed % brackets outperform structure brackets on this window — VP level SL/TP may be misaligned.");
}

await closePool?.();
