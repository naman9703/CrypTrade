#!/usr/bin/env node
/**
 * Per-coin: dynamic auto-tune vs sweep-optimal fixed setup (sep + ST + bracket).
 *
 * Oracle winners loaded from elite-fixed-setup-sweep-results.json.
 *
 * Usage (from backend/):
 *   node scripts/backtest-elite-dynamic-vs-oracle.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-11";
const STARTING = Number(process.env.STARTING_USDT || 100);
const RISK = Number(process.env.RISK_PCT || 5);
const LEV = Number(process.env.LEVERAGE || 10);

const sweepPath = path.resolve(__dirname, "elite-fixed-setup-sweep-results.json");
const sweepData = JSON.parse(fs.readFileSync(sweepPath, "utf8"));

/** @type {Record<string, { sep: string, stM: number, bracket: string, fragile?: boolean, ret?: number }>} */
export const ELITE_ORACLE_OPTIMUM = {};
for (const [sym, row] of Object.entries(sweepData.coins ?? {})) {
  ELITE_ORACLE_OPTIMUM[sym] = {
    sep: row.winner.sep,
    stM: row.winner.stM,
    bracket: row.winner.bracket,
    fragile: row.winner.fragile,
    ret: row.winner.ret,
  };
}

const SYMBOLS = (process.env.SYMBOLS || Object.keys(ELITE_ORACLE_OPTIMUM).join(","))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const TIGHT_SL = 0.002;
const TIGHT_TP = 0.015;
const FIXED_MIN_SEP = 0.0003;

const { closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
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
  eliteBracketStyleToMode,
} = await import("../src/strategy/eliteAutoCalibrate.js");
const { SUPERTREND_ELITE_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");
const { SUPERTREND_ELITE_AUTO_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

async function loadCandles(sym) {
  if (getPool?.()) {
    try {
      const rows = await readCandles(sym, "1h", fromMs, toMs, { market: "futures" });
      if (rows.length > 100) return rows;
    } catch {
      /* fall through */
    }
  }
  return fetchBinanceKlinesRange({
    symbol: sym,
    interval: "1h",
    startTime: fromMs,
    endTime: toMs,
    feedKind: "BINANCE_FUTURES",
  });
}

function buildOracleRawCfg(sym, opt, profile) {
  const sepAdxBase = resolveEliteSepAdxBase(profile);
  const { slPct, tpPct } = resolveEliteBracketPct(profile);
  const cfg = {
    ...SUPERTREND_ELITE_1H_PRESET,
    symbol: sym,
    timeframe: "1h",
    riskPerTrade: RISK,
    futuresLeverage: LEV,
    eliteStAutoCalibrate: false,
    eliteStHtf1hSepMode: opt.sep,
    supertrendMultiplier: opt.stM,
    eliteStHtf4hMultiplier: opt.stM,
    eliteStHtf1hSepAdxBase: sepAdxBase,
    eliteStMinAdx: 0,
    eliteStMinVolumeVsAvg: 0,
    eliteStRequireAtrExpansion: false,
    _eliteCoinProfile: profile,
  };
  if (opt.sep === "FIXED") cfg.eliteStHtf1hMinSep = FIXED_MIN_SEP;

  if (opt.bracket === "TIGHT") {
    cfg.supertrendFuturesUseFixedSl = true;
    cfg.supertrendFuturesFixedSlPct = TIGHT_SL;
    cfg.supertrendFuturesUseFixedTp = true;
    cfg.supertrendFuturesFixedTpPct = TIGHT_TP;
    cfg.eliteStAutoBracketMode = "FIXED";
  } else if (opt.bracket === "ATR") {
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

function bracketLabel(cfg) {
  const mode = String(cfg.eliteStAutoBracketMode ?? "").toUpperCase();
  if (mode === "OFF") return "TRAIL";
  if (mode === "FIXED" && Number(cfg.supertrendFuturesFixedSlPct) <= 0.003) return "TIGHT";
  if (mode === "ATR") return "ATR";
  if (mode === "FIXED") return "TIGHT";
  return mode || "?";
}

async function runCoin(sym, mode, candles) {
  if (!candles.length) return null;
  const opt = ELITE_ORACLE_OPTIMUM[sym];
  if (!opt) throw new Error(`No oracle row for ${sym}`);

  const rawCfg =
    mode === "dynamic"
      ? {
          ...SUPERTREND_ELITE_AUTO_1H_PRESET,
          symbol: sym,
          timeframe: "1h",
          riskPerTrade: RISK,
          futuresLeverage: LEV,
          eliteStAutoFullTune: true,
        }
      : buildOracleRawCfg(sym, opt, buildEliteCoinProfile(candles));

  const cfg = prepareEliteRunCfg(rawCfg, sym, candles);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: STARTING,
    timeframe: "1h",
    adapters: {
      SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(cfg)),
    },
    symbol: sym,
  });

  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "1h",
    startingEquity: STARTING,
  });
  const n = sim.trades.filter((t) => t.exitReason !== "tp1_partial").length;
  const tuning = cfg._eliteDynamicTuning ?? {};

  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    n,
    sep: cfg.eliteStHtf1hSepMode,
    stM: cfg.supertrendMultiplier,
    bracket: bracketLabel(cfg),
    bracketMode: cfg.eliteStAutoBracketMode,
    sl: cfg.supertrendFuturesFixedSlPct,
    tuneSource: tuning.tuneSource ?? null,
    nearestD: tuning.nearestRef?.d ?? null,
    dynamicBracket: tuning.bracketStyle ?? null,
  };
}

function cfgMatch(dynamic, opt) {
  return (
    dynamic.sep === opt.sep &&
    dynamic.stM === opt.stM &&
    dynamic.bracket === opt.bracket
  );
}

function retMatch(oracleRet, dynRet) {
  return Math.abs(dynRet - oracleRet) <= Math.max(0.5, Math.abs(oracleRet) * 0.01);
}

console.log(`\nElite dynamic vs sweep-optimal | ${FROM} → ${TO} | $${STARTING} @ ${RISK}% risk ${LEV}x\n`);
console.log(
  "Symbol".padEnd(10),
  "Cfg",
  "Dynamic setup",
  "Oracle setup",
  "Ret dyn",
  "Ret ora",
  "Match",
  "Trades",
);
console.log("-".repeat(100));

let cfgMatches = 0;
let retMatches = 0;
const rows = [];

for (const sym of SYMBOLS) {
  const candles = await loadCandles(sym);
  const oracle = await runCoin(sym, "oracle", candles);
  const dynamic = await runCoin(sym, "dynamic", candles);
  if (!oracle || !dynamic) {
    console.log(`${sym.padEnd(10)} SKIP (no candles)`);
    continue;
  }

  const opt = ELITE_ORACLE_OPTIMUM[sym];
  const cfgOk = cfgMatch(dynamic, opt);
  const retOk = retMatch(oracle.ret, dynamic.ret) && oracle.n === dynamic.n;
  if (cfgOk) cfgMatches += 1;
  if (retOk) retMatches += 1;

  const dynSetup = `${dynamic.sep}/m${dynamic.stM}/${dynamic.bracket}`;
  const oraSetup = `${opt.sep}/m${opt.stM}/${opt.bracket}`;
  rows.push({ sym, oracle, dynamic, cfgOk, retOk, opt });
  console.log(
    sym.padEnd(10),
    cfgOk ? "OK " : "XX ",
    dynSetup.padEnd(22),
    oraSetup.padEnd(22),
    `${dynamic.ret.toFixed(1)}%`.padStart(8),
    `${oracle.ret.toFixed(1)}%`.padStart(8),
    retOk ? "  yes" : "   no",
    `${dynamic.n}/${oracle.n}`.padStart(7),
    dynamic.tuneSource ? `(${dynamic.tuneSource})` : "",
    opt.fragile ? "[fragile]" : "",
  );
}

console.log("-".repeat(100));
console.log(`Config match: ${cfgMatches}/${rows.length} | Return+trade match: ${retMatches}/${rows.length}`);

const mismatches = rows.filter((r) => !r.cfgOk || !r.retOk);
if (mismatches.length) {
  console.log("\nMismatches:");
  for (const r of mismatches) {
    console.log(
      `  ${r.sym}: cfg ${r.cfgOk ? "ok" : `${r.dynamic.sep}/m${r.dynamic.stM}/${r.dynamic.bracket} vs ${r.opt.sep}/m${r.opt.stM}/${r.opt.bracket}`}` +
        ` | ret dyn ${r.dynamic.ret.toFixed(2)}% ora ${r.oracle.ret.toFixed(2)}%` +
        ` | tr ${r.dynamic.n}/${r.oracle.n}` +
        (r.dynamic.nearestD != null ? ` | nn d=${r.dynamic.nearestD.toFixed(4)}` : ""),
    );
  }
}

await closePool?.();
