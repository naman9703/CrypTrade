import type {
  PrimarySignalType,
  Strategy,
  StrategyVersion,
  StrategyVersionBlocks,
} from "../types/strategy";

const PRIMARY_SIGNAL_TYPES: ReadonlySet<PrimarySignalType> = new Set([
  "SUPERTREND",
  "SURF_PULSE_ML",
  "EMA_CROSS",
  "RSI",
  "MANUAL",
]);

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

const EMPTY_BLOCKS: StrategyVersionBlocks = {
  supertrend: null,
  surfPulse: null,
  emaCross: null,
  rsi: null,
  ai: null,
  entry: null,
  exit: null,
  leverage: null,
  mde: null,
  signalGates: null,
};

function mapBlocks(raw: unknown): StrategyVersionBlocks {
  if (!isJsonObject(raw)) return { ...EMPTY_BLOCKS };
  return {
    supertrend: isJsonObject(raw.supertrend) ? raw.supertrend : null,
    surfPulse: isJsonObject(raw.surfPulse) ? raw.surfPulse : null,
    emaCross: isJsonObject(raw.emaCross) ? raw.emaCross : null,
    rsi: isJsonObject(raw.rsi) ? raw.rsi : null,
    ai: isJsonObject(raw.ai) ? raw.ai : null,
    entry: isJsonObject(raw.entry) ? raw.entry : null,
    exit: isJsonObject(raw.exit) ? raw.exit : null,
    leverage: isJsonObject(raw.leverage) ? raw.leverage : null,
    mde: isJsonObject(raw.mde) ? raw.mde : null,
    signalGates: isJsonObject(raw.signalGates) ? raw.signalGates : null,
  };
}

function mapCfgVersion(v: Record<string, unknown> | null | undefined): Partial<StrategyVersion> {
  if (!v || typeof v !== "object") return {};
  const cfg = v as Record<string, unknown>;
  return {
    cfgSymbol: cfg.symbol != null ? String(cfg.symbol) : null,
    cfgTimeframe: cfg.timeframe != null ? String(cfg.timeframe) : null,
    cfgStPeriod: cfg.stPeriod != null && Number.isFinite(Number(cfg.stPeriod)) ? Number(cfg.stPeriod) : null,
    cfgStMultiplier: cfg.stMultiplier != null && Number.isFinite(Number(cfg.stMultiplier)) ? Number(cfg.stMultiplier) : null,
    cfgCapitalMode: cfg.capitalMode != null ? String(cfg.capitalMode) : null,
    cfgCapitalFixedUsdt:
      cfg.capitalFixedUsdt != null && Number.isFinite(Number(cfg.capitalFixedUsdt))
        ? Number(cfg.capitalFixedUsdt)
        : null,
    cfgCapitalPct:
      cfg.capitalPct != null && Number.isFinite(Number(cfg.capitalPct)) ? Number(cfg.capitalPct) : null,
    cfgTrailingMode: cfg.trailingMode != null ? String(cfg.trailingMode) : null,
    cfgMarketMode: cfg.marketMode != null ? String(cfg.marketMode) : null,
  };
}

/** Accept camelCase (Node mappers) or snake_case (raw SQL rows) for version payloads. */
function normalizeStrategyVersionShape(v: Record<string, unknown>): Record<string, unknown> {
  return {
    ...v,
    strategyId: v.strategyId ?? v.strategy_id,
    versionNumber: v.versionNumber ?? v.version_number,
    promotedFrom: v.promotedFrom ?? v.promoted_from,
    cfgRaw: v.cfgRaw ?? v.cfg_raw,
    createdAt: v.createdAt ?? v.created_at,
    createdBy: v.createdBy ?? v.created_by,
    primarySignalType: v.primarySignalType ?? v.primary_signal_type,
    blocks: v.blocks,
  };
}

/** Normalize backend `strategy_versions` row JSON. */
export function mapApiStrategyVersion(raw: unknown): StrategyVersion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = normalizeStrategyVersionShape(raw as Record<string, unknown>);
  const id = v.id != null ? String(v.id) : "";
  if (!id) return null;
  const cfgNested = v.cfg && typeof v.cfg === "object" && !Array.isArray(v.cfg) ? (v.cfg as Record<string, unknown>) : {};
  const fromCfg = mapCfgVersion(cfgNested);
  const cfgRaw =
    v.cfgRaw && typeof v.cfgRaw === "object" && !Array.isArray(v.cfgRaw) ? (v.cfgRaw as Record<string, unknown>) : {};
  const primarySignalType: PrimarySignalType =
    typeof v.primarySignalType === "string" && PRIMARY_SIGNAL_TYPES.has(v.primarySignalType as PrimarySignalType)
      ? (v.primarySignalType as PrimarySignalType)
      : "SUPERTREND";
  return {
    id,
    strategyId: v.strategyId != null ? String(v.strategyId) : "",
    versionNumber: v.versionNumber != null && Number.isFinite(Number(v.versionNumber)) ? Number(v.versionNumber) : 0,
    label: v.label != null ? String(v.label) : null,
    promotedFrom: v.promotedFrom != null ? String(v.promotedFrom) : null,
    primarySignalType,
    blocks: mapBlocks(v.blocks),
    cfgSymbol: fromCfg.cfgSymbol ?? null,
    cfgTimeframe: fromCfg.cfgTimeframe ?? null,
    cfgStPeriod: fromCfg.cfgStPeriod ?? null,
    cfgStMultiplier: fromCfg.cfgStMultiplier ?? null,
    cfgCapitalMode: fromCfg.cfgCapitalMode ?? null,
    cfgCapitalFixedUsdt: fromCfg.cfgCapitalFixedUsdt ?? null,
    cfgCapitalPct: fromCfg.cfgCapitalPct ?? null,
    cfgTrailingMode: fromCfg.cfgTrailingMode ?? null,
    cfgMarketMode: fromCfg.cfgMarketMode ?? null,
    cfgRaw,
    createdAt: v.createdAt != null ? String(v.createdAt) : "",
    createdBy: v.createdBy != null ? String(v.createdBy) : undefined,
  };
}

export function mapApiStrategy(raw: unknown, latestVersion: StrategyVersion | null = null): Strategy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const id = s.id != null ? String(s.id) : "";
  if (!id) return null;
  let lv = latestVersion;
  const embedded = s.latestVersion ?? s.latest_version;
  if (embedded !== undefined) {
    lv = mapApiStrategyVersion(embedded);
  }
  return {
    id,
    userId: s.userId != null ? String(s.userId) : "",
    name: s.name != null ? String(s.name) : "",
    description: s.description != null ? String(s.description) : null,
    tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t)) : [],
    isArchived: Boolean(s.isArchived),
    modeId: s.modeId != null && Number.isFinite(Number(s.modeId)) ? Number(s.modeId) : null,
    modeSlug: s.modeSlug != null ? String(s.modeSlug) : null,
    createdAt: s.createdAt != null ? String(s.createdAt) : "",
    updatedAt: s.updatedAt != null ? String(s.updatedAt) : "",
    latestVersion: lv,
  };
}
