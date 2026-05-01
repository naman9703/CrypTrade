import { query } from '../query.js';
import { getLiquidationPayloadForSymbol } from '../../intelligence/collectors/liquidationCollector.js';
import { intelligenceCache } from '../../intelligence/index.js';

/** @param {string} sym */
function emptyIntelPayload(sym) {
  return {
    symbol: sym,
    timestamp: new Date().toISOString(),
    fearGreed: null,
    funding: null,
    openInterest: null,
    orderBook: null,
    options: null,
    onChain: null,
    liquidations: null,
    newsImpact: null,
    confluence: null,
    volatility: null,
    composite: null,
  };
}

/** @param {unknown} ratio */
function inferIvRelativeFromRatio(ratio) {
  const r = ratio != null && ratio !== '' ? Number(ratio) : NaN;
  if (!Number.isFinite(r) || r <= 0) return 'unknown';
  if (r >= 1.15) return 'iv_rich';
  if (r <= 0.85) return 'iv_cheap';
  return 'balanced';
}

/**
 * PostgreSQL `market_intelligence` row → same nested JSON shape as WS `intelligence_update`
 * (frontend `IntelligenceData`).
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Record<string, unknown> | null}
 */
export function mapIntelligenceRowToClientPayload(row) {
  if (!row || typeof row !== 'object') return null;
  const symbol = String(row.symbol ?? '').trim().toUpperCase();
  if (!symbol) return null;

  const captured = row.captured_at;
  const timestamp =
    captured instanceof Date
      ? captured.toISOString()
      : captured
        ? String(captured)
        : new Date().toISOString();

  /** @param {unknown} v */
  const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return fallback;
      }
    }
    return fallback;
  };

  /** @param {unknown} x */
  const numOrNull = (x) => {
    if (x == null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };

  /** @param {unknown} x @param {number} d */
  const num = (x, d = 0) => numOrNull(x) ?? d;

  const bull = parseJson(row.bullish_signals, []);
  const bear = parseJson(row.bearish_signals, []);

  const compScore = numOrNull(row.composite_score);
  const hasComposite =
    compScore != null ||
    row.composite_bias != null ||
    row.composite_confidence != null ||
    row.composite_size_multiplier != null;

  /** Mirrors thresholds in intelligence/orderBookCollector imbalanceRatio */
  const imb = num(row.book_imbalance_ratio, NaN);
  const pressure =
    !Number.isFinite(imb) || imb <= 0 ? 'neutral' :
    imb > 0.65 ? 'strong_buy' :
    imb < 0.35 ? 'strong_sell' : 'neutral';

  return {
    symbol,
    timestamp,
    fearGreed:
      row.fear_greed_value != null
        ? {
            value: num(row.fear_greed_value, 0),
            label: String(row.fear_greed_label ?? ''),
            change24h: Math.round(num(row.fear_greed_24h_change, 0)),
          }
        : null,
    funding:
      row.funding_rate != null ||
      row.funding_bias != null ||
      row.funding_rate_zscore != null ||
      row.funding_predicted != null
        ? {
            current: num(row.funding_rate, 0),
            avg30d: num(row.funding_rate_30d_avg, 0),
            zscore: num(row.funding_rate_zscore, 0),
            predicted: num(row.funding_predicted, 0),
            nextTime:
              row.funding_next_time instanceof Date
                ? row.funding_next_time.toISOString()
                : row.funding_next_time != null
                  ? String(row.funding_next_time)
                  : '',
            bias: String(row.funding_bias ?? ''),
          }
        : null,
    openInterest:
      row.oi_usdt != null || row.long_short_ratio != null
        ? {
            usdt: num(row.oi_usdt, 0),
            change4hPct: num(row.oi_change_4h_pct, 0),
            change24hPct: num(row.oi_change_24h_pct, 0),
            longShortRatio: num(row.long_short_ratio, 0),
          }
        : null,
    orderBook:
      row.book_imbalance_ratio != null || row.bid_wall_usdt != null || row.ask_wall_usdt != null
        ? {
            imbalanceRatio: Number.isFinite(imb) ? imb : 0.5,
            bidWallUsdt: num(row.bid_wall_usdt, 0),
            askWallUsdt: num(row.ask_wall_usdt, 0),
            pressure,
          }
        : null,
    options:
      row.options_max_pain != null ||
      row.options_bias != null ||
      row.options_put_call_ratio != null ||
      row.options_implied_vol != null ||
      row.options_gex != null
        ? {
            maxPain: num(row.options_max_pain, 0),
            maxPainDistance: num(row.options_max_pain_distance, 0),
            putCallRatio: num(row.options_put_call_ratio, 0),
            impliedVol: row.options_implied_vol != null ? num(row.options_implied_vol, 0) : null,
            gex: num(row.options_gex, 0),
            gexRegime: String(row.options_gex_regime ?? ''),
            bias: String(row.options_bias ?? ''),
          }
        : null,
    onChain:
      row.exchange_netflow_24h != null ||
      row.exchange_netflow_zscore != null ||
      row.cq_exchange_netflow_usd_24h != null
        ? {
            takerFlowImbalancePct: num(row.exchange_netflow_24h, 0),
            takerFlowZscore: num(row.exchange_netflow_zscore, 0),
            cryptoQuantNetflowUsd24h:
              row.cq_exchange_netflow_usd_24h != null ? num(row.cq_exchange_netflow_usd_24h, 0) : null,
            /** Not stored historically on `market_intelligence`; WS/live rows include it from Binance. */
            takerBuyRatio: 0.5,
          }
        : null,
    confluence:
      row.tf_confluence_score != null ||
      row.tf_bias != null ||
      row.tf_breakdown != null
        ? (() => {
            const breakdownRaw = parseJson(row.tf_breakdown, {});
            const breakdown =
              breakdownRaw && typeof breakdownRaw === 'object' && !Array.isArray(breakdownRaw) ? breakdownRaw : {};
            return {
              score: Math.round(num(row.tf_confluence_score, 0)),
              breakdown,
              primaryDir: null,
              bias: String(row.tf_bias ?? ''),
            };
          })()
        : null,
    volatility:
      row.vol_regime != null ||
      row.adx_regime != null ||
      row.combined_regime != null ||
      row.realised_vol_24h != null ||
      row.implied_vol != null ||
      row.iv_rv_ratio != null
        ? {
            realisedVol24h: row.realised_vol_24h != null ? num(row.realised_vol_24h, 0) : null,
            impliedVolAnnualPct:
              row.implied_vol != null ? num(row.implied_vol, 0) : null,
            ivRvRatio: row.iv_rv_ratio != null ? num(row.iv_rv_ratio, 0) : null,
            ivRelativeRegime: inferIvRelativeFromRatio(row.iv_rv_ratio),
            volRegime: String(row.vol_regime ?? ''),
            adxRegime: String(row.adx_regime ?? ''),
            combined: String(row.combined_regime ?? ''),
          }
        : null,
    liquidations:
      row.liq_long_usd != null || row.liq_short_usd != null || row.liq_total_usd != null
        ? {
            longUsd: num(row.liq_long_usd, 0),
            shortUsd: num(row.liq_short_usd, 0),
            totalUsd: num(row.liq_total_usd, 0),
            count: 0,
            dominance:
              row.liq_dominance === 'longs' || row.liq_dominance === 'shorts'
                ? row.liq_dominance
                : 'neutral',
            intensity:
              row.liq_intensity === 'moderate' ||
              row.liq_intensity === 'high' ||
              row.liq_intensity === 'extreme'
                ? row.liq_intensity
                : 'low',
            windowHours: 4,
            lastUpdated: Number.isFinite(Date.parse(timestamp))
              ? Date.parse(timestamp)
              : Date.now(),
          }
        : null,
    composite: hasComposite
      ? {
          composite: compScore ?? 0,
          bias: String(row.composite_bias ?? ''),
          confidence: num(row.composite_confidence, 0),
          sizeMultiplier: num(row.composite_size_multiplier, 1),
          bullishSignals: Array.isArray(bull) ? bull : [],
          bearishSignals: Array.isArray(bear) ? bear : [],
        }
      : null,
  };
}

export async function getLatestIntelligence(symbol) {
  const sym = String(symbol ?? '').trim().toUpperCase();
  const res = await query(`
    SELECT * FROM market_intelligence
    WHERE symbol = $1
    ORDER BY captured_at DESC
    LIMIT 1
  `, [sym]);
  return res.rows[0] ?? null;
}

/** Latest row formatted for UI / `fetchIntelligence` — matches WS payload shape (live cache overlays). */
export async function getLatestIntelligenceApiPayload(symbol) {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) return null;

  const row = await getLatestIntelligence(sym);
  let payload = mapIntelligenceRowToClientPayload(row);

  if (!payload) payload = emptyIntelPayload(sym);
  else if (!payload.symbol) payload = { ...payload, symbol: sym };

  const liveLiq = getLiquidationPayloadForSymbol(sym);
  if (liveLiq) payload.liquidations = liveLiq;

  const news = intelligenceCache.newsImpact?.GLOBAL ?? null;
  if (news) payload.newsImpact = news;

  const liveConf = intelligenceCache.confluence?.[sym];
  if (liveConf && typeof liveConf === 'object') {
    payload.confluence =
      payload.confluence && typeof payload.confluence === 'object'
        ? { ...payload.confluence, ...liveConf }
        : { ...liveConf };
  }

  const liveBook = intelligenceCache.orderBook?.[sym];
  if (liveBook && typeof liveBook === 'object') {
    payload.orderBook =
      payload.orderBook && typeof payload.orderBook === 'object'
        ? { ...payload.orderBook, ...liveBook }
        : { ...liveBook };
  }

  return payload;
}

export async function getIntelligenceHistory(symbol, limit = 100) {
  const res = await query(`
    SELECT symbol, captured_at, composite_score, composite_bias,
           funding_rate, funding_rate_zscore,
           fear_greed_value, tf_confluence_score,
           options_max_pain, options_put_call_ratio
    FROM market_intelligence
    WHERE symbol = $1
    ORDER BY captured_at DESC
    LIMIT $2
  `, [symbol, limit]);
  return res.rows;
}
