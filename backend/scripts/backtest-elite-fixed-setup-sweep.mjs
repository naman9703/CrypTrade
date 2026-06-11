#!/usr/bin/env node
/**
 * Exhaustive per-coin fixed-setup sweep: sep mode x ST multiplier x bracket style.
 * Outputs elite-fixed-setup-sweep-results.json for dynamic tuning reference rebuild.
 *
 * Usage (from backend/):
 *   node scripts/backtest-elite-fixed-setup-sweep.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-11";
const H1_END = process.env.H1_END || "2025-12-31";
const H2_START = process.env.H2_START || "2026-01-01";
const STARTING = Number(process.env.STARTING_USDT || 100);
const RISK = Number(process.env.RISK_PCT || 5);
const LEV = Number(process.env.LEVERAGE || 10);

const SYMBOLS = (process.env.SYMBOLS ||
  "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,TRXUSDT,INJUSDT,TIAUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const SEP_MODES = ["FIXED", "ADX", "PERCENTILE"];
const ST_MULTS = [3, 3.5];
const BRACKET_STYLES = ["TIGHT", "ATR", "TRAIL"];

const TIGHT_SL = 0.002;
const TIGHT_TP = 0.015;
const FIXED_MIN_SEP = 0.0003;

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const h1EndMs = new Date(H1_END).getTime() + 86_400_000 - 1;
const h2StartMs = new Date(H2_START).getTime();

const { closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");

/** Avoid initPool here — pool.js exits the process when DB is down. */
async function loadCandles(sym) {
  if (getPool?.()) {
    try {
      const rows = await readCandles(sym, "1h", fromMs, toMs, { market: "futures" });
      if (rows.length > 100) return rows;
    } catch {
      /* fall through */
    }
  }
  const rows = await fetchBinanceKlinesRange({
    symbol: sym,
    interval: "1h",
    startTime: fromMs,
    endTime: toMs,
    feedKind: "BINANCE_FUTURES",
  });
  if (!rows.length) throw new Error(`no_candles:${sym}`);
  return rows;
}
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  prepareEliteRunCfg,
} = await import("../src/strategy/supertrendElite.js");
const {
  buildEliteCoinProfile,
  resolveEliteBracketPct,
  resolveEliteSepAdxBase,
  resolveEliteTrailDisasterSlPct,
} = await import("../src/strategy/eliteAutoCalibrate.js");
const { SUPERTREND_ELITE_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

function sliceCandles(candles, startMs, endMs) {
  return candles.filter((c) => c.ts >= startMs && c.ts <= endMs);
}

function buildFixedCfg(sym, combo, profile) {
  const { sep, stM, bracket } = combo;
  const sepAdxBase = resolveEliteSepAdxBase(profile);
  const { slPct, tpPct } = resolveEliteBracketPct(profile);

  const cfg = {
    ...SUPERTREND_ELITE_1H_PRESET,
    symbol: sym,
    timeframe: "1h",
    riskPerTrade: RISK,
    futuresLeverage: LEV,
    eliteStAutoCalibrate: false,
    eliteStHtf1hSepMode: sep,
    supertrendMultiplier: stM,
    eliteStHtf4hMultiplier: stM,
    eliteStHtf1hSepAdxBase: sepAdxBase,
    eliteStMinAdx: 0,
    eliteStMinVolumeVsAvg: 0,
    eliteStRequireAtrExpansion: false,
    _eliteCoinProfile: profile,
  };

  if (sep === "FIXED") {
    cfg.eliteStHtf1hMinSep = FIXED_MIN_SEP;
  }

  if (bracket === "TIGHT") {
    cfg.supertrendFuturesUseFixedSl = true;
    cfg.supertrendFuturesFixedSlPct = TIGHT_SL;
    cfg.supertrendFuturesUseFixedTp = true;
    cfg.supertrendFuturesFixedTpPct = TIGHT_TP;
    cfg.eliteStAutoBracketMode = "FIXED";
  } else if (bracket === "ATR") {
    cfg.supertrendFuturesUseFixedSl = true;
    cfg.supertrendFuturesFixedSlPct = slPct;
    cfg.supertrendFuturesUseFixedTp = true;
    cfg.supertrendFuturesFixedTpPct = tpPct;
    cfg.eliteStAutoBracketMode = "ATR";
  } else {
    const disasterSl = resolveEliteTrailDisasterSlPct(profile, { cfg });
    cfg.supertrendFuturesUseFixedSl = true;
    cfg.supertrendFuturesFixedSlPct = disasterSl;
    cfg.supertrendFuturesUseFixedTp = false;
    cfg.supertrendFuturesFixedTpPct = 0;
    cfg.eliteStAutoBracketMode = "OFF";
  }

  return cfg;
}

async function runCombo(sym, allCandles, combo, windowCandles, startEq) {
  const profile = buildEliteCoinProfile(allCandles);
  const raw = buildFixedCfg(sym, combo, profile);
  const cfg = prepareEliteRunCfg(raw, sym, allCandles);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles: windowCandles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: startEq,
    timeframe: "1h",
    adapters: {
      SUPERTREND_ELITE: buildEliteStBacktestAdapter(windowCandles, buildEliteStOptsFromCfg(cfg)),
    },
    symbol: sym,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "1h",
    startingEquity: startEq,
  });
  const n = sim.trades.filter((t) => t.exitReason !== "tp1_partial").length;
  return { ret: Number(m.totalReturnPct ?? 0), dd: Number(m.maxDrawdownPct ?? 0), n };
}

function comboKey(c) {
  return `${c.sep}_m${c.stM}_${c.bracket}`;
}

function rankInHalf(results, key) {
  const sorted = [...results].sort((a, b) => b.ret - a.ret);
  return sorted.findIndex((r) => comboKey(r.combo) === key) + 1;
}

function profileToRefRow(sym, profile, winner) {
  return {
    symbol: sym,
    atr: profile.medianAtrPct,
    adx: profile.medianAdx,
    p40Adx: profile.p40Adx,
    vol: profile.medianVolRatio,
    p40EmaSep: profile.p40H1EmaSep,
    sep: winner.sep,
    stM: winner.stM,
    bracket: winner.bracket,
  };
}

const grid = [];
for (const sep of SEP_MODES) {
  for (const stM of ST_MULTS) {
    for (const bracket of BRACKET_STYLES) {
      grid.push({ sep, stM, bracket });
    }
  }
}

console.log(`\nElite fixed-setup sweep | ${FROM} → ${TO} | ${SYMBOLS.length} coins x ${grid.length} combos\n`);

const results = {};

for (const sym of SYMBOLS) {
  const allCandles = await loadCandles(sym);
  if (!allCandles.length) {
    console.log(`${sym}: SKIP (no data)`);
    continue;
  }

  const profile = buildEliteCoinProfile(allCandles);
  const h1Candles = sliceCandles(allCandles, fromMs, h1EndMs);
  const h2Candles = sliceCandles(allCandles, h2StartMs, toMs);
  const fullCandles = allCandles;

  const combos = [];
  for (const combo of grid) {
    const full = await runCombo(sym, allCandles, combo, fullCandles, STARTING);
    const h1 = await runCombo(sym, allCandles, combo, h1Candles, STARTING);
    const h2 = await runCombo(sym, allCandles, combo, h2Candles, STARTING);
    combos.push({ combo, full, h1, h2 });
    process.stdout.write(".");
  }
  console.log(` ${sym}`);

  combos.sort((a, b) => b.full.ret - a.full.ret);
  const winner = combos[0];
  const runnerUp = combos[1] ?? null;
  const wKey = comboKey(winner.combo);

  const h1Rank = rankInHalf(combos.map((c) => ({ combo: c.combo, ret: c.h1.ret })), wKey);
  const h2Rank = rankInHalf(combos.map((c) => ({ combo: c.combo, ret: c.h2.ret })), wKey);
  const fragile =
    winner.h1.ret < 0 ||
    winner.h2.ret < 0 ||
    h1Rank > 3 ||
    h2Rank > 3;

  results[sym] = {
    profile: {
      medianAtrPct: profile.medianAtrPct,
      medianAdx: profile.medianAdx,
      p40Adx: profile.p40Adx,
      medianVolRatio: profile.medianVolRatio,
      p40H1EmaSep: profile.p40H1EmaSep,
      medianH1EmaSep: profile.medianH1EmaSep,
    },
    winner: {
      sep: winner.combo.sep,
      stM: winner.combo.stM,
      bracket: winner.combo.bracket,
      ret: winner.full.ret,
      dd: winner.full.dd,
      n: winner.full.n,
      h1Ret: winner.h1.ret,
      h2Ret: winner.h2.ret,
      h1Rank,
      h2Rank,
      fragile,
    },
    runnerUp: runnerUp
      ? {
          sep: runnerUp.combo.sep,
          stM: runnerUp.combo.stM,
          bracket: runnerUp.combo.bracket,
          ret: runnerUp.full.ret,
        }
      : null,
    referenceRow: profileToRefRow(sym, profile, winner.combo),
    top5: combos.slice(0, 5).map((c) => ({
      sep: c.combo.sep,
      stM: c.combo.stM,
      bracket: c.combo.bracket,
      ret: c.full.ret,
      n: c.full.n,
    })),
  };

  const w = results[sym].winner;
  console.log(
    `  → ${w.sep}/m${w.stM}/${w.bracket} ret ${w.ret.toFixed(1)}% (${w.n} tr)` +
      ` H1 ${w.h1Ret.toFixed(1)}% H2 ${w.h2Ret.toFixed(1)}%` +
      (w.fragile ? " [FRAGILE]" : ""),
  );
}

const outPath = path.resolve(__dirname, "elite-fixed-setup-sweep-results.json");
const payload = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: TO, h1End: H1_END, h2Start: H2_START },
  risk: RISK,
  leverage: LEV,
  startingUsdt: STARTING,
  coins: results,
  referenceTable: Object.values(results).map((r) => r.referenceRow),
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(`Reference rows: ${payload.referenceTable.length}`);

await closePool?.();
