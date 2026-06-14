/**
 * Mirrors live gate applicability in backend/src/state/bot.js (manualAdapterPath, supertrendPausesAi).
 * UI-only — does not change trading behavior.
 */

export type GateId =
  | "intelligence"
  | "signalStrength"
  | "marketDecision"
  | "moveQuality"
  | "bigMove"
  | "htf4h"
  | "futuresAiConfidence"
  | "globalAiThreshold"
  | "surfPulseMl"
  | "stConfirmation";

export type TradingPanelCfg = {
  strategyMode?: string;
  manualStrategy?: string;
  marketMode?: string;
  supertrendSpotAuto?: boolean;
  supertrendFuturesAuto?: boolean;
  intelligenceGateEnabled?: boolean;
  intelligenceGateManualStrategies?: boolean;
  signalStrengthGatesTrades?: boolean;
  marketDecision?: { enabled?: boolean };
  supertrendMoveQualityGate?: boolean;
  supertrendBigMoveGateEnabled?: boolean;
  supertrendHtf4hEnabled?: boolean;
  supertrendFuturesAiConfidenceFilter?: boolean;
  supertrendConfirmationGateEnabled?: boolean;
  surfPulseMlGateEnabled?: boolean;
  eliteStRequireHtf4hAlign?: boolean;
};

const PANEL_MANUAL_KEYS = new Set([
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

export function manualStrategyKey(cfg: TradingPanelCfg): string {
  return String(cfg.manualStrategy ?? "").trim().toUpperCase();
}

export function manualStrategyUsesLiveBarClose(cfg: TradingPanelCfg): boolean {
  if (String(cfg.strategyMode ?? "").toUpperCase() !== "MANUAL") return false;
  return PANEL_MANUAL_KEYS.has(manualStrategyKey(cfg));
}

export function supertrendAutotradeOn(cfg: TradingPanelCfg): boolean {
  const mm = String(cfg.marketMode ?? "AUTO").toUpperCase();
  const spot = Boolean(cfg.supertrendSpotAuto);
  const fut = Boolean(cfg.supertrendFuturesAuto);
  if (mm === "SPOT") return spot;
  if (mm === "FUTURES") return fut;
  return spot || fut;
}

export function manualAdapterPath(cfg: TradingPanelCfg): boolean {
  return manualStrategyUsesLiveBarClose(cfg) && manualStrategyKey(cfg) !== "SUPERTREND";
}

export function supertrendPausesAiPath(cfg: TradingPanelCfg): boolean {
  return manualStrategyUsesLiveBarClose(cfg) || supertrendAutotradeOn(cfg);
}

export function stAutotradeOnlyGatesEffective(cfg: TradingPanelCfg): boolean {
  return !manualAdapterPath(cfg) && supertrendAutotradeOn(cfg);
}

export function isGateEffective(cfg: TradingPanelCfg, gateId: GateId): boolean {
  switch (gateId) {
    case "intelligence":
      if (!cfg.intelligenceGateEnabled) return false;
      if (manualAdapterPath(cfg)) return cfg.intelligenceGateManualStrategies === true;
      return true;
    case "signalStrength":
      return stAutotradeOnlyGatesEffective(cfg) && cfg.signalStrengthGatesTrades === true;
    case "marketDecision":
      return stAutotradeOnlyGatesEffective(cfg) && cfg.marketDecision?.enabled === true;
    case "moveQuality":
      return (
        stAutotradeOnlyGatesEffective(cfg) &&
        cfg.supertrendMoveQualityGate === true &&
        cfg.supertrendBigMoveGateEnabled !== true
      );
    case "bigMove":
      return stAutotradeOnlyGatesEffective(cfg) && cfg.supertrendBigMoveGateEnabled === true;
    case "htf4h":
      if (manualAdapterPath(cfg)) return false;
      if (manualStrategyKey(cfg) === "SUPERTREND_ELITE" && cfg.eliteStRequireHtf4hAlign === true) {
        return false;
      }
      return stAutotradeOnlyGatesEffective(cfg) && cfg.supertrendHtf4hEnabled === true;
    case "futuresAiConfidence":
      return stAutotradeOnlyGatesEffective(cfg) && cfg.supertrendFuturesAiConfidenceFilter !== false;
    case "globalAiThreshold":
      return !supertrendPausesAiPath(cfg);
    case "surfPulseMl":
      return manualStrategyKey(cfg) === "SURF_PULSE_ML";
    case "stConfirmation":
      return stAutotradeOnlyGatesEffective(cfg) && cfg.supertrendConfirmationGateEnabled === true;
    default:
      return false;
  }
}

export function countActiveGates(cfg: TradingPanelCfg): number {
  const ids: GateId[] = [
    "intelligence",
    "signalStrength",
    "marketDecision",
    "moveQuality",
    "bigMove",
    "htf4h",
    "futuresAiConfidence",
  ];
  return ids.filter((id) => isGateEffective(cfg, id)).length;
}

export function gateScopeLabel(gateId: GateId): string {
  switch (gateId) {
    case "intelligence":
      return "Opens when enabled; MANUAL bar-close only if sub-toggle on";
    case "signalStrength":
    case "marketDecision":
    case "moveQuality":
    case "bigMove":
    case "htf4h":
    case "futuresAiConfidence":
    case "stConfirmation":
      return "Supertrend autotrade bar-close only";
    case "globalAiThreshold":
      return "Tick path (non bar-close strategies)";
    case "surfPulseMl":
      return "SurfPulse ML strategy";
    default:
      return "";
  }
}
