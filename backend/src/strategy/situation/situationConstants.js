/** Canonical situation labels for BNB 15m situation router. */
export const SITUATIONS = Object.freeze({
  BREAKDOWN_BEAR: "BREAKDOWN_BEAR",
  BREAKOUT_BULL: "BREAKOUT_BULL",
  RANGE_ABOVE_PDL: "RANGE_ABOVE_PDL",
  RANGE_BELOW_PDH: "RANGE_BELOW_PDH",
  SQUEEZE: "SQUEEZE",
  VOLATILE_AVOID: "VOLATILE_AVOID",
  CHOP_NEUTRAL: "CHOP_NEUTRAL",
});

export const SETUP_TRIGGERS = Object.freeze({
  LH_FADE_SHORT: "lh_fade_short",
  LH_FADE_LONG: "lh_fade_long",
  RETEST_SHORT: "retest_short",
  RETEST_LONG: "retest_long",
  DISPLACEMENT_SHORT: "displacement_short",
  DISPLACEMENT_LONG: "displacement_long",
  FAIL_SHORT: "fail_short",
  FAIL_LONG: "fail_long",
  EXHAUSTION_LONG: "exhaustion_long",
  EXHAUSTION_SHORT: "exhaustion_short",
  CLASSICAL_PDL_RECLAIM: "classical_pdl_reclaim",
  CLASSICAL_PDH_RECLAIM: "classical_pdh_reclaim",
  SESSION_EXTREME_FADE: "session_extreme_fade",
  SQUEEZE_BREAK: "squeeze_break",
});

export const DEFAULT_ROUTE_TABLE = {
  BREAKDOWN_BEAR: ["lh_fade_short", "retest_short", "displacement_short", "fail_short", "exhaustion_long"],
  BREAKOUT_BULL: ["lh_fade_long", "retest_long", "displacement_long", "fail_long", "exhaustion_short"],
  RANGE_ABOVE_PDL: ["session_extreme_fade", "classical_pdl_reclaim"],
  RANGE_BELOW_PDH: ["session_extreme_fade", "classical_pdh_reclaim"],
  SQUEEZE: ["squeeze_break", "displacement_short", "displacement_long"],
  VOLATILE_AVOID: [],
  CHOP_NEUTRAL: [],
};
