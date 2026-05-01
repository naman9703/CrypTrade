import axios from 'axios';
import { insertMarketEventIfNew } from '../db/services/marketEventsService.js';
import { getResolvedMarketIntelApis } from './marketIntelResolvedApis.js';

function impactFromFinnhub(impact) {
  const s = String(impact ?? '').toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  return 'low';
}

/**
 * Pull Finnhub economic calendar into `market_events` when `FINNHUB_API_KEY` is set.
 * Safe no-op without key.
 *
 * @param {{ daysForward?: number }} opts
 */
export async function ingestFinnhubEconomicCalendar(opts = {}) {
  const key = getResolvedMarketIntelApis().finnhubApiKey;
  if (!key) return { inserted: 0, skipped: true };

  const days = Math.min(14, Math.max(1, Math.floor(Number(opts.daysForward) || 7)));
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const toDate = new Date(now.getTime() + days * 86400000);
  const to = toDate.toISOString().slice(0, 10);

  let inserted = 0;
  try {
    const res = await axios.get('https://finnhub.io/api/v1/calendar/economic', {
      params: { from, to, token: key },
      timeout: 20000,
    });
    const rows = res.data?.economicCalendar;
    if (!Array.isArray(rows)) return { inserted: 0, skipped: false };

    for (const ev of rows) {
      const title = ev?.event != null ? String(ev.event) : '';
      const timeStr = ev?.time != null ? String(ev.time) : '';
      if (!title || !timeStr) continue;
      const eventTime = new Date(`${timeStr.replace(' ', 'T')}Z`);
      if (!Number.isFinite(eventTime.getTime())) continue;

      const currency = ev?.currency != null ? String(ev.currency).trim().toUpperCase() : null;
      const country = ev?.country != null ? String(ev.country) : '';

      const ok = await insertMarketEventIfNew({
        eventType: 'economic',
        title,
        description: country ? `${country}${currency ? ` · ${currency}` : ''}` : currency || null,
        eventTime,
        asset: currency === 'USD' || !currency ? null : currency,
        impactLevel: impactFromFinnhub(ev?.impact),
        source: 'finnhub',
      });
      if (ok) inserted += 1;
    }
  } catch (err) {
    console.warn('[market_events] finnhub ingest:', err.message);
  }

  return { inserted, skipped: false };
}
