import { clamp, roundTo } from "../lib/math.js";
import { tradeCloseFeeUsdtFromNotional } from "../lib/tradeCloseFee.js";
import { maxBarsForHistory } from "../lib/chartWindow.js";
import { computeIndicators } from "../strategy/indicators.js";
import { computeDecisionSnapshot } from "../strategy/decisionEngine.js";
import { detectRegime } from "../strategy/regime.js";
import { strategies } from "../strategy/strategies.js";
import { pickStrategyAuto, topStrategies } from "../strategy/selector.js";
import { riskPlan, spotBracketFromAtr } from "../strategy/risk.js";
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
import { formatAiServiceError } from "../svc/aiHttpError.js";
import { isPlausibleCandleClose } from "../lib/symbolPriceSanity.js";
import { computeSupertrendSeries } from "../strategy/supertrend.js";
import {
  sanitizeCandlesForSt,
  chartMarkerVisibleForBar,
  computeSupertrendSignalStrength01,
} from "../lib/supertrendChartAlign.js";
import { broadcastActivity } from "../lib/activityLog.js";
import { mergeTradesById, readTradeWsEvents } from "../lib/activityPersistence.js";
import { filterStrictPortfolioTradesAfterMerge } from "../lib/tradeLedgerClassification.js";
import { readBotTradingConfig, writeBotTradingConfig } from "../lib/botTradingConfigStore.js";
import {
  appendSupertrendSignalHistoryEntry,
  maybeMigrateLegacySupertrendSignalHistory,
  readSupertrendSignalHistory,
} from "../lib/supertrendSignalHistoryPersistence.js";
import { isStrictBinanceAccountMode } from "../lib/tradingModePersistence.js";
import { fetchBinanceKlinesRows } from "../lib/binanceKlinesRest.js";

/** Must match /api/bot/config timeframe allowlist. */
const PERSISTED_TF = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

const SUPERTREND_SIGNAL_STATE_MAX = Math.max(
  50,
  Math.min(50_000, Number(process.env.SUPERTREND_SIGNAL_HISTORY_STATE_MAX || 2000)),
);
const SYM_RE = /^[A-Z0-9]{5,20}$/i;

function activityStopMsg(reason) {
  const r = String(reason || "user_request");
  const labels = {
    user_request: "Bot stopped · user request",
    ui_header_bar: "Bot stopped · header bar",
    feed_stale_60s: "Bot stopped · no market data for >60s (safety)",
    max_daily_loss: "Bot stopped · max daily loss exceeded",
    max_drawdown: "Bot stopped · max drawdown exceeded",
    trading_mode_switch: "Bot stopped · switching trading mode",
  };
  return labels[r] || `Bot stopped · ${r}`;
}

function activityStartMsg(reason) {
  const r = String(reason || "user_request");
  const labels = {
    user_request: "Bot started · user request",
    ui_header_bar: "Bot started · header bar",
    ui: "Bot started · UI",
    api: "Bot started · API",
    feed_recovery: "Bot started · feed recovered (auto-restart)",
    daily_loss_reset_resume: "Bot started · daily loss baseline reset (user)",
  };
  return labels[r] || `Bot started · ${r}`;
}

/** Latest activity from Binance feed: max(kline lastMsgAt, aggTrade delta lastMsgAt) — avoids false stops when only one stream stalls. */
function freshestBinanceFeedMsgAt(feedStatus) {
  if (!feedStatus) return null;
  const k = Number(feedStatus.lastMsgAt);
  const d = feedStatus.delta?.lastMsgAt != null ? Number(feedStatus.delta.lastMsgAt) : NaN;
  const vals = [];
  if (Number.isFinite(k)) vals.push(k);
  if (Number.isFinite(d)) vals.push(d);
  if (!vals.length) return null;
  return Math.max(...vals);
}

function marketFeedKind() {
  return String(process.env.MARKET_FEED || "SYNTH").toUpperCase();
}

/** Spot or USDT-M public feed: enables depth WS + universe scan (AUTO symbol). */
function marketFeedUsesLiveBinance() {
  const k = marketFeedKind();
  return k === "BINANCE" || k === "BINANCE_FUTURES";
}

function binanceDepthWsBase() {
  return marketFeedKind() === "BINANCE_FUTURES"
    ? process.env.BINANCE_FUTURES_WS_BASE || "wss://fstream.binance.com/ws"
    : process.env.BINANCE_WS_BASE;
}

/** Blend calibrated vs raw AI probability (reduces isotonic collapse). */
function aiGateProbability(calProb, rawProb) {
  const useRaw =
    String(process.env.AI_GATE_USE_RAW || "").toLowerCase() === "1" ||
    String(process.env.AI_GATE_USE_RAW || "").toLowerCase() === "true";
  const calOnly =
    String(process.env.AI_GATE_CALIBRATED_ONLY || "").toLowerCase() === "1" ||
    String(process.env.AI_GATE_CALIBRATED_ONLY || "").toLowerCase() === "true";
  const cal = Number(calProb);
  const raw = Number(rawProb);
  if (useRaw && Number.isFinite(raw)) return clamp(raw, 0, 1);
  if (calOnly && Number.isFinite(cal)) return clamp(cal, 0, 1);
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

/** Backfill fee (qty×price×rate) and top-level price / SL / TP for WS trade history when exchange rows omit them. */
function enrichCloseTradeForHistory(t) {
  if (!t || t.type !== "CLOSE" || isIncomeLedgerClose(t)) return t;
  const m = { ...(t.meta || {}) };
  const px = Number(t.price ?? t.exitPrice ?? m.exitPrice ?? m.closePrice ?? m.markPx);
  const q = Number(t.qty);
  const next = { ...t, meta: m };
  if (Number.isFinite(px) && px > 0 && (!Number.isFinite(Number(next.price)) || Number(next.price) <= 0)) {
    next.price = px;
  }
  if (Number.isFinite(Number(m.stopLoss)) && (next.stopLoss == null || !Number.isFinite(Number(next.stopLoss)))) {
    next.stopLoss = Number(m.stopLoss);
  }
  if (Number.isFinite(Number(m.takeProfit)) && (next.takeProfit == null || !Number.isFinite(Number(next.takeProfit)))) {
    next.takeProfit = Number(m.takeProfit);
  }
  const fExisting = Number(next.fee);
  if (!Number.isFinite(fExisting) || fExisting <= 0) {
    const modeled = tradeCloseFeeUsdtFromNotional(q, px);
    if (modeled != null) next.fee = modeled;
  }
  return next;
}

/** Clamp `riskPerTrade` / `maxDailyLoss` to valid ranges for their unit modes. */
function normalizeRiskLimits(s) {
  const ru = String(s.riskPerTradeUnit || "PCT").toUpperCase() === "USDT" ? "USDT" : "PCT";
  s.riskPerTradeUnit = ru;
  if (ru === "USDT") {
    s.riskPerTrade = clamp(Number(s.riskPerTrade), 1, 10_000_000);
  } else {
    s.riskPerTrade = clamp(Number(s.riskPerTrade), 0.001, 0.05);
  }
  const lu = String(s.maxDailyLossUnit || "PCT").toUpperCase() === "USDT" ? "USDT" : "PCT";
  s.maxDailyLossUnit = lu;
  if (lu === "USDT") {
    s.maxDailyLoss = clamp(Number(s.maxDailyLoss), 1, 10_000_000);
  } else {
    s.maxDailyLoss = clamp(Number(s.maxDailyLoss), 0.01, 0.2);
  }
}

export function createBot({ log, ai, exchange, defaults, getTradingMode }) {
  let exch = exchange;
  function runtimeTradingMode() {
    if (typeof getTradingMode === "function") {
      try {
        return String(getTradingMode() || "PAPER").toUpperCase();
      } catch {
        /* ignore */
      }
    }
    return String(process.env.TRADING_MODE || "PAPER").toUpperCase();
  }
  function requiresStrictBinanceAccount() {
    return isStrictBinanceAccountMode(runtimeTradingMode());
  }
  function walletBaseFromAccount(account) {
    if (account == null) return null;
    if (account.equity == null || !Number.isFinite(Number(account.equity))) return null;
    return Number(account.equity);
  }
  const state = {
    running: false,
    symbol: defaults.symbol,
    timeframe: defaults.timeframe,
    symbolMode: "AUTO", // SINGLE | AUTO (coin selection)
    aiThreshold: defaults.aiThreshold,
    riskPerTrade: defaults.riskPerTrade,
    maxDailyLoss: defaults.maxDailyLoss,
    /** `"PCT"` = fraction of balance; `"USDT"` = fixed USD at stop (before confidence tiers). */
    riskPerTradeUnit: "PCT",
    /** `"PCT"` = max daily drawdown as fraction of day's start equity; `"USDT"` = max loss in USD from day baseline per venue. */
    maxDailyLossUnit: "PCT",
    strategyMode: "AUTO", // AUTO | MANUAL
    manualStrategy: "EMA_CROSS",
    marketMode: "AUTO", // SPOT | FUTURES | AUTO
    /** AUTO: per trade via decideFuturesLeverage (AI + volatility). MANUAL: use futuresLeverage for every futures order. */
    futuresLeverageMode: "AUTO",
    futuresLeverage: Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5))),
    lastDecision: null,
    lastAi: null,
    lastRegime: null,
    regimeConfirmCandles: Number(process.env.REGIME_CONFIRM_CANDLES || 4),
    regimeCandidate: null, // { type, firstSeenAt }
    universe: null, // last scan snapshot
    universeLastPick: null,
    /** When set, keep trading this symbol and skip auto rotation (AUTO mode); cleared on bot start or explicit unpin. */
    universePinnedSymbol: null,
    /** AUTO + unpinned + AUTO_MULTI_UNPINNED_SUPERTREND: last fully-closed bar `ts` seen per symbol (REST sweep). */
    autoMultiLastSeenBarTs: Object.create(null),
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
      feedRecoveryRestarts: 0,
      startedAt: Date.now(),
    },
    /** Set when stopped by feed staleness; cleared on start or any other stop reason. Auto-restart when feed is healthy again (see FEED_AUTO_RESTART). */
    pendingAutoRestartAfterFeedStale: false,
    /**
     * Live Binance feed unhealthy or stale: keep broadcasting chart/regime/signals but block autotrade
     * (and risky exits) until the feed recovers. Does not flip `running`.
     */
    feedExecutionPause: null,
    /** Last `stop()` reason while bot was running (e.g. max_daily_loss); cleared on `start()`. For UI reset affordances. */
    lastStopReason: null,
    _fundingCache: { symbol: null, rate: null, at: 0 },
    /** Spot-only: trade on Supertrend flips when a Binance kline closes (k.x). */
    supertrendSpotAuto: false,
    /** Futures-only (Market = FUTURES): same bar-close Supertrend logic; BUY ≈ max margin×leverage; SELL closes long. */
    supertrendFuturesAuto: false,
    /** When true (default), Supertrend futures opens apply `supertrendFuturesMinAiProb` and AI-based risk tiers. When false, that gate is skipped; sizing uses chart signal strength (blend). */
    supertrendFuturesAiConfidenceFilter: true,
    /**
     * When true, Supertrend spot/futures **opening** legs require composite signal strength ≥ `signalStrengthOpenMin` and matching BUY/SELL from signal_strength engine.
     * When false (default), strength is computed for UI/logs only and does not block trades.
     */
    signalStrengthGatesTrades: false,
    /** When `signalStrengthGatesTrades` is on, min composite strength (0–100) to allow an open; direction must still match. Default 65 (old TRADE cut). */
    signalStrengthOpenMin: clamp(
      Math.round(Number(process.env.SIGNAL_STRENGTH_OPEN_MIN ?? 65)),
      0,
      100,
    ),
    /** Min AI probability (0–1) for Supertrend futures opens when `supertrendFuturesAiConfidenceFilter` is on. */
    supertrendFuturesMinAiProb: clamp(
      Number(process.env.SUPERTREND_FUTURES_MIN_AI_PROB ?? 0.55),
      0,
      1,
    ),
    /** Fixed stop distance (fraction of price) for Supertrend futures when AI confidence filter is off. */
    supertrendFuturesFixedSlPct: clamp(
      Number(process.env.SUPERTREND_FUTURES_FIXED_SL_PCT ?? 0.002),
      0.00005,
      0.2,
    ),
    /** Fixed take-profit distance (fraction of price) for Supertrend futures when AI confidence filter is off. */
    supertrendFuturesFixedTpPct: clamp(
      Number(process.env.SUPERTREND_FUTURES_FIXED_TP_PCT ?? 0.015),
      0.00005,
      0.5,
    ),
    /**
     * Futures Supertrend: false = 1-way (BUY opens long; SELL closes long only).
     * true = 2-way (BUY closes short then opens long; SELL closes long then opens short).
     */
    supertrendFuturesTwoWay: false,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendWilderAtr: true,
    supertrendLast: null,
    supertrendLastClosedTs: null,
    /** Last kline-close row signals (same math as autotrade). Exposed so UI matches Activity when chart buffer lags. */
    supertrendLastBarClose: null,
    /**
     * Last bar where a chart-aligned Supertrend flip could fire autotrade (`allowBuy || allowSell`).
     * Persists across later no-flip closes so Insights / HUD still match Activity.
     */
    supertrendLastFlipBarClose: null,
    /**
     * Last 10 chart-aligned Supertrend flips (chronological, most recent kept) with AI + composite strength.
     * @type {Array<{ ts: number, side: 'BUY'|'SELL', aiGate: number|null, strength: number|null, stAction: string|null }>}
     */
    supertrendSignalHistory: [],
    /** `${SYMBOL}:${candleOpenTs}` — ignore duplicate kline `x` deliveries for the same bar. */
    supertrendStHandledCloseKey: null,
    /**
     * Bar-close Supertrend signal captured while `running` was false — flush once after bot starts
     * (first tick with candles) so e.g. SELL can close an open leg; skipped if position already flat.
     */
    pendingSupertrendAction: null,
    /** Set in `start()` when `pendingSupertrendAction` exists; cleared after first successful flush attempt. */
    _pendingSupertrendFlushOnNextTick: false,
    /** Throttle repeated “free USDT below min order” warns (ms timestamp). */
    supertrendLowUsdtLastWarnAt: 0,
    /** Throttle Supertrend futures min-notional warns (ms). */
    supertrendLowFutNotionalLastWarnAt: 0,
    /** Rule-based score (0–100) + expected move; complements ML `lastAi`. */
    decisionEngine: null,
    /** Manual order form strings; persisted across backend restarts. */
    tradingFormDefaults: {
      amountUsdStr: "200",
      slPctStr: "0.002",
      tpPctStr: "0.015",
    },
  };

  /** Risk/trade + max daily loss both USDT: fixed notional per trade (no AI tiers/gates on size). */
  function isFixedUsdtCapitalMode() {
    return (
      String(state.riskPerTradeUnit || "PCT").toUpperCase() === "USDT" &&
      String(state.maxDailyLossUnit || "PCT").toUpperCase() === "USDT"
    );
  }

  function persistTradingConfigToDisk() {
    try {
      writeBotTradingConfig({
        v: 1,
        bot: {
          symbol: state.symbol,
          timeframe: state.timeframe,
          symbolMode: state.symbolMode,
          universePinnedSymbol: state.universePinnedSymbol,
          aiThreshold: state.aiThreshold,
          riskPerTrade: state.riskPerTrade,
          maxDailyLoss: state.maxDailyLoss,
          riskPerTradeUnit: state.riskPerTradeUnit,
          maxDailyLossUnit: state.maxDailyLossUnit,
          strategyMode: state.strategyMode,
          manualStrategy: state.manualStrategy,
          marketMode: state.marketMode,
          futuresLeverageMode: state.futuresLeverageMode,
          futuresLeverage: state.futuresLeverage,
          supertrendSpotAuto: state.supertrendSpotAuto,
          supertrendFuturesAuto: state.supertrendFuturesAuto,
          supertrendFuturesAiConfidenceFilter: state.supertrendFuturesAiConfidenceFilter,
          signalStrengthGatesTrades: state.signalStrengthGatesTrades,
          signalStrengthOpenMin: state.signalStrengthOpenMin,
          supertrendFuturesMinAiProb: state.supertrendFuturesMinAiProb,
          supertrendFuturesFixedSlPct: state.supertrendFuturesFixedSlPct,
          supertrendFuturesFixedTpPct: state.supertrendFuturesFixedTpPct,
          supertrendFuturesTwoWay: state.supertrendFuturesTwoWay,
          supertrendPeriod: state.supertrendPeriod,
          supertrendMultiplier: state.supertrendMultiplier,
          supertrendWilderAtr: state.supertrendWilderAtr,
        },
        tradingFormDefaults: { ...state.tradingFormDefaults },
      });
    } catch (e) {
      log?.warn?.("bot_trading_config_persist_failed", { error: String(e?.message || e) });
    }
  }

  function hydrateTradingConfigFromDisk() {
    const raw = readBotTradingConfig();
    if (!raw || typeof raw !== "object") return;
    const b = raw.bot;
    if (b && typeof b === "object") {
      if (typeof b.symbol === "string" && SYM_RE.test(b.symbol.trim())) {
        state.symbol = b.symbol.trim().toUpperCase();
      }
      if (typeof b.timeframe === "string" && PERSISTED_TF.has(b.timeframe)) {
        state.timeframe = b.timeframe;
      }
      if (b.symbolMode === "SINGLE" || b.symbolMode === "AUTO") {
        state.symbolMode = b.symbolMode;
      }
      if (b.universePinnedSymbol === null || b.universePinnedSymbol === "") {
        state.universePinnedSymbol = null;
      } else if (typeof b.universePinnedSymbol === "string" && SYM_RE.test(b.universePinnedSymbol.trim())) {
        const up = b.universePinnedSymbol.trim().toUpperCase();
        state.universePinnedSymbol = up;
        state.symbolMode = "AUTO";
        state.symbol = up;
      }
      if (b.aiThreshold != null && Number.isFinite(Number(b.aiThreshold))) {
        state.aiThreshold = clamp(Number(b.aiThreshold), 0, 1);
      }
      if (b.riskPerTradeUnit === "USDT" || b.riskPerTradeUnit === "PCT") {
        state.riskPerTradeUnit = b.riskPerTradeUnit;
      }
      if (b.maxDailyLossUnit === "USDT" || b.maxDailyLossUnit === "PCT") {
        state.maxDailyLossUnit = b.maxDailyLossUnit;
      }
      if (b.riskPerTrade != null && Number.isFinite(Number(b.riskPerTrade))) {
        state.riskPerTrade = Number(b.riskPerTrade);
      }
      if (b.maxDailyLoss != null && Number.isFinite(Number(b.maxDailyLoss))) {
        state.maxDailyLoss = Number(b.maxDailyLoss);
      }
      normalizeRiskLimits(state);
      if (b.strategyMode === "AUTO" || b.strategyMode === "MANUAL") state.strategyMode = b.strategyMode;
      if (typeof b.manualStrategy === "string" && b.manualStrategy.length <= 80) {
        state.manualStrategy = b.manualStrategy;
      }
      if (b.marketMode === "SPOT" || b.marketMode === "FUTURES" || b.marketMode === "AUTO") {
        state.marketMode = b.marketMode;
      }
      if (b.futuresLeverageMode === "AUTO" || b.futuresLeverageMode === "MANUAL") {
        state.futuresLeverageMode = b.futuresLeverageMode;
      }
      if (b.futuresLeverage != null && Number.isFinite(Number(b.futuresLeverage))) {
        state.futuresLeverage = clamp(Math.floor(Number(b.futuresLeverage)), 1, 100);
      }
      if (typeof b.supertrendSpotAuto === "boolean") state.supertrendSpotAuto = b.supertrendSpotAuto;
      if (typeof b.supertrendFuturesAuto === "boolean") state.supertrendFuturesAuto = b.supertrendFuturesAuto;
      if (typeof b.supertrendFuturesAiConfidenceFilter === "boolean") {
        state.supertrendFuturesAiConfidenceFilter = b.supertrendFuturesAiConfidenceFilter;
      }
      if (typeof b.signalStrengthGatesTrades === "boolean") {
        state.signalStrengthGatesTrades = b.signalStrengthGatesTrades;
      }
      if (b.signalStrengthOpenMin != null && Number.isFinite(Number(b.signalStrengthOpenMin))) {
        state.signalStrengthOpenMin = clamp(Math.round(Number(b.signalStrengthOpenMin)), 0, 100);
      }
      if (b.supertrendFuturesMinAiProb != null && Number.isFinite(Number(b.supertrendFuturesMinAiProb))) {
        state.supertrendFuturesMinAiProb = clamp(Number(b.supertrendFuturesMinAiProb), 0, 1);
      }
      if (typeof b.supertrendFuturesTwoWay === "boolean") state.supertrendFuturesTwoWay = b.supertrendFuturesTwoWay;
      if (b.supertrendFuturesFixedSlPct != null && Number.isFinite(Number(b.supertrendFuturesFixedSlPct))) {
        state.supertrendFuturesFixedSlPct = clamp(Number(b.supertrendFuturesFixedSlPct), 0.00005, 0.2);
      }
      if (b.supertrendFuturesFixedTpPct != null && Number.isFinite(Number(b.supertrendFuturesFixedTpPct))) {
        state.supertrendFuturesFixedTpPct = clamp(Number(b.supertrendFuturesFixedTpPct), 0.00005, 0.5);
      }
      if (b.supertrendPeriod != null && Number.isFinite(Number(b.supertrendPeriod))) {
        state.supertrendPeriod = clamp(Math.floor(Number(b.supertrendPeriod)), 2, 100);
      }
      if (b.supertrendMultiplier != null && Number.isFinite(Number(b.supertrendMultiplier))) {
        state.supertrendMultiplier = clamp(Number(b.supertrendMultiplier), 0.5, 20);
      }
      if (typeof b.supertrendWilderAtr === "boolean") state.supertrendWilderAtr = b.supertrendWilderAtr;
    }
    const tf = raw.tradingFormDefaults;
    if (tf && typeof tf === "object") {
      if (typeof tf.amountUsdStr === "string" && tf.amountUsdStr.length <= 32) {
        state.tradingFormDefaults.amountUsdStr = tf.amountUsdStr;
      }
      if (typeof tf.slPctStr === "string" && tf.slPctStr.length <= 32) {
        state.tradingFormDefaults.slPctStr = tf.slPctStr;
      }
      if (typeof tf.tpPctStr === "string" && tf.tpPctStr.length <= 32) {
        state.tradingFormDefaults.tpPctStr = tf.tpPctStr;
      }
    }
    if (!state.supertrendFuturesAuto || state.marketMode === "SPOT") {
      state.supertrendFuturesAiConfidenceFilter = true;
    }
  }

  function loadSupertrendSignalHistoryFromDisk() {
    try {
      maybeMigrateLegacySupertrendSignalHistory();
      state.supertrendSignalHistory = readSupertrendSignalHistory({
        symbol: state.symbol,
        timeframe: state.timeframe,
        limit: SUPERTREND_SIGNAL_STATE_MAX,
      });
    } catch (e) {
      log?.warn?.("supertrend_signal_history_load_failed", { error: String(e?.message || e) });
    }
  }

  function noteTradeBlock(payload) {
    state.lastTradeBlock = { ts: new Date().toISOString(), ...payload };
  }

  /** When `signalStrengthGatesTrades` is on, direction must match and composite strength ≥ `signalStrengthOpenMin`. */
  function signalStrengthBlocksOpen({ openingSide, decisionSnapshot }) {
    if (!state.signalStrengthGatesTrades) return null;
    const snap = decisionSnapshot ?? resolveSupertrendDecisionSnapshot(null);
    const ss = snap?.signalStrength;
    const needSig = openingSide === "BUY" ? "BUY" : "SELL";
    const minSt = clamp(Math.round(Number(state.signalStrengthOpenMin ?? 65)), 0, 100);
    if (!ss) {
      return { reason: "signal_strength_unavailable", detail: { openingSide } };
    }
    if (ss.signal !== needSig) {
      return {
        reason: "signal_strength_gate",
        detail: {
          openingSide,
          needSignal: needSig,
          have: ss.signal,
          strength: ss.strength,
          needMinStrength: minSt,
        },
      };
    }
    const st = Number(ss.strength);
    if (!Number.isFinite(st) || st < minSt) {
      return {
        reason: "signal_strength_gate",
        detail: {
          openingSide,
          needSignal: needSig,
          strength: ss.strength,
          needMinStrength: minSt,
          action: ss.action,
        },
      };
    }
    return null;
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

  let feed;

  function resolveSupertrendDecisionSnapshot(precomputed) {
    if (precomputed) return precomputed;
    try {
      const c = feed?.getCandles?.();
      if (!c?.length) return null;
      const ind = computeIndicators(c);
      const st = state.supertrendLast;
      const supertrendLastRow =
        st && typeof st === "object"
          ? { trend: st.trend, buySignal: false, sellSignal: false }
          : null;
      return computeDecisionSnapshot({
        candles: c,
        indicatorsLatest: ind.latest,
        supertrendLastRow,
        symbol: state.symbol,
        supertrendOpts: {
          period: state.supertrendPeriod,
          multiplier: state.supertrendMultiplier,
          wilderAtr: state.supertrendWilderAtr,
        },
      });
    } catch {
      return null;
    }
  }

  /** `${klineOpenTs}:BUY|SELL` — suppress duplicate fills for the same signal (tick + candle close). */
  const supertrendOrderDedupe = new Map();
  function pruneSupertrendDedupe(max = 400) {
    while (supertrendOrderDedupe.size > max) {
      const k = supertrendOrderDedupe.keys().next().value;
      supertrendOrderDedupe.delete(k);
    }
  }

  /**
   * Activity panel: one structured line per signal outcome (Supertrend bar-close or AI/strategy path).
   * @param {{ kind: "supertrend"|"strategy", strategyKey?: string, venue?: string, side: string, action: string, reason?: string, orderId?: string|number, qty?: number, leverage?: number, probability?: number, threshold?: number }} p
   */
  function emitSignalActionActivity(hub, p) {
    if (!hub?.broadcast || !p?.action) return;
    const kind = p.kind === "strategy" ? "strategy" : "supertrend";
    const label = kind === "supertrend" ? "Supertrend signal" : "Strategy signal";
    const sk = p.strategyKey != null ? String(p.strategyKey) : kind === "supertrend" ? "SUPERTREND" : "—";
    const ven = p.venue != null && String(p.venue) !== "—" && String(p.venue).trim() !== "" ? String(p.venue).toUpperCase() : "";
    const sd = p.side != null && String(p.side).trim() !== "" ? String(p.side).toUpperCase() : "—";
    const ac = String(p.action).toUpperCase();
    const parts = [label, sk];
    if (ven) parts.push(ven);
    parts.push(sd, ac);
    let msg = parts.join(" · ");
    if (p.reason) msg += ` · ${p.reason}`;
    if (p.orderId != null) msg += ` · order=${p.orderId}`;
    if (p.qty != null && Number.isFinite(Number(p.qty))) msg += ` · qty=${p.qty}`;
    if (p.leverage != null && Number.isFinite(Number(p.leverage))) msg += ` · lev=${p.leverage}x`;
    if (p.probability != null && Number.isFinite(Number(p.probability))) msg += ` · p=${Number(p.probability).toFixed(3)}`;
    if (p.threshold != null && Number.isFinite(Number(p.threshold))) msg += ` · thr=${Number(p.threshold).toFixed(3)}`;
    if (p.signalStrength != null && Number.isFinite(Number(p.signalStrength))) {
      msg += ` · str=${Number(p.signalStrength).toFixed(2)}`;
    }
    if (p.decisionScore != null && Number.isFinite(Number(p.decisionScore))) {
      msg += ` · dec=${Number(p.decisionScore)}`;
      if (p.decisionMin != null && Number.isFinite(Number(p.decisionMin))) msg += ` (min ${p.decisionMin})`;
    }
    if (p.decisionBias && (p.expectedMoveLong != null || p.expectedMoveShort != null)) {
      const em =
        String(p.decisionBias).toLowerCase() === "short"
          ? p.expectedMoveShort
          : p.expectedMoveLong;
      if (em != null && Number.isFinite(Number(em))) msg += ` · expMv≈${Number(em).toFixed(4)}`;
    }
    const level =
      ac === "ERROR" ? "error" : ac === "SKIPPED" ? "warn" : ac === "PENDING" ? "info" : "info";
    broadcastActivity(hub, {
      level,
      msg,
      category: "signal",
      reason: p.reason ? String(p.reason) : undefined,
      symbol: state.symbol,
      detail: { kind, strategyKey: sk, venue: ven || undefined, side: sd, action: ac, ...p },
    });
  }

  function emitSupertrendSignalFeedback(hub, result) {
    if (!hub?.broadcast || !result) return;
    const {
      venue,
      side,
      action,
      reason,
      orderId,
      qty,
      leverage,
      signalStrength,
      decisionScore,
      decisionMin,
      decisionBias,
      expectedMoveLong,
      expectedMoveShort,
      decisionLong,
      decisionShort,
    } = result;
    emitSignalActionActivity(hub, {
      kind: "supertrend",
      strategyKey: "SUPERTREND",
      venue: venue != null ? String(venue) : "—",
      side,
      action: action != null ? String(action) : "—",
      reason,
      orderId,
      qty,
      leverage,
      signalStrength,
      decisionScore:
        decisionScore ??
        (decisionBias === "short" ? decisionShort : decisionLong),
      decisionMin,
      decisionBias,
      expectedMoveLong,
      expectedMoveShort,
    });
  }

  /**
   * Run queued bar-close Supertrend action after `start()` (first tick with candles).
   * Clears pending before placing orders; `trySupertrend*` skips if already flat / guards fail.
   */
  async function flushPendingSupertrendOnStart(wsHub) {
    if (!state.running) return;
    if (state.feedExecutionPause) return;
    const pending = state.pendingSupertrendAction;
    if (!pending) return;
    const candles = feed.getCandles();
    const last = candles?.length ? candles[candles.length - 1] : null;
    if (!last) return;

    const symU = String(state.symbol).toUpperCase();
    if (String(pending.symbol).toUpperCase() !== symU) {
      state.pendingSupertrendAction = null;
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: `Pending Supertrend dropped: symbol changed (${pending.symbol} → ${symU})`,
      });
      return;
    }

    state.pendingSupertrendAction = null;

    const mm = String(state.marketMode).toUpperCase();
    const spotOn = Boolean(state.supertrendSpotAuto);
    const futOn = Boolean(state.supertrendFuturesAuto);
    let stSpot = spotOn && mm === "SPOT";
    let stFut = futOn && mm === "FUTURES";
    if (mm === "AUTO") {
      if (futOn) {
        stFut = true;
        stSpot = false;
      } else if (spotOn) {
        stSpot = true;
        stFut = false;
      }
    }

    const venueWant = String(pending.venue || "").toUpperCase();
    const venueOk = venueWant === "SPOT" ? stSpot : stFut;
    if (!stSpot && !stFut) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: "Pending Supertrend skipped: Supertrend autotrade off or market mode mismatch",
      });
      return;
    }
    if (!venueOk) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: `Pending Supertrend (${pending.side} ${venueWant}) skipped: current market mode / toggles no longer match`,
      });
      return;
    }

    const hub = wsHub || wsHubRef;
    const strategyKey = "SUPERTREND";

    wsHub?.broadcast?.("log", {
      level: "info",
      msg: `Running pending Supertrend ${pending.side} (${venueWant}) from bar ${pending.barTs}`,
      symbol: state.symbol,
    });

    if (pending.side === "BUY") {
      if (stSpot && pending.dedupeKeyBuy) {
        const buyRes = await trySupertrendSpotOrder({
          side: "BUY",
          strategyKey,
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: pending.dedupeKeyBuy,
          decisionSnapshot: resolveSupertrendDecisionSnapshot(null),
        });
        emitSupertrendSignalFeedback(hub, buyRes);
        if (buyRes?.action === "placed") await pushImmediateState(hub);
      } else if (stFut && pending.dedupeKeyBuyFut) {
        const buyRes = await trySupertrendFuturesOrder({
          side: "BUY",
          strategyKey,
          wsHub: hub,
          dedupeKey: pending.dedupeKeyBuyFut,
          decisionSnapshot: resolveSupertrendDecisionSnapshot(null),
        });
        emitSupertrendSignalFeedback(hub, buyRes);
        if (buyRes?.action === "placed") await pushImmediateState(hub);
      }
      return;
    }

    if (pending.side === "SELL") {
      if (stSpot && pending.dedupeKeySellSpot) {
        const sellRes = await trySupertrendSpotOrder({
          side: "SELL",
          strategyKey,
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: pending.dedupeKeySellSpot,
          decisionSnapshot: resolveSupertrendDecisionSnapshot(null),
        });
        emitSupertrendSignalFeedback(hub, sellRes);
        if (sellRes?.action === "placed") await pushImmediateState(hub);
      } else if (stFut && pending.dedupeKeySellFut) {
        const sellRes = await trySupertrendFuturesOrder({
          side: "SELL",
          strategyKey,
          wsHub: hub,
          dedupeKey: pending.dedupeKeySellFut,
          decisionSnapshot: resolveSupertrendDecisionSnapshot(null),
        });
        emitSupertrendSignalFeedback(hub, sellRes);
        if (sellRes?.action === "placed") await pushImmediateState(hub);
      }
    }
  }

  /**
   * @param {{ side: string, strategyKey: string, wsHub: any, indicatorFullCapital?: boolean, dedupeKey?: string | null, tradeSymbol?: string | null, candlesOverride?: array | null, fixedQuoteSpendUsdt?: number | null, multiUnpinnedOrder?: boolean }} args
   * `indicatorFullCapital`: spot wallet — BUY spends ~all quote free balance; SELL closes full base position (Supertrend-only path).
   */
  async function trySupertrendSpotOrder({
    side,
    strategyKey,
    wsHub,
    indicatorFullCapital = false,
    dedupeKey = null,
    decisionSnapshot = null,
    tradeSymbol = null,
    candlesOverride = null,
    fixedQuoteSpendUsdt = null,
    multiUnpinnedOrder = false,
  }) {
    let spot = exch?.spot;
    if (!spot?.placeOrder && typeof exch?.placeOrder === "function") spot = exch;
    if (!spot?.placeOrder) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: "Supertrend: no exchange with placeOrder (use BINANCE_DEMO_API / BINANCE_TESTNET / BINANCE_LIVE / PAPER with autotrading)",
      });
      return { venue: "SPOT", side, action: "skipped", reason: "no_spot_placeOrder" };
    }
    if (state.feedExecutionPause) {
      return { venue: "SPOT", side, action: "skipped", reason: "feed_execution_paused" };
    }
    const orderSymbol = String(tradeSymbol || state.symbol).toUpperCase();
    const candles =
      Array.isArray(candlesOverride) && candlesOverride.length ? candlesOverride : feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: "Supertrend spot: no candles in feed buffer — cannot size order",
        symbol: orderSymbol,
      });
      return { venue: "SPOT", side, action: "skipped", reason: "no_candles" };
    }

    const indicators = computeIndicators(candles);
    const regime = state.lastRegime?.type || "UNKNOWN";
    const prob = 0.82;
    const fixedSpend =
      fixedQuoteSpendUsdt != null &&
      Number.isFinite(Number(fixedQuoteSpendUsdt)) &&
      Number(fixedQuoteSpendUsdt) > 0
        ? Number(fixedQuoteSpendUsdt)
        : null;

    const now = Date.now();
    if (!indicatorFullCapital && fixedSpend == null && !multiUnpinnedOrder) {
      state.tradeOpenTimestamps = (state.tradeOpenTimestamps || []).filter((t) => now - Number(t) < 60 * 60_000);
      if (state.lastTradeOpenedAt && now - Number(state.lastTradeOpenedAt) < state.tradeCooldownMs) {
        noteTradeBlock({ reason: "cooldown", symbol: orderSymbol, strategyKey });
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend spot: skipped — trade cooldown",
          symbol: orderSymbol,
          strategyKey,
        });
        return { venue: "SPOT", side, action: "skipped", reason: "cooldown" };
      }
      if (state.tradeOpenTimestamps.length >= state.maxTradesPerHour) {
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: "Supertrend spot: skipped — max trades/hour",
          symbol: orderSymbol,
        });
        return { venue: "SPOT", side, action: "skipped", reason: "max_trades_per_hour" };
      }
    }

    // Demo spot (and similar) tracks TP/SL via OCO; REST user-stream is often off. Sync before SELL so
    // `getPositions` / wallet free base match the exchange — avoids "no spot position" vs ghost rows or
    // no_free_base_after_oco when the bracket already filled or mem was stale.
    if (side === "SELL" && spot?.markToMarket) {
      try {
        await spot.markToMarket();
      } catch (e) {
        log?.warn?.("supertrend_spot_mtm_before_sell_failed", { error: String(e?.message || e), symbol: orderSymbol });
      }
    }

    let positions = _cachedPositions || [];
    try {
      positions = await exch.getPositions();
      _cachedPositions = positions;
    } catch {
      /* use cache */
    }
    const symU = orderSymbol;
    const here = positions.filter((p) => String(p.symbol).toUpperCase() === symU).filter((p) => !p.venue || String(p.venue) === "SPOT");
    if (side === "BUY" && fixedSpend != null && here.length > 0) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: "Supertrend spot BUY skipped: already have spot position on symbol (AUTO multi)",
        symbol: orderSymbol,
      });
      return { venue: "SPOT", side, action: "skipped", reason: "already_spot_position" };
    }
    if (side === "BUY" && here.length >= state.maxConcurrentPositions) {
      noteTradeBlock({ reason: "max_positions", symbol: orderSymbol, strategyKey });
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: "Supertrend spot BUY skipped: max concurrent positions",
        symbol: orderSymbol,
      });
      return { venue: "SPOT", side, action: "skipped", reason: "max_concurrent_positions" };
    }
    if (side === "SELL" && here.length === 0) {
      wsHub?.broadcast?.("log", { level: "info", msg: "Supertrend SELL skipped: no spot position", symbol: orderSymbol });
      return { venue: "SPOT", side, action: "skipped", reason: "no_spot_position" };
    }

    let decisionSnapSpot = decisionSnapshot;
    if (side === "BUY") {
      decisionSnapSpot = decisionSnapshot ?? resolveSupertrendDecisionSnapshot(null);
      const gate = signalStrengthBlocksOpen({ openingSide: "BUY", decisionSnapshot: decisionSnapSpot });
      if (gate) {
        const ss = decisionSnapSpot?.signalStrength;
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend spot BUY skipped: signal strength gate (${gate.reason}) — ${ss ? `strength ${ss.strength} action ${ss.action} signal ${ss.signal}` : "no strength"}`,
          symbol: orderSymbol,
          detail: gate.detail,
        });
        return {
          venue: "SPOT",
          side,
          action: "skipped",
          reason: gate.reason,
          decisionScore: ss?.strength,
          decisionBias: "long",
          signalStrength: ss ?? undefined,
          expectedMoveLong: decisionSnapSpot?.expectedMoveLong ?? null,
          expectedMoveShort: decisionSnapSpot?.expectedMoveShort ?? null,
        };
      }
    }

    const { stopLoss, takeProfit } = spotBracketFromAtr({
      entryPrice: last.close,
      atr: indicators.latest?.atr_14,
      regime,
      side,
    });
    const perUnitRisk = Math.abs(Number(last.close) - stopLoss);
    if (!Number.isFinite(perUnitRisk) || perUnitRisk <= 0) {
      wsHub?.broadcast?.("log", { level: "warn", msg: "Supertrend: invalid stop distance, skip order", symbol: orderSymbol });
      return { venue: "SPOT", side, action: "skipped", reason: "invalid_stop_distance" };
    }

    let qty;
    if (indicatorFullCapital) {
      /** Default 1 = deploy ~100% of free quote (USDT) on BUY; clamp allows tiny slack if exchange rejects full balance. */
      const bufferPct = clamp(Number(process.env.SUPERTREND_SPOT_NOTIONAL_BUFFER_PCT ?? 1), 0.85, 1);
      let acct;
      try {
        acct = await spot.getAccount();
      } catch (e) {
        wsHub?.broadcast?.("log", { level: "warn", msg: `Supertrend: account read failed: ${String(e?.message || e)}` });
        return { venue: "SPOT", side, action: "skipped", reason: "account_read_failed" };
      }
      const tradable = Number(acct.freeBalance ?? acct.equity ?? 0);
      if (!Number.isFinite(tradable) || tradable <= 0) {
        wsHub?.broadcast?.("log", { level: "warn", msg: "Supertrend: no spendable spot balance", symbol: orderSymbol });
        return { venue: "SPOT", side, action: "skipped", reason: "no_spendable_balance" };
      }
      if (side === "BUY") {
        const spend = tradable * bufferPct;
        qty = roundTo(spend / Number(last.close), 8);
        if (!qty || qty <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "Supertrend spot BUY skipped: computed qty is zero (check price and balance)",
            symbol: orderSymbol,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "zero_qty_buy" };
        }
        state._supertrendLastBuySpendUsdt = spend;
      } else {
        const pos = here[0];
        qty = roundTo(Number(pos?.qty || 0), 8);
        if (!qty || qty <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "Supertrend spot SELL skipped: zero position qty",
            symbol: orderSymbol,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "zero_position_qty" };
        }
      }
    } else if (fixedSpend != null) {
      /** AUTO multi-unpinned: spend a fixed USDT slice of current free quote (see AUTO_MULTI_SLOT_PCT). */
      const bufferPct = clamp(Number(process.env.SUPERTREND_SPOT_NOTIONAL_BUFFER_PCT ?? 1), 0.85, 1);
      let acct;
      try {
        acct = await spot.getAccount();
      } catch (e) {
        wsHub?.broadcast?.("log", { level: "warn", msg: `Supertrend: account read failed: ${String(e?.message || e)}` });
        return { venue: "SPOT", side, action: "skipped", reason: "account_read_failed" };
      }
      const tradable = Number(acct.freeBalance ?? acct.equity ?? 0);
      if (!Number.isFinite(tradable) || tradable <= 0) {
        wsHub?.broadcast?.("log", { level: "warn", msg: "Supertrend: no spendable spot balance", symbol: orderSymbol });
        return { venue: "SPOT", side, action: "skipped", reason: "no_spendable_balance" };
      }
      if (side === "BUY") {
        const spend = Math.min(fixedSpend * bufferPct, tradable * bufferPct);
        qty = roundTo(spend / Number(last.close), 8);
        if (!qty || qty <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "Supertrend spot BUY skipped: computed qty is zero (fixed spend)",
            symbol: orderSymbol,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "zero_qty_buy" };
        }
        state._supertrendLastBuySpendUsdt = spend;
      } else {
        const pos = here[0];
        qty = roundTo(Number(pos?.qty || 0), 8);
        if (!qty || qty <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "Supertrend spot SELL skipped: zero position qty",
            symbol: orderSymbol,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "zero_position_qty" };
        }
      }
    } else {
      const plan = await riskPlan({
        exchange: spot,
        side,
        entryPrice: last.close,
        confidence: prob,
        riskPerTrade: state.riskPerTrade,
        riskPerTradeUnit: state.riskPerTradeUnit,
        fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
        atr: indicators.latest?.atr_14,
        futuresLeverage: undefined,
        stats: state.stats[strategyKey],
        regime,
      });
      if (!plan.ok) {
        wsHub?.broadcast?.("log", { level: "warn", msg: "Supertrend: risk plan rejected", reason: plan.reason });
        return { venue: "SPOT", side, action: "skipped", reason: plan.reason || "risk_plan" };
      }
      qty = plan.qty;
      if (side === "SELL") {
        const pos = here[0];
        qty = roundTo(Number(pos?.qty || 0), 8);
        if (!qty || qty <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "Supertrend spot SELL skipped: zero qty after risk plan",
            symbol: orderSymbol,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "zero_qty_sell" };
        }
      }
    }

    const minSpotQuote = Number(process.env.BINANCE_SPOT_MIN_QUOTE_USDT ?? 5.5);
    if (side === "BUY") {
      const estQuote =
        (indicatorFullCapital || fixedSpend != null) && Number.isFinite(Number(state._supertrendLastBuySpendUsdt))
          ? Number(state._supertrendLastBuySpendUsdt)
          : Number(qty) * Number(last.close);
      if (Number.isFinite(estQuote) && estQuote > 0 && estQuote < minSpotQuote) {
        const cooldownMs = Number(process.env.SUPERTREND_LOW_USDT_WARN_COOLDOWN_MS ?? 600_000);
        const nowT = Date.now();
        if (nowT - Number(state.supertrendLowUsdtLastWarnAt || 0) >= cooldownMs) {
          state.supertrendLowUsdtLastWarnAt = nowT;
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend BUY skipped: ~${estQuote.toFixed(2)} USDT order is below Binance spot minimum (~${minSpotQuote} USDT). Free USDT on spot is too low — higher portfolio equity is often from other assets (e.g. BTC) or locked USDT, which are not spent on this buy. To take trades: add or convert to at least ~${Math.ceil(minSpotQuote + 1)} USDT free on this spot wallet.`,
            symbol: orderSymbol,
            estQuoteUsdt: estQuote,
          });
        }
        return { venue: "SPOT", side, action: "skipped", reason: "below_min_spot_quote" };
      }
    }

    try {
      if (dedupeKey) {
        if (supertrendOrderDedupe.has(dedupeKey)) {
          wsHub?.broadcast?.("log", {
            level: "info",
            msg: "Supertrend spot: order already attempted for this signal (dedupe)",
            symbol: orderSymbol,
            side,
          });
          return { venue: "SPOT", side, action: "skipped", reason: "duplicate_signal" };
        }
        supertrendOrderDedupe.set(dedupeKey, Date.now());
        pruneSupertrendDedupe();
      }
      const spendMeta =
        side === "BUY" &&
        (indicatorFullCapital || fixedSpend != null) &&
        Number.isFinite(Number(state._supertrendLastBuySpendUsdt))
          ? Number(state._supertrendLastBuySpendUsdt)
          : undefined;
      const order = await spot.placeOrder({
        symbol: orderSymbol,
        side,
        qty,
        price: last.close,
        stopLoss,
        takeProfit,
        strategy: strategyKey,
        meta: {
          supertrend: true,
          aiProbability: prob,
          marketMode: "SPOT",
          indicatorFullCapital: Boolean(indicatorFullCapital),
          autoMultiUnpinned: Boolean(multiUnpinnedOrder),
          spendQuoteUsdt: spendMeta,
        },
      });
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend ${side} (${
          indicatorFullCapital ? "full spot wallet" : fixedSpend != null ? "AUTO multi slice" : "risk-sized"
        }) qty=${qty}`,
        symbol: orderSymbol,
        qty,
        strategyKey,
      });
      if (side === "BUY") {
        wsHub?.broadcast?.("trade", {
          type: "OPEN",
          id: order.id,
          ts: new Date().toISOString(),
          symbol: orderSymbol,
          side,
          qty,
          price: order.filledPrice,
          stopLoss,
          takeProfit,
          strategy: strategyKey,
          strategyKey,
          aiProbability: prob,
          venue: "SPOT",
          source: "SUPERTREND",
        });
      } else {
        const exitPx = Number(order.filledPrice);
        wsHub?.broadcast?.("trade", {
          type: "CLOSE",
          id: order.id,
          ts: new Date().toISOString(),
          symbol: orderSymbol,
          side: "SELL",
          qty,
          price: order.filledPrice,
          pnl: Number(order.pnl ?? 0),
          fee: tradeCloseFeeUsdtFromNotional(qty, exitPx) ?? undefined,
          strategy: strategyKey,
          strategyKey,
          venue: "SPOT",
          reason: "SUPERTREND_EXIT",
          source: "SUPERTREND",
        });
      }
      state.stats[strategyKey].trades += 1;
      state.lastTradeOpenedAt = Date.now();
      if (!indicatorFullCapital && fixedSpend == null && !multiUnpinnedOrder) state.tradeOpenTimestamps.push(Date.now());
      return {
        venue: "SPOT",
        side,
        action: "placed",
        orderId: order.id,
        qty,
        decisionLong: decisionSnapSpot?.long?.total,
        decisionShort: decisionSnapSpot?.short?.total,
        expectedMoveLong: decisionSnapSpot?.expectedMoveLong ?? null,
        expectedMoveShort: decisionSnapSpot?.expectedMoveShort ?? null,
        decisionBias: side === "BUY" ? "long" : undefined,
        decisionScore: side === "BUY" ? decisionSnapSpot?.long?.total : undefined,
      };
    } catch (e) {
      wsHub?.broadcast?.("log", { level: "error", msg: `Supertrend order failed: ${String(e?.message || e)}` });
      log.warn("supertrend_order_failed", { error: String(e?.message || e), side, symbol: orderSymbol });
      return { venue: "SPOT", side, action: "error", reason: String(e?.message || e) };
    }
  }

  /**
   * Supertrend autotrade on USD-M futures: bar-close BUY/SELL uses AI /predict for leverage (AUTO) and sizing.
   * 1-way: BUY opens long; SELL closes long only. 2-way: BUY flips short→long; SELL flips long→short.
   * With AI confidence filter off: SL/TP default to fixed % (0.002 / 0.015) after risk-based qty.
   */
  async function trySupertrendFuturesOrder({
    side,
    strategyKey,
    wsHub,
    dedupeKey = null,
    signalStrength = null,
    decisionSnapshot = null,
    tradeSymbol = null,
    candlesOverride = null,
    multiUnpinnedOrder = false,
    aiPredictNoLastAi = false,
    maxNotionalUsd = null,
  }) {
    let futuresEx = exch?.futures;
    if (!futuresEx?.placeOrder && typeof exch?.placeOrder === "function") {
      const n = String(exch?.name || "").toLowerCase();
      if (n.includes("futures")) futuresEx = exch;
    }
    if (!futuresEx?.placeOrder) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: "Supertrend futures: no futures connector with placeOrder (set Market FUTURES + keys for demo, testnet, or BINANCE_LIVE)",
      });
      return { venue: "FUTURES", side, action: "skipped", reason: "no_futures_placeOrder" };
    }
    if (state.feedExecutionPause) {
      return { venue: "FUTURES", side, action: "skipped", reason: "feed_execution_paused" };
    }

    const orderSymbol = String(tradeSymbol || state.symbol).toUpperCase();
    const candles =
      Array.isArray(candlesOverride) && candlesOverride.length ? candlesOverride : feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: "Supertrend futures: no candles in feed buffer — cannot size order",
        symbol: orderSymbol,
      });
      return { venue: "FUTURES", side, action: "skipped", reason: "no_candles" };
    }

    const indicators = computeIndicators(candles);
    const regimeType = state.lastRegime?.type || "UNKNOWN";

    /** No TRADE_COOLDOWN / maxTradesPerHour here — bar-close flips are rare; those guards blocked legitimate Supertrend entries. */

    let positions = _cachedPositions || [];
    try {
      positions = await exch.getPositions();
      _cachedPositions = positions;
    } catch {
      /* use cache */
    }
    const symU = orderSymbol;
    const twoWay = state.supertrendFuturesTwoWay === true;
    const closer = futuresEx?.closePosition ? futuresEx : exch;

    function legsFromPositions(posRows) {
      const rows = Array.isArray(posRows) ? posRows : [];
      const h = rows
        .filter((p) => String(p.symbol).toUpperCase() === symU)
        .filter((p) => String(p.venue || "").toUpperCase() !== "SPOT");
      return {
        here: h,
        longHere: h.filter((p) => p.side === "BUY"),
        shortHere: h.filter((p) => p.side === "SELL"),
      };
    }

    let { here, longHere, shortHere } = legsFromPositions(positions);

    async function refreshFuturesLegs() {
      try {
        positions = await exch.getPositions();
        _cachedPositions = positions;
      } catch {
        /* keep cache */
      }
      return legsFromPositions(_cachedPositions || []);
    }

    async function closeFuturesLegsForSupertrend(poses, reasonLabel) {
      const markPx = Number(last?.close);
      for (const pos of poses) {
        const closeId = pos.id || pos.symbol;
        try {
          const r = await closer.closePosition({
            id: closeId,
            ...(Number.isFinite(markPx) && markPx > 0 ? { price: markPx } : {}),
            reason: reasonLabel,
          });
          if (!r?.ok) {
            wsHub?.broadcast?.("log", {
              level: "error",
              msg: `Supertrend futures close failed: ${r?.error || "unknown"}`,
              symbol: orderSymbol,
            });
            return { ok: false, error: String(r?.error || "close_failed") };
          }
          const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
          const feePxClose =
            Number.isFinite(markPx) && markPx > 0
              ? markPx
              : Number(pos.entryPrice) > 0
                ? Number(pos.entryPrice)
                : NaN;
          wsHub?.broadcast?.("log", {
            level: "info",
            msg:
              pos.side === "BUY"
                ? "Supertrend — closed futures long (flip / exit; TP/SL on exchange may also apply)"
                : "Supertrend — closed futures short (flip / exit)",
            symbol: orderSymbol,
            strategyKey,
          });
          wsHub?.broadcast?.("trade", {
            type: "CLOSE",
            id: closeId,
            ts: new Date().toISOString(),
            symbol: orderSymbol,
            side: exitSide,
            qty: pos.qty,
            price:
              Number.isFinite(markPx) && markPx > 0
                ? markPx
                : Number(pos.entryPrice) > 0
                  ? Number(pos.entryPrice)
                  : null,
            pnl: r?.pnl != null && Number.isFinite(Number(r.pnl)) ? Number(r.pnl) : null,
            fee: tradeCloseFeeUsdtFromNotional(pos.qty, feePxClose) ?? undefined,
            stopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : null,
            takeProfit: pos.takeProfit != null ? Number(pos.takeProfit) : null,
            strategy: strategyKey,
            strategyKey,
            venue: "FUTURES",
            reason: reasonLabel,
            source: "SUPERTREND",
            leverage: pos.leverage,
            meta: {
              leverage: pos.leverage,
              entryPrice: Number(pos.entryPrice) > 0 ? Number(pos.entryPrice) : undefined,
            },
          });
          state.stats[strategyKey].trades += 1;
          state.lastTradeOpenedAt = Date.now();
          if (!multiUnpinnedOrder) state.tradeOpenTimestamps.push(Date.now());
        } catch (e) {
          wsHub?.broadcast?.("log", {
            level: "error",
            msg: `Supertrend futures close failed: ${String(e?.message || e)}`,
          });
          log.warn("supertrend_futures_close_failed", { error: String(e?.message || e), symbol: orderSymbol });
          return { ok: false, error: String(e?.message || e) };
        }
      }
      return { ok: true };
    }

    /** 1-way SELL: close long(s) only (no new short). */
    if (side === "SELL" && !twoWay) {
      if (longHere.length === 0) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures SELL skipped: no long position",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "no_futures_long" };
      }
      const cr = await closeFuturesLegsForSupertrend(longHere, "SUPERTREND_EXIT");
      if (!cr.ok) return { venue: "FUTURES", side, action: "error", reason: String(cr.error || "close_failed") };
      const pos0 = longHere[0];
      return {
        venue: "FUTURES",
        side,
        action: "placed",
        orderId: pos0?.id || pos0?.symbol,
        qty: pos0?.qty,
      };
    }

    /** BUY: open long; 2-way closes any short first. */
    if (side === "BUY") {
      if (longHere.length > 0) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures BUY skipped: already long on this symbol",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "already_in_futures_position" };
      }
      if (shortHere.length > 0) {
        if (!twoWay) {
          wsHub?.broadcast?.("log", {
            level: "info",
            msg: "Supertrend futures BUY skipped: short open — enable 2-way (buy & sell) to flip to long",
            symbol: orderSymbol,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "short_blocks_one_way" };
        }
        const cr = await closeFuturesLegsForSupertrend(shortHere, "SUPERTREND_FLIP");
        ({ here, longHere, shortHere } = await refreshFuturesLegs());
        if (!cr.ok) {
          if (shortHere.length > 0) {
            return { venue: "FUTURES", side, action: "error", reason: String(cr.error || "close_failed") };
          }
          if (longHere.length > 0) {
            return { venue: "FUTURES", side, action: "skipped", reason: "already_in_futures_position" };
          }
          broadcastActivity(wsHub, {
            level: "warn",
            msg: `Supertrend flip: close short failed (${String(cr.error || "unknown")}) but exchange has no short — opening long`,
            category: "signal",
            reason: "flip_close_error_but_flat",
            symbol: orderSymbol,
            detail: { priorError: String(cr.error || "") },
          });
        }
      }
      if (here.length > 0) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures BUY skipped: futures position still open after flip",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "position_after_flip" };
      }
      if (!multiUnpinnedOrder && longHere.length >= state.maxConcurrentPositions) {
        noteTradeBlock({ reason: "max_positions", symbol: orderSymbol, strategyKey });
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures BUY skipped: max concurrent positions",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "max_concurrent_positions" };
      }
    }

    /** 2-way SELL: close long(s) then open short below. */
    if (side === "SELL" && twoWay) {
      if (longHere.length > 0) {
        const cr = await closeFuturesLegsForSupertrend(longHere, "SUPERTREND_EXIT");
        if (!cr.ok) return { venue: "FUTURES", side, action: "error", reason: String(cr.error || "close_failed") };
        ({ here, longHere, shortHere } = await refreshFuturesLegs());
      }
      if (shortHere.length > 0) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures SELL skipped: already short on this symbol",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "already_in_short" };
      }
    }

    const openingSide = side;
    if (openingSide !== "BUY" && openingSide !== "SELL") {
      return { venue: "FUTURES", side, action: "skipped", reason: "bad_side" };
    }
    if (openingSide === "SELL" && !twoWay) {
      return { venue: "FUTURES", side, action: "skipped", reason: "internal_sell_open_requires_two_way" };
    }

    let snapUsedForOpen = decisionSnapshot ?? resolveSupertrendDecisionSnapshot(null);
    const gate = signalStrengthBlocksOpen({ openingSide, decisionSnapshot: snapUsedForOpen });
    if (gate) {
      const ss = snapUsedForOpen?.signalStrength;
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} skipped: signal strength gate (${gate.reason}) — ${ss ? `strength ${ss.strength} action ${ss.action} signal ${ss.signal}` : "no strength"}`,
        symbol: orderSymbol,
        detail: gate.detail,
      });
      return {
        venue: "FUTURES",
        side,
        action: "skipped",
        reason: gate.reason,
        decisionScore: ss?.strength,
        decisionBias: openingSide === "BUY" ? "long" : "short",
        signalStrength: ss ?? undefined,
        expectedMoveLong: snapUsedForOpen?.expectedMoveLong ?? null,
        expectedMoveShort: snapUsedForOpen?.expectedMoveShort ?? null,
      };
    }

    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let gateProb = NaN;
    if (candles.length >= aiMinCandles) {
      try {
        const aiResp = await ai.predict({ symbol: orderSymbol, timeframe: state.timeframe, candles });
        if (!aiPredictNoLastAi) {
          state.lastAi = {
            probability: aiResp.probability,
            rawProbability: aiResp.raw_probability ?? aiResp.rawProbability,
            shortProbability: aiResp.short_probability ?? aiResp.shortProbability ?? null,
            shortRawProbability: aiResp.short_raw_probability ?? aiResp.shortRawProbability ?? null,
            calibrated: aiResp.calibrated,
            features: aiResp.features,
            model_kind: aiResp.model_kind || aiResp.modelKind,
          };
        }
        const calProb = Number(aiResp?.probability ?? 0);
        const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
        gateProb = aiGateProbability(calProb, rawProb);
        log.info("supertrend_futures_ai", { symbol: orderSymbol, gateProb, calibrated: Boolean(aiResp?.calibrated) });
      } catch (e) {
        const errMsg = formatAiServiceError(e);
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: "Supertrend futures: AI predict failed; trying last score",
          error: errMsg,
        });
        log.warn("supertrend_futures_predict_failed", { symbol: orderSymbol, error: errMsg });
      }
    }
    if (!Number.isFinite(gateProb) && !aiPredictNoLastAi) {
      const calProb = Number(state.lastAi?.probability ?? 0);
      const rawProb = Number(state.lastAi?.rawProbability ?? NaN);
      if (state.lastAi && (Number.isFinite(calProb) || Number.isFinite(rawProb))) {
        gateProb = aiGateProbability(calProb, rawProb);
      }
    }
    if (!Number.isFinite(gateProb)) {
      if (isFixedUsdtCapitalMode()) {
        gateProb = 1;
      } else {
        const rawFb = process.env.SUPERTREND_FUTURES_AI_FALLBACK_PROB;
        const fbParsed =
          rawFb === undefined || rawFb === ""
            ? 0.58
            : clamp(Number(rawFb), 0, 1);
        if (fbParsed > 0) {
          gateProb = fbParsed;
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend futures: no live AI score (need /predict + ≥${aiMinCandles} candles, or lastAi cache) — using fallback prob ${fbParsed} for sizing. Set SUPERTREND_FUTURES_AI_FALLBACK_PROB=0 to disable.`,
            symbol: orderSymbol,
          });
        } else {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend futures ${openingSide} skipped: no AI score (need ≥${aiMinCandles} candles for /predict, running AI service, or set SUPERTREND_FUTURES_AI_FALLBACK_PROB).`,
            symbol: orderSymbol,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "no_ai_score" };
        }
      }
    }

    const aiFilterOn =
      !isFixedUsdtCapitalMode() && state.supertrendFuturesAiConfidenceFilter !== false;
    const minAi = clamp(Number(state.supertrendFuturesMinAiProb ?? 0.55), 0, 1);
    if (aiFilterOn && minAi > 0 && gateProb < minAi) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} skipped: AI ${gateProb.toFixed(3)} < min AI prob (${minAi})`,
        symbol: orderSymbol,
      });
      return { venue: "FUTURES", side, action: "skipped", reason: "ai_below_min_prob" };
    }

    /** Risk tiers use `confidence`; blend ST strength into sizing when enabled (long and short). */
    const blendStOn =
      String(process.env.SUPERTREND_FUTURES_BLEND_ST_SIGNAL ?? "1").toLowerCase() !== "0" &&
      String(process.env.SUPERTREND_FUTURES_BLEND_ST_SIGNAL ?? "1").toLowerCase() !== "false";
    const stN =
      signalStrength != null && Number.isFinite(Number(signalStrength)) ? clamp(Number(signalStrength), 0, 1) : null;
    let sizingConfidence = blendStOn && stN != null ? Math.max(gateProb, stN) : gateProb;
    /** AI filter off: floor sizing from signal strength or neutral default. */
    if (!aiFilterOn) {
      const floor = clamp(Number(process.env.SUPERTREND_FUTURES_NO_AI_FILTER_SIZING_FLOOR ?? 0.55), 0.35, 0.95);
      sizingConfidence = Math.max(sizingConfidence, stN ?? floor);
    }

    const lev =
      String(state.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
        ? clamp(Number(state.futuresLeverage), 1, 100)
        : decideFuturesLeverage({
            prob: isFixedUsdtCapitalMode() ? 0.75 : gateProb,
            atrPct: state.lastRegime?.atrPct,
            regime: regimeType,
          });

    const plan = await riskPlan({
      exchange: futuresEx,
      side: openingSide,
      entryPrice: last.close,
      confidence: sizingConfidence,
      riskPerTrade: state.riskPerTrade,
      riskPerTradeUnit: state.riskPerTradeUnit,
      fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
      atr: indicators.latest?.atr_14,
      futuresLeverage: lev,
      stats: state.stats[strategyKey],
      regime: regimeType,
      aiConfidence: gateProb,
    });
    if (!plan.ok) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: `Supertrend futures ${openingSide} skipped: ${plan.reason || "risk_plan"} (AI gate=${gateProb.toFixed(3)}, sizing=${sizingConfidence.toFixed(3)}${stN != null ? `, ST str=${stN.toFixed(3)}` : ""})`,
        symbol: orderSymbol,
      });
      return {
        venue: "FUTURES",
        side,
        action: "skipped",
        reason: plan.reason || "risk_plan",
        aiGateProb: gateProb,
        sizingConfidence,
        signalStrength: stN ?? undefined,
      };
    }

    const pxEntry = Number(last.close);
    let qty = plan.qty;
    let stopLoss = plan.stopLoss;
    let takeProfit = plan.takeProfit;

    /** With AI confidence filter off: fixed %-based SL/TP for indicator entries. */
    if (!aiFilterOn) {
      const slPct = clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2);
      const tpPct = clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5);
      if (openingSide === "BUY") {
        stopLoss = pxEntry * (1 - slPct);
        takeProfit = pxEntry * (1 + tpPct);
      } else {
        stopLoss = pxEntry * (1 + slPct);
        takeProfit = pxEntry * (1 - tpPct);
      }
      const perUnitRisk = Math.abs(pxEntry - stopLoss);
      const riskUsd = Number(plan.riskUsd);
      if (perUnitRisk > 0 && riskUsd > 0) {
        qty = roundTo(riskUsd / perUnitRisk, 6);
        const buyingPower = Number(plan.tradableBalance) * lev;
        const maxNotional = buyingPower * 0.9;
        const notional = qty * pxEntry;
        if (notional > maxNotional && pxEntry > 0) qty = roundTo(maxNotional / pxEntry, 6);
      }
    }

    const capN = Number(maxNotionalUsd);
    if (Number.isFinite(capN) && capN > 0 && pxEntry > 0) {
      const maxQ = capN / pxEntry;
      if (qty > maxQ) qty = roundTo(maxQ, 6);
    }

    const minFut = Number(
      process.env.SUPERTREND_FUTURES_MIN_NOTIONAL_USDT ?? process.env.BINANCE_FUTURES_MIN_NOTIONAL ?? 5,
    );
    const estNotional = Number(qty) * Number(last.close);
    if (Number.isFinite(estNotional) && estNotional > 0 && estNotional < minFut) {
      const cooldownMs = Number(process.env.SUPERTREND_LOW_USDT_WARN_COOLDOWN_MS ?? 600_000);
      const t = Date.now();
      if (t - Number(state.supertrendLowFutNotionalLastWarnAt || 0) >= cooldownMs) {
        state.supertrendLowFutNotionalLastWarnAt = t;
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: `Supertrend futures ${openingSide} skipped: ~${estNotional.toFixed(2)} USDT notional below minimum (~${minFut} USDT).`,
          symbol: orderSymbol,
        });
      }
      return { venue: "FUTURES", side, action: "skipped", reason: "below_min_futures_notional" };
    }

    try {
      if (dedupeKey) {
        if (supertrendOrderDedupe.has(dedupeKey)) {
          wsHub?.broadcast?.("log", {
            level: "info",
            msg: "Supertrend futures: order already attempted for this signal (dedupe)",
            symbol: orderSymbol,
            side: openingSide,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "duplicate_signal" };
        }
        supertrendOrderDedupe.set(dedupeKey, Date.now());
        pruneSupertrendDedupe();
      }
      const order = await futuresEx.placeOrder({
        symbol: orderSymbol,
        side: openingSide,
        qty,
        price: last.close,
        stopLoss,
        takeProfit,
        strategy: strategyKey,
        meta: {
          supertrend: true,
          aiProbability: gateProb,
          marketMode: "FUTURES",
          supertrendFuturesAiSized: true,
          supertrendFuturesTwoWay: twoWay,
          futuresLeverage: lev,
          leverage: lev,
          autoMultiUnpinned: Boolean(multiUnpinnedOrder),
        },
      });
      const tpSlNote = !aiFilterOn ? "fixed SL/TP (no AI filter)" : "ATR+regime+AI";
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} AI=${gateProb.toFixed(3)} lev=${lev}x qty=${qty} ${tpSlNote}`,
        symbol: orderSymbol,
        qty,
        leverage: lev,
        strategyKey,
      });
      wsHub?.broadcast?.("trade", {
        type: "OPEN",
        id: order.id,
        ts: new Date().toISOString(),
        symbol: orderSymbol,
        side: openingSide,
        qty,
        price: order.filledPrice,
        stopLoss,
        takeProfit,
        strategy: strategyKey,
        strategyKey,
        aiProbability: gateProb,
        venue: "FUTURES",
        leverage: order.leverage ?? lev,
        meta: { supertrend: true, leverage: order.leverage ?? lev, venue: "FUTURES" },
        source: "SUPERTREND",
      });
      state.stats[strategyKey].trades += 1;
      state.lastTradeOpenedAt = Date.now();
      if (!multiUnpinnedOrder) state.tradeOpenTimestamps.push(Date.now());
      return {
        venue: "FUTURES",
        side,
        action: "placed",
        orderId: order.id,
        qty,
        leverage: order.leverage ?? lev,
        decisionLong: snapUsedForOpen?.long?.total,
        decisionShort: snapUsedForOpen?.short?.total,
        expectedMoveLong: snapUsedForOpen?.expectedMoveLong ?? null,
        expectedMoveShort: snapUsedForOpen?.expectedMoveShort ?? null,
        decisionBias: openingSide === "BUY" ? "long" : "short",
        decisionScore: openingSide === "BUY" ? snapUsedForOpen?.long?.total : snapUsedForOpen?.short?.total,
      };
    } catch (e) {
      wsHub?.broadcast?.("log", {
        level: "error",
        msg: `Supertrend futures order failed: ${String(e?.message || e)}`,
      });
      log.warn("supertrend_futures_order_failed", { error: String(e?.message || e), side, symbol: orderSymbol });
      return { venue: "FUTURES", side, action: "error", reason: String(e?.message || e) };
    }
  }

  /** AI gate probs at bar close: long model for BUY path, short model for SELL path (when trained). Updates `state.lastAi` on successful /predict. */
  async function resolveSupertrendBarCloseAiGates(rawCandles) {
    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let aiGateBuy = null;
    let aiGateSell = null;
    if (rawCandles.length >= aiMinCandles) {
      try {
        const aiResp = await ai.predict({
          symbol: state.symbol,
          timeframe: state.timeframe,
          candles: rawCandles,
        });
        state.lastAi = {
          probability: aiResp.probability,
          rawProbability: aiResp.raw_probability ?? aiResp.rawProbability,
          shortProbability: aiResp.short_probability ?? aiResp.shortProbability ?? null,
          shortRawProbability: aiResp.short_raw_probability ?? aiResp.shortRawProbability ?? null,
          calibrated: aiResp.calibrated,
          features: aiResp.features,
          model_kind: aiResp.model_kind || aiResp.modelKind,
        };
        const calProb = Number(aiResp?.probability ?? 0);
        const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
        aiGateBuy = aiGateProbability(calProb, rawProb);
        const shortProb = Number(aiResp?.short_probability ?? aiResp?.shortProbability ?? NaN);
        const shortRaw = Number(aiResp?.short_raw_probability ?? aiResp?.shortRawProbability ?? NaN);
        if (Number.isFinite(shortProb) && shortProb > 0) {
          aiGateSell = aiGateProbability(shortProb, shortRaw);
        }
      } catch (e) {
        log.warn("supertrend_bar_close_ai_predict_failed", {
          symbol: state.symbol,
          error: formatAiServiceError(e),
        });
      }
    }
    if (!Number.isFinite(aiGateBuy)) {
      const calProb = Number(state.lastAi?.probability ?? 0);
      const rawProb = Number(state.lastAi?.rawProbability ?? NaN);
      if (state.lastAi && (Number.isFinite(calProb) || Number.isFinite(rawProb))) {
        aiGateBuy = aiGateProbability(calProb, rawProb);
      }
    }
    if (!Number.isFinite(aiGateSell)) {
      const shortProb = Number(state.lastAi?.shortProbability ?? NaN);
      const shortRaw = Number(state.lastAi?.shortRawProbability ?? NaN);
      if (Number.isFinite(shortProb) && shortProb > 0) {
        aiGateSell = aiGateProbability(shortProb, shortRaw);
      }
    }
    return { aiGateBuy: Number.isFinite(aiGateBuy) ? aiGateBuy : null, aiGateSell: Number.isFinite(aiGateSell) ? aiGateSell : null };
  }

  /**
   * Bar-close AI gates for a specific symbol without mutating `state.lastAi` (AUTO multi sweep + jsonl history).
   */
  async function resolveSupertrendBarCloseAiGatesNoLastAi(rawCandles, predictSymbol) {
    const sym = String(predictSymbol || "").toUpperCase();
    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let aiGateBuy = null;
    let aiGateSell = null;
    if (!sym || rawCandles.length < aiMinCandles) {
      return { aiGateBuy: null, aiGateSell: null };
    }
    try {
      const aiResp = await ai.predict({
        symbol: sym,
        timeframe: state.timeframe,
        candles: rawCandles,
      });
      const calProb = Number(aiResp?.probability ?? 0);
      const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
      aiGateBuy = aiGateProbability(calProb, rawProb);
      const shortProb = Number(aiResp?.short_probability ?? aiResp?.shortProbability ?? NaN);
      const shortRaw = Number(aiResp?.short_raw_probability ?? aiResp?.shortRawProbability ?? NaN);
      if (Number.isFinite(shortProb) && shortProb > 0) {
        aiGateSell = aiGateProbability(shortProb, shortRaw);
      }
    } catch (e) {
      log.warn("supertrend_auto_multi_ai_gates_failed", { symbol: sym, error: formatAiServiceError(e) });
    }
    return {
      aiGateBuy: Number.isFinite(aiGateBuy) ? aiGateBuy : null,
      aiGateSell: Number.isFinite(aiGateSell) ? aiGateSell : null,
    };
  }

  /** Persist flip to jsonl (all symbols); merge into in-memory history + WS when entry matches chart symbol/timeframe. */
  function mergeSupertrendSignalHistoryFromAutoMulti(entry, wsHub) {
    appendSupertrendSignalHistoryEntry(entry);
    const symE = String(entry.symbol || "").toUpperCase();
    const tfE = String(entry.timeframe || "");
    if (symE === String(state.symbol).toUpperCase() && tfE === String(state.timeframe)) {
      const prev = Array.isArray(state.supertrendSignalHistory) ? state.supertrendSignalHistory : [];
      const filt = prev.filter(
        (e) =>
          !(
            Number(e?.ts) === entry.ts &&
            e?.side === entry.side &&
            String(e?.symbol || symE).toUpperCase() === symE
          ),
      );
      filt.push({
        ts: entry.ts,
        side: entry.side,
        symbol: symE,
        timeframe: tfE,
        aiGate: entry.aiGate,
        strength: entry.strength,
        stAction: entry.stAction,
      });
      filt.sort((a, b) => Number(a.ts) - Number(b.ts));
      state.supertrendSignalHistory = filt.slice(-SUPERTREND_SIGNAL_STATE_MAX);
      persistTradingConfigToDisk();
      wsHub?.broadcast?.("state", { mode: runtimeTradingMode(), ...getPublicState() });
    }
  }

  function autoMultiUnpinnedEnvOn() {
    const v = String(process.env.AUTO_MULTI_UNPINNED_SUPERTREND ?? "0").toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }

  /** AUTO coin select, no table pin, env on, live Binance feed, bot running, Supertrend autotrade for active venue. */
  function autoMultiUnpinnedActive(mmUp) {
    if (!autoMultiUnpinnedEnvOn()) return false;
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    if (state.universePinnedSymbol) return false;
    if (!state.running) return false;
    if (!marketFeedUsesLiveBinance()) return false;
    const spotOn = Boolean(state.supertrendSpotAuto);
    const futOn = Boolean(state.supertrendFuturesAuto);
    let stSpot = spotOn && mmUp === "SPOT";
    let stFut = futOn && mmUp === "FUTURES";
    if (mmUp === "AUTO") {
      if (futOn) {
        stFut = true;
        stSpot = false;
      } else if (spotOn) {
        stSpot = true;
        stFut = false;
      }
    }
    return stSpot || stFut;
  }

  function autoMultiMaxOpenPositions() {
    const n = Number(process.env.AUTO_MULTI_MAX_OPEN_POSITIONS);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    return Math.max(1, Math.floor(Number(state.maxConcurrentPositions) || 3));
  }

  function autoMultiWatchSize() {
    const n = Number(process.env.AUTO_MULTI_WATCH_SIZE);
    if (Number.isFinite(n) && n >= 1) return Math.min(80, Math.floor(n));
    return 15;
  }

  function autoMultiSlotPct() {
    return clamp(Number(process.env.AUTO_MULTI_SLOT_PCT ?? 0.3), 0.05, 0.95);
  }

  /** Distinct symbols with an open position on the given venue (SPOT rows vs non-SPOT futures). */
  function distinctOpenSymbolsForVenue(positions, venueSpot) {
    const rows = Array.isArray(positions) ? positions : [];
    const set = new Set();
    for (const p of rows) {
      const sym = String(p?.symbol || "").toUpperCase();
      const q = Number(p?.qty);
      if (!sym || !Number.isFinite(q) || q <= 0) continue;
      const isSpot = !p.venue || String(p.venue).toUpperCase() === "SPOT";
      if (venueSpot && isSpot) set.add(sym);
      if (!venueSpot && !isSpot) set.add(sym);
    }
    return set;
  }

  /** k-th new slot (k=0 first): slotPct * (1-slotPct)^k * freeQuote */
  function autoMultiQuoteSpendForSlot(freeQuote, openDistinctCount) {
    const free = Number(freeQuote);
    if (!Number.isFinite(free) || free <= 0) return 0;
    const slot = autoMultiSlotPct();
    const k = Math.max(0, Math.floor(openDistinctCount));
    return free * slot * Math.pow(1 - slot, k);
  }

  /**
   * Evaluate the last **fully closed** candle in `closedRaw` (no forming bar) for Supertrend bar-close autotrade alignment.
   * @returns {null | { cTs: number, allowBuy: boolean, allowSell: boolean, row: object, decisionSnapshotBar: object, supertrendStrength01: number | null, closedRaw: array }}
   */
  function evaluateSupertrendLastClosedBar(closedRaw) {
    const raw = Array.isArray(closedRaw) ? closedRaw : [];
    if (raw.length < Math.max(30, state.supertrendPeriod + 2)) return null;
    const cTs = Number(raw[raw.length - 1]?.ts);
    if (!Number.isFinite(cTs)) return null;

    const strictChartAlign = String(process.env.SUPERTREND_STRICT_CHART_ALIGN ?? "true").toLowerCase() !== "false";
    const clean = sanitizeCandlesForSt(raw, state.symbol);
    const idxC = clean.findIndex((c) => Number(c.ts) === cTs);
    const opts = {
      period: state.supertrendPeriod,
      multiplier: state.supertrendMultiplier,
      wilderAtr: state.supertrendWilderAtr,
    };
    const series = computeSupertrendSeries(clean, opts);
    const row = idxC >= 0 ? series[idxC] : null;

    const chartVisible =
      idxC >= 0 && row?.ready
        ? chartMarkerVisibleForBar({
            clean,
            series,
            barIndex: idxC,
            timeframe: state.timeframe,
            nowMs: Date.now(),
          })
        : false;
    const allowBuy = Boolean(row?.buySignal) && (!strictChartAlign || chartVisible);
    const allowSell = Boolean(row?.sellSignal) && (!strictChartAlign || chartVisible);

    const strengthBar = idxC >= 0 ? clean[idxC] : null;
    const supertrendStrength01 =
      row?.ready && strengthBar
        ? computeSupertrendSignalStrength01({
            row,
            candle: strengthBar,
            multiplier: state.supertrendMultiplier,
          })
        : null;

    if (!row?.ready || Number(row.ts) !== cTs || idxC < 0) {
      return null;
    }

    const indicatorsBarClose = computeIndicators(raw);
    const decisionSnapshotBar = computeDecisionSnapshot({
      candles: raw,
      indicatorsLatest: indicatorsBarClose.latest,
      supertrendLastRow: row,
      symbol: state.symbol,
      supertrendOpts: {
        period: state.supertrendPeriod,
        multiplier: state.supertrendMultiplier,
        wilderAtr: state.supertrendWilderAtr,
      },
    });

    return {
      cTs,
      allowBuy,
      allowSell,
      row,
      decisionSnapshotBar,
      supertrendStrength01,
      closedRaw: raw,
    };
  }

  let autoMultiSweepInFlight = false;

  async function runAutoMultiUnpinnedSweep(hub) {
    if (!hub || autoMultiSweepInFlight) return;
    const mm = String(state.marketMode).toUpperCase();
    if (!autoMultiUnpinnedActive(mm)) return;
    autoMultiSweepInFlight = true;
    try {
      const spotOn = Boolean(state.supertrendSpotAuto);
      const futOn = Boolean(state.supertrendFuturesAuto);
      let stSpot = spotOn && mm === "SPOT";
      let stFut = futOn && mm === "FUTURES";
      if (mm === "AUTO") {
        if (futOn) {
          stFut = true;
          stSpot = false;
        } else if (spotOn) {
          stSpot = true;
          stFut = false;
        }
      }
      const venueSpot = stSpot && !stFut;

      const snap = state.universe;
      const selectedSyms = Array.isArray(snap?.selected) && snap.selected.length ? snap.selected : [];
      const rankedSyms = Array.isArray(snap?.ranked) ? snap.ranked.map((r) => r?.symbol).filter(Boolean) : [];
      const candidatesRaw = selectedSyms.length ? selectedSyms : rankedSyms;
      const watchN = autoMultiWatchSize();
      const candidates = [...new Set(candidatesRaw.map((s) => String(s).toUpperCase()).filter(Boolean))].slice(
        0,
        watchN,
      );
      if (!candidates.length) return;

      let positions = _cachedPositions || [];
      try {
        positions = await exch.getPositions();
        _cachedPositions = positions;
      } catch {
        /* use cache */
      }
      const openSyms = distinctOpenSymbolsForVenue(positions, venueSpot);
      const maxOpen = autoMultiMaxOpenPositions();

      let acct = null;
      try {
        acct = await exch.getAccount();
      } catch {
        /* no spend sizing */
      }

      async function refreshOpenSymsAfterTrade() {
        try {
          positions = await exch.getPositions();
          _cachedPositions = positions;
        } catch {
          /* keep */
        }
        openSyms.clear();
        for (const s of distinctOpenSymbolsForVenue(positions, venueSpot)) openSyms.add(s);
      }

      const klineLimit = Math.max(
        120,
        Math.min(1000, Number(process.env.AUTO_MULTI_KLINES_LIMIT ?? 450)),
      );

      for (const sym of candidates) {
        if (!state.running) break;
        const symU = String(sym).toUpperCase();
        let rows;
        try {
          rows = await fetchBinanceKlinesRows({
            symbol: symU,
            interval: state.timeframe,
            limit: klineLimit,
          });
        } catch (e) {
          log.warn("auto_multi_klines_failed", { symbol: symU, error: String(e?.message || e) });
          continue;
        }
        const closedRaw = rows.length >= 2 ? rows.slice(0, -1) : rows;
        const ev = evaluateSupertrendLastClosedBar(closedRaw);
        if (!ev) continue;
        const { cTs, allowBuy, allowSell, decisionSnapshotBar, supertrendStrength01, closedRaw: cr } = ev;
        if (Number(state.autoMultiLastSeenBarTs[symU]) === cTs) continue;
        if (!allowBuy && !allowSell) {
          state.autoMultiLastSeenBarTs[symU] = cTs;
          continue;
        }

        const hubLocal = hub;
        const strategyKey = "SUPERTREND";

        const { aiGateBuy: aiGbSweep, aiGateSell: aiGsSweep } = await resolveSupertrendBarCloseAiGatesNoLastAi(cr, symU);
        const histSide = allowBuy ? "BUY" : "SELL";
        const ssHist = decisionSnapshotBar.signalStrength;
        mergeSupertrendSignalHistoryFromAutoMulti(
          {
            ts: Number(cTs),
            side: histSide,
            symbol: symU,
            timeframe: String(state.timeframe),
            aiGate: allowBuy
              ? aiGbSweep != null && Number.isFinite(Number(aiGbSweep))
                ? Number(aiGbSweep)
                : null
              : aiGsSweep != null && Number.isFinite(Number(aiGsSweep))
                ? Number(aiGsSweep)
                : null,
            strength:
              ssHist?.strength != null && Number.isFinite(Number(ssHist.strength)) ? Number(ssHist.strength) : null,
            stAction: ssHist?.action != null ? String(ssHist.action) : null,
          },
          hubLocal,
        );

        if (allowSell && allowBuy) {
          hubLocal?.broadcast?.("log", {
            level: "warn",
            msg: "AUTO multi: both BUY and SELL on same closed bar — executing SELL before BUY",
            symbol: symU,
          });
        }

        /** SELL first (flip / exit) when both or when bearish close with a position */
        if (allowSell && stSpot) {
          const hasSpot = openSyms.has(symU);
          if (hasSpot) {
            const sellRes = await trySupertrendSpotOrder({
              side: "SELL",
              strategyKey,
              wsHub: hubLocal,
              indicatorFullCapital: true,
              dedupeKey: `AUTO:${symU}:${cTs}:SELL`,
              decisionSnapshot: decisionSnapshotBar,
              tradeSymbol: symU,
              candlesOverride: cr,
              fixedQuoteSpendUsdt: null,
              multiUnpinnedOrder: true,
            });
            emitSupertrendSignalFeedback(hubLocal, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
            if (sellRes?.action === "placed") {
              await pushImmediateState(hubLocal);
              await refreshOpenSymsAfterTrade();
            }
          }
        }
        if (allowSell && stFut) {
          const sellRes = await trySupertrendFuturesOrder({
            side: "SELL",
            strategyKey,
            wsHub: hubLocal,
            dedupeKey: `AUTO:${symU}:${cTs}:FUT:SELL`,
            signalStrength: supertrendStrength01,
            decisionSnapshot: decisionSnapshotBar,
            tradeSymbol: symU,
            candlesOverride: cr,
            multiUnpinnedOrder: true,
            aiPredictNoLastAi: true,
          });
          emitSupertrendSignalFeedback(hubLocal, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
          if (sellRes?.action === "placed") {
            await pushImmediateState(hubLocal);
            await refreshOpenSymsAfterTrade();
          }
        }

        let spendQuote = 0;
        if (allowBuy && stSpot) {
          try {
            acct = await exch.getAccount();
          } catch {
            /* ignore */
          }
          const freeNow = Number(acct?.freeBalance ?? acct?.equity ?? 0);
          spendQuote =
            Number.isFinite(freeNow) && freeNow > 0
              ? autoMultiQuoteSpendForSlot(freeNow, openSyms.size)
              : 0;
        }

        if (allowBuy && stSpot) {
          if (openSyms.has(symU)) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          if (openSyms.size >= maxOpen) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          if (!(Number.isFinite(spendQuote) && spendQuote > 0)) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          const buyRes = await trySupertrendSpotOrder({
            side: "BUY",
            strategyKey,
            wsHub: hubLocal,
            indicatorFullCapital: false,
            dedupeKey: `AUTO:${symU}:${cTs}:BUY`,
            decisionSnapshot: decisionSnapshotBar,
            tradeSymbol: symU,
            candlesOverride: cr,
            fixedQuoteSpendUsdt: spendQuote,
            multiUnpinnedOrder: true,
          });
          emitSupertrendSignalFeedback(hubLocal, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
          if (buyRes?.action === "placed") {
            await pushImmediateState(hubLocal);
            try {
              acct = await exch.getAccount();
            } catch {
              /* ignore */
            }
            await refreshOpenSymsAfterTrade();
          }
        }

        if (allowBuy && stFut) {
          try {
            positions = await exch.getPositions();
            _cachedPositions = positions;
          } catch {
            /* keep */
          }
          const symPos = (Array.isArray(positions) ? positions : []).filter(
            (p) => String(p?.symbol || "").toUpperCase() === symU && String(p?.venue || "").toUpperCase() !== "SPOT",
          ).filter((p) => Number(p?.qty) > 0);
          const longHere = symPos.filter((p) => p.side === "BUY");
          const shortHereSweep = symPos.filter((p) => p.side === "SELL");
          if (longHere.length > 0) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          if (shortHereSweep.length > 0 && state.supertrendFuturesTwoWay !== true) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          if (openSyms.size >= maxOpen && !openSyms.has(symU)) {
            state.autoMultiLastSeenBarTs[symU] = cTs;
            continue;
          }
          try {
            acct = await exch.getAccount();
          } catch {
            /* ignore */
          }
          const freeFut = Number(acct?.freeBalance ?? acct?.equity ?? 0);
          const maxNotionalUsd =
            Number.isFinite(freeFut) && freeFut > 0
              ? autoMultiQuoteSpendForSlot(freeFut, openSyms.size)
              : null;
          const buyRes = await trySupertrendFuturesOrder({
            side: "BUY",
            strategyKey,
            wsHub: hubLocal,
            dedupeKey: `AUTO:${symU}:${cTs}:FUT:BUY`,
            signalStrength: supertrendStrength01,
            decisionSnapshot: decisionSnapshotBar,
            tradeSymbol: symU,
            candlesOverride: cr,
            multiUnpinnedOrder: true,
            aiPredictNoLastAi: true,
            maxNotionalUsd: Number.isFinite(maxNotionalUsd) && maxNotionalUsd > 0 ? maxNotionalUsd : null,
          });
          emitSupertrendSignalFeedback(hubLocal, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
          if (buyRes?.action === "placed") {
            await pushImmediateState(hubLocal);
            try {
              acct = await exch.getAccount();
            } catch {
              /* ignore */
            }
            await refreshOpenSymsAfterTrade();
          }
        }

        state.autoMultiLastSeenBarTs[symU] = cTs;
      }
    } finally {
      autoMultiSweepInFlight = false;
    }
  }

  async function processSupertrendCandleClose(candle) {
    if (!marketFeedUsesLiveBinance()) return;
    if (String(candle.symbol || "").toUpperCase() !== String(state.symbol).toUpperCase()) return;

    const mm = String(state.marketMode).toUpperCase();
    if (autoMultiUnpinnedActive(mm)) {
      return;
    }
    const spotOn = Boolean(state.supertrendSpotAuto);
    const futOn = Boolean(state.supertrendFuturesAuto);
    let stSpot = spotOn && mm === "SPOT";
    let stFut = futOn && mm === "FUTURES";
    /** AUTO previously disabled both flags — route Supertrend to the venue whose autotrade toggle is on. */
    if (mm === "AUTO") {
      if (futOn) {
        stFut = true;
        stSpot = false;
      } else if (spotOn) {
        stSpot = true;
        stFut = false;
      }
    }

    const rawCandles = feed.getCandles();
    const cTs = Number(candle.ts);
    if (!Number.isFinite(cTs)) return;

    const strictChartAlign = String(process.env.SUPERTREND_STRICT_CHART_ALIGN ?? "true").toLowerCase() !== "false";

    const clean = sanitizeCandlesForSt(rawCandles, state.symbol);
    const idxC = clean.findIndex((c) => Number(c.ts) === cTs);
    const opts = {
      period: state.supertrendPeriod,
      multiplier: state.supertrendMultiplier,
      wilderAtr: state.supertrendWilderAtr,
    };
    const series = computeSupertrendSeries(clean, opts);
    const row = idxC >= 0 ? series[idxC] : null;

    const chartVisible =
      idxC >= 0 && row?.ready
        ? chartMarkerVisibleForBar({
            clean,
            series,
            barIndex: idxC,
            timeframe: state.timeframe,
            nowMs: Date.now(),
          })
        : false;
    const allowBuy = Boolean(row?.buySignal) && (!strictChartAlign || chartVisible);
    const allowSell = Boolean(row?.sellSignal) && (!strictChartAlign || chartVisible);

    const strengthBar = idxC >= 0 ? clean[idxC] : null;
    const supertrendStrength01 =
      row?.ready && strengthBar
        ? computeSupertrendSignalStrength01({
            row,
            candle: strengthBar,
            multiplier: state.supertrendMultiplier,
          })
        : null;

    if (!row?.ready || Number(row.ts) !== cTs || idxC < 0) {
      log.warn("supertrend_close_bar_mismatch", {
        symbol: state.symbol,
        cTs,
        rowTs: row?.ts,
        idxC,
        bufLen: clean.length,
        rawBufLen: rawCandles?.length ?? 0,
        stSpot,
        stFut,
      });
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: "SUPERTREND",
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: "—",
          action: "skipped",
          reason: "bar_close_not_ready_buffer_mismatch",
        });
      }
      return;
    }

    const barCloseKey = `${String(state.symbol).toUpperCase()}:${cTs}`;
    if (state.supertrendStHandledCloseKey === barCloseKey) {
      if ((allowBuy || allowSell) && wsHubRef) {
        const sideLabel = allowBuy ? "BUY" : "SELL";
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: "SUPERTREND",
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: sideLabel,
          action: "skipped",
          reason: "duplicate_bar_close",
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      return;
    }

    state.supertrendLast = { ts: row.ts, up: row.up, dn: row.dn, trend: row.trend, line: row.line };
    state.supertrendLastClosedTs = row.ts;

    const indicatorsBarClose = computeIndicators(rawCandles);
    const decisionSnapshotBar = computeDecisionSnapshot({
      candles: rawCandles,
      indicatorsLatest: indicatorsBarClose.latest,
      supertrendLastRow: row,
      symbol: state.symbol,
      supertrendOpts: {
        period: state.supertrendPeriod,
        multiplier: state.supertrendMultiplier,
        wilderAtr: state.supertrendWilderAtr,
      },
    });

    const { aiGateBuy, aiGateSell } = await resolveSupertrendBarCloseAiGates(rawCandles);

    state.supertrendLastBarClose = {
      ts: Number(row.ts),
      /** Chart-aligned: only true when autotrade may act on this bar (see SUPERTREND_STRICT_CHART_ALIGN). */
      buySignal: allowBuy === true,
      sellSignal: allowSell === true,
      /** After this bar's close: +1 long, -1 short (no flip ≠ no position — see Activity). */
      trend: row.trend != null && Number.isFinite(Number(row.trend)) ? Number(row.trend) : null,
      supertrendStrength01,
      signalStrengthDecision: decisionSnapshotBar.signalStrength ?? null,
      chartStrict: strictChartAlign,
      decisionLong: decisionSnapshotBar.long?.total ?? null,
      decisionShort: decisionSnapshotBar.short?.total ?? null,
      decisionMaxLong: decisionSnapshotBar.long?.max ?? null,
      decisionMaxShort: decisionSnapshotBar.short?.max ?? null,
      /** AI gate at this bar: long model (BUY / 1-way entry); short model (SELL opening short in 2-way), if trained. */
      aiGateBuy,
      aiGateSell,
      expectedMoveLong: decisionSnapshotBar.expectedMoveLong ?? null,
      expectedMoveShort: decisionSnapshotBar.expectedMoveShort ?? null,
    };
    if (allowBuy || allowSell) {
      state.supertrendLastFlipBarClose = { ...state.supertrendLastBarClose };
      const side = allowBuy ? "BUY" : "SELL";
      const ss = decisionSnapshotBar.signalStrength;
      const entry = {
        ts: Number(row.ts),
        side,
        symbol: String(state.symbol).toUpperCase(),
        timeframe: String(state.timeframe),
        aiGate: allowBuy
          ? aiGateBuy != null && Number.isFinite(Number(aiGateBuy))
            ? Number(aiGateBuy)
            : null
          : aiGateSell != null && Number.isFinite(Number(aiGateSell))
            ? Number(aiGateSell)
            : null,
        strength: ss?.strength != null && Number.isFinite(Number(ss.strength)) ? Number(ss.strength) : null,
        stAction: ss?.action != null ? String(ss.action) : null,
      };
      appendSupertrendSignalHistoryEntry(entry);
      const prev = Array.isArray(state.supertrendSignalHistory) ? state.supertrendSignalHistory : [];
      const symH = String(entry.symbol).toUpperCase();
      const filt = prev.filter(
        (e) =>
          !(
            Number(e?.ts) === entry.ts &&
            e?.side === entry.side &&
            String(e?.symbol || symH).toUpperCase() === symH
          ),
      );
      filt.push({
        ts: entry.ts,
        side: entry.side,
        symbol: symH,
        timeframe: String(entry.timeframe),
        aiGate: entry.aiGate,
        strength: entry.strength,
        stAction: entry.stAction,
      });
      filt.sort((a, b) => Number(a.ts) - Number(b.ts));
      state.supertrendSignalHistory = filt.slice(-SUPERTREND_SIGNAL_STATE_MAX);
      persistTradingConfigToDisk();
    }
    if (wsHubRef) {
      wsHubRef.broadcast("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
      });
    }

    if (!(row.buySignal || row.sellSignal)) return;

    if (strictChartAlign && (row.buySignal || row.sellSignal) && !allowBuy && !allowSell) {
      state.supertrendStHandledCloseKey = barCloseKey;
      return;
    }

    if (!stSpot && !stFut) {
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: "SUPERTREND",
          venue: "—",
          side: allowBuy ? "BUY" : "SELL",
          action: "skipped",
          reason: "supertrend_autotrade_off_or_market_mode_mismatch",
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      return;
    }

    if (state.running && state.feedExecutionPause && (allowBuy || allowSell)) {
      state.supertrendStHandledCloseKey = barCloseKey;
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: "SUPERTREND",
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: allowBuy ? "BUY" : "SELL",
          action: "skipped",
          reason: `feed_paused:${state.feedExecutionPause.reason}`,
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      return;
    }

    if (!state.running) {
      const rowTs = Number(row.ts);
      state.pendingSupertrendAction = {
        side: allowBuy ? "BUY" : "SELL",
        symbol: String(state.symbol).toUpperCase(),
        barTs: rowTs,
        barCloseKey,
        venue: stSpot ? "SPOT" : "FUTURES",
        dedupeKeyBuy: stSpot && allowBuy ? `${rowTs}:BUY` : null,
        dedupeKeyBuyFut: stFut && allowBuy ? `${rowTs}:FUT:BUY` : null,
        dedupeKeySellSpot: stSpot && allowSell ? `${rowTs}:SELL` : null,
        dedupeKeySellFut: stFut && allowSell ? `${rowTs}:FUT:SELL` : null,
      };
      state.supertrendStHandledCloseKey = barCloseKey;
      if (wsHubRef) {
        emitSupertrendSignalFeedback(wsHubRef, {
          venue: stSpot ? "SPOT" : "FUTURES",
          side: allowBuy ? "BUY" : "SELL",
          action: "pending",
          reason: "queued — runs when bot starts",
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      return;
    }

    const hub = wsHubRef;
    if (!hub) return;

    const symTrade = String(state.symbol || "").trim().toUpperCase();
    if (idxC > 0 && symTrade) {
      const prevB = clean[idxC - 1];
      const curB = clean[idxC];
      const prevC = Number(prevB?.close);
      const cl = Number(curB?.close);
      const lo = Number(curB?.low);
      if (
        Number.isFinite(prevC) &&
        prevC > 0 &&
        Number.isFinite(cl) &&
        !isPlausibleCandleClose(symTrade, cl, lo, prevC)
      ) {
        log.warn("supertrend_autotrade_blocked_implausible_bar_step", {
          symbol: symTrade,
          prevClose: prevC,
          close: cl,
          barTs: cTs,
        });
        state.supertrendStHandledCloseKey = barCloseKey;
        emitSignalActionActivity(hub, {
          kind: "supertrend",
          strategyKey: "SUPERTREND",
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: allowBuy ? "BUY" : allowSell ? "SELL" : "—",
          action: "skipped",
          reason: "implausible_close_step_vs_prior_sanitized_bar",
        });
        return;
      }
    }

    state.supertrendStHandledCloseKey = barCloseKey;

    if (allowBuy) {
      let buyRes;
      if (stSpot) {
        buyRes = await trySupertrendSpotOrder({
          side: "BUY",
          strategyKey: "SUPERTREND",
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${Number(row.ts)}:BUY`,
          decisionSnapshot: decisionSnapshotBar,
        });
      } else {
        buyRes = await trySupertrendFuturesOrder({
          side: "BUY",
          strategyKey: "SUPERTREND",
          wsHub: hub,
          dedupeKey: `${Number(row.ts)}:FUT:BUY`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
        });
      }
      emitSupertrendSignalFeedback(hub, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
      if (buyRes?.action === "placed") await pushImmediateState(hub);
    }
    if (allowSell) {
      let sellRes;
      if (stSpot) {
        sellRes = await trySupertrendSpotOrder({
          side: "SELL",
          strategyKey: "SUPERTREND",
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${Number(row.ts)}:SELL`,
          decisionSnapshot: decisionSnapshotBar,
        });
      } else {
        sellRes = await trySupertrendFuturesOrder({
          side: "SELL",
          strategyKey: "SUPERTREND",
          wsHub: hub,
          dedupeKey: `${Number(row.ts)}:FUT:SELL`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
        });
      }
      emitSupertrendSignalFeedback(hub, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
      if (sellRes?.action === "placed") await pushImmediateState(hub);
    }
  }

  hydrateTradingConfigFromDisk();
  loadSupertrendSignalHistoryFromDisk();

  feed = createMarketFeed({
    log,
    symbol: state.symbol,
    timeframe: state.timeframe,
    onCandleClose: (c) => {
      void processSupertrendCandleClose(c);
    },
  });
  const depth = marketFeedUsesLiveBinance()
    ? createBinanceOrderBook({ log, symbol: state.symbol, wsBase: binanceDepthWsBase() })
    : null;
  const universe = createBinanceUniverse({ log });
  const cg = createCoinGeckoClient({ log });
  let lastSeenTradeId = null;
  /** Dedup CLOSE WS broadcasts — same id must not be emitted twice (duplicate rows / findIndex bug). */
  let ingestedCloseBroadcastKeys = new Set();
  let closedSinceRetrain = 0;
  let tickInFlight = false;
  let wsHubRef = null;

  function setWsHub(hub) {
    wsHubRef = hub || null;
  }
  let _cachedAccount = null;
  let _cachedPositions = [];
  let _lastAccountFetchAt = 0;
  let _lastStrictAccountWarnAt = 0;
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
    const confident =
      isFixedUsdtCapitalMode() || p >= Number(state.aiThreshold || 0.4) + 0.05;
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
   * @param {string} [unit] `"PCT"` = compare daily PnL % to limit; `"USDT"` = compare PnL USD to limit.
   */
  function computeDailyVenueLoss(account, maxDailyLossLimit, unit = "PCT") {
    const MIN_START = 10;
    const dayKey = utcDayKey();
    const isUsdt = String(unit || "PCT").toUpperCase() === "USDT";
    const limit = Math.abs(Number(maxDailyLossLimit));
    const venues = account?.venues;

    if (!venues || (!venues.spot && !venues.futures)) {
      const pct = Number(account?.dailyPnlPct ?? 0);
      if (isUsdt) {
        const start = Number(account?.dailyStartEquity);
        const eq = Number(account?.equity ?? account?.freeBalance);
        let dailyPnlUsd = null;
        let exceeded = false;
        if (Number.isFinite(start) && start >= MIN_START && Number.isFinite(eq)) {
          dailyPnlUsd = eq - start;
          exceeded = dailyPnlUsd <= -limit;
        }
        return {
          dailyPnlPctByVenue: null,
          dailyPnlUsdByVenue: null,
          dailyPnlPctWorst: Number.isFinite(dailyPnlUsd) && start > 0 ? dailyPnlUsd / start : pct,
          dailyPnlUsdWorst: dailyPnlUsd,
          exceeded,
        };
      }
      return {
        dailyPnlPctByVenue: null,
        dailyPnlUsdByVenue: null,
        dailyPnlPctWorst: pct,
        dailyPnlUsdWorst: null,
        exceeded: pct <= -limit,
      };
    }

    if (!state.dailyVenueBaseline || typeof state.dailyVenueBaseline !== "object") state.dailyVenueBaseline = {};

    const dailyPnlPctByVenue = {};
    const dailyPnlUsdByVenue = {};
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
        dailyPnlUsdByVenue[key] = 0;
        continue;
      }
      dailyPnlPctByVenue[key] = (eq - start) / start;
      dailyPnlUsdByVenue[key] = eq - start;
    }

    const pctVals = Object.values(dailyPnlPctByVenue).filter((x) => Number.isFinite(x));
    const dailyPnlPctWorst = pctVals.length ? Math.min(...pctVals) : 0;
    const usdVals = Object.values(dailyPnlUsdByVenue).filter((x) => Number.isFinite(x));
    const dailyPnlUsdWorst = usdVals.length ? Math.min(...usdVals) : null;

    let exceeded;
    if (isUsdt) {
      exceeded = ["spot", "futures"].some((k) => {
        const usd = dailyPnlUsdByVenue[k];
        const start = state.dailyVenueBaseline[k]?.startEquity;
        return Number(start) >= MIN_START && Number.isFinite(usd) && usd <= -limit;
      });
    } else {
      const threshold = -limit;
      exceeded = ["spot", "futures"].some((k) => {
        const p = dailyPnlPctByVenue[k];
        if (p == null || !Number.isFinite(p)) return false;
        const start = state.dailyVenueBaseline[k]?.startEquity;
        return Number(start) >= MIN_START && p <= threshold;
      });
    }

    return { dailyPnlPctByVenue, dailyPnlUsdByVenue, dailyPnlPctWorst, dailyPnlUsdWorst, exceeded };
  }

  const BOT_TICK_MS = Math.max(500, Math.min(10_000, Number(process.env.BOT_TICK_MS || 1000)));
  setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    tick({ wsHub: wsHubRef })
      .catch((e) => log.warn("tick_error", { error: String(e?.message || e) }))
      .finally(() => { tickInFlight = false; });
  }, BOT_TICK_MS);
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
    if (!marketFeedUsesLiveBinance()) return;
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
        wsHubRef?.broadcast?.("state", { mode: runtimeTradingMode(), ...getPublicState(), account: acct, positions: pos });

        const pinSym = state.universePinnedSymbol ? String(state.universePinnedSymbol).toUpperCase() : "";
        if (pinSym) {
          if (String(state.symbol).toUpperCase() !== pinSym) {
            state.symbol = pinSym;
            state.supertrendStHandledCloseKey = null;
            state.coinLastSwitchedAt = Date.now();
            feed.setSymbol(pinSym);
            try {
              depth?.setSymbol?.(pinSym);
            } catch {
              // ignore
            }
            wsHubRef?.broadcast?.("log", {
              level: "info",
              msg: "Universe pin: trading symbol locked",
              symbol: pinSym,
            });
          }
          return;
        }

        const mmScan = String(state.marketMode || "AUTO").toUpperCase();
        if (autoMultiUnpinnedActive(mmScan)) {
          await runAutoMultiUnpinnedSweep(wsHubRef);
          return;
        }

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
        state.supertrendStHandledCloseKey = null;
        state.universeLastPick = { ts: new Date().toISOString(), symbol: best };
        state.coinLastSwitchedAt = Date.now();
        feed.setSymbol(best);
        try {
          depth?.setSymbol?.(best);
        } catch {
          // ignore
        }
        wsHubRef?.broadcast?.("log", { level: "info", msg: "Auto-selected coin", symbol: best });
        if (wsHubRef) {
          queueMicrotask(() => {
            tick({ wsHub: wsHubRef }).catch((e) =>
              log.warn("universe_tick_flush_failed", { error: String(e?.message || e) }),
            );
          });
        }
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

  function getChartCandles(opts = {}) {
    const hours = Math.max(0.25, Number(opts.hours ?? 24));
    const raw = feed.getCandles() || [];
    const n = maxBarsForHistory(state.timeframe, hours);
    return raw.length <= n ? raw.slice() : raw.slice(-n);
  }

  /**
   * One computeSupertrendSeries pass: Pine/TV-aligned line + buy/sell shapes.
   * Signals include the **open** (last) bar so markers fire intrabar when `close` crosses bands (realtime).
   * Autotrade in `processSupertrendCandleClose` still runs only on kline close (k.x).
   */
  /**
   * @param {boolean} [opts.withChartArrays=true] If false, skips building full `line` / `signals` (1000s of points).
   *        Tick still needs `lastRow` for decisions; chart arrays are omitted from high-frequency WS to cut bandwidth/CPU.
   */
  function computeSupertrendChartModel(chartCandles, opts = {}) {
    const withChartArrays = opts.withChartArrays !== false;
    const empty = { line: null, signals: [], lastRow: null };
    if (!chartCandles?.length) return empty;
    const clean = sanitizeCandlesForSt(chartCandles, state.symbol);
    if (clean.length < Math.max(2, state.supertrendPeriod)) return empty;
    const stOpts = {
      period: state.supertrendPeriod,
      multiplier: state.supertrendMultiplier,
      wilderAtr: state.supertrendWilderAtr,
    };
    const stSer = computeSupertrendSeries(clean, stOpts);
    if (!withChartArrays) {
      const lastRowFast = stSer[stSer.length - 1];
      const lastReady = lastRowFast?.ready ? lastRowFast : null;
      return { line: [], signals: [], lastRow: lastReady };
    }
    const lineRaw = stSer
      .filter((r) => {
        if (!r.ready || r.line == null) return false;
        const v = Number(r.line);
        return Number.isFinite(v) && v > 0;
      })
      .map((r) => ({
        time: Math.floor(Number(r.ts) / 1000),
        value: Number(r.line),
      }));
    /** Drop only obvious single-point spikes (bad tick); UI uses a separate Y scale for ST vs candles. */
    const line = (() => {
      const out = lineRaw.slice();
      while (out.length >= 2) {
        const a = out[out.length - 2].value;
        const b = out[out.length - 1].value;
        if (a > 0 && b > 0 && (b / a > 120 || a / b > 120)) out.pop();
        else break;
      }
      return out;
    })();
    /** Chart markers only on completed bars — including the forming bar retriggers buy/sell every tick as close wiggles (marker spam). Intrabar autotrade still uses `lastRow` in `tick` / kline close handler. */
    const signals = [];
    const lastClosedIdx = stSer.length - 2;
    for (let i = 0; i < stSer.length; i++) {
      const r = stSer[i];
      if (!r.ready) continue;
      if (i > lastClosedIdx) continue;
      const t = Math.floor(Number(r.ts) / 1000);
      if (r.buySignal) signals.push({ time: t, side: "buy" });
      if (r.sellSignal) signals.push({ time: t, side: "sell" });
    }
    const lastRow = stSer[stSer.length - 1];
    const lastReady = lastRow?.ready ? lastRow : null;
    return { line, signals, lastRow: lastReady };
  }

  function getChartSnapshot(opts = {}) {
    const hours = Math.max(0.25, Number(opts.hours ?? 24));
    const raw = getChartCandles({ hours });
    const candles = sanitizeCandlesForSt(raw, state.symbol);
    const st = computeSupertrendChartModel(candles);
    return {
      symbol: state.symbol,
      timeframe: state.timeframe,
      hours,
      candles,
      supertrendLine: st.line,
      supertrendSignals: st.signals,
      supertrend: st.lastRow
        ? {
            ts: st.lastRow.ts,
            up: st.lastRow.up,
            dn: st.lastRow.dn,
            trend: st.lastRow.trend,
            line: st.lastRow.line,
          }
        : null,
    };
  }

  function getPublicState() {
    return {
      running: state.running,
      symbol: state.symbol,
      timeframe: state.timeframe,
      symbolMode: state.symbolMode,
      aiThreshold: state.aiThreshold,
      riskPerTrade: state.riskPerTrade,
      maxDailyLoss: state.maxDailyLoss,
      riskPerTradeUnit: state.riskPerTradeUnit === "USDT" ? "USDT" : "PCT",
      maxDailyLossUnit: state.maxDailyLossUnit === "USDT" ? "USDT" : "PCT",
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
      universePinnedSymbol: state.universePinnedSymbol,
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
      supertrendSpotAuto: state.supertrendSpotAuto,
      supertrendFuturesAuto: state.supertrendFuturesAuto,
      supertrendFuturesAiConfidenceFilter: state.supertrendFuturesAiConfidenceFilter,
      signalStrengthGatesTrades: state.signalStrengthGatesTrades === true,
      signalStrengthOpenMin: clamp(Math.round(Number(state.signalStrengthOpenMin ?? 65)), 0, 100),
      supertrendFuturesMinAiProb: clamp(Number(state.supertrendFuturesMinAiProb ?? 0.55), 0, 1),
      supertrendFuturesFixedSlPct: clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2),
      supertrendFuturesFixedTpPct: clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5),
      supertrendFuturesTwoWay: state.supertrendFuturesTwoWay === true,
      supertrendPeriod: state.supertrendPeriod,
      supertrendMultiplier: state.supertrendMultiplier,
      supertrendWilderAtr: state.supertrendWilderAtr,
      supertrendLast: state.supertrendLast,
      supertrendLastBarClose: state.supertrendLastBarClose,
      supertrendLastFlipBarClose: state.supertrendLastFlipBarClose,
      supertrendSignalHistory: Array.isArray(state.supertrendSignalHistory)
        ? state.supertrendSignalHistory.slice(-SUPERTREND_SIGNAL_STATE_MAX)
        : [],
      decisionEngine: state.decisionEngine,
      pendingSupertrendAction: state.pendingSupertrendAction,
      pendingAutoRestartAfterFeedStale: state.pendingAutoRestartAfterFeedStale,
      feedExecutionPause: state.feedExecutionPause,
      lastStopReason: state.lastStopReason,
      tradingFormDefaults: { ...state.tradingFormDefaults },
    };
  }

  function closeBroadcastKey(t) {
    if (t?.id != null && String(t.id) !== "") return `id:${String(t.id)}`;
    return `row:${String(t.ts)}|${String(t.symbol)}|${String(t.pnl)}|${String(t.price ?? t.exitPrice ?? "")}`;
  }

  async function ingestClosedTrades({ wsHub }) {
    const trades = await exch.getTrades();
    if (!trades.length) return;

    // Advance from last seen id using **last** occurrence — duplicate ids in the array would make
    // findIndex (first match) leave a duplicate tail that gets re-broadcast every tick.
    let startIdx = 0;
    if (lastSeenTradeId != null) {
      let idx = -1;
      for (let i = trades.length - 1; i >= 0; i--) {
        if (trades[i]?.id === lastSeenTradeId) {
          idx = i;
          break;
        }
      }
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
      const bkey = closeBroadcastKey(t);
      if (ingestedCloseBroadcastKeys.has(bkey)) continue;
      ingestedCloseBroadcastKeys.add(bkey);
      if (ingestedCloseBroadcastKeys.size > 12_000) {
        ingestedCloseBroadcastKeys = new Set([...ingestedCloseBroadcastKeys].slice(-6000));
      }
      wsHub?.broadcast("trade", enrichCloseTradeForHistory({ ...t }));

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

      // Drawdown tracking (skip if we don't have a real wallet equity — avoids fake zeros on failed Binance fetches)
      const acctIngest = await exch.getAccount().catch(() => null);
      const eqIngest = walletBaseFromAccount(acctIngest);
      if (eqIngest != null) {
        const equity = eqIngest;
        if (equity > (state.peakEquity || 0)) state.peakEquity = equity;
        if (state.peakEquity > 0) {
          const dd = (state.peakEquity - equity) / state.peakEquity;
          if (dd > (state.maxDrawdownPct || 0)) state.maxDrawdownPct = dd;
          const maxDDLimit = Number(process.env.MAX_DRAWDOWN_PCT || 0.15);
          if (dd >= maxDDLimit && state.running) {
            stop({
              wsHub,
              reason: "max_drawdown",
              source: "safety_ingest_trade",
              detail: {
                drawdownPct: roundTo(dd * 100, 2),
                limitPct: roundTo(maxDDLimit * 100, 2),
              },
            });
          }
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
        broadcastActivity(wsHub, {
          level: "info",
          msg: "Auto-retraining AI model from feedback…",
          category: "ai",
          reason: "retrain_scheduled",
          source: "ingest_closed_trades",
        });
        const r = await ai.retrainFromFeedback({ minRows });
        broadcastActivity(wsHub, {
          level: "info",
          msg: "AI retrain complete",
          category: "ai",
          reason: "retrain_ok",
          detail: r && typeof r === "object" ? r : { result: r },
        });
      } catch (e) {
        broadcastActivity(wsHub, {
          level: "warn",
          msg: "AI retrain failed",
          category: "ai",
          reason: "retrain_error",
          detail: { error: String(e?.message || e) },
        });
      }
    }
  }

  /** Refresh Portfolio (positions + account + trade tail) over WS right after Supertrend fills. */
  async function pushImmediateState(wsHub) {
    if (!wsHub?.broadcast) return;
    try {
      const strict = requiresStrictBinanceAccount();
      const account = await exch.getAccount().catch(() => null);
      let positions = [];
      if (account != null) {
        try {
          positions = await exch.getPositions();
        } catch (e) {
          if (strict) positions = [];
          else positions = [];
        }
      }
      if (!Array.isArray(positions)) positions = [];
      if (strict) {
        if (account == null) {
          _cachedAccount = null;
          _cachedPositions = [];
        } else {
          _cachedAccount = account;
          _cachedPositions = positions;
        }
      } else {
        _cachedAccount = account;
        _cachedPositions = positions;
      }
      _lastAccountFetchAt = Date.now();

      const lastC = feed.getCandles()?.at(-1);
      const markPrice = Number(lastC?.close ?? 0);
      const positionsMtM = _cachedPositions.map((p) => {
        if (p.venue === "FUTURES" && p.syncSource === "fapi_v2_account") {
          const apiUpnl = Number(p.unrealizedPnl ?? p.unrealizedProfit ?? 0);
          return { ...p, markPrice, unrealizedPnl: Number.isFinite(apiUpnl) ? apiUpnl : null };
        }
        const isLong = p.side === "BUY";
        if (p?.symbol !== state.symbol) {
          return { ...p, markPrice, unrealizedPnl: null };
        }
        const uPnl = isLong
          ? (markPrice - Number(p.entryPrice)) * Number(p.qty)
          : (Number(p.entryPrice) - markPrice) * Number(p.qty);
        return { ...p, markPrice, unrealizedPnl: uPnl };
      });
      const unrealizedPnl = positionsMtM.reduce((a, p) => a + Number(p.unrealizedPnl || 0), 0);
      const wBase = walletBaseFromAccount(account);
      const equityWithUnrealized = wBase != null ? wBase + unrealizedPnl : null;
      const dv =
        account == null
          ? { exceeded: false, dailyPnlPctWorst: undefined, dailyPnlPctByVenue: undefined }
          : computeDailyVenueLoss(account, state.maxDailyLoss, state.maxDailyLossUnit);
      const dailyPnlPctEff =
        account == null
          ? undefined
          : account?.venues?.spot || account?.venues?.futures
            ? dv.dailyPnlPctWorst
            : account?.dailyPnlPct ?? 0;

      const acctPayload =
        account == null
          ? null
          : {
              ...account,
              markPrice,
              unrealizedPnl,
              equityWithUnrealized,
              dailyPnlPct: dailyPnlPctEff,
              dailyPnlPctByVenue: dv.dailyPnlPctByVenue || undefined,
            };

      wsHub.broadcast("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: acctPayload,
        positions: positionsMtM,
      });

      if (strict && account == null) {
        wsHub.broadcast("trades_snapshot", { replace: true, trades: [] });
      } else {
        const recentTrades = await exch.getTrades().catch(() => []);
        const mergedTrades = filterStrictPortfolioTradesAfterMerge(
          runtimeTradingMode(),
          mergeTradesById(readTradeWsEvents(400), recentTrades || [])
        );
        if (mergedTrades.length) {
          wsHub.broadcast("trades_snapshot", { replace: true, trades: mergedTrades.slice(-80) });
        } else if (strict) {
          wsHub.broadcast("trades_snapshot", { replace: true, trades: [] });
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function tick({ wsHub }) {
    const candles = feed.getCandles();
    const last = candles[candles.length - 1];
    if (state._pendingSupertrendFlushOnNextTick && state.running) {
      if (last) {
        state._pendingSupertrendFlushOnNextTick = false;
        try {
          await flushPendingSupertrendOnStart(wsHub);
        } catch (e) {
          log.warn("pending_supertrend_flush_failed", { error: String(e?.message || e) });
        }
      }
    }
    if (!last) return;
    state.metrics.tickCount += 1;

    // Feed health affects **execution only** (see `feedExecutionPause`). Chart/regime/signals keep updating
    // from the candle buffer whenever we have a `last` candle.
    const feedStatus = feed.getStatus ? feed.getStatus() : null;
    const inGrace =
      state.coinLastSwitchedAt && Date.now() - Number(state.coinLastSwitchedAt) < Number(state.feedGraceMsAfterSwitch || 0);

    // After AUTO switches symbols, avoid using ticks from the old stream window (best-effort).
    if (
      state.coinLastSwitchedAt &&
      inGrace &&
      feedStatus?.lastMsgAt &&
      Number(feedStatus.lastMsgAt) < Number(state.coinLastSwitchedAt)
    ) {
      return;
    }
    const feedStaleMs = Math.max(15_000, Number(process.env.FEED_STALE_MS ?? 60_000));
    const freshestAt = freshestBinanceFeedMsgAt(feedStatus);
    const feedAutoRestartOn =
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "0" &&
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "false";

    if (
      !state.running &&
      state.pendingAutoRestartAfterFeedStale &&
      feedAutoRestartOn &&
      marketFeedUsesLiveBinance() &&
      feedStatus?.ok === true &&
      freshestAt != null &&
      Date.now() - freshestAt <= feedStaleMs
    ) {
      state.pendingAutoRestartAfterFeedStale = false;
      state.metrics.feedRecoveryRestarts += 1;
      start({
        wsHub,
        reason: "feed_recovery",
        source: "safety_tick",
        detail: {
          freshestMsgAt: freshestAt,
          thresholdMs: feedStaleMs,
          symbol: state.symbol,
        },
      });
      try {
        wsHub?.broadcast?.("state", {
          mode: runtimeTradingMode(),
          ...getPublicState(),
        });
      } catch {
        // ignore
      }
    }

    const feedUseBinance = marketFeedUsesLiveBinance();
    const wsUnhealthy = !inGrace && feedStatus?.ok === false;
    const dataStale =
      !inGrace &&
      feedUseBinance &&
      freshestAt != null &&
      Date.now() - freshestAt > feedStaleMs;
    const shouldPauseExecution = feedUseBinance && (wsUnhealthy || dataStale);

    if (shouldPauseExecution) {
      const reason = wsUnhealthy ? "feed_ws" : "feed_stale";
      const prev = state.feedExecutionPause;
      if (!prev || prev.reason !== reason) {
        state.feedExecutionPause = { reason, since: Date.now() };
        if (state.running) {
          broadcastActivity(wsHub, {
            level: "warn",
            msg:
              reason === "feed_ws"
                ? "Market WebSocket reconnecting — autotrade paused; chart still updates from candle buffer"
                : "Market data stale — autotrade paused until live ticks resume",
            category: "feed",
            reason,
            detail: {
              klineLastMsgAt: feedStatus?.lastMsgAt ?? null,
              aggTradeLastMsgAt: feedStatus?.delta?.lastMsgAt ?? null,
              freshestMsgAt: freshestAt,
              thresholdMs: feedStaleMs,
            },
          });
        }
        if (reason === "feed_stale" && (!prev || prev.reason !== "feed_stale")) {
          state.metrics.feedStaleStops += 1;
        }
        log.warn("feed_execution_paused", {
          symbol: state.symbol,
          pauseReason: reason,
          wsOk: feedStatus?.ok,
          freshestMsgAt: freshestAt,
          staleMs: freshestAt != null ? Date.now() - freshestAt : null,
        });
      }
    } else if (state.feedExecutionPause) {
      const had = state.feedExecutionPause;
      state.feedExecutionPause = null;
      if (state.running && had) {
        broadcastActivity(wsHub, {
          level: "info",
          msg: "Market feed healthy — autotrade eligible again",
          category: "feed",
          reason: "feed_recovered",
        });
      }
    }

    if (!state.feedExecutionPause) {
      await exch.markToMarket({ symbol: state.symbol, price: last.close });
    }
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
    const strictAcc = requiresStrictBinanceAccount();
    const nowMs = Date.now();
    if (nowMs - _lastAccountFetchAt >= ACCOUNT_FETCH_INTERVAL_MS || !_cachedAccount) {
      try {
        account = await exch.getAccount();
        if (account == null) {
          positions = [];
          _cachedAccount = null;
          _cachedPositions = [];
          if (strictAcc && nowMs - _lastStrictAccountWarnAt > 60_000) {
            _lastStrictAccountWarnAt = nowMs;
            broadcastActivity(wsHub, {
              level: "warn",
              msg: "Binance account unavailable — check API keys, IP whitelist, and permissions",
              category: "exchange",
              reason: "account_null",
            });
          }
        } else {
          try {
            positions = await exch.getPositions();
          } catch (e) {
            accountError = String(e?.message || e);
            positions = [];
            if (strictAcc) {
              account = null;
              _cachedAccount = null;
              _cachedPositions = [];
              broadcastActivity(wsHub, {
                level: "warn",
                msg: "Exchange positions unavailable",
                category: "exchange",
                reason: "positions_fetch_failed",
                detail: { error: accountError },
              });
            }
          }
          if (account != null && Array.isArray(positions)) {
            _cachedAccount = account;
            _cachedPositions = positions;
            if (strictAcc) _lastStrictAccountWarnAt = 0;
          }
        }
        _lastAccountFetchAt = nowMs;
      } catch (e) {
        accountError = String(e?.message || e);
        if (strictAcc) {
          _cachedAccount = null;
          _cachedPositions = [];
          account = null;
          positions = [];
          broadcastActivity(wsHub, {
            level: "warn",
            msg: "Exchange account/positions unavailable",
            category: "exchange",
            reason: "account_fetch_failed",
            detail: { error: accountError },
          });
        } else {
          account = _cachedAccount;
          positions = _cachedPositions;
        }
        _lastAccountFetchAt = nowMs;
      }
    }

    // Time-based exits (must run after positions are loaded — not before `let positions`)
    const maxPosAgeMs = Number(process.env.MAX_POSITION_AGE_MS || 0);
    if (
      maxPosAgeMs > 0 &&
      Array.isArray(positions) &&
      positions.length > 0 &&
      !state.feedExecutionPause
    ) {
      for (const p of positions) {
        const openedAt = p.openedAt || p.meta?.openedAt;
        if (!openedAt) continue;
        const ageMs = Date.now() - new Date(openedAt).getTime();
        if (ageMs > maxPosAgeMs) {
          try {
            await exch.closePosition?.({ id: p.id, price: last.close, reason: "TIME_EXIT" });
            broadcastActivity(wsHub, {
              level: "info",
              msg: `Time-based exit · ${String(p.symbol)}`,
              category: "position",
              reason: "time_exit",
              symbol: p.symbol,
              detail: { positionId: p.id, ageMs, maxAgeMs: maxPosAgeMs },
            });
          } catch {
            // will be caught next tick
          }
        }
      }
    }

    const markPrice = Number(last.close);
    const symU = String(state.symbol || "").toUpperCase();
    const prevK = candles.length >= 2 ? candles[candles.length - 2] : null;
    const prevKClose = prevK ? Number(prevK.close) : null;
    if (
      Number.isFinite(markPrice) &&
      markPrice > 0 &&
      !isPlausibleCandleClose(symU, markPrice, Number(last.low), prevKClose)
    ) {
      log.warn("market_broadcast_implausible_price", {
        symbol: state.symbol,
        close: markPrice,
        prevClose: prevKClose,
        feed: feed.getStatus?.() ?? null,
        tick: state.metrics?.tickCount,
      });
    }
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
    const wBaseTick = walletBaseFromAccount(account);
    const equityWithUnrealizedTick = wBaseTick != null ? wBaseTick + unrealizedPnl : null;

    const dv =
      account == null
        ? { exceeded: false, dailyPnlPctWorst: undefined, dailyPnlPctByVenue: undefined }
        : computeDailyVenueLoss(account, state.maxDailyLoss, state.maxDailyLossUnit);
    const dailyPnlPct =
      account == null
        ? undefined
        : account?.venues?.spot || account?.venues?.futures
          ? dv.dailyPnlPctWorst
          : account?.dailyPnlPct ?? 0;
    const dailyPnlPctByVenue = account == null ? undefined : dv.dailyPnlPctByVenue;
    const exceededDailyLoss = account == null ? false : dv.exceeded;

    const acctBroadcast =
      account == null
        ? null
        : {
            ...account,
            markPrice,
            unrealizedPnl,
            equityWithUnrealized: equityWithUnrealizedTick,
            accountError: accountError || undefined,
            dailyPnlPct,
            dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
          };

    if (exceededDailyLoss) {
      stop({
        wsHub,
        reason: "max_daily_loss",
        source: "safety_tick",
        detail: {
          dailyPnlPct,
          dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
        },
      });
      wsHub?.broadcast("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: acctBroadcast,
        positions: positionsMtM,
      });
      return;
    }

    const mmUp = String(state.marketMode).toUpperCase();
    const supertrendPausesAi =
      marketFeedUsesLiveBinance() &&
      ((mmUp === "SPOT" && Boolean(state.supertrendSpotAuto)) ||
        (mmUp === "FUTURES" && Boolean(state.supertrendFuturesAuto)) ||
        (mmUp === "AUTO" && (Boolean(state.supertrendSpotAuto) || Boolean(state.supertrendFuturesAuto))));

    const strategyKey = supertrendPausesAi
      ? "SUPERTREND"
      : state.strategyMode === "AUTO"
        ? pickStrategyAuto({ regime, indicators, stats: state.stats })
        : state.manualStrategy;

    const strat = strategies[strategyKey] || strategies.EMA_CROSS;
    const signal = supertrendPausesAi
      ? strategies.SUPERTREND.signal({ candles, indicators, regime })
      : strat.signal({ candles, indicators, regime });

    state.lastDecision = { ts: new Date().toISOString(), strategyKey, signal };
    log.info("decision_made", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      regime: regime?.type,
      pendingRegime: regime?.pending,
      strategyKey,
      action: signal?.action,
    });

    const chartCandles = getChartCandles({ hours: 24 });
    const stModel = computeSupertrendChartModel(chartCandles, { withChartArrays: false });
    if (stModel.lastRow) {
      state.supertrendLast = {
        ts: stModel.lastRow.ts,
        up: stModel.lastRow.up,
        dn: stModel.lastRow.dn,
        trend: stModel.lastRow.trend,
        line: stModel.lastRow.line,
      };
    }

    try {
      state.decisionEngine = computeDecisionSnapshot({
        candles,
        indicatorsLatest: indicators.latest,
        supertrendLastRow: stModel.lastRow,
        symbol: state.symbol,
        supertrendOpts: {
          period: state.supertrendPeriod,
          multiplier: state.supertrendMultiplier,
          wilderAtr: state.supertrendWilderAtr,
        },
      });
    } catch (e) {
      log.warn("decision_engine_snapshot_failed", { error: String(e?.message || e) });
    }

    wsHub?.broadcast("market", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      candle: last,
      indicators: indicators.latest,
      regime,
      supertrend: state.supertrendLast,
      supertrendLine: stModel.line,
      supertrendSignals: stModel.signals,
      feedExecutionPause: state.feedExecutionPause,
    });

    wsHub?.broadcast("state", {
      mode: runtimeTradingMode(),
      ...getPublicState(),
      account: acctBroadcast,
      positions: positionsMtM,
    });

    if (!state.running) return;

    if (state.feedExecutionPause) return;

    if (supertrendPausesAi) {
      /** Supertrend orders run only in `processSupertrendCandleClose` (kline `x` = bar closed). */
      return;
    }

    // --- AI predict runs every few seconds (the AI is the brain) ---
    const AI_PREDICT_INTERVAL_MS = 5_000;
    const aiLastCalledAt = state._aiLastCalledAt || 0;
    const tickNow = Date.now();
    let aiResp = null;
    let prob = 0;

    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let didPredict = false;
    if (tickNow - aiLastCalledAt >= AI_PREDICT_INTERVAL_MS) {
      if (candles.length < aiMinCandles) {
        // FastAPI /predict requires min 30 candles; WS-only feed may be sparse if REST backfill failed.
        state._aiLastCalledAt = tickNow;
        if (!state._predictWarmupLogged && candles.length >= 5) {
          state._predictWarmupLogged = true;
          broadcastActivity(wsHub, {
            level: "info",
            msg: `AI predict warming up (${candles.length}/${aiMinCandles} candles — need history for /predict)`,
            category: "ai",
            reason: "predict_warmup",
            detail: { candles: candles.length, minCandles: aiMinCandles },
          });
        }
      } else {
        try {
          state._predictWarmupLogged = false;
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
          didPredict = true;
        } catch (e) {
          const errMsg = formatAiServiceError(e);
          broadcastActivity(wsHub, {
            level: "error",
            msg: "AI predict failed; skipping trade",
            category: "ai",
            reason: "predict_failed",
            detail: { error: errMsg, symbol: state.symbol },
          });
          log.warn("ai_predict_failed", { symbol: state.symbol, error: errMsg });
          noteTradeBlock({ reason: "ai_predict_failed", detail: errMsg, symbol: state.symbol });
          return;
        }
      }
    }

    if (didPredict && aiResp) {
      const calProb = Number(aiResp?.probability ?? 0);
      const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
      prob = aiGateProbability(calProb, rawProb);
      log.info("ai_scored", {
        symbol: state.symbol,
        probability: calProb,
        gateProbability: prob,
        aiGateBlend: process.env.AI_GATE_CALIBRATED_BLEND ?? "0.65",
        aiGateCalibratedOnly: String(process.env.AI_GATE_CALIBRATED_ONLY || "").toLowerCase() === "1" || String(process.env.AI_GATE_CALIBRATED_ONLY || "").toLowerCase() === "true",
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
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: "FUTURES",
          side: "SELL",
          action: "skipped",
          reason: "short_ai_unavailable",
          probability: prob,
        });
        return;
      }
    }

    if (state.lastAi) {
      state.lastAi.gateProbability = prob;
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
    if (!isFixedUsdtCapitalMode() && rlT != null && state.rlBandit.trials >= 15) {
      adaptiveThreshold = Math.max(adaptiveThreshold, rlT);
    }

    if (tradeAction === "HOLD") {
      if (signal.action === "SELL" && isSpotExchange) {
        noteTradeBlock({ reason: "spot_no_short", strategyKey, symbol: state.symbol });
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: "SPOT",
          side: "SELL",
          action: "skipped",
          reason: "spot_cannot_short",
        });
        return;
      }
      if (String(signal.action).toUpperCase() === "HOLD") {
        return;
      }
      noteTradeBlock({
        reason: "strategy_hold",
        strategyKey,
        probability: prob,
        threshold: adaptiveThreshold,
        regime: regimeType,
        symbol: state.symbol,
      });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: isSpotExchange ? "SPOT" : "FUTURES",
        side: "HOLD",
        action: "skipped",
        reason: "strategy_hold",
        probability: prob,
        threshold: adaptiveThreshold,
      });
      return;
    }
    if (!isFixedUsdtCapitalMode() && prob < adaptiveThreshold) {
      noteTradeBlock({
        reason: "ai_below_threshold",
        strategyKey,
        probability: prob,
        threshold: adaptiveThreshold,
        baseThreshold: state.aiThreshold,
        regime: regimeType,
        symbol: state.symbol,
      });
      const routed = pickVenueExchange({
        side: tradeAction,
        prob,
        regime: regime?.type,
        atrPct: regime?.atrPct,
      });
      const vn = String(routed?.name || "").toLowerCase().includes("futures") ? "FUTURES" : isSpotExchange ? "SPOT" : "—";
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: vn,
        side: tradeAction,
        action: "skipped",
        reason: "ai_below_threshold",
        probability: prob,
        threshold: adaptiveThreshold,
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
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: "—",
        side: tradeAction,
        action: "skipped",
        reason: "no_venue",
        probability: prob,
      });
      return;
    }

    const stratVenue = String(venueEx?.name || "").toLowerCase().includes("futures") ? "FUTURES" : "SPOT";

    // Over-trading protection
    const now = Date.now();
    state.tradeOpenTimestamps = (state.tradeOpenTimestamps || []).filter((t) => now - Number(t) < 60 * 60_000);
    if (state.lastTradeOpenedAt && now - Number(state.lastTradeOpenedAt) < state.tradeCooldownMs) {
      noteTradeBlock({ reason: "cooldown", cooldownMs: state.tradeCooldownMs, symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "cooldown",
        probability: prob,
      });
      return;
    }
    if (state.tradeOpenTimestamps.length >= state.maxTradesPerHour) {
      noteTradeBlock({ reason: "max_trades_per_hour", max: state.maxTradesPerHour, symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "max_trades_per_hour",
        probability: prob,
      });
      return;
    }
    if (Array.isArray(positions) && positions.length >= state.maxConcurrentPositions) {
      noteTradeBlock({ reason: "max_concurrent_positions", max: state.maxConcurrentPositions, symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "max_concurrent_positions",
        probability: prob,
      });
      return;
    }
    // Correlation-aware portfolio: skip if already holding the same or highly correlated symbol
    if (Array.isArray(positions) && positions.length > 0) {
      const sym = state.symbol.toUpperCase();
      const holdingSyms = positions.map((p) => String(p?.symbol || "").toUpperCase()).filter(Boolean);
      if (holdingSyms.includes(sym)) {
        noteTradeBlock({ reason: "already_in_position", symbol: sym, strategyKey });
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: "already_in_position",
          probability: prob,
        });
        return;
      }
      // BTC/ETH correlation guard
      const correlatedPairs = { BTCUSDT: ["ETHUSDT"], ETHUSDT: ["BTCUSDT"] };
      const correlated = correlatedPairs[sym] || [];
      const maxCorr = Number(process.env.PORTFOLIO_MAX_CORRELATION || 0);
      if (maxCorr > 0 && correlated.some((c) => holdingSyms.includes(c))) {
        noteTradeBlock({ reason: "correlated_position", symbol: sym, held: holdingSyms, strategyKey });
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: "correlated_position",
          probability: prob,
        });
        return;
      }
    }
    if (venueEx?.name && venueEx.name !== "paper" && venueEx.supportsAutoTrading !== true) {
      noteTradeBlock({ reason: "auto_trading_disabled", exchange: venueEx.name });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "auto_trading_disabled",
      });
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
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: `spread_too_wide_${sp.toFixed(1)}bps`,
          probability: prob,
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
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: "depth_too_thin",
          probability: prob,
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
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: "funding_extreme",
          probability: prob,
        });
        return;
      }
    }

    const isFuturesVenue = String(venueEx?.name || "").toLowerCase().includes("futures");
    const futuresLeverage = !isFuturesVenue
      ? null
      : String(state.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
        ? clamp(Number(state.futuresLeverage), 1, 100)
        : decideFuturesLeverage({
            prob: isFixedUsdtCapitalMode() ? 0.75 : prob,
            atrPct: regime?.atrPct,
            regime: regime?.type,
          });

    // Risk plan (1-2% capital per trade) + SL/TP required.
    // Pass futuresLeverage so max-notional cap matches the leverage we will set on the order.
    const plan = await riskPlan({
      exchange: venueEx,
      side: tradeAction,
      entryPrice: last.close,
      confidence: prob,
      riskPerTrade: state.riskPerTrade,
      riskPerTradeUnit: state.riskPerTradeUnit,
      fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
      atr: indicators.latest.atr_14,
      futuresLeverage: futuresLeverage ?? undefined,
      stats: state.stats[strategyKey],
      regime: regime?.type,
    });
    if (!plan.ok) {
      noteTradeBlock({ reason: "risk_plan_rejected", detail: plan.reason, symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: `risk_plan:${plan.reason || "rejected"}`,
        probability: prob,
      });
      return;
    }

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
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "error",
        reason: err,
        qty: plan.qty,
        probability: prob,
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
    emitSignalActionActivity(wsHub, {
      kind: "strategy",
      strategyKey,
      venue: stratVenue,
      side: tradeAction,
      action: "placed",
      reason: tradeReason != null ? String(tradeReason) : undefined,
      orderId: order.id,
      qty: plan.qty,
      leverage: futuresLeverage ?? undefined,
      probability: prob,
      threshold: adaptiveThreshold,
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
      mode: runtimeTradingMode(),
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
  function start({ wsHub, reason = "user_request", source = "api", detail } = {}) {
    if (state.running) return;
    wsHubRef = wsHub;
    state.lastStopReason = null;
    state.running = true;
    state.pendingAutoRestartAfterFeedStale = false;
    if (state.universePinnedSymbol) {
      state.universePinnedSymbol = null;
      broadcastActivity(wsHub, {
        level: "info",
        msg: "Universe pin cleared (bot started)",
        category: "universe",
        reason: "pin_cleared_on_start",
      });
    }
    broadcastActivity(wsHub, {
      level: "info",
      msg: activityStartMsg(reason),
      category: "bot_lifecycle",
      reason: String(reason),
      source: String(source),
      detail: {
        ...(detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {}),
        symbol: state.symbol,
        timeframe: state.timeframe,
      },
    });
    if (state.pendingSupertrendAction) {
      state._pendingSupertrendFlushOnNextTick = true;
    }
    const feedSrc = feed.getStatus?.()?.source;
    if ((state.supertrendSpotAuto || state.supertrendFuturesAuto) && feedSrc === "SYNTH") {
      broadcastActivity(wsHub, {
        level: "warn",
        msg:
          "Supertrend autotrade is ON but MARKET_FEED is SYNTH — no Binance kline close (k.x) events fire; set MARKET_FEED=BINANCE or BINANCE_FUTURES in backend .env and restart.",
        category: "feed",
        reason: "supertrend_requires_live_feed",
        detail: { feedSource: feedSrc, marketFeed: process.env.MARKET_FEED || "SYNTH" },
      });
    }
    try {
      wsHub?.broadcast?.("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
      });
    } catch {
      /* ignore */
    }
  }

  function stop({ wsHub, reason = "user_request", source = "api", detail } = {}) {
    if (!state.running) return;
    state.running = false;
    state.feedExecutionPause = null;
    const r = String(reason);
    state.lastStopReason = r;
    const feedAutoRestartOn =
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "0" &&
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "false";
    if (r === "feed_stale_60s" && feedAutoRestartOn && marketFeedUsesLiveBinance()) {
      state.pendingAutoRestartAfterFeedStale = true;
    } else {
      state.pendingAutoRestartAfterFeedStale = false;
    }
    const level =
      r === "feed_stale_60s" || r === "max_daily_loss" || r === "max_drawdown" ? "warn" : "info";
    const det =
      detail != null && typeof detail === "object" && !Array.isArray(detail)
        ? { ...detail, symbol: state.symbol }
        : detail != null
          ? { value: detail, symbol: state.symbol }
          : { symbol: state.symbol };
    broadcastActivity(wsHub, {
      level,
      msg: activityStopMsg(reason),
      category: "bot_lifecycle",
      reason: r,
      source: String(source),
      detail: det,
    });
    try {
      wsHub?.broadcast?.("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Clears hybrid per-venue UTC day baselines so the next tick re-anchors from current wallet equity,
   * then starts the bot. Use after max-daily-loss stop when the operator accepts fresh risk for the rest of the day.
   */
  function resetDailyLossBaselineAndStart({ wsHub, source = "http" } = {}) {
    state.dailyVenueBaseline = {};
    broadcastActivity(wsHub, {
      level: "warn",
      msg: "Daily loss baseline reset — counter re-anchored to current wallet equity; bot resuming",
      category: "bot_lifecycle",
      reason: "daily_loss_baseline_reset",
      source: String(source),
      detail: { symbol: state.symbol },
    });
    start({ wsHub, reason: "daily_loss_reset_resume", source });
  }

  function updateConfig(patch) {
    if (patch.symbol) {
      state.symbol = patch.symbol;
      state.coinLastSwitchedAt = Date.now();
      feed.setSymbol(patch.symbol);
      state.feedExecutionPause = null;
      state.supertrendStHandledCloseKey = null;
      state.supertrendLastBarClose = null;
      state.supertrendLastFlipBarClose = null;
      state.supertrendSignalHistory = [];
      state.pendingSupertrendAction = null;
      state._pendingSupertrendFlushOnNextTick = false;
      state.pendingAutoRestartAfterFeedStale = false;
      try {
        depth?.setSymbol?.(patch.symbol);
      } catch {
        // ignore
      }
    }
    if (patch.symbolMode) {
      const v = String(patch.symbolMode).toUpperCase();
      if (v === "SINGLE" || v === "AUTO") state.symbolMode = v;
      if (v === "SINGLE" && state.universePinnedSymbol) {
        state.universePinnedSymbol = null;
      }
    }
    if (patch.universePinnedSymbol !== undefined) {
      const raw = patch.universePinnedSymbol;
      if (raw == null || raw === "") {
        state.universePinnedSymbol = null;
      } else {
        const up = String(raw).toUpperCase();
        state.universePinnedSymbol = up;
        state.symbolMode = "AUTO";
        state.symbol = up;
        state.coinLastSwitchedAt = Date.now();
        feed.setSymbol(up);
        state.feedExecutionPause = null;
        state.supertrendStHandledCloseKey = null;
        state.supertrendLastBarClose = null;
        state.supertrendLastFlipBarClose = null;
        state.supertrendSignalHistory = [];
        state.pendingSupertrendAction = null;
        state._pendingSupertrendFlushOnNextTick = false;
        state.pendingAutoRestartAfterFeedStale = false;
        try {
          depth?.setSymbol?.(up);
        } catch {
          // ignore
        }
      }
    }
    if (patch.timeframe) {
      state.timeframe = patch.timeframe;
      feed.setTimeframe(patch.timeframe);
      state.feedExecutionPause = null;
      state.supertrendStHandledCloseKey = null;
      state.supertrendLastBarClose = null;
      state.supertrendLastFlipBarClose = null;
      state.supertrendSignalHistory = [];
      state.pendingSupertrendAction = null;
      state._pendingSupertrendFlushOnNextTick = false;
      state.pendingAutoRestartAfterFeedStale = false;
    }
    if (patch.aiThreshold != null) state.aiThreshold = clamp(Number(patch.aiThreshold), 0, 1);
    if (patch.riskPerTradeUnit === "PCT" || patch.riskPerTradeUnit === "USDT") {
      state.riskPerTradeUnit = patch.riskPerTradeUnit;
    }
    if (patch.maxDailyLossUnit === "PCT" || patch.maxDailyLossUnit === "USDT") {
      state.maxDailyLossUnit = patch.maxDailyLossUnit;
    }
    if (patch.riskPerTrade != null && Number.isFinite(Number(patch.riskPerTrade))) {
      state.riskPerTrade = Number(patch.riskPerTrade);
    }
    if (patch.maxDailyLoss != null && Number.isFinite(Number(patch.maxDailyLoss))) {
      state.maxDailyLoss = Number(patch.maxDailyLoss);
    }
    normalizeRiskLimits(state);
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
    if (patch.futuresLeverage != null) state.futuresLeverage = clamp(Number(patch.futuresLeverage), 1, 100);

    if (patch.supertrendSpotAuto != null) state.supertrendSpotAuto = Boolean(patch.supertrendSpotAuto);
    if (patch.supertrendFuturesAuto != null) state.supertrendFuturesAuto = Boolean(patch.supertrendFuturesAuto);
    if (patch.supertrendFuturesAiConfidenceFilter != null) {
      state.supertrendFuturesAiConfidenceFilter = Boolean(patch.supertrendFuturesAiConfidenceFilter);
    }
    if (patch.signalStrengthGatesTrades != null) {
      state.signalStrengthGatesTrades = Boolean(patch.signalStrengthGatesTrades);
    }
    if (patch.signalStrengthOpenMin != null && Number.isFinite(Number(patch.signalStrengthOpenMin))) {
      state.signalStrengthOpenMin = clamp(Math.round(Number(patch.signalStrengthOpenMin)), 0, 100);
    }
    if (patch.supertrendFuturesMinAiProb != null && Number.isFinite(Number(patch.supertrendFuturesMinAiProb))) {
      state.supertrendFuturesMinAiProb = clamp(Number(patch.supertrendFuturesMinAiProb), 0, 1);
    }
    if (patch.supertrendFuturesFixedSlPct != null && Number.isFinite(Number(patch.supertrendFuturesFixedSlPct))) {
      state.supertrendFuturesFixedSlPct = clamp(Number(patch.supertrendFuturesFixedSlPct), 0.00005, 0.2);
    }
    if (patch.supertrendFuturesFixedTpPct != null && Number.isFinite(Number(patch.supertrendFuturesFixedTpPct))) {
      state.supertrendFuturesFixedTpPct = clamp(Number(patch.supertrendFuturesFixedTpPct), 0.00005, 0.5);
    }
    if (patch.supertrendFuturesTwoWay != null) state.supertrendFuturesTwoWay = Boolean(patch.supertrendFuturesTwoWay);
    if (patch.supertrendPeriod != null) {
      state.supertrendPeriod = clamp(Math.floor(Number(patch.supertrendPeriod)), 2, 100);
    }
    if (patch.supertrendMultiplier != null) {
      state.supertrendMultiplier = clamp(Number(patch.supertrendMultiplier), 0.5, 20);
    }
    if (patch.supertrendWilderAtr != null) state.supertrendWilderAtr = Boolean(patch.supertrendWilderAtr);

    if (patch.tradingFormDefaults && typeof patch.tradingFormDefaults === "object") {
      const t = patch.tradingFormDefaults;
      if (typeof t.amountUsdStr === "string" && t.amountUsdStr.length <= 32) {
        state.tradingFormDefaults.amountUsdStr = t.amountUsdStr;
      }
      if (typeof t.slPctStr === "string" && t.slPctStr.length <= 32) {
        state.tradingFormDefaults.slPctStr = t.slPctStr;
      }
      if (typeof t.tpPctStr === "string" && t.tpPctStr.length <= 32) {
        state.tradingFormDefaults.tpPctStr = t.tpPctStr;
      }
    }

    // Futures Supertrend AI filter only applies when futures autotrade is on; otherwise reset to default.
    if (!state.supertrendFuturesAuto || state.marketMode === "SPOT") {
      state.supertrendFuturesAiConfidenceFilter = true;
    }

    if (patch.symbol || patch.timeframe || patch.universePinnedSymbol !== undefined) {
      loadSupertrendSignalHistoryFromDisk();
    }

    persistTradingConfigToDisk();

    if ((patch.symbol || patch.timeframe) && wsHubRef) {
      queueMicrotask(() => {
        tick({ wsHub: wsHubRef }).catch((e) =>
          log.warn("config_tick_flush_failed", { error: String(e?.message || e) }),
        );
      });
    }

    return getPublicState();
  }

  async function manualTrade({ wsHub, side, amountUsd, stopLossPct, takeProfitPct, strategyKey = "MANUAL" }) {
    if (state.feedExecutionPause) return { ok: false, reason: "feed_execution_paused" };
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
          ? clamp(Number(state.futuresLeverage), 1, 100)
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
    broadcastActivity(wsHub, {
      level: "info",
      msg: `Manual trade · ${side} ${state.symbol} · order ${order.id}`,
      category: "manual_trade",
      reason: "manual_order",
      symbol: state.symbol,
      detail: {
        orderId: order.id,
        side,
        qty,
        price: order.filledPrice,
        stopLoss,
        takeProfit,
        amountUsd,
      },
    });
    return { ok: true, id: order.id };
  }

  return {
    feed,
    setWsHub,
    getPublicState,
    getChartCandles,
    getChartSnapshot,
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
      if (!marketFeedUsesLiveBinance()) return null;
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
    resetDailyLossBaselineAndStart,
    updateConfig,
    manualTrade,
    saveTradingConfigToDisk() {
      persistTradingConfigToDisk();
    },
    reloadTradingConfigFromDisk() {
      hydrateTradingConfigFromDisk();
      loadSupertrendSignalHistoryFromDisk();
    },
    setExchange(next) {
      exch = next;
      lastSeenTradeId = null;
      ingestedCloseBroadcastKeys = new Set();
      closedSinceRetrain = 0;
    },
  };
}

