/** Path segment for `/api/trading-modes/:slug/accounts` — matches `trading_modes.slug` in Postgres. */
export type ApiTradingModeSlug = "paper" | "demo_api" | "testnet" | "live";

export function tradingModeToApiModeSlug(mode: string | undefined): ApiTradingModeSlug {
  const m = String(mode || "PAPER").toUpperCase();
  const map: Record<string, ApiTradingModeSlug> = {
    PAPER: "paper",
    BINANCE_DEMO_API: "demo_api",
    BINANCE_TESTNET: "testnet",
    BINANCE_LIVE: "live",
  };
  return map[m] ?? "paper";
}

export function apiModeSlugToModeLabel(slug: ApiTradingModeSlug): string {
  switch (slug) {
    case "live":
      return "LIVE";
    case "testnet":
      return "TESTNET";
    case "demo_api":
      return "DEMO";
    default:
      return "PAPER";
  }
}
