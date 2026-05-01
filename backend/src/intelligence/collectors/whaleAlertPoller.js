import axios from 'axios';
import { query } from '../../db/query.js';
import { insertWhaleAlert } from '../../db/services/whaleAlertsService.js';
import { getResolvedMarketIntelApis } from '../marketIntelResolvedApis.js';

/**
 * Poll Whale Alert compatible feed when WHALE_ALERT_API_KEY set.
 * https://docs.whale-alert.io/
 *
 * @param {{ wsHub?: { broadcast?: (t: string, p: unknown) => void } } | null} ctx
 */
export async function pollWhaleAlertTransactions(ctx = null) {
  const key = getResolvedMarketIntelApis().whaleAlertApiKey;
  if (!key) return { inserted: 0 };

  let inserted = 0;
  try {
    const res = await axios.get('https://api.whale-alert.io/v1/transactions', {
      params: {
        api_key: key,
        min_value: Math.max(1_000_000, Number(process.env.WHALE_ALERT_MIN_VALUE_USD) || 5_000_000),
        limit: 10,
      },
      timeout: 20000,
    });

    const rawTx = res.data?.transactions;
    const txs = Array.isArray(rawTx)
      ? rawTx
      : rawTx && typeof rawTx === 'object'
        ? Object.values(rawTx)
        : [];
    const broadcastMin = Math.max(1, Math.floor(Number(process.env.WHALE_ALERT_WS_IMPACT_MIN) || 70));

    for (const tx of txs) {
      const symbolRaw =
        tx?.symbol != null
          ? String(tx.symbol).toUpperCase()
          : tx?.currency != null
            ? `${String(tx.currency).toUpperCase()}USDT`
            : '';
      const symbol = symbolRaw.endsWith('USDT') ? symbolRaw : `${symbolRaw}USDT`;
      const amountUsd = tx?.amount_usd != null ? Number(tx.amount_usd) : NaN;
      const ts =
        tx?.timestamp != null
          ? new Date(Number(tx.timestamp) * 1000)
          : tx?.timestamp_ns != null
            ? new Date(Number(tx.timestamp_ns) / 1e6)
            : null;

      if (!symbol || symbol === 'USDT' || ts == null || !Number.isFinite(ts.getTime())) continue;

      const hash = tx?.hash != null ? String(tx.hash) : '';
      if (hash) {
        const dup = await query(`SELECT 1 FROM whale_alerts WHERE tx_hash = $1 LIMIT 1`, [hash]);
        if (dup.rows.length) continue;
      }

      const fromOwner = tx?.from?.owner_type != null ? String(tx.from.owner_type) : null;
      const toOwner = tx?.to?.owner_type != null ? String(tx.to.owner_type) : null;
      const direction =
        fromOwner === 'exchange' && toOwner !== 'exchange'
          ? 'out_of_exchange'
          : toOwner === 'exchange' && fromOwner !== 'exchange'
            ? 'into_exchange'
            : 'transfer';

      let impact = 40;
      if (Number.isFinite(amountUsd)) {
        if (amountUsd >= 50_000_000) impact = 95;
        else if (amountUsd >= 20_000_000) impact = 85;
        else if (amountUsd >= 10_000_000) impact = 75;
      }

      const row = await insertWhaleAlert({
        symbol,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
        direction,
        fromEntity: tx?.from?.owner_type ?? null,
        toEntity: tx?.to?.owner_type ?? null,
        txHash: hash || null,
        alertedAt: ts,
        impactScore: impact,
      });

      if (row && ctx?.wsHub && typeof ctx.wsHub.broadcast === 'function' && impact >= broadcastMin) {
        ctx.wsHub.broadcast('whale_alert', { alert: row, timestamp: new Date().toISOString() });
      }
      if (row) inserted += 1;
    }
  } catch (err) {
    console.warn('[whale_alert] poll:', err.message);
  }

  return { inserted };
}
