import { query } from '../query.js';

function clampDays(d) {
  const x = Math.floor(Number(d) || 90);
  return Math.min(730, Math.max(7, x));
}

/**
 * @param {{ net_pnl: unknown }[]} rows
 */
function computeEdge(rows) {
  const nets = rows.map((r) => Number(r.net_pnl)).filter((x) => Number.isFinite(x));
  const n = nets.length;
  if (!n) {
    return {
      tradeCount: 0,
      winRatePct: null,
      expectancyUsdt: null,
      profitFactor: null,
      avgWinUsdt: null,
      avgLossUsdt: null,
      netPnlUsdt: 0,
      buckets: {},
    };
  }

  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLossAbs = 0;
  let netSum = 0;

  for (const x of nets) {
    netSum += x;
    if (x > 0) {
      wins += 1;
      sumWin += x;
    } else if (x < 0) {
      losses += 1;
      sumLossAbs += -x;
    }
  }

  const denomWin = wins > 0 ? wins : null;
  const denomLoss = losses > 0 ? losses : null;
  const avgWinUsdt = denomWin != null ? sumWin / denomWin : null;
  const avgLossUsdt = denomLoss != null ? -sumLossAbs / denomLoss : null;
  const profitFactor = sumLossAbs > 1e-9 ? sumWin / sumLossAbs : sumWin > 0 ? null : null;

  return {
    tradeCount: n,
    winRatePct: (wins / n) * 100,
    expectancyUsdt: netSum / n,
    profitFactor,
    avgWinUsdt,
    avgLossUsdt,
    netPnlUsdt: netSum,
    buckets: {},
  };
}

/**
 * @param {string} instanceId
 * @param {number} windowDays
 */
export async function getStrategyEdgeForInstance(instanceId, windowDays = 90) {
  const days = clampDays(windowDays);
  const r = await query(
    `
    SELECT net_pnl
    FROM trades
    WHERE instance_id = $1
      AND status = 'closed'
      AND closed_at IS NOT NULL
      AND closed_at >= NOW() - make_interval(days => $2::int)
    ORDER BY closed_at ASC
    `,
    [instanceId, days],
  );
  return { scope: 'instance', windowDays: days, ...computeEdge(r.rows) };
}

/**
 * All closed trades linked to this strategy version (any instance).
 *
 * @param {string} strategyVersionId
 * @param {number} windowDays
 */
export async function getStrategyEdgeForVersion(strategyVersionId, windowDays = 90) {
  const days = clampDays(windowDays);
  const r = await query(
    `
    SELECT t.net_pnl
    FROM trades t
    LEFT JOIN bot_instances i ON t.instance_id = i.id
    WHERE t.status = 'closed'
      AND t.closed_at IS NOT NULL
      AND t.closed_at >= NOW() - make_interval(days => $2::int)
      AND COALESCE(t.strategy_version_id, i.strategy_version_id) = $1
    ORDER BY t.closed_at ASC
    `,
    [strategyVersionId, days],
  );
  return { scope: 'strategy_version', strategyVersionId, windowDays: days, ...computeEdge(r.rows) };
}
