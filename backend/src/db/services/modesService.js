import { query } from "../query.js";

/** @typedef {{ id: number, slug: string, label: string, requires_api: boolean, is_real_money: boolean, trading_mode: string }} TradingModeRow */

const SLUG_TO_ENGINE = {
  paper: "PAPER",
  demo_api: "BINANCE_DEMO_API",
  testnet: "BINANCE_TESTNET",
  live: "BINANCE_LIVE",
};

function rowWithEngine(r) {
  const trading_mode = SLUG_TO_ENGINE[r.slug] || null;
  return { ...r, trading_mode };
}

export async function getAllModes() {
  const result = await query(
    `SELECT id, slug, label, requires_api, is_real_money
     FROM trading_modes
     ORDER BY id`,
  );
  return result.rows.map(rowWithEngine);
}

/** @param {string} slug */
export async function getModeBySlug(slug) {
  const result = await query(`SELECT * FROM trading_modes WHERE slug = $1`, [slug]);
  const r = result.rows[0];
  return r ? rowWithEngine(r) : null;
}
