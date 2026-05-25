/**
 * Persistence helpers for the simulator: write trades, equity curve, and the
 * final metrics blob back to Postgres. Trade rows match the schema added by
 * migration 026 (gross_pnl / fees / funding_paid / slippage_cost / net_pnl,
 * mae_pct / mfe_pct, intel_score_at_entry, gate_action).
 */

import { query, withTransaction } from "../../db/query.js";

const MAX_EQUITY_INSERT_ROWS = 5000;

/**
 * Downsample the equity curve for bulk insert. Postgres forbids the same conflict
 * key `(run_id, ts)` appearing twice in one `INSERT … ON CONFLICT DO UPDATE` batch
 * ("cannot affect row a second time"). We dedupe by bar timestamp (last sample wins).
 *
 * @param {Array<{ts:number,equity:number,drawdownPct?:number}>} curve
 */
function sampleEquityPointsForInsert(curve) {
  if (!curve?.length) return [];
  const stride = Math.max(1, Math.ceil(curve.length / MAX_EQUITY_INSERT_ROWS));
  const idxs = new Set();
  for (let i = 0; i < curve.length; i += stride) idxs.add(i);
  idxs.add(curve.length - 1);
  const byTs = new Map();
  for (const i of [...idxs].sort((a, b) => a - b)) {
    const p = curve[i];
    const ts = Number(p.ts);
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, p);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
}

function buildEquityBulkInsert(runId, points) {
  if (!points.length) return null;
  const rows = [];
  const params = [];
  for (const p of points) {
    const base = params.length;
    params.push(runId, new Date(Number(p.ts)), Number(p.equity), Number(p.drawdownPct ?? 0));
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  }
  const sql = `
    INSERT INTO backtest_equity_points (run_id, ts, equity, drawdown_pct)
    VALUES ${rows.join(", ")}
    ON CONFLICT (run_id, ts) DO UPDATE
      SET equity = EXCLUDED.equity, drawdown_pct = EXCLUDED.drawdown_pct
  `;
  return { sql, params };
}

/**
 * Insert all trades for a run in a single multi-row INSERT.
 * @param {string} runId
 * @param {string} symbol
 * @param {Array<Object>} trades
 */
export async function insertTrades(runId, symbol, trades) {
  if (!trades?.length) return 0;
  const cols = [
    "backtest_run_id",
    "trade_number",
    "symbol",
    "direction",
    "entry_time",
    "exit_time",
    "entry_price",
    "exit_price",
    "quantity",
    "sl_price",
    "tp_price",
    "exit_reason",
    "gross_pnl",
    "fees_usdt",
    "net_pnl",
    "roi_pct",
    "mae",
    "mfe",
    "signal_context",
    "funding_paid",
    "slippage_cost",
    "bars_held",
    "mae_pct",
    "mfe_pct",
    "intel_score_at_entry",
    "gate_action",
  ];
  const params = [];
  const rows = [];
  for (const t of trades) {
    const base = params.length;
    params.push(
      runId,
      Number(t.tradeNumber),
      symbol,
      String(t.direction),
      new Date(Number(t.entryTs)),
      new Date(Number(t.exitTs)),
      Number(t.entryPrice),
      Number(t.exitPrice),
      Number(t.qty),
      t.slPrice != null ? Number(t.slPrice) : null,
      t.tpPrice != null ? Number(t.tpPrice) : null,
      String(t.exitReason ?? ""),
      Number(t.grossPnl ?? 0),
      Number(t.fees ?? 0),
      Number(t.netPnl ?? 0),
      Number(t.netPnl ?? 0),
      null,
      null,
      JSON.stringify({
        intelScoreAtEntry: t.intelScoreAtEntry ?? null,
        gateAction: t.gateAction ?? null,
        trailStep: t.trailStep ?? 0,
        trailTierLabel: t.trailTierLabel ?? null,
        equityAtEntry: t.equityAtEntry ?? null,
        marginUsdt: t.marginUsdt ?? null,
        entryQuality: t.entryQuality ?? null,
        lossPattern: t.lossPattern ?? null,
      }),
      Number(t.fundingPaid ?? 0),
      Number(t.slippageCost ?? 0),
      Number(t.barsHeld ?? 0),
      t.maePct != null ? Number(t.maePct) * 100 : null,
      t.mfePct != null ? Number(t.mfePct) * 100 : null,
      t.intelScoreAtEntry != null ? Number(t.intelScoreAtEntry) : null,
      String(t.gateAction ?? "pass"),
    );
    const ph = cols.map((_, j) => `$${base + j + 1}`).join(",");
    rows.push(`(${ph})`);
  }
  const sql = `
    INSERT INTO backtest_trades (${cols.join(", ")})
    VALUES ${rows.join(", ")}
  `;
  const r = await query(sql, params);
  return r.rowCount ?? 0;
}

/**
 * Bulk insert equity points. Downsamples internally to <= 5000 rows so the
 * chart endpoint can stream them without further aggregation.
 * @param {string} runId
 * @param {Array<{ts:number,equity:number,drawdownPct:number}>} curve
 */
export async function insertEquityCurve(runId, curve) {
  const points = sampleEquityPointsForInsert(curve);
  const bulk = buildEquityBulkInsert(runId, points);
  if (!bulk) return 0;
  const r = await query(bulk.sql, bulk.params);
  return r.rowCount ?? 0;
}

/**
 * Atomically write run results: status=done, metrics, totals, and (in the same tx)
 * the trade list + equity curve. Anything that fails rolls back.
 * @param {Object} args
 */
export async function finalizeRun(args) {
  const {
    runId,
    symbol,
    metrics,
    trades,
    equityCurve,
    finalEquity,
    coveragePct,
  } = args;
  await withTransaction(async (client) => {
    if (trades.length) {
      await insertTradesInTx(client, runId, symbol, trades);
    }
    if (equityCurve.length) {
      await insertEquityInTx(client, runId, equityCurve);
    }
    await client.query(
      `UPDATE backtest_runs
         SET status = 'done',
             progress_pct = 100,
             total_trades = $2,
             win_rate_pct = $3,
             total_pnl_usdt = $4,
             max_drawdown_pct = $5,
             sharpe_ratio = $6,
             profit_factor = $7,
             metrics = $8,
             final_capital = $9,
             data_coverage_pct = $10,
             completed_at = NOW(),
             finished_at = NOW()
       WHERE id = $1`,
      [
        runId,
        Number(metrics.totalTrades ?? 0),
        Number((metrics.winRate ?? 0) * 100),
        Number(metrics.totalNetPnl ?? 0),
        Number(metrics.maxDrawdownPct ?? 0),
        Number(metrics.sharpe ?? 0),
        Number(metrics.profitFactor ?? 0),
        JSON.stringify(metrics),
        Number(finalEquity),
        coveragePct != null ? Number(coveragePct) : null,
      ],
    );
  });
}

async function insertTradesInTx(client, runId, symbol, trades) {
  const sql = (await import("util")).format;
  void sql;
  const cols = [
    "backtest_run_id",
    "trade_number",
    "symbol",
    "direction",
    "entry_time",
    "exit_time",
    "entry_price",
    "exit_price",
    "quantity",
    "sl_price",
    "tp_price",
    "exit_reason",
    "gross_pnl",
    "fees_usdt",
    "net_pnl",
    "roi_pct",
    "signal_context",
    "funding_paid",
    "slippage_cost",
    "bars_held",
    "mae_pct",
    "mfe_pct",
    "intel_score_at_entry",
    "gate_action",
  ];
  const rows = [];
  const params = [];
  for (const t of trades) {
    const base = params.length;
    params.push(
      runId,
      Number(t.tradeNumber),
      symbol,
      String(t.direction),
      new Date(Number(t.entryTs)),
      new Date(Number(t.exitTs)),
      Number(t.entryPrice),
      Number(t.exitPrice),
      Number(t.qty),
      t.slPrice != null ? Number(t.slPrice) : null,
      t.tpPrice != null ? Number(t.tpPrice) : null,
      String(t.exitReason ?? ""),
      Number(t.grossPnl ?? 0),
      Number(t.fees ?? 0),
      Number(t.netPnl ?? 0),
      Number(t.netPnl ?? 0),
      JSON.stringify({
        intelScoreAtEntry: t.intelScoreAtEntry ?? null,
        gateAction: t.gateAction ?? null,
        trailStep: t.trailStep ?? 0,
        trailTierLabel: t.trailTierLabel ?? null,
        equityAtEntry: t.equityAtEntry ?? null,
        marginUsdt: t.marginUsdt ?? null,
        entryQuality: t.entryQuality ?? null,
        lossPattern: t.lossPattern ?? null,
      }),
      Number(t.fundingPaid ?? 0),
      Number(t.slippageCost ?? 0),
      Number(t.barsHeld ?? 0),
      t.maePct != null ? Number(t.maePct) * 100 : null,
      t.mfePct != null ? Number(t.mfePct) * 100 : null,
      t.intelScoreAtEntry != null ? Number(t.intelScoreAtEntry) : null,
      String(t.gateAction ?? "pass"),
    );
    rows.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(",")})`);
  }
  const insSql = `INSERT INTO backtest_trades (${cols.join(", ")}) VALUES ${rows.join(", ")}`;
  await client.query(insSql, params);
}

async function insertEquityInTx(client, runId, curve) {
  const points = sampleEquityPointsForInsert(curve);
  const bulk = buildEquityBulkInsert(runId, points);
  if (!bulk) return;
  await client.query(bulk.sql, bulk.params);
}

/** Mark a run failed with the error string visible in the UI. */
export async function failRun(runId, error) {
  await query(
    `UPDATE backtest_runs
       SET status = 'failed',
           error_message = $2,
           finished_at = NOW(),
           completed_at = NOW()
     WHERE id = $1`,
    [runId, String(error?.message ?? error ?? "unknown_error").slice(0, 1000)],
  );
}

/** Mark a run cancelled cleanly when the runner observes shouldCancel. */
export async function cancelRun(runId) {
  await query(
    `UPDATE backtest_runs
       SET status = 'cancelled',
           finished_at = NOW(),
           completed_at = NOW()
     WHERE id = $1
       AND status IN ('queued','running')`,
    [runId],
  );
}

/** Idempotent transition queued → running with started_at = now(). */
export async function markRunning(runId) {
  await query(
    `UPDATE backtest_runs
       SET status = 'running', started_at = COALESCE(started_at, NOW())
     WHERE id = $1
       AND status IN ('queued','running')`,
    [runId],
  );
}

/** Update progress % only when it actually changes. */
export async function updateProgress(runId, pct) {
  await query(
    `UPDATE backtest_runs
       SET progress_pct = $2
     WHERE id = $1
       AND status IN ('queued','running')
       AND COALESCE(progress_pct, 0) <> $2`,
    [runId, Number(pct)],
  );
}
