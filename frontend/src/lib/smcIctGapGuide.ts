/** Step-by-step gap table — current sweep preset vs ideal ICT 2022 (mirrors backend plan). */

export type SmcGapRow = {
  step: number;
  label: string;
  ideal: string;
  sweep: string;
  codeSupport: "yes" | "partial" | "no";
};

export const SMC_ICT_GAP_ROWS: SmcGapRow[] = [
  {
    step: 1,
    label: "HTF narrative",
    ideal: "Completed 1H structure + dealing-range POI; multi 15m entries while valid",
    sweep: "4H EMA21 vs EMA50; opt-in 1H narrative (`RequireHtfNarrative` + POI mode)",
    codeSupport: "yes",
  },
  {
    step: 2,
    label: "Session timing",
    ideal: "London, NY, Silver Bullet windows",
    sweep: "24/7 (kill-zone ALL)",
    codeSupport: "yes",
  },
  {
    step: 3,
    label: "Liquidity target",
    ideal: "External BSL/SSL, session highs/lows, inducement",
    sweep: "PDH/PDL + optional session clusters",
    codeSupport: "partial",
  },
  {
    step: 4,
    label: "Sweep + reclaim",
    ideal: "Sweep then wait for structural shift",
    sweep: "Sweep + reclaim is the main entry trigger",
    codeSupport: "yes",
  },
  {
    step: 5,
    label: "CHoCH",
    ideal: "Required shift after sweep; invalid if immediately reclaimed",
    sweep: "OFF on sweep preset; ON on full/research; reclaimed-CHoCH abort when enforced",
    codeSupport: "yes",
  },
  {
    step: 6,
    label: "MSS / displacement",
    ideal: "Entry after MSS leg, not on reclaim",
    sweep: "OFF on sweep; BOS + ATR displacement when enabled",
    codeSupport: "yes",
  },
  {
    step: 7,
    label: "PD array",
    ideal: "FVG/OB from displacement / after CHoCH only; CE (50%) entry",
    sweep: "Sweep: any recent FVG/OB; CHoCH paths require PD after CHoCH + invalidation",
    codeSupport: "yes",
  },
  {
    step: 8,
    label: "Entry timing",
    ideal: "Retrace into FVG/OB after MSS bar",
    sweep: "On reclaim bar close or in zone",
    codeSupport: "yes",
  },
  {
    step: 9,
    label: "Confirm / invalidation",
    ideal: "Skip reclaimed CHoCH, blown OB, mitigated FVG, continuation sweeps",
    sweep: "Enforced when CHoCH required or full/balanced; OFF on bare sweep",
    codeSupport: "yes",
  },
  {
    step: 10,
    label: "Stop loss",
    ideal: "Beyond sweep + invalidation structure",
    sweep: "Structure mode: min(sweep wick, last swing); pd_array opt-in",
    codeSupport: "yes",
  },
  {
    step: 11,
    label: "Take profit",
    ideal: "TP1 internal liq, TP2 external; HTF runners",
    sweep: "Partial @ 1R + opposing PDH/PDL; max 3R cap",
    codeSupport: "partial",
  },
  {
    step: 12,
    label: "Trade frequency",
    ideal: "Low (1–3 quality setups/day); skip empty months",
    sweep: "Up to 5/day, per_signal pick mode",
    codeSupport: "yes",
  },
];

export function smcGapSupportLabel(s: SmcGapRow["codeSupport"]): string {
  if (s === "yes") return "Full";
  if (s === "partial") return "Partial";
  return "Missing";
}

/** True when sweep profile has strict gates manually enabled (expect fewer trades). */
export function smcSweepStrictGateWarning(smc: Record<string, unknown>): string | null {
  const profile = String(smc.intradaySmcIctProfile ?? "sweep").toLowerCase();
  if (profile !== "sweep" && profile !== "lite") return null;
  const strict =
    smc.intradaySmcRequireChoch === true ||
    smc.intradaySmcRequireMss === true ||
    smc.intradaySmcRequireBos === true ||
    smc.intradaySmcRequireRetrace === true ||
    smc.intradaySmcRequireConfirm === true ||
    smc.intradaySmcRequirePremiumDiscount === true;
  if (!strict) return null;
  return "Sweep profile with strict gates ON — expect far fewer trades than the tuned sweep baseline (~69 entries Jan–May 2026). Use “SMC ICT Full” preset for intentional strict ICT.";
}
