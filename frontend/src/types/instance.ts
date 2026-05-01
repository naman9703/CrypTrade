/** Phase 3C/3D — bot instances + capital allotments + operational config (API is camelCase). */

export type InstanceAllotment = {
  id: string;
  allotmentMode: string;
  configuredUsdt: number;
  configuredPct: number | null;
  reservedUsdt: number;
  status: string;
};

/**
 * Per-deployment operational configuration owned by the instance (3D split).
 * These fields override the strategy version's defaults when the bot boots.
 *
 * Universe is stored as a free-form object on the row to keep schema flexibility.
 */
export type InstanceOperationalConfig = {
  symbol: string | null;
  timeframe: string | null;
  symbolMode: string | null;
  marketMode: string | null;
  universe: Record<string, unknown> | null;
  riskPerTrade: number | null;
  riskUnit: string | null;
  maxDailyLoss: number | null;
  maxDailyLossUnit: string | null;
  capitalMode: string | null;
  capitalUsdt: number | null;
  capitalPct: number | null;
  compoundPnl: boolean | null;
};

/** Patch payload for `PATCH /instances/:id/operational-config` (UI-shape, all optional). */
export type InstanceOperationalPatch = Partial<{
  symbol: string | null;
  timeframe: string | null;
  symbolMode: string | null;
  marketMode: string | null;
  universe: Record<string, unknown> | null;
  riskPerTrade: number | null;
  riskUnit: string | null;
  maxDailyLoss: number | null;
  maxDailyLossUnit: string | null;
  compoundPnl: boolean | null;
}>;

export type BotInstance = {
  id: string;
  accountId: string;
  strategyVersionId: string;
  strategyId: string | null;
  label: string | null;
  status: string;
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastStopReason: string | null;
  errorMessage: string | null;
  totalTrades: number;
  totalPnlUsdt: number;
  createdAt: string | null;
  updatedAt: string | null;
  accountLabel: string | null;
  accountModeSlug: string | null;
  strategyName: string | null;
  strategyVersionNumber: number | null;
  strategyVersionLabel: string | null;
  /** 3D split — operational fields owned by this instance. */
  operational: InstanceOperationalConfig;
  allotment: InstanceAllotment | null;
};

export type InstanceStatusLogEntry = {
  id: string;
  instanceId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  triggeredBy: string;
  metadata: unknown;
  createdAt: string | null;
};

export type CreateInstanceDto = {
  strategyVersionId: string;
  label: string;
  capitalMode: "FIXED" | "PCT";
  capitalUsdt?: number | null;
  capitalPct?: number | null;
  /** Optional operational overrides; omitted fields fall back to strategy defaults. */
  operational?: InstanceOperationalPatch;
};

export type AllotmentHeadroom = {
  availableUsdt: number;
  committedUsdt: number;
  headroomUsdt: number;
};
