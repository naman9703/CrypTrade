/**
 * Backtest runner. Drives a strict no-look-ahead loop:
 *   - signal evaluated on the just-closed bar (`signalFromSupertrendBar(bar[i])`)
 *   - entries/exits use the *next* bar's open (or hit price for SL/TP)
 *   - fees + slippage always applied
 *   - funding charged every 8h for futures
 *   - approximate intelligence-gate replay can veto / size-scale entries
 *
 * Signal lifecycle (all strategies, including adapters like SURF_PULSE_ML):
 *   1. Signal is pre-computed ONCE at bar[i] and reused for both exit and entry.
 *   2. If a position is open and the signal flips direction → "flip" exit at next open.
 *   3. After exit (or if no position), the same flip signal also opens the new position.
 *   4. In spot markets SELL signals are LONG-only exits — no short-selling.
 *
 * Persistence helpers live in worker.js so this module stays pure and unit-testable.
 */

import { resolveCostModel, applySlippage, fundingPaidBetween, tradeBreakdown, liquidationPrice } from "./costModel.js";
import { buildSupertrendSeries, signalFromSupertrendBar } from "./signals/supertrend.js";
import { tfToMs } from "../data/timeframe.js";
import { resolveTrailOnlyAfterTp2Fill } from "../../../lib/trailingOptsFromCfg.js";
import { adverseExtreme, advanceTrailForBar, resolveTrailingOpts } from "./trailingSim.js";
import { evaluateSupertrendMoveQuality } from "../../strategy/supertrendMoveQuality.js";
import { computeIndicators } from "../../strategy/indicators.js";
import { computeMarketDecisionSnapshot, mergeMarketDecisionConfig } from "../../lib/marketDecisionEngine.js";
import {
  evaluateTrendHtfStRegime,
  classifyTrendHtfStTradeOutcome,
  isTrendHtfStRegimeGateEnabled,
  isTrendHtfStSurgicalLossFilterEnabled,
} from "../../strategy/trendHtfStRegime.js";
import { fixedBracketSlEnabled, fixedBracketTpEnabled, bracketSlLegsEnabled, bracketTpLegsEnabled } from "../../strategy/bracketToggles.js";
import { resolveSizingStopPrice } from "../../strategy/sizingStop.js";
import { computeEntryQtyDetailed, resolvePositionLeverage } from "../backtestSizing.js";
import {
  buildSupertrendConfirmationContext,
  evaluateSupertrendConfirmationGate,
  readConfirmationGateCfg,
} from "../../strategy/supertrendConfirmationGate.js";
import {
  evaluateSupertrendBigMoveGate,
  readBigMoveGateCfg,
} from "../../strategy/supertrendBigMoveGate.js";
import {
  buildHtf4hContext,
  evaluateHtf4hFilter,
  readHtf4hFilterCfg,
} from "../../strategy/supertrendHtf4hFilter.js";
import { normalizeEliteStRunCfg } from "../../strategy/supertrendElite.js";
import { resolveLiquidityMapRunCfg } from "../../strategy/liquidityMapStrategy.js";
import { resolveFibEntryBrackets } from "../../strategy/techniques/fibonacci.js";
import {
  liqBreakevenStopPx,
  mapLiquidityEntryLegs,
  resolveLiquidityEntryBrackets,
  resolveLiqRunnerTpHits,
} from "../../strategy/techniques/liquidity.js";
import {
  mapOrderFlowEntryLegs,
  resolveOrderFlowEntryBrackets,
} from "../../strategy/techniques/orderFlowBrackets.js";
import { orderFlowExitSignal } from "../../strategy/techniques/orderFlowPatterns.js";

const SUPERTREND_KEY = "SUPERTREND";
const SUPERTREND_ELITE_KEY = "SUPERTREND_ELITE";
const TREND_HTF_ST_KEY = "TREND_HTF_ST";
const ELITE_HTF_KEY = "ELITE_HTF";

/** Max closed bars before `time_stop` exit (0 = disabled). LIQ+S/R uses liq hold when SMC gate is off. */
export function resolveMaxHoldBars(cfg = {}) {
  const liqOn =
    cfg.intradayGateLiquidity !== false ||
    cfg.intradayGateInstitutionalSr === true ||
    cfg.intradaySrAPlusMode === true;
  const smcOn = cfg.intradayGateSmcIct === true || cfg.intradaySmcIctMode === true;
  const readHold = (key) => {
    if (!Object.prototype.hasOwnProperty.call(cfg, key)) return null;
    const v = Number(cfg[key]);
    if (!Number.isFinite(v) || v < 0) return null;
    return Math.floor(v);
  };
  const pick = (...keys) => {
    for (const k of keys) {
      const v = readHold(k);
      if (v != null) return v;
    }
    return 0;
  };
  if (liqOn && !smcOn) {
    const liqHold = readHold("intradayLiqMaxHoldBars");
    return liqHold != null ? liqHold : 0;
  }
  return Math.max(0, pick("intradaySmcMaxHoldBars", "intradayLiqMaxHoldBars", "intradayOfMaxHoldBars"));
}

function finalizeTradeRecord(pos, row) {
  return {
    ...row,
    effectiveLeverage:
      pos?.effectiveLeverage != null && Number.isFinite(Number(pos.effectiveLeverage))
        ? Number(pos.effectiveLeverage)
        : row.effectiveLeverage ?? null,
    entryQuality: pos?.entryQuality ?? null,
    vpSetup: pos?.vpSetup ?? null,
    entryReason: pos?.entryReason ?? null,
    liqContext: pos?.liqContext ?? null,
    regime: pos?.regime ?? null,
    situation: pos?.situation ?? null,
    playbook: pos?.playbook ?? null,
    trigger: pos?.trigger ?? null,
    // Entry-time stop distance so R-multiples stay honest after breakeven trailing.
    initialSlPrice: pos?.initialSl ?? null,
    initialRiskUsd: pos?.initialRiskUsd ?? null,
    lossPattern: classifyTrendHtfStTradeOutcome(row),
  };
}

/**
 * Bracket exits (SL / trail / TP) fill at the stop/target price when it lies inside
 * the bar range; otherwise clamp to [low, high] so chart OHLC matches the exit bar.
 */
export function clampBracketFillToBar(exitPrice, bar) {
  const px = Number(exitPrice);
  if (!bar || !Number.isFinite(px)) return exitPrice;
  const lo = Math.min(Number(bar.low), Number(bar.high));
  const hi = Math.max(Number(bar.low), Number(bar.high));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return exitPrice;
  return Math.max(lo, Math.min(hi, px));
}

/**
 * Position size for the next entry.
 *
 * `RISK_AT_SL` (default): risk `riskPerTrade` % of policy cap at the stop distance,
 * capped by `allowedBudgetUsdt` allotment and `equity × leverage` (live parity).
 *
 * `RISK_AT_SL_FULL_MARGIN`: same dollar risk at SL, but margin = full per-trade cap;
 * `futuresLeverage` is the max leverage — effective leverage varies per trade.
 *
 * `FULL_EQUITY_MARGIN`: use full per-trade margin cap as isolated margin
 * (`qty = marginCap × leverage / entry` on futures).
 *
 * @param {object} p
 * @param {number} p.equity
 * @param {number} p.entryFill
 * @param {number} p.sl
 * @param {Record<string, unknown>} p.cfg
 * @param {import("./costModel.js").ResolvedCostModel} p.cm
 * @param {boolean} p.isFutures
 * @param {number} [p.sizeMult]
 * @param {string} [p.symbol]
 * @param {number} [p.openMarginUsdt]
 * @returns {number}
 */
export function computeEntryQty({ equity, entryFill, sl, cfg, cm, isFutures, sizeMult = 1, symbol = "", openMarginUsdt = 0 }) {
  return computeEntryQtyDetailed({
    equity,
    entryFill,
    sl,
    cfg,
    cm,
    isFutures,
    sizeMult,
    symbol,
    openMarginUsdt,
  }).qty;
}

/**
 * Live-parity trailing requires the Supertrend line for SUPERTREND mode even
 * when the **signal** strategy is something else (e.g. AUTO, SURF_PULSE_ML).
 * We always build the series when trail is on so backtest = live.
 */
function trailNeedsSupertrend(cfg) {
  if (cfg?.trailingStopLossAuto !== true) return false;
  const mode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  if (mode === "OFF" || mode === "FEE_LADDER") return false;
  return true;
}

/**
 * @param {Object} args
 * @param {string} args.strategyKey
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>} args.candles
 * @param {Record<string, unknown>} args.cfg                           cfg_raw bot subtree
 * @param {Object} args.costModelOverride
 * @param {'off'|'approx'} args.gateMode
 * @param {Array<{ts:number,rate:number}>} [args.fundingRates]
 * @param {(ts:number)=>{intelScore:number, action:'pass'|'vetoed'|'size_scaled', sizeMult:number}} [args.gateFn]
 * @param {(opts:{ percent:number, equity:number, ts:number })=>void} [args.onProgress]
 * @param {()=>boolean} [args.shouldCancel]
 * @param {number} args.startingUsdt
 * @param {string} args.timeframe
 * @param {Record<string, (bar:any, idx:number, ctx:any)=>Promise<{action:'BUY'|'SELL'|'HOLD',reason:string}|null>|{action:'BUY'|'SELL'|'HOLD',reason:string}|null>} [args.adapters]
 */
export async function runSimulation(args) {
  const {
    strategyKey,
    candles,
    costModelOverride = {},
    gateMode = "off",
    fundingRates = [],
    gateFn,
    onProgress,
    shouldCancel,
    startingUsdt,
    timeframe,
    symbol = "",
    adapters = {},
  } = args;

  let cfg = args.cfg;
  if (strategyKey === "SITUATION_INTRADAY" && cfg && typeof cfg === "object") {
    const { resolveSituationRouterCfg } = await import("../../strategy/situationIntraday.js");
    cfg = resolveSituationRouterCfg(cfg);
  } else if (strategyKey === "CRT_TBS" && cfg && typeof cfg === "object") {
    const { resolveCrtTbsCfg } = await import("../../strategy/crtTbsIntraday.js");
    cfg = resolveCrtTbsCfg(cfg);
  } else if (strategyKey === "TOKYO_SESSION" && cfg && typeof cfg === "object") {
    const { resolveTokyoSessionCfg } = await import("../../strategy/tokyoSessionIntraday.js");
    cfg = resolveTokyoSessionCfg(cfg);
  } else if (
    (strategyKey === SUPERTREND_ELITE_KEY || strategyKey === "UNIFIED_ELITE") &&
    cfg &&
    typeof cfg === "object"
  ) {
    cfg = normalizeEliteStRunCfg(cfg);
  } else if (strategyKey === "LIQUIDITY_MAP" && cfg && typeof cfg === "object") {
    cfg = resolveLiquidityMapRunCfg(cfg, candles);
  }

  const cm = resolveCostModel(cfg, costModelOverride);
  const tfMs = tfToMs(timeframe);
  const startEq = Math.max(1, Number(startingUsdt));
  const fixedSlPct = Number(cfg?.supertrendFuturesFixedSlPct ?? 0);
  const fixedTpPct = Number(cfg?.supertrendFuturesFixedTpPct ?? 0);
  const bracketSlOn = fixedBracketSlEnabled(cfg);
  const bracketTpOn = fixedBracketTpEnabled(cfg);
  /** Live futures: `trailingStopLossAuto` must be on for any trailing SL; see `bot.js` + `trailingStopLoss.js`. */
  const trailingStopLossAuto = cfg?.trailingStopLossAuto === true;
  const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const isFutures = cm.isFutures;
  /** Trailing is futures-only in live; gate the same way here. */
  const trailEnabled = trailingStopLossAuto && isFutures && futuresTrailMode !== "OFF";

  // ── Signal-quality gates (mirrors live bot gate checks) ──────────────────────
  /** Move-quality gate — uses the same evaluateSupertrendMoveQuality the live bot calls. */
  const moveQualityGate = cfg?.supertrendMoveQualityGate === true;
  const moveQualityOpts = moveQualityGate ? {
    minScore:             Number(cfg?.supertrendMoveQualityMinScore  ?? 0.5),
    minAdx:               Number(cfg?.supertrendMoveQualityMinAdx    ?? 18),
    minMoveToSlRatio:     Number(cfg?.supertrendMoveQualityMinMoveSlRatio ?? 1.5),
    expectedMoveAtrMult:  Number(cfg?.supertrendMoveQualityExpectedMoveAtrMult ?? 1.5),
    minAtrExpansion:      Number(cfg?.supertrendMoveQualityMinAtrExpansion ?? 0),
    minBodyVsAvg:         Number(cfg?.supertrendMoveQualityMinBodyVsAvg ?? 0.55),
    minDirectionalBody:   Number(cfg?.supertrendMoveQualityMinDirectionalBody ?? 0),
    minVolumeVsAvgRatio:  Number(cfg?.supertrendMoveQualityMinVolumeVsAvg ?? 0),
  } : null;

  /** Breakout confirm: defer entry until a subsequent bar closes beyond the signal bar's high/low. */
  const breakoutConfirm = cfg?.supertrendBreakoutConfirm === true;
  const breakoutMaxBars = Math.max(1, Math.min(20, Math.floor(Number(cfg?.supertrendBreakoutMaxBars ?? 5))));

  /** Signal strength gate — mirrors live `signalStrengthBlocksOpen`. */
  const signalStrengthEnabled = cfg?.signalStrengthGatesTrades === true;
  const signalStrengthOpenMin = Math.max(0, Math.min(100, Math.round(Number(cfg?.signalStrengthOpenMin ?? 65))));

  /** Market decision engine — ADX/EMA regime + fee gate. Uses live `computeMarketDecisionSnapshot`. */
  const mdRawCfg = cfg?.marketDecision && typeof cfg.marketDecision === "object" ? cfg.marketDecision : null;
  const mdCfg = mdRawCfg ? mergeMarketDecisionConfig(mdRawCfg) : null;
  const marketDecisionEnabled = mdCfg?.enabled === true;

  /** Max daily loss: stop trading on the day once equity drops this much. */
  const maxDailyLossEnabled = Number(cfg?.maxDailyLoss ?? 0) > 0;
  const maxDailyLossVal = Number(cfg?.maxDailyLoss ?? 0);
  /** Live bot defaults maxDailyLossUnit to "PCT" not "USDT". */
  const maxDailyLossIsUsdt = String(cfg?.maxDailyLossUnit ?? "PCT").toUpperCase() === "USDT";

  // ── Institutional risk overlay (regime-adaptive + reusable by any strategy) ──
  const clampNum = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  /** Single user-facing aggressiveness dial: scales risk-per-trade ~1:1 with return AND drawdown. */
  const riskScale = clampNum(cfg?.riskScale, 0.1, 5, 1);
  /** Vol-targeted sizing: scale size by referenceATR%/currentATR% so risk is constant across regimes. */
  const volTargetEnabled = cfg?.volTargetSizing === true;
  const volTargetAtrPct = clampNum(cfg?.volTargetAtrPct, 0.0005, 0.1, 0.005);
  const volTargetMaxMult = clampNum(cfg?.volTargetMaxMult, 1, 5, 2);
  const volTargetMinMult = clampNum(cfg?.volTargetMinMult, 0.05, 1, 0.4);
  /** Account-drawdown kill switch: halt NEW entries once equity is this far below peak. 0 = off. */
  const killSwitchDdPct = clampNum(cfg?.riskKillSwitchDdPct, 0, 100, 0);
  /** Consecutive-loss cooldown: stop new entries for the rest of the UTC day after N losses in a row. 0 = off. */
  const consecLossLimit = Math.max(0, Math.floor(Number(cfg?.riskConsecutiveLossLimit ?? 0)));
  /** Weekly drawdown cap: halt new entries once the rolling 7-day equity is down this %. 0 = off. */
  const weeklyDdCapPct = clampNum(cfg?.riskWeeklyMaxLossPct, 0, 100, 0);
  const riskOverlayReplay = { killSwitch: 0, weeklyCap: 0, consecCooldown: 0, dailyCap: 0 };

  /**
   * Build the Supertrend series whenever the strategy key OR the trailing
   * stop needs it. Previously this was gated on `strategyKey === SUPERTREND`,
   * which silently disabled live-parity trail for AUTO / non-Supertrend signal
   * paths even though `futuresTrailingStopMode = "SUPERTREND"` was set.
   */
  let stSeries = null;
  if (strategyKey === SUPERTREND_KEY || trailNeedsSupertrend(cfg)) {
    stSeries = buildSupertrendSeries(candles, {
      period: Number(cfg?.supertrendPeriod ?? 10),
      multiplier: Number(cfg?.supertrendMultiplier ?? 3),
      wilderAtr: cfg?.supertrendWilderAtr !== false,
    });
  }

  // Pre-compute per-bar ATR for signal-quality gates (simple rolling ATR).
  const atrPeriod = Number(cfg?.supertrendPeriod ?? 10);
  const atrSeries = computeSimpleAtr(candles, atrPeriod);

  /** Optional ST companion gate — filters signal-bar quality before entry. */
  const confirmationCfg = readConfirmationGateCfg(cfg);
  const confirmationCtx = confirmationCfg
    ? buildSupertrendConfirmationContext(candles, confirmationCfg)
    : null;
  const confirmationReplay = {
    enabled: confirmationCtx != null,
    pass: 0,
    veto: 0,
    reasons: {},
  };

  const bigMoveCfg = readBigMoveGateCfg(cfg);
  const bigMoveReplay = { enabled: bigMoveCfg != null, pass: 0, veto: 0, reasons: {} };

  /** 4H Supertrend direction confirmation filter (built once, reused per bar). */
  const htf4hFilterCfg = readHtf4hFilterCfg(cfg);
  const htf4hCtx = htf4hFilterCfg ? buildHtf4hContext(candles, htf4hFilterCfg) : null;
  const htf4hReplay = { enabled: htf4hCtx != null, pass: 0, veto: 0, reasons: {} };

  /**
   * Pre-compute per-bar `computeIndicators` snapshots for move-quality and signal-strength gates.
   * Uses a 120-bar rolling window — enough to stabilise ADX-14, RSI-14, ATR-14, EMA-26.
   * Only called when at least one gate that needs indicators is enabled.
   */
  const INDICATOR_LOOKBACK = 120;
  const needsIndicators = moveQualityGate || signalStrengthEnabled;
  function latestIndicatorsAt(idx) {
    if (!needsIndicators) return null;
    const start = Math.max(0, idx - INDICATOR_LOOKBACK + 1);
    const slice = candles.slice(start, idx + 1);
    if (slice.length < 14) return null;
    try {
      return computeIndicators(slice).latest;
    } catch {
      return null;
    }
  }

  /**
   * Pre-compute market decision verdicts for every bar.
   * `computeMarketDecisionSnapshot` needs `max(30, emaLength+2)` bars minimum
   * (default emaLength=200 → 202 bars). We use a 500-bar rolling window so the
   * EMA is well-stabilised from bar 202 onwards, matching how the live bot operates
   * on a continuously-growing candle buffer. Earlier bars return null (pass-through),
   * exactly as live bot does during warmup.
   */
  const MD_LOOKBACK = 500;
  let mdVerdicts = null;
  if (marketDecisionEnabled && mdCfg) {
    mdVerdicts = new Array(candles.length).fill(null);
    for (let mi = 0; mi < candles.length; mi++) {
      const sliceMd = candles.slice(Math.max(0, mi - MD_LOOKBACK + 1), mi + 1);
      try {
        const snap = computeMarketDecisionSnapshot({
          candles: sliceMd,
          cTs: candles[mi].ts,
          row: null,
          decisionSnapshotBar: null,
          symbol,
          timeframe,
          config: mdCfg,
        });
        mdVerdicts[mi] = snap ? String(snap.verdict || "").toUpperCase() : null;
      } catch {
        mdVerdicts[mi] = null;
      }
    }
  }

  const trades = [];
  const equityCurve = [];
  const gateReplay = {
    mode: gateMode,
    evaluated: 0,
    pass: 0,
    vetoed: 0,
    sizeScaled: 0,
    noGate: 0,
    intelScoreSum: 0,
  };
  let equity = startEq;
  let dayStartEquity = startEq;
  let dayStartMs = candles.length ? Math.floor(candles[0].ts / 86400000) * 86400000 : 0;
  // Risk-overlay running state.
  let peakEquity = startEq;
  let weekStartEquity = startEq;
  let weekStartMs = dayStartMs;
  /**
   * Pending breakout state: when `supertrendBreakoutConfirm` is on, on a signal bar
   * we record the signal and wait up to `breakoutMaxBars` bars for a confirming close
   * beyond the signal bar's high (BUY) or low (SELL) — exactly mirroring live `bot.js`.
   */
  let pendingBreakout = null; // { side, signalHi, signalLo, barsLeft, flipIdx }
  /** Bar index of the ST flip when a deferred breakout entry fires (for big-move gate). */
  let confirmedBreakoutFlipIdx = -1;
  /** @type {null | {
   *   side:'BUY'|'SELL', entryFill:number, entryTs:number, entryIdx:number,
   *   qty:number, sl:number, tp:number,
   *   trailStep:number, extremePx:number, trailTierLabel:string|null, trailOpts:object|null,
   *   intelAtEntry:number, gateAction:string, sizeMult:number, mae:number, mfe:number, liqPx:number
   * }} */
  let pos = null;

  for (let i = 0; i < candles.length; i++) {
    if (shouldCancel?.()) break;
    const bar = candles[i];

    // ── Daily / weekly loss reset + peak tracking ───────────────────────────────
    const barDayMs = Math.floor(bar.ts / 86400000) * 86400000;
    if (barDayMs > dayStartMs) {
      dayStartEquity = equity;
      dayStartMs = barDayMs;
    }
    if (barDayMs - weekStartMs >= 7 * 86400000) {
      weekStartEquity = equity;
      weekStartMs = barDayMs;
    }
    if (equity > peakEquity) peakEquity = equity;

    // ── Pre-compute this bar's signal ONCE (reused for both exit flip and entry) ──
    // Adapters may be async (e.g. SURF_PULSE_ML ML gate). We await here so the
    // loop remains strict and look-ahead-free.
    let barSignal = null;
    if (strategyKey === SUPERTREND_KEY && stSeries) {
      barSignal = signalFromSupertrendBar(stSeries[i]);
    } else if (typeof adapters[strategyKey] === "function") {
      barSignal = (await adapters[strategyKey](bar, i, { candles, cfg, timeframe })) || null;
      // Normalize: HOLD / null → no signal
      if (barSignal?.action === "HOLD") barSignal = null;
    }
    const signalStartMs = Number(cfg?.backtestSignalStartMs ?? 0);
    if (barSignal && signalStartMs > 0 && Number(bar.ts) < signalStartMs) {
      barSignal = null;
    }

    // ── Position management ────────────────────────────────────────────────────
    if (pos) {
      const isLong = pos.side === "BUY";
      const adv = adverseExtreme(bar, isLong);
      const fav = isLong ? bar.high : bar.low;
      const liqStages = pos.liqExitStages ?? null;
      const { hitTp1, hitTp2, hitTP } = resolveLiqRunnerTpHits(pos, bar, isLong, liqStages);
      const hitLiq = isFutures && (isLong ? bar.low <= pos.liqPx : bar.high >= pos.liqPx);
      /** Protective SL sits between entry and liquidation — must win when both are touched. */
      const protectiveSlBeforeLiq =
        pos.sl > 0 && (isLong ? pos.sl > pos.liqPx : pos.sl < pos.liqPx);
      const hitProtectiveSl =
        protectiveSlBeforeLiq && (isLong ? bar.low <= pos.sl : bar.high >= pos.sl);
      pos.mae = Math.min(pos.mae, computePctMove(pos.entryFill, adv, isLong));
      pos.mfe = Math.max(pos.mfe, computePctMove(pos.entryFill, fav, isLong));

      /** Lock SL to breakeven (+ fee buffer) once trade has reached MFE threshold. */
      const beAtMfePct = Number(
        cfg?.backtestBreakevenAtMfePct ?? cfg?.supertrendFuturesBreakevenAtMfePct ?? 0,
      );
      if (beAtMfePct > 0 && pos.mfe >= beAtMfePct && !pos.beLocked && pos.sl > 0) {
        const feeBuf =
          Number(cfg?.backtestBreakevenFeeBufferPct) ||
          (Number(cm.openFeeRate) + Number(cm.closeFeeRate)) * 1.2 ||
          0.001;
        const bePx = liqBreakevenStopPx(pos.entryFill, isLong, feeBuf);
        if (isLong ? bePx > pos.sl : bePx < pos.sl) {
          pos.sl = bePx;
          pos.beLocked = true;
        }
      }

      /** TP1 off + BE on: lock SL to breakeven once price reaches 1R (full size, then aim for TP2). */
      if (pos.liqBeAt1R && !pos.beLocked && liqStages?.beOn !== false && pos.sl > 0) {
        const trigger = Number(pos.liqBeTriggerPx);
        const hit1R =
          trigger > 0 && (isLong ? bar.high >= trigger : bar.low <= trigger);
        if (hit1R) {
          const feeBuf =
            Number(cfg?.backtestBreakevenFeeBufferPct) ||
            (Number(cm.openFeeRate) + Number(cm.closeFeeRate)) * 1.2 ||
            0.001;
          const bePx = liqBreakevenStopPx(pos.entryFill, isLong, feeBuf);
          if (isLong ? bePx > pos.sl : bePx < pos.sl) {
            pos.sl = bePx;
            pos.beLocked = true;
          }
        }
      }

      let exitReason = null;
      let exitPrice = null;
      const hitSLAfterBe =
        pos.sl > 0 && (isLong ? bar.low <= pos.sl : bar.high >= pos.sl);
      const flipBeforeSl = cfg?.trendHtfStFlipExitBeforeSl === true;
      /** When false, hold through opposite Supertrend flips — exit only on SL/TP/trail/liq (higher WR, live must match). */
      const exitOnFlip = cfg?.supertrendFuturesExitOnFlip !== false;

      /** TREND_HTF_ST: opposite ST flip is the primary exit — check before bracket SL. */
      if (
        flipBeforeSl &&
        barSignal &&
        barSignal.action !== "EXIT" &&
        barSignal.action !== pos.side
      ) {
        exitReason = "flip";
        const next = candles[i + 1];
        exitPrice = next
          ? applySlippage(isLong ? "SELL" : "BUY", next.open, cm.slippagePct)
          : applySlippage(isLong ? "SELL" : "BUY", bar.close, cm.slippagePct);
      }

      /**
       * Intra-bar exit priority (no tick data):
       *   1. Liq — only when liquidation is touched and no closer protective SL
       *      also triggered (long: SL above liq; short: SL below liq).
       *   2. TP — fixed take-profit on favorable touch.
       *   3. Trail — advance SL from the favorable extreme first, then test the
       *      adverse extreme vs the tightened stop (live updates trail on mark
       *      before the stop order is evaluated).
       *   4. SL — initial / BE bracket if trail did not exit on this bar.
       */
      if (!exitReason && hitLiq && !hitProtectiveSl) {
        exitReason = "liq";
        exitPrice = pos.liqPx;
      } else if (!exitReason && hitTp1) {
        const frac = Math.min(0.75, Math.max(0.1, Number(pos.partialFrac) || 0.5));
        const closeQty = pos.qty * frac;
        const rawTp1 = clampBracketFillToBar(pos.tp1, bar);
        const exitFillPartial = applySlippage(isLong ? "SELL" : "BUY", rawTp1, cm.slippagePct);
        const breakdownP = tradeBreakdown({
          side: pos.side,
          entryFill: pos.entryFill,
          exitFill: exitFillPartial,
          qty: closeQty,
          leverage: resolvePositionLeverage(pos, cm),
          model: cm,
        });
        const fundingP = isFutures
          ? fundingPaidBetween(pos, fundingRates, pos.entryTs, bar.ts) * frac
          : 0;
        const netPnlP = breakdownP.gross - breakdownP.fees - fundingP;
        equity += netPnlP;
        const entryNotionalP = closeQty * pos.entryFill;
        const marginP =
          pos.marginUsdt != null && Number.isFinite(Number(pos.marginUsdt))
            ? Number(pos.marginUsdt) * frac
            : isFutures && resolvePositionLeverage(pos, cm) > 0
              ? entryNotionalP / resolvePositionLeverage(pos, cm)
              : entryNotionalP;
        trades.push(
          finalizeTradeRecord(pos, {
            tradeNumber: trades.length + 1,
            direction: pos.side,
            entryTs: pos.entryTs,
            entryPrice: pos.entryFill,
            exitTs: bar.ts,
            exitPrice: exitFillPartial,
            qty: closeQty,
            slPrice: pos.sl,
            tpPrice: pos.tp1,
            exitReason: "tp1_partial",
            trailStep: pos.trailStep || 0,
            trailTierLabel: pos.trailTierLabel || null,
            grossPnl: breakdownP.gross,
            fees: breakdownP.fees,
            fundingPaid: fundingP,
            slippageCost:
              closeQty *
              (Math.abs(pos.entryFill * cm.slippagePct) + Math.abs(exitFillPartial * cm.slippagePct)),
            netPnl: netPnlP,
            maePct: pos.mae,
            mfePct: pos.mfe,
            barsHeld: i - pos.entryIdx,
            intelScoreAtEntry: pos.intelAtEntry,
            gateAction: pos.gateAction,
            equityAtEntry: pos.entryEquity ?? equity - netPnlP,
            marginUsdt: marginP,
            leverageCapped: pos.leverageCapped === true,
            allotmentCapped: pos.allotmentCapped === true,
            marginCapUsdt: pos.marginCapUsdt,
            allowedPoolUsdt: pos.allowedPoolUsdt,
          }),
        );
        pos.qty -= closeQty;
        pos.partialTaken = true;
        /** After 1R partial, protect runner with BE when stage config allows it. */
        if (pos.partialTp && liqStages?.beOn !== false) {
          const feeBuf =
            Number(cfg?.backtestBreakevenFeeBufferPct) ||
            (Number(cm.openFeeRate) + Number(cm.closeFeeRate)) * 1.2 ||
            0.001;
          const bePx = liqBreakevenStopPx(pos.entryFill, isLong, feeBuf);
          if (isLong ? bePx > pos.sl : bePx < pos.sl) {
            pos.sl = bePx;
            pos.beLocked = true;
          }
        }
      } else if (!exitReason && hitTp2) {
        const initQty = Number(pos.initialQty) > 0 ? Number(pos.initialQty) : pos.qty;
        const frac = Math.min(0.75, Math.max(0.05, Number(pos.tp2PartialFrac) || 0.25));
        const closeQty = Math.min(pos.qty, initQty * frac);
        const rawTp2 = clampBracketFillToBar(pos.tp, bar);
        const exitFillPartial = applySlippage(isLong ? "SELL" : "BUY", rawTp2, cm.slippagePct);
        const breakdownP = tradeBreakdown({
          side: pos.side,
          entryFill: pos.entryFill,
          exitFill: exitFillPartial,
          qty: closeQty,
          leverage: resolvePositionLeverage(pos, cm),
          model: cm,
        });
        const fundingP = isFutures
          ? fundingPaidBetween(pos, fundingRates, pos.entryTs, bar.ts) * (closeQty / initQty)
          : 0;
        const netPnlP = breakdownP.gross - breakdownP.fees - fundingP;
        equity += netPnlP;
        const entryNotionalP = closeQty * pos.entryFill;
        const marginP =
          pos.marginUsdt != null && Number.isFinite(Number(pos.marginUsdt))
            ? Number(pos.marginUsdt) * (closeQty / initQty)
            : isFutures && resolvePositionLeverage(pos, cm) > 0
              ? entryNotionalP / resolvePositionLeverage(pos, cm)
              : entryNotionalP;
        trades.push(
          finalizeTradeRecord(pos, {
            tradeNumber: trades.length + 1,
            direction: pos.side,
            entryTs: pos.entryTs,
            entryPrice: pos.entryFill,
            exitTs: bar.ts,
            exitPrice: exitFillPartial,
            qty: closeQty,
            slPrice: pos.sl,
            tpPrice: pos.tp,
            exitReason: "tp2_partial",
            trailStep: pos.trailStep || 0,
            trailTierLabel: pos.trailTierLabel || null,
            grossPnl: breakdownP.gross,
            fees: breakdownP.fees,
            fundingPaid: fundingP,
            slippageCost:
              closeQty *
              (Math.abs(pos.entryFill * cm.slippagePct) + Math.abs(exitFillPartial * cm.slippagePct)),
            netPnl: netPnlP,
            maePct: pos.mae,
            mfePct: pos.mfe,
            barsHeld: i - pos.entryIdx,
            intelScoreAtEntry: pos.intelAtEntry,
            gateAction: pos.gateAction,
            equityAtEntry: pos.entryEquity ?? equity - netPnlP,
            marginUsdt: marginP,
            leverageCapped: pos.leverageCapped === true,
            allotmentCapped: pos.allotmentCapped === true,
            marginCapUsdt: pos.marginCapUsdt,
            allowedPoolUsdt: pos.allowedPoolUsdt,
          }),
        );
        pos.qty -= closeQty;
        pos.tp2PartialTaken = true;
      } else if (!exitReason && hitTP) {
        exitReason = pos.partialTaken ? "tp2" : "tp";
        exitPrice = pos.tp;
      }

      const trailAfterTp2 = resolveTrailOnlyAfterTp2Fill(cfg);
      const trailGateOk = !(
        (trailAfterTp2 && !pos.tp2PartialTaken) ||
        (cfg?.trailOnlyAfterPartialFill === true &&
          pos.partialTp === true &&
          pos.partialTaken !== true &&
          !trailAfterTp2)
      );
      if (!exitReason && trailEnabled && trailGateOk) {
        const stBar = stSeries ? stSeries[i] : null;
        const atrInfo = atrSeries[i];
        const atrPct =
          atrInfo && Number.isFinite(atrInfo.atr) && bar.close > 0 ? atrInfo.atr / bar.close : null;
        const trailOpts = pos.trailOpts || resolveTrailingOpts(cfg, cm, atrPct);
        const advRes = advanceTrailForBar({
          pos,
          bar,
          stBar,
          opts: trailOpts,
          mode: futuresTrailMode,
          leverage: resolvePositionLeverage(pos, cm),
        });
        if (advRes.advanced && advRes.proposedSl != null) {
          pos.sl = advRes.proposedSl;
          pos.trailStep = advRes.trailStep;
          pos.trailTierLabel = advRes.tierLabel;
          const breached = isLong ? bar.low <= pos.sl : bar.high >= pos.sl;
          if (breached) {
            exitReason = "trail";
            exitPrice = pos.sl;
          }
        } else if (advRes.trailStep != null) {
          pos.trailStep = advRes.trailStep;
        }
      }

      if (!exitReason && hitSLAfterBe) {
        exitReason = pos.beLocked ? "be" : "sl";
        exitPrice = pos.sl;
      }

      /** Order-flow guide exit: two consecutive bars delta against position. */
      if (
        !exitReason &&
        pos.ofMonitor &&
        cfg?.intradayOfExitOnDeltaAgainst !== false &&
        orderFlowExitSignal(candles, i, pos.side, cfg, pos.entryIdx)
      ) {
        exitReason = "of_exit";
        const next = candles[i + 1];
        exitPrice = next
          ? applySlippage(isLong ? "SELL" : "BUY", next.open, cm.slippagePct)
          : applySlippage(isLong ? "SELL" : "BUY", bar.close, cm.slippagePct);
      }

      // Close-only exit — adapters can emit action:"EXIT" to close the current
      // position without opening a new one (used by TREND_PULLBACK for RSI recovery exits).
      if (!exitReason && barSignal && barSignal.action === "EXIT") {
        exitReason = "signal_exit";
        const next = candles[i + 1];
        exitPrice = next
          ? applySlippage(isLong ? "SELL" : "BUY", next.open, cm.slippagePct)
          : applySlippage(isLong ? "SELL" : "BUY", bar.close, cm.slippagePct);
      }

      // Signal-based flip exit (when not already handled flip-before-SL above).
      if (
        !exitReason &&
        !flipBeforeSl &&
        exitOnFlip &&
        barSignal &&
        barSignal.action !== "EXIT" &&
        barSignal.action !== pos.side
      ) {
        exitReason = "flip";
        const next = candles[i + 1];
        exitPrice = next
          ? applySlippage(isLong ? "SELL" : "BUY", next.open, cm.slippagePct)
          : applySlippage(isLong ? "SELL" : "BUY", bar.close, cm.slippagePct);
      }

      const deadTradeBars = Math.max(
        0,
        Math.floor(
          Number(cfg?.intradayLiqDeadTradeExitBars ?? cfg?.liqMapDeadTradeExitBars ?? 0),
        ),
      );
      const deadTradeMinMfeR = Math.max(
        0,
        Number(cfg?.intradayLiqDeadTradeMinMfeR ?? cfg?.liqMapDeadTradeMinMfeR ?? 0),
      );
      const deadTradeMaxLossR = Math.max(
        0,
        Number(cfg?.intradayLiqDeadTradeMaxLossR ?? cfg?.liqMapDeadTradeMaxLossR ?? 0.55),
      );
      const deadTradeStrategies = new Set(["LIQUIDITY_MAP", "SR_INTRADAY", "INTRADAY_PRO"]);
      if (
        !exitReason &&
        deadTradeStrategies.has(strategyKey) &&
        deadTradeBars > 0 &&
        deadTradeMinMfeR > 0 &&
        deadTradeMaxLossR > 0 &&
        pos.deadTradeTightened !== true &&
        pos.partialTaken !== true &&
        i - pos.entryIdx >= deadTradeBars
      ) {
        const initialRiskFrac =
          Number(pos.initialSl) > 0 && Number(pos.entryFill) > 0
            ? Math.abs(Number(pos.entryFill) - Number(pos.initialSl)) / Number(pos.entryFill)
            : 0;
        const mfeR = initialRiskFrac > 0 ? Number(pos.mfe) / initialRiskFrac : 0;
        if (mfeR < deadTradeMinMfeR) {
          const riskPx = Math.abs(Number(pos.entryFill) - Number(pos.initialSl));
          const compressedSl = isLong
            ? Number(pos.entryFill) - deadTradeMaxLossR * riskPx
            : Number(pos.entryFill) + deadTradeMaxLossR * riskPx;
          if (compressedSl > 0 && (isLong ? compressedSl > pos.sl : compressedSl < pos.sl)) {
            pos.sl = compressedSl;
            pos.deadTradeTightened = true;
          }
        }
      }

      /**
       * Intraday time stop (lowest priority — only if no SL/TP/trail/flip fired this
       * bar). Forces intraday trades to close within a bounded horizon so a single
       * runner can't ride for weeks and starve every subsequent setup.
       */
      if (!exitReason && pos.maxHoldBars > 0 && i - pos.entryIdx >= pos.maxHoldBars) {
        exitReason = "time_stop";
        exitPrice = bar.close; // finalizer applies slippage once for non-flip exits
      }

      if (exitReason) {
        const bracketExit =
          exitReason === "sl" || exitReason === "trail" || exitReason === "tp";
        const rawExitPx = bracketExit ? clampBracketFillToBar(exitPrice, bar) : exitPrice;
        const exitFill =
          exitReason === "flip" || exitReason === "signal_exit"
            ? exitPrice // already has slippage applied above
            : applySlippage(isLong ? "SELL" : "BUY", rawExitPx, cm.slippagePct);
        const breakdown = tradeBreakdown({
          side: pos.side,
          entryFill: pos.entryFill,
          exitFill,
          qty: pos.qty,
          leverage: resolvePositionLeverage(pos, cm),
          model: cm,
        });
        const fundingPaid = isFutures
          ? fundingPaidBetween(pos, fundingRates, pos.entryTs, bar.ts)
          : 0;
        const slippageCost =
          Math.abs(pos.qty) *
          (Math.abs(pos.entryFill * cm.slippagePct) + Math.abs(exitFill * cm.slippagePct));
        const netPnl = breakdown.gross - breakdown.fees - fundingPaid;
        equity += netPnl;
        const entryNotional = Math.abs(pos.qty) * pos.entryFill;
        const marginUsdt =
          pos.marginUsdt != null && Number.isFinite(Number(pos.marginUsdt))
            ? Number(pos.marginUsdt)
            : isFutures && resolvePositionLeverage(pos, cm) > 0
              ? entryNotional / resolvePositionLeverage(pos, cm)
              : entryNotional;
        trades.push(
          finalizeTradeRecord(pos, {
            tradeNumber: trades.length + 1,
            direction: pos.side,
            entryTs: pos.entryTs,
            entryPrice: pos.entryFill,
            exitTs: bar.ts,
            exitPrice: exitFill,
            qty: pos.qty,
            slPrice: pos.sl,
            tpPrice: pos.tp,
            exitReason,
            trailStep: pos.trailStep || 0,
            trailTierLabel: pos.trailTierLabel || null,
            grossPnl: breakdown.gross,
            fees: breakdown.fees,
            fundingPaid,
            slippageCost,
            netPnl,
            maePct: pos.mae,
            mfePct: pos.mfe,
            barsHeld: i - pos.entryIdx,
            intelScoreAtEntry: pos.intelAtEntry,
            gateAction: pos.gateAction,
            equityAtEntry: pos.entryEquity ?? equity - netPnl,
            marginUsdt,
            leverageCapped: pos.leverageCapped === true,
            allotmentCapped: pos.allotmentCapped === true,
            marginCapUsdt: pos.marginCapUsdt,
            allowedPoolUsdt: pos.allowedPoolUsdt,
          }),
        );
        pos = null;
      }
    }

    // ── Pending-breakout confirmation (live bot parity) ─────────────────────
    /**
     * `fromConfirmedBreakout` flags that the current barSignal was synthesised from a
     * confirmed pending breakout. The entry block must NOT re-arm another breakout
     * defer for the same signal — the confirmation itself IS the entry trigger.
     */
    let fromConfirmedBreakout = false;
    if (!pos && pendingBreakout) {
      const pb = pendingBreakout;
      const confirmed =
        pb.side === "BUY" ? bar.close > pb.signalHi : bar.close < pb.signalLo;
      pb.barsLeft--;
      if (!confirmed && pb.barsLeft > 0) {
        // Still waiting — try next bar without opening a position.
        equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
        if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
        continue;
      }
      if (!confirmed) {
        // Expired without confirmation — discard.
        pendingBreakout = null;
      } else {
        // Confirmed: open on next bar (fall through to entry block below with synthetic signal).
        barSignal = { action: pb.side };
        confirmedBreakoutFlipIdx = Number.isFinite(pb.flipIdx) ? pb.flipIdx : i;
        pendingBreakout = null;
        fromConfirmedBreakout = true;
      }
    }

    // ── Entry ─────────────────────────────────────────────────────────────────
    if (!pos && barSignal && barSignal.action !== "EXIT" && i + 1 < candles.length) {
      // Spot: no shorting.
      if (barSignal.action === "SELL" && !isFutures) {
        equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
        if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
        continue;
      }

      // Max daily loss guard — mirrors live bot's daily risk limit.
      if (maxDailyLossEnabled) {
        const dailyLoss = dayStartEquity - equity;
        const limit = maxDailyLossIsUsdt ? maxDailyLossVal : dayStartEquity * (maxDailyLossVal / 100);
        if (dailyLoss >= limit) {
          riskOverlayReplay.dailyCap++;
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      }

      // ── Institutional risk overlay — halt NEW entries on risk breach ─────────
      {
        let blocked = null;
        // Account-DD kill switch.
        if (killSwitchDdPct > 0 && peakEquity > 0 && ((peakEquity - equity) / peakEquity) * 100 >= killSwitchDdPct) {
          blocked = "killSwitch";
        }
        // Weekly drawdown cap.
        if (!blocked && weeklyDdCapPct > 0 && weekStartEquity > 0 && ((weekStartEquity - equity) / weekStartEquity) * 100 >= weeklyDdCapPct) {
          blocked = "weeklyCap";
        }
        // Consecutive-loss cooldown — stop for the rest of the UTC day after N losses in a row.
        if (!blocked && consecLossLimit > 0 && trades.length) {
          let tcl = 0;
          let lastExitTs = 0;
          for (let k = trades.length - 1; k >= 0; k--) {
            if (trades[k].exitReason === "tp1_partial") continue; // partial leg is not a distinct outcome
            if (Number(trades[k].netPnl ?? 0) < 0) {
              if (!lastExitTs) lastExitTs = Number(trades[k].exitTs ?? 0);
              tcl++;
            } else break;
          }
          if (tcl >= consecLossLimit) {
            const lastLossDay = Math.floor(lastExitTs / 86400000) * 86400000;
            if (lastLossDay === barDayMs) blocked = "consecCooldown";
          }
        }
        if (blocked) {
          riskOverlayReplay[blocked]++;
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      }

      // ── Signal-quality gates (live-parity) ──────────────────────────────────

      // Breakout confirm: on a fresh signal bar, defer — wait up to breakoutMaxBars for the
      // next bar(s) to close beyond signal high (BUY) or below signal low (SELL).
      // Skip re-arm when the barSignal came from a confirmed pending breakout (fromConfirmedBreakout),
      // otherwise we loop forever: confirm → re-arm → confirm → ...
      if (breakoutConfirm && !pendingBreakout && !fromConfirmedBreakout) {
        pendingBreakout = {
          side: barSignal.action,
          signalHi: bar.high,
          signalLo: bar.low,
          barsLeft: breakoutMaxBars,
          flipIdx: i,
        };
        equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
        if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
        continue;
      }

      // Big-move entry gate (indicator) — ST-only filter for T1+ expected move; not intelligence gate.
      if (bigMoveCfg && strategyKey === SUPERTREND_KEY && stSeries) {
        const atrInfoBm = atrSeries[i];
        const slDistBm =
          fixedSlPct > 0
            ? fixedSlPct
            : atrInfoBm?.atr && bar.close > 0
              ? Math.max(0.0005, (atrInfoBm.atr / bar.close) * 1.25)
              : 0.012;
        const flipIdxForGate = fromConfirmedBreakout && confirmedBreakoutFlipIdx >= 0 ? confirmedBreakoutFlipIdx : i;
        const bm = evaluateSupertrendBigMoveGate({
          candles,
          idx: flipIdxForGate,
          barSignal,
          stSeries,
          lastFlipIdx: flipIdxForGate,
          slDistancePct: slDistBm,
          opts: bigMoveCfg,
        });
        if (!bm.pass) {
          bigMoveReplay.veto++;
          bigMoveReplay.reasons[bm.reason] = (bigMoveReplay.reasons[bm.reason] || 0) + 1;
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
        bigMoveReplay.pass++;
      }

      // 4H Supertrend confirmation filter — block entries where 4H ST disagrees.
      // Order-flow solo uses VP premium/discount as HTF filter (guide Layer 1), not ST.
      const ofSoloEntry = String(barSignal?.reason ?? "").startsWith("ipro_of_");
      if (htf4hCtx && !ofSoloEntry) {
        const htf4h = evaluateHtf4hFilter(htf4hCtx, bar, barSignal.action);
        if (!htf4h.pass) {
          htf4hReplay.veto++;
          htf4hReplay.reasons[htf4h.reason] = (htf4hReplay.reasons[htf4h.reason] || 0) + 1;
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
        htf4hReplay.pass++;
      }

      // Move-quality gate — exact same evaluateSupertrendMoveQuality as live bot.
      if (moveQualityGate && moveQualityOpts && !bigMoveCfg) {
        const latest = latestIndicatorsAt(i);
        const atrInfoMq = atrSeries[i];
        const slDistPct =
          fixedSlPct > 0
            ? fixedSlPct
            : atrInfoMq?.atr && bar.close > 0
              ? Math.max(0.0005, (atrInfoMq.atr / bar.close) * 1.25)
              : 0.002;
        const sliceMq = candles.slice(Math.max(0, i - INDICATOR_LOOKBACK + 1), i + 1);
        const mqResult = evaluateSupertrendMoveQuality({
          candles: sliceMq,
          latest,
          openingSide: barSignal.action,
          slDistancePct: slDistPct,
          options: moveQualityOpts,
        });
        if (!mqResult.pass) {
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      }

      // Signal-strength gate — mirrors live `signalStrengthBlocksOpen`.
      // The live bot computes a "composite strength" from its AI pipeline.
      // In backtesting we derive a proxy from the indicator snapshot (ADX + RSI momentum).
      if (signalStrengthEnabled && !bigMoveCfg) {
        const latest = latestIndicatorsAt(i);
        const adxVal = Number(latest?.adx_14 ?? 0);
        const rsiVal = Number(latest?.rsi_14 ?? 50);
        const rsiSlope = latest?.rsi_14_prev != null ? rsiVal - Number(latest.rsi_14_prev) : 0;
        // Map ADX 0→100 to 0→80 strength, add RSI momentum (BUY: rsi > 50 and rising; SELL: rsi < 50 and falling)
        const rsiBonus = barSignal.action === "BUY"
          ? Math.max(0, (rsiVal - 50) / 50 * 15 + (rsiSlope > 0 ? 5 : 0))
          : Math.max(0, (50 - rsiVal) / 50 * 15 + (rsiSlope < 0 ? 5 : 0));
        const proxyStrength = Math.min(100, adxVal * 0.8 + rsiBonus);
        if (proxyStrength < signalStrengthOpenMin) {
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      }

      // Market decision gate — uses the pre-computed verdict series built before the loop.
      // null means warmup not yet met (< 202 bars) → pass through, same as live bot.
      if (marketDecisionEnabled && mdVerdicts) {
        const verdict = mdVerdicts[i];
        if (verdict !== null && verdict !== "ALLOW" && verdict !== "BYPASS") {
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      }

      // Intelligence gate veto / size scaling
      let gateAction = "pass";
      let intelAtEntry = 50;
      // Per-signal risk scaling — strategy adapters can attach a `riskScale` to their
      // signal to scale position size up (e.g. 1.5× for high-confluence liq entries)
      // or down (e.g. 0.5× for supplemental lower-conviction trades).
      let sizeMult = Number(barSignal.riskScale ?? 1);
      if (!Number.isFinite(sizeMult) || sizeMult <= 0) sizeMult = 1;
      if (gateMode === "approx" && typeof gateFn === "function") {
        const gate =
          typeof gateFn === "function"
            ? gateFn(bar.ts, barSignal.action) || { intelScore: 50, action: "pass", sizeMult: 1 }
            : { intelScore: 50, action: "pass", sizeMult: 1 };
        gateAction = gate.action;
        intelAtEntry = gate.intelScore;
        // Multiply gate sizeMult with per-signal riskScale so both can coexist.
        sizeMult *= (Number(gate.sizeMult) || 1);
        noteGateReplay(gateReplay, gateAction, intelAtEntry);
        if (gateAction === "vetoed") {
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
      } else {
        gateReplay.noGate++;
      }

      if (confirmationCtx) {
        const stBarForGate = stSeries ? stSeries[i] : null;
        const conf = evaluateSupertrendConfirmationGate(
          confirmationCtx,
          bar,
          i,
          barSignal.action,
          stBarForGate,
        );
        if (!conf.pass) {
          confirmationReplay.veto++;
          confirmationReplay.reasons[conf.reason] =
            (confirmationReplay.reasons[conf.reason] || 0) + 1;
          equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
          if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
          continue;
        }
        confirmationReplay.pass++;
      }

      const entryQuality =
        strategyKey === TREND_HTF_ST_KEY || strategyKey === ELITE_HTF_KEY
          ? evaluateTrendHtfStRegime(candles, i, barSignal.action, cfg)
          : null;

      if (
        entryQuality &&
        (isTrendHtfStRegimeGateEnabled(cfg) || isTrendHtfStSurgicalLossFilterEnabled(cfg)) &&
        entryQuality.allowEntry === false
      ) {
        equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
        if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
        continue;
      }

      const slLegsOn = bracketSlLegsEnabled(cfg, barSignal);
      const tpLegsOn = bracketTpLegsEnabled(cfg, barSignal);

      const next = candles[i + 1];
      /** Fib signals fire at bar close in live — optional same-bar fill (default on when fib brackets set). */
      const fibSameBarEntry =
        barSignal?.fibBrackets?.slPct > 0 && cfg?.intradayFibEntryAtSignalClose !== false;
      const liqSameBarEntry =
        barSignal?.liqBrackets?.slPct > 0 && cfg?.intradayLiqEntryAtSignalClose !== false;
      const ofSameBarEntry =
        barSignal?.ofBrackets?.slPct > 0 && cfg?.intradayOfEntryAtSignalClose !== false;
      /** Live Supertrend Elite fills at signal bar close (market on candle close), not next bar. */
      const eliteSameBarEntry =
        strategyKey === SUPERTREND_ELITE_KEY || strategyKey === "UNIFIED_ELITE";
      const fillBar =
        fibSameBarEntry || liqSameBarEntry || ofSameBarEntry || eliteSameBarEntry ? bar : next;
      let fillPx =
        !(fibSameBarEntry || liqSameBarEntry || ofSameBarEntry || eliteSameBarEntry) && next
          ? next.open
          : fillBar.close;
      const liqLimitEntryPx = Number(barSignal?.liqBrackets?.limitEntryPrice ?? barSignal?.liqBrackets?.entryPrice);
      if (
        liqSameBarEntry &&
        Number.isFinite(liqLimitEntryPx) &&
        liqLimitEntryPx > 0 &&
        fillBar &&
        Number(fillBar.low) <= liqLimitEntryPx &&
        liqLimitEntryPx <= Number(fillBar.high)
      ) {
        fillPx = liqLimitEntryPx;
      }
      const entryFill = applySlippage(barSignal.action, fillPx, cm.slippagePct);
      const atrInfoEntry = atrSeries[i];
      const atrPctEntry =
        atrInfoEntry && Number.isFinite(atrInfoEntry.atr) && bar.close > 0
          ? atrInfoEntry.atr / bar.close
          : null;
      let stopPct = computeStopPct({
        cfg,
        fixedSlPct: slLegsOn ? fixedSlPct : 0,
        isFutures,
        atrPct: atrPctEntry,
        allowFallback: slLegsOn,
      });
      let tpPct = tpLegsOn ? fixedTpPct : 0;
      if (entryQuality?.brackets && isTrendHtfStRegimeGateEnabled(cfg)) {
        if (slLegsOn) stopPct = entryQuality.brackets.slPct;
        if (tpLegsOn) tpPct = entryQuality.brackets.tpPct;
      }
      if (barSignal?.vpBrackets?.slPct > 0 && cfg.intradayVpBrackets === true) {
        if (slLegsOn) stopPct = barSignal.vpBrackets.slPct;
        if (tpLegsOn && fixedBracketTpEnabled(cfg)) {
          tpPct = barSignal.vpBrackets.tpPct ?? tpPct;
        }
      }
      let fibStructureSl = null;
      let fibStructureTp = null;
      if (barSignal?.fibBrackets?.slPct > 0) {
        const fibBr = resolveFibEntryBrackets(cfg, barSignal, entryFill, barSignal.action);
        if (fibBr) {
          if (slLegsOn) stopPct = fibBr.slPct;
          if (tpLegsOn) tpPct = fibBr.tpPct ?? tpPct;
          if (slLegsOn && fibBr.slPrice > 0) fibStructureSl = fibBr.slPrice;
          if (tpLegsOn && fibBr.tpPrice > 0) fibStructureTp = fibBr.tpPrice;
        } else {
          if (slLegsOn) stopPct = barSignal.fibBrackets.slPct;
          if (tpLegsOn) tpPct = barSignal.fibBrackets.tpPct ?? tpPct;
        }
      }
      let liqStructureSl = null;
      let liqStructureTp = null;
      let liqStructureTp1 = null;
      let liqPartial = false;
      let liqPartialFrac = 0.5;
      let liqTp2PartialFrac = 0;
      let liqExitStages = null;
      let liqBeAt1R = false;
      let liqBeTriggerPx = 0;
      if (barSignal?.ofBrackets?.slPct > 0) {
        const ofBr = resolveOrderFlowEntryBrackets(cfg, barSignal, entryFill, barSignal.action);
        if (ofBr) {
          if (slLegsOn) stopPct = ofBr.slPct;
          if (tpLegsOn) tpPct = ofBr.tp2Pct ?? tpPct;
          const legs = mapOrderFlowEntryLegs(ofBr, cfg);
          if (legs) {
            if (slLegsOn) liqStructureSl = legs.slPrice;
            if (tpLegsOn) {
              liqStructureTp = legs.tp;
              liqStructureTp1 = legs.tp1;
              liqPartial = legs.partialTp;
              liqPartialFrac = legs.partialFrac;
              liqTp2PartialFrac = legs.tp2PartialFrac ?? 0;
              liqExitStages = legs.stages;
              liqBeAt1R = legs.beAt1R;
              liqBeTriggerPx = legs.beTriggerPx;
            }
          }
        } else if (slLegsOn) {
          stopPct = barSignal.ofBrackets.slPct;
          if (tpLegsOn) tpPct = barSignal.ofBrackets.tp2Pct ?? barSignal.ofBrackets.tpPct ?? tpPct;
        }
      } else if (barSignal?.liqBrackets?.slPct > 0) {
        const liqBr = resolveLiquidityEntryBrackets(cfg, barSignal, entryFill, barSignal.action);
        if (liqBr) {
          if (slLegsOn) stopPct = liqBr.slPct;
          if (tpLegsOn) tpPct = liqBr.tpPct ?? tpPct;
          const legs = mapLiquidityEntryLegs(liqBr, cfg);
          if (legs) {
            if (slLegsOn) liqStructureSl = legs.slPrice;
            if (tpLegsOn) {
              liqStructureTp = legs.tp;
              liqStructureTp1 = legs.tp1;
              liqPartial = legs.partialTp;
              liqPartialFrac = legs.partialFrac;
              liqTp2PartialFrac = legs.tp2PartialFrac ?? 0;
              liqExitStages = legs.stages;
              liqBeAt1R = legs.beAt1R;
              liqBeTriggerPx = legs.beTriggerPx;
            }
          }
        } else {
          if (slLegsOn) stopPct = barSignal.liqBrackets.slPct;
          if (tpLegsOn) tpPct = barSignal.liqBrackets.tpPct ?? tpPct;
        }
      }
      if (!slLegsOn) {
        stopPct = 0;
        fibStructureSl = null;
        liqStructureSl = null;
        liqBeAt1R = false;
      }
      if (!tpLegsOn) {
        tpPct = 0;
        fibStructureTp = null;
        liqStructureTp = null;
        liqStructureTp1 = null;
        liqPartial = false;
        liqExitStages = null;
      }
      if (barSignal?.sizeMult > 1 && Number.isFinite(barSignal.sizeMult)) {
        sizeMult *= barSignal.sizeMult;
      }
      const structureSl = fibStructureSl ?? liqStructureSl;
      const structureTp = fibStructureTp ?? liqStructureTp;
      const sl =
        structureSl != null && structureSl > 0
          ? structureSl
          : stopPct > 0
            ? barSignal.action === "BUY"
              ? entryFill * (1 - stopPct)
              : entryFill * (1 + stopPct)
            : 0;
      const sizingSl = resolveSizingStopPrice({
        entryFill,
        exitSl: sl,
        side: barSignal.action,
        cfg,
      });
      const tp =
        structureTp != null && structureTp > 0
          ? structureTp
          : tpPct > 0
            ? barSignal.action === "BUY"
              ? entryFill * (1 + tpPct)
              : entryFill * (1 - tpPct)
            : 0;
      // Risk-overlay sizing: riskScale dial × vol-target (referenceATR%/currentATR%).
      let riskMult = riskScale;
      if (volTargetEnabled && atrPctEntry > 0) {
        const vtm = volTargetAtrPct / atrPctEntry;
        riskMult *= Math.max(volTargetMinMult, Math.min(volTargetMaxMult, vtm));
      }
      const sizeMultFinal = sizeMult * riskMult;
      const openMarginUsdt =
        pos && String(pos.symbol || symbol).toUpperCase() === String(symbol || cfg?.symbol || "").toUpperCase()
          ? Number(pos.marginUsdt) > 0
            ? Number(pos.marginUsdt)
            : (Math.abs(pos.qty) * pos.entryFill) / Math.max(1, resolvePositionLeverage(pos, cm))
          : 0;
      const sizing = computeEntryQtyDetailed({
        equity,
        entryFill,
        sl: sizingSl,
        cfg,
        cm,
        isFutures,
        sizeMult: sizeMultFinal,
        symbol: String(symbol || cfg?.symbol || ""),
        openMarginUsdt,
      });
      const qty = sizing.qty;
      const entryLev = sizing.effectiveLeverage ?? cm.leverage;
      const liqPx = isFutures
        ? liquidationPrice({ side: barSignal.action, entryFill, leverage: entryLev })
        : barSignal.action === "BUY"
          ? 0
          : Infinity;
      const vpSetup =
        barSignal.vpSetup ??
        (typeof barSignal.reason === "string" && barSignal.reason.startsWith("vp_")
          ? barSignal.reason.slice(3)
          : null);
      const sameBarEntry =
        fibSameBarEntry || liqSameBarEntry || ofSameBarEntry || eliteSameBarEntry;
      pos = {
        side: barSignal.action,
        symbol: String(symbol || cfg?.symbol || ""),
        entryFill,
        entryTs: fillBar.ts,
        entryIdx: sameBarEntry ? i : i + 1,
        qty,
        sl,
        tp,
        trailStep: 0,
        extremePx: entryFill,
        trailTierLabel: null,
        trailOpts: trailEnabled
          ? {
              ...resolveTrailingOpts(cfg, cm, atrPctEntry),
              ...(barSignal?.liqBrackets?.trailOverrides && typeof barSignal.liqBrackets.trailOverrides === "object"
                ? barSignal.liqBrackets.trailOverrides
                : {}),
            }
          : null,
        entryEquity: equity,
        marginUsdt: sizing.marginUsdt,
        effectiveLeverage: sizing.effectiveLeverage ?? cm.leverage,
        leverageCapped: sizing.leverageCapped,
        allotmentCapped: sizing.allotmentCapped,
        marginCapUsdt: sizing.marginCapUsdt,
        allowedPoolUsdt: sizing.allowedPoolUsdt,
        intelAtEntry,
        gateAction,
        sizeMult: sizeMultFinal,
        // Initial (entry-time) stop + dollar risk — preserved for honest R-multiple
        // stats even after the live stop is trailed to breakeven. When exit SL is
        // off (trail-only Elite), use the sizing stop (default 1% or backtestSizingStopPct).
        initialSl: sl > 0 ? sl : sizingSl,
        initialRiskUsd: Math.abs(entryFill - sizingSl) * qty,
        regime: barSignal?.regime ?? null,
        situation: barSignal?.situation ?? null,
        playbook: barSignal?.playbook ?? null,
        trigger: barSignal?.trigger ?? null,
        mae: 0,
        mfe: 0,
        liqPx,
        beLocked: false,
        entryQuality,
        vpSetup,
        entryReason: barSignal.reason ?? null,
        liqContext: barSignal?.liqBrackets
          ? {
              levelType: barSignal.liqBrackets.levelType,
              level: barSignal.liqBrackets.level,
              sweepWick: barSignal.liqBrackets.sweepWick,
              opposingLevel: barSignal.liqBrackets.opposingLevel,
              liqQuality: barSignal.liqBrackets.liqQuality,
              rr: barSignal.liqBrackets.rr,
              partialTp: liqPartial,
              tp1Price: liqStructureTp1 > 0 ? liqStructureTp1 : null,
              smcMeta: barSignal.smcMeta ?? null,
              techniques: barSignal.techniques ?? null,
              tokyoMeta: barSignal.liqBrackets.tokyoMeta ?? null,
              dynamicExitPolicy: barSignal.liqBrackets.mapMeta?.dynamicExitPolicy ?? null,
            }
          : null,
        partialTp: liqPartial,
        tp1: liqStructureTp1 ?? 0,
        partialFrac: liqPartialFrac,
        tp2PartialFrac: liqTp2PartialFrac,
        initialQty: qty,
        partialTaken: false,
        tp2PartialTaken: false,
        liqExitStages,
        liqBeAt1R,
        liqBeTriggerPx,
        maxHoldBars: resolveMaxHoldBars(cfg),
        ofMonitor: Boolean(barSignal?.ofBrackets || barSignal?.ofMeta),
      };
      if (!sameBarEntry) {
        i++; // bar[i+1] is the fill bar — skip it so we don't re-signal on the entry bar
      }
    }

    equityCurve.push({ ts: bar.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
    if (onProgress && candles.length) reportProgress(i, candles.length, equity, bar.ts, onProgress);
  }

  // ── Force-close any open position at session end ───────────────────────────
  if (pos) {
    const isLong = pos.side === "BUY";
    const last = candles[candles.length - 1];
    const exitFill = applySlippage(isLong ? "SELL" : "BUY", last.close, cm.slippagePct);
    const breakdown = tradeBreakdown({
      side: pos.side,
      entryFill: pos.entryFill,
      exitFill,
      qty: pos.qty,
      leverage: resolvePositionLeverage(pos, cm),
      model: cm,
    });
    const fundingPaid = cm.isFutures
      ? fundingPaidBetween(pos, fundingRates, pos.entryTs, last.ts)
      : 0;
    const netPnl = breakdown.gross - breakdown.fees - fundingPaid;
    equity += netPnl;
    const entryNotionalEnd = Math.abs(pos.qty) * pos.entryFill;
    const marginUsdtEnd =
      pos.marginUsdt != null && Number.isFinite(Number(pos.marginUsdt))
        ? Number(pos.marginUsdt)
        : cm.isFutures && resolvePositionLeverage(pos, cm) > 0
          ? entryNotionalEnd / resolvePositionLeverage(pos, cm)
          : entryNotionalEnd;
    trades.push(
      finalizeTradeRecord(pos, {
        tradeNumber: trades.length + 1,
        direction: pos.side,
        entryTs: pos.entryTs,
        entryPrice: pos.entryFill,
        exitTs: last.ts,
        exitPrice: exitFill,
        qty: pos.qty,
        slPrice: pos.sl,
        tpPrice: pos.tp,
        exitReason: "session_end",
        trailStep: pos.trailStep || 0,
        trailTierLabel: pos.trailTierLabel || null,
        grossPnl: breakdown.gross,
        fees: breakdown.fees,
        fundingPaid,
        slippageCost: Math.abs(pos.qty) * Math.abs(pos.entryFill * cm.slippagePct + exitFill * cm.slippagePct),
        netPnl,
        maePct: pos.mae,
        mfePct: pos.mfe,
        barsHeld: candles.length - 1 - pos.entryIdx,
        intelScoreAtEntry: pos.intelAtEntry,
        gateAction: pos.gateAction,
        equityAtEntry: pos.entryEquity ?? equity - netPnl,
        marginUsdt: marginUsdtEnd,
        leverageCapped: pos.leverageCapped === true,
        allotmentCapped: pos.allotmentCapped === true,
        marginCapUsdt: pos.marginCapUsdt,
        allowedPoolUsdt: pos.allowedPoolUsdt,
      }),
    );
    equityCurve.push({ ts: last.ts, equity, drawdownPct: drawdownAt(equityCurve, equity) });
  }

  return {
    trades,
    equityCurve,
    finalEquity: equity,
    costModel: cm,
    tfMs,
    gateReplay: finalizeGateReplay(gateReplay),
    confirmationReplay,
    bigMoveReplay,
    htf4hReplay,
    riskOverlayReplay,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute per-bar True Range and a simple rolling average (same period as Supertrend ATR)
 * for signal-quality gate use. Returns an array parallel to `candles`.
 */
function computeSimpleAtr(candles, period) {
  const p = Math.max(2, period);
  const result = new Array(candles.length).fill(null);
  const trValues = [];
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : bar.open;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    trValues.push(tr);
    if (i < p - 1) continue;
    const slice = trValues.slice(-p);
    const atr = slice.reduce((s, v) => s + v, 0) / slice.length;
    // rolling average of ATR over the same lookback to detect ATR expansion
    const avgSlice = trValues.slice(Math.max(0, trValues.length - p * 3), -1);
    const atrAvg = avgSlice.length ? avgSlice.reduce((s, v) => s + v, 0) / avgSlice.length : atr;
    result[i] = { atr, atrAvg };
  }
  return result;
}

function reportProgress(i, n, equity, ts, onProgress) {
  const step = Math.max(1, Math.floor(n / 500));
  const isLast = i === n - 1;
  if (i === 0 || isLast || i % step === 0) {
    const simPct = isLast ? 100 : Math.min(99.99, (i / Math.max(1, n - 1)) * 100);
    onProgress({ percent: simPct, equity, ts });
  }
}

function drawdownAt(curve, equity) {
  if (!curve.length) return 0;
  let peak = curve[0].equity;
  for (const p of curve) if (p.equity > peak) peak = p.equity;
  if (equity > peak) peak = equity;
  return peak > 0 ? Math.max(0, (peak - equity) / peak) * 100 : 0;
}

function computePctMove(entry, px, isLong) {
  if (!entry) return 0;
  const m = (px - entry) / entry;
  return isLong ? m : -m;
}

function noteGateReplay(stats, action, intelScore) {
  stats.evaluated++;
  const a = String(action || "pass");
  if (a === "vetoed") stats.vetoed++;
  else if (a === "size_scaled") stats.sizeScaled++;
  else stats.pass++;
  const n = Number(intelScore);
  if (Number.isFinite(n)) stats.intelScoreSum += n;
}

function finalizeGateReplay(stats) {
  const evaluated = Number(stats.evaluated || 0);
  return {
    mode: stats.mode,
    evaluated,
    pass: Number(stats.pass || 0),
    vetoed: Number(stats.vetoed || 0),
    sizeScaled: Number(stats.sizeScaled || 0),
    noGate: Number(stats.noGate || 0),
    avgIntelScore: evaluated > 0 ? stats.intelScoreSum / evaluated : null,
  };
}

function computeStopPct({ cfg, fixedSlPct, isFutures, atrPct, allowFallback = true }) {
  // ATR-based dynamic SL: slAtrMultiplier × ATR% of price (e.g. 3 × 0.1% ATR = 0.3% SL).
  // Only used when slAtrMultiplier > 0 AND we have a valid ATR reading.
  const atrMult = Number(cfg?.slAtrMultiplier ?? 0);
  if (allowFallback && atrMult > 0 && atrPct != null && atrPct > 0) {
    return Math.max(0.001, Math.min(0.1, atrMult * atrPct));
  }
  if (fixedSlPct > 0) return fixedSlPct;
  if (!allowFallback) return 0;
  const fallback = isFutures ? 0.01 : 0.02;
  return Math.max(0.001, Number(cfg?.spotFixedSlPct ?? fallback));
}
