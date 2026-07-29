import { SURF_PULSE_ML } from "./surfPulseMl.js";
import { TREND_PULLBACK } from "./trendPullback.js";
import { SMART_REVERSAL } from "./smartReversal.js";
import { HTF_RSI } from "./htfRsi.js";
import { TREND_HTF_ST } from "./trendHtfSt.js";
import { ELITE_HTF } from "./eliteHtf.js";
import { HTF_LEG_RIDER } from "./htfLegRider.js";
import { APEX_TREND } from "./apexTrend.js";
import { SUPERTREND_ELITE } from "./supertrendElite.js";
import { SAFE_INTRADAY } from "./safeIntraday.js";
import { SR_INTRADAY, INTRADAY_PRO } from "./intradayPro.js";
import { VOLUME_PROFILE } from "./volumeProfileStrategy.js";
import { REGIME_ADAPTIVE } from "./regimeAdaptive.js";
import { SITUATION_INTRADAY } from "./situationIntraday.js";
import { CRT_TBS } from "./crtTbsIntraday.js";
import { LIQ_CASCADE } from "./liqCascadeIntraday.js";
import { MLCTS } from "./mlctsIntraday.js";
import { SCALP_MR } from "./scalpMr.js";
import { TOKYO_SESSION } from "./tokyoSessionIntraday.js";
import { UNIFIED_ELITE } from "./unifiedElite.js";
import { LIQUIDITY_MAP } from "./liquidityMapStrategy.js";

const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE || 65);

function scoreTrend({ ema_fast, ema_slow, macd_hist }, prevMacdHist) {
  if (!ema_fast || !ema_slow) return { buy: 0, sell: 0 };
  const dist = (ema_fast - ema_slow) / ema_slow;
  const slopeUp = dist > 0.0005;
  const slopeDown = dist < -0.0005;

  let buy = 0;
  let sell = 0;

  if (ema_fast > ema_slow && slopeUp) buy = 20;
  else if (ema_fast > ema_slow) buy = 10;
  else if (ema_fast < ema_slow && slopeDown) sell = 20;
  else if (ema_fast < ema_slow) sell = 10;

  return { buy, sell };
}

function scoreMomentum({ rsi_14 }) {
  const r = rsi_14 ?? 50;
  let buy = 0;
  let sell = 0;

  if (r >= 40 && r <= 65) buy = 20;
  else if (r >= 30 && r < 40) buy = 15;
  else if (r < 30) buy = 8;

  if (r >= 35 && r <= 60) sell = 20;
  else if (r > 60 && r <= 70) sell = 15;
  else if (r > 70) sell = 8;

  return { buy, sell };
}

function scoreVolume({ volume_spike }) {
  const vs = volume_spike ?? 1;
  let s = 0;
  if (vs >= 2.0) s = 20;
  else if (vs >= 1.5) s = 15;
  else if (vs >= 1.2) s = 10;
  else if (vs >= 1.0) s = 3;

  return { buy: s, sell: s };
}

function scoreMacd({ macd_hist }, prevMacdHist) {
  const h = macd_hist ?? 0;
  const ph = prevMacdHist ?? 0;
  const increasing = h > ph;
  const decreasing = h < ph;

  let buy = 0;
  let sell = 0;

  if (h > 0 && increasing) buy = 20;
  else if (h > 0) buy = 10;
  else if (h < 0 && decreasing) sell = 20;
  else if (h < 0) sell = 10;

  return { buy, sell };
}

function scoreBollinger({ bb_pos }) {
  const bp = bb_pos ?? 0.5;
  let buy = 0;
  let sell = 0;

  if (bp <= 0.2) buy = 20;
  else if (bp <= 0.35) buy = 15;
  else if (bp <= 0.5) buy = 8;

  if (bp >= 0.8) sell = 20;
  else if (bp >= 0.65) sell = 15;
  else if (bp >= 0.5) sell = 8;

  return { buy, sell };
}

function computeConfluenceScore({ candles, indicators, regime }) {
  const latest = indicators.latest;
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;

  const prevMacdHist = prevCandle ? (latest.macd_hist_prev ?? 0) : 0;

  const trend = scoreTrend(latest, prevMacdHist);
  const momentum = scoreMomentum(latest);
  const volume = scoreVolume(latest);
  const macd = scoreMacd(latest, prevMacdHist);
  const bollinger = scoreBollinger(latest);

  let rawBuy = trend.buy + momentum.buy + volume.buy + macd.buy + bollinger.buy;
  let rawSell = trend.sell + momentum.sell + volume.sell + macd.sell + bollinger.sell;

  // Multi-timeframe alignment bonus/penalty (5m and 15m)
  const htf5mTrend = latest.htf_5m_ema_trend ?? 0;
  const htf15mTrend = latest.htf_15m_ema_trend ?? 0;

  if (htf5mTrend === 1) { rawBuy += 5; rawSell -= 8; }
  else if (htf5mTrend === -1) { rawSell += 5; rawBuy -= 8; }

  if (htf15mTrend === 1) { rawBuy += 5; rawSell -= 7; }
  else if (htf15mTrend === -1) { rawSell += 5; rawBuy -= 7; }

  const buyScore = Math.max(0, rawBuy);
  const sellScore = Math.max(0, rawSell);

  const components = { trend, momentum, volume, macd, bollinger, htf5mTrend, htf15mTrend };

  if (buyScore >= sellScore && buyScore >= MIN_SIGNAL_SCORE) {
    return {
      action: "BUY",
      score: buyScore,
      reason: `confluence_buy_${buyScore}`,
      components,
    };
  }
  if (sellScore > buyScore && sellScore >= MIN_SIGNAL_SCORE) {
    return {
      action: "SELL",
      score: sellScore,
      reason: `confluence_sell_${sellScore}`,
      components,
    };
  }
  return {
    action: "HOLD",
    score: Math.max(buyScore, sellScore),
    reason: `confluence_low_${Math.max(buyScore, sellScore)}`,
    components,
  };
}

export const strategies = {
  SUPERTREND: {
    name: "Supertrend (spot — trades on candle close via WebSocket)",
    signal() {
      return { action: "HOLD", reason: "supertrend_event_driven" };
    },
  },
  CONFLUENCE: {
    name: "Multi-Indicator Confluence (scored 0-100)",
    signal: computeConfluenceScore,
  },
  EMA_CROSS: {
    name: "Trend Following (EMA 12/26)",
    signal({ indicators }) {
      const f = indicators.latest.ema_fast;
      const s = indicators.latest.ema_slow;
      if (!f || !s) return { action: "HOLD", reason: "no_ema" };
      if (f > s) return { action: "BUY", reason: "ema_fast_above_slow" };
      if (f < s) return { action: "SELL", reason: "ema_fast_below_slow" };
      return { action: "HOLD", reason: "flat" };
    },
  },
  RSI_MEAN: {
    name: "Mean Reversion (RSI 14)",
    signal({ indicators }) {
      const r = indicators.latest.rsi_14;
      if (r <= 30) return { action: "BUY", reason: "rsi_oversold" };
      if (r >= 70) return { action: "SELL", reason: "rsi_overbought" };
      return { action: "HOLD", reason: "neutral" };
    },
  },
  BREAKOUT_VOL: {
    name: "Breakout (Volume spike + range)",
    signal({ candles, indicators }) {
      const vs = indicators.latest.volume_spike;
      if (vs < 1.5) return { action: "HOLD", reason: "no_volume_spike" };
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      if (!last || !prev) return { action: "HOLD", reason: "insufficient_candles" };
      if (last.close > prev.high) return { action: "BUY", reason: "break_above_prev_high" };
      if (last.close < prev.low) return { action: "SELL", reason: "break_below_prev_low" };
      return { action: "HOLD", reason: "no_break" };
    },
  },
  MOMENTUM_SURGE: {
    name: "Momentum Surge (multi-signal confirmation)",
    signal({ indicators }) {
      const rsi = indicators.latest.rsi_14;
      const vs = indicators.latest.volume_spike;
      const macdH = indicators.latest.macd_hist ?? 0;
      const emaF = indicators.latest.ema_fast;
      const emaS = indicators.latest.ema_slow;
      const bbPos = indicators.latest.bb_pos ?? 0.5;

      const trendUp = emaF > emaS;
      const trendDown = emaF < emaS;

      if (trendUp && rsi > 40 && rsi < 68 && vs > 1.3 && macdH > 0 && bbPos < 0.85) {
        return { action: "BUY", reason: "momentum_surge_buy" };
      }
      if (trendDown && rsi > 32 && rsi < 60 && vs > 1.3 && macdH < 0 && bbPos > 0.15) {
        return { action: "SELL", reason: "momentum_surge_sell" };
      }
      return { action: "HOLD", reason: "no_momentum_surge" };
    },
  },
  SURF_PULSE_ML,
  TREND_PULLBACK,
  SMART_REVERSAL,
  HTF_RSI,
  TREND_HTF_ST,
  ELITE_HTF,
  HTF_LEG_RIDER,
  ENSEMBLE: {
    name: "Ensemble (2+ signals must agree)",
    signal({ candles, indicators, regime }) {
      const base = ["EMA_CROSS", "RSI_MEAN", "BREAKOUT_VOL", "MOMENTUM_SURGE"];
      let buys = 0;
      let sells = 0;
      for (const key of base) {
        const sig = strategies[key].signal({ candles, indicators, regime });
        if (sig.action === "BUY") buys++;
        else if (sig.action === "SELL") sells++;
      }
      if (buys >= 2) return { action: "BUY", reason: `ensemble_${buys}_buy` };
      if (sells >= 2) return { action: "SELL", reason: `ensemble_${sells}_sell` };
      return { action: "HOLD", reason: "ensemble_no_consensus" };
    },
  },
  APEX_TREND,
  BTC_CONSENSUS: {
    name: "BTC trend consensus (2+ of Trend+ST / Leg Rider / Momentum)",
    signal({ candles, indicators, regime }) {
      const base = ["TREND_HTF_ST", "HTF_LEG_RIDER", "MOMENTUM_SURGE"];
      let buys = 0;
      let sells = 0;
      for (const key of base) {
        const strat = strategies[key];
        if (!strat?.signal) continue;
        const sig = strat.signal({ candles, indicators, regime });
        if (sig.action === "BUY") buys++;
        else if (sig.action === "SELL") sells++;
      }
      if (buys >= 2) return { action: "BUY", reason: `btc_consensus_${buys}` };
      if (sells >= 2) return { action: "SELL", reason: `btc_consensus_${sells}` };
      return { action: "HOLD", reason: "btc_consensus_no_agree" };
    },
  },

  SUPERTREND_ELITE,
  SAFE_INTRADAY,
  SR_INTRADAY,
  INTRADAY_PRO,
  VOLUME_PROFILE,
  REGIME_ADAPTIVE,
  SITUATION_INTRADAY,
  CRT_TBS,
  LIQ_CASCADE,
  MLCTS,
  SCALP_MR,
  TOKYO_SESSION,
  UNIFIED_ELITE,
  LIQUIDITY_MAP,
};
