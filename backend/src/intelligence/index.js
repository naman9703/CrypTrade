import { fearGreedCollector }    from './collectors/fearGreedCollector.js';
import { fundingCollector }      from './collectors/fundingCollector.js';
import { openInterestCollector } from './collectors/openInterestCollector.js';
import { orderBookCollector }    from './collectors/orderBookCollector.js';
import { optionsCollector }      from './collectors/optionsCollector.js';
import { onChainCollector }      from './collectors/onChainCollector.js';
import {
  startLiquidationStream,
  ensureLiquidationStreamRunning,
  getLiquidationPayloadForSymbol,
} from './collectors/liquidationCollector.js';
import { pollWhaleAlertTransactions } from './collectors/whaleAlertPoller.js';
import { ingestFinnhubEconomicCalendar } from './marketEventsIngest.js';
import { refreshNewsImpactCache } from './newsImpactPoller.js';
import { confluenceProcessor }   from './processors/confluenceProcessor.js';
import { volatilityProcessor }   from './processors/volatilityProcessor.js';
import { compositeScorer }       from './processors/compositeScorer.js';
import { saveIntelligence }      from './intelligenceService.js';
import { refreshMultiTimeframeCandles } from './fetchMultiTimeframeKlines.js';
import { maybeEmitFundingExtremeAlerts } from './fundingAlerts.js';
import { refreshMarketIntelApisFromStore } from './marketIntelResolvedApis.js';
import { listWhaleAlertsInRange } from '../db/services/whaleAlertsService.js';
import { listMarketEventsInRange } from '../db/services/marketEventsService.js';

/** @type {{ bot?: { getPublicState?: () => Record<string, unknown> } } | null} */
let intelligenceAppStateRef = null;

const intelligenceReadySymbols = new Set();

/**
 * True after the first successful composite snapshot for this futures symbol (e.g. BTCUSDT).
 * @param {string} symbol
 */
export function isIntelligenceReady(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  return sym.length > 0 && intelligenceReadySymbols.has(sym);
}

const INTERVALS = {
  fearGreed:    5  * 60 * 1000,
  funding:      30 * 1000,
  openInterest: 60 * 1000,
  options:      5  * 60 * 1000,
  onChain:      15 * 60 * 1000,
  composite:    30 * 1000,
};

export const intelligenceCache = {
  fearGreed:    null,
  funding:      {},
  openInterest: {},
  /** Latest raw depth tuples `{ bids, asks }` from Binance partial book — not overwritten by processors. */
  depthSnapshots: {},
  /** Per-symbol computed order-book metrics for composite scorer / WS payload. */
  orderBook:    {},
  options:      {},
  onChain:      {},
  /** Binance USD-M forceOrder stream → rolling 4h USD notionals per futures symbol. */
  liquidations: {},
  /** `{ GLOBAL, BTC, ETH, … }` — Finnhub + `/news_impact_score` per bucket. */
  newsImpact:   {},
  /** Per-symbol rows from `whale_alerts` (last poll window). */
  whaleAlerts:  {},
  /** Upcoming `market_events` rows for calendar dampening / UI. */
  calendarEvents: [],
  confluence:   {},
  volatility:   {},
  candles:      {},
  adx:          {},
  _lastComposite: {},
};

export function updateIntelligenceCandles(symbol, timeframe, candles) {
  if (!intelligenceCache.candles[symbol])
    intelligenceCache.candles[symbol] = {};
  intelligenceCache.candles[symbol][timeframe] = candles;
}

export function updateIntelligenceAdx(symbol, adxValue) {
  intelligenceCache.adx[symbol] = adxValue;
}

export function updateIntelligenceOrderBook(symbol, bids, asks) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return;
  intelligenceCache.depthSnapshots[sym] = { bids, asks };
}

export function getIntelligenceScore(symbol) {
  const comp = intelligenceCache._lastComposite?.[symbol];
  if (!comp) return null;
  return {
    composite:      comp.composite,
    bias:           comp.bias,
    confidence:     comp.confidence,
    sizeMultiplier: comp.sizeMultiplier,
  };
}

function normalizeIntelSymbol(symbol) {
  return String(symbol || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .trim()
    .toUpperCase();
}

/**
 * Symbols for REST pollers — intel candle cache plus bot chart/trade symbol so OI/funding
 * work before the first bar close (LIQ_CASCADE feed panel, etc.).
 */
export function resolveIntelligencePollSymbols() {
  const syms = new Set(
    Object.keys(intelligenceCache.candles)
      .map(normalizeIntelSymbol)
      .filter((s) => s.length >= 5),
  );

  const botState = intelligenceAppStateRef?.bot?.getPublicState?.() ?? {};
  for (const raw of [
    botState.symbol,
    botState.uiChartFocusSymbol,
    ...(Array.isArray(botState.multiCoinSignalTabSymbols) ? botState.multiCoinSignalTabSymbols : []),
  ]) {
    const sym = normalizeIntelSymbol(raw);
    if (sym.length >= 5) syms.add(sym);
  }

  return [...syms];
}

/** @type {Record<string, number>} */
const openInterestFetchedAt = {};

/**
 * Fetch Binance OI for symbols and merge into `intelligenceCache.openInterest`.
 * @param {string[]} [symbols]
 */
export async function ensureOpenInterestForSymbols(symbols) {
  const syms = (Array.isArray(symbols) ? symbols : resolveIntelligencePollSymbols())
    .map(normalizeIntelSymbol)
    .filter((s) => s.length >= 5);
  if (!syms.length) return intelligenceCache.openInterest;

  const fresh = await openInterestCollector.collect(syms);
  for (const [sym, row] of Object.entries(fresh)) {
    intelligenceCache.openInterest[sym] = row;
    openInterestFetchedAt[sym] = Date.now();
  }
  return intelligenceCache.openInterest;
}

export function getOpenInterestFetchedAt(symbol) {
  const sym = normalizeIntelSymbol(symbol);
  return openInterestFetchedAt[sym] ?? null;
}

/**
 * Recompute confluence, volatility, composite, persist, and optionally WS broadcast.
 * Used by the periodic poller and by bar-close for fresher UI than 30s-only ticks.
 *
 * @param {string} symbol
 * @param {{ broadcast?: (type: string, payload: unknown) => void } | null | undefined} [wsHub]
 */
export async function computeAndBroadcastIntelligenceSnapshot(symbol, wsHub) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return;

  await refreshMultiTimeframeCandles(sym, intelligenceCache);

  const liqSnap = getLiquidationPayloadForSymbol(sym);
  if (liqSnap) intelligenceCache.liquidations[sym] = liqSnap;
  else delete intelligenceCache.liquidations[sym];

  const bookData = orderBookCollector.collect([sym], intelligenceCache)[sym];
  if (bookData) intelligenceCache.orderBook[sym] = bookData;

  const fromWhaleIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const toNowIso = new Date().toISOString();
  try {
    const whales = await listWhaleAlertsInRange({
      fromIso: fromWhaleIso,
      toIso: toNowIso,
      symbol: sym,
    });
    intelligenceCache.whaleAlerts[sym] = whales;
  } catch (err) {
    console.warn(`[intelligence] whale_alerts ${sym}:`, err.message);
  }

  try {
    const fromEvIso = new Date().toISOString();
    const toEvIso = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    intelligenceCache.calendarEvents = await listMarketEventsInRange({
      fromIso: fromEvIso,
      toIso: toEvIso,
    });
  } catch (err) {
    console.warn('[intelligence] market_events:', err.message);
  }

  const botState = intelligenceAppStateRef?.bot?.getPublicState?.() ?? {};
  const stPeriod = Number(botState.supertrendPeriod) || 10;
  const stMult = Number(botState.supertrendMultiplier) || 3;
  const stWilder = Boolean(botState.supertrendWilderAtr);
  intelligenceCache.confluence[sym] = await confluenceProcessor.compute(sym, intelligenceCache, {
    period: stPeriod,
    multiplier: stMult,
    wilder: stWilder,
  });
  intelligenceCache.volatility[sym] = volatilityProcessor.compute(sym, intelligenceCache);

  maybeEmitFundingExtremeAlerts(
    intelligenceCache,
    sym,
    intelligenceCache.funding?.[sym]?.zscore,
    wsHub,
  );

  const composite = compositeScorer.score(sym, intelligenceCache);
  intelligenceCache._lastComposite[sym] = composite;

  const newsBaseKey = sym.replace(/USDT$/i, '').replace(/BUSD$/i, '').toUpperCase();

  if (!intelligenceReadySymbols.has(sym)) {
    intelligenceReadySymbols.add(sym);
    console.log(
      `[intelligence] ${sym} ready — composite: ${composite.composite}`,
      `bias: ${composite.bias}`,
      `signals: ${composite.bullishSignals.length}B / ${composite.bearishSignals.length}Be`,
    );
  }

  const ts = new Date().toISOString();
  const record = {
    symbol: sym,
    timestamp: ts,
    fearGreed:    intelligenceCache.fearGreed,
    funding:      intelligenceCache.funding?.[sym],
    openInterest: intelligenceCache.openInterest?.[sym],
    orderBook:    intelligenceCache.orderBook?.[sym],
    options:      intelligenceCache.options?.[sym],
    onChain:      intelligenceCache.onChain?.[sym],
    liquidations: intelligenceCache.liquidations?.[sym] ?? null,
    newsImpact:
      intelligenceCache.newsImpact?.[newsBaseKey] ?? intelligenceCache.newsImpact?.GLOBAL ?? null,
    confluence:   intelligenceCache.confluence?.[sym],
    volatility:   intelligenceCache.volatility?.[sym],
    composite,
  };

  saveIntelligence(record).catch(() => {});

  if (wsHub && typeof wsHub.broadcast === 'function') {
    wsHub.broadcast('intelligence_update', {
      symbol: sym,
      data: record,
      timestamp: ts,
    });
  }
}

/**
 * @param {{ broadcast?: (type: string, payload: unknown) => void } | null | undefined} wsHub
 * @param {{ bot?: { getPublicState?: () => Record<string, unknown> } } | null} [appState]
 */
export function startIntelligenceEngine(wsHub, appState = null) {
  intelligenceAppStateRef = appState;
  console.log('[intelligence] Starting engine...');

  void refreshMarketIntelApisFromStore().catch(() => {});

  startLiquidationStream({
    getTradingMode: () =>
      intelligenceAppStateRef?.bot?.getPublicState?.()?.tradingMode ||
      process.env.TRADING_MODE ||
      "PAPER",
  });
  // Kick once so first LIQ_CASCADE poll does not wait on a stuck socket.
  ensureLiquidationStreamRunning({
    getTradingMode: () =>
      intelligenceAppStateRef?.bot?.getPublicState?.()?.tradingMode ||
      process.env.TRADING_MODE ||
      "PAPER",
  });

  setTimeout(() => runPoller('fearGreed', async () => {
    intelligenceCache.fearGreed = await fearGreedCollector.collect();
  }, INTERVALS.fearGreed), 1000);

  setTimeout(() => runPoller('funding', async () => {
    const syms = resolveIntelligencePollSymbols();
    if (!syms.length) return;
    const fresh = await fundingCollector.collect(syms);
    intelligenceCache.funding = { ...intelligenceCache.funding, ...fresh };
  }, INTERVALS.funding), 3000);

  setTimeout(() => runPoller('openInterest', async () => {
    await ensureOpenInterestForSymbols();
  }, INTERVALS.openInterest), 5000);

  setTimeout(() => {
    const syms = resolveIntelligencePollSymbols();
    if (syms.length) void ensureOpenInterestForSymbols(syms).catch(() => {});
  }, 2500);

  setTimeout(() => runPoller('options', async () => {
    const syms = Object.keys(intelligenceCache.candles);
    if (syms.length)
      intelligenceCache.options = await optionsCollector.collect(syms);
  }, INTERVALS.options), 7000);

  setTimeout(() => runPoller('onChain', async () => {
    const syms = Object.keys(intelligenceCache.candles);
    if (syms.length)
      intelligenceCache.onChain = await onChainCollector.collect(syms);
  }, INTERVALS.onChain), 9000);

  setTimeout(() => runPoller('market_events_ingest', async () => {
    await ingestFinnhubEconomicCalendar({ daysForward: 10 });
  }, 6 * 60 * 60 * 1000), 13_000);

  setTimeout(() => runPoller('whale_alerts', async () => {
    await pollWhaleAlertTransactions(wsHub ? { wsHub } : null);
  }, 10 * 60 * 1000), 14_000);

  setTimeout(() => runPoller('news_impact', async () => {
    await refreshNewsImpactCache(intelligenceCache);
  }, 12 * 60 * 1000), 15_500);

  setTimeout(() => runPoller('composite', async () => {
    const syms = Object.keys(intelligenceCache.candles);
    if (!syms.length) return;

    for (const symbol of syms) {
      try {
        await computeAndBroadcastIntelligenceSnapshot(symbol, wsHub);
      } catch (err) {
        console.warn(`[intelligence] composite ${symbol}:`, err.message);
      }
    }
  }, INTERVALS.composite), 12000);

  console.log('[intelligence] All pollers scheduled');
}

function runPoller(name, fn, interval) {
  const run = async () => {
    try { await fn(); }
    catch (err) { console.warn(`[intelligence] ${name}:`, err.message); }
  };
  run();
  setInterval(run, interval);
}
