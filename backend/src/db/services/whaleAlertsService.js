import { query } from '../query.js';

/**
 * @param {{ fromIso: string, toIso: string, symbol?: string }} p
 */
export async function listWhaleAlertsInRange({ fromIso, toIso, symbol }) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return [];

  const sym = symbol != null ? String(symbol).trim().toUpperCase() : '';
  const lim = 200;

  if (sym) {
    const r = await query(
      `
      SELECT id, symbol, amount_usd, direction, from_entity, to_entity, tx_hash, alerted_at, impact_score
      FROM whale_alerts
      WHERE alerted_at >= $1 AND alerted_at <= $2 AND symbol = $3
      ORDER BY alerted_at DESC
      LIMIT $4
      `,
      [from, to, sym, lim],
    );
    return r.rows.map(mapWhale);
  }

  const r = await query(
    `
    SELECT id, symbol, amount_usd, direction, from_entity, to_entity, tx_hash, alerted_at, impact_score
    FROM whale_alerts
    WHERE alerted_at >= $1 AND alerted_at <= $2
    ORDER BY alerted_at DESC
    LIMIT $3
    `,
    [from, to, lim],
  );
  return r.rows.map(mapWhale);
}

/** @param {Record<string, unknown>} row */
function mapWhale(row) {
  return {
    id: String(row.id ?? ''),
    symbol: String(row.symbol ?? ''),
    amountUsd: row.amount_usd != null ? Number(row.amount_usd) : null,
    direction: row.direction != null ? String(row.direction) : null,
    fromEntity: row.from_entity != null ? String(row.from_entity) : null,
    toEntity: row.to_entity != null ? String(row.to_entity) : null,
    txHash: row.tx_hash != null ? String(row.tx_hash) : null,
    alertedAt: row.alerted_at instanceof Date ? row.alerted_at.toISOString() : String(row.alerted_at ?? ''),
    impactScore: row.impact_score != null ? Number(row.impact_score) : null,
  };
}

/**
 * @param {object} o
 */
export async function insertWhaleAlert(o) {
  const sym = String(o.symbol ?? '').trim().toUpperCase();
  const alertedAt = o.alertedAt instanceof Date ? o.alertedAt : new Date(o.alertedAt);
  if (!sym || !Number.isFinite(alertedAt.getTime())) return null;

  const r = await query(
    `
    INSERT INTO whale_alerts (symbol, amount_usd, direction, from_entity, to_entity, tx_hash, alerted_at, impact_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [
      sym,
      o.amountUsd != null ? Number(o.amountUsd) : null,
      o.direction != null ? String(o.direction) : null,
      o.fromEntity != null ? String(o.fromEntity) : null,
      o.toEntity != null ? String(o.toEntity) : null,
      o.txHash != null ? String(o.txHash) : null,
      alertedAt,
      o.impactScore != null ? Math.floor(Number(o.impactScore)) : null,
    ],
  );
  return r.rows[0] ? mapWhale(r.rows[0]) : null;
}
