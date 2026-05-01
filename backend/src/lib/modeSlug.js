/** DB `trading_modes.slug` values (see migration 003). */
const DB_SLUGS = new Set(["paper", "demo_api", "testnet", "live"]);

const ALIASES = {
  PAPER: "paper",
  BINANCE_DEMO_API: "demo_api",
  BINANCE_DEMO: "demo_api",
  BINANCE_TESTNET: "testnet",
  BINANCE_FUTURES_TESTNET: "testnet",
  BINANCE_LIVE: "live",
};

/**
 * Normalize `:modeSlug` from HTTP routes to a DB trading_modes.slug.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeModeSlugParam(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!s) return null;
  if (DB_SLUGS.has(s)) return s;
  const up = String(raw || "").trim().toUpperCase();
  const mapped = ALIASES[up];
  return mapped && DB_SLUGS.has(mapped) ? mapped : null;
}
