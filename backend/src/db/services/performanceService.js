import { query } from "../query.js";

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function avg(arr) {
  if (!arr.length) return null;
  const s = arr.reduce((a, b) => a + b, 0);
  return s / arr.length;
}

function stddevSample(arr) {
  if (arr.length < 2) return null;
  const m = avg(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? sd : null;
}

/**
 * @param {Array<{ closed_at: Date|string, net_pnl: unknown }>} rows closed trades ordered by time
 */
function computeDailyPnls(rows) {
  /** @type {Map<string, number>} */
  const byDay = new Map();
  for (const r of rows) {
    const d = new Date(r.closed_at);
    if (!Number.isFinite(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const p = num(r.net_pnl);
    byDay.set(key, (byDay.get(key) || 0) + p);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, pnl]) => pnl);
}

/**
 * Annualised Sharpe on daily PnL samples (mean/std × √365). Spec-aligned; not risk-free adjusted.
 * @param {number[]} dailyPnls
 */
function computeSharpe(dailyPnls) {
  if (dailyPnls.length < 2) return null;
  const m = avg(dailyPnls);
  const sd = stddevSample(dailyPnls);
  if (m == null || sd == null) return null;
  return (m / sd) * Math.sqrt(365);
}

export function emptyMetrics() {
  return {
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate_pct: 0,
    total_pnl_usdt: 0,
    avg_win_usdt: null,
    avg_loss_usdt: null,
    profit_factor: null,
    max_drawdown_usdt: 0,
    max_drawdown_pct: 0,
    sharpe_ratio: null,
    avg_hold_sec: null,
    avg_roi_pct: null,
    rr_ratio: null,
    last_calculated_at: new Date(),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapPerformanceRow(row) {
  if (!row) return null;
  return {
    strategyVersionId: String(row.strategy_version_id),
    totalTrades: Number(row.total_trades ?? 0),
    winningTrades: Number(row.winning_trades ?? 0),
    losingTrades: Number(row.losing_trades ?? 0),
    winRatePct: row.win_rate_pct != null ? Number(row.win_rate_pct) : 0,
    totalPnlUsdt: row.total_pnl_usdt != null ? Number(row.total_pnl_usdt) : 0,
    avgWinUsdt: row.avg_win_usdt != null ? Number(row.avg_win_usdt) : null,
    avgLossUsdt: row.avg_loss_usdt != null ? Number(row.avg_loss_usdt) : null,
    profitFactor: row.profit_factor != null ? Number(row.profit_factor) : null,
    maxDrawdownUsdt: row.max_drawdown_usdt != null ? Number(row.max_drawdown_usdt) : null,
    maxDrawdownPct: row.max_drawdown_pct != null ? Number(row.max_drawdown_pct) : null,
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    avgHoldSec: row.avg_hold_sec != null ? Number(row.avg_hold_sec) : null,
    avgRoiPct: row.avg_roi_pct != null ? Number(row.avg_roi_pct) : null,
    rrRatio: row.rr_ratio != null ? Number(row.rr_ratio) : null,
    lastCalculatedAt: row.last_calculated_at ? new Date(row.last_calculated_at).toISOString() : null,
  };
}

/**
 * @param {string} strategyVersionId
 * @param {ReturnType<typeof emptyMetrics>} m
 */
export async function upsertPerformance(strategyVersionId, m) {
  await query(
    `INSERT INTO strategy_performance (
       strategy_version_id, total_trades, winning_trades, losing_trades, win_rate_pct,
       total_pnl_usdt, avg_win_usdt, avg_loss_usdt, profit_factor,
       max_drawdown_usdt, max_drawdown_pct, sharpe_ratio, avg_hold_sec, avg_roi_pct, rr_ratio,
       last_calculated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (strategy_version_id) DO UPDATE SET
       total_trades = EXCLUDED.total_trades,
       winning_trades = EXCLUDED.winning_trades,
       losing_trades = EXCLUDED.losing_trades,
       win_rate_pct = EXCLUDED.win_rate_pct,
       total_pnl_usdt = EXCLUDED.total_pnl_usdt,
       avg_win_usdt = EXCLUDED.avg_win_usdt,
       avg_loss_usdt = EXCLUDED.avg_loss_usdt,
       profit_factor = EXCLUDED.profit_factor,
       max_drawdown_usdt = EXCLUDED.max_drawdown_usdt,
       max_drawdown_pct = EXCLUDED.max_drawdown_pct,
       sharpe_ratio = EXCLUDED.sharpe_ratio,
       avg_hold_sec = EXCLUDED.avg_hold_sec,
       avg_roi_pct = EXCLUDED.avg_roi_pct,
       rr_ratio = EXCLUDED.rr_ratio,
       last_calculated_at = EXCLUDED.last_calculated_at`,
    [
      strategyVersionId,
      m.total_trades,
      m.winning_trades,
      m.losing_trades,
      m.win_rate_pct,
      m.total_pnl_usdt,
      m.avg_win_usdt,
      m.avg_loss_usdt,
      m.profit_factor,
      m.max_drawdown_usdt,
      m.max_drawdown_pct,
      m.sharpe_ratio,
      m.avg_hold_sec,
      m.avg_roi_pct,
      m.rr_ratio,
      m.last_calculated_at,
    ],
  );
}

/**
 * @param {string} strategyVersionId
 */
export async function recalculateStrategyPerformance(strategyVersionId) {
  const r = await query(
    `SELECT t.net_pnl, t.gross_pnl, t.fees_usdt, t.roi_pct, t.hold_duration_sec, t.exit_reason,
            t.opened_at, t.closed_at, t.notional_usdt
     FROM trades t
     LEFT JOIN bot_instances i ON t.instance_id = i.id
     WHERE t.status = 'closed'
       AND COALESCE(t.strategy_version_id, i.strategy_version_id) = $1
     ORDER BY t.closed_at ASC NULLS LAST, t.created_at ASC`,
    [strategyVersionId],
  );

  const rows = r.rows;
  if (!rows.length) {
    const z = emptyMetrics();
    await upsertPerformance(strategyVersionId, z);
    return mapPerformanceRow({
      strategy_version_id: strategyVersionId,
      total_trades: z.total_trades,
      winning_trades: z.winning_trades,
      losing_trades: z.losing_trades,
      win_rate_pct: z.win_rate_pct,
      total_pnl_usdt: z.total_pnl_usdt,
      avg_win_usdt: z.avg_win_usdt,
      avg_loss_usdt: z.avg_loss_usdt,
      profit_factor: z.profit_factor,
      max_drawdown_usdt: z.max_drawdown_usdt,
      max_drawdown_pct: z.max_drawdown_pct,
      sharpe_ratio: z.sharpe_ratio,
      avg_hold_sec: z.avg_hold_sec,
      avg_roi_pct: z.avg_roi_pct,
      rr_ratio: z.rr_ratio,
      last_calculated_at: z.last_calculated_at,
    });
  }

  const total = rows.length;
  const winners = rows.filter((x) => num(x.net_pnl) > 0);
  const losers = rows.filter((x) => num(x.net_pnl) <= 0);
  const winRate = (winners.length / total) * 100;

  const totalPnl = rows.reduce((s, x) => s + num(x.net_pnl), 0);
  const avgWin = winners.length ? avg(winners.map((x) => num(x.net_pnl))) : null;
  const avgLoss = losers.length ? avg(losers.map((x) => num(x.net_pnl))) : null;

  const grossWins = winners.reduce((s, x) => s + num(x.net_pnl), 0);
  const grossLosses = Math.abs(losers.reduce((s, x) => s + num(x.net_pnl), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;

  let peak = 0;
  let equity = 0;
  let maxDdUsdt = 0;
  let maxDdPct = 0;
  for (const row of rows) {
    equity += num(row.net_pnl);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDdUsdt) maxDdUsdt = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }

  const dailyPnls = computeDailyPnls(rows);
  const sharpe = computeSharpe(dailyPnls);

  const holds = rows.map((x) => x.hold_duration_sec).filter((x) => x != null && Number.isFinite(Number(x)));
  const avgHoldSec = holds.length ? Math.round(avg(holds.map((x) => Number(x)))) : null;
  const rois = rows.map((x) => x.roi_pct).filter((x) => x != null && Number.isFinite(Number(x)));
  const avgRoi = rois.length ? avg(rois.map((x) => Number(x))) : null;
  const rrRatio =
    avgWin != null && avgLoss != null && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  const metrics = {
    total_trades: total,
    winning_trades: winners.length,
    losing_trades: losers.length,
    win_rate_pct: winRate,
    total_pnl_usdt: totalPnl,
    avg_win_usdt: avgWin,
    avg_loss_usdt: avgLoss,
    profit_factor: profitFactor,
    max_drawdown_usdt: maxDdUsdt,
    max_drawdown_pct: maxDdPct,
    sharpe_ratio: sharpe,
    avg_hold_sec: avgHoldSec,
    avg_roi_pct: avgRoi,
    rr_ratio: rrRatio,
    last_calculated_at: new Date(),
  };

  await upsertPerformance(strategyVersionId, metrics);
  return mapPerformanceRow({
    strategy_version_id: strategyVersionId,
    total_trades: metrics.total_trades,
    winning_trades: metrics.winning_trades,
    losing_trades: metrics.losing_trades,
    win_rate_pct: metrics.win_rate_pct,
    total_pnl_usdt: metrics.total_pnl_usdt,
    avg_win_usdt: metrics.avg_win_usdt,
    avg_loss_usdt: metrics.avg_loss_usdt,
    profit_factor: metrics.profit_factor,
    max_drawdown_usdt: metrics.max_drawdown_usdt,
    max_drawdown_pct: metrics.max_drawdown_pct,
    sharpe_ratio: metrics.sharpe_ratio,
    avg_hold_sec: metrics.avg_hold_sec,
    avg_roi_pct: metrics.avg_roi_pct,
    rr_ratio: metrics.rr_ratio,
    last_calculated_at: metrics.last_calculated_at,
  });
}

/**
 * @param {string} strategyVersionId
 */
export async function getEquityCurve(strategyVersionId) {
  const result = await query(
    `SELECT t.closed_at, t.net_pnl, t.exit_reason, t.symbol, t.direction
     FROM trades t
     LEFT JOIN bot_instances i ON t.instance_id = i.id
     WHERE COALESCE(t.strategy_version_id, i.strategy_version_id) = $1
       AND t.status = 'closed'
     ORDER BY t.closed_at ASC NULLS LAST, t.created_at ASC`,
    [strategyVersionId],
  );

  let equity = 0;
  let peak = 0;
  return result.rows.map((r) => {
    equity += num(r.net_pnl);
    if (equity > peak) peak = equity;
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    return {
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      netPnl: num(r.net_pnl),
      runningEquity: equity,
      drawdownPct,
      exitReason: r.exit_reason != null ? String(r.exit_reason) : null,
      symbol: String(r.symbol ?? ""),
      direction: String(r.direction ?? ""),
    };
  });
}

/**
 * @param {string} strategyId
 */
export async function getPerformanceRowsForStrategy(strategyId) {
  const r = await query(
    `SELECT sv.id AS strategy_version_id, sv.version_number, sv.label,
            sp.total_trades, sp.winning_trades, sp.losing_trades, sp.win_rate_pct,
            sp.total_pnl_usdt, sp.avg_win_usdt, sp.avg_loss_usdt, sp.profit_factor,
            sp.max_drawdown_usdt, sp.max_drawdown_pct, sp.sharpe_ratio, sp.avg_hold_sec, sp.avg_roi_pct,
            sp.rr_ratio, sp.last_calculated_at
     FROM strategy_versions sv
     LEFT JOIN strategy_performance sp ON sp.strategy_version_id = sv.id
     WHERE sv.strategy_id = $1
     ORDER BY sv.version_number ASC`,
    [strategyId],
  );
  return r.rows.map((row) => ({
    versionId: String(row.strategy_version_id),
    versionNumber: Number(row.version_number),
    label: row.label != null ? String(row.label) : null,
    metrics: mapPerformanceRow({
      strategy_version_id: row.strategy_version_id,
      total_trades: row.total_trades ?? 0,
      winning_trades: row.winning_trades ?? 0,
      losing_trades: row.losing_trades ?? 0,
      win_rate_pct: row.win_rate_pct ?? 0,
      total_pnl_usdt: row.total_pnl_usdt ?? 0,
      avg_win_usdt: row.avg_win_usdt,
      avg_loss_usdt: row.avg_loss_usdt,
      profit_factor: row.profit_factor,
      max_drawdown_usdt: row.max_drawdown_usdt,
      max_drawdown_pct: row.max_drawdown_pct,
      sharpe_ratio: row.sharpe_ratio,
      avg_hold_sec: row.avg_hold_sec,
      avg_roi_pct: row.avg_roi_pct,
      rr_ratio: row.rr_ratio,
      last_calculated_at: row.last_calculated_at,
    }),
  }));
}

/**
 * @param {string} userId
 * @param {string} modeSlug normalized e.g. paper | demo_api
 */
export async function listPerformanceCompareForUserMode(userId, modeSlug) {
  const r = await query(
    `SELECT s.id AS strategy_id, s.name AS strategy_name,
            sv.id AS version_id, sv.version_number, sv.label,
            sp.total_trades, sp.winning_trades, sp.losing_trades, sp.win_rate_pct,
            sp.total_pnl_usdt, sp.avg_win_usdt, sp.avg_loss_usdt, sp.profit_factor,
            sp.max_drawdown_usdt, sp.max_drawdown_pct, sp.sharpe_ratio, sp.avg_hold_sec, sp.avg_roi_pct,
            sp.rr_ratio, sp.last_calculated_at
     FROM strategies s
     JOIN strategy_versions sv ON sv.strategy_id = s.id
     LEFT JOIN trading_modes tm ON tm.id = s.mode_id
     LEFT JOIN strategy_performance sp ON sp.strategy_version_id = sv.id
     WHERE s.user_id = $1
       AND (tm.slug = $2 OR s.mode_id IS NULL)
       AND s.is_archived = false
     ORDER BY s.name ASC, sv.version_number ASC`,
    [userId, modeSlug],
  );
  return r.rows.map((row) => ({
    strategyId: String(row.strategy_id),
    strategyName: String(row.strategy_name),
    versionId: String(row.version_id),
    versionNumber: Number(row.version_number),
    label: row.label != null ? String(row.label) : null,
    metrics: mapPerformanceRow({
      strategy_version_id: row.version_id,
      total_trades: row.total_trades ?? 0,
      winning_trades: row.winning_trades ?? 0,
      losing_trades: row.losing_trades ?? 0,
      win_rate_pct: row.win_rate_pct ?? 0,
      total_pnl_usdt: row.total_pnl_usdt ?? 0,
      avg_win_usdt: row.avg_win_usdt,
      avg_loss_usdt: row.avg_loss_usdt,
      profit_factor: row.profit_factor,
      max_drawdown_usdt: row.max_drawdown_usdt,
      max_drawdown_pct: row.max_drawdown_pct,
      sharpe_ratio: row.sharpe_ratio,
      avg_hold_sec: row.avg_hold_sec,
      avg_roi_pct: row.avg_roi_pct,
      rr_ratio: row.rr_ratio,
      last_calculated_at: row.last_calculated_at,
    }),
  }));
}

export async function recalculateAllStrategyPerformance() {
  const r = await query(`SELECT id FROM strategy_versions`);
  const errors = [];
  let processed = 0;
  for (const row of r.rows) {
    try {
      await recalculateStrategyPerformance(String(row.id));
      processed++;
    } catch (e) {
      errors.push({ versionId: String(row.id), error: String(e?.message || e) });
    }
  }
  return { processed, errors };
}
