import { clamp, roundTo } from "../lib/math.js";
import { computeIndicators } from "../strategy/indicators.js";
import { detectRegime } from "../strategy/regime.js";
import { strategies } from "../strategy/strategies.js";
import { pickStrategyAuto, topStrategies } from "../strategy/selector.js";
import { riskPlan } from "../strategy/risk.js";
import { createMarketFeed } from "./marketFeed.js";
import { createBinanceUniverse } from "../svc/universe/binanceUniverse.js";
import { createBinanceOrderBook } from "./orderBookBinance.js";
import {
  depthNotionalUsd,
  fetchBinanceFuturesFundingRate,
  fundingBlocksTrade,
  spreadBpsFromBook,
} from "../svc/executionGuards.js";
import { createCoinGeckoClient } from "../svc/external/coingecko.js";

/** Blend calibrated vs raw AI probability (reduces isotonic collapse). */
function aiGateProbability(calProb, rawProb) {
  const useRaw =
    String(process.env.AI_GATE_USE_RAW || "").toLowerCase() === "1" ||
    String(process.env.AI_GATE_USE_RAW || "").toLowerCase() === "true";
  const cal = Number(calProb);
  const raw = Number(rawProb);
  if (useRaw && Number.isFinite(raw)) return clamp(raw, 0, 1);
  const w = clamp(Number(process.env.AI_GATE_CALIBRATED_BLEND ?? "0.65"), 0, 1);
  if (Number.isFinite(raw) && Number.isFinite(cal)) return clamp(w * cal + (1 - w) * raw, 0, 1);
  return clamp(Number.isFinite(cal) ? cal : 0, 0, 1);
}

/** Futures income sync: generic ledger rows only — not bracket-matched REALIZED_PNL (localEnforcement). */
function isIncomeLedgerClose(t) {
  if (!t) return false;
  if (t.meta?.localEnforcement === true) return false;
  if (t.ledgerEvent === true || t.meta?.ledgerEvent === true) return true;
  if (String(t.strategy || "").toUpperCase() === "INCOME_LEDGER") return true;
  if (String(t.strategy || "") === "FUTURES_DEMO") return true;
  if (t.meta?.note === "realized_pnl_ledger_row") return true;
  if (t.meta?.source === "fapi_income") return true;
  return false;
}

export function createBot({ log, ai, exchange, defaults }) {
  let exch = exchange;
  const state = {
    running: false,
    symbol: defaults.symbol,
    timeframe: defaults.timeframe,
    symbolMode: "AUTO", // SINGLE | AUTO (coin selection)
    aiThreshold: defaults.aiThreshold,
    riskPerTrade: defaults.riskPerTrade,
    maxDailyLoss: defaults.maxDailyLoss,
    strategyMode: "AUTO", // AUTO | MANUAL
    manualStrategy: "EMA_CROSS",
    marketMode: "AUTO", // SPOT | FUTURES | AUTO
    /** AUTO: per trade via decideFuturesLeverage (AI + volatility). MANUAL: use futuresLeverage for every futures order. */
    futuresLeverageMode: "AUTO",
    futuresLeverage: Math.max(1, Math.min(50, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5))),
    lastDecision: null,
    lastAi: null,
    lastRegime: null,
    regimeConfirmCandles: Number(process.env.REGIME_CONFIRM_CANDLES || 4),
    regimeCandidate: null, // { type, firstSeenAt }
    universe: null, // last scan snapshot
    universeLastPick: null,
    universeSwitchCooldownMs: Number(process.env.UNIVERSE_SWITCH_COOLDOWN_MS || 5 * 60_000),
    coinLastSwitchedAt: null,
    feedGraceMsAfterSwitch: Number(process.env.FEED_GRACE_MS_AFTER_SWITCH || 30_000),
    tradeCooldownMs: Number(process.env.TRADE_COOLDOWN_MS || 180_000),
    lastTradeOpenedAt: null,
    maxTradesPerHour: Number(process.env.MAX_TRADES_PER_HOUR || 3),
    tradeOpenTimestamps: [],
    maxConcurrentPositions: Number(process.env.MAX_CONCURRENT_POSITIONS || 1),
    stats: Object.fromEntries(Object.keys(strategies).map((k) => [k, { trades: 0, wins: 0, pnl: 0 }])),
    /** Per-venue day start for hybrid demo (spot + futures wallets). */
    dailyVenueBaseline: null,
    // Live performance monitoring
    perfWindow: [],    // rolling trade results: { ts, pnl }
    peakEquity: 0,     // for max drawdown tracking
    maxDrawdownPct: 0,
    // RL bandit state: learns optimal threshold from recent outcomes
    rlBandit: { trials: 0, sumReward: 0, threshold: null },
    // Execution quality log
    execLog: [],       // { ts, symbol, intendedPx, filledPx, slippage, latencyMs }
    /** Last reason the bot did not open (or just opened) a trade — for API/UI diagnostics */
    lastTradeBlock: null,
    /** Ops / latency / microstructure (for /api/metrics) */
    metrics: {
      tickCount: 0,
      lastPredictLatencyMs: null,
      lastSpreadBps: null,
      lastDepthNotionalUsd: null,
      lastFundingRate: null,
      feedStaleStops: 0,
      startedAt: Date.now(),
    },
    _fundingCache: { symbol: null, rate: null, at: 0 },
  };

  function noteTradeBlock(payload) {
    state.lastTradeBlock = { ts: new Date().toISOString(), ...payload };
  }

  async function getCachedFunding(symbol) {
    const ttl = Number(process.env.FUNDING_CACHE_TTL_MS || 60_000);
    const now = Date.now();
    const c = state._fundingCache;
    if (
      c?.symbol === symbol &&
      now - c.at < ttl &&
      (Number.isFinite(Number(c.rate)) || c.rate === null)
    ) {
      return Number.isFinite(Number(c.rate)) ? Number(c.rate) : null;
    }
    const rate = await fetchBinanceFuturesFundingRate(symbol);
    state._fundingCache = { symbol, rate, at: now };
    return rate;
  }

  const feed = createMarketFeed({ log, symbol: state.symbol, timeframe: state.timeframe });
  const depth =
    String(process.env.MARKET_FEED || "SYNTH").toUpperCase() === "BINANCE"
      ? createBinanceOrderBook({ log, symbol: state.symbol, wsBase: process.env.BINANCE_WS_BASE })
      : null;
  const universe = createBinanceUniverse({ log });
  const cg = createCoinGeckoClient({ log });
  let lastSeenTradeId = null;
  let closedSinceRetrain = 0;
  let tickInFlight = false;
  let wsHubRef = null;
  let _cachedAccount = null;
  let _cachedPositions = [];
  let _lastAccountFetchAt = 0;
  const ACCOUNT_FETCH_INTERVAL_MS = Number(process.env.ACCOUNT_FETCH_INTERVAL_MS || 5000);

  function pickVenueExchange({ side, prob, regime, atrPct }) {
    const spot = exch?.spot || null;
    const futures = exch?.futures || null;
    const want = String(state.marketMode || "AUTO").toUpperCase();
    if (want === "SPOT") return spot || futures || null;
    if (want === "FUTURES") return futures || spot || null;

    // AUTO: route SELL to futures if available (spot can't short in our build).
    if (side === "SELL" && futures) return futures;

    const p = Number(prob || 0);
    const a = Number(atrPct || 0);
    const reg = String(regime || "").toUpperCase();
    const volatile = reg.includes("VOLAT") || a >= 0.008;
    const confident = p >= Number(state.aiThreshold || 0.4) + 0.05;
    if (volatile && confident && futures) return futures;
    return spot || futures || null;
  }

  function decideFuturesLeverage({ prob, atrPct, regime }) {
    // Conservative, confidence-based leverage. We also scale down in very volatile regimes.
    const p = clamp(Number(prob ?? 0), 0, 1);
    const a = Math.max(0, Number(atrPct || 0));
    const reg = String(regime || "").toUpperCase();
    const volatile = reg.includes("VOLAT") || a >= 0.012;

    let lev =
      p >= 0.85 ? 15 :
      p >= 0.78 ? 10 :
      p >= 0.70 ? 7 :
      p >= 0.62 ? 5 :
      p >= 0.55 ? 3 : 2;

    if (volatile) lev = Math.max(2, Math.floor(lev * 0.6));
    return clamp(lev, 1, 5);
  }

  function utcDayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  /**
   * When account.venues.{spot,futures} exists (e.g. BINANCE_DEMO_API hybrid), compute each wallet's
   * daily return from UTC day baseline so max-daily-loss applies per leg.
   */
  function computeDailyVenueLoss(account, maxDailyLossAbs) {
    const MIN_START = 10;
    const dayKey = utcDayKey();
    const venues = account?.venues;
    if (!venues || (!venues.spot && !venues.futures)) {
      return {
        dailyPnlPctByVenue: null,
        dailyPnlPctWorst: Number(account?.dailyPnlPct ?? 0),
        exceeded: Number(account?.dailyPnlPct ?? 0) <= -Math.abs(maxDailyLossAbs),
      };
    }
    if (!state.dailyVenueBaseline || typeof state.dailyVenueBaseline !== "object") state.dailyVenueBaseline = {};

    const dailyPnlPctByVenue = {};
    for (const key of ["spot", "futures"]) {
      const v = venues[key];
      if (!v || v.equity == null) continue;
      const eq = Number(v.equity);
      if (!Number.isFinite(eq)) continue;
      let base = state.dailyVenueBaseline[key];
      if (!base || base.dayKey !== dayKey) {
        state.dailyVenueBaseline[key] = { dayKey, startEquity: eq };
        base = state.dailyVenueBaseline[key];
      }
      const start = Number(base.startEquity);
      if (!Number.isFinite(start) || start < MIN_START) {
        dailyPnlPctByVenue[key] = 0;
        continue;
      }
      dailyPnlPctByVenue[key] = (eq - start) / start;
    }

    const vals = Object.values(dailyPnlPctByVenue).filter((x) => Number.isFinite(x));
    const dailyPnlPctWorst = vals.length ? Math.min(...vals) : 0;
    const threshold = -Math.abs(maxDailyLossAbs);
    const exceeded = ["spot", "futures"].some((k) => {
      const pct = dailyPnlPctByVenue[k];
      if (pct == null || !Number.isFinite(pct)) return false;
      const start = state.dailyVenueBaseline[k]?.startEquity;
      return Number(start) >= MIN_START && pct <= threshold;
    });

    return { dailyPnlPctByVenue, dailyPnlPctWorst, exceeded };
  }

  setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    tick({ wsHub: wsHubRef })
      .catch((e) => log.warn("tick_error", { error: String(e?.message || e) }))
      .finally(() => { tickInFlight = false; });
  }, 1000);
  // Depth broadcast loop (UI order book)
  setInterval(() => {
    if (!wsHubRef) return;
    if (!depth) return;
    const b = depth.getBook();
    if (!b?.symbol) return;
    wsHubRef.broadcast("depth", b);
  }, 500);

  // External context loop (CoinGecko market context for current symbol)
  let cgInFlight = false;
  setInterval(() => {
    if (!wsHubRef) return;
    if (cgInFlight) return;
    if (String(process.env.ENABLE_COINGECKO || "1") === "0") return;
    cgInFlight = true;
    (async () => {
      try {
        const ctx = await cg.marketContext({ symbol: state.symbol });
        if (ctx?.ok) wsHubRef.broadcast("external", ctx);
      } catch {
        // ignore
      } finally {
        cgInFlight = false;
      }
    })();
  }, 30_000);

  // Coin selection loop (runs even if bot stopped so you can see ranks).
  let scanInFlight = false;
  setInterval(() => {
    if (scanInFlight) return;
    if (String(process.env.MARKET_FEED || "SYNTH").toUpperCase() !== "BINANCE") return;
    if (state.symbolMode !== "AUTO") return;
    scanInFlight = true;
    (async () => {
      try {
        const snap = await universe.scanAndRank({
          timeframe: state.timeframe,
          universeSize: Number(process.env.UNIVERSE_SIZE || 30),
          topKlines: Number(process.env.UNIVERSE_TOP_KLINES || 12),
          minQuoteVolumeUSDT: Number(process.env.UNIVERSE_MIN_QUOTE_VOL || 5_000_000),
          maxSpreadPct: Number(process.env.UNIVERSE_MAX_SPREAD_PCT || 0.0015),
          excludeStablePairs: String(process.env.UNIVERSE_EXCLUDE_STABLES || "1") !== "0",
          aiClient: ai,
        });
        state.universe = snap;
        // Attach account + positions so the UI doesn't flash empty
        const acct = await exch.getAccount().catch(() => null);
        const pos = await exch.getPositions().catch(() => []);
        wsHubRef?.broadcast?.("state", { mode: process.env.TRADING_MODE || "PAPER", ...getPublicState(), account: acct, positions: pos });

        const positions = await exch.getPositions().catch(() => []);
        const openPositions = Array.isArray(positions) ? positions : [];
        const openCount = openPositions.length;
        if (openCount >= state.maxConcurrentPositions) return;

        const openSymbols = new Set(
          openPositions
            .map((p) => String(p?.symbol || "").toUpperCase())
            .filter(Boolean)
        );

        // Prefer a candidate we don't already hold, so we can open multi-crypto positions.
        const selectedSyms = Array.isArray(snap?.selected) && snap.selected.length ? snap.selected : [];
        const rankedSyms = Array.isArray(snap?.ranked) ? snap.ranked.map((r) => r?.symbol).filter(Boolean) : [];
        const candidates = selectedSyms.length ? selectedSyms : rankedSyms;
        const best =
          candidates.find((s) => !openSymbols.has(String(s).toUpperCase())) ||
          snap?.selected?.[0] ||
          rankedSyms?.[0] ||
          null;

        if (!best) return;
        // If we already hold some positions, allow faster switching to fill remaining capacity.
        const cooldownMs = openCount > 0 ? Math.min(state.universeSwitchCooldownMs, 60_000) : state.universeSwitchCooldownMs;
        if (
          state.coinLastSwitchedAt &&
          Date.now() - Number(state.coinLastSwitchedAt) < cooldownMs
        )
          return;
        if (String(best).toUpperCase() === String(state.symbol).toUpperCase()) return;

        state.symbol = String(best).toUpperCase();
        state.universeLastPick = { ts: new Date().toISOString(), symbol: best };
        state.coinLastSwitchedAt = Date.now();
        feed.setSymbol(best);
        try {
          depth?.setSymbol?.(best);
        } catch {
          // ignore
        }
        wsHubRef?.broadcast?.("log", { level: "info", msg: "Auto-selected coin", symbol: best });
      } catch (e) {
        wsHubRef?.broadcast?.("log", { level: "warn", msg: "Universe scan failed", error: String(e?.message || e) });
      } finally {
        scanInFlight = false;
      }
    })();
  }, 30_000);

  // Auto-train on real Binance data if the model is missing, stale, or
  // was only trained on synthetic bootstrap data.
  setTimeout(async () => {
    try {
      const h = await ai.health();
      const meta = h?.meta;
      const modelOk = h?.model_loaded && h?.model_compatible;
      const source = meta?.source;
      if (!modelOk || source === "bootstrap") {
        const reason = !h?.model_loaded
          ? "no_model"
          : !h?.model_compatible
            ? "feature_mismatch"
            : "bootstrap_only";
        log.info("auto_train_start", { reason, source });
        wsHubRef?.broadcast?.("log", {
          level: "info",
          msg: `Auto-training AI on real Binance data (${reason})…`,
        });
        const r = await ai.trainFromBinance({
          symbols: [
            "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
            "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
          ],
          interval: "1m",
          // Default 24k/symbol balances quality vs cold-start time; override with AUTO_TRAIN_CANDLES_PER_SYMBOL
          candlesPerSymbol: Number(process.env.AUTO_TRAIN_CANDLES_PER_SYMBOL || 24000),
          horizon: Number(process.env.AUTO_TRAIN_HORIZON || 90),
          feeBps: Number(process.env.AUTO_TRAIN_FEE_BPS ?? 10),
        });
        log.info("auto_train_done", {
          rows: r?.trained_rows,
          accuracy: r?.val_accuracy,
          precision: r?.val_precision,
        });
        wsHubRef?.broadcast?.("log", {
          level: "info",
          msg: `AI model trained on real data — accuracy ${r?.val_accuracy}, precision ${r?.val_precision}`,
        });
      } else {
        log.info("model_already_trained", { source, features: meta?.n_features });
      }
    } catch (e) {
      log.warn("auto_train_failed", { error: String(e?.message || e) });
      wsHubRef?.broadcast?.("log", {
        level: "warn",
        msg: "Auto-train failed: " + String(e?.message || e),
      });
    }
  }, 8000);

  function getPublicState() {
    return {
      running: state.running,
      symbol: state.symbol,
      timeframe: state.timeframe,
      symbolMode: state.symbolMode,
      aiThreshold: state.aiThreshold,
      riskPerTrade: state.riskPerTrade,
      maxDailyLoss: state.maxDailyLoss,
      strategyMode: state.strategyMode,
      manualStrategy: state.manualStrategy,
      marketMode: state.marketMode,
      futuresLeverageMode: state.futuresLeverageMode,
      futuresLeverage: state.futuresLeverage,
      feed: feed.getStatus ? feed.getStatus() : null,
      exchange: { name: exch?.name || null, storeInfo: exch?.storeInfo || null },
      exchangeStatus: exch?.getStatus?.() || null,
      depth: depth?.getStatus?.() || null,
      lastDecision: state.lastDecision,
      lastAi: state.lastAi,
      lastRegime: state.lastRegime,
      topStrategies: topStrategies(state.stats),
      universe: state.universe,
      universeLastPick: state.universeLastPick,
      riskGuards: {
        tradeCooldownMs: state.tradeCooldownMs,
        maxTradesPerHour: state.maxTradesPerHour,
        maxConcurrentPositions: state.maxConcurrentPositions,
        universeSwitchCooldownMs: state.universeSwitchCooldownMs,
      },
      performance: (() => {
        const pw = state.perfWindow || [];
        const wins = pw.filter((t) => t.pnl > 0);
        const losses = pw.filter((t) => t.pnl <= 0);
        const n = pw.length;
        const winRate = n > 0 ? wins.length / n : 0;
        const avgPnl = n > 0 ? pw.reduce((a, t) => a + t.pnl, 0) / n : 0;
        const returns = pw.map((t) => t.pnl);
        const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const variance = returns.length > 1 ? returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
        const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252 * 24) : 0;
        return {
          totalTrades: n,
          winRate: roundTo(winRate, 4),
          avgPnl: roundTo(avgPnl, 4),
          rollingSharpe: roundTo(sharpe, 4),
          maxDrawdownPct: roundTo(state.maxDrawdownPct || 0, 4),
          peakEquity: roundTo(state.peakEquity || 0, 2),
        };
      })(),
      rlBandit: state.rlBandit ? {
        trials: state.rlBandit.trials,
        adaptedThreshold: state.rlBandit.threshold,
      } : null,
      lastTradeBlock: state.lastTradeBlock,
      execLog: (state.execLog || []).slice(-25),
      metrics: {
        ...state.metrics,
        uptimeSec: Math.round((Date.now() - state.metrics.startedAt) / 1000),
      },
    };
  }

  async function ingestClosedTrades({ wsHub }) {
    const trades = await exch.getTrades();
    if (!trades.length) return;

    // Find trades newer than last seen ID (handles capped/sliding buffers)
    let startIdx = 0;
    if (lastSeenTradeId != null) {
      const idx = trades.findIndex((t) => t.id === lastSeenTradeId);
      if (idx >= 0) startIdx = idx + 1;
      else startIdx = trades.length; // ID was evicted — skip to avoid replays
    }
    if (startIdx >= trades.length) {
      lastSeenTradeId = trades[trades.length - 1]?.id ?? lastSeenTradeId;
      return;
    }
    const newTrades = trades.slice(startIdx);
    lastSeenTradeId = trades[trades.length - 1]?.id ?? lastSeenTradeId;

    for (const t of newTrades) {
      if (t.type !== "CLOSE") continue;
      wsHub?.broadcast("trade", { ...t });

      if (isIncomeLedgerClose(t)) {
        continue;
      }

      closedSinceRetrain += 1;

      const st = state.stats[t.strategy] || null;
      if (st) {
        st.pnl += Number(t.pnl || 0);
        if (Number(t.pnl || 0) > 0) st.wins += 1;
      }

      // Performance monitoring: rolling window of recent trades
      const pnlVal = Number(t.pnl || 0);
      state.perfWindow = (state.perfWindow || []).concat({ ts: t.ts, pnl: pnlVal }).slice(-100);

      // Drawdown tracking
      const equity = Number((await exch.getAccount().catch(() => ({}))).equity || 0);
      if (equity > (state.peakEquity || 0)) state.peakEquity = equity;
      if (state.peakEquity > 0) {
        const dd = (state.peakEquity - equity) / state.peakEquity;
        if (dd > (state.maxDrawdownPct || 0)) state.maxDrawdownPct = dd;
        // Auto-stop if drawdown exceeds safety limit
        const maxDDLimit = Number(process.env.MAX_DRAWDOWN_PCT || 0.15);
        if (dd >= maxDDLimit && state.running) {
          state.running = false;
          wsHub?.broadcast("log", {
            level: "warn",
            msg: `Bot auto-stopped: max drawdown ${(dd * 100).toFixed(1)}% exceeded limit ${(maxDDLimit * 100).toFixed(0)}%`,
          });
        }
      }

      // RL contextual bandit: update Thompson-sampling-style reward tracker
      const aiProb = Number(t?.meta?.aiProbability ?? state.lastAi?.probability ?? 0.5);
      const reward = pnlVal > 0 ? 1 : pnlVal < 0 ? -1 : 0;
      state.rlBandit = state.rlBandit || { trials: 0, sumReward: 0, threshold: null };
      const rDecay = Number(process.env.RL_BANDIT_REWARD_DECAY ?? "1");
      if (Number.isFinite(rDecay) && rDecay > 0 && rDecay < 1) {
        state.rlBandit.sumReward *= rDecay;
      }
      state.rlBandit.trials += 1;
      state.rlBandit.sumReward += reward;
      // Simple learned threshold: if average reward is negative, raise threshold
      if (state.rlBandit.trials >= 15) {
        const avgReward = state.rlBandit.sumReward / state.rlBandit.trials;
        const baseT = Number(state.aiThreshold || 0.5);
        state.rlBandit.threshold = clamp(baseT - avgReward * 0.05, 0.35, 0.85);
      }

      try {
        const prob = Number(t?.meta?.aiProbability ?? state.lastAi?.probability ?? 0.5);
        const feats = t?.meta?.aiFeatures ?? state.lastAi?.features ?? {};
        await ai.feedback({
          symbol: t.symbol,
          strategy: t.strategy || "UNKNOWN",
          timeframe: state.timeframe,
          side: t.side,
          probability: prob,
          features: feats,
          pnl: Number(t.pnl || 0),
          outcome: Number(t.pnl || 0) > 0 ? "WIN" : Number(t.pnl || 0) < 0 ? "LOSS" : "BREAKEVEN",
          ts: t.ts,
        });
      } catch {
        // ignore
      }
    }

    const every = Number(process.env.RETRAIN_EVERY_CLOSED_TRADES || 0);
    const minRows = Number(process.env.RETRAIN_MIN_ROWS || 200);
    if (every > 0 && closedSinceRetrain >= every) {
      closedSinceRetrain = 0;
      try {
        wsHub?.broadcast("log", { level: "info", msg: "Auto-retraining AI model from feedback…" });
        const r = await ai.retrainFromFeedback({ minRows });
        wsHub?.broadcast("log", { level: "info", msg: "AI retrain complete", ...r });
      } catch {
        wsHub?.broadcast("log", { level: "warn", msg: "AI retrain failed" });
      }
    }
  }

  async function tick({ wsHub }) {
    const candles = feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) return;
    state.metrics.tickCount += 1;

    // Safety: skip tick (but stay running) if feed is reconnecting after symbol switch.
    // Only hard-stop after prolonged staleness (60s without data).
    const feedStatus = feed.getStatus ? feed.getStatus() : null;
    const inGrace =
      state.coinLastSwitchedAt && Date.now() - Number(state.coinLastSwitchedAt) < Number(state.feedGraceMsAfterSwitch || 0);

    // After AUTO switches symbols, the feed may still be streaming the previous symbol
    // for a short moment. Avoid broadcasting/marking using stale candles for a new symbol.
    if (
      state.running &&
      state.coinLastSwitchedAt &&
      inGrace &&
      feedStatus?.lastMsgAt &&
      Number(feedStatus.lastMsgAt) < Number(state.coinLastSwitchedAt)
    ) {
      return;
    }
    if (state.running && !inGrace && feedStatus?.ok === false) {
      // Skip tick but don't stop — feed may reconnect
      return;
    }
    if (state.running && !inGrace && feedStatus?.lastMsgAt && Date.now() - Number(feedStatus.lastMsgAt) > 60_000) {
      state.running = false;
      state.metrics.feedStaleStops += 1;
      wsHub?.broadcast("log", { level: "warn", msg: "Bot auto-stopped: feed stale >60s", feed: feedStatus });
      log.warn("bot_auto_stopped_feed_stale", { symbol: state.symbol, lastMsgAt: feedStatus.lastMsgAt });
      return;
    }

    await exch.markToMarket({ symbol: state.symbol, price: last.close });
    await ingestClosedTrades({ wsHub });

    const indicators = computeIndicators(candles);
    const rawRegime = detectRegime({ candles, indicators });
    // Regime confirmation to avoid noisy switching
    if (!state.regimeCandidate || state.regimeCandidate.type !== rawRegime.type) {
      state.regimeCandidate = { type: rawRegime.type, seen: 1 };
    } else {
      state.regimeCandidate.seen += 1;
    }
    const confirmed = state.regimeCandidate.seen >= Math.max(1, state.regimeConfirmCandles);
    const regime = confirmed ? rawRegime : { ...rawRegime, type: state.lastRegime?.type || rawRegime.type, pending: rawRegime.type };
    state.lastRegime = regime;

    let account = _cachedAccount;
    let positions = _cachedPositions;
    let accountError = null;
    const nowMs = Date.now();
    if (nowMs - _lastAccountFetchAt >= ACCOUNT_FETCH_INTERVAL_MS || !_cachedAccount) {
      try {
        account = await exch.getAccount();
        positions = await exch.getPositions();
        _cachedAccount = account;
        _cachedPositions = positions;
        _lastAccountFetchAt = nowMs;
      } catch (e) {
        accountError = String(e?.message || e);
        account = _cachedAccount;
        positions = _cachedPositions;
        _lastAccountFetchAt = nowMs;
        if (!account) {
          wsHub?.broadcast("log", { level: "warn", msg: "Exchange account/positions unavailable", error: accountError });
        }
      }
    }

    // Time-based exits (must run after positions are loaded — not before `let positions`)
    const maxPosAgeMs = Number(process.env.MAX_POSITION_AGE_MS || 0);
    if (maxPosAgeMs > 0 && Array.isArray(positions) && positions.length > 0) {
      for (const p of positions) {
        const openedAt = p.openedAt || p.meta?.openedAt;
        if (!openedAt) continue;
        const ageMs = Date.now() - new Date(openedAt).getTime();
        if (ageMs > maxPosAgeMs) {
          try {
            await exch.closePosition?.({ id: p.id, price: last.close, reason: "TIME_EXIT" });
            wsHub?.broadcast("log", { level: "info", msg: "Time-based exit", symbol: p.symbol, ageMs });
          } catch {
            // will be caught next tick
          }
        }
      }
    }

    const markPrice = Number(last.close);
    const positionsMtM = positions.map((p) => {
      // USD-M on exchange: use Binance-reported unrealized PnL (do not conflate with local paper sim).
      if (p.venue === "FUTURES" && p.syncSource === "fapi_v2_account") {
        const apiUpnl = Number(p.unrealizedPnl ?? p.unrealizedProfit ?? 0);
        return { ...p, markPrice, unrealizedPnl: Number.isFinite(apiUpnl) ? apiUpnl : null };
      }
      const isLong = p.side === "BUY";
      // Use the live mark price only for the currently streamed symbol.
      // In multi-coin AUTO, positions from other symbols must not use the wrong symbol's price.
      if (p?.symbol !== state.symbol) {
        return { ...p, markPrice, unrealizedPnl: null };
      }
      const uPnl = isLong
        ? (markPrice - Number(p.entryPrice)) * Number(p.qty)
        : (Number(p.entryPrice) - markPrice) * Number(p.qty);
      return { ...p, markPrice, unrealizedPnl: uPnl };
    });
    const unrealizedPnl = positionsMtM.reduce((a, p) => a + Number(p.unrealizedPnl || 0), 0);
    const equityWithUnrealized = Number(account?.equity ?? 0) + unrealizedPnl;

    const dv = computeDailyVenueLoss(account, state.maxDailyLoss);
    const dailyPnlPct = account?.venues?.spot || account?.venues?.futures ? dv.dailyPnlPctWorst : (account?.dailyPnlPct ?? 0);
    const dailyPnlPctByVenue = dv.dailyPnlPctByVenue;
    const exceededDailyLoss = dv.exceeded;
    if (exceededDailyLoss) {
      state.running = false;
      wsHub?.broadcast("log", {
        level: "warn",
        msg: "Bot auto-stopped: max daily loss exceeded",
        dailyPnlPct,
        dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
      });
      wsHub?.broadcast("state", {
        ...getPublicState(),
        account: {
          ...(account || {}),
          markPrice,
          unrealizedPnl,
          equityWithUnrealized,
          accountError,
          dailyPnlPct,
          dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
        },
        positions: positionsMtM,
      });
      return;
    }

    const strategyKey =
      state.strategyMode === "AUTO"
        ? pickStrategyAuto({ regime, indicators, stats: state.stats })
        : state.manualStrategy;

    const strat = strategies[strategyKey];
    const signal = strat.signal({ candles, indicators, regime });

    state.lastDecision = { ts: new Date().toISOString(), strategyKey, signal };
    log.info("decision_made", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      regime: regime?.type,
      pendingRegime: regime?.pending,
      strategyKey,
      action: signal?.action,
    });

    wsHub?.broadcast("market", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      candle: last,
      indicators: indicators.latest,
      regime,
    });

    wsHub?.broadcast("state", {
      ...getPublicState(),
      account: {
        ...(account || {}),
        markPrice,
        unrealizedPnl,
        equityWithUnrealized,
        accountError,
        dailyPnlPct,
        dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
      },
      positions: positionsMtM,
    });

    if (!state.running) return;

    // --- AI predict runs every few seconds (the AI is the brain) ---
    const AI_PREDICT_INTERVAL_MS = 5_000;
    const aiLastCalledAt = state._aiLastCalledAt || 0;
    const tickNow = Date.now();
    let aiResp = null;
    let prob = 0;

    if (tickNow - aiLastCalledAt >= AI_PREDICT_INTERVAL_MS) {
      try {
        const tPred = Date.now();
        aiResp = await ai.predict({ symbol: state.symbol, timeframe: state.timeframe, candles });
        state.metrics.lastPredictLatencyMs = Date.now() - tPred;
        state.lastAi = {
          probability: aiResp.probability,
          rawProbability: aiResp.raw_probability ?? aiResp.rawProbability,
          shortProbability: aiResp.short_probability ?? aiResp.shortProbability ?? null,
          shortRawProbability: aiResp.short_raw_probability ?? aiResp.shortRawProbability ?? null,
          calibrated: aiResp.calibrated,
          features: aiResp.features,
          model_kind: aiResp.model_kind || aiResp.modelKind,
        };
        state._aiLastCalledAt = tickNow;
      } catch (e) {
        const errMsg = String(e?.response?.data?.detail || e?.message || e);
        wsHub?.broadcast("log", { level: "error", msg: "AI predict failed; skipping trade", error: errMsg });
        log.warn("ai_predict_failed", { symbol: state.symbol, error: errMsg });
        noteTradeBlock({ reason: "ai_predict_failed", detail: errMsg, symbol: state.symbol });
        return;
      }
      const calProb = Number(aiResp?.probability ?? 0);
      const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
      prob = aiGateProbability(calProb, rawProb);
      log.info("ai_scored", {
        symbol: state.symbol,
        probability: calProb,
        gateProbability: prob,
        aiGateBlend: process.env.AI_GATE_CALIBRATED_BLEND ?? "0.65",
        rawProbability: Number.isFinite(rawProb) ? rawProb : NaN,
        calibrated: Boolean(aiResp?.calibrated),
        modelKind: aiResp?.model_kind || aiResp?.modelKind || null,
        strategySignal: signal.action,
      });
    } else {
      const calProb = Number(state.lastAi?.probability ?? 0);
      const rawProb = Number(state.lastAi?.rawProbability ?? NaN);
      prob = aiGateProbability(calProb, rawProb);
      aiResp = state.lastAi;
    }

    // Trade direction comes from the strategy signal (CONFLUENCE / manual). No EMA override.
    const venueEx0 = pickVenueExchange({
      side: signal.action,
      prob,
      regime: regime?.type,
      atrPct: regime?.atrPct,
    });
    const exName = String(venueEx0?.name || "");
    const isSpotExchange = exName === "paper" || exName === "binance_demo" || exName.includes("spot");
    let tradeAction = signal.action;
    let tradeReason = signal.reason;

    // On spot exchanges, only BUY is possible (no shorting)
    if (isSpotExchange && tradeAction === "SELL") {
      tradeAction = "HOLD";
    }

    // Direction-aware AI: SELL must use short model probability (long model is not meaningful for shorts).
    if (tradeAction === "SELL") {
      const shortProb = Number(state.lastAi?.shortProbability ?? NaN);
      const shortRaw = Number(state.lastAi?.shortRawProbability ?? NaN);
      if (Number.isFinite(shortProb) && shortProb > 0) {
        prob = aiGateProbability(shortProb, shortRaw);
      } else if (String(process.env.AI_ALLOW_SELL_WITHOUT_SHORT_MODEL || "").toLowerCase() === "1" ||
        String(process.env.AI_ALLOW_SELL_WITHOUT_SHORT_MODEL || "").toLowerCase() === "true") {
        // Degraded: keep long-side prob (misleading for shorts; off unless explicitly enabled).
      } else {
        noteTradeBlock({
          reason: "short_ai_unavailable",
          strategyKey,
          symbol: state.symbol,
          detail: "Train AI with /train/from-binance (risk_aligned) so model_short.pkl exists",
        });
        wsHub?.broadcast("log", {
          level: "info",
          msg: "SELL blocked: short AI model score unavailable (retrain AI or set AI_ALLOW_SELL_WITHOUT_SHORT_MODEL=1)",
          strategyKey,
          symbol: state.symbol,
        });
        return;
      }
    }

    // Regime-adaptive threshold: tighter in volatile/sideways, looser in trending
    const regimeType = String(regime?.type || "").toUpperCase();
    let adaptiveThreshold =
      String(process.env.AI_REGIME_ADAPTIVE || "1") === "1"
        ? regimeType === "VOLATILE" ? Math.max(state.aiThreshold, 0.75)
          : regimeType === "SIDEWAYS" ? Math.max(state.aiThreshold, 0.68)
          : Math.max(state.aiThreshold, 0.58)
        : state.aiThreshold;

    // Wire RL bandit learned threshold (raises gate when recent trades are net-negative)
    const rlT = state.rlBandit?.threshold;
    if (rlT != null && state.rlBandit.trials >= 15) {
      adaptiveThreshold = Math.max(adaptiveThreshold, rlT);
    }

    if (tradeAction === "HOLD") {
      noteTradeBlock({
        reason: "strategy_hold",
        strategyKey,
        probability: prob,
        threshold: adaptiveThreshold,
        regime: regimeType,
        symbol: state.symbol,
      });
      wsHub?.broadcast("log", {
        level: "info",
        msg: "No trade: strategy HOLD",
        strategyKey,
        probability: prob,
        aiThreshold: adaptiveThreshold,
        regime: regimeType,
      });
      return;
    }
    if (prob < adaptiveThreshold) {
      noteTradeBlock({
        reason: "ai_below_threshold",
        strategyKey,
        probability: prob,
        threshold: adaptiveThreshold,
        baseThreshold: state.aiThreshold,
        regime: regimeType,
        symbol: state.symbol,
      });
      wsHub?.broadcast("log", {
        level: "info",
        msg: "AI filter blocked trade",
        probability: prob,
        threshold: adaptiveThreshold,
        baseThreshold: state.aiThreshold,
        regime: regimeType,
        strategyKey,
      });
      log.info("ai_filter_blocked", { symbol: state.symbol, probability: prob, threshold: adaptiveThreshold, regime: regimeType, strategyKey });
      return;
    }

    const venueEx = pickVenueExchange({
      side: tradeAction,
      prob,
      regime: regime?.type,
      atrPct: regime?.atrPct,
    });
    if (!venueEx) {
      noteTradeBlock({ reason: "no_venue", symbol: state.symbol, strategyKey });
      wsHub?.broadcast("log", { level: "warn", msg: "Trade blocked: no venue available (spot/futures)" });
      return;
    }

    // Over-trading protection
    const now = Date.now();
    state.tradeOpenTimestamps = (state.tradeOpenTimestamps || []).filter((t) => now - Number(t) < 60 * 60_000);
    if (state.lastTradeOpenedAt && now - Number(state.lastTradeOpenedAt) < state.tradeCooldownMs) {
      noteTradeBlock({ reason: "cooldown", cooldownMs: state.tradeCooldownMs, symbol: state.symbol, strategyKey });
      wsHub?.broadcast("log", { level: "info", msg: "Trade blocked: cooldown", cooldownMs: state.tradeCooldownMs });
      return;
    }
    if (state.tradeOpenTimestamps.length >= state.maxTradesPerHour) {
      noteTradeBlock({ reason: "max_trades_per_hour", max: state.maxTradesPerHour, symbol: state.symbol, strategyKey });
      wsHub?.broadcast("log", { level: "warn", msg: "Trade blocked: max trades/hour", max: state.maxTradesPerHour });
      return;
    }
    if (Array.isArray(positions) && positions.length >= state.maxConcurrentPositions) {
      noteTradeBlock({ reason: "max_concurrent_positions", max: state.maxConcurrentPositions, symbol: state.symbol, strategyKey });
      wsHub?.broadcast("log", { level: "warn", msg: "Trade blocked: max concurrent positions", max: state.maxConcurrentPositions });
      return;
    }
    // Correlation-aware portfolio: skip if already holding the same or highly correlated symbol
    if (Array.isArray(positions) && positions.length > 0) {
      const sym = state.symbol.toUpperCase();
      const holdingSyms = positions.map((p) => String(p?.symbol || "").toUpperCase()).filter(Boolean);
      if (holdingSyms.includes(sym)) {
        noteTradeBlock({ reason: "already_in_position", symbol: sym, strategyKey });
        wsHub?.broadcast("log", { level: "info", msg: "Trade blocked: already holding same symbol", symbol: sym });
        return;
      }
      // BTC/ETH correlation guard
      const correlatedPairs = { BTCUSDT: ["ETHUSDT"], ETHUSDT: ["BTCUSDT"] };
      const correlated = correlatedPairs[sym] || [];
      const maxCorr = Number(process.env.PORTFOLIO_MAX_CORRELATION || 0);
      if (maxCorr > 0 && correlated.some((c) => holdingSyms.includes(c))) {
        noteTradeBlock({ reason: "correlated_position", symbol: sym, held: holdingSyms, strategyKey });
        wsHub?.broadcast("log", { level: "info", msg: "Trade blocked: correlated asset already held", symbol: sym, held: holdingSyms });
        return;
      }
    }
    if (venueEx?.name && venueEx.name !== "paper" && venueEx.supportsAutoTrading !== true) {
      noteTradeBlock({ reason: "auto_trading_disabled", exchange: venueEx.name });
      wsHub?.broadcast("log", { level: "warn", msg: "Auto-trading disabled for this exchange", exchange: venueEx.name });
      state.running = false;
      return;
    }

    const venueForGuards = pickVenueExchange({
      side: tradeAction,
      prob,
      regime: regime?.type,
      atrPct: regime?.atrPct,
    });
    const isFuturesRoute = String(venueForGuards?.name || "").toLowerCase().includes("futures");

    const maxSpread = Number(process.env.TRADE_MAX_SPREAD_BPS || 0);
    if (maxSpread > 0 && depth) {
      const book = depth.getBook();
      const sp = spreadBpsFromBook(book, last.close);
      state.metrics.lastSpreadBps = sp;
      if (sp != null && sp > maxSpread) {
        noteTradeBlock({
          reason: "spread_too_wide",
          spreadBps: sp,
          maxSpreadBps: maxSpread,
          symbol: state.symbol,
          strategyKey,
        });
        wsHub?.broadcast("log", {
          level: "info",
          msg: `Trade blocked: spread ${sp.toFixed(1)} bps > max ${maxSpread} bps`,
          symbol: state.symbol,
        });
        return;
      }
    }

    const minDepthUsd = Number(process.env.TRADE_MIN_DEPTH_NOTIONAL_USD || 0);
    if (minDepthUsd > 0 && depth) {
      const book = depth.getBook();
      const lv = Number(process.env.TRADE_DEPTH_LEVELS || 5);
      const notion = depthNotionalUsd(book, tradeAction, lv);
      state.metrics.lastDepthNotionalUsd = notion;
      if (notion != null && notion < minDepthUsd) {
        noteTradeBlock({
          reason: "depth_too_thin",
          depthNotionalUsd: notion,
          minDepthUsd: minDepthUsd,
          symbol: state.symbol,
          strategyKey,
        });
        wsHub?.broadcast("log", {
          level: "info",
          msg: `Trade blocked: top-of-book notional $${notion.toFixed(0)} < min $${minDepthUsd}`,
          symbol: state.symbol,
        });
        return;
      }
    }

    const fundCap = Number(process.env.FUNDING_BLOCK_ABS_RATE || 0);
    if (fundCap > 0 && isFuturesRoute) {
      const fr = await getCachedFunding(state.symbol);
      state.metrics.lastFundingRate = fr;
      const fg = fundingBlocksTrade(tradeAction, fr, fundCap);
      if (!fg.ok) {
        noteTradeBlock({
          reason: fg.reason,
          fundingRate: fr,
          cap: fundCap,
          symbol: state.symbol,
          strategyKey,
        });
        wsHub?.broadcast("log", {
          level: "info",
          msg: `Trade blocked: extreme funding (${fr}) vs cap ±${fundCap}`,
          symbol: state.symbol,
        });
        return;
      }
    }

    wsHub?.broadcast("log", {
      level: "info",
      msg: "AI approved trade",
      probability: prob,
      direction: tradeAction,
      reason: tradeReason,
      strategyKey,
    });

    const isFuturesVenue = String(venueEx?.name || "").toLowerCase().includes("futures");
    const futuresLeverage = !isFuturesVenue
      ? null
      : String(state.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
        ? clamp(Number(state.futuresLeverage), 1, 50)
        : decideFuturesLeverage({ prob, atrPct: regime?.atrPct, regime: regime?.type });

    // Risk plan (1-2% capital per trade) + SL/TP required.
    // Pass futuresLeverage so max-notional cap matches the leverage we will set on the order.
    const plan = await riskPlan({
      exchange: venueEx,
      side: tradeAction,
      entryPrice: last.close,
      confidence: prob,
      riskPerTrade: state.riskPerTrade,
      atr: indicators.latest.atr_14,
      futuresLeverage: futuresLeverage ?? undefined,
      stats: state.stats[strategyKey],
      regime: regime?.type,
    });
    if (!plan.ok) {
      noteTradeBlock({ reason: "risk_plan_rejected", detail: plan.reason, symbol: state.symbol, strategyKey });
      wsHub?.broadcast("log", { level: "warn", msg: "Risk plan rejected", reason: plan.reason });
      return;
    }
    wsHub?.broadcast("log", { level: "info", msg: "Risk tier selected", tierMult: plan.tierMult, riskUsd: plan.riskUsd });

    let order;
    const orderStartMs = Date.now();
    try {
      order = await venueEx.placeOrder({
        symbol: state.symbol,
        side: tradeAction,
        qty: plan.qty,
        price: last.close,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
        strategy: strategyKey,
        meta: {
          aiProbability: prob,
          aiFeatures: aiResp?.features || {},
          modelKind: aiResp?.model_kind || aiResp?.modelKind || null,
          tierMult: plan.tierMult,
          riskUsd: plan.riskUsd,
          aiThreshold: state.aiThreshold,
          strategyKey,
          tradeReason,
          marketMode: state.marketMode,
          futuresLeverage,
          futuresLeverageMode: state.futuresLeverageMode,
        },
      });
    } catch (e) {
      const err = String(e?.message || e);
      wsHub?.broadcast("log", {
        level: "error",
        msg: `Order failed: ${err}`,
        exchange: venueEx?.name,
        symbol: state.symbol,
        side: tradeAction,
        qty: plan.qty,
      });
      log.warn("place_order_failed", { error: err, symbol: state.symbol, side: tradeAction });
      noteTradeBlock({ reason: "order_failed", detail: err, symbol: state.symbol, side: tradeAction, strategyKey });
      return;
    }
    noteTradeBlock({
      reason: "order_placed",
      symbol: state.symbol,
      side: tradeAction,
      strategyKey,
      probability: prob,
    });
    log.info("trade_placed", {
      symbol: state.symbol,
      side: tradeAction,
      qty: plan.qty,
      entryMark: Number(last.close),
      filledPrice: Number(order?.filledPrice ?? null),
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      probability: prob,
      threshold: state.aiThreshold,
      tierMult: plan.tierMult,
      exchange: exch?.name,
      mode: process.env.TRADING_MODE,
      strategyKey,
    });

    wsHub?.broadcast("trade", {
      type: "OPEN",
      id: order.id,
      symbol: state.symbol,
      side: tradeAction,
      qty: plan.qty,
      price: order.filledPrice,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      strategyKey,
      aiProbability: prob,
    });

    // Execution quality tracking
    const orderLatencyMs = Date.now() - orderStartMs;
    const intendedPx = Number(last.close);
    const filledPx = Number(order?.filledPrice ?? intendedPx);
    const slippage = intendedPx > 0 ? (filledPx - intendedPx) / intendedPx : 0;
    state.execLog = (state.execLog || []).concat({
      ts: new Date().toISOString(),
      symbol: state.symbol,
      intendedPx,
      filledPx,
      slippage: roundTo(slippage, 6),
      latencyMs: orderLatencyMs,
    }).slice(-200);
    log.info("exec_quality", { symbol: state.symbol, intendedPx, filledPx, slippage, latencyMs: orderLatencyMs });

    state.stats[strategyKey].trades += 1;
    state.lastTradeOpenedAt = Date.now();
    state.tradeOpenTimestamps.push(Date.now());
  }

  let interval = null;
  function start({ wsHub }) {
    if (state.running) return;
    wsHubRef = wsHub;
    state.running = true;
    wsHub?.broadcast("log", { level: "info", msg: "Bot started" });
  }

  function stop({ wsHub }) {
    if (!state.running) return;
    state.running = false;
    wsHub?.broadcast("log", { level: "info", msg: "Bot stopped" });
  }

  function updateConfig(patch) {
    if (patch.symbol) {
      state.symbol = patch.symbol;
      feed.setSymbol(patch.symbol);
      try {
        depth?.setSymbol?.(patch.symbol);
      } catch {
        // ignore
      }
    }
    if (patch.symbolMode) {
      const v = String(patch.symbolMode).toUpperCase();
      if (v === "SINGLE" || v === "AUTO") state.symbolMode = v;
    }
    if (patch.timeframe) {
      state.timeframe = patch.timeframe;
      feed.setTimeframe(patch.timeframe);
    }
    if (patch.aiThreshold != null) state.aiThreshold = clamp(Number(patch.aiThreshold), 0, 1);
    if (patch.riskPerTrade != null) state.riskPerTrade = clamp(Number(patch.riskPerTrade), 0.001, 0.05);
    if (patch.maxDailyLoss != null) state.maxDailyLoss = clamp(Number(patch.maxDailyLoss), 0.01, 0.2);
    if (patch.strategyMode) state.strategyMode = patch.strategyMode;
    if (patch.manualStrategy) state.manualStrategy = patch.manualStrategy;
    if (patch.marketMode) {
      const v = String(patch.marketMode).toUpperCase();
      if (v === "SPOT" || v === "FUTURES" || v === "AUTO") state.marketMode = v;
    }
    if (patch.futuresLeverageMode != null) {
      const v = String(patch.futuresLeverageMode).toUpperCase();
      if (v === "AUTO" || v === "MANUAL") state.futuresLeverageMode = v;
    }
    if (patch.futuresLeverage != null) state.futuresLeverage = clamp(Number(patch.futuresLeverage), 1, 50);

    return getPublicState();
  }

  async function manualTrade({ wsHub, side, amountUsd, stopLossPct, takeProfitPct, strategyKey = "MANUAL" }) {
    const candles = feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) return { ok: false, reason: "no_market_data" };

    const px = last.close;
    const qty = roundTo(Number(amountUsd) / px, 6);
    const isLong = side === "BUY";
    const stopLoss = isLong ? px * (1 - Math.abs(stopLossPct)) : px * (1 + Math.abs(stopLossPct));
    const takeProfit = isLong ? px * (1 + Math.abs(takeProfitPct)) : px * (1 - Math.abs(takeProfitPct));

    const venueEx =
      pickVenueExchange({
        side,
        prob: Number(state.lastAi?.probability ?? 0),
        regime: state.lastRegime?.type,
        atrPct: state.lastRegime?.atrPct,
      }) ||
      exch?.spot ||
      exch?.futures ||
      exch;

    const isFutManual = String(venueEx?.name || "").toLowerCase().includes("futures");
    const manualLev =
      isFutManual && String(state.futuresLeverageMode || "AUTO").toUpperCase() === "AUTO"
        ? decideFuturesLeverage({
            prob: Number(state.lastAi?.probability ?? 0.55),
            atrPct: state.lastRegime?.atrPct,
            regime: state.lastRegime?.type,
          })
        : isFutManual
          ? clamp(Number(state.futuresLeverage), 1, 50)
          : null;

    const order = await venueEx.placeOrder({
      symbol: state.symbol,
      side,
      qty,
      price: px,
      stopLoss,
      takeProfit,
      strategy: strategyKey,
      meta: {
        manual: true,
        marketMode: state.marketMode,
        futuresLeverage: manualLev ?? state.futuresLeverage,
        futuresLeverageMode: state.futuresLeverageMode,
      },
    });

    wsHub?.broadcast("trade", {
      type: "OPEN",
      id: order.id,
      symbol: state.symbol,
      side,
      qty,
      price: order.filledPrice,
      stopLoss,
      takeProfit,
      strategyKey,
      manual: true,
    });
    return { ok: true, id: order.id };
  }

  return {
    feed,
    getPublicState,
    getMetrics() {
      return {
        ...state.metrics,
        uptimeSec: Math.round((Date.now() - state.metrics.startedAt) / 1000),
        symbol: state.symbol,
        running: state.running,
      };
    },
    async getUniverseScan() {
      if (state.universe) return state.universe;
      // best-effort one-shot scan
      if (String(process.env.MARKET_FEED || "SYNTH").toUpperCase() !== "BINANCE") return null;
      const snap = await universe.scanAndRank({
        timeframe: state.timeframe,
        universeSize: Number(process.env.UNIVERSE_SIZE || 30),
        topKlines: Number(process.env.UNIVERSE_TOP_KLINES || 12),
        minQuoteVolumeUSDT: Number(process.env.UNIVERSE_MIN_QUOTE_VOL || 5_000_000),
        maxSpreadPct: Number(process.env.UNIVERSE_MAX_SPREAD_PCT || 0.0015),
        excludeStablePairs: String(process.env.UNIVERSE_EXCLUDE_STABLES || "1") !== "0",
        aiClient: ai,
      });
      state.universe = snap;
      return snap;
    },
    start,
    stop,
    updateConfig,
    manualTrade,
    setExchange(next) {
      exch = next;
      lastSeenTradeId = null;
      closedSinceRetrain = 0;
    },
  };
}

