export interface FearGreedData {
  value:     number;
  label:     string;
  change24h: number;
}

export interface FundingData {
  current:   number;
  avg30d:    number;
  zscore:    number;
  predicted: number;
  nextTime:  string;
  bias:      string;
}

export interface OpenInterestData {
  usdt:           number;
  change4hPct:    number;
  change24hPct:   number;
  longShortRatio: number;
}

export interface OrderBookData {
  imbalanceRatio: number;
  bidWallUsdt:    number;
  askWallUsdt:    number;
  pressure:       string;
}

export interface OptionsData {
  maxPain:         number;
  maxPainDistance: number;
  putCallRatio:    number;
  impliedVol:      number | null;
  gex:             number;
  gexRegime:       string;
  bias:            string;
}

export interface OnChainData {
  /** Binance futures taker buy−sell imbalance (~−100…+100), not on-chain exchange balance flow. */
  takerFlowImbalancePct: number;
  takerFlowZscore: number;
  takerBuyRatio: number;
  /** CryptoQuant daily netflow × spot (USD); needs `CRYPTOQUANT_API_KEY` on server. */
  cryptoQuantNetflowUsd24h?: number | null;
}

export interface LiquidationData {
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
  dominance: 'longs' | 'shorts' | 'neutral';
  intensity: 'low' | 'moderate' | 'high' | 'extreme';
  windowHours: number;
  lastUpdated: number;
}

export interface NewsImpactData {
  sentiment: number;
  summary?: string;
  model?: string;
  updatedAt?: string;
  headlineSample?: string[];
}

export interface ConfluenceData {
  score:      number;
  /** How many TFs agree with the 15m primary (when defined > 0). */
  agreeing?:  number;
  /** How many TFs had enough bars for a direction read. */
  defined?:   number;
  breakdown:  Record<string, 'up' | 'down' | null>;
  primaryDir: 'up' | 'down' | null;
  bias:       string;
}

export interface VolatilityData {
  realisedVol24h: number | null;
  /** ATM IV annualized % when options collector populated (e.g. BTC/ETH Deribit). */
  impliedVolAnnualPct?: number | null;
  /** IV/RV when both are comparable annualized % points. */
  ivRvRatio?: number | null;
  /** iv_rich | iv_cheap | balanced | unknown */
  ivRelativeRegime?: string;
  volRegime: string;
  adxRegime: string;
  combined: string;
}

export interface IntelligenceSignal {
  name:   string;
  detail: string;
  weight: number;
}

export interface CompositeData {
  composite:      number;
  bias:           string;
  confidence:     number;
  sizeMultiplier: number;
  bullishSignals: IntelligenceSignal[];
  bearishSignals: IntelligenceSignal[];
}

export interface IntelligenceData {
  symbol:       string;
  timestamp:    string;
  fearGreed:    FearGreedData    | null;
  funding:      FundingData      | null;
  openInterest: OpenInterestData | null;
  orderBook:    OrderBookData    | null;
  options:      OptionsData      | null;
  onChain:      OnChainData      | null;
  liquidations?: LiquidationData | null;
  newsImpact?:  NewsImpactData   | null;
  confluence:   ConfluenceData   | null;
  volatility:   VolatilityData   | null;
  composite:    CompositeData;
}
