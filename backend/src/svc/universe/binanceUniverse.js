import axios from "axios";
import { computeIndicators } from "../../strategy/indicators.js";

function normalizeSymbol(s) {
  return String(s || "").toUpperCase();
}

function isLeveragedTokenSymbol(sym) {
  const s = normalizeSymbol(sym);
  return /(UP|DOWN|BULL|BEAR)USDT$/.test(s);
}

/** USDT-quoted pairs whose base is another stable / fiat wrapper (low “alt” beta). */
const STABLE_OR_FIAT_BASES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "DAI",
  "USDP",
  "PYUSD",
  "USDD",
  "GUSD",
  "EUR",
  "GBP",
  "AUD",
  "BRL",
]);

function isStableOrFiatUsdtPair(sym) {
  const s = normalizeSymbol(sym);
  if (!s.endsWith("USDT") || s.length < 8) return false;
  const base = s.slice(0, -4);
  return STABLE_OR_FIAT_BASES.has(base);
}

function parseExtraExcludeSymbols() {
  const raw = process.env.UNIVERSE_EXCLUDE_SYMBOLS || "";
  return new Set(
    raw
      .split(",")
      .map((x) => normalizeSymbol(x))
      .filter(Boolean)
  );
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function scoreFormula({ aiProb, opportunity, spreadPct }) {
  const a = clamp01(Number(aiProb));
  const opp = Number(opportunity || 0);
  const spr = Number(spreadPct || 0);
  // AI dominates heavily (it's the brain), opportunity is a small bonus
  return a * 2.5 + opp * 0.25 - spr * 6.0;
}

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  let sa = 0,
    sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let va = 0,
    vb = 0,
    cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    va += da * da;
    vb += db * db;
    cov += da * db;
  }
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}

function returnsFromCandles(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = Number(candles[i - 1]?.close);
    const cur = Number(candles[i]?.close);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) continue;
    out.push(Math.log(cur / prev));
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createBinanceUniverse({ log, restBase, feedKind } = {}) {
  const mf = String(
    feedKind != null && String(feedKind).trim() ? feedKind : process.env.MARKET_FEED || "SYNTH",
  ).toUpperCase();
  const useFuturesUniverse = mf === "BINANCE_FUTURES";
  const spotBase = restBase || process.env.BINANCE_REST_BASE || "https://api.binance.com";
  const fapiBase = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

  const http = axios.create({
    baseURL: useFuturesUniverse ? fapiBase : spotBase,
    timeout: 25_000,
  });

  let futuresSymbolsCache = null;
  let futuresSymbolsCacheTs = 0;
  const FUTURES_CACHE_TTL = 30 * 60 * 1000;

  let exchangeInfoCache = null;
  let exchangeInfoCacheTs = 0;
  const EXCHANGE_INFO_CACHE_TTL = 30 * 60 * 1000;

  let tradableSymbolsCache = null;
  let tradableSymbolsCacheTs = 0;
  const TRADABLE_SYMBOLS_CACHE_TTL = 30 * 60 * 1000;
  let tradableSymbolsLoadInFlight = null;

  async function loadFuturesSymbols() {
    const now = Date.now();
    if (futuresSymbolsCache && now - futuresSymbolsCacheTs < FUTURES_CACHE_TTL) return futuresSymbolsCache;
    const bases = [
      process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com",
      process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com",
    ];
    for (const futBase of bases) {
      try {
        const { data } = await axios.get(`${futBase}/fapi/v1/exchangeInfo`, { timeout: 8_000 });
        const syms = new Set(
          (data?.symbols || [])
            .filter((s) => s?.status === "TRADING" || s?.contractStatus === "TRADING")
            .map((s) => normalizeSymbol(s?.symbol))
            .filter(Boolean)
        );
        futuresSymbolsCache = syms;
        futuresSymbolsCacheTs = now;
        log?.info?.("universe_futures_symbols_loaded", { count: syms.size, base: futBase });
        return syms;
      } catch (e) {
        log?.warn?.("universe_futures_symbols_try_failed", { base: futBase, error: String(e?.message || e) });
      }
    }
    log?.warn?.("universe_futures_symbols_failed", { tried: bases });
    return futuresSymbolsCache || null;
  }

  async function exchangeInfo({ allowStale = true } = {}) {
    const now = Date.now();
    if (exchangeInfoCache && now - exchangeInfoCacheTs < EXCHANGE_INFO_CACHE_TTL) return exchangeInfoCache;
    const path = useFuturesUniverse ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo";
    try {
      const { data } = await http.get(path);
      exchangeInfoCache = data;
      exchangeInfoCacheTs = now;
      return data;
    } catch (e) {
      if (allowStale && exchangeInfoCache) {
        log?.warn?.("universe_exchange_info_stale_fallback", { error: String(e?.message || e) });
        return exchangeInfoCache;
      }
      throw e;
    }
  }

  function filterTradableSymbols(syms, q) {
    const query = String(q || "").trim().toUpperCase();
    if (!query) return syms;
    return syms.filter((sym) => {
      const su = String(sym || "").toUpperCase();
      const base = su.endsWith("USDT") ? su.slice(0, -4) : su;
      return su.includes(query) || base.includes(query);
    });
  }

  async function buildTradableSymbolsList({ excludeLeveragedTokens = true, excludeStablePairs = true } = {}) {
    const [exInfo, futSyms] = await Promise.all([
      exchangeInfo(),
      useFuturesUniverse ? Promise.resolve(null) : loadFuturesSymbols(),
    ]);
    const syms = (exInfo?.symbols || [])
      .filter((s) => exSymbolAllowed(s, futSyms, { excludeLeveragedTokens, excludeStablePairs }))
      .map((s) => normalizeSymbol(s?.symbol))
      .filter(Boolean);
    return [...new Set(syms)].sort();
  }

  async function ticker24hr() {
    const path = useFuturesUniverse ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr";
    const { data } = await http.get(path);
    return data;
  }

  async function bookTicker() {
    const path = useFuturesUniverse ? "/fapi/v1/ticker/bookTicker" : "/api/v3/ticker/bookTicker";
    const { data } = await http.get(path);
    return data;
  }

  async function klines({ symbol, interval, limit }) {
    const path = useFuturesUniverse ? "/fapi/v1/klines" : "/api/v3/klines";
    const { data } = await http.get(path, {
      params: { symbol: normalizeSymbol(symbol), interval: String(interval || "1m"), limit: Number(limit || 260) },
    });
    if (!Array.isArray(data)) return [];
    return data.map((k) => ({
      ts: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }

  function exSymbolAllowed(s, futSyms, { excludeLeveragedTokens, excludeStablePairs }) {
      const extraExclude = parseExtraExcludeSymbols();
      const sym = normalizeSymbol(s?.symbol);
      if (!sym) return false;
      if (useFuturesUniverse) {
        if (
          !(
            s?.contractType === "PERPETUAL" &&
            (s?.status === "TRADING" || s?.contractStatus === "TRADING") &&
            String(s?.quoteAsset || "").toUpperCase() === "USDT"
          )
        )
          return false;
      } else {
        if (!(s?.status === "TRADING" && s?.quoteAsset === "USDT")) return false;
      }
      if (excludeLeveragedTokens && isLeveragedTokenSymbol(sym)) return false;
      if (excludeStablePairs && isStableOrFiatUsdtPair(sym)) return false;
      if (extraExclude.has(sym)) return false;
      if (!useFuturesUniverse && futSyms && !futSyms.has(sym)) return false;
      return true;
    }

  return {
    async listTradableUsdtSymbols({ excludeLeveragedTokens = true, excludeStablePairs = true, q = null } = {}) {
      const now = Date.now();
      const cacheFresh = tradableSymbolsCache && now - tradableSymbolsCacheTs < TRADABLE_SYMBOLS_CACHE_TTL;
      if (cacheFresh) return filterTradableSymbols(tradableSymbolsCache, q);

      if (!tradableSymbolsLoadInFlight) {
        tradableSymbolsLoadInFlight = (async () => {
          try {
            const fresh = await buildTradableSymbolsList({ excludeLeveragedTokens, excludeStablePairs });
            tradableSymbolsCache = fresh;
            tradableSymbolsCacheTs = Date.now();
            return fresh;
          } catch (e) {
            if (tradableSymbolsCache) {
              log?.warn?.("universe_tradable_symbols_stale_fallback", { error: String(e?.message || e) });
              return tradableSymbolsCache;
            }
            throw e;
          } finally {
            tradableSymbolsLoadInFlight = null;
          }
        })();
      }

      const all = await tradableSymbolsLoadInFlight;
      return filterTradableSymbols(all, q);
    },

    /** Fire-and-forget warm-up so the custom coin picker does not cold-hit Binance. */
    warmTradableSymbolsCache() {
      void this.listTradableUsdtSymbols().catch((e) => {
        log?.warn?.("universe_tradable_symbols_warm_failed", { error: String(e?.message || e) });
      });
    },

    async scanAndRank({
      timeframe = "1m",
      universeSize = 30,
      candlesLimit = 260,
      topKlines = 12,
      minQuoteVolumeUSDT = 5_000_000,
      maxSpreadPct = 0.0015, // 0.15%
      excludeLeveragedTokens = true,
      excludeStablePairs = true,
      maxCorr = Number(process.env.UNIVERSE_MAX_CORR || 0.85),
      aiClient = null,
      /** When set, restrict to these symbols only (e.g. user custom watchlist, max ~10). */
      customSymbols = null,
      /** If true, sort final table primarily by AI probability (for “ALL” top-AI funnel). */
      rankByAiPrimary = false,
      /** After AI sort, keep this many rows in `ranked` (default 10 for ALL). */
      aiRankedDisplayTop = 10,
    } = {}) {
      const customMode = Array.isArray(customSymbols) && customSymbols.length > 0;
      // Step 1: universe
      const [exInfo, t24, book, futSyms] = await Promise.all([
        exchangeInfo(),
        ticker24hr(),
        bookTicker(),
        useFuturesUniverse ? Promise.resolve(null) : loadFuturesSymbols(),
      ]);

      const by24 = new Map();
      for (const t of Array.isArray(t24) ? t24 : []) by24.set(normalizeSymbol(t?.symbol), t);
      const byBook = new Map();
      for (const b of Array.isArray(book) ? book : []) byBook.set(normalizeSymbol(b?.symbol), b);

      const allowedRows = (exInfo?.symbols || []).filter((s) =>
        exSymbolAllowed(s, futSyms, { excludeLeveragedTokens, excludeStablePairs }),
      );
      const allowedSet = new Set(allowedRows.map((s) => normalizeSymbol(s?.symbol)).filter(Boolean));

      let rankedByVol;
      if (customMode) {
        const want = [...new Set(customSymbols.map((x) => normalizeSymbol(x)).filter(Boolean))].slice(0, 10);
        rankedByVol = want
          .filter((sym) => allowedSet.has(sym))
          .map((sym) => {
            const t = by24.get(sym);
            return { symbol: sym, quoteVolumeUSDT: Number(t?.quoteVolume || 0) };
          });
      } else {
        const symbols = allowedRows
          .map((s) => normalizeSymbol(s?.symbol))
          .filter(Boolean);
        rankedByVol = symbols
          .map((sym) => {
            const t = by24.get(sym);
            const qv = Number(t?.quoteVolume || 0);
            return { symbol: sym, quoteVolumeUSDT: qv };
          })
          .sort((a, b) => b.quoteVolumeUSDT - a.quoteVolumeUSDT)
          .slice(0, Math.max(5, Math.min(200, Number(universeSize || 30))));
      }

      // Step 2: filter by volume + spread
      const tradable = rankedByVol
        .map((x) => {
          const b = byBook.get(x.symbol);
          const bid = Number(b?.bidPrice || 0);
          const ask = Number(b?.askPrice || 0);
          const mid = (bid + ask) / 2;
          const spreadPct = mid > 0 ? (ask - bid) / mid : 1;
          return { ...x, bid, ask, spreadPct };
        })
        .filter((x) => (customMode ? true : x.quoteVolumeUSDT >= Number(minQuoteVolumeUSDT || 0)))
        .filter((x) =>
          customMode ? true : x.spreadPct > 0 && x.spreadPct <= Number(maxSpreadPct || 0.01),
        );

      // Step 3: opportunity signals for top candidates (klines are the expensive part)
      const klineSource = customMode && tradable.length === 0 ? rankedByVol : tradable;
      const klineCap = customMode
        ? Math.max(1, Math.min(10, klineSource.length))
        : Math.max(5, Math.min(tradable.length, Number(topKlines || 12)));
      const klinesTargets = klineSource.slice(0, klineCap);
      const withSignals = await mapLimit(klinesTargets, 4, async (x) => {
        const candles = await klines({ symbol: x.symbol, interval: timeframe, limit: candlesLimit });
        const last = candles[candles.length - 1];
        if (!last) return { ...x, candles: [], indicators: null, opportunity: 0 };

        const ind = computeIndicators(candles);
        const close = Number(last.close);
        const atr = Number(ind?.latest?.atr_14 || 0);
        const atrPct = close > 0 ? atr / close : 0;
        const volSpike = Number(ind?.latest?.volume_spike || 1);
        const emaFast = Number(ind?.latest?.ema_fast || 0);
        const emaSlow = Number(ind?.latest?.ema_slow || 0);
        const trendStrength = close > 0 ? Math.abs(emaFast - emaSlow) / close : 0;

        // A fast "opportunity" score before AI.
        const opportunity = atrPct * 2.0 + Math.max(0, volSpike - 1) * 0.7 + trendStrength * 1.2;

        return {
          ...x,
          lastPrice: close,
          atrPct,
          volSpike,
          trendStrength,
          opportunity,
          candles,
          rets: returnsFromCandles(candles),
          indicators: ind?.latest || null,
        };
      });

      // Step 4: AI scoring (only for those we got candles for)
      const aiPool = rankByAiPrimary ? 28 : 8;
      const aiTargets = withSignals
        .filter((x) => Array.isArray(x.candles) && x.candles.length >= 80)
        .sort((a, b) => b.opportunity - a.opportunity)
        .slice(0, Math.min(withSignals.length, customMode ? withSignals.length : aiPool));

      const aiScores = new Map();
      if (aiClient) {
        await mapLimit(aiTargets, 2, async (x) => {
          try {
            const r = await aiClient.predict({ symbol: x.symbol, timeframe, candles: x.candles });
            aiScores.set(x.symbol, Number(r?.probability ?? 0));
          } catch (e) {
            log?.warn?.("universe_ai_score_failed", { symbol: x.symbol, error: String(e?.message || e) });
            aiScores.set(x.symbol, null);
          }
        });
      }

      let ranked = withSignals
        .map((x) => {
          const aiProb = aiScores.has(x.symbol) ? aiScores.get(x.symbol) : null;
          const score = scoreFormula({ aiProb: aiProb ?? 0, opportunity: x.opportunity, spreadPct: x.spreadPct });
          return {
            symbol: x.symbol,
            score,
            aiProb,
            quoteVolumeUSDT: x.quoteVolumeUSDT,
            spreadPct: x.spreadPct,
            lastPrice: x.lastPrice ?? null,
            atrPct: x.atrPct ?? null,
            volSpike: x.volSpike ?? null,
            trendStrength: x.trendStrength ?? null,
            opportunity: x.opportunity ?? null,
            corr: null,
          };
        })
        .sort((a, b) => b.score - a.score);

      if (rankByAiPrimary || customMode) {
        ranked = [...ranked].sort((a, b) => {
          const ap = a.aiProb != null && Number.isFinite(Number(a.aiProb)) ? Number(a.aiProb) : -1;
          const bp = b.aiProb != null && Number.isFinite(Number(b.aiProb)) ? Number(b.aiProb) : -1;
          if (bp !== ap) return bp - ap;
          return b.score - a.score;
        });
      }
      const topN = Number(aiRankedDisplayTop || 0);
      if (topN > 0 && ranked.length > topN) ranked = ranked.slice(0, topN);

      if (customMode) {
        const want = [...new Set(customSymbols.map((x) => normalizeSymbol(x)).filter(Boolean))].slice(0, 10);
        const have = new Set(ranked.map((r) => r.symbol));
        for (const sym of want) {
          if (have.has(sym)) continue;
          const vol = rankedByVol.find((x) => x.symbol === sym);
          ranked.push({
            symbol: sym,
            score: 0,
            aiProb: null,
            quoteVolumeUSDT: vol?.quoteVolumeUSDT ?? null,
            spreadPct: null,
            lastPrice: null,
            atrPct: null,
            volSpike: null,
            trendStrength: null,
            opportunity: null,
            corr: null,
          });
        }
      }

      // Correlation-aware pick of top N
      const selected = [];
      const pickedRets = [];
      for (const r of ranked) {
        const src = withSignals.find((x) => x.symbol === r.symbol);
        const rets = src?.rets || [];
        let tooCorr = false;
        let worst = null;
        for (const pr of pickedRets) {
          const c = corr(rets, pr);
          if (c == null) continue;
          worst = worst == null ? c : Math.max(worst, c);
          if (Math.abs(c) >= maxCorr) {
            tooCorr = true;
            break;
          }
        }
        if (!tooCorr) {
          selected.push(r.symbol);
          pickedRets.push(rets);
        }
        if (selected.length >= 3) break;
      }

      return {
        ok: true,
        asOf: new Date().toISOString(),
        timeframe,
        universeSize: rankedByVol.length,
        tradable: tradable.length,
        ranked: ranked.map((r) => {
          // compute max correlation vs selected set for UI visibility
          if (!selected.length || selected.includes(r.symbol) === false) return r;
          return r;
        }),
        selected,
      };
    },
  };
}

