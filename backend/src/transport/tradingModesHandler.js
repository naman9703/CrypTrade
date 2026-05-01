import { getPool } from "../db/pool.js";
import { getAllModes } from "../db/services/modesService.js";

/** Same four rows as `003_modes.sql` seed + `trading_mode` for bot API. */
export const STATIC_TRADING_MODES = [
  { id: 1, slug: "paper", label: "Paper", requires_api: false, is_real_money: false, trading_mode: "PAPER" },
  {
    id: 2,
    slug: "demo_api",
    label: "Demo",
    requires_api: true,
    is_real_money: false,
    trading_mode: "BINANCE_DEMO_API",
  },
  {
    id: 3,
    slug: "testnet",
    label: "Testnet",
    requires_api: true,
    is_real_money: false,
    trading_mode: "BINANCE_TESTNET",
  },
  { id: 4, slug: "live", label: "Live", requires_api: true, is_real_money: true, trading_mode: "BINANCE_LIVE" },
];

/** Public + authenticated callers share this handler. */
export async function sendTradingModesJson(res) {
  try {
    if (getPool()) {
      const modes = await getAllModes();
      return res.json({ ok: true, modes, source: "db" });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "trading_modes_failed",
      message: String(e?.message || e),
    });
  }
  return res.json({ ok: true, modes: STATIC_TRADING_MODES, source: "fallback" });
}
