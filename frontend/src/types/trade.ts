/** Phase 3E — persisted trades per instance (API camelCase). */

export type TradeFill = {
  id: string;
  tradeId: string;
  binanceOrderId: string;
  binanceTradeId: string | null;
  fillType: string;
  side: string;
  price: number;
  quantity: number;
  feeAsset: string | null;
  feeAmount: number | null;
  feeUsdt: number | null;
  isMaker: boolean | null;
  filledAt: string | null;
};

export type Trade = {
  id: string;
  instanceId: string;
  signalId: string | null;
  strategyVersionId: string | null;
  symbol: string;
  marketType: string;
  direction: string;
  status: string;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number | null;
  notionalUsdt: number | null;
  leverage: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  feesUsdt: number | null;
  netPnl: number | null;
  roiPct: number | null;
  holdDurationSec: number | null;
  binanceOrderIds: string[] | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  fills?: TradeFill[];
};
