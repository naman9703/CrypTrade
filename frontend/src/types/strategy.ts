/** Strategy + version types (Phase 3B → 3D split). API returns camelCase from backend mappers. */

/** Allowed primary signal types (matches backend `strategy_versions.primary_signal_type`). */
export type PrimarySignalType =
  | "SUPERTREND"
  | "SURF_PULSE_ML"
  | "EMA_CROSS"
  | "RSI"
  | "TREND_PULLBACK"
  | "MANUAL";

/**
 * Typed signal-brain blocks persisted on a strategy version (3D split).
 * Each block is null until populated. The block matching `primarySignalType`
 * is always populated; siblings stay null.
 */
export interface StrategyVersionBlocks {
  supertrend: Record<string, unknown> | null;
  surfPulse: Record<string, unknown> | null;
  emaCross: Record<string, unknown> | null;
  rsi: Record<string, unknown> | null;
  trendPullback: Record<string, unknown> | null;
  ai: Record<string, unknown> | null;
  entry: Record<string, unknown> | null;
  exit: Record<string, unknown> | null;
  leverage: Record<string, unknown> | null;
  mde: Record<string, unknown> | null;
  signalGates: Record<string, unknown> | null;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  versionNumber: number;
  label: string | null;
  promotedFrom: string | null;
  /** Set by 3D split (defaults to "SUPERTREND" for legacy rows). */
  primarySignalType: PrimarySignalType;
  /** Typed signal-brain blocks; the block matching `primarySignalType` is authoritative. */
  blocks: StrategyVersionBlocks;
  /** Legacy scalar columns retained for analytics queries; do not write directly. */
  cfgSymbol: string | null;
  cfgTimeframe: string | null;
  cfgStPeriod: number | null;
  cfgStMultiplier: number | null;
  cfgCapitalMode: string | null;
  cfgCapitalFixedUsdt: number | null;
  cfgCapitalPct: number | null;
  cfgTrailingMode: string | null;
  cfgMarketMode: string | null;
  /**
   * Flat bot-config payload the engine consumes. After the 3D split this is the
   * SIGNAL-BRAIN-only flat shape; per-instance operational fields (symbol/risk/
   * capital/etc.) live on `BotInstance.operational` and are merged in at engine
   * boot time.
   */
  cfgRaw: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
}

export interface Strategy {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  tags: string[];
  isArchived: boolean;
  modeId: number | null;
  modeSlug: string | null;
  createdAt: string;
  updatedAt: string;
  latestVersion: StrategyVersion | null;
}

export interface CreateStrategyDto {
  name: string;
  description?: string;
  tags?: string[];
}

export interface StrategyMetaPatch {
  name?: string;
  description?: string | null;
  tags?: string[];
}
