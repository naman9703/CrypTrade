import type { MarketDecisionEngineConfig } from "./types";
import { DEFAULT_MARKET_DECISION_CONFIG } from "./configDefaults";

/** Numeric fields surfaced as “threshold / tuning” inputs — reset together to {@link DEFAULT_MARKET_DECISION_CONFIG}. */
export const MARKET_DECISION_NUMERIC_RESET_KEYS = [
  "adxStrong",
  "adxWeak",
  "emaLength",
  "atrVolThreshold",
  "stabilityLookback",
  "stabilityMinAgree",
  "transitionLookback",
  "minRegimeConfidence",
  "confidencePenalty",
  "chopRangeThreshold",
  "chopMaxFlips",
  "directionMismatchPenalty",
  "btcMinAdx",
  "btcFilterPenalty",
  "scoreThreshold",
  "scoreRsiLongMin",
  "scoreRsiShortMax",
  "weightSupertrend",
  "weightEmaAlign",
  "weightRsi",
  "weightHtfMatch",
  "penaltyChop",
  "penaltyWeakTrend",
  "penaltyOverextension",
  "pullbackAtrMult",
  "feeGateT02FeeBeMultiplier",
  "feeGateT02ActivationSlippageFrac",
  "feeGateT02TrailBufferRate",
  "feeSlippageBps",
  "feeBufferPct",
  "defaultRoundTripFeeRate",
] as const satisfies ReadonlyArray<keyof MarketDecisionEngineConfig>;

export type MarketDecisionNumericResetKey = (typeof MARKET_DECISION_NUMERIC_RESET_KEYS)[number];

export function marketDecisionNumericDefaultsPatch(): Partial<MarketDecisionEngineConfig> {
  const D = DEFAULT_MARKET_DECISION_CONFIG;
  return Object.fromEntries(MARKET_DECISION_NUMERIC_RESET_KEYS.map((k) => [k, D[k]])) as Partial<MarketDecisionEngineConfig>;
}

/** Short overview for the settings panel (not tooltips). */
export const MARKET_DECISION_ENGINE_OVERVIEW = `The market decision engine runs on the server at bar close for snapshots (and can gate opens when enabled). It combines several layers in order:

1) Regime — Classifies the LTF bar as uptrend, downtrend, sideways, volatile, or unclear using ADX, EMA slope vs price, and ATR% vs a threshold. Produces a confidence score (0–100).

2) Regime confidence — If confidence is below your minimum, either BLOCK outright or subtract a penalty from the composite score (depending on mode).

3) Transition block — Detects a messy mix of chop and trend over a short lookback; can hard-block when enabled.

4) Chop layer — Optional hard block or soft penalty when ADX is weak, range is too compressed, or regime flips too often.

5) BTC filter — Optional global check on BTC’s regime; block or penalize when BTC is weak/sideways.

6) Direction vs regime — Ensures BUY aligns with uptrend (and SELL with downtrend), unless you allow sideways.

7) Composite score — Weighted checklist: Supertrend confirm, EMA alignment, RSI momentum band, optional HTF match, minus penalties (weak trend, overextension, soft chop, etc.). Must meet your score threshold; if HTF is on with weight, HTF must also align.

8) Entry timing — Pullback/breakout vs distance to EMA (ATR band), or instant.

9) Fee gate — Requires estimated favorable move to cover fees (and buffer/slip, or T02 activation geometry).

Each snapshot stores the verdict (ALLOW / BLOCK / WAIT), reasons, and per-parameter rows for the chart accordion. Move quality (volume, body, separate MQ score) is a different system below this panel.`;

/** Native title= tooltips for every persisted config key (hover label or ⓘ). */
export const MARKET_DECISION_PARAM_TOOLTIPS: { [K in keyof MarketDecisionEngineConfig]: string } = {
  enabled:
    "Master switch. Off: engine does not filter live orders; snapshots still show what would happen if it were on. On: enabled pipeline stages can block or wait on opens.",
  regimeFilterEnabled:
    "When on, the server computes LTF regime (trend/sideways/volatile/unclear) from ADX, EMA trend, and ATR%. Used for confidence gating, direction vs regime, and chop context. Off: those regime-dependent stages are skipped.",
  adxStrong:
    "ADX level (14) used in the regime classifier to boost trend strength scoring. Higher = classify strong trends more readily in the internal strength heuristic.",
  adxWeak:
    "ADX floor for “weak trend” / sideways bias in regime logic. The chop layer can also use this as the minimum ADX to avoid the weak-ADX chop flag when chop ADX sub-rule is on.",
  emaLength:
    "EMA period for regime classification and for price-vs-EMA alignment in the composite score and entry-timing distance.",
  atrVolThreshold:
    "Fraction ATR/price (e.g. 0.015 = 1.5%). If current ATR% exceeds this, regime is classified VOLATILE, which changes how trend/sideways rules interact and appears in stage checks.",
  stabilityLookback:
    "Number of recent LTF regime labels used to compute stability (how many bars agree). Shown in snapshots; informs how “noisy” regime flips are.",
  stabilityMinAgree:
    "Within the lookback, minimum count of bars that must share the same regime type for the stability label to read as stable.",
  transitionBlockEnabled:
    "When on, detects rapid alternation between chop-like and trend-like conditions over transitionLookback bars and can BLOCK as a false-breakout guard.",
  transitionLookback:
    "Bars scanned for the transition/chop+trend mix pattern when transition block is enabled.",
  minRegimeConfidence:
    "0–100 composite regime confidence from the classifier. Below this: BLOCK (if confidence mode is BLOCK) or apply confidencePenalty to the score (if PENALTY).",
  confidenceMode:
    "BLOCK: low confidence hard-stops before score. PENALTY: low confidence still allows later stages but subtracts confidencePenalty from the composite total.",
  confidencePenalty:
    "Points subtracted from the composite score when regime confidence is below minRegimeConfidence and mode is PENALTY. Should be sized vs your max possible score.",
  chopEnabled:
    "Master for chop microstructure rules (ADX weak, tight range, flip count). When off, chop stage is skipped.",
  chopAdxEnabled:
    "When on, ADX below adxWeak contributes to chop detection (weak trend / chop risk).",
  chopRangeEnabled:
    "When on, range compression below chopRangeThreshold contributes to chop (tight, indecisive bars).",
  chopFlipEnabled:
    "When on, too many regime type flips in the lookback contributes to chop.",
  chopRangeThreshold:
    "Minimum Range₁₀ (fraction of price) required to avoid the tight-range chop flag when chop range is enabled. Lower = stricter (easier to flag chop).",
  chopMaxFlips:
    "Maximum allowed regime flips in the chop window before the flip sub-rule flags chop.",
  chopHardBlock:
    "On: chop composite BLOCKs the trade when any chop rule fires. Off: apply penaltyChop to score only (soft chop) if other stages still pass.",
  directionMismatchMode:
    "BLOCK: BUY not in uptrend (or SELL not in downtrend, given allowSideways) hard-stops. PENALTY: subtract directionMismatchPenalty from score instead.",
  directionMismatchPenalty:
    "Score points removed when signal direction disagrees with regime and mode is PENALTY.",
  allowSidewaysWithSignal:
    "When on, BUY may be allowed in SIDEWAYS/UNCLEAR and SELL similarly, instead of counting as mismatch. Use with care.",
  htfEnabled:
    "When on, a higher-timeframe regime slice is computed and can contribute HTF weight to the composite score and must align when HTF weight > 0.",
  htfTimeframe:
    "Binance-style interval string for the HTF regime bar (e.g. 15m, 1h).",
  btcFilterEnabled:
    "When on, evaluates BTC’s regime quality (ADX, sideways/unclear) and can block or penalize the local symbol’s trade.",
  btcSymbol:
    "Futures symbol used for the BTC regime feed (e.g. BTCUSDT).",
  btcMinAdx:
    "If BTC ADX is below this, the BTC filter treats BTC as too weak for global risk-on alignment (subject to block/penalty mode).",
  btcBlockMode:
    "BLOCK: weak/sideways BTC stops the trade. PENALTY: subtract btcFilterPenalty from score.",
  btcFilterPenalty:
    "Score penalty when BTC filter trips in PENALTY mode.",
  signalQualityEnabled:
    "When on, composite score (weights + penalties + threshold) must pass after earlier stages.",
  scoreThreshold:
    "Minimum composite score total (after adds and subtracts) required to pass. Typical default equals sum of enabled LTF weights when HTF is off.",
  scoreRsiLongMin:
    "For BUY (and neutral legacy bias), RSI must be at or above this to earn the RSI weight in the composite score.",
  scoreRsiShortMax:
    "For SELL, RSI must be at or below this to earn the RSI weight.",
  weightSupertrend:
    "Points added when the Supertrend row confirms the signal side at the bar.",
  weightEmaAlign:
    "Points added when price is on the correct side of the EMA for the trade direction.",
  weightRsi:
    "Points added when RSI satisfies the long/short momentum bands.",
  weightHtfMatch:
    "Points added when HTF regime direction matches LTF. If HTF is enabled with positive weight, alignment is also required for an overall pass.",
  penaltyChop:
    "Points subtracted when chop fires in soft mode (chopHardBlock off).",
  penaltyWeakTrend:
    "Points subtracted when the scoring input marks the trend as weak.",
  penaltyOverextension:
    "Points subtracted when the scoring input marks price as overextended.",
  entryMode:
    "INSTANT: always ENTER for entry timing. PULLBACK: WAIT until price is close enough to EMA. BREAKOUT: WAIT until stretched enough from EMA.",
  pullbackAtrMult:
    "Scales the ATR-based band for |price−EMA|/price in pullback/breakout entry timing. Higher = wider band.",
  feeGateEnabled:
    "When on, requires estimated favorable move to meet or exceed the computed required move %.",
  feeGateRequiredMoveBasis:
    "FEE_BUFFER_SLIP: round-trip fee + feeBufferPct + slippage bps. T02_ACTIVATION: compare to % move to tier-2 trail activation (aligned with Supertrend trailing).",
  feeGateT02SyncFromBotTrailing:
    "When basis is T02 and this is on, server pulls fee-BE multiplier, activation slip, and trail buffer from live bot trailing settings each check.",
  feeGateT02FeeBeMultiplier:
    "Multiplies padded round-trip fee when computing T02 activation distance (1 = exact fee breakeven multiple).",
  feeGateT02ActivationSlippageFrac:
    "Extra fraction added on top of padded fee for the activation threshold only (slippage cushion).",
  feeGateT02TrailBufferRate:
    "Trail buffer fraction matching SUPERTREND_TRAIL_BUFFER_RATE geometry for T02 activation comparison.",
  feeSlippageBps:
    "Slippage assumption in basis points added to the required move when using FEE_BUFFER_SLIP basis.",
  feeBufferPct:
    "Additional percent buffer on top of round-trip fees for the classic fee gate (human-readable percent, e.g. 0.15 = 0.15%).",
  defaultRoundTripFeeRate:
    "Round-trip fee as a fraction (e.g. 0.0016 = 0.16% per leg combined model depends on engine — used when venue fee not injected).",
};
