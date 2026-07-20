export type StrategyUsageInstance = {
  id: string;
  label: string | null;
  status: string;
  modeSlug: string;
  strategyId: string;
  openTrades: number;
};

export type StrategyUsageContext = {
  strategyId: string;
  instanceCount: number;
  shared: boolean;
  instances: StrategyUsageInstance[];
  otherInstancesBusy: boolean;
  canSaveInPlace: boolean;
  canRename: boolean;
  blockReason: string | null;
  renameBlockReason: string | null;
};
