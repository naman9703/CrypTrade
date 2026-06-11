/**
 * Situation → sub-strategy mapping. Each market condition routes to a named
 * playbook with its own entry logic, brackets, and filters.
 */

import { SITUATIONS, SETUP_TRIGGERS } from "./situationConstants.js";

/** @typedef {{ id: string, label: string, phase: string, description: string, triggers: string[] }} SituationStrategy */

export const SITUATION_STRATEGIES = Object.freeze({
  [SITUATIONS.RANGE_ABOVE_PDL]: {
    id: "range_fade_short",
    label: "Range Fade Short (above PDL)",
    phase: "pre_structure",
    description:
      "Morning/early session while day holds above prior day low — fade lower highs into displacement or LH rejection.",
    triggers: [SETUP_TRIGGERS.LH_FADE_SHORT, SETUP_TRIGGERS.DISPLACEMENT_SHORT],
  },
  [SITUATIONS.RANGE_BELOW_PDH]: {
    id: "range_retest_short",
    label: "Range Retest Short (below PDH)",
    phase: "pre_structure",
    description: "Day failed to reclaim prior day high — short retests of breakdown with bear bias.",
    triggers: [SETUP_TRIGGERS.RETEST_SHORT],
  },
  [SITUATIONS.SQUEEZE]: {
    id: "squeeze_breakout",
    label: "Squeeze Breakout",
    phase: "pre_structure",
    description: "Compressed volatility before directional expansion — LH fade long or squeeze break.",
    triggers: [SETUP_TRIGGERS.LH_FADE_LONG, SETUP_TRIGGERS.SQUEEZE_BREAK],
  },
  [SITUATIONS.BREAKDOWN_BEAR]: {
    id: "breakdown_exhaustion",
    label: "Breakdown Exhaustion Reversal",
    phase: "breakdown",
    description:
      "After confirmed breakdown below PDL — counter-trend long on selling exhaustion (wick + new low + volume).",
    triggers: [SETUP_TRIGGERS.EXHAUSTION_LONG],
  },
  [SITUATIONS.BREAKOUT_BULL]: {
    id: "breakout_exhaustion",
    label: "Breakout Exhaustion Fade",
    phase: "breakout",
    description: "After confirmed breakout above PDH — fade buying exhaustion at new highs.",
    triggers: [SETUP_TRIGGERS.EXHAUSTION_SHORT, SETUP_TRIGGERS.LH_FADE_LONG, SETUP_TRIGGERS.RETEST_LONG],
  },
  [SITUATIONS.VOLATILE_AVOID]: {
    id: "stand_down",
    label: "Stand Down",
    phase: "avoid",
    description: "Extreme volatility — no trades.",
    triggers: [],
  },
  [SITUATIONS.CHOP_NEUTRAL]: {
    id: "no_edge",
    label: "No Edge",
    phase: "avoid",
    description: "Chop without clear structure — no trades.",
    triggers: [],
  },
});

/**
 * @param {string} situation
 * @returns {SituationStrategy}
 */
export function strategyForSituation(situation) {
  return (
    SITUATION_STRATEGIES[situation] || {
      id: "unknown",
      label: situation,
      phase: "unknown",
      description: "",
      triggers: [],
    }
  );
}

export function listRoutableStrategies(routeTable) {
  const routes = routeTable?.routes || {};
  const out = [];
  for (const [situation, triggers] of Object.entries(routes)) {
    if (!triggers?.length) continue;
    const meta = strategyForSituation(situation);
    out.push({ situation, ...meta, activeTriggers: triggers });
  }
  return out;
}
