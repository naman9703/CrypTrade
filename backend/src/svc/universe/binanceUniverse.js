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

export function createBinanceUniverse({ log, restBase }) {
  const http = axios.create({
    baseURL: restBase || process.env.BINANCE_REST_BASE || "https://api.binance.com",
    timeout: 12_000,
  });

  let futuresSymbolsCache = null;
  let futuresSymbolsCacheTs = 0;
  const FUTURES_CACHE_TTL = 30 * 60 * 1000;

  async function loadFuturesSymbols() {
    const now = Date.now();
    if (futuresSymbolsCache && now - futuresSymbolsCacheTs < FUTURES_CACHE_TTL) return futuresSymbolsCache;
    const futBase = process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com";
    try {
      const { data } = await axios.get(`${futBase}/fapi/v1/exchangeInfo`, { timeout: 10_000 });
      const syms = new Set(
        (data?.symbols || [])
          .filter((s) => s?.status === "TRADING" || s?.contractStatus === "TRADING")
          .map((s) => normalizeSymbol(s?.symbol))
          .filter(Boolean)
      );
      futuresSymbolsCache = syms;
      futuresSymbolsCacheTs = now;
      log?.info?.("universe_futures_symbols_loaded", { count: syms.size });
      return syms;
    } catch (e) {
      log?.warn?.("universe_futures_symbols_failed", { error: String(e?.message || e) });
      return futuresSymbolsCache || null;
    }
  }

  async function exchangeInfo() {
    const { data } = await http.get("/api/v3/exchangeInfo");
    return data;
  }

  async function ticker24hr() {
    const { data } = await http.get("/api/v3/ticker/24hr");
    return data;
  }

  async function bookTicker() {
    const { data } = await http.get("/api/v3/ticker/bookTicker");
    return data;
  }

  async function klines({ symbol, interval, limit }) {
    const { data } = await http.get("/api/v3/klines", {
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

  return {
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
    } = {}) {
      const extraExclude = parseExtraExcludeSymbols();
      // Step 1: universe
      const [exInfo, t24, book, futSyms] = await Promise.all([
        exchangeInfo(), ticker24hr(), bookTicker(), loadFuturesSymbols(),
      ]);
      const symbols = (exInfo?.symbols || [])
        .filter((s) => s?.status === "TRADING" && s?.quoteAsset === "USDT")
        .map((s) => normalizeSymbol(s?.symbol))
        .filter(Boolean)
        .filter((s) => (excludeLeveragedTokens ? !isLeveragedTokenSymbol(s) : true))
        .filter((s) => (excludeStablePairs ? !isStableOrFiatUsdtPair(s) : true))
        .filter((s) => !extraExclude.has(s))
        .filter((s) => (futSyms ? futSyms.has(s) : true));

      const by24 = new Map();
      for (const t of Array.isArray(t24) ? t24 : []) by24.set(normalizeSymbol(t?.symbol), t);
      const byBook = new Map();
      for (const b of Array.isArray(book) ? book : []) byBook.set(normalizeSymbol(b?.symbol), b);

      // Rank by 24h quote volume (liquidity)
      const rankedByVol = symbols
        .map((sym) => {
          const t = by24.get(sym);
          const qv = Number(t?.quoteVolume || 0);
          return { symbol: sym, quoteVolumeUSDT: qv };
        })
        .sort((a, b) => b.quoteVolumeUSDT - a.quoteVolumeUSDT)
        .slice(0, Math.max(5, Math.min(200, Number(universeSize || 30))));

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
        .filter((x) => x.quoteVolumeUSDT >= Number(minQuoteVolumeUSDT || 0))
        .filter((x) => x.spreadPct > 0 && x.spreadPct <= Number(maxSpreadPct || 0.01));

      // Step 3: opportunity signals for top candidates (klines are the expensive part)
      const klinesTargets = tradable.slice(0, Math.max(5, Math.min(tradable.length, Number(topKlines || 12))));
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
      const aiTargets = withSignals
        .filter((x) => Array.isArray(x.candles) && x.candles.length >= 80)
        .sort((a, b) => b.opportunity - a.opportunity)
        .slice(0, Math.min(withSignals.length, 8));

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

      const ranked = withSignals
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

