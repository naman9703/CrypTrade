/**
 * Approximate intelligence-gate replay for backtests.
 *
 * Recomputes a composite score at any historical `ts` from data we _can_ replay:
 *   - Fear & Greed (`historical_fear_greed`, nearest <= ts)
 *   - Funding z-score (rolling 30d window in `historical_funding_rates`)
 *   - Open Interest 4h/24h change + Long/Short ratio (`historical_open_interest`)
 *   - Multi-timeframe Supertrend confluence (computed locally from the requested
 *     candle stream, downsampled to 15m/1h/4h via in-memory aggregation).
 *   - Strategy-TF regime context: ADX-14 (trend strength), ATR-14 (volatility),
 *     volume vs 20-bar MA. Used for pre-composite vetoes and stronger directional biases.
 *
 * Skipped (not historically recoverable): orderbook, options, live liquidations.
 * Runs flagged with `gate_mode = 'approx'` so the UI can label results.
 *
 * The returned function `(ts, openingSide) => { intelScore, action, sizeMult }` is what the
 * runner consumes; `openingSide` is `'BUY'|'SELL'` (same as live open). Veto / sizing rules mirror
 * `evaluateIntelligenceGateForSupertrendOpen` in `src/state/intelligenceGate.js` (directional
 * composite bands), not legacy symmetric `<30` thresholds.
 *
 * Filtering layers (evaluated in order, early-return on veto):
 *   0. **Per-direction cooldown** — minimum N strategy-TF bars between accepted signals
 *        per side (TF-dependent: 60 bars on 1m, 6 on 15m). Crushes 1m overtrading.
 *   1. **Regime pre-veto** — kills BOTH directions when market is unsuitable:
 *        a. Strategy-TF ADX < 25 (no clear trend → supertrend will whipsaw)
 *        b. 15m ADX < 22 (higher-TF chop check — protects against 1m false trends)
 *        c. ATR > 0.5% of price (extreme volatility — news/liquidation spikes)
 *   2. **HTF directional consensus** — both 1h AND 4h supertrends must agree with
 *        the signal direction. Lower-TF alignment alone is too noisy.
 *   3. **RSI confirmation** — blocks LONG when RSI > 70 (overbought / exhausted move)
 *        and SHORT when RSI < 30 (oversold / bounce likely).
 *   4. **Composite score veto** — tighter bands (≤42 for LONG / ≥58 for SHORT) so
 *        the composite must actively agree with the signal direction.
 *   5. **Contrarian extreme filter** — blocks entry when composite < 15 or > 85
 *        (panic/euphoria → likely reversal, not continuation).
 *   6. **Size scaling** — only when `confidence > 60` (composite deep into one tail).
 */

import { computeSupertrendSeries } from "../../strategy/supertrend.js";
import { adx as computeAdx, atr as computeAtr, rsi as computeRsi } from "../../strategy/indicators.js";
import { readFearGreed } from "../data/fearGreedIngest.js";
import { readFundingRates } from "../data/fundingIngest.js";
import { readOpenInterest } from "../data/openInterestIngest.js";

/** Strategy-TF → suggested per-direction cooldown bars (kills 1m overtrading). */
const COOLDOWN_BARS_BY_TF = {
  "1m": 60,
  "3m": 30,
  "5m": 20,
  "15m": 6,
  "30m": 4,
  "1h": 3,
  "4h": 2,
};

/** Strategy-TF → minutes per bar (used for cooldown timing). */
const MINUTES_PER_BAR = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
};

/**
 * @param {{ symbol: string, fromMs: number, toMs: number, timeframe?: string,
 *           strictMode?: boolean,
 *           candles: Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}> }} args
 */
export async function buildIntelligenceReplay({
  symbol,
  fromMs,
  toMs,
  candles,
  timeframe,
  strictMode = false,
  highWinRateMode = false,
}) {
  const strict = strictMode === true;
  const highWr = highWinRateMode === true;
  const padMs = 30 * 24 * 60 * 60 * 1000;
  const fundFrom = fromMs - padMs;
  const [fng, funding, oi] = await Promise.all([
    readFearGreed(fundFrom, toMs).catch(() => []),
    readFundingRates(symbol, fundFrom, toMs).catch(() => []),
    readOpenInterest(symbol, fundFrom, toMs).catch(() => []),
  ]);

  /** Aggregate strategy-TF candles to coarser timeframes and run Supertrend on each. */
  const stByTf = {
    "15m": runSupertrend(aggregateTo(candles, 15 * 60_000)),
    "1h": runSupertrend(aggregateTo(candles, 60 * 60_000)),
    "4h": runSupertrend(aggregateTo(candles, 4 * 60 * 60_000)),
  };

  /** Pre-compute 15m-aggregated candle stream for higher-TF chop detection. */
  const candles15m = aggregateTo(candles, 15 * 60_000).map((c) => ({
    ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0,
  }));
  const adx15mSeries = candles15m.length >= 30 ? computeAdx(candles15m, 14) : [];

  /**
   * Strategy-TF regime indicators. ADX/ATR/RSI are pre-computed for all bars;
   * volume MA is a 20-bar rolling average. On intraday timeframes the regime
   * indicators do most of the discriminative work because the macro inputs
   * (F&G, funding, OI) barely vary between consecutive signals.
   */
  const adxSeries = candles.length >= 30 ? computeAdx(candles, 14) : [];
  const atrSeries = candles.length >= 30 ? computeAtr(candles, 14) : [];
  const rsiSeries = candles.length >= 30 ? computeRsi(candles.map((c) => c.close), 14) : [];
  const volumeMa = computeRollingMean(candles.map((c) => Number(c.volume) || 0), 20);

  /**
   * Stateful per-direction cooldown. After ANY signal (pass OR veto) is evaluated,
   * record the timestamp. On the next call within the cooldown window for the same
   * direction, veto with `cooldown_active`. This kills 1m-TF overtrading where the
   * supertrend rapidly flips back and forth, generating 5-10 same-direction signals
   * per hour during chop. The cooldown is per-direction so LONG cooldown does not
   * block a SHORT signal (and vice versa) — letting actual trend reversals through.
   */
  const tfKey = String(timeframe || "1m").toLowerCase();
  const cooldownBars = highWr ? Math.max((COOLDOWN_BARS_BY_TF[tfKey] ?? 10) + 2, 8) : COOLDOWN_BARS_BY_TF[tfKey] ?? 10;
  const barMs = (MINUTES_PER_BAR[tfKey] ?? 1) * 60_000;
  const cooldownMs = cooldownBars * barMs;
  const lastAcceptedTs = { BUY: -Infinity, SELL: -Infinity };

  return function gateFn(ts, openingSide) {
    const side = String(openingSide || "").toUpperCase();
    const openingLong = side === "BUY";
    const openingShort = side === "SELL";

    /** Regime lookup at strategy-TF. */
    const idx = indexAtTs(candles, ts);
    const bar = idx >= 0 ? candles[idx] : null;
    const adxVal = idx >= 14 && adxSeries.length ? Number(adxSeries[idx]) : NaN;
    const atrVal = idx >= 14 && atrSeries.length ? Number(atrSeries[idx]) : NaN;
    const atrPct =
      Number.isFinite(atrVal) && bar?.close > 0 ? (atrVal / bar.close) * 100 : NaN;
    const rsiVal = idx >= 14 && rsiSeries.length ? Number(rsiSeries[idx]) : NaN;
    const vMa = idx >= 0 ? volumeMa[idx] : NaN;
    const volRatio =
      Number.isFinite(vMa) && vMa > 0 && bar?.volume ? Number(bar.volume) / vMa : NaN;

    // ── Layer 0: per-direction cooldown ──────────────────────────────────────
    // Prevents overtrading: on noisy TFs (especially 1m), the strategy supertrend
    // flips repeatedly during chop, generating same-direction signals 5-10× per
    // hour. The cooldown enforces a minimum gap between accepted signals per side.
    const dirKey = openingLong ? "BUY" : openingShort ? "SELL" : null;
    if (dirKey && ts - lastAcceptedTs[dirKey] < cooldownMs) {
      return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "cooldown_active" };
    }

    // ── Layer 1: regime pre-veto (kills BOTH directions) ─────────────────────
    // (a) Strategy-TF ADX < 25 → no clear trend → supertrend whipsaws.
    // (b) 15m ADX < 22 → even higher-TF is choppy → bail.
    // (c) ATR > 0.5% of price → extreme volatility → news / liquidation event.
    const minAdx = highWr ? 30 : strict ? 28 : 25;
    if (Number.isFinite(adxVal) && adxVal < minAdx) {
      return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "low_adx_chop" };
    }
    if (adx15mSeries.length) {
      const i15 = indexAtTs(candles15m, ts);
      const adx15 = i15 >= 14 ? Number(adx15mSeries[i15]) : NaN;
      if (Number.isFinite(adx15) && adx15 < 22) {
        return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "htf_15m_chop" };
      }
    }
    if (Number.isFinite(atrPct) && atrPct > 0.5) {
      return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "extreme_volatility" };
    }

    // ── Layer 2: HTF directional alignment ───────────────────────────────────
    // Require BOTH 1h AND 4h supertrends to agree with the signal direction.
    // 15m alone is too noisy (proven empirically: 15m-aligned losers > winners),
    // but 1h+4h consensus filters macro-counter-trend entries effectively.
    const confluence = confluenceAt(stByTf, ts);
    const h15trend = confluence.h15mtrend ?? 0;
    const h1trend = confluence.h1trend ?? 0;
    const h4trend = confluence.h4trend ?? 0;
    if (openingLong && (h15trend !== 1 || h4trend !== 1 || h1trend !== 1)) {
      return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "htf_not_bullish_consensus" };
    }
    if (openingShort && (h15trend !== -1 || h4trend !== -1 || h1trend !== -1)) {
      return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "htf_not_bearish_consensus" };
    }

    // ── Layer 3: RSI confirmation ────────────────────────────────────────────
    // Don't go long into overbought or short into oversold — the move is
    // likely exhausted and will reverse.
    if (Number.isFinite(rsiVal)) {
      const rsiLongMax = strict ? 65 : 70;
      const rsiShortMin = strict ? 35 : 30;
      if (openingLong && rsiVal > rsiLongMax) {
        return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "rsi_overbought" };
      }
      if (openingShort && rsiVal < rsiShortMin) {
        return { intelScore: 50, action: "vetoed", sizeMult: 0, vetoReason: "rsi_oversold" };
      }
    }

    // ── Layer 4: composite score (strengthened biases + tighter bands) ───────
    const fearGreed = nearestBefore(fng, ts, "ts");
    const fearGreedValue = fearGreed?.value ?? 50;
    const fundingZ = computeFundingZ(funding, ts);
    const oiChange4h = computeOiChange(oi, ts, 4 * 60 * 60_000);
    const oiChange24h = computeOiChange(oi, ts, 24 * 60 * 60_000);
    const lsr = nearestBefore(oi, ts, "ts")?.longShortRatio ?? 1;

    let score = 50;
    score += biasFromFearGreed(fearGreedValue);
    score += biasFromFunding(fundingZ);
    score += biasFromOiChange(oiChange4h, oiChange24h, lsr);
    const confluenceBias = (confluence.upVotes - confluence.downVotes) * 10;
    score += confluenceBias;
    score += biasFromAdxStrength(adxVal, confluence.upVotes - confluence.downVotes);
    score += biasFromVolume(volRatio, confluence.upVotes - confluence.downVotes);

    const composite = Math.max(0, Math.min(100, score));

    /**
     * Directional bands — live parity uses 35/65; replay default 42/58; strict requires
     * active agreement (LONG ≥58, SHORT ≤42) and blocks the neutral chop zone 47–53.
     */
    const longVetoMax = highWr ? 55 : strict ? 57 : 42;
    const shortVetoMin = highWr ? 45 : strict ? 43 : 58;
    const longPassMin = highWr ? 62 : strict ? 58 : 53;
    const shortPassMax = highWr ? 38 : strict ? 42 : 47;

    if (openingLong && composite <= longVetoMax) {
      return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_bearish" };
    }
    if (openingShort && composite >= shortVetoMin) {
      return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_bullish" };
    }
    const needStrongComposite = strict || highWr;
    if (needStrongComposite) {
      if (openingLong && composite < longPassMin) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_weak_long" };
      }
      if (openingShort && composite > shortPassMax) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_weak_short" };
      }
      if (composite >= 47 && composite <= 53) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_neutral_chop" };
      }
    }
    if (composite < 15 || composite > 85) {
      return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_extreme" };
    }

    /** Normal mode: block neutral chop; require modest directional agreement (fixes ~50 composite passes). */
    if (!strict && !highWr) {
      if (composite >= 46 && composite <= 54) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_neutral_chop" };
      }
      if (openingLong && composite < 53) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_weak_long" };
      }
      if (openingShort && composite > 47) {
        return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "composite_weak_short" };
      }
    }

    if (highWr && Number.isFinite(volRatio) && volRatio < 0.85) {
      return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "low_volume" };
    }

    const confidence = Math.round(Math.abs(composite - 50) * 2);
    const confMinPass = highWr ? 58 : strict ? 55 : 0;
    if ((strict || highWr) && confidence < confMinPass) {
      return { intelScore: composite, action: "vetoed", sizeMult: 0, vetoReason: "low_confidence" };
    }
    let sizeMult = 1;
    let action = "pass";
    const confMin = highWr ? 58 : strict ? 55 : 60;
    if (confidence > confMin) {
      sizeMult = replayIntelSizeMultiplier(composite);
      if (sizeMult !== 1) action = "size_scaled";
    }
    // Signal accepted — start cooldown for this direction.
    if (dirKey) lastAcceptedTs[dirKey] = ts;
    return { intelScore: composite, action, sizeMult };
  };
}

/** Mirrors the core of `computeSizeMultiplier` in compositeScorer (without vol/calendar). */
function replayIntelSizeMultiplier(composite) {
  let mult = 1.0;
  if (composite >= 70 || composite <= 30) mult = 1.5;
  if (composite >= 80 || composite <= 20) mult = 2.0;
  return Math.min(2.0, Math.max(0.25, parseFloat(mult.toFixed(2))));
}

function biasFromFearGreed(value) {
  if (value < 25) return -8;
  if (value < 40) return -3;
  if (value > 75) return +8;
  if (value > 60) return +3;
  return 0;
}

function biasFromFunding(z) {
  if (!Number.isFinite(z)) return 0;
  if (z > 2) return -10;
  if (z > 1) return -4;
  if (z < -2) return +10;
  if (z < -1) return +4;
  return 0;
}

/**
 * ADX-modulated directional boost: when trend strength is high (ADX > 25), the HTF
 * confluence direction is more trustworthy → amplify the bias in that direction.
 * Returns 0 when HTF confluence is neutral or ADX is unavailable.
 */
function biasFromAdxStrength(adxVal, htfNetVotes) {
  if (!Number.isFinite(adxVal) || htfNetVotes === 0) return 0;
  const dir = Math.sign(htfNetVotes);
  if (adxVal > 35) return dir * 6;
  if (adxVal > 25) return dir * 3;
  return 0;
}

/**
 * Volume confirmation: bars with > 1.5× the 20-bar average volume confirm the HTF
 * direction. Anemic volume (< 0.5×) implies low-conviction signal — bias against it.
 */
function biasFromVolume(volRatio, htfNetVotes) {
  if (!Number.isFinite(volRatio) || htfNetVotes === 0) return 0;
  const dir = Math.sign(htfNetVotes);
  if (volRatio > 1.5) return dir * 4;
  if (volRatio < 0.5) return -dir * 2;
  return 0;
}

function biasFromOiChange(c4h, c24h, lsr) {
  let b = 0;
  if (Number.isFinite(c4h)) {
    if (c4h > 0.05) b += 2;
    else if (c4h < -0.05) b -= 2;
  }
  if (Number.isFinite(c24h)) {
    if (c24h > 0.1) b += 3;
    else if (c24h < -0.1) b -= 3;
  }
  if (Number.isFinite(lsr)) {
    if (lsr > 1.5) b -= 2;
    else if (lsr < 0.7) b += 2;
  }
  return b;
}

/**
 * Binary search the candle array (sorted ascending by ts) for the largest index whose
 * candle.ts ≤ the given ts. Returns -1 if no candle satisfies the constraint.
 */
function indexAtTs(arr, ts) {
  if (!arr?.length) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= ts) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Trailing N-bar simple mean. Bars before window-size fill use the partial mean so far. */
function computeRollingMean(values, period) {
  const out = new Array(values.length).fill(0);
  if (!values.length || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out[i] = i >= period - 1 ? sum / period : i > 0 ? sum / (i + 1) : values[0];
  }
  return out;
}

function nearestBefore(arr, ts, key = "ts") {
  if (!arr?.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= ts) {
      best = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function computeFundingZ(rows, ts) {
  if (!rows?.length) return NaN;
  const start = ts - 30 * 24 * 60 * 60_000;
  const window = rows.filter((r) => r.ts >= start && r.ts <= ts).map((r) => r.rate);
  if (window.length < 5) return NaN;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, window.length - 1);
  const std = Math.sqrt(variance);
  if (std <= 0) return 0;
  const last = window[window.length - 1];
  return (last - mean) / std;
}

function computeOiChange(rows, ts, lookbackMs) {
  if (!rows?.length) return NaN;
  const now = nearestBefore(rows, ts, "ts");
  const before = nearestBefore(rows, ts - lookbackMs, "ts");
  if (!now || !before || !now.oiUsdt || !before.oiUsdt) return NaN;
  return (Number(now.oiUsdt) - Number(before.oiUsdt)) / Number(before.oiUsdt);
}

function aggregateTo(candles, stepMs) {
  if (!candles.length) return [];
  const out = [];
  let bucket = null;
  for (const c of candles) {
    const bucketTs = Math.floor(c.ts / stepMs) * stepMs;
    if (!bucket || bucket.ts !== bucketTs) {
      if (bucket) out.push(bucket);
      bucket = { ts: bucketTs, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function runSupertrend(candles) {
  if (!candles.length) return [];
  return computeSupertrendSeries(candles, { period: 10, multiplier: 3, wilderAtr: true }).map(
    (b) => ({ ts: b.ts, trend: b.trend ?? null, ready: b.ready }),
  );
}

function confluenceAt(stByTf, ts) {
  let upVotes = 0;
  let downVotes = 0;
  const trends = {};
  for (const [tf, series] of Object.entries(stByTf)) {
    const last = nearestBefore(series, ts, "ts");
    trends[tf] = last?.ready ? last.trend : 0;
    if (!last?.ready) continue;
    if (last.trend === 1) upVotes++;
    else if (last.trend === -1) downVotes++;
  }
  const net = upVotes - downVotes;
  return {
    upVotes,
    downVotes,
    bias: net * 4,
    h15mtrend: trends["15m"] ?? 0,
    h1trend: trends["1h"] ?? 0,
    h4trend: trends["4h"] ?? 0,
  };
}
