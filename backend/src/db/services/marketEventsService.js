import { query } from '../query.js';

/**
 * @param {{ fromIso: string, toIso: string, assets?: string[] }} p
 * @returns {Promise<object[]>}
 */
export async function listMarketEventsInRange({ fromIso, toIso, assets }) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return [];

  const lim = 500;
  const assetList = (assets ?? [])
    .map((a) => String(a ?? '').trim().toUpperCase().replace(/USDT|USD|BUSD$/u, ''))
    .filter(Boolean);

  if (assetList.length) {
    const r = await query(
      `
      SELECT id, event_type, title, description, event_time, asset, impact_level, source
      FROM market_events
      WHERE event_time >= $1 AND event_time <= $2
        AND (asset IS NULL OR trim(upper(asset)) = ANY($3::text[]))
      ORDER BY event_time ASC
      LIMIT $4
      `,
      [from, to, assetList, lim],
    );
    return r.rows.map(mapRow);
  }

  const r = await query(
    `
    SELECT id, event_type, title, description, event_time, asset, impact_level, source
    FROM market_events
    WHERE event_time >= $1 AND event_time <= $2
    ORDER BY event_time ASC
    LIMIT $3
    `,
    [from, to, lim],
  );
  return r.rows.map(mapRow);
}

/** @param {Record<string, unknown>} row */
function mapRow(row) {
  return {
    id: String(row.id ?? ''),
    eventType: String(row.event_type ?? ''),
    title: String(row.title ?? ''),
    description: row.description != null ? String(row.description) : null,
    eventTime: row.event_time instanceof Date ? row.event_time.toISOString() : String(row.event_time ?? ''),
    asset: row.asset != null ? String(row.asset) : null,
    impactLevel: String(row.impact_level ?? 'medium'),
    source: row.source != null ? String(row.source) : null,
  };
}

/**
 * Insert if no duplicate (same title + instant).
 * @param {object} o
 */
export async function insertMarketEventIfNew(o) {
  const title = String(o.title ?? '').trim();
  const eventTime = o.eventTime instanceof Date ? o.eventTime : new Date(o.eventTime);
  if (!title || !Number.isFinite(eventTime.getTime())) return false;

  const exists = await query(`SELECT 1 FROM market_events WHERE title = $1 AND event_time = $2 LIMIT 1`, [
    title,
    eventTime,
  ]);
  if (exists.rows.length) return false;

  await query(
    `
    INSERT INTO market_events (event_type, title, description, event_time, asset, impact_level, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      String(o.eventType ?? 'economic'),
      title,
      o.description != null ? String(o.description) : null,
      eventTime,
      o.asset != null ? String(o.asset).trim().toUpperCase() : null,
      String(o.impactLevel ?? 'medium'),
      o.source != null ? String(o.source) : null,
    ],
  );
  return true;
}
