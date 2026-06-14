/** Strategy picker categories and panel visibility for Trading Panel. */

export type StrategyCategory = {
  id: string;
  label: string;
  keys: string[];
};

export const STRATEGY_CATEGORIES: StrategyCategory[] = [
  {
    id: "trend_st",
    label: "Trend / Supertrend",
    keys: [
      "SUPERTREND",
      "SUPERTREND_ELITE",
      "UNIFIED_ELITE",
      "SAFE_INTRADAY",
      "TREND_HTF_ST",
      "TREND_PULLBACK",
      "APEX_TREND",
    ],
  },
  {
    id: "htf",
    label: "HTF / swing",
    keys: ["HTF_RSI", "HTF_LEG_RIDER", "BTC_CONSENSUS"],
  },
  {
    id: "intraday",
    label: "Intraday / ICT",
    keys: ["SR_INTRADAY", "SITUATION_INTRADAY", "CRT_TBS", "TOKYO_SESSION", "REGIME_ADAPTIVE"],
  },
  {
    id: "baselines",
    label: "Baselines",
    keys: [
      "CONFLUENCE",
      "EMA_CROSS",
      "RSI_MEAN",
      "BREAKOUT_VOL",
      "MOMENTUM_SURGE",
      "ENSEMBLE",
      "SMART_REVERSAL",
    ],
  },
  {
    id: "specialized",
    label: "Specialized",
    keys: ["SURF_PULSE_ML", "VOLUME_PROFILE"],
  },
];

export type SignalSourceEntry = { n: number; key: string; label: string };

export function groupedStrategyOptions(
  sources: SignalSourceEntry[],
): { category: StrategyCategory; items: SignalSourceEntry[] }[] {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  return STRATEGY_CATEGORIES.map((cat) => ({
    category: cat,
    items: cat.keys.map((k) => byKey.get(k)).filter(Boolean) as SignalSourceEntry[],
  })).filter((g) => g.items.length > 0);
}

export function usesIntradayGatePanel(manualStrategy: string): boolean {
  const k = String(manualStrategy || "").toUpperCase();
  return k === "SR_INTRADAY" || k === "SITUATION_INTRADAY" || k === "UNIFIED_ELITE";
}

export function usesEliteSettingsPanel(manualStrategy: string): boolean {
  const k = String(manualStrategy || "").toUpperCase();
  return k === "SUPERTREND_ELITE" || k === "SAFE_INTRADAY" || k === "UNIFIED_ELITE";
}

export function isSupertrendAutotradeStrategy(manualStrategy: string): boolean {
  return String(manualStrategy || "").toUpperCase() === "SUPERTREND";
}

export function isBaselineStrategy(manualStrategy: string): boolean {
  const baselines = new Set(STRATEGY_CATEGORIES.find((c) => c.id === "baselines")?.keys ?? []);
  return baselines.has(String(manualStrategy || "").toUpperCase());
}

export function showVolumeProfileStrategyPanel(manualStrategy: string): boolean {
  return String(manualStrategy || "").toUpperCase() === "VOLUME_PROFILE";
}

export function showRegimeAdaptivePanel(manualStrategy: string): boolean {
  return String(manualStrategy || "").toUpperCase() === "REGIME_ADAPTIVE";
}

export function showSurfPulsePanel(manualStrategy: string): boolean {
  return String(manualStrategy || "").toUpperCase() === "SURF_PULSE_ML";
}

/** Preset strips apply only in MANUAL when the fixed path matches. */
export function showStrategyPresetStrip(
  strategyMode: string | undefined,
  manualStrategy: string | undefined,
  presetStrategyKey: string,
): boolean {
  if (String(strategyMode ?? "").toUpperCase() !== "MANUAL") return false;
  return String(manualStrategy ?? "").toUpperCase() === String(presetStrategyKey).toUpperCase();
}
