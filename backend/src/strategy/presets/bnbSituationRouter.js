/**
 * BNB 15m Situation Router — data-driven multi-playbook preset.
 * Route table: backend/scripts/bnb-situation-route-table.json (from year study).
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.resolve(__dirname, "../../../scripts/bnb-situation-route-table.json");

export const BNB_SITUATION_ROUTER_15M = {
  symbol: "BNBUSDT",
  timeframe: "15m",
  manualStrategy: "SITUATION_INTRADAY",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2,
  riskPerTradeUnit: "PCT",
  situationMaxTradesPerDay: 2,
  situationMinBarGap: 4,
  situationMinScore: 7,
  situationMaxLossStreak: 2,
  situationMaxExhaustionPerDay: 2,
  situationExhaustionMinBarsFromOpen: 20,
  situationMaxDayRangeAtEntry: 0.05,
  situationMaxAdx: 70,
  situationPhaseLock: true,
  situationRouteTablePath: ROUTE_PATH,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
};
