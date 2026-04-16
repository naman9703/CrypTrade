/** Dispatched from ChartPanel when Supertrend buy/sell chime plays (chart marker, not server Activity). */
export const CLIENT_SUPERTREND_CHIME_EVENT = "client-supertrend-chime";

export type ClientSupertrendChimeDetail = {
  side: "buy" | "sell";
  /** Chart bar time (seconds, UTC epoch seconds as used by lightweight-charts). */
  barTimeSec: number;
  symbol: string;
  timeframe: string;
};
