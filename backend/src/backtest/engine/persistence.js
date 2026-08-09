/**
 * Persistence helpers for the simulator: write trades, equity curve, and the
 * final metrics blob back to Postgres. Trade rows match the schema added by
 * migration 026 (gross_pnl / fees / funding_paid / slippage_cost / net_pnl,
 * mae_pct / mfe_pct, intel_score_at_entry, gate_action).
 */

import { query, withTransaction } from "../../db/query.js";

const MAX_EQUITY_INSERT_ROWS = 5000;
/** Max rows per UNNEST batch (bind param count = column count, not rows × cols). */
const UNNEST_INSERT_CHUNK = 2000;

/** Drop duplicate trade_number rows before persist (keeps first). */
function dedupeTradesForPersist(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const t of trades) {
    const n = Number(t?.tradeNumber);
    const key = Number.isFinite(n) ? n : String(t?.tradeNumber ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Postgres NUMERIC(p,s) max representable value (signed). */
function clampNumeric(value, precision, scale) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const max = 10 ** (precision - scale) - 10 ** -scale;
  return Math.max(-max, Math.min(max, v));
}

/** Sizing metadata persisted on `signal_context`. */
function tradeSizingContext(t) {
  return {
    leverageCapped: t.leverageCapped === true ? true : t.leverageCapped === false ? false : null,
    allotmentCapped: t.allotmentCapped === true ? true : t.allotmentCapped === false ? false : null,
    effectiveLeverage:
      t.effectiveLeverage != null && Number.isFinite(Number(t.effectiveLeverage)) ? Number(t.effectiveLeverage) : null,
    marginCapUsdt: t.marginCapUsdt != null && Number.isFinite(Number(t.marginCapUsdt)) ? Number(t.marginCapUsdt) : null,
    allowedPoolUsdt:
      t.allowedPoolUsdt != null && Number.isFinite(Number(t.allowedPoolUsdt)) ? Number(t.allowedPoolUsdt) : null,
  };
}

function tradeSignalContextObject(t) {
  return {
    intelScoreAtEntry: t.intelScoreAtEntry ?? null,
    gateAction: t.gateAction ?? null,
    trailStep: t.trailStep ?? 0,
    trailTierLabel: t.trailTierLabel ?? null,
    trailEvents:
      Array.isArray(t.trailEvents) && t.trailEvents.length
        ? t.trailEvents.map((ev) => ({
            ts: ev.ts != null ? Number(ev.ts) : null,
            step: ev.step != null ? Number(ev.step) : 0,
            tierLabel: ev.tierLabel != null ? String(ev.tierLabel) : null,
            slPrice: ev.slPrice != null && Number.isFinite(Number(ev.slPrice)) ? Number(ev.slPrice) : null,
            favorablePx:
              ev.favorablePx != null && Number.isFinite(Number(ev.favorablePx)) ? Number(ev.favorablePx) : null,
            nextActivationPx:
              ev.nextActivationPx != null && Number.isFinite(Number(ev.nextActivationPx))
                ? Number(ev.nextActivationPx)
                : null,
          }))
        : null,
    equityAtEntry: t.equityAtEntry ?? null,
    marginUsdt: t.marginUsdt ?? null,
    initialSlPrice: t.initialSlPrice != null && Number.isFinite(Number(t.initialSlPrice)) ? Number(t.initialSlPrice) : null,
    initialRiskUsd: t.initialRiskUsd != null && Number.isFinite(Number(t.initialRiskUsd)) ? Number(t.initialRiskUsd) : null,
    entryQuality: t.entryQuality ?? null,
    lossPattern: t.lossPattern ?? null,
    entryReason: t.entryReason ?? null,
    entryBarTs: t.entryBarTs != null ? Number(t.entryBarTs) : null,
    entryFillTs: t.entryFillTs != null ? Number(t.entryFillTs) : null,
    entrySameBar: t.entrySameBar === true ? true : t.entrySameBar === false ? false : null,
    entryMarkPx: t.entryMarkPx != null && Number.isFinite(Number(t.entryMarkPx)) ? Number(t.entryMarkPx) : null,
    exitFillTs: t.exitFillTs != null ? Number(t.exitFillTs) : null,
    liq: t.liqContext && typeof t.liqContext === "object" ? t.liqContext : null,
    ...tradeSizingContext(t),
  };
}

function tradeRowParams(runId, symbol, t, { includeMaeMfe = false } = {}) {
  const row = [
    runId,
    Number(t.tradeNumber),
    String(t.symbol ?? symbol),
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
    clampNumeric(tradeRoiPct(t), 10, 4),
  ];
  if (includeMaeMfe) row.push(null, null);
  row.push(
    tradeSignalContextObject(t),
    Number(t.fundingPaid ?? 0),
    Number(t.slippageCost ?? 0),
    Number(t.barsHeld ?? 0),
    t.maePct != null ? clampNumeric(Number(t.maePct) * 100, 10, 4) : null,
    t.mfePct != null ? clampNumeric(Number(t.mfePct) * 100, 10, 4) : null,
    t.intelScoreAtEntry != null ? clampNumeric(t.intelScoreAtEntry, 6, 2) : null,
    String(t.gateAction ?? "pass"),
  );
  return row;
}

function buildTradesBulkInsert(runId, symbol, trades, { includeMaeMfe = false } = {}) {
  if (!trades.length) return null;
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
  ];
  if (includeMaeMfe) cols.push("mae", "mfe");
  cols.push(
    "signal_context",
    "funding_paid",
    "slippage_cost",
    "bars_held",
    "mae_pct",
    "mfe_pct",
    "intel_score_at_entry",
    "gate_action",
  );

  /** @type {unknown[][]} */
  const arrays = cols.map(() => []);
  for (const t of trades) {
    const row = tradeRowParams(runId, symbol, t, { includeMaeMfe });
    for (let i = 0; i < row.length; i++) arrays[i].push(row[i]);
  }

  const casts = [
    "uuid[]",
    "int[]",
    "text[]",
    "text[]",
    "timestamptz[]",
    "timestamptz[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
    "text[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
  ];
  if (includeMaeMfe) casts.push("numeric[]", "numeric[]");
  casts.push(
    "jsonb[]",
    "numeric[]",
    "numeric[]",
    "int[]",
    "numeric[]",
    "numeric[]",
    "numeric[]",
    "text[]",
  );

  const unnest = casts.map((cast, i) => `$${i + 1}::${cast}`).join(", ");
  const sql = `INSERT INTO backtest_trades (${cols.join(", ")}) SELECT * FROM UNNEST(${unnest})`;
  return { sql, params: arrays };
}

/** ROI % for backtest_trades.roi_pct — margin-based, not dollar PnL. */
function tradeRoiPct(t) {
  const net = Number(t.netPnl ?? 0);
  const margin = Number(t.marginUsdt);
  if (Number.isFinite(margin) && margin > 0) return (net / margin) * 100;
  const eq = Number(t.equityAtEntry);
  if (Number.isFinite(eq) && eq > 0) return (net / eq) * 100;
  return null;
}

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
  const runIds = [];
  const tss = [];
  const equities = [];
  const drawdowns = [];
  for (const p of points) {
    runIds.push(runId);
    tss.push(new Date(Number(p.ts)));
    equities.push(Number(p.equity));
    drawdowns.push(clampNumeric(p.drawdownPct ?? 0, 8, 4) ?? 0);
  }
  const sql = `
    INSERT INTO backtest_equity_points (run_id, ts, equity, drawdown_pct)
    SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[], $3::numeric[], $4::numeric[])
    ON CONFLICT (run_id, ts) DO UPDATE
      SET equity = EXCLUDED.equity, drawdown_pct = EXCLUDED.drawdown_pct
  `;
  return { sql, params: [runIds, tss, equities, drawdowns] };
}

async function execBulkChunks(client, buildFn, items, buildArgs, chunkSize = UNNEST_INSERT_CHUNK) {
  let inserted = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const bulk = buildFn(...buildArgs, slice);
    if (!bulk) continue;
    const r = await client.query(bulk.sql, bulk.params);
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Insert all trades for a run in a single multi-row INSERT.
 * @param {string} runId
 * @param {string} symbol
 * @param {Array<Object>} trades
 */
export async function insertTrades(runId, symbol, trades) {
  if (!trades?.length) return 0;
  let inserted = 0;
  for (let i = 0; i < trades.length; i += UNNEST_INSERT_CHUNK) {
    const slice = trades.slice(i, i + UNNEST_INSERT_CHUNK);
    const bulk = buildTradesBulkInsert(runId, symbol, slice, { includeMaeMfe: true });
    if (!bulk) continue;
    const r = await query(bulk.sql, bulk.params);
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Bulk insert equity points. Downsamples internally to <= 5000 rows so the
 * chart endpoint can stream them without further aggregation.
 * @param {string} runId
 * @param {Array<{ts:number,equity:number,drawdownPct:number}>} curve
 */
export async function insertEquityCurve(runId, curve) {
  const points = sampleEquityPointsForInsert(curve);
  if (!points.length) return 0;
  let inserted = 0;
  for (let i = 0; i < points.length; i += UNNEST_INSERT_CHUNK) {
    const slice = points.slice(i, i + UNNEST_INSERT_CHUNK);
    const bulk = buildEquityBulkInsert(runId, slice);
    if (!bulk) continue;
    const r = await query(bulk.sql, bulk.params);
    inserted += r.rowCount ?? 0;
  }
  return inserted;
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
    // Serialize finalize for this run (prevents concurrent double-insert races).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [String(runId)]);
    // Idempotent: dual workers / recover-requeue can finalize the same run twice.
    await client.query(`DELETE FROM backtest_trades WHERE backtest_run_id = $1`, [runId]);
    await client.query(`DELETE FROM backtest_equity_points WHERE run_id = $1`, [runId]);
    const uniqueTrades = dedupeTradesForPersist(trades);
    if (uniqueTrades.length) {
      await insertTradesInTx(client, runId, symbol, uniqueTrades);
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
        clampNumeric((metrics.winRate ?? 0) * 100, 6, 2) ?? 0,
        Number(metrics.totalNetPnl ?? 0),
        clampNumeric(metrics.maxDrawdownPct ?? 0, 6, 2) ?? 0,
        clampNumeric(metrics.sharpe ?? 0, 8, 4) ?? 0,
        clampNumeric(metrics.profitFactor ?? 0, 10, 4) ?? 0,
        JSON.stringify(metrics),
        Number(finalEquity),
        coveragePct != null ? Number(coveragePct) : null,
      ],
    );
  });
}

async function insertTradesInTx(client, runId, symbol, trades) {
  await execBulkChunks(
    client,
    (rid, sym, slice) => buildTradesBulkInsert(rid, sym, slice),
    trades,
    [runId, symbol],
  );
}

async function insertEquityInTx(client, runId, curve) {
  const points = sampleEquityPointsForInsert(curve);
  await execBulkChunks(client, (rid, slice) => buildEquityBulkInsert(rid, slice), points, [runId]);
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
