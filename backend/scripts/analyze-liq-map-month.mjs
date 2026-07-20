#!/usr/bin/env node
/**
 * Deep 1-month analysis of LIQUIDITY_MAP through the REAL runner.
 *  - Validates each entry is a genuine sweep + reclaim (geometry check).
 *  - Shows how SL / TP1 / TP2 (opposing liquidity) are defined per trade.
 *  - Reports trade frequency (>= 1/day?) and returns for both exit modes.
 *
 * Usage:
 *   SYMBOL=BTCUSDT TF=15m FROM=2026-05-01 TO=2026-06-01 \
 *     node scripts/analyze-liq-map-month.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").trim();
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-05-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 10_000);
const MODE = (process.env.MODE || "BOTH").toUpperCase();
const SHOW = Math.max(0, Number(process.env.SHOW || 18));

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  LIQUIDITY_MAP_BTC_15M_PRESET,
  LIQUIDITY_MAP_BTC_5M_PRESET,
  LIQUIDITY_MAP_BTC_1M_PRESET,
  normalizeLiquidityMapRunCfg,
} = await import(
  "../src/strategy/liquidityMapStrategy.js"
);

const candles = await readCandles(SYMBOL, TF, fromMs - 12 * 86_400_000, toMs);
if (!candles.length) {
  console.error(`[analyze] no candles for ${SYMBOL} ${TF}`);
  await closePool?.();
  process.exit(1);
}
const byTs = new Map(candles.map((c) => [Number(c.ts), c]));

const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "n/a");
const pct = (v, d = 3) => (Number.isFinite(Number(v)) ? (Number(v) * 100).toFixed(d) : "n/a");
const dt = (ts) => new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 16);
const dayId = (ts) => new Date(Number(ts)).toISOString().slice(0, 10);

console.log(`\n=== LIQUIDITY_MAP 1-month analysis ===`);
console.log(`${SYMBOL} ${TF}  ${FROM} -> ${TO}  (${days.toFixed(0)} days)\n`);

const modes = MODE === "BOTH" ? ["PARTIAL_RUNNER", "SCALED_FIXED"] : [MODE];

const overrides = {};
if (process.env.LIQ_ONE_PER_DAY != null) overrides.liqMapOnePerDay = process.env.LIQ_ONE_PER_DAY !== "0";
if (process.env.MIN_WICK != null) overrides.liqMapMinWickRatio = Number(process.env.MIN_WICK);
if (process.env.MIN_RVOL != null) overrides.liqMapMinRvol = Number(process.env.MIN_RVOL);
if (process.env.HTF_MODE != null) overrides.liqMapHtfMode = process.env.HTF_MODE;
if (process.env.USE_4H != null) overrides.liqMapUse4hConfirm = process.env.USE_4H !== "0";
if (process.env.LOOKBACK != null) overrides.liqMapLookbackBars = Number(process.env.LOOKBACK);
if (process.env.MAX_AGE != null) overrides.liqMapMaxAgeBars = Number(process.env.MAX_AGE);
if (process.env.MAX_HOLD != null) {
  overrides.liqMapMaxHoldBars = Number(process.env.MAX_HOLD);
  overrides.intradayLiqMaxHoldBars = Number(process.env.MAX_HOLD);
}
if (process.env.NORM_THRESH != null) overrides.liqMapNormalizeThresholds = process.env.NORM_THRESH !== "0";
if (process.env.SWEEP_ATR_FRAC != null) overrides.liqMapSweepAtrFrac = Number(process.env.SWEEP_ATR_FRAC);
if (process.env.EQUAL_ATR_FRAC != null) overrides.liqMapEqualTolAtrFrac = Number(process.env.EQUAL_ATR_FRAC);
if (process.env.AUTO_CAL != null) overrides.liqMapAutoCalibrate = process.env.AUTO_CAL !== "0";
if (process.env.AUTO_PROFILE_BARS != null) overrides.liqMapAutoProfileBars = Number(process.env.AUTO_PROFILE_BARS);
if (process.env.QUALITY_GATE != null) overrides.liqMapQualityGate = process.env.QUALITY_GATE !== "0";
if (process.env.QUALITY_GATE_MODE != null) overrides.liqMapQualityGateMode = String(process.env.QUALITY_GATE_MODE).toUpperCase();
if (process.env.SOFT_GATE_BAND != null) overrides.liqMapSoftGateScoreBand = Number(process.env.SOFT_GATE_BAND);
if (process.env.QUALITY_AUTO != null) overrides.liqMapQualityAuto = process.env.QUALITY_AUTO !== "0";
if (process.env.MIN_QUALITY != null) overrides.liqMapMinQualityScore = Number(process.env.MIN_QUALITY);
if (process.env.ENTRY_MODEL != null) overrides.liqMapEntryModel = String(process.env.ENTRY_MODEL).toUpperCase();
if (process.env.HTF_POOL_TFS != null) overrides.liqMapHtfPoolTfs = String(process.env.HTF_POOL_TFS);
if (process.env.HTF_LOOKBACK != null) overrides.liqMapHtfLookbackBars = Number(process.env.HTF_LOOKBACK);
if (process.env.HTF_SWING_LEFT != null) overrides.liqMapHtfSwingLeft = Number(process.env.HTF_SWING_LEFT);
if (process.env.HTF_SWING_RIGHT != null) overrides.liqMapHtfSwingRight = Number(process.env.HTF_SWING_RIGHT);
if (process.env.HTF_EQUAL_TOUCHES != null) overrides.liqMapHtfEqualMinTouches = Number(process.env.HTF_EQUAL_TOUCHES);
if (process.env.DAILY_WEEKLY_POOLS != null) overrides.liqMapUseDailyWeeklyPools = process.env.DAILY_WEEKLY_POOLS !== "0";
if (process.env.TRENDLINE_POOLS != null) overrides.liqMapUseTrendlinePools = process.env.TRENDLINE_POOLS !== "0";
if (process.env.ENTRY_TIMING != null) overrides.liqMapEntryTiming = String(process.env.ENTRY_TIMING).toUpperCase();
if (process.env.REQUIRE_MSS != null) overrides.liqMapRequireMss = process.env.REQUIRE_MSS !== "0";
if (process.env.REQUIRE_CHOCH != null) overrides.liqMapRequireChoch = process.env.REQUIRE_CHOCH !== "0";
if (process.env.REQUIRE_RETRACE != null) overrides.liqMapRequireRetrace = process.env.REQUIRE_RETRACE !== "0";
if (process.env.RECLAIM_HOLD != null) overrides.liqMapRequireReclaimHold = process.env.RECLAIM_HOLD !== "0";
if (process.env.STRUCT_LOOKBACK != null) overrides.liqMapStructureLookbackBars = Number(process.env.STRUCT_LOOKBACK);
if (process.env.MSS_MAX_AFTER_SWEEP != null) overrides.liqMapMssMaxBarsAfterSweep = Number(process.env.MSS_MAX_AFTER_SWEEP);
if (process.env.ENTRY_ZONE != null) overrides.liqMapEntryZoneMode = String(process.env.ENTRY_ZONE).toUpperCase();
if (process.env.FVG_ENTRY != null) overrides.liqMapFvgEntryMode = String(process.env.FVG_ENTRY).toUpperCase();
if (process.env.MSS_DISPLACEMENT != null) overrides.liqMapMssRequireDisplacement = process.env.MSS_DISPLACEMENT !== "0";
if (process.env.DISP_BODY_MULT != null) overrides.liqMapDisplacementBodyMult = Number(process.env.DISP_BODY_MULT);
if (process.env.DISP_ATR_MULT != null) overrides.liqMapDisplacementAtrMult = Number(process.env.DISP_ATR_MULT);
if (process.env.FVG_MIN_GAP != null) overrides.liqMapFvgMinGapPct = Number(process.env.FVG_MIN_GAP);
if (process.env.STRICT_PD_ZONE != null) overrides.liqMapStrictPdZone = process.env.STRICT_PD_ZONE !== "0";
if (process.env.OB_DISP_ATR != null) overrides.liqMapObMinDisplacementAtr = Number(process.env.OB_DISP_ATR);
if (process.env.SL_MODE != null) overrides.liqMapSlMode = String(process.env.SL_MODE).toUpperCase();
if (process.env.ATR_SL != null) overrides.liqMapAtrSlMult = Number(process.env.ATR_SL);
if (process.env.SL_BUFFER_PCT != null) overrides.liqMapSlBufferPct = Number(process.env.SL_BUFFER_PCT);
if (process.env.SL_BUFFER_ATR != null) overrides.liqMapSlBufferAtrFrac = Number(process.env.SL_BUFFER_ATR);
if (process.env.SL_REGIME != null) overrides.liqMapSlRegimeAdjust = process.env.SL_REGIME !== "0";
if (process.env.SL_REGIME_LOW != null) overrides.liqMapSlRegimeLowMult = Number(process.env.SL_REGIME_LOW);
if (process.env.SL_REGIME_HIGH != null) overrides.liqMapSlRegimeHighMult = Number(process.env.SL_REGIME_HIGH);
if (process.env.TRAIL != null) overrides.liqMapTrailMode = process.env.TRAIL;
if (process.env.BE_AFTER_PARTIAL != null) overrides.liqMapBreakevenAfterPartial = process.env.BE_AFTER_PARTIAL !== "0";
if (process.env.LIQ_TRAIL_ST_PERIOD != null) {
  overrides.liqMapTrailStPeriod = Number(process.env.LIQ_TRAIL_ST_PERIOD);
  overrides.supertrendPeriod = Number(process.env.LIQ_TRAIL_ST_PERIOD);
}
if (process.env.LIQ_TRAIL_ST_MULT != null) {
  overrides.liqMapTrailStMult = Number(process.env.LIQ_TRAIL_ST_MULT);
  overrides.supertrendMultiplier = Number(process.env.LIQ_TRAIL_ST_MULT);
}
if (process.env.TRAIL_ATR_HWM != null) overrides.liqMapTrailAtrHwmMult = Number(process.env.TRAIL_ATR_HWM);
if (process.env.TRAIL_MFE_GIVEBACK != null) overrides.liqMapTrailMfeGiveback = Number(process.env.TRAIL_MFE_GIVEBACK);
if (process.env.TRAIL_MFE_MIN_R != null) overrides.liqMapTrailMfeMinR = Number(process.env.TRAIL_MFE_MIN_R);
if (process.env.TRAIL_STEP_ATR != null) overrides.liqMapTrailStepAtrMult = Number(process.env.TRAIL_STEP_ATR);
if (process.env.TRAIL_MERGE_ST != null) overrides.liqMapTrailMergeSt = process.env.TRAIL_MERGE_ST !== "0";
if (process.env.DEAD_BARS != null) overrides.liqMapDeadTradeExitBars = Number(process.env.DEAD_BARS);
if (process.env.DEAD_MIN_MFE_R != null) overrides.liqMapDeadTradeMinMfeR = Number(process.env.DEAD_MIN_MFE_R);
if (process.env.DEAD_MAX_LOSS_R != null) overrides.liqMapDeadTradeMaxLossR = Number(process.env.DEAD_MAX_LOSS_R);
if (process.env.MAX_TP_RR != null) overrides.liqMapMaxTpRr = Number(process.env.MAX_TP_RR);
if (process.env.MAX_OPP_RR != null) overrides.liqMapMaxOpposingRr = Number(process.env.MAX_OPP_RR);
if (process.env.DYN_RUNNER_MAX_TP_RR != null) overrides.liqMapDynamicRunnerMaxTpRr = Number(process.env.DYN_RUNNER_MAX_TP_RR);
if (process.env.DYN_RUNNER_MIN_TP_RR != null) overrides.liqMapDynamicRunnerMinTpRr = Number(process.env.DYN_RUNNER_MIN_TP_RR);
if (process.env.PROJ_TP_ATR != null) overrides.liqMapProjectedTpAtrMult = Number(process.env.PROJ_TP_ATR);
if (process.env.PROJ_TP_RANGE != null) overrides.liqMapProjectedTpRangeMult = Number(process.env.PROJ_TP_RANGE);
if (process.env.PROJ_TP_LOOKBACK != null) overrides.liqMapProjectionLookbackBars = Number(process.env.PROJ_TP_LOOKBACK);
if (process.env.DYN_EXIT != null) overrides.liqMapDynamicExitPolicy = process.env.DYN_EXIT !== "0";
if (process.env.DYN_EXIT_Q_HI != null) overrides.liqMapDynExitQualityHi = Number(process.env.DYN_EXIT_Q_HI);
if (process.env.DYN_EXIT_Q_MID != null) overrides.liqMapDynExitQualityMid = Number(process.env.DYN_EXIT_Q_MID);
if (process.env.DYN_EXIT_RR_HI != null) overrides.liqMapDynExitRrHi = Number(process.env.DYN_EXIT_RR_HI);
if (process.env.DYN_EXIT_RR_MID != null) overrides.liqMapDynExitRrMid = Number(process.env.DYN_EXIT_RR_MID);
if (process.env.DYN_EXIT_PARTIAL_HI != null) overrides.liqMapDynExitPartialHi = Number(process.env.DYN_EXIT_PARTIAL_HI);
if (process.env.DYN_EXIT_PARTIAL_MID != null) overrides.liqMapDynExitPartialMid = Number(process.env.DYN_EXIT_PARTIAL_MID);
if (process.env.DYN_EXIT_PARTIAL_BASE != null) overrides.liqMapDynExitPartialBase = Number(process.env.DYN_EXIT_PARTIAL_BASE);
if (process.env.DYN_EXIT_TRAIL_ATR_HI != null) overrides.liqMapDynExitTrailAtrHi = Number(process.env.DYN_EXIT_TRAIL_ATR_HI);
if (process.env.DYN_EXIT_TRAIL_ATR_MID != null) overrides.liqMapDynExitTrailAtrMid = Number(process.env.DYN_EXIT_TRAIL_ATR_MID);
if (process.env.DYN_EXIT_TRAIL_ATR_BASE != null) overrides.liqMapDynExitTrailAtrBase = Number(process.env.DYN_EXIT_TRAIL_ATR_BASE);
if (process.env.DYN_EXIT_WEAK_TP1_RR != null) overrides.liqMapDynExitWeakTp1Rr = Number(process.env.DYN_EXIT_WEAK_TP1_RR);
if (process.env.STRUCT_TP1_RR != null) overrides.liqMapStructuralTp1Rr = Number(process.env.STRUCT_TP1_RR);
if (process.env.ATR_PCTILE_LB != null) overrides.liqMapAtrPctileLookback = Number(process.env.ATR_PCTILE_LB);
if (Object.keys(overrides).length) console.log(`overrides=${JSON.stringify(overrides)}\n`);

for (const exitMode of modes) {
  const preset =
    String(TF).toLowerCase() === "1m"
      ? LIQUIDITY_MAP_BTC_1M_PRESET
      : String(TF).toLowerCase() === "5m"
        ? LIQUIDITY_MAP_BTC_5M_PRESET
        : LIQUIDITY_MAP_BTC_15M_PRESET;
  const baseCfg = {
    ...preset,
    symbol: SYMBOL,
    timeframe: TF,
    liqMapExitMode: exitMode,
    backtestSignalStartMs: fromMs,
    ...overrides,
  };
  const cfg = { ...baseCfg, ...normalizeLiquidityMapRunCfg(baseCfg) };
  const adapters = await buildBacktestAdapters({
    strategyKey: "LIQUIDITY_MAP",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: Number(candles[0]?.ts) || fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "LIQUIDITY_MAP",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });

  // de-dup partial fills: count one entry per entryTs
  const allRows = sim.trades || [];
  const inWin = allRows.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  const entryTsSet = new Set(inWin.map((t) => Number(t.entryTs)));
  const entries = [...entryTsSet].sort((a, b) => a - b);

  const metrics = computeAllMetrics({ trades: inWin, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });

  // ---- entry geometry validation (sweep + reclaim) ----
  let validSweep = 0;
  let validReclaim = 0;
  const firstRowByTs = new Map();
  for (const t of inWin) if (!firstRowByTs.has(Number(t.entryTs))) firstRowByTs.set(Number(t.entryTs), t);
  for (const ts of entries) {
    const t = firstRowByTs.get(ts);
    const lc = t.liqContext;
    const bar = byTs.get(Number(t.entryBarTs ?? t.entryTs)) || byTs.get(Number(t.entryTs));
    if (!lc || !bar) continue;
    const level = Number(lc.level);
    const wick = Number(lc.sweepWick);
    const isLong = String(t.direction) === "BUY";
    // sweep: wick pierced beyond the pool level
    const sweptOk = isLong ? wick < level : wick > level;
    // reclaim: bar closed back across the level on the correct side
    const reclaimOk = isLong ? Number(bar.close) > level : Number(bar.close) < level;
    if (sweptOk) validSweep++;
    if (reclaimOk) validReclaim++;
  }

  const daysWithTrade = new Set(entries.map((ts) => dayId(ts))).size;
  const exits = inWin.reduce((m, t) => {
    const r = String(t.exitReason ?? "?");
    m[r] = (m[r] || 0) + 1;
    return m;
  }, {});

  console.log(`########## ${exitMode} ##########`);
  console.log(
    `entries=${entries.length}  /day=${num(entries.length / days)}  ` +
      `days_with_trade=${daysWithTrade}/${Math.round(days)}  fills(incl partials)=${inWin.length}`,
  );
  console.log(
    `ret%=${num(metrics.totalReturnPct)}  WR%=${num((metrics.winRate ?? 0) * 100)}  ` +
      `PF=${num(metrics.profitFactor)}  maxDD%=${num(metrics.maxDrawdownPct)}  expectancyR=${num(metrics.expectancyR, 3)}`,
  );
  console.log(
    `entry validity: sweep_geometry=${validSweep}/${entries.length}  reclaim_close=${validReclaim}/${entries.length}`,
  );
  console.log(`exit reasons: ${JSON.stringify(exits)}`);

  // ---- per-trade SL/TP table (first SHOW unique entries) ----
  if (SHOW > 0) {
    console.log(
      `\n  ${"date".padEnd(16)}${"side".padStart(5)}${"pool".padStart(12)}` +
        `${"entry".padStart(11)}${"SL".padStart(11)}${"slPct".padStart(8)}` +
        `${"TP1(1R)".padStart(11)}${"TP2/opp".padStart(11)}${"oppR".padStart(7)}${"exit".padStart(14)}`,
    );
    let shown = 0;
    for (const ts of entries) {
      if (shown >= SHOW) break;
      const t = firstRowByTs.get(ts);
      const lc = t.liqContext || {};
      const isLong = String(t.direction) === "BUY";
      const entry = Number(t.entryPrice);
      const sl = Number(t.initialSlPrice ?? t.slPrice);
      const risk = Math.abs(entry - sl);
      const slPct = entry > 0 ? risk / entry : 0;
      const tp1 = isLong ? entry + risk : entry - risk;
      const opp = Number(lc.opposingLevel);
      const oppR = risk > 0 && Number.isFinite(opp) ? Math.abs(opp - entry) / risk : NaN;
      console.log(
        `  ${dt(ts).padEnd(16)}${String(t.direction).padStart(5)}${String(lc.levelType ?? "?").padStart(12)}` +
          `${num(entry).padStart(11)}${num(sl).padStart(11)}${pct(slPct, 2).padStart(7)}%` +
          `${num(tp1).padStart(11)}${num(opp).padStart(11)}${num(oppR, 1).padStart(7)}${String(t.exitReason ?? "?").padStart(14)}`,
      );
      shown++;
    }
  }
  console.log("");
}

await closePool?.();
