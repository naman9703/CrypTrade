/**
 * Live bar-close evaluation for MANUAL strategies — uses the same adapters as backtest (`baselines.js`).
 */

import { sanitizeCandlesForSt } from "../lib/supertrendChartAlign.js";
import { computeSupertrendSeries } from "./supertrend.js";
import { buildBacktestAdapters } from "../backtest/engine/signals/baselines.js";

/** Every Path (MANUAL) entry in TradingPanel NUMBERED_SIGNAL_SOURCES. */
export const PANEL_MANUAL_STRATEGY_KEYS = new Set([
  "SUPERTREND",
  "CONFLUENCE",
  "EMA_CROSS",
  "RSI_MEAN",
  "BREAKOUT_VOL",
  "MOMENTUM_SURGE",
  "ENSEMBLE",
  "SURF_PULSE_ML",
  "TREND_PULLBACK",
  "HTF_RSI",
  "HTF_LEG_RIDER",
  "TREND_HTF_ST",
  "SMART_REVERSAL",
  "BTC_CONSENSUS",
  "APEX_TREND",
  "SUPERTREND_ELITE",
  "SAFE_INTRADAY",
  "SR_INTRADAY",
  "SITUATION_INTRADAY",
  "VOLUME_PROFILE",
  "REGIME_ADAPTIVE",
  "CRT_TBS",
  "TOKYO_SESSION",
  "UNIFIED_ELITE",
]);

/** @deprecated use PANEL_MANUAL_STRATEGY_KEYS */
export const LIVE_BAR_CLOSE_ADAPTER_KEYS = PANEL_MANUAL_STRATEGY_KEYS;

export function manualStrategyKey(state) {
  return String(state?.manualStrategy ?? "").trim().toUpperCase();
}

export function manualStrategyUsesLiveBarClose(state) {
  if (String(state?.strategyMode ?? "").toUpperCase() !== "MANUAL") return false;
  return PANEL_MANUAL_STRATEGY_KEYS.has(manualStrategyKey(state));
}

/** @deprecated */
export const manualStrategyUsesBarCloseAdapter = manualStrategyUsesLiveBarClose;

export function manualStrategyBarCloseActive(state, mmUp) {
  if (!state?.running) return false;
  if (!manualStrategyUsesLiveBarClose(state)) return false;
  const mm = String(mmUp ?? state?.marketMode ?? "AUTO").toUpperCase();
  return mm === "SPOT" || mm === "FUTURES" || mm === "AUTO";
}

export function resolveManualStrategyVenue(state, mmUp) {
  const mm = String(mmUp ?? state?.marketMode ?? "AUTO").toUpperCase();
  if (mm === "SPOT") return { stSpot: true, stFut: false };
  if (mm === "FUTURES") return { stSpot: false, stFut: true };
  return { stSpot: false, stFut: true };
}

function adapterPersistedFor(state, symU, strategyKey) {
  if (!state._liveStrategyPersisted || typeof state._liveStrategyPersisted !== "object") {
    state._liveStrategyPersisted = Object.create(null);
  }
  const sym = String(symU || "").toUpperCase();
  if (!state._liveStrategyPersisted[sym]) state._liveStrategyPersisted[sym] = Object.create(null);
  if (!state._liveStrategyPersisted[sym][strategyKey]) {
    state._liveStrategyPersisted[sym][strategyKey] = Object.create(null);
  }
  return state._liveStrategyPersisted[sym][strategyKey];
}

/**
 * Run backtest adapter for one closed bar (async — SurfPulse ML gate may await).
 */
export async function evaluateLiveStrategyAdapterBar({ state, candles, idx, symU, strategyKey }) {
  const key = String(strategyKey || "").toUpperCase();
  const tf = String(state?.timeframe ?? "15m").trim();
  const fromMs = Number(candles[0]?.ts) || Date.now();
  const adapters = await buildBacktestAdapters({
    strategyKey: key,
    cfg: state,
    symbol: symU,
    tf,
    candles,
    fromMs,
  });
  const fn = adapters[key];
  if (typeof fn !== "function") return null;

  const persisted = adapterPersistedFor(state, symU, key);
  const ctx = { candles, cfg: state, timeframe: tf, persisted };
  const bar = candles[idx];
  if (!bar) return null;
  return (await fn(bar, idx, ctx)) || null;
}

function buildBarCloseResult({
  raw,
  clean,
  idxC,
  cTs,
  symForEval,
  state,
  strategyKey,
  sig,
  chartMarkerVisibleForBar,
  computeIndicators,
  computeDecisionSnapshot,
  computeSupertrendSignalStrength01,
  timeframe,
  strictChartAlign,
}) {
  const stSeriesForChart = computeSupertrendSeries(clean, {
    period: state.supertrendPeriod,
    multiplier: state.supertrendMultiplier,
    wilderAtr: state.supertrendWilderAtr,
  });
  const row = stSeriesForChart[idxC] ?? null;

  const chartVisible =
    typeof chartMarkerVisibleForBar === "function" && row?.ready
      ? chartMarkerVisibleForBar({
          clean,
          series: stSeriesForChart,
          barIndex: idxC,
          timeframe: timeframe ?? state.timeframe,
          nowMs: Date.now(),
        })
      : true;

  const action = String(sig.action || "").toUpperCase();
  const allowBuy = action === "BUY" && (!strictChartAlign || chartVisible);
  const allowSell = action === "SELL" && (!strictChartAlign || chartVisible);
  const allowExit = action === "EXIT";

  const strengthBar = clean[idxC] ?? null;
  const supertrendStrength01 =
    row?.ready && strengthBar && typeof computeSupertrendSignalStrength01 === "function"
      ? computeSupertrendSignalStrength01({
          row,
          candle: strengthBar,
          multiplier: state.supertrendMultiplier,
        })
      : null;

  const indicatorsBarClose =
    typeof computeIndicators === "function" ? computeIndicators(raw) : { latest: {} };
  const decisionSnapshotBar =
    typeof computeDecisionSnapshot === "function"
      ? computeDecisionSnapshot({
          candles: raw,
          indicatorsLatest: indicatorsBarClose.latest,
          supertrendLastRow: row,
          symbol: symForEval,
          supertrendOpts: {
            period: state.supertrendPeriod,
            multiplier: state.supertrendMultiplier,
            wilderAtr: state.supertrendWilderAtr,
          },
        })
      : {};

  return {
    cTs,
    allowBuy,
    allowSell,
    allowExit,
    exitReason: allowExit ? sig.reason : null,
    row,
    decisionSnapshotBar,
    supertrendStrength01,
    strategyKey,
    signalReason: sig.reason ?? null,
    barSignal: sig,
    closedRaw: raw.map((c) => (c && typeof c === "object" ? { ...c } : c)),
  };
}

/**
 * Evaluate MANUAL strategy at bar close using backtest adapters (parity with runner.js).
 */
export async function evaluateLiveStrategyBarClose({
  state,
  closedRaw,
  evalSymbol,
  candleTsOpt,
  chartMarkerVisibleForBar,
  computeIndicators,
  computeDecisionSnapshot,
  computeSupertrendSignalStrength01,
  timeframe,
  strictChartAlign = true,
  evaluateRawSupertrendBarClose,
}) {
  const raw = Array.isArray(closedRaw) ? closedRaw : [];
  if (!manualStrategyUsesLiveBarClose(state)) return null;
  if (raw.length < Math.max(30, Number(state.supertrendPeriod ?? 10) + 2)) return null;

  const symForEval =
    evalSymbol != null && String(evalSymbol).trim()
      ? String(evalSymbol).trim().toUpperCase()
      : String(state.symbol || "").toUpperCase();

  const clean = sanitizeCandlesForSt(raw, symForEval);
  const cTs =
    Number.isFinite(Number(candleTsOpt)) && Number(candleTsOpt) > 0
      ? Number(candleTsOpt)
      : Number(raw[raw.length - 1]?.ts);
  if (!Number.isFinite(cTs)) return null;
  const idxC = clean.findIndex((c) => Number(c.ts) === cTs);
  if (idxC < 0) return null;

  const strategyKey = manualStrategyKey(state);

  if (strategyKey === "SUPERTREND" && typeof evaluateRawSupertrendBarClose === "function") {
    return evaluateRawSupertrendBarClose(raw, symForEval, cTs);
  }

  const sig = await evaluateLiveStrategyAdapterBar({
    state,
    candles: clean,
    idx: idxC,
    symU: symForEval,
    strategyKey,
  });
  if (!sig || sig.action === "HOLD") return null;

  return buildBarCloseResult({
    raw,
    clean,
    idxC,
    cTs,
    symForEval,
    state,
    strategyKey,
    sig,
    chartMarkerVisibleForBar,
    computeIndicators,
    computeDecisionSnapshot,
    computeSupertrendSignalStrength01,
    timeframe,
    strictChartAlign,
  });
}

/** @deprecated use evaluateLiveStrategyBarClose */
export const evaluateManualStrategyBarClose = evaluateLiveStrategyBarClose;
