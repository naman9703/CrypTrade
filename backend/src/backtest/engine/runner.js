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
import { fixedBracketSlEnabled, fixedBracketTpEnabled } from "../../strategy/bracketToggles.js";
import { resolveSizingStopPrice } from "../../strategy/sizingStop.js";
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
import { resolveFibEntryBrackets } from "../../strategy/techniques/fibonacci.js";
import {
  liqBreakevenStopPx,
  mapLiquidityEntryLegs,
  resolveLiquidityEntryBrackets,
} from "../../strategy/techniques/liquidity.js";

const SUPERTREND_KEY = "SUPERTREND";
const SUPERTREND_ELITE_KEY = "SUPERTREND_ELITE";
const TREND_HTF_ST_KEY = "TREND_HTF_ST";
const ELITE_HTF_KEY = "ELITE_HTF";

function finalizeTradeRecord(pos, row) {
  return {
    ...row,
    entryQuality: pos?.entryQuality ?? null,
    vpSetup: pos?.vpSetup ?? null,
    entryReason: pos?.entryReason ?? null,
    liqContext: pos?.liqContext ?? null,
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
 * `RISK_AT_SL` (default): risk `riskPerTrade` % of equity (or fixed USDT) at the stop distance,
 * capped at `equity × leverage` notional on futures.
 *
 * `FULL_EQUITY_MARGIN`: use all current equity as isolated margin each trade
 * (`qty = equity × leverage / entry` on futures; spot uses full equity notional).
 *
 * @param {object} p
 * @param {number} p.equity
 * @param {number} p.entryFill
 * @param {number} p.sl
 * @param {Record<string, unknown>} p.cfg
 * @param {import("./costModel.js").ResolvedCostModel} p.cm
 * @param {boolean} p.isFutures
 * @param {number} [p.sizeMult]
 * @returns {number}
 */
export function computeEntryQty({ equity, entryFill, sl, cfg, cm, isFutures, sizeMult = 1 }) {
  const entry = Number(entryFill);
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  const mult = Math.max(0.01, Number(sizeMult) || 1);
  const sizing = String(cfg?.backtestPositionSizing ?? "RISK_AT_SL").toUpperCase();

  if (sizing === "FULL_EQUITY_MARGIN" || sizing === "FULL_EQUITY") {
    if (isFutures && cm.leverage > 0) return (equity * cm.leverage * mult) / entry;
    return (equity * mult) / entry;
  }

  const riskPctOfEquity = Math.max(0.01, Number(cfg?.riskPerTrade ?? 1)) / 100;
  const riskUnit = String(cfg?.riskPerTradeUnit ?? "PCT_EQUITY");
  const dollarRisk =
    riskUnit === "USDT" ? Math.max(1, Number(cfg?.riskPerTrade ?? 10)) : equity * riskPctOfEquity;
  const perUnitRisk = Math.abs(entry - Number(sl));
  let qty = perUnitRisk > 0 ? (dollarRisk * mult) / perUnitRisk : 0;
  if (!Number.isFinite(qty) || qty <= 0) qty = (mult * equity * 0.01) / entry;
  if (isFutures && cm.leverage > 0) {
    const maxNotional = equity * cm.leverage;
    const notional = Math.abs(qty) * entry;
    if (notional > maxNotional && maxNotional > 0) qty = maxNotional / entry;
  }
  return qty;
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
  if (strategyKey === SUPERTREND_ELITE_KEY && cfg && typeof cfg === "object") {
    cfg = normalizeEliteStRunCfg(cfg);
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

    // ── Daily loss reset ──────────────────────────────────────────────────────
    const barDayMs = Math.floor(bar.ts / 86400000) * 86400000;
    if (barDayMs > dayStartMs) {
      dayStartEquity = equity;
      dayStartMs = barDayMs;
    }

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

    // ── Position management ────────────────────────────────────────────────────
    if (pos) {
      const isLong = pos.side === "BUY";
      const adv = adverseExtreme(bar, isLong);
      const fav = isLong ? bar.high : bar.low;
      const liqStages = pos.liqExitStages ?? null;
      const hitTp1 =
        (liqStages?.tp1On !== false) &&
        pos.partialTp &&
        !pos.partialTaken &&
        pos.tp1 > 0 &&
        (isLong ? bar.high >= pos.tp1 : bar.low <= pos.tp1);
      const hitTP =
        pos.tp > 0 &&
        (pos.partialTaken || !pos.partialTp) &&
        (isLong ? bar.high >= pos.tp : bar.low <= pos.tp);
      const hitLiq = isFutures && (isLong ? bar.low <= pos.liqPx : bar.high >= pos.liqPx);
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
       *   1. Liq — gap through liquidation without a closer stop.
       *   2. TP — fixed take-profit on favorable touch.
       *   3. Trail — advance SL from the favorable extreme first, then test the
       *      adverse extreme vs the tightened stop (live updates trail on mark
       *      before the stop order is evaluated).
       *   4. SL — initial / BE bracket if trail did not exit on this bar.
       */
      if (!exitReason && hitLiq) {
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
          leverage: cm.leverage,
          model: cm,
        });
        const fundingP = isFutures
          ? fundingPaidBetween(pos, fundingRates, pos.entryTs, bar.ts) * frac
          : 0;
        const netPnlP = breakdownP.gross - breakdownP.fees - fundingP;
        equity += netPnlP;
        const entryNotionalP = closeQty * pos.entryFill;
        const marginP =
          isFutures && cm.leverage > 0 ? entryNotionalP / cm.leverage : entryNotionalP;
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
          }),
        );
        pos.qty -= closeQty;
        pos.partialTaken = true;
        /** After 1R partial on liquidity trades, protect runner with BE (manual analysis assumes this). */
        if (
          pos.partialTp &&
          (liqStages?.beOn !== false) &&
          cfg?.intradayLiqBreakevenAfterPartial !== false
        ) {
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
      } else if (!exitReason && hitTP) {
        exitReason = pos.partialTaken ? "tp2" : "tp";
        exitPrice = pos.tp;
      }

      if (!exitReason && trailEnabled) {
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
          leverage: cm.leverage,
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
          leverage: cm.leverage,
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
          isFutures && cm.leverage > 0 ? entryNotional / cm.leverage : entryNotional;
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
      if (htf4hCtx) {
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
      let sizeMult = 1;
      if (gateMode === "approx" && typeof gateFn === "function") {
        const gate =
          typeof gateFn === "function"
            ? gateFn(bar.ts, barSignal.action) || { intelScore: 50, action: "pass", sizeMult: 1 }
            : { intelScore: 50, action: "pass", sizeMult: 1 };
        gateAction = gate.action;
        intelAtEntry = gate.intelScore;
        sizeMult = gate.sizeMult;
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

      const next = candles[i + 1];
      /** Fib signals fire at bar close in live — optional same-bar fill (default on when fib brackets set). */
      const fibSameBarEntry =
        barSignal?.fibBrackets?.slPct > 0 && cfg?.intradayFibEntryAtSignalClose !== false;
      const liqSameBarEntry =
        barSignal?.liqBrackets?.slPct > 0 && cfg?.intradayLiqEntryAtSignalClose !== false;
      const fillBar = fibSameBarEntry || liqSameBarEntry ? bar : next;
      const entryFill = applySlippage(barSignal.action, fillBar.close, cm.slippagePct);
      const atrInfoEntry = atrSeries[i];
      const atrPctEntry =
        atrInfoEntry && Number.isFinite(atrInfoEntry.atr) && bar.close > 0
          ? atrInfoEntry.atr / bar.close
          : null;
      let stopPct = computeStopPct({
        cfg,
        fixedSlPct: bracketSlOn ? fixedSlPct : 0,
        isFutures,
        atrPct: atrPctEntry,
        allowFallback: bracketSlOn,
      });
      let tpPct = bracketTpOn ? fixedTpPct : 0;
      if (entryQuality?.brackets && isTrendHtfStRegimeGateEnabled(cfg)) {
        if (bracketSlOn) stopPct = entryQuality.brackets.slPct;
        if (bracketTpOn) tpPct = entryQuality.brackets.tpPct;
      }
      if (barSignal?.vpBrackets?.slPct > 0 && cfg.intradayVpBrackets === true) {
        if (bracketSlOn) stopPct = barSignal.vpBrackets.slPct;
        if (bracketTpOn) tpPct = barSignal.vpBrackets.tpPct ?? tpPct;
      }
      let fibStructureSl = null;
      let fibStructureTp = null;
      if (barSignal?.fibBrackets?.slPct > 0) {
        const fibBr = resolveFibEntryBrackets(cfg, barSignal, entryFill, barSignal.action);
        if (fibBr) {
          if (bracketSlOn) stopPct = fibBr.slPct;
          if (bracketTpOn) tpPct = fibBr.tpPct ?? tpPct;
          if (bracketSlOn && fibBr.slPrice > 0) fibStructureSl = fibBr.slPrice;
          if (bracketTpOn && fibBr.tpPrice > 0) fibStructureTp = fibBr.tpPrice;
        } else {
          if (bracketSlOn) stopPct = barSignal.fibBrackets.slPct;
          if (bracketTpOn) tpPct = barSignal.fibBrackets.tpPct ?? tpPct;
        }
      }
      let liqStructureSl = null;
      let liqStructureTp = null;
      let liqStructureTp1 = null;
      let liqPartial = false;
      let liqPartialFrac = 0.5;
      let liqExitStages = null;
      let liqBeAt1R = false;
      let liqBeTriggerPx = 0;
      if (barSignal?.liqBrackets?.slPct > 0) {
        const liqBr = resolveLiquidityEntryBrackets(cfg, barSignal, entryFill, barSignal.action);
        if (liqBr) {
          if (bracketSlOn) stopPct = liqBr.slPct;
          if (bracketTpOn) tpPct = liqBr.tpPct ?? tpPct;
          const legs = mapLiquidityEntryLegs(liqBr, cfg);
          if (legs) {
            if (bracketSlOn) liqStructureSl = legs.slPrice;
            if (bracketTpOn) {
              liqStructureTp = legs.tp;
              liqStructureTp1 = legs.tp1;
              liqPartial = legs.partialTp;
              liqPartialFrac = legs.partialFrac;
              liqExitStages = legs.stages;
              liqBeAt1R = legs.beAt1R;
              liqBeTriggerPx = legs.beTriggerPx;
            }
          }
        } else {
          if (bracketSlOn) stopPct = barSignal.liqBrackets.slPct;
          if (bracketTpOn) tpPct = barSignal.liqBrackets.tpPct ?? tpPct;
        }
      }
      if (!bracketSlOn) {
        stopPct = 0;
        fibStructureSl = null;
        liqStructureSl = null;
        liqBeAt1R = false;
      }
      if (!bracketTpOn) {
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
      const tp =
        structureTp != null && structureTp > 0
          ? structureTp
          : tpPct > 0
            ? barSignal.action === "BUY"
              ? entryFill * (1 + tpPct)
              : entryFill * (1 - tpPct)
            : 0;
      const qty = computeEntryQty({
        equity,
        entryFill,
        sl: resolveSizingStopPrice({
          entryFill,
          exitSl: sl > 0 ? sl : 0,
          side: barSignal.action,
          cfg,
        }),
        cfg,
        cm,
        isFutures,
        sizeMult,
      });
      const liqPx = isFutures
        ? liquidationPrice({ side: barSignal.action, entryFill, leverage: cm.leverage })
        : barSignal.action === "BUY"
          ? 0
          : Infinity;
      const vpSetup =
        barSignal.vpSetup ??
        (typeof barSignal.reason === "string" && barSignal.reason.startsWith("vp_")
          ? barSignal.reason.slice(3)
          : null);
      pos = {
        side: barSignal.action,
        entryFill,
        entryTs: fillBar.ts,
        entryIdx: fibSameBarEntry ? i : i + 1,
        qty,
        sl,
        tp,
        trailStep: 0,
        extremePx: entryFill,
        trailTierLabel: null,
        trailOpts: trailEnabled ? resolveTrailingOpts(cfg, cm, atrPctEntry) : null,
        entryEquity: equity,
        intelAtEntry,
        gateAction,
        sizeMult,
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
            }
          : null,
        partialTp: liqPartial,
        tp1: liqStructureTp1 ?? 0,
        partialFrac: liqPartialFrac,
        partialTaken: false,
        liqExitStages,
        liqBeAt1R,
        liqBeTriggerPx,
        maxHoldBars: Math.max(0, Number(cfg?.intradaySmcMaxHoldBars ?? cfg?.intradayLiqMaxHoldBars ?? 0)),
      };
      if (!fibSameBarEntry) {
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
      leverage: cm.leverage,
      model: cm,
    });
    const fundingPaid = cm.isFutures
      ? fundingPaidBetween(pos, fundingRates, pos.entryTs, last.ts)
      : 0;
    const netPnl = breakdown.gross - breakdown.fees - fundingPaid;
    equity += netPnl;
    const entryNotionalEnd = Math.abs(pos.qty) * pos.entryFill;
    const marginUsdtEnd =
      cm.isFutures && cm.leverage > 0 ? entryNotionalEnd / cm.leverage : entryNotionalEnd;
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
