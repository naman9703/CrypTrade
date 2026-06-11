/**
 * Backfill metrics.walkForward on read when the run was saved with walk_forward_split
 * but the worker did not attach train/test (e.g. portfolio runs before the fix).
 */

import { query } from "../../db/query.js";
import { readCandles } from "../data/klineIngest.js";
import { attachWalkForwardMetrics } from "./metrics.js";

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeMetrics(raw) {
  const m = parseJson(raw);
  return m && typeof m === "object" && !Array.isArray(m) ? m : null;
}

/**
 * @param {object} row backtest_runs row
 * @returns {Promise<object>} row with metrics.walkForward when applicable
 */
export async function backfillWalkForwardMetrics(row) {
  if (!row || String(row.status) !== "done") return row;

  const split = parseJson(row.walk_forward_split);
  const trainPct = split?.trainPct;
  if (trainPct == null || !Number.isFinite(Number(trainPct))) return row;

  const metrics = normalizeMetrics(row.metrics) ?? {};
  if (metrics.walkForward?.train && metrics.walkForward?.test) {
    return { ...row, metrics };
  }

  const runId = String(row.id);
  const tf = String(row.timeframe);
  const fromMs = new Date(row.start_date).getTime();
  const toMs = new Date(row.end_date).getTime();
  const startingEquity = Number(row.initial_capital ?? 100);

  const [tradeRes, eqRes] = await Promise.all([
    query(
      `SELECT trade_number, entry_time, exit_time, net_pnl, gross_pnl, fees_usdt,
              funding_paid, slippage_cost, direction
         FROM backtest_trades
        WHERE backtest_run_id = $1
        ORDER BY trade_number`,
      [runId],
    ),
    query(
      `SELECT ts, equity, drawdown_pct
         FROM backtest_equity_points
        WHERE run_id = $1
        ORDER BY ts`,
      [runId],
    ),
  ]);

  const trades = (tradeRes.rows || []).map((r) => ({
    tradeNumber: Number(r.trade_number),
    direction: String(r.direction ?? ""),
    entryTs: new Date(r.entry_time).getTime(),
    exitTs: new Date(r.exit_time).getTime(),
    netPnl: Number(r.net_pnl ?? 0),
    grossPnl: Number(r.gross_pnl ?? 0),
    fees: Number(r.fees_usdt ?? 0),
    fundingPaid: Number(r.funding_paid ?? 0),
    slippageCost: Number(r.slippage_cost ?? 0),
  }));
  if (!trades.length) return { ...row, metrics };

  const equityCurve = (eqRes.rows || []).map((r) => ({
    ts: new Date(r.ts).getTime(),
    equity: Number(r.equity),
    drawdownPct: Number(r.drawdown_pct ?? 0),
  }));

  const symbols = Array.isArray(row.symbols) ? row.symbols.map((s) => String(s).toUpperCase()) : [];
  const timelineSymbol =
    symbols.includes("BTCUSDT") ? "BTCUSDT" : symbols[0] || (row.symbol === "PORTFOLIO" ? "BTCUSDT" : String(row.symbol));

  let timelineCandles = [];
  try {
    timelineCandles = await readCandles(timelineSymbol, tf, fromMs, toMs, { market: "futures" });
  } catch {
    return { ...row, metrics };
  }
  if (!timelineCandles.length) return { ...row, metrics };

  const enriched = attachWalkForwardMetrics(metrics, {
    trades,
    equityCurve,
    timelineCandles,
    trainPct: Number(trainPct),
    tf,
    startingEquity,
  });

  return { ...row, metrics: enriched };
}
