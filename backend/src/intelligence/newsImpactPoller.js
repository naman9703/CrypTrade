import axios from "axios";
import { getResolvedMarketIntelApis } from "./marketIntelResolvedApis.js";

/** @type {string[]} */
const ASSET_KEYS = [
  "BTC",
  "ETH",
  "XRP",
  "SOL",
  "DOGE",
  "BNB",
  "ADA",
  "LINK",
  "MATIC",
  "POL",
  "AVAX",
  "DOT",
  "TON",
  "TRX",
  "SHIB",
];

/**
 * Bucket Finnhub crypto headlines by mentioned asset; headlines with no match → GLOBAL.
 * @param {{ headline?: string }[]} items
 */
function bucketHeadlinesByAsset(items) {
  /** @type {Record<string, string[]>} */
  const buckets = { GLOBAL: [] };
  for (const item of items) {
    const h = item?.headline != null ? String(item.headline).trim() : "";
    if (!h) continue;
    const upper = h.toUpperCase();
    let matched = false;
    for (const k of ASSET_KEYS) {
      const re = new RegExp(`\\b${k}\\b`, "i");
      if (re.test(upper)) {
        if (!buckets[k]) buckets[k] = [];
        buckets[k].push(h);
        matched = true;
      }
    }
    if (!matched) buckets.GLOBAL.push(h);
  }
  return buckets;
}

/**
 * Refresh crypto headline sentiment via Finnhub + AI `/news_impact_score` per bucket.
 * Mutates `intelligenceCache.newsImpact` — keys: GLOBAL, BTC, ETH, …
 *
 * @param {Record<string, unknown>} intelligenceCache
 */
export async function refreshNewsImpactCache(intelligenceCache) {
  const apis = getResolvedMarketIntelApis();
  const finnhub = apis.finnhubApiKey;
  const aiUrl = apis.aiBaseUrl.replace(/\/$/, "");

  if (!finnhub) return;

  let items = [];
  try {
    const news = await axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "crypto", token: finnhub },
      timeout: 15000,
    });
    items = Array.isArray(news.data) ? news.data : [];
  } catch (err) {
    console.warn("[news_impact] finnhub:", err.message);
    return;
  }

  if (!items.length) return;

  intelligenceCache.newsImpact = intelligenceCache.newsImpact || {};
  const buckets = bucketHeadlinesByAsset(items);

  for (const [asset, headlines] of Object.entries(buckets)) {
    if (!headlines.length) continue;
    const capped = headlines.slice(0, 24);

    let sentiment = 0;
    let summary = "Neutral.";
    let model = "none";

    try {
      const r = await axios.post(
        `${aiUrl}/news_impact_score`,
        { headlines: capped },
        { timeout: 45000, validateStatus: (s) => s < 500 },
      );
      if (r.status === 200 && r.data && typeof r.data === "object") {
        sentiment = Number(r.data.sentiment);
        if (!Number.isFinite(sentiment)) sentiment = 0;
        sentiment = Math.max(-1, Math.min(1, sentiment));
        summary = String(r.data.summary ?? "");
        model = String(r.data.model ?? "heuristic");
      }
    } catch (err) {
      console.warn(`[news_impact] ai-service ${asset}:`, err.message);
      continue;
    }

    intelligenceCache.newsImpact[asset] = {
      sentiment,
      summary,
      model,
      updatedAt: new Date().toISOString(),
      headlineSample: capped.slice(0, 6),
      bucket: asset,
    };
  }
}
