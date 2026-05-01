import axios from 'axios';
import { getResolvedMarketIntelApis } from './marketIntelResolvedApis.js';

/**
 * Refresh crypto headline sentiment via Finnhub + AI `/news_impact_score` (heuristic JSON).
 * Mutates `intelligenceCache.newsImpact`.
 *
 * @param {Record<string, unknown>} intelligenceCache
 */
export async function refreshNewsImpactCache(intelligenceCache) {
  const apis = getResolvedMarketIntelApis();
  const finnhub = apis.finnhubApiKey;
  const aiUrl = apis.aiBaseUrl.replace(/\/$/, '');

  if (!finnhub) return;

  let headlines = [];
  try {
    const news = await axios.get('https://finnhub.io/api/v1/news', {
      params: { category: 'crypto', token: finnhub },
      timeout: 15000,
    });
    const arr = Array.isArray(news.data) ? news.data : [];
    headlines = arr
      .map((x) => (x?.headline != null ? String(x.headline).trim() : ''))
      .filter(Boolean)
      .slice(0, 24);
  } catch (err) {
    console.warn('[news_impact] finnhub:', err.message);
    return;
  }

  if (!headlines.length) return;

  let sentiment = 0;
  let summary = 'Neutral.';
  let model = 'none';

  try {
    const r = await axios.post(
      `${aiUrl}/news_impact_score`,
      { headlines },
      { timeout: 45000, validateStatus: (s) => s < 500 },
    );
    if (r.status === 200 && r.data && typeof r.data === 'object') {
      sentiment = Number(r.data.sentiment);
      if (!Number.isFinite(sentiment)) sentiment = 0;
      sentiment = Math.max(-1, Math.min(1, sentiment));
      summary = String(r.data.summary ?? '');
      model = String(r.data.model ?? 'heuristic');
    }
  } catch (err) {
    console.warn('[news_impact] ai-service:', err.message);
  }

  intelligenceCache.newsImpact = intelligenceCache.newsImpact || {};
  intelligenceCache.newsImpact.GLOBAL = {
    sentiment,
    summary,
    model,
    updatedAt: new Date().toISOString(),
    headlineSample: headlines.slice(0, 6),
  };
}
