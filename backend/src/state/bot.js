import { clamp, roundTo } from "../lib/math.js";
import {
  updateIntelligenceCandles,
  updateIntelligenceAdx,
  updateIntelligenceOrderBook,
  computeAndBroadcastIntelligenceSnapshot,
  intelligenceCache,
} from "../intelligence/index.js";
import { tradeCloseFeeUsdtFromNotional, tradeCloseFeeRate } from "../lib/tradeCloseFee.js";
import { maxBarsForHistory } from "../lib/chartWindow.js";
import { chartSnapshotNeedsRestRepair } from "../lib/chartSnapshotRepair.js";
import { computeIndicators } from "../strategy/indicators.js";
import { computeDecisionSnapshot } from "../strategy/decisionEngine.js";
import { detectRegime } from "../strategy/regime.js";
import { strategies } from "../strategy/strategies.js";
import { pickStrategyAuto, topStrategies } from "../strategy/selector.js";
import { riskPlan, spotBracketFromAtr, applyFixedPctBracket } from "../strategy/risk.js";
import { resolveFibEntryBrackets } from "../strategy/techniques/fibonacci.js";
import {
  mapLiquidityEntryLegs,
  resolveLiquidityEntryBrackets,
} from "../strategy/techniques/liquidity.js";
import { resolveSizingStopPrice } from "../strategy/sizingStop.js";
import { evaluateIntelligenceGateForSupertrendOpen } from "./intelligenceGate.js";
import { createMarketFeed } from "./marketFeed.js";
import { createBinanceUniverse } from "../svc/universe/binanceUniverse.js";
import { createBinanceOrderBook } from "./orderBookBinance.js";
import {
  evaluateLiquidityGuards,
  fetchBinanceFuturesFundingRate,
  fundingBlocksTrade,
  readLiquidityGuardConfig,
} from "../svc/executionGuards.js";
import { createCoinGeckoClient } from "../svc/external/coingecko.js";
import { formatAiServiceError } from "../svc/aiHttpError.js";
import { isPlausibleCandleClose } from "../lib/symbolPriceSanity.js";
import { computeSupertrendSeries } from "../strategy/supertrend.js";
import {
  sanitizeCandlesForSt,
  chartMarkerVisibleForBar,
  computeSupertrendSignalStrength01,
  binanceIntervalMs,
} from "../lib/supertrendChartAlign.js";
import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import { getPool } from "../db/pool.js";
import { scheduleArchiveLiveOhlcvCandle } from "../backtest/data/liveOhlcvArchive.js";
import { fireAndForgetWalletSnapshot } from "../db/services/walletService.js";
import { computeInstanceStats, updateInstanceStats } from "../db/services/instanceService.js";
import { getAllotmentForInstance, updateReserved } from "../db/services/capitalAllotmentService.js";
import * as tradeService from "../db/services/tradeService.js";
import {
  depthBookFromTicker,
  fetchUsdMBookTicker,
  fetchUsdMDepthBook,
  fetchUsdMKlineCloseAtOpenTime,
  fetchUsdMPremiumMark,
} from "../lib/binanceUsdMBookTicker.js";
import { routeBinanceUsdmWsBase } from "../lib/binanceUsdmWsRoute.js";
import { readBotTradingConfig, writeBotTradingConfig } from "../lib/botTradingConfigStore.js";
import {
  appendSupertrendSignalHistoryEntry,
  maybeMigrateLegacySupertrendSignalHistory,
  readSupertrendSignalHistory,
} from "../lib/supertrendSignalHistoryPersistence.js";
import { appendMqTradeOutcomeRow } from "../lib/mqTradeOutcomeLog.js";
import { isStrictBinanceAccountMode, tradingModeToPersistenceSlug } from "../lib/tradingModePersistence.js";
import { fetchBinanceKlinesRows, fetchBinanceKlinesRange } from "../lib/binanceKlinesRest.js";
import {
  evaluateLiveBinanceFeedExecutionGate,
  feedRecoveredForAutoRestart,
} from "../lib/binanceFeedHealth.js";
import { computeSupertrendSignalVerdictsBackend, closeBySecFromKlines } from "../lib/supertrendSignalVerdict.js";
import {
  evaluateSupertrendMoveQuality,
  estimateSlDistancePctForMoveQualityGate,
} from "../strategy/supertrendMoveQuality.js";
import {
  evaluateSupertrendBigMoveGate,
  readBigMoveGateCfg,
  BIG_MOVE_DEFAULTS,
} from "../strategy/supertrendBigMoveGate.js";
import {
  buildHtf4hContext,
  evaluateHtf4hFilter,
} from "../strategy/supertrendHtf4hFilter.js";
import { ELITE_ST_ACTIVATION_PATCH } from "../strategy/supertrendElite.js";
import {
  applyVolumeProfilePatchToState,
  volumeProfilePublicSnapshot,
} from "../strategy/volumeProfileConfigKeys.js";
import {
  manualStrategyUsesLiveBarClose,
  manualStrategyUsesBarCloseAdapter,
  manualStrategyKey,
  evaluateLiveStrategyBarClose,
  manualStrategyBarCloseActive,
  resolveManualStrategyVenue,
  resolveTradingVenueForBarClose,
  barCloseActivityKindFor,
  shouldSuppressBarCloseAutotradeOffActivity,
  barCloseTradingConfigured,
  barCloseWatchConfigured,
  supertrendAutotradeActive,
  tickExecutionOwnedByBarClose,
  barCloseSignalStrategyKey,
} from "../strategy/liveStrategyBarClose.js";
import { learnSmartSignalStrengthThreshold } from "../lib/signalStrengthSmartThreshold.js";
import { extractSurfPulseFeatures } from "../strategy/surfPulseMl.js";
import { mergeMarketDecisionConfig, computeMarketDecisionSnapshot } from "../lib/marketDecisionEngine.js";
import { maxTrailStepsForConfig } from "../lib/trailingStopLoss.js";
import { entryRejectedLiquidationBreakeven } from "../lib/supertrendTrailingSl.js";
import { postOpenStableProbeMs } from "../lib/binanceUsdmPositionVerify.js";

/** Must match /api/bot/config timeframe allowlist. */
const PERSISTED_TF = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

function truthyEnv(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

async function withTimeout(p, ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0));
  if (!t) return await p;
  return await Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), t)),
  ]);
}

const AI_PREDICT_TIMEOUT_MS = Math.max(0, Math.floor(Number(process.env.AI_PREDICT_TIMEOUT_MS ?? 450)));
/** When true, AI timeout blocks (skip trade). Default false: fall back to last AI / configured fallback prob. */
const AI_TIMEOUT_IS_HARD_FAIL = truthyEnv(process.env.AI_PREDICT_TIMEOUT_HARD_FAIL);
/** How long bar-close is allowed to wait for AI gates before using cached gates (ms). */
const SUPERTREND_BAR_CLOSE_AI_BUDGET_MS = Math.max(
  0,
  Math.floor(Number(process.env.SUPERTREND_BAR_CLOSE_AI_BUDGET_MS ?? 120)),
);

/** Fraction of `(allowed − open margin)` kept as strategy “usable” margin (default 90%). */
function usableCapitalBufferPctFromEnv() {
  return clamp(Number(process.env.USABLE_CAPITAL_BUFFER_PCT || 90), 1, 100);
}

const SUPERTREND_SIGNAL_STATE_MAX = Math.max(
  50,
  Math.min(50_000, Number(process.env.SUPERTREND_SIGNAL_HISTORY_STATE_MAX || 2000)),
);
const SYM_RE = /^[A-Z0-9]{5,20}$/i;

/**
 * Trailing uses the lower ST rail for longs and the upper rail for shorts.
 * `line` flips with trend and is wrong for counter-trend legs (shows opposite side vs stop geometry).
 */
function futuresSideIsLongCached(positions, symU) {
  if (!Array.isArray(positions) || !symU) return null;
  const u = String(symU).trim().toUpperCase();
  if (!u) return null;
  for (const x of positions) {
    if (String(x?.venue || "").toUpperCase() !== "FUTURES") continue;
    if (String(x?.symbol || "").trim().toUpperCase() !== u) continue;
    const q = Math.abs(Number(x?.qty ?? x?.positionAmt ?? 0));
    if (!Number.isFinite(q) || q <= 1e-8) continue;
    return String(x?.side || "").toUpperCase() === "BUY";
  }
  return null;
}

function supertrendTrailPxPickFromStRow(row, isLong) {
  if (!row || typeof row !== "object") return null;
  const up = Number(row.up);
  const dn = Number(row.dn);
  const line = Number(row.line);
  if (isLong === true && Number.isFinite(up) && up > 0) return up;
  if (isLong === false && Number.isFinite(dn) && dn > 0) return dn;
  if (Number.isFinite(line) && line > 0) return line;
  return null;
}

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
  const openRefId = t.meta?.openRefId;
  if (openRefId != null && String(openRefId).trim() !== "") return false;
  if (t.ledgerEvent === true || t.meta?.ledgerEvent === true) return true;
  if (String(t.strategy || "").toUpperCase() === "INCOME_LEDGER") return true;
  if (String(t.strategy || "") === "FUTURES_DEMO") return true;
  if (t.meta?.note === "realized_pnl_ledger_row") return true;
  if (t.meta?.source === "fapi_income") return true;
  return false;
}

/** Backfill fee (qty×price×rate) and top-level price / SL / TP for WS trade history when exchange rows omit them. */
function enrichCloseTradeForHistory(t) {
  if (!t || t.type !== "CLOSE") return t;
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
  if (Number.isFinite(Number(m.leverage)) && (next.leverage == null || !Number.isFinite(Number(next.leverage)))) {
    next.leverage = Number(m.leverage);
  }
  if (Number.isFinite(Number(m.entryPrice)) && (next.entryPrice == null || !Number.isFinite(Number(next.entryPrice)))) {
    next.entryPrice = Number(m.entryPrice);
  }
  const fExisting = Number(next.fee);
  if (!Number.isFinite(fExisting) || fExisting <= 0) {
    const modeled = tradeCloseFeeUsdtFromNotional(q, px);
    if (modeled != null) next.fee = modeled;
  }
  if (next.reason != null && String(next.reason).trim() !== "") {
    if (m.closeReason == null || String(m.closeReason).trim() === "") {
      m.closeReason = String(next.reason);
    }
    next.meta = m;
  }
  const pnlN = Number(next.pnl);
  const entryPx = Number(next.entryPrice ?? m.entryPrice);
  const qn = Number(next.qty);
  if (Number.isFinite(pnlN) && Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(qn) && qn > 0) {
    const notional = entryPx * qn;
    m.pnlPct = Math.round((pnlN / notional) * 100 * 10000) / 10000;
    if (pnlN > 1e-12) m.outcome = "WIN";
    else if (pnlN < -1e-12) m.outcome = "LOSS";
    else m.outcome = "BREAKEVEN";
    next.meta = m;
  }
  return next;
}

/** Binance USD-M `placeOrder` returns `id: fut_<SYM>` for position rows; merge keys need the real entry order id. */
function binanceFuturesEntryOrderIdFromPlaceOrder(order) {
  if (!order || typeof order !== "object") return null;
  if (order.binanceOrderId != null && String(order.binanceOrderId).trim() !== "") {
    return String(order.binanceOrderId).trim();
  }
  const r = order.raw;
  if (r && r.orderId != null && String(r.orderId).trim() !== "") return String(r.orderId).trim();
  return null;
}

/** Clamp `riskPerTrade` / `maxDailyLoss` to valid ranges for their unit modes. */
function normalizeRiskLimits(s) {
  const ru = String(s.riskPerTradeUnit || "PCT").toUpperCase() === "USDT" ? "USDT" : "PCT";
  s.riskPerTradeUnit = ru;
  if (ru === "USDT") {
    s.riskPerTrade = clamp(Number(s.riskPerTrade), 0, 10_000_000);
  } else {
    let rp = Number(s.riskPerTrade);
    if (Number.isFinite(rp) && rp > 0 && rp <= 0.051) rp *= 100;
    s.riskPerTrade = clamp(rp, 0, 100);
  }
  const lu = String(s.maxDailyLossUnit || "PCT").toUpperCase() === "USDT" ? "USDT" : "PCT";
  s.maxDailyLossUnit = lu;
  if (lu === "USDT") {
    s.maxDailyLoss = clamp(Number(s.maxDailyLoss), 0, 10_000_000);
  } else {
    let md = Number(s.maxDailyLoss);
    if (Number.isFinite(md) && md > 0 && md <= 0.25) md *= 100;
    s.maxDailyLoss = clamp(md, 0, 100);
  }
}

/**
 * **Margin** (collateral) tied in an open leg vs allowed budget — not leveraged notional.
 * Futures USD-M: approximate initial margin ≈ notional / leverage. Spot: full quote at entry.
 */
function positionMarginUsedUsdt(p) {
  const qty = Math.abs(Number(p?.qty ?? p?.positionAmt ?? 0));
  if (!(qty > 0)) return 0;
  const ep = Number(p?.entryPrice || 0);
  let notional = 0;
  if (Number.isFinite(ep) && ep > 0) notional = qty * ep;
  else {
    const mp = Number(p?.markPrice ?? p?.mark ?? 0);
    if (Number.isFinite(mp) && mp > 0) notional = qty * mp;
  }
  if (!(notional > 0)) return 0;
  const ven = String(p?.venue || "").toUpperCase();
  const levRaw = Number(p?.leverage);
  if (ven === "FUTURES") {
    const lev = Math.max(1, Math.floor(Number.isFinite(levRaw) && levRaw > 0 ? levRaw : 1));
    return notional / lev;
  }
  return notional;
}

function sumOpenMarginUsedUsdt(positions, marketMode) {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    const ven = String(p?.venue || "").toUpperCase();
    if (mm === "SPOT" && ven !== "SPOT") continue;
    if (mm === "FUTURES" && ven !== "FUTURES") continue;
    if (mm === "AUTO" && ven && ven !== "SPOT" && ven !== "FUTURES") continue;
    sum += positionMarginUsedUsdt(p);
  }
  return sum;
}

function sumMarginUsedForSymbolUsdt(positions, marketMode, symbol) {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const sym = String(symbol || "").trim().toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    const ps = String(p?.symbol || "").trim().toUpperCase();
    if (ps !== sym) continue;
    const ven = String(p?.venue || "").toUpperCase();
    if (mm === "SPOT" && ven !== "SPOT") continue;
    if (mm === "FUTURES" && ven !== "FUTURES") continue;
    if (mm === "AUTO" && ven && ven !== "SPOT" && ven !== "FUTURES") continue;
    sum += positionMarginUsedUsdt(p);
  }
  return sum;
}

/** USD-M quote notional (USDT) for open futures legs — used when capital allotment is expressed as max notional, not margin. */
function futuresPositionNotionalUsdt(p) {
  const qty = Math.abs(Number(p?.qty ?? p?.positionAmt ?? 0));
  if (!(qty > 0)) return 0;
  const px = Number(p?.markPrice ?? p?.mark ?? p?.entryPrice ?? 0);
  return Number.isFinite(px) && px > 0 ? qty * px : 0;
}

function sumOpenFuturesNotionalUsdt(positions) {
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    if (String(p?.venue || "").toUpperCase() !== "FUTURES") continue;
    sum += futuresPositionNotionalUsdt(p);
  }
  return sum;
}

function sumFuturesNotionalForSymbolUsdt(positions, symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    if (String(p?.symbol || "").trim().toUpperCase() !== sym) continue;
    if (String(p?.venue || "").toUpperCase() !== "FUTURES") continue;
    sum += futuresPositionNotionalUsdt(p);
  }
  return sum;
}

/** Free **margin** (USDT) available to cap allowed budget — hybrid `venues.*.freeBalance`; else `account.freeBalance`. */
function walletFreeMarginUsdtForAllowedCap(account, marketMode) {
  if (account == null) return null;
  const mm = String(marketMode || "AUTO").toUpperCase();
  const v = account?.venues;
  if (v && (v.spot != null || v.futures != null)) {
    const spotF =
      v.spot && v.spot.freeBalance != null && Number.isFinite(Number(v.spot.freeBalance))
        ? Math.max(0, Number(v.spot.freeBalance))
        : 0;
    const futF =
      v.futures && v.futures.freeBalance != null && Number.isFinite(Number(v.futures.freeBalance))
        ? Math.max(0, Number(v.futures.freeBalance))
        : 0;
    if (mm === "SPOT") return spotF > 0 ? spotF : null;
    if (mm === "FUTURES") return futF > 0 ? futF : null;
    const sum = spotF + futF;
    return sum > 0 ? sum : null;
  }
  const fb = Number(account.freeBalance);
  return Number.isFinite(fb) && fb > 0 ? fb : null;
}

function normalizeCapitalBudgetFields(s, SYM_RE) {
  const ab = Number(s.allowedBudgetUsdt);
  s.allowedBudgetUsdt = Number.isFinite(ab) && ab >= 0 ? clamp(ab, 0, 10_000_000) : 0;
  const aw = Number(s.allowedBudgetWalletPct);
  s.allowedBudgetWalletPct = Number.isFinite(aw) ? clamp(aw, 0, 100) : 0;
  const im = String(s.allowedBudgetInputMode || "USDT").toUpperCase();
  s.allowedBudgetInputMode = im === "WALLET_PCT" ? "WALLET_PCT" : "USDT";
  const mp = Number(s.multiTradePctOfUsable);
  s.multiTradePctOfUsable = Number.isFinite(mp) ? clamp(mp, 0, 100) : 100;
  const sanitizeMapNum = (raw, maxVal) => {
    const next = Object.create(null);
    if (!raw || typeof raw !== "object") return next;
    for (const [k, v] of Object.entries(raw)) {
      const sym = String(k || "").trim().toUpperCase();
      if (!SYM_RE.test(sym)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      next[sym] = clamp(n, 0, maxVal);
    }
    return next;
  };
  s.multiBudgetCoinUsdt = sanitizeMapNum(s.multiBudgetCoinUsdt, 10_000_000);
  s.multiBudgetCoinPct = sanitizeMapNum(s.multiBudgetCoinPct, 100);
  let pctSum = 0;
  for (const v of Object.values(s.multiBudgetCoinPct)) pctSum += Number(v) || 0;
  if (pctSum > 100 + 1e-6) {
    const scale = 100 / pctSum;
    for (const k of Object.keys(s.multiBudgetCoinPct)) {
      s.multiBudgetCoinPct[k] = roundTo(Number(s.multiBudgetCoinPct[k]) * scale, 4);
    }
  }
  const pti = String(s.perTradeBudgetInputMode || "USDT").toUpperCase();
  s.perTradeBudgetInputMode = pti === "PCT_OF_USABLE" ? "PCT_OF_USABLE" : "USDT";
}

export function createBot({
  log,
  ai,
  exchange,
  defaults,
  getTradingMode,
  getActiveInstanceId = null,
  persistenceSlug,
  dbAccountId = null,
  initialPersistedConfig = null,
}) {
  let exch = exchange;
  /** Phase 2C: DB `accounts.id` for wallet_snapshots telemetry; null skips writes. */
  const walletTelemetryAccountId = dbAccountId && String(dbAccountId).trim() ? String(dbAccountId).trim() : null;
  function scheduleCapitalReservedSyncAfterTrade() {
    if (!getPool()) return;
    let iid = null;
    try {
      iid = typeof getActiveInstanceId === "function" ? getActiveInstanceId() : null;
    } catch {
      iid = null;
    }
    if (!iid) return;
    void (async () => {
      try {
        const allot = await getAllotmentForInstance(String(iid));
        if (!allot?.id) return;
        let pos = _cachedPositions || [];
        try {
          pos = await exch.getPositions();
        } catch {
          /* keep cache */
        }
        const margin = sumOpenMarginUsedUsdt(pos, state.marketMode);
        const row = await updateReserved(String(allot.id), margin);
        const hub = wsHubRef;
        if (hub?.broadcast && row) {
          const ru = Number(row.reserved_usdt ?? 0);
          hub.broadcast("instance_status", {
            instanceId: String(iid),
            reservedUsdt: Number.isFinite(ru) ? ru : null,
            triggeredBy: "system",
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        log?.warn?.("[capital] updateReserved failed", { error: String(e?.message || e) });
      }
    })();
  }

  async function placeOrderWithWalletTelemetry(venueEx, runPlaceOrder) {
    if (!walletTelemetryAccountId || !getPool()) {
      try {
        const o = await runPlaceOrder();
        if (getPool()) scheduleCapitalReservedSyncAfterTrade();
        return o;
      } catch (e) {
        if (getPool()) scheduleCapitalReservedSyncAfterTrade();
        throw e;
      }
    }
    fireAndForgetWalletSnapshot(walletTelemetryAccountId, "pre_trade", venueEx);
    try {
      const o = await runPlaceOrder();
      fireAndForgetWalletSnapshot(walletTelemetryAccountId, "post_trade", venueEx);
      scheduleCapitalReservedSyncAfterTrade();
      return o;
    } catch (e) {
      fireAndForgetWalletSnapshot(walletTelemetryAccountId, "post_trade", venueEx);
      scheduleCapitalReservedSyncAfterTrade();
      throw e;
    }
  }
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
  const cfgPersistenceSlug =
    persistenceSlug != null && String(persistenceSlug).trim()
      ? String(persistenceSlug).trim()
      : tradingModeToPersistenceSlug(runtimeTradingMode());

  function emitActivity(hub, payload) {
    const tm = runtimeTradingMode();
    broadcastActivity(
      hub,
      { ...payload, tradingMode: payload?.tradingMode ?? tm },
      { persistenceSlug: cfgPersistenceSlug },
    );
  }

  function broadcastTrade(hub, payload) {
    hub?.broadcast?.("trade", { ...payload, originTradingMode: runtimeTradingMode() });
  }
  function requiresStrictBinanceAccount() {
    return isStrictBinanceAccountMode(runtimeTradingMode());
  }
  /** Kline OHLC updates every BOT_TICK (~1s); wallet/positions come from REST. Defaults: 1500ms live/testnet, 5000ms paper/demo unless `ACCOUNT_FETCH_INTERVAL_MS` is set. */
  function effectiveAccountFetchIntervalMs() {
    const raw = Number(process.env.ACCOUNT_FETCH_INTERVAL_MS);
    if (Number.isFinite(raw) && raw >= 250) return Math.min(120_000, raw);
    const strictMs = Number(process.env.ACCOUNT_FETCH_INTERVAL_STRICT_MS ?? 1500);
    const relaxedMs = Number(process.env.ACCOUNT_FETCH_INTERVAL_RELAXED_MS ?? 5000);
    return requiresStrictBinanceAccount()
      ? Math.max(250, Math.min(120_000, strictMs))
      : Math.max(500, Math.min(120_000, relaxedMs));
  }
  function walletBaseFromAccount(account) {
    if (account == null) return null;
    if (account.equity == null || !Number.isFinite(Number(account.equity))) return null;
    return Number(account.equity);
  }
  const state = {
    running: false,
    /** Phase 3D: tick continues; Supertrend entry paths skip new risk while exits / flips-to-flat still allowed. */
    paused: false,
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
    /**
     * Institutional risk overlay (regime-adaptive strategy + reusable globally).
     * Backtest enforcement lives in runner.js; live enforcement in the entry path.
     */
    /** Single aggressiveness dial — scales risk-per-trade ~1:1 with return AND drawdown (0.1–5). */
    riskScale: 1,
    /** Vol-targeted sizing: size by referenceATR%/currentATR% so per-trade risk is constant across regimes. */
    volTargetSizing: false,
    volTargetAtrPct: 0.005,
    volTargetMaxMult: 2,
    volTargetMinMult: 0.4,
    /** Account-drawdown kill switch: halt NEW entries once equity is this % below peak (0 = off). */
    riskKillSwitchDdPct: 0,
    /** Consecutive-loss cooldown: stop new entries for the rest of the UTC day after N losses in a row (0 = off). */
    riskConsecutiveLossLimit: 0,
    /** Weekly drawdown cap: halt new entries once the rolling 7-day equity is down this % (0 = off). */
    riskWeeklyMaxLossPct: 0,
    /** Equity at start of current UTC week (for weekly risk cap). */
    weekStartEquity: 0,
    weekStartMs: 0,
    /** Recent closed trades for consecutive-loss overlay (capped). */
    recentClosedTrades: [],
    /** VP FREQ novelty monitor — opt-in only (BTC bleed list must not auto-attach on ETH). */
    vpNoveltyEnabled: false,
    vpNoveltyUnknownPolicy: "trade",
    vpNoveltyMonitor: null,

    // ── Regime-adaptive strategy (REGIME_ADAPTIVE) ──────────────────────────
    /** Per-regime playbook enables. */
    regimeAdaptiveEnableTrend: true,
    regimeAdaptiveEnableRange: true,
    regimeAdaptiveEnableBreakout: true,
    /** Minimum setup grade to trade: "A" (top only) or "B" (A or B). */
    regimeAdaptiveMinGrade: "A",
    /** Skip bars where the regime label confidence is below this floor (0–1). */
    regimeAdaptiveConfidenceFloor: 0.45,
    /** Trade-frequency controls (the #1 cost lever). */
    regimeAdaptiveMaxTradesPerDay: 2,
    regimeAdaptiveMinBarGap: 8,
    /** Session filter: "LONDON_NY" (default) or "ALL". */
    regimeAdaptiveKillzoneMode: "LONDON_NY",
    /** Reward:risk (TP2 in R) per playbook. */
    regimeAdaptiveTrendRR: 2.0,
    regimeAdaptiveRangeRR: 1.5,
    regimeAdaptiveBreakoutRR: 2.0,
    /** Structure-stop ATR buffer. */
    regimeAdaptiveAtrSlMult: 1.1,
    /** Optional regime-engine threshold overrides (0/unset = use defaults). */
    regimeAdaptiveTrendAdx: 25,
    regimeAdaptiveSqueezePctile: 0.2,
    regimeAdaptiveVolatileAtrPct: 0.012,
    // ── Scalp mean-reversion (SCALP_MR) ─────────────────────────────────────
    scalpMrBbPeriod: 20,
    scalpMrBbMult: 2,
    scalpMrRsiPeriod: 14,
    scalpMrRsiBuyMax: 38,
    scalpMrRsiSellMin: 62,
    scalpMrMaxAdx: 22,
    scalpMrMinAtrPct: 0.08,
    scalpMrMaxAtrPct: 0.55,
    scalpMrMinVolVsAvg: 1.15,
    scalpMrVolLookback: 20,
    scalpMrRangeRR: 1.5,
    scalpMrAtrSlMult: 0.55,
    scalpMrMinReclaimAtr: 0.2,
    scalpMrRequireConfirmCandle: true,
    scalpMrUsePartialTp: false,
    scalpMrMaxTradesPerDay: 10,
    scalpMrMinBarGap: 3,
    scalpMrKillzoneMode: "LONDON_NY",
    /**
     * With fixed USDT capital (risk + max daily both USDT) and MULTIPLE pins (2+), divide `riskPerTrade` by pin count
     * so each active coin gets an equal slice of the per-trade budget.
     */
    capitalSplitAcrossCoins: false,
    /**
     * Pool cap for strategy (USDT). Fixed-USDT sizing uses **only** this value (after wallet clamp) as the allotment pool;
     * there is no fallback to `riskPerTrade`. Set a positive value before relying on autotrade size.
     * `allowedBudgetWalletPct` + `allowedBudgetInputMode` are UI hints for syncing this from wallet equity.
     */
    allowedBudgetUsdt: 0,
    allowedBudgetWalletPct: 0,
    allowedBudgetInputMode: "USDT", // USDT | WALLET_PCT
    /** Epoch ms when allowed-budget fields were last user-edited; compound headline ignores closes / legs before this. */
    allowedBudgetPnlAnchorMs: null,
    /** MULTIPLE + fixed USDT: size opens from % of (allowed − open notional); pool is `allowedBudgetUsdt` only. */
    multiTradeUsePctOfUsable: false,
    multiTradePctOfUsable: 100,
    /** UI-only: when true, Capital allotment headline treats allowed pool as base cap + close net P&L + open unrealized (does not change order sizing). */
    capitalAllotmentCompoundPnlUi: false,
    /**
     * Cycle-based capital allocation state (fixed slots during open-cycle, rebalance on flat).
     * strategyBalanceUsdt grows/shrinks with realized PnL, poolAnchorUsdt stays fixed within cycle.
     */
    capitalCycleStrategyBalanceUsdt: 0,
    capitalCyclePoolAnchorUsdt: 0,
    capitalCycleRealizedPnlUsdt: 0,
    capitalCycleSymbols: [],
    /** When false, per-trade USDT cap (`riskPerTrade`) is ignored for sizing (still venue-limited). */
    perTradeBudgetCapEnabled: true,
    /**
     * When `riskPerTradeUnit` is USDT: `USDT` = `riskPerTrade` is margin USDT cap; `PCT_OF_USABLE` = cap is that % of sized usable (after buffer).
     */
    perTradeBudgetInputMode: "USDT",
    /**
     * MULTIPLE + fixed USDT: when true, `multiBudgetSplit*` modes size capital and per-trade cap is off.
     * When false, pool is full usable per symbol with optional per-trade cap (per-trade budget path).
     */
    multiCoinCapitalSizingActive: false,
    /**
     * MULTIPLE capital split: FULL = full pool per active symbol; EQUAL = divide pool across ranked/pins list;
     * CUSTOM_USDT / CUSTOM_PCT_ALLOWED = per-symbol maps (`multiBudgetCoinUsdt` / `multiBudgetCoinPct` as % of sized usable).
     */
    multiBudgetSplitMode: null, // null → derive from capitalSplitAcrossCoins
    multiBudgetCoinUsdt: Object.create(null),
    multiBudgetCoinPct: Object.create(null),
    strategyMode: "AUTO", // AUTO | MANUAL
    manualStrategy: "EMA_CROSS",
    marketMode: "AUTO", // SPOT | FUTURES | AUTO
    /** AUTO: per trade via decideFuturesLeverage (AI + volatility). MANUAL: use futuresLeverage for every futures order. */
    futuresLeverageMode: "AUTO",
    futuresLeverage: Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5))),
    lastDecision: null,
    lastAi: null,
    /** SurfPulse ML: last /predict/surfpulse score when strategy is SURF_PULSE_ML */
    lastSurfPulseMl: null,
    lastRegime: null,
    regimeConfirmCandles: Number(process.env.REGIME_CONFIRM_CANDLES || 4),
    regimeCandidate: null, // { type, firstSeenAt }
    universe: null, // last scan snapshot
    universeLastPick: null,
    /**
     * When set, keep trading this symbol and skip auto rotation (AUTO mode); cleared on bot start or explicit unpin.
     * Kept in sync with `universePinnedSymbols[0]` when `universeCoinSelectMode === "SINGLE"`.
     */
    universePinnedSymbol: null,
    /** `ALL` = broad Binance universe, funnel top N by AI; `CUSTOM` = only `universeCustomSymbols` (max 10). */
    universeCoinBase: "ALL",
    /** User watchlist for CUSTOM coin base (modal); max 10 symbols. */
    universeCustomSymbols: [],
    /** `SINGLE` = at most one pin (locks chart); `MULTIPLE` = 1–10 pins (auto-pick among pins only). */
    universeCoinSelectMode: "SINGLE",
    /** `AUTO` = ignore saved pins for rotation (table read-only for bot); `MANUAL` = pins filter / lock as before. */
    universePinControl: "AUTO",
    /**
     * Auto coin rotation when Pick control is Auto (no manual pins):
     * `RANKED_AI_SS` = ranked list (AI + spread/opp composite from universe scan).
     * `ST_SIGNAL_FIRST` = walk ranked/pinned order; first symbol with Supertrend bar-close signal (same ST rules as autotrade).
     */
    universeAutoCoinPick: "RANKED_AI_SS",
    /** Pinned symbols (max 10). Canonical store; see `universePinnedSymbol` for single-pin compat. */
    universePinnedSymbols: [],
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
    /**
     * When true, Supertrend spot/futures **opening** legs must pass move-quality (ATR vs SL, ADX, body, expansion, composite score).
     * Default off so behavior matches legacy.
     */
    supertrendMoveQualityGate: false,
    /** Min composite move-quality score (0–1) when gate is on. */
    supertrendMoveQualityMinScore: clamp(Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_SCORE ?? 0.6), 0, 1),
    /** Min ADX (14) at signal bar. */
    supertrendMoveQualityMinAdx: clamp(Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_ADX ?? 23), 0, 100),
    /** Require expected move (ATR% × mult) ≥ SL% × this ratio. */
    supertrendMoveQualityMinMoveSlRatio: Math.max(1, Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_MOVE_SL_RATIO ?? 1.5)),
    /** Multiplier on ATR% for “expected favorable move” estimate (1 = raw ATR% vs SL%). */
    supertrendMoveQualityExpectedMoveAtrMult: Math.max(0.1, Number(process.env.SUPERTREND_MOVE_QUALITY_ATR_EXPECT_MULT ?? 1.0)),
    /**
     * 4H Supertrend direction confirmation filter.
     * When on, Supertrend opens are blocked unless the 4H ST trend agrees (bullish for BUY, bearish for SELL).
     */
    supertrendHtf4hEnabled: false,
    supertrendHtf4hPeriod: clamp(Math.round(Number(process.env.SUPERTREND_HTF4H_PERIOD ?? 10)), 2, 50),
    supertrendHtf4hMultiplier: Math.max(0.5, Number(process.env.SUPERTREND_HTF4H_MULTIPLIER ?? 3)),

    /** Volume Profile — SR_INTRADAY / INTRADAY_PRO structure filter (Indicators section). */
    volumeProfileEnabled: false,
    volumeProfileSoftGates: true,
    volumeProfileGatesEnabled: false,
    intradayVpBrackets: false,
    intradayGateLiquidity: true,
    intradayGateSession: true,
    intradayGateFib: true,
    intradayGateVp: true,
    intradayGateOrderFlow: true,
    intradayOfKillzoneMode: "LONDON_NY",
    intradayOfRequireKeyLevel: true,
    intradayOfRequireConfirmation: true,
    intradayOfMinStackBars: 3,
    intradayOfMinConfluence: 2,
    intradayOfUseOrderBook: true,
    intradayOfAllowProxy: false,
    intradayOfLevelProximityPct: 0.0006,
    intradayOfDivergenceLookback: 12,
    intradayOfAbsorptionVolMult: 1.5,
    intradayOfAbsorptionRangeAtrMult: 1.0,
    intradayOfStackDeltaRatio: 0.75,
    intradayOfBookImbalanceMin: 0.65,
    intradayOfSoloMinScore: 7,
    intradayOfVetoMode: false,
    intradayOfMinPartialScore: 6,
    intradayOfConfluenceMode: "full",
    intradayOfAllowCvdOnly: false,
    intradayOfRequirePremiumDiscount: true,
    intradayOfTp1Enabled: true,
    intradayOfTp2Enabled: true,
    intradayOfPartialFrac: 0.4,
    intradayOfMinRr: 1.5,
    intradayOfBreakevenAfterPartial: true,
    intradayOfApproachLookback: 8,
    intradayOfEntryAtSignalClose: false,
    intradayOfExitOnDeltaAgainst: true,
    intradayOfExitGraceBars: 3,
    intradayOfExitMinDeltaRatio: 0.4,
    intradayOfMaxHoldBars: 48,
    intradaySmcUseOrderFlow: false,
    intradayGateHtfRegime: true,
    intradayGateInstitutionalSr: false,
    intradayGateSmcIct: false,
    intradaySmcIctMode: false,
    intradaySmcIctProfile: "sweep",
    intradaySmcPickMode: "per_signal",
    intradaySmcOneTradePerDay: false,
    intradaySmcMinScore: 7,
    intradaySmcRequireHtfBias: true,
    intradaySmcChochStrict: false,
    intradaySmcRequireMss: false,
    intradaySmcRequireRetrace: false,
    intradaySmcRequireChoch: false,
    intradaySmcRequireBos: false,
    intradaySmcRequireConfirm: false,
    intradaySmcRequireFvgRetrace: false,
    intradaySmcRequirePremiumDiscount: false,
    intradaySmcPremiumDiscountOte: false,
    intradaySmcDealingRangeLookback: 48,
    intradaySmcLookbackBars: 30,
    intradaySmcMinRr: 1.5,
    intradaySmcBosMaxBars: 5,
    intradaySmcChochMaxBars: 8,
    intradaySmcEntryZoneMode: "EITHER",
    intradaySmcFvgEntryMode: "zone",
    intradaySmcTp2Mode: "opposing",
    intradaySmcKillzoneMode: "LONDON_NY",
    intradaySmcMinAdx: 15,
    intradaySmcHtfStrictness: "either",
    intradaySmcHtfBiasMode: "parallel",
    intradaySmcSlMode: "structure",
    intradaySmcMaxTpRr: 5,
    intradaySmcMaxHoldBars: 48,
    intradaySrAPlusMode: false,
    intradaySrMinVolRatio: clamp(Number(process.env.INTRADAY_SR_MIN_VOL_RATIO ?? 1.2), 0, 5),
    intradaySrMinHtfSep: clamp(Number(process.env.INTRADAY_SR_MIN_HTF_SEP ?? 0.0004), 0, 0.01),
    intradaySrZoneWidthPct: clamp(Number(process.env.INTRADAY_SR_ZONE_WIDTH_PCT ?? 0.002), 0.0001, 0.02),
    intradaySrBosMaxBarsAfterReclaim: clamp(
      Math.round(Number(process.env.INTRADAY_SR_BOS_MAX_BARS ?? 3)),
      0,
      10,
    ),
    intradaySrMinConfirmWick: clamp(Number(process.env.INTRADAY_SR_MIN_CONFIRM_WICK ?? 0.38), 0, 1),
    intradaySrRequireBos: true,
    intradaySrRequireConfirm: true,
    intradaySrRequireVolume: true,
    intradaySrRequireHtfTrend: true,
    /** Liquidity sweep exit legs (INTRADAY_PRO liq solo). */
    intradayLiqTp1Enabled: true,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: true,
    intradayLiqPartialTp: true,
    intradayLiqPartialFrac: 0.5,
    intradayLiqTp1Rr: 1,
    intradayLiqTp2Rr: 0,
    intradayLiqTp2PartialFrac: 0,
    intradayLiqMinRr: clamp(Number(process.env.INTRADAY_LIQ_MIN_RR ?? 1.5), 0, 5),
    intradayLiqMaxTpRr: clamp(Number(process.env.INTRADAY_LIQ_MAX_TP_RR ?? 5), 0, 20),
    intradayLiqMaxHoldBars: 0,
    liqMapLookbackBars: 72,
    liqMapMaxAgeBars: 72,
    liqMapMinTouches: 1,
    liqMapMinWickRatio: 0.25,
    liqMapMinRvol: 1.1,
    liqMapMinBodyRatio: 0,
    liqMapSweepPct: 0.0006,
    liqMapEqualTolPct: 0.0008,
    liqMapNormalizeThresholds: true,
    liqMapSweepAtrFrac: 0.13,
    liqMapEqualTolAtrFrac: 0.18,
    liqMapAutoCalibrate: true,
    liqMapAutoTrailTune: true,
    liqMapHybridExit: true,
    liqMapAutoProfileBars: 200,
    liqMapQualityGate: false,
    liqMapQualityGateMode: "HARD",
    liqMapSoftGateScoreBand: 0.25,
    liqMapQualityAuto: true,
    liqMapMinQualityScore: 6.2,
    liqMapRequireUnresolved: true,
    liqMapRequireDirectionalClose: true,
    liqMapEntryModel: "HTF_SWEEP",
    liqMapHtfPoolTfs: "1h,4h",
    liqMapHtfLookbackBars: 72,
    liqMapHtfSwingLeft: 2,
    liqMapHtfSwingRight: 2,
    liqMapHtfEqualMinTouches: 2,
    liqMapUseDailyWeeklyPools: true,
    liqMapUseTrendlinePools: true,
    liqMapEntryTiming: "FVG_OR_OB",
    liqMapRequireMss: true,
    liqMapRequireChoch: false,
    liqMapRequireRetrace: true,
    liqMapRequireReclaimHold: true,
    liqMapStructureLookbackBars: 24,
    liqMapMssMaxBarsAfterSweep: 10,
    liqMapEntryZoneMode: "FVG",
    liqMapFvgEntryMode: "ZONE",
    liqMapMssRequireDisplacement: true,
    liqMapDisplacementBodyMult: 1.15,
    liqMapDisplacementAtrMult: 0.35,
    liqMapFvgMinGapPct: 0.00005,
    liqMapStrictPdZone: true,
    liqMapObMinDisplacementAtr: 0.6,
    liqMapRr: 1.25,
    liqMapHtfMode: "against",
    liqMapKillzone: "ALL",
    liqMapMinAtrPctile: 0,
    liqMapMaxAtrPctile: 0,
    liqMapAtrPctileLookback: 2880,
    liqMapMinAdx: 0,
    liqMapMaxAdx: 0,
    liqMapMinAtrPct: 0,
    liqMapMaxAtrPct: 0,
    liqMapMaxHoldBars: 0,
    liqMapMaxSlPct: 0.05,
    liqMapSlBufferPct: 0.0015,
    liqMapSlBufferAtrFrac: 0.2,
    liqMapOnePerDay: true,
    liqMapOnePerSidePerDay: false,
    liqMapExitMode: "SCALED_FIXED",
    liqMapTrailMode: "SUPERTREND",
    liqMapMaxTpRr: 10,
    liqMapMaxOpposingRr: 2,
    liqMapPartialFrac: 0.75,
    liqMapBreakevenAfterPartial: false,
    liqMapUse4hConfirm: false,
    liqMapSlMode: "ATR_FLOOR",
    liqMapAtrSlMult: 1.0,
    liqMapSlRegimeAdjust: true,
    liqMapSlRegimeLowMult: 0.75,
    liqMapSlRegimeHighMult: 1.15,
    liqMapTrailStPeriod: 10,
    liqMapTrailStMult: 3.0,
    liqMapTrailAtrHwmMult: 2.75,
    liqMapTrailMfeGiveback: 0.16,
    liqMapTrailMfeMinR: 1.5,
    liqMapTrailStepAtrMult: 0.6,
    liqMapTrailMergeSt: true,
    liqMapDynamicRunnerMaxTpRr: 15,
    liqMapDynamicRunnerMinTpRr: 3,
    liqMapProjectedTpAtrMult: 4,
    liqMapProjectedTpRangeMult: 0.5,
    liqMapProjectionLookbackBars: 24,
    liqMapDynamicExitPolicy: false,
    liqMapDynExitQualityHi: 6.4,
    liqMapDynExitQualityMid: 5.8,
    liqMapDynExitRrHi: 3.0,
    liqMapDynExitRrMid: 2.0,
    liqMapDynExitPartialHi: 0.35,
    liqMapDynExitPartialMid: 0.5,
    liqMapDynExitPartialBase: 0.75,
    liqMapDynExitTrailAtrHi: 5.5,
    liqMapDynExitTrailAtrMid: 4.5,
    liqMapDynExitTrailAtrBase: 3.0,
    liqMapDynExitWeakTp1Rr: 0.7,
    liqMapDeadTradeExitBars: 0,
    liqMapDeadTradeMinMfeR: 0.5,
    liqMapDeadTradeMaxLossR: 0.55,
    liqMapStructuralTp1Rr: 0.75,
    ...volumeProfilePublicSnapshot({
      vpLookbackBars: clamp(Math.round(Number(process.env.VP_LOOKBACK_BARS ?? 672)), 48, 2000),
      vpMinRR: clamp(Number(process.env.VP_MIN_RR ?? 1.5), 0.8, 5),
    }),

    /**
     * Unified Supertrend entry filter (indicator section): signal strength + move quality targeting T1+.
     * Replaces separate signal-strength / move-quality gates when enabled. Not the intelligence gate.
     */
    supertrendBigMoveGateEnabled: false,
    supertrendBigMoveMinStrength: clamp(
      Math.round(Number(process.env.SUPERTREND_BIG_MOVE_MIN_STRENGTH ?? BIG_MOVE_DEFAULTS.minStrength)),
      0,
      100,
    ),
    supertrendBigMoveMinMoveSlRatio: Math.max(1, Number(process.env.SUPERTREND_BIG_MOVE_MIN_MOVE_SL_RATIO ?? BIG_MOVE_DEFAULTS.minMoveToSlRatio)),
    supertrendBigMoveMinAdx: clamp(Math.round(Number(process.env.SUPERTREND_BIG_MOVE_MIN_ADX ?? BIG_MOVE_DEFAULTS.minAdx)), 0, 100),
    supertrendBigMoveMinScore: clamp(Number(process.env.SUPERTREND_BIG_MOVE_MIN_SCORE ?? BIG_MOVE_DEFAULTS.minScore), 0, 1),
    supertrendBigMoveMaxCandlesSinceFlip: Math.max(
      0,
      Math.min(20, Math.floor(Number(process.env.SUPERTREND_BIG_MOVE_MAX_CANDLES_SINCE_FLIP ?? BIG_MOVE_DEFAULTS.maxCandlesSinceFlip))),
    ),
    supertrendBigMoveMinVolumeVsAvg: Math.max(0, Number(process.env.SUPERTREND_BIG_MOVE_MIN_VOLUME_VS_AVG ?? BIG_MOVE_DEFAULTS.minVolumeVsAvg)),
    supertrendBigMoveExpectedMoveAtrMult: Math.max(
      0.1,
      Number(process.env.SUPERTREND_BIG_MOVE_EXPECTED_MOVE_ATR_MULT ?? BIG_MOVE_DEFAULTS.expectedMoveAtrMult),
    ),
    /** Min ATR/avgATR expansion; 0 = disable this hard check. */
    supertrendMoveQualityMinAtrExpansion: Math.max(0, Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_ATR_EXPANSION ?? 1.08)),
    /** Skip if signal bar body vs avg body ratio is below this (noise filter). */
    supertrendMoveQualityMinBodyVsAvg: clamp(Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_BODY_VS_AVG ?? 0.62), 0.15, 1),
    /** 0 = off. Else require signed (close−open)/range vs direction (stronger than abs body ratio). */
    supertrendMoveQualityMinDirectionalBody: clamp(Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_DIRECTIONAL_BODY ?? 0), 0, 1),
    /** 0 = off. Else last vol must be ≥ SMA(vol)×this (e.g. 1.2). */
    supertrendMoveQualityMinVolumeVsAvg: Math.max(0, Number(process.env.SUPERTREND_MOVE_QUALITY_MIN_VOLUME_VS_AVG ?? 0)),

    /**
     * SUPERTREND_ELITE strategy gate config.
     * Gate 1 (ADX), Gate 2 (Volume), Gate 3 (1H EMA), Gate 4 (4H ST), Gate 5 (ATR exp), Bonus (LiqSweep).
     * All gates are individually configurable. Default: 4H alignment only (the proven high-WR gate).
     */
    eliteStRequireHtf4hAlign:     ["1","true","yes"].includes(String(process.env.ELITE_ST_REQUIRE_HTF4H_ALIGN ?? "true").toLowerCase()),
    eliteStHtf4hPeriod:           clamp(Math.round(Number(process.env.ELITE_ST_HTF4H_PERIOD ?? 10)), 2, 50),
    eliteStHtf4hMultiplier:       Math.max(0.5, Number(process.env.ELITE_ST_HTF4H_MULTIPLIER ?? 3)),
    eliteStRequireHtf1hEmaAlign:  ["1","true","yes"].includes(String(process.env.ELITE_ST_REQUIRE_HTF1H_EMA_ALIGN ?? "true").toLowerCase()),
    eliteStHtf1hMinSep:           Math.max(0, Number(process.env.ELITE_ST_HTF1H_MIN_SEP ?? 0.0005)),
    /** FIXED | ATR | PERCENTILE | ADX | CALIBRATED — Gate 3 dynamic EMA min-separation */
    eliteStHtf1hSepMode:          String(process.env.ELITE_ST_HTF1H_SEP_MODE ?? "FIXED").toUpperCase(),
    eliteStHtf1hMinSepAtrMult:    clamp(Number(process.env.ELITE_ST_HTF1H_MIN_SEP_ATR_MULT ?? 0.25), 0.05, 2),
    eliteStHtf1hMinSepFloor:      clamp(Number(process.env.ELITE_ST_HTF1H_MIN_SEP_FLOOR ?? 0.0002), 0, 0.01),
    eliteStHtf1hMinSepCeil:       clamp(Number(process.env.ELITE_ST_HTF1H_MIN_SEP_CEIL ?? 0.0012), 0, 0.01),
    eliteStHtf1hSepPercentileLookback: clamp(Math.round(Number(process.env.ELITE_ST_HTF1H_SEP_PCT_LOOKBACK ?? 90)), 20, 200),
    eliteStHtf1hSepPercentileMult:     clamp(Number(process.env.ELITE_ST_HTF1H_SEP_PCT_MULT ?? 1), 0.5, 3),
    eliteStHtf1hSepAdxBase:       clamp(Number(process.env.ELITE_ST_HTF1H_SEP_ADX_BASE ?? 0.0003), 0, 0.01),
    eliteStHtf1hSepAdxAlpha:      clamp(Number(process.env.ELITE_ST_HTF1H_SEP_ADX_ALPHA ?? 1.5), 0, 5),
    eliteStHtf1hSepAdxRef:        clamp(Math.round(Number(process.env.ELITE_ST_HTF1H_SEP_ADX_REF ?? 25)), 1, 100),
    eliteStHtf1hSepCalibratePct:  clamp(Math.round(Number(process.env.ELITE_ST_HTF1H_SEP_CALIB_PCT ?? 40)), 1, 99),
    eliteStHtf1hSepCalibrateBars: clamp(Math.round(Number(process.env.ELITE_ST_HTF1H_SEP_CALIB_BARS ?? 90)), 20, 200),
    eliteStMinAdx:                Math.max(0, Number(process.env.ELITE_ST_MIN_ADX ?? 0)),
    eliteStRequireAdxRising:      false,
    eliteStAdxRisingLookback:     Math.max(1, Math.round(Number(process.env.ELITE_ST_ADX_RISING_LOOKBACK ?? 3))),
    eliteStMinVolumeVsAvg:        Math.max(0, Number(process.env.ELITE_ST_MIN_VOLUME_VS_AVG ?? 0)),
    eliteStRequireAtrExpansion:   false,
    eliteStMinAtrExpansion:       Math.max(1, Number(process.env.ELITE_ST_MIN_ATR_EXPANSION ?? 1.15)),
    eliteStAtrExpansionLookback:  Math.max(2, Math.round(Number(process.env.ELITE_ST_ATR_EXPANSION_LOOKBACK ?? 12))),
    eliteStLiqSweepEnabled:       false,
    /** Auto-calibrate gate thresholds + brackets per symbol from warmup bars. */
    eliteStAutoCalibrate:         false,
    eliteStAutoProfileBars:       clamp(Math.round(Number(process.env.ELITE_ST_AUTO_PROFILE_BARS ?? 90)), 40, 200),
    /** ATR = vol-scaled SL/TP; OFF = trail-only; FIXED = manual panel brackets */
    eliteStAutoBracketMode:       String(process.env.ELITE_ST_AUTO_BRACKET_MODE ?? "ATR").toUpperCase(),
    eliteStAutoMinAdxFloor:       clamp(Math.round(Number(process.env.ELITE_ST_AUTO_MIN_ADX_FLOOR ?? 15)), 0, 100),
    eliteStAutoMinAdxCeil:        clamp(Math.round(Number(process.env.ELITE_ST_AUTO_MIN_ADX_CEIL ?? 30)), 1, 100),

    /**
     * When true, defer entry until a later bar **closes** beyond signal candle high (BUY) or low (SELL).
     * Single-chart `processBarCloseTrading` only; AUTO multi sweep still uses immediate entry.
     */
    supertrendBreakoutConfirm: ["1", "true", "yes"].includes(
      String(process.env.SUPERTREND_BREAKOUT_CONFIRM ?? "0").toLowerCase(),
    ),
    /** Max closed bars to wait after signal before dropping a pending breakout. */
    supertrendBreakoutMaxBars: Math.max(1, Math.min(20, Math.floor(Number(process.env.SUPERTREND_BREAKOUT_MAX_BARS ?? 5)))),
    /**
     * Suggested min SS (0–100) from historical list outcomes vs composite strength; blended with prior on restart.
     * @type {number | null}
     */
    smartSignalStrengthThreshold: null,
    /** @type {Record<string, unknown> | null} */
    smartSignalStrengthThresholdMeta: null,
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
    /** When false, autotrade opens without a fixed-% stop (exit via flip/trail/time only). */
    supertrendFuturesUseFixedSl: true,
    /** When false, autotrade opens without a fixed-% take-profit. */
    supertrendFuturesUseFixedTp: true,
    /** Enable/disable SurfPulse ML probability gate for SURF_PULSE_ML opens. */
    surfPulseMlGateEnabled: String(process.env.SURF_PULSE_ML_GATE_ENABLED ?? "1").toLowerCase() !== "0",
    /** Enable market intelligence gate — skips trades when high-confidence signals oppose direction. Default off until tested. */
    intelligenceGateEnabled: String(process.env.INTELLIGENCE_GATE_ENABLED ?? "0").toLowerCase() !== "0",
    /** Stricter composite bands + neutral chop block (mirrors backtest `intelligenceGateStrict`). */
    intelligenceGateStrict: false,
    intelligenceGateHighWinRate: false,
    /** When false (default), intelligence gate skips MANUAL bar-close adapter opens (backtest parity). */
    intelligenceGateManualStrategies: false,
    /** When false, skip opposite ST flip orders while a futures leg is open (exit via SL/trail/TP on exchange). */
    supertrendFuturesExitOnFlip: true,
    /** Min XGBoost win probability (0–1) for SURF_PULSE_ML opens; default from env `SURF_PULSE_ML_THRESHOLD`. */
    surfPulseMlThreshold: clamp(Number(process.env.SURF_PULSE_ML_THRESHOLD ?? 0.6), 0, 1),
    /** Futures autotrade: fee breakeven, fee-based first scalping, then optional %-of-entry locks (see `trailingStopLoss.js`). */
    trailingStopLossAuto: false,
    /** When true, trailing only arms after the TP2 partial leg fills (liq 3-stage ladder). */
    trailOnlyAfterTp2Fill: false,
    /** `SUPERTREND` = ST line + fee activation (see `supertrendTrailingSl.js`). `FEE_LADDER` = discrete fee/% locks (`advanceTrailingStopState`). */
    futuresTrailingStopMode: "SUPERTREND",
    /** Supertrend mode: fee breakeven floor / activation (see `computeSupertrendTrailingSlUpdate`). HTF_RSI backtests: off + advanced on beats tiered T01/T02. */
    futuresTrailingStFeeBreakeven: false,
    /** Supertrend mode: follow Supertrend line (with BE floor when fee breakeven is also on). */
    futuresTrailingStAdvanced: true,
    /** Up to 3 extra trailing locks, each % of entry (e.g. 0.5 = 0.5%). */
    trailingStopExtraScalpingPcts: [],
    /**
     * Configurable trailing metrics (all modes). Env vars supply the default values shown here.
     * UI: TradingPanel → "Supertrend-based" / "Fee ladder" (`TrailMetricGroup`). See also
     * `frontend/src/lib/trailingFeeLadder.ts` file header for field → engine mapping.
     *
     * Fee inputs (used by both SUPERTREND and FEE_LADDER):
     * `trailOpenFeeRate`  — taker/maker fee for opening the position (fraction; e.g. 0.0004 = 0.04%).
     *                       Defaults to `TRADE_OPEN_FEE_RATE ?? TRADE_CLOSE_FEE_RATE`.
     * `trailCloseFeeRate` — taker fee for SL exit (fraction; e.g. 0.0004 = 0.04%).
     *                       Defaults to `TRADE_CLOSE_FEE_RATE`.
     * Round-trip fee = openFee + closeFee (e.g. 0.04% + 0.04% = 0.08%).
     *
     * SUPERTREND-specific (tiered T01 → T02 → ST ladder):
     *
     * Lock semantics (what price the SL is SET TO when each tier triggers):
     *   T01 lock = entry                         (zero-loss point: gross = 0, net = -round-trip fee)
     *   T02 lock = entry × (1 ± round-trip fee)  (break-even point: gross = fees, net ≈ 0)
     *
     * Activation prices (when mark must exceed before the lock moves):
     *   T01 activation = entry × (1 ± trailBufferRate)                        (default buf 0.05%)
     *   T02 activation = entry × (1 ± (paddedFee + trailBufferRate))          (default fee 0.08% + buf 0.05% = 0.13%)
     *
     * `trailFeeBeMultiplier` — safety × on round-trip fee for the T02 lock / activation. Default 1.0 (exact BE).
     *                           Raising it (e.g. 1.25) covers stop-market slippage but delays T02 firing and means
     *                           T02 lock gross > fees instead of equal to fees.
     * `trailBufferRate`      — activation buffer (fraction; default 0.0005 = 0.05%): T01 needs +buf, T02 needs +(fee+buf).
     * `trailActivationSlippageFrac` — added to padded fee rate for Supertrend tiered gates only (execution cushion; cap 1%).
     * `trailT01LockSlippageFrac` — tiered T01 only: SL lock offset from entry (LONG: above entry; SHORT: below); cap 1%.
     *                               Default 0 (T01 locks AT entry per the "zero-loss" spec). Set a small positive value
     *                               (e.g. 0.0002 = 2 bp) only if you want T01 to lock a tick or two past entry to clear
     *                               sub-tick mark-price noise. NOTE: a value > trailFeeBeMultiplier × round-trip fee will
     *                               make T01 lock above T02 lock and silently disable T02 (merge picks max for long).
     * `trailBufferMode`      — `PERCENT` = use `trailBufferRate` only; `ATR` = buffer = min(5%, atrPct × trailBufferAtrMult) when regime ATR exists, else `trailBufferRate`.
     * `trailBufferAtrMult`   — multiplier on `lastRegime.atrPct` when `trailBufferMode` is `ATR`.
     * `trailMinSlDistFrac`   — minimum fractional improvement the new SL must make (default 0.002 = 0.2%).
     * `trailMinGapFromMarkFrac` — min |mark−SL|/mark when trailing (0 = off); loosens SL vs mark so small pullbacks do not stop (e.g. 0.005 = 0.5%).
     * `trailMaintMarginRate` — liquidation guard rate for open-rejection check (default 0.005 = 0.5%).
     */
    trailOpenFeeRate: clamp(
      Number(process.env.TRADE_OPEN_FEE_RATE ?? process.env.TRADE_CLOSE_FEE_RATE ?? 0.0004), 0, 0.01,
    ),
    trailCloseFeeRate: clamp(Number(process.env.TRADE_CLOSE_FEE_RATE ?? 0.0004), 0, 0.01),
    /** Portfolio trade-history modeled fees (fraction of notional); maker vs taker entry/exit. */
    tradeHistoryMakerOpenFeeRate: clamp(
      Number(process.env.TRADE_HISTORY_MAKER_OPEN_FRAC ?? 0.0002),
      0,
      0.01,
    ),
    tradeHistoryMakerCloseFeeRate: clamp(
      Number(process.env.TRADE_HISTORY_MAKER_CLOSE_FRAC ?? 0.0002),
      0,
      0.01,
    ),
    tradeHistoryTakerOpenFeeRate: clamp(
      Number(process.env.TRADE_HISTORY_TAKER_OPEN_FRAC ?? 0.0005),
      0,
      0.01,
    ),
    tradeHistoryTakerCloseFeeRate: clamp(
      Number(process.env.TRADE_HISTORY_TAKER_CLOSE_FRAC ?? 0.0005),
      0,
      0.01,
    ),
    trailFeeBeMultiplier: clamp(Number(process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1.0), 1, 2),
    trailBufferRate: clamp(Number(process.env.SUPERTREND_TRAIL_BUFFER_RATE ?? 0.0015), 0, 0.05),
    /** Additive fraction on padded BE rate for Supertrend tiered gates (execution vs theoretical fees). */
    trailActivationSlippageFrac: clamp(Number(process.env.FUTURES_TRAIL_ACTIVATION_SLIPPAGE_FRAC ?? 0), 0, 0.01),
    /** Tiered Supertrend T01: SL lock offset from entry. Default 0 — T01 lock = entry (zero-loss point per spec). */
    trailT01LockSlippageFrac: clamp(Number(process.env.FUTURES_TRAIL_T01_LOCK_SLIPPAGE_FRAC ?? 0), 0, 0.01),
    /** With `trailBufferMode: "ATR"`: buffer = min(5%, atrPct × this). Ignored in PERCENT mode. */
    trailBufferAtrMult: clamp(Number(process.env.FUTURES_TRAIL_BUFFER_ATR_MULT ?? 0), 0, 1),
    /** `"PERCENT"` = fixed `trailBufferRate`; `"ATR"` = scale buffer from regime ATR (see `trailBufferAtrMult`). */
    trailBufferMode: (() => {
      const u = String(process.env.FUTURES_TRAIL_BUFFER_MODE ?? "PERCENT").toUpperCase();
      return u === "ATR" ? "ATR" : "PERCENT";
    })(),
    /**
     * Activation buffer for **post-T02 profit rungs only** (T1, T2, T3…). Decoupled from
     * `trailBufferRate` so users can keep T01/T02 glued to entry (fast loss-protection activation)
     * while giving every advance profit tier a larger pull-back cushion. `null` = fall back to
     * `trailBufferRate` (legacy single-buffer behaviour). Fraction of price (cap 5%).
     */
    trailPostT02ActivationBufferRate: (() => {
      const x = Number(process.env.FUTURES_TRAIL_POST_T02_ACTIVATION_BUFFER_RATE);
      if (Number.isFinite(x) && x >= 0) return clamp(x, 0, 0.05);
      return 0.0014;
    })(),
    trailMinSlDistFrac: clamp(Number(process.env.SUPERTREND_TRAIL_MIN_SL_DISTANCE_FRAC ?? 0.002), 0, 0.1),
    trailMinGapFromMarkFrac: clamp(Number(process.env.SUPERTREND_TRAIL_MIN_GAP_FROM_MARK_FRAC ?? 0), 0, 0.2),
    trailMaintMarginRate: clamp(Number(process.env.SUPERTREND_TRAIL_MAINTENANCE_MARGIN_RATE ?? 0.005), 0, 0.1),
    /**
     * Tiered ST post‑T02: spacing between successive lock rungs as a fraction of entry (e.g. 0.001 = 0.1% of entry).
     * `null` = engine default `min(2%, max(2×roundTrip, 0.04%))`.
     */
    trailPostT02SpacingFrac: (() => {
      const x = Number(process.env.TRAIL_POST_T02_SPACING_FRAC);
      return Number.isFinite(x) && x > 0 ? clamp(x, 0.00001, 0.05) : 0.002;
    })(),
    /** Max post‑T02 tiers (T1…); total trail steps cap ≈ 3 + this (with floor/ceiling in `maxTrailStepsForConfig`). */
    trailPostT02MaxExtraTiers: Math.max(
      10,
      Math.min(500, Math.floor(Number(process.env.TRAIL_POST_T02_MAX_EXTRA_TIERS ?? 150))),
    ),
    /** `FIXED_PCT` = tiered fee ladder; `DYNAMIC` = ATR/MFE chandelier (LIQUIDITY_MAP runner). */
    trailSizingMode: (() => {
      const m = String(process.env.TRAIL_SIZING_MODE ?? "FIXED_PCT").toUpperCase();
      return m === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT";
    })(),
    trailDynamicAdvAtrHwmMult: clamp(Number(process.env.TRAIL_DYNAMIC_ADV_ATR_HWM_MULT ?? 2.5), 0, 6),
    trailDynamicAdvMfeGivebackFrac: clamp(Number(process.env.TRAIL_DYNAMIC_ADV_MFE_GIVEBACK_FRAC ?? 0.18), 0, 0.9),
    trailDynamicAdvMfeMinR: clamp(Number(process.env.TRAIL_DYNAMIC_ADV_MFE_MIN_R ?? 1.2), 0, 10),
    trailDynamicAdvPostT02StepAtrMult: clamp(Number(process.env.TRAIL_DYNAMIC_ADV_POST_T02_STEP_ATR_MULT ?? 0.6), 0, 2),
    trailDynamicAdvMergeSupertrend: String(process.env.TRAIL_DYNAMIC_ADV_MERGE_ST ?? "1").toLowerCase() !== "0",
    trailDynamicAdvAtrSource: "ROLLING",
    /**
     * Futures Supertrend: false = 1-way (BUY opens long; SELL closes long only).
     * true = 2-way (BUY closes short then opens long; SELL closes long then opens short).
     */
    supertrendFuturesTwoWay: false,
    /**
     * USD-M Supertrend entry execution (mirrors env `SUPERTREND_FUTURES_*`; persisted in bot-trading-config.json).
     * `supertrendFuturesEntryOpenStyle` AUTO = LIMIT_IOC when slippage % > 0 else MARKET.
     */
    supertrendFuturesMaxEntrySlippagePct: (() => {
      const e = process.env.SUPERTREND_FUTURES_MAX_ENTRY_SLIPPAGE_PCT;
      const n = e === undefined || e === "" ? 0.15 : Number(e);
      return Number.isFinite(n) ? clamp(n, 0, 5) : 0.15;
    })(),
    supertrendFuturesEntryOpenStyle: (() => {
      const e = process.env.SUPERTREND_FUTURES_OPEN_STYLE;
      if (e === undefined || e === null || String(e).trim() === "") return "AUTO";
      const u = String(e).trim().toUpperCase();
      if (u === "MARKET" || u === "LIMIT_IOC") return u;
      return "AUTO";
    })(),
    supertrendFuturesEntryRecheckMs: Math.max(0, Math.floor(Number(process.env.SUPERTREND_FUTURES_ENTRY_RECHECK_MS ?? 0))),
    supertrendFuturesIocFallbackMarket: truthyEnv(process.env.SUPERTREND_FUTURES_IOC_FALLBACK_MARKET ?? "0"),
    supertrendFuturesRequireMarkPrice: truthyEnv(process.env.SUPERTREND_FUTURES_REQUIRE_MARK_PRICE ?? "0"),
    supertrendFuturesRequireBookTicker: truthyEnv(process.env.SUPERTREND_FUTURES_REQUIRE_BOOK_TICKER ?? "0"),
    supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(Number(process.env.SUPERTREND_FUTURES_MAX_SIGNAL_LAG_MS ?? 0))),
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    trendHtfStRegimeGate: false,
    trendHtfStSurgicalLossFilter: false,
    trendHtfStQualityFilter: false,
    trendHtfStFlipExitBeforeSl: false,
    trendHtfStMaxEntryRangeAtr: 2,
    trendHtfStMinHtfSep: 0.0005,
    trendHtfStRegimeTpTrend: 0.03,
    trendHtfStRegimeTpMixed: 0.035,
    trendHtfStRegimeTpChop: 0.04,
    backtestBreakevenAtMfePct: 0,
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
    /**
     * Primary-chart breakout confirmation: after a Supertrend flip, wait until close breaks signal high/low.
     * @type {{ symbol: string, side: "BUY"|"SELL", signalBarTs: number, signalHigh: number, signalLow: number, stSpot: boolean, stFut: boolean, barsWaited: number, maxBars: number } | null}
     */
    pendingSupertrendBreakout: null,
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
      /** Manual SL/TP: percent of price (e.g. "1" = 1%); API still uses fraction. */
      slPctStr: "0.2",
      tpPctStr: "1.5",
    },
    /**
     * Per-symbol Supertrend bar-close snapshots for multi-coin watch (WS + sweep). UI tabs; not persisted to disk.
     * @type {Record<string, { ts: number, buySignal: boolean, sellSignal: boolean, trend: number | null, strength01: number | null, signalStrength: number | null, stAction: string | null, aiGateBuy: number | null, aiGateSell: number | null, bufferBars: number | null, updatedAt: number, source?: string, marketDecisionSnapshot?: object | null }>}
     */
    multiSymbolWatchSignals: Object.create(null),
    /**
     * Multi-coin UI: which symbol the main chart focuses (live `market` + ST overlay). Null = `symbol`.
     * Ephemeral — not written to bot-trading-config.json.
     */
    uiChartFocusSymbol: null,
    /** Partial market decision engine config; merged with defaults in `getPublicState`. */
    marketDecision: Object.create(null),
  };

  /**
   * Paper: use Binance **public** OHLCV / depth (same math as demo & live) while orders stay on local paper legs.
   * Demo/testnet/live: explicit `MARKET_FEED=BINANCE|BINANCE_FUTURES` overrides; if unset or SYNTH, default
   * matches paper (SPOT → BINANCE, else BINANCE_FUTURES). Paper opt-out: `PAPER_MARKET_FEED=SYNTH`.
   */
  function effectiveMarketFeedKind() {
    const tm = runtimeTradingMode();
    const g = String(process.env.MARKET_FEED || "SYNTH").toUpperCase();
    if (tm !== "PAPER") {
      // Production guard: futures trading should not use spot klines. When user sets MARKET_FEED=BINANCE
      // but the bot is trading futures (marketMode FUTURES/AUTO with futures), prefer the futures feed.
      if (g === "BINANCE_FUTURES") return "BINANCE_FUTURES";
      if (g === "BINANCE") {
        const mm = String(state.marketMode || "AUTO").toUpperCase();
        const futOn = Boolean(state.supertrendFuturesAuto);
        const spotOn = Boolean(state.supertrendSpotAuto);
        let wantsFutures = mm === "FUTURES" || (mm === "AUTO" && futOn && !spotOn);
        /**
         * `MARKET_FEED=BINANCE` is ambiguous: many deployments (and Binance geo rules) block **spot**
         * `api.binance.com` / `stream.binance.com` while **USD-M** `fapi` / `fstream` still works — live then
         * looks "stuck" / Feed: stale while demo (demo-fapi + fstream.binancefuture.com) is fine.
         * If Market is AUTO and neither Supertrend leg is chosen yet, default strict exchange modes to **futures**
         * OHLCV so the chart matches the usual USD-M venue. Use Market **SPOT** or `MARKET_FEED=BINANCE_FUTURES`
         * / `BINANCE` + futures toggles to force a venue explicitly.
         */
        if (
          !wantsFutures &&
          mm === "AUTO" &&
          !futOn &&
          !spotOn &&
          (tm === "BINANCE_LIVE" || tm === "BINANCE_DEMO_API" || tm === "BINANCE_TESTNET")
        ) {
          wantsFutures = true;
        }
        return wantsFutures ? "BINANCE_FUTURES" : "BINANCE";
      }
      // Paper defaults to public Binance when MARKET_FEED is SYNTH; demo/testnet/live used to fall through
      // to SYNTH here — charts then had no real klines unless MARKET_FEED was set explicitly.
      if (
        g === "SYNTH" &&
        (tm === "BINANCE_DEMO_API" || tm === "BINANCE_TESTNET" || tm === "BINANCE_LIVE")
      ) {
        const mm = String(state.marketMode || "AUTO").toUpperCase();
        return mm === "SPOT" ? "BINANCE" : "BINANCE_FUTURES";
      }
      return "SYNTH";
    }
    const paperExplicit = String(process.env.PAPER_MARKET_FEED || "").trim().toUpperCase();
    if (paperExplicit === "SYNTH" || paperExplicit === "BINANCE" || paperExplicit === "BINANCE_FUTURES") {
      return paperExplicit;
    }
    if (g === "BINANCE" || g === "BINANCE_FUTURES") return g;
    const mm = String(state.marketMode || "AUTO").toUpperCase();
    return mm === "SPOT" ? "BINANCE" : "BINANCE_FUTURES";
  }

  /** Spot or USDT-M public feed: enables depth WS + universe scan (AUTO symbol), REST klines helper. */
  function marketFeedUsesLiveBinance() {
    const k = effectiveMarketFeedKind();
    return k === "BINANCE" || k === "BINANCE_FUTURES";
  }

  /** Periodic Binance universe scan + auto primary rotation (`UNIVERSE_SCAN_ENABLED=1` to opt in). */
  function universeScanEnabled() {
    return String(process.env.UNIVERSE_SCAN_ENABLED || "0") !== "0";
  }

  function buildUniverseStubFromUiCandidates() {
    const syms = resolveMultiCoinUiSymbolCandidates();
    const ranked = syms.map((symbol) => ({
      symbol,
      score: 0,
      aiProb: null,
      opportunity: null,
      spreadPct: null,
    }));
    return {
      ok: true,
      asOf: new Date().toISOString(),
      timeframe: state.timeframe,
      ranked,
      selected: syms.slice(0, 3),
      tradable: syms.length,
      universeSize: syms.length,
      emptyCustom: syms.length === 0,
      scanDisabled: true,
    };
  }

  function binanceDepthWsBase() {
    const k = effectiveMarketFeedKind();
    const tm = String(runtimeTradingMode() || "").toUpperCase();
    /** Partial depth is a **Public** stream; do not reuse `/market/ws` from kline env. */
    function futuresDepthBaseFromEnv() {
      const depthFirst =
        String(process.env.BINANCE_FUTURES_DEPTH_WS_BASE || "").trim() ||
        String(process.env.BINANCE_LIVE_FUTURES_DEPTH_WS_BASE || "").trim();
      if (depthFirst) {
        let r = depthFirst;
        if (/fstream\.binance/i.test(r) && /\/market\//i.test(r)) r = r.replace(/\/market\//gi, "/public/");
        return routeBinanceUsdmWsBase(r, "public");
      }
      const chain = [
        tm === "BINANCE_DEMO_API" ? process.env.BINANCE_DEMO_FUTURES_WS_BASE : null,
        tm === "BINANCE_DEMO_API" || tm === "BINANCE_TESTNET" ? process.env.BINANCE_FUTURES_TESTNET_WS_BASE : null,
        tm === "BINANCE_LIVE" ? process.env.BINANCE_LIVE_FUTURES_WS_BASE : null,
        process.env.BINANCE_FUTURES_WS_BASE,
      ];
      let raw = "";
      for (const c of chain) {
        const s = String(c || "").trim();
        if (!s) continue;
        raw = s;
        break;
      }
      if (!raw) {
        raw =
          tm === "BINANCE_DEMO_API" || tm === "BINANCE_TESTNET"
            ? "wss://fstream.binancefuture.com/public/ws"
            : "wss://fstream.binance.com/public/ws";
      }
      if (/fstream\.binance/i.test(raw) && /\/market\//i.test(raw)) {
        raw = raw.replace(/\/market\//gi, "/public/");
      }
      return routeBinanceUsdmWsBase(raw, "public");
    }
    if (k === "BINANCE_FUTURES") {
      return futuresDepthBaseFromEnv();
    }
    if (k === "BINANCE") {
      if (tm === "BINANCE_DEMO_API") {
        return process.env.BINANCE_DEMO_WS_BASE || "wss://demo-stream.binance.com/ws";
      }
      if (tm === "BINANCE_LIVE") {
        return process.env.BINANCE_LIVE_WS_BASE || process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws";
      }
      if (tm === "BINANCE_TESTNET") {
        return process.env.BINANCE_TESTNET_WS_BASE || "wss://testnet.binance.vision/ws";
      }
      return process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws";
    }
    return process.env.BINANCE_WS_BASE;
  }

  function normalizeTrailingExtraPcts(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      const n = Number(x);
      if (Number.isFinite(n) && n > 0) out.push(clamp(n, 0.01, 5));
      if (out.length >= 3) break;
    }
    return out;
  }

  function normalizeFuturesTrailingStopMode(v) {
    const u = String(v ?? "SUPERTREND").toUpperCase();
    return u === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND";
  }

  function normalizeTrailBufferMode(v) {
    const u = String(v ?? "PERCENT").toUpperCase();
    return u === "ATR" ? "ATR" : "PERCENT";
  }

  function universeManualPinningOn() {
    return String(state.universePinControl || "AUTO").toUpperCase() === "MANUAL";
  }

  /** Risk/trade + max daily loss both USDT: fixed notional per trade (no AI tiers/gates on size). */
  function isFixedUsdtCapitalMode() {
    return (
      String(state.riskPerTradeUnit || "PCT").toUpperCase() === "USDT" &&
      String(state.maxDailyLossUnit || "PCT").toUpperCase() === "USDT"
    );
  }

  /** For fixed-USDT sizing + multi-pin: shrink per-trade notional by pinned symbol count (≥2 pins). */
  function fixedUsdtCapitalSplitDivisor() {
    if (!state.capitalSplitAcrossCoins || !isFixedUsdtCapitalMode()) return 1;
    if (String(state.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return 1;
    const pins = Array.isArray(state.universePinnedSymbols)
      ? state.universePinnedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
      : [];
    if (pins.length <= 1) return 1;
    return pins.length;
  }

  function derivedMultiBudgetSplitMode() {
    const m = state.multiBudgetSplitMode;
    if (m === "FULL" || m === "EQUAL" || m === "CUSTOM_USDT" || m === "CUSTOM_PCT_ALLOWED") return m;
    return state.capitalSplitAcrossCoins ? "EQUAL" : "FULL";
  }

  /** Symbols shown in multi budget UI / EQUAL divisor: ranked top table ∩ pins (manual), else ranked slice. */
  function symbolsForMultiBudgetList() {
    if (String(state.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return [];
    const ranked = Array.isArray(state.universe?.ranked) ? state.universe.ranked : [];
    const rankedSyms = ranked
      .slice(0, 12)
      .map((r) => String(r?.symbol || "").trim().toUpperCase())
      .filter((s) => SYM_RE.test(s));
    // Custom universe can suppress ranked display (`aiRankedDisplayTop=0`) but still has an explicit list.
    // Use it as the equal-split divisor so fixed-USDT multi sizing doesn't silently fall back to divisor=1.
    const customRaw = Array.isArray(state.universeCustomSymbols) ? state.universeCustomSymbols : [];
    const customSyms = [...new Set(customRaw.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10);
    const coinBase = String(state.universeCoinBase || "ALL").toUpperCase();
    const pins = Array.isArray(state.universePinnedSymbols)
      ? [...new Set(state.universePinnedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))]
      : [];
    const manual = String(state.universePinControl || "").toUpperCase() === "MANUAL";
    if (coinBase === "CUSTOM" && customSyms.length > 0) {
      if (manual && pins.length > 0) {
        const inCustom = pins.filter((p) => customSyms.includes(p));
        return inCustom.length > 0 ? inCustom : customSyms;
      }
      return customSyms;
    }
    if (manual && pins.length > 0) {
      const setR = new Set(rankedSyms);
      const inTable = pins.filter((p) => setR.has(p));
      return inTable.length > 0 ? inTable : pins;
    }
    if (rankedSyms.length > 0) return rankedSyms.slice(0, 10);
    return [];
  }

  /**
   * Same leverage rule as live orders (MANUAL vs AUTO) — used to turn USD-M **notional** allotment into initial margin for `riskPlan`.
   * Declared before `decideFuturesLeverage` (later in file); keep in sync with that function + `futuresLeverageMode`.
   */
  function futuresLeverageForSizingResolve() {
    if (String(state.futuresLeverageMode || "").toUpperCase() === "MANUAL") {
      return clamp(Number(state.futuresLeverage) || 1, 1, 100);
    }
    const p = clamp(Number(state.lastAi?.gateProbability ?? state.lastAi?.probability ?? 0.5), 0, 1);
    const a = Math.max(0, Number(state.lastRegime?.atrPct || 0));
    const reg = String(state.lastRegime?.type || "").toUpperCase();
    const volatile = reg.includes("VOLAT") || a >= 0.012;
    let lev =
      p >= 0.85 ? 15 :
      p >= 0.78 ? 10 :
      p >= 0.7 ? 7 :
      p >= 0.62 ? 5 :
      p >= 0.55 ? 3 : 2;
    if (volatile) lev = Math.max(2, Math.floor(lev * 0.6));
    return clamp(lev, 1, 5);
  }

  function resolveAllowedBudgetBaseUsdt() {
    const walletCap = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
    const allowedRaw = Number(state.allowedBudgetUsdt);
    let allowed = Number.isFinite(allowedRaw) && allowedRaw > 0 ? allowedRaw : 0;
    if (walletCap != null && Number.isFinite(walletCap) && walletCap > 0) {
      allowed = Math.min(allowed, walletCap);
    }
    return Math.max(0, allowed);
  }

  function capitalCycleModeActive() {
    const isMultiple = String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
    const splitModeNow = derivedMultiBudgetSplitMode();
    const multiSizingImplied =
      splitModeNow === "EQUAL" || splitModeNow === "CUSTOM_USDT" || splitModeNow === "CUSTOM_PCT_ALLOWED";
    const multiSizing = isMultiple && (state.multiCoinCapitalSizingActive === true || multiSizingImplied);
    return multiSizing && multiSizingImplied;
  }

  function resetCapitalCycleFromAllowedBase() {
    const base = resolveAllowedBudgetBaseUsdt();
    state.capitalCycleStrategyBalanceUsdt = base;
    state.capitalCyclePoolAnchorUsdt = base;
    state.capitalCycleRealizedPnlUsdt = 0;
    const syms = symbolsForMultiBudgetList();
    state.capitalCycleSymbols = Array.isArray(syms) ? [...new Set(syms)].slice(0, 10) : [];
  }

  function ensureCapitalCycleInitialized() {
    const curS = Number(state.capitalCycleStrategyBalanceUsdt);
    const curA = Number(state.capitalCyclePoolAnchorUsdt);
    if (Number.isFinite(curS) && curS > 0 && Number.isFinite(curA) && curA >= 0) return;
    resetCapitalCycleFromAllowedBase();
  }

  /**
   * EQUAL-split divisor list: frozen `capitalCycleSymbols` when capital cycle is active, else live
   * ranked/pins (`symbolsForMultiBudgetList`). Must stay in sync with the UI and with
   * `pctPolicyCapForRiskPlan` (PCT cap / nDiv).
   */
  function multiBudgetEqualDivisorSymbolList() {
    const mode = derivedMultiBudgetSplitMode();
    const isMultiple = String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
    const splitModeNow = derivedMultiBudgetSplitMode();
    const multiSizingImplied =
      splitModeNow === "EQUAL" || splitModeNow === "CUSTOM_USDT" || splitModeNow === "CUSTOM_PCT_ALLOWED";
    const multiSizing = isMultiple && (state.multiCoinCapitalSizingActive === true || multiSizingImplied);
    const cycleMode = capitalCycleModeActive() && multiSizing;
    if (cycleMode) ensureCapitalCycleInitialized();
    const cycleList =
      cycleMode && mode === "EQUAL" && Array.isArray(state.capitalCycleSymbols) && state.capitalCycleSymbols.length > 0
        ? state.capitalCycleSymbols
        : null;
    return cycleList ?? symbolsForMultiBudgetList();
  }

  async function maybeRebalanceCapitalCycleOnFlat({ wsHub, source } = {}) {
    if (!capitalCycleModeActive()) return;
    ensureCapitalCycleInitialized();

    // Anchor + allowedBudgetUsdt are already kept in sync on every trade close
    // (see ingestClosedTrades). This function additionally:
    //   1. Resets the realized-PnL counter when all positions are flat (cycle boundary).
    //   2. Broadcasts state so the UI updates immediately.
    const posNow = await exch.getPositions().catch(() => []);
    _cachedPositions = Array.isArray(posNow) ? posNow : [];
    const invested = sumOpenMarginUsedUsdt(posNow, state.marketMode);
    const isFlat = invested <= 1e-8;

    const prevAnchor = Number(state.capitalCyclePoolAnchorUsdt) || 0;
    const curBalance = Math.max(0, Number(state.capitalCycleStrategyBalanceUsdt) || 0);
    const walletCap = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
    const nextAnchor = walletCap != null && Number.isFinite(walletCap) && walletCap > 0
      ? Math.min(curBalance, walletCap)
      : curBalance;

    state.capitalCyclePoolAnchorUsdt = nextAnchor;
    if (String(state.allowedBudgetInputMode || "USDT").toUpperCase() !== "WALLET_PCT") {
      state.allowedBudgetUsdt = clamp(nextAnchor, 0, 10_000_000);
    }

    if (isFlat) {
      state.capitalCycleRealizedPnlUsdt = 0;
    }

    if (Math.abs(nextAnchor - prevAnchor) > 1e-9) {
      emitActivity(wsHub, {
        level: "info",
        category: "capital",
        reason: isFlat ? "capital_cycle_rebalanced" : "capital_cycle_anchor_updated",
        msg: isFlat
          ? `Capital cycle rebalanced · pool anchor ${prevAnchor.toFixed(2)} → ${nextAnchor.toFixed(2)} USDT`
          : `Capital anchor updated · ${prevAnchor.toFixed(2)} → ${nextAnchor.toFixed(2)} USDT`,
        detail: { source: source || "unknown", prevAnchor, nextAnchor, isFlat },
      });
    }

    // Broadcast immediately so the frontend "Allowed" display updates without waiting for the next tick.
    try {
      const candles = feed.getCandles();
      const lastCb = candles.length ? candles[candles.length - 1] : null;
      const pf = portfolioMtmForWs(lastCb, candles, _cachedPositions, _cachedAccount, null);
      wsHub?.broadcast?.("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: pf.account,
        positions: pf.positionsMtM,
      });
    } catch {
      /* non-critical */
    }

  }

  /**
   * USDT **initial margin** per trade for `riskPlan` (futures): pool from **`allowedBudgetUsdt` only** (capital allotment),
   * capped by wallet free margin,
   * minus open margin, then **buffer %** of that headroom as sized usable, optional “% of usable” pool trim,
   * then either multi-coin split (no per-trade cap) or full usable per symbol with optional per-trade cap.
   * There is **no** fallback to `riskPerTrade` for the pool — if `allowedBudgetUsdt` is unset or zero after clamp, usable is zero.
   * `riskPerTrade` caps each lane only on the per-trade path (`multiCoinCapitalSizingActive` false) when `perTradeBudgetCapEnabled`.
   * When `riskPerTradeUnit` is not USDT, returns raw `riskPerTrade` (PCT path).
   */
  function resolveCapitalAllotmentMarginLaneForOrder(orderSymbol, positions) {
    const bufferPct = usableCapitalBufferPctFromEnv();
    const isMultiple = String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
    /**
     * Multi-coin sizing is active when the explicit flag is on, OR when the derived split mode is
     * EQUAL / CUSTOM (not FULL). This prevents the single-coin fallback from giving each coin the
     * full pool even when equal-split is displayed in the UI.
     */
    const splitModeNow = derivedMultiBudgetSplitMode();
    const multiSizingImplied = splitModeNow === "EQUAL" || splitModeNow === "CUSTOM_USDT" || splitModeNow === "CUSTOM_PCT_ALLOWED";
    const multiSizing = isMultiple && (state.multiCoinCapitalSizingActive === true || multiSizingImplied);
    const capEnabled = state.perTradeBudgetCapEnabled !== false && !multiSizing;
    const rawCap = Number(state.riskPerTrade) || 0;
    const usePctCap = String(state.perTradeBudgetInputMode || "USDT").toUpperCase() === "PCT_OF_USABLE";

    const walletCap = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
    const allowed = resolveAllowedBudgetBaseUsdt();
    const invested = sumOpenMarginUsedUsdt(positions, state.marketMode);
    const headroom = Math.max(0, allowed - invested);
    const totalUsableBuffered = headroom * (bufferPct / 100);
    const usePct = state.multiTradeUsePctOfUsable === true;
    const p = clamp(Number(state.multiTradePctOfUsable ?? 100), 0, 100);
    const sizedUsable = usePct ? (totalUsableBuffered * p) / 100 : totalUsableBuffered;
    /**
     * Fixed-slot cycle model (multi-coin split modes): pool stays fixed during open cycle and
     * only rebalances on flat. This avoids cross-coin shrink while positions are open.
     */
    const cycleMode = capitalCycleModeActive() && multiSizing;
    if (cycleMode) ensureCapitalCycleInitialized();
    const strategyBalance = Math.max(0, Number(state.capitalCycleStrategyBalanceUsdt) || 0);
    const cycleAnchorRaw = Number(state.capitalCyclePoolAnchorUsdt);
    let cycleAnchor = Number.isFinite(cycleAnchorRaw) && cycleAnchorRaw > 0 ? cycleAnchorRaw : strategyBalance;
    if (walletCap != null && Number.isFinite(walletCap) && walletCap > 0) {
      cycleAnchor = Math.min(cycleAnchor, walletCap);
    }
    const cycleSized = usePct ? (cycleAnchor * p) / 100 : cycleAnchor;
    const splitPool = cycleMode ? cycleSized : sizedUsable;
    const basePool = Number.isFinite(splitPool) && splitPool > 0 ? splitPool : 0;

    let perTradeCapUsdt = 1e15;
    if (capEnabled) {
      if (usePctCap) {
        perTradeCapUsdt = Math.max(0, (splitPool * clamp(rawCap, 0, 100)) / 100);
      } else {
        perTradeCapUsdt = Math.max(0, rawCap);
      }
    }

    const mm = state.marketMode;
    const marSym = (s) => sumMarginUsedForSymbolUsdt(positions, mm, s);
    const sym = String(orderSymbol || "").trim().toUpperCase();

    const cappedLane = (laneRawMargin) => {
      const x = Math.max(0, laneRawMargin);
      return capEnabled ? Math.min(perTradeCapUsdt, x) : x;
    };

    const laneMarginFromUnits = (coinU, basePoolUnits) =>
      Math.min(cappedLane(Math.max(0, coinU)), Math.max(0, basePoolUnits));

    if (!isMultiple || !multiSizing) {
      const coinU = Math.max(0, splitPool - marSym(sym));
      const lane = laneMarginFromUnits(coinU, basePool);
      return { riskPerTrade: lane, fixedUsdtSplitDivisor: 1 };
    }

    // Global pool safety: fixed cycle pool cannot be exceeded by aggregate open margin.
    if (cycleMode && invested >= basePool - 1e-9) {
      return { riskPerTrade: 0, fixedUsdtSplitDivisor: 1 };
    }

    const mode = derivedMultiBudgetSplitMode();
    const list = multiBudgetEqualDivisorSymbolList();
    const listSet = new Set((Array.isArray(list) ? list : []).map((s) => String(s || "").toUpperCase()));
    const modeUsesSymbolList = mode === "EQUAL" || mode === "CUSTOM_USDT" || mode === "CUSTOM_PCT_ALLOWED";
    if (modeUsesSymbolList && listSet.size === 0) {
      return { riskPerTrade: 0, fixedUsdtSplitDivisor: 1 };
    }
    // Strict guard: when split mode is list-based, symbols outside the active list are not tradable.
    if (modeUsesSymbolList && listSet.size > 0 && !listSet.has(sym)) {
      return { riskPerTrade: 0, fixedUsdtSplitDivisor: 1 };
    }
    // Production guard: if the ranked/pin/custom list is temporarily empty (scan lag, UI already has rows),
    // do not silently collapse EQUAL split to divisor=1 (would oversize each coin).
    const nDiv = Math.max(1, list.length);

    if (mode === "CUSTOM_USDT") {
      const m = state.multiBudgetCoinUsdt && typeof state.multiBudgetCoinUsdt === "object" ? state.multiBudgetCoinUsdt : {};
      const v = Number(m[sym]);
      const allocated = Number.isFinite(v) && v >= 0 ? v : 0;
      /**
       * Per-coin cap is the configured USDT amount for this symbol.
       * usable_coin_cap = coin_slot - used_margin_coin (clamped ≥ 0).
       * Hard cap: never exceed the coin's allocated slot.
       */
      const coinU = Math.max(0, Math.min(allocated, allocated - marSym(sym)));
      return { riskPerTrade: Math.max(0, coinU), fixedUsdtSplitDivisor: 1 };
    }
    if (mode === "CUSTOM_PCT_ALLOWED") {
      const m = state.multiBudgetCoinPct && typeof state.multiBudgetCoinPct === "object" ? state.multiBudgetCoinPct : {};
      const pc = Number(m[sym]);
      const coinSlot = Number.isFinite(pc) && pc >= 0 ? splitPool * (clamp(pc, 0, 100) / 100) : 0;
      /** usable_coin_cap = coin_slot - used_margin_coin (clamped ≥ 0, hard-capped at slot) */
      const coinU = Math.max(0, Math.min(coinSlot, coinSlot - marSym(sym)));
      return { riskPerTrade: Math.max(0, coinU), fixedUsdtSplitDivisor: 1 };
    }

    if (mode === "EQUAL") {
      /**
       * Per-coin slot = sizedUsable / nDiv (e.g. 900 / 6 = 150 USDT each).
       * usable_coin_cap = coin_slot - used_margin_coin (clamped ≥ 0, never exceed slot).
       *
       * CRITICAL FIX (was: returned perSlot * nDiv + splitDivisor=nDiv which only worked
       * when fixedCapital=true in riskPlan — with maxDailyLossUnit=PCT the divisor was
       * NOT applied, passing the full 900 USDT pool to riskPlan instead of the 150 cap).
       */
      const equalSlot = nDiv > 0 ? splitPool / nDiv : 0;
      const coinU = Math.max(0, equalSlot - marSym(sym));
      const coinCap = Math.min(coinU, equalSlot); // never exceed the slot
      return { riskPerTrade: Math.max(0, coinCap), fixedUsdtSplitDivisor: 1 };
    }

    const coinU = Math.max(0, splitPool - marSym(sym));
    const lane = laneMarginFromUnits(coinU, basePool);
    return { riskPerTrade: lane, fixedUsdtSplitDivisor: 1 };
  }

  function resolveFixedUsdtRiskForOrder(orderSymbol, positions) {
    if (String(state.riskPerTradeUnit || "").toUpperCase() !== "USDT") {
      return { riskPerTrade: state.riskPerTrade, fixedUsdtSplitDivisor: 1 };
    }
    return resolveCapitalAllotmentMarginLaneForOrder(orderSymbol, positions);
  }

  /**
   * Unified futures qty clamp against per-coin capital-allotment margin cap.
   * Applies regardless of risk unit (USDT/PCT) so all entry paths share the same hard guard.
   */
  function clampQtyToPerCoinMarginCap({ symbol, qty, entryPx, leverage, positions, wsHub, context = "futures_order" }) {
    const q = Number(qty);
    const px = Number(entryPx);
    const lev = Number(leverage);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(px) || px <= 0 || !Number.isFinite(lev) || lev <= 0) {
      return { qty: q, perCoinMarginCap: null, hardCapNotional: null, clamped: false };
    }
    const lane = resolveCapitalAllotmentMarginLaneForOrder(symbol, positions);
    const cap = Number(lane?.riskPerTrade);
    if (!Number.isFinite(cap) || cap <= 0) {
      return { qty: 0, perCoinMarginCap: 0, hardCapNotional: 0, clamped: true };
    }
    const hardCapNotional = Math.max(0, cap) * lev;
    let outQty = q;
    if (outQty * px > hardCapNotional) {
      outQty = roundTo(hardCapNotional / px, 6);
    }
    const clamped = outQty !== q;
    if (clamped) {
      wsHub?.broadcast?.("log", {
        level: "info",
        category: "capital",
        symbol: String(symbol || "").toUpperCase(),
        msg: `Capital cap clamp · ${String(symbol || "").toUpperCase()} · ${context} qty ${q.toFixed(6)} → ${outQty.toFixed(6)} (cap ${cap.toFixed(2)} USDT @ ${lev}x)`,
      });
    }
    return { qty: outQty, perCoinMarginCap: cap, hardCapNotional, clamped };
  }

  /** Allowed USDT pool for PCT sizing when not in fixed-USDT mode (matches UI capital allotment). */
  function effectivePolicyAllowedPoolUsdt() {
    if (isFixedUsdtCapitalMode()) return 0;
    const walletCap = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
    const raw = Number(state.allowedBudgetUsdt);
    let poolNominal = Number.isFinite(raw) && raw > 0 ? raw : 0;
    /**
     * Fallback to `riskPerTrade` as the pool ONLY in single-coin USDT mode (not when multi-coin
     * sizing is active). Using the per-trade cap as the pool in multi-coin mode causes each coin to
     * independently consume the full cap, multiplying exposure by the number of coins.
     */
    if (!(poolNominal > 0) && String(state.riskPerTradeUnit || "").toUpperCase() === "USDT") {
      const isMulti = String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
      const splitModeEff = derivedMultiBudgetSplitMode();
      const multiActive = isMulti && (
        state.multiCoinCapitalSizingActive === true ||
        splitModeEff === "EQUAL" || splitModeEff === "CUSTOM_USDT" || splitModeEff === "CUSTOM_PCT_ALLOWED"
      );
      if (!multiActive) {
        poolNominal = Math.max(0, Number(state.riskPerTrade) || 0);
      }
    }
    if (!(poolNominal > 0) && walletCap != null && Number.isFinite(walletCap) && walletCap > 0) {
      const wpct = clamp(Number(state.allowedBudgetWalletPct || 0), 0.5, 100);
      if (wpct > 0) poolNominal = Math.max(1, Math.round((walletCap * wpct) / 100));
    }
    if (!Number.isFinite(poolNominal) || poolNominal <= 0) return 0;
    if (walletCap != null && Number.isFinite(walletCap) && walletCap > 0) {
      return Math.min(poolNominal, walletCap);
    }
    return poolNominal;
  }

  /**
   * Per-coin policy cap fed to `riskPlan` as `pctPolicyCapUsdt` (PCT mode).
   * In multi-coin EQUAL mode the cap is the per-coin slot (pool / nDiv) so every coin
   * independently respects its portion of the allowed budget.
   */
  function pctPolicyCapForRiskPlan() {
    const p = effectivePolicyAllowedPoolUsdt();
    if (!(p > 0)) return null;
    /** PCT mode: divide by number of equal-split coins so each coin uses its own slot. */
    if (String(state.riskPerTradeUnit || "PCT").toUpperCase() !== "USDT") {
      const isMultiple = String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
      const splitMode = derivedMultiBudgetSplitMode();
      const multiActive = isMultiple && (
        state.multiCoinCapitalSizingActive === true ||
        splitMode === "EQUAL" || splitMode === "CUSTOM_USDT" || splitMode === "CUSTOM_PCT_ALLOWED"
      );
      if (multiActive && splitMode === "EQUAL") {
        const list = multiBudgetEqualDivisorSymbolList();
        const nDiv = Math.max(1, list.length);
        if (nDiv > 1) return p / nDiv;
      }
    }
    return p;
  }

  /** SUPERTREND_ELITE signal-brain fields — shared by persist payload and WS/HTTP public state. */
  function eliteStPublicSnapshot() {
    return {
      eliteStRequireHtf4hAlign: state.eliteStRequireHtf4hAlign === true,
      eliteStHtf4hPeriod: state.eliteStHtf4hPeriod,
      eliteStHtf4hMultiplier: state.eliteStHtf4hMultiplier,
      eliteStRequireHtf1hEmaAlign: state.eliteStRequireHtf1hEmaAlign === true,
      eliteStHtf1hMinSep: state.eliteStHtf1hMinSep,
      eliteStHtf1hSepMode: state.eliteStHtf1hSepMode,
      eliteStHtf1hMinSepAtrMult: state.eliteStHtf1hMinSepAtrMult,
      eliteStHtf1hMinSepFloor: state.eliteStHtf1hMinSepFloor,
      eliteStHtf1hMinSepCeil: state.eliteStHtf1hMinSepCeil,
      eliteStHtf1hSepPercentileLookback: state.eliteStHtf1hSepPercentileLookback,
      eliteStHtf1hSepPercentileMult: state.eliteStHtf1hSepPercentileMult,
      eliteStHtf1hSepAdxBase: state.eliteStHtf1hSepAdxBase,
      eliteStHtf1hSepAdxAlpha: state.eliteStHtf1hSepAdxAlpha,
      eliteStHtf1hSepAdxRef: state.eliteStHtf1hSepAdxRef,
      eliteStHtf1hSepCalibratePct: state.eliteStHtf1hSepCalibratePct,
      eliteStHtf1hSepCalibrateBars: state.eliteStHtf1hSepCalibrateBars,
      eliteStMinAdx: state.eliteStMinAdx,
      eliteStRequireAdxRising: state.eliteStRequireAdxRising === true,
      eliteStAdxRisingLookback: state.eliteStAdxRisingLookback,
      eliteStMinVolumeVsAvg: state.eliteStMinVolumeVsAvg,
      eliteStRequireAtrExpansion: state.eliteStRequireAtrExpansion === true,
      eliteStMinAtrExpansion: state.eliteStMinAtrExpansion,
      eliteStAtrExpansionLookback: state.eliteStAtrExpansionLookback,
      eliteStLiqSweepEnabled: state.eliteStLiqSweepEnabled === true,
      eliteStAutoCalibrate: state.eliteStAutoCalibrate === true,
      eliteStAutoFullTune: state.eliteStAutoFullTune !== false,
      eliteStAutoProfileBars: state.eliteStAutoProfileBars,
      eliteStAutoBracketMode: state.eliteStAutoBracketMode,
      eliteStAutoMinAdxFloor: state.eliteStAutoMinAdxFloor,
      eliteStAutoMinAdxCeil: state.eliteStAutoMinAdxCeil,
    };
  }

  /** Dynamic trailing fields — shared by persist payload and WS/HTTP public state. */
  function trailAdvancedPublicSnapshot() {
    return {
      trailSizingMode:
        String(state.trailSizingMode ?? "FIXED_PCT").toUpperCase() === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT",
      trailDynamicAdvAtrHwmMult: Number(state.trailDynamicAdvAtrHwmMult ?? 2.5),
      trailDynamicAdvMfeGivebackFrac: Number(state.trailDynamicAdvMfeGivebackFrac ?? 0.18),
      trailDynamicAdvMfeMinR: Number(state.trailDynamicAdvMfeMinR ?? 1.2),
      trailDynamicAdvPostT02StepAtrMult: Number(state.trailDynamicAdvPostT02StepAtrMult ?? 0.6),
      trailDynamicAdvMergeSupertrend: state.trailDynamicAdvMergeSupertrend !== false,
      trailDynamicAdvAtrSource:
        String(state.trailDynamicAdvAtrSource ?? "ROLLING").toUpperCase() === "ROLLING" ? "ROLLING" : "ROLLING",
    };
  }

  function applyTrailAdvancedPatchToState(patch) {
    if (!patch || typeof patch !== "object") return;
    if (patch.trailSizingMode != null) {
      const m = String(patch.trailSizingMode).toUpperCase();
      state.trailSizingMode = m === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT";
    }
    if (patch.trailDynamicAdvAtrHwmMult != null && Number.isFinite(Number(patch.trailDynamicAdvAtrHwmMult))) {
      state.trailDynamicAdvAtrHwmMult = clamp(Number(patch.trailDynamicAdvAtrHwmMult), 0, 6);
    }
    if (patch.trailDynamicAdvMfeGivebackFrac != null && Number.isFinite(Number(patch.trailDynamicAdvMfeGivebackFrac))) {
      state.trailDynamicAdvMfeGivebackFrac = clamp(Number(patch.trailDynamicAdvMfeGivebackFrac), 0, 0.9);
    }
    if (patch.trailDynamicAdvMfeMinR != null && Number.isFinite(Number(patch.trailDynamicAdvMfeMinR))) {
      state.trailDynamicAdvMfeMinR = clamp(Number(patch.trailDynamicAdvMfeMinR), 0, 10);
    }
    if (
      patch.trailDynamicAdvPostT02StepAtrMult != null &&
      Number.isFinite(Number(patch.trailDynamicAdvPostT02StepAtrMult))
    ) {
      state.trailDynamicAdvPostT02StepAtrMult = clamp(Number(patch.trailDynamicAdvPostT02StepAtrMult), 0, 2);
    }
    if (patch.trailDynamicAdvMergeSupertrend != null) {
      state.trailDynamicAdvMergeSupertrend = Boolean(patch.trailDynamicAdvMergeSupertrend);
    }
    if (patch.trailDynamicAdvAtrSource != null) {
      state.trailDynamicAdvAtrSource = "ROLLING";
    }
  }

  /** LIQUIDITY_MAP signal-brain fields — shared by persist payload and WS/HTTP public state. */
  function liqMapPublicSnapshot(src = state) {
    return {
      liqMapLookbackBars: clamp(Math.round(Number(src.liqMapLookbackBars ?? 72)), 8, 300),
      liqMapMaxAgeBars: clamp(Math.round(Number(src.liqMapMaxAgeBars ?? 72)), 4, 300),
      liqMapMinTouches: clamp(Math.round(Number(src.liqMapMinTouches ?? 1)), 1, 10),
      liqMapMinWickRatio: clamp(Number(src.liqMapMinWickRatio ?? 0.25), 0, 1),
      liqMapMinRvol: clamp(Number(src.liqMapMinRvol ?? 1.1), 0, 10),
      liqMapMinBodyRatio: clamp(Number(src.liqMapMinBodyRatio ?? 0), 0, 1),
      liqMapSweepPct: clamp(Number(src.liqMapSweepPct ?? 0.0006), 0, 0.05),
      liqMapEqualTolPct: clamp(Number(src.liqMapEqualTolPct ?? 0.0008), 0, 0.02),
      liqMapNormalizeThresholds: src.liqMapNormalizeThresholds !== false,
      liqMapSweepAtrFrac: clamp(Number(src.liqMapSweepAtrFrac ?? 0.13), 0, 2),
      liqMapEqualTolAtrFrac: clamp(Number(src.liqMapEqualTolAtrFrac ?? 0.18), 0, 2),
      liqMapAutoCalibrate: src.liqMapAutoCalibrate === true,
      liqMapAutoProfileBars: clamp(Math.round(Number(src.liqMapAutoProfileBars ?? 200)), 40, 200),
      liqMapAutoTrailTune: src.liqMapAutoTrailTune !== false,
      liqMapHybridExit: src.liqMapHybridExit !== false,
      liqMapQualityGate: src.liqMapQualityGate === true,
      liqMapQualityGateMode: String(src.liqMapQualityGateMode).toUpperCase() === "SOFT" ? "SOFT" : "HARD",
      liqMapSoftGateScoreBand: clamp(Number(src.liqMapSoftGateScoreBand ?? 0.25), 0, 3),
      liqMapQualityAuto: src.liqMapQualityAuto !== false,
      liqMapMinQualityScore: clamp(Number(src.liqMapMinQualityScore ?? 6.2), 0, 12),
      liqMapRequireUnresolved: src.liqMapRequireUnresolved !== false,
      liqMapRequireDirectionalClose: src.liqMapRequireDirectionalClose === true,
      liqMapEntryModel: ["HTF_SWEEP", "STRUCTURAL", "SWEEP_RECLAIM"].includes(String(src.liqMapEntryModel).toUpperCase())
        ? String(src.liqMapEntryModel).toUpperCase()
        : "HTF_SWEEP",
      liqMapHtfPoolTfs: String(src.liqMapHtfPoolTfs ?? "1h,4h"),
      liqMapHtfLookbackBars: clamp(Math.round(Number(src.liqMapHtfLookbackBars ?? 72)), 12, 500),
      liqMapHtfSwingLeft: clamp(Math.round(Number(src.liqMapHtfSwingLeft ?? 2)), 1, 10),
      liqMapHtfSwingRight: clamp(Math.round(Number(src.liqMapHtfSwingRight ?? 2)), 1, 10),
      liqMapHtfEqualMinTouches: clamp(Math.round(Number(src.liqMapHtfEqualMinTouches ?? 2)), 2, 8),
      liqMapUseDailyWeeklyPools: src.liqMapUseDailyWeeklyPools !== false,
      liqMapUseTrendlinePools: src.liqMapUseTrendlinePools !== false,
      liqMapEntryTiming: ["FVG_OR_OB", "NEXT_OPEN", "CONFIRMATION_CLOSE", "TWO_BAR_CONFIRM"].includes(String(src.liqMapEntryTiming).toUpperCase())
        ? String(src.liqMapEntryTiming).toUpperCase()
        : "FVG_OR_OB",
      liqMapRequireMss: src.liqMapRequireMss !== false,
      liqMapRequireChoch: src.liqMapRequireChoch === true,
      liqMapRequireRetrace: src.liqMapRequireRetrace !== false,
      liqMapRequireReclaimHold: src.liqMapRequireReclaimHold !== false,
      liqMapStructureLookbackBars: clamp(Math.round(Number(src.liqMapStructureLookbackBars ?? 24)), 3, 200),
      liqMapMssMaxBarsAfterSweep: clamp(Math.round(Number(src.liqMapMssMaxBarsAfterSweep ?? 10)), 1, 100),
      liqMapEntryZoneMode: ["FVG", "OB", "EITHER"].includes(String(src.liqMapEntryZoneMode).toUpperCase())
        ? String(src.liqMapEntryZoneMode).toUpperCase()
        : "EITHER",
      liqMapFvgEntryMode: ["ZONE", "MIDPOINT", "CE"].includes(String(src.liqMapFvgEntryMode).toUpperCase())
        ? String(src.liqMapFvgEntryMode).toUpperCase()
        : "ZONE",
      liqMapMssRequireDisplacement: src.liqMapMssRequireDisplacement !== false,
      liqMapDisplacementBodyMult: clamp(Number(src.liqMapDisplacementBodyMult ?? 1.15), 0, 5),
      liqMapDisplacementAtrMult: clamp(Number(src.liqMapDisplacementAtrMult ?? 0.35), 0, 5),
      liqMapFvgMinGapPct: clamp(Number(src.liqMapFvgMinGapPct ?? 0.00005), 0, 0.02),
      liqMapStrictPdZone: src.liqMapStrictPdZone !== false,
      liqMapObMinDisplacementAtr: clamp(Number(src.liqMapObMinDisplacementAtr ?? 0.6), 0, 5),
      liqMapRr: clamp(Number(src.liqMapRr ?? 1.25), 0.2, 10),
      liqMapHtfMode: ["none", "with", "against"].includes(String(src.liqMapHtfMode))
        ? String(src.liqMapHtfMode)
        : "with",
      liqMapKillzone: String(src.liqMapKillzone ?? "ALL"),
      liqMapMinAtrPctile: clamp(Number(src.liqMapMinAtrPctile ?? 0), 0, 100),
      liqMapMaxAtrPctile: clamp(Number(src.liqMapMaxAtrPctile ?? 0), 0, 100),
      liqMapAtrPctileLookback: clamp(Math.round(Number(src.liqMapAtrPctileLookback ?? 2880)), 200, 10000),
      liqMapMinAdx: clamp(Number(src.liqMapMinAdx ?? 0), 0, 100),
      liqMapMaxAdx: clamp(Number(src.liqMapMaxAdx ?? 0), 0, 100),
      liqMapMinAtrPct: clamp(Number(src.liqMapMinAtrPct ?? 0), 0, 0.1),
      liqMapMaxAtrPct: clamp(Number(src.liqMapMaxAtrPct ?? 0), 0, 0.1),
      liqMapMaxHoldBars: clamp(Math.round(Number(src.liqMapMaxHoldBars ?? 0)), 0, 2000),
      liqMapMaxSlPct: clamp(Number(src.liqMapMaxSlPct ?? 0.05), 0, 0.2),
      liqMapSlBufferPct: clamp(Number(src.liqMapSlBufferPct ?? 0.0015), 0, 0.05),
      liqMapSlBufferAtrFrac: clamp(Number(src.liqMapSlBufferAtrFrac ?? 0.2), 0, 2),
      liqMapOnePerDay: src.liqMapOnePerDay !== false,
      liqMapOnePerSidePerDay: src.liqMapOnePerSidePerDay === true,
      liqMapExitMode: ["PARTIAL_RUNNER", "SCALED_FIXED"].includes(String(src.liqMapExitMode))
        ? String(src.liqMapExitMode)
        : "SCALED_FIXED",
      liqMapTrailMode: ["FEE_LADDER", "SUPERTREND", "DYNAMIC_ATR"].includes(String(src.liqMapTrailMode))
        ? String(src.liqMapTrailMode)
        : "SUPERTREND",
      liqMapMaxTpRr: clamp(Number(src.liqMapMaxTpRr ?? 10), 0, 50),
      liqMapMaxOpposingRr: clamp(Number(src.liqMapMaxOpposingRr ?? 2), 0, 50),
      liqMapMinTp2Rr: clamp(Number(src.liqMapMinTp2Rr ?? 1.5), 0, 20),
      liqMapFallbackTpRr: clamp(Number(src.liqMapFallbackTpRr ?? 3), 0, 50),
      liqMapDynamicRunnerMaxTpRr: clamp(Number(src.liqMapDynamicRunnerMaxTpRr ?? 15), 0, 50),
      liqMapDynamicRunnerMinTpRr: clamp(Number(src.liqMapDynamicRunnerMinTpRr ?? 3), 1, 20),
      liqMapProjectedTpAtrMult: clamp(Number(src.liqMapProjectedTpAtrMult ?? 4), 0, 20),
      liqMapProjectedTpRangeMult: clamp(Number(src.liqMapProjectedTpRangeMult ?? 0.5), 0, 5),
      liqMapProjectionLookbackBars: clamp(Math.round(Number(src.liqMapProjectionLookbackBars ?? 24)), 2, 300),
      liqMapDynamicExitPolicy: src.liqMapDynamicExitPolicy === true,
      liqMapDynExitQualityHi: clamp(Number(src.liqMapDynExitQualityHi ?? 6.4), 0, 12),
      liqMapDynExitQualityMid: clamp(Number(src.liqMapDynExitQualityMid ?? 5.8), 0, 12),
      liqMapDynExitRrHi: clamp(Number(src.liqMapDynExitRrHi ?? 3.0), 0, 20),
      liqMapDynExitRrMid: clamp(Number(src.liqMapDynExitRrMid ?? 2.0), 0, 20),
      liqMapDynExitPartialHi: clamp(Number(src.liqMapDynExitPartialHi ?? 0.35), 0.25, 0.75),
      liqMapDynExitPartialMid: clamp(Number(src.liqMapDynExitPartialMid ?? 0.5), 0.25, 0.75),
      liqMapDynExitPartialBase: clamp(Number(src.liqMapDynExitPartialBase ?? 0.75), 0.25, 0.75),
      liqMapDynExitTrailAtrHi: clamp(Number(src.liqMapDynExitTrailAtrHi ?? 5.5), 0, 6),
      liqMapDynExitTrailAtrMid: clamp(Number(src.liqMapDynExitTrailAtrMid ?? 4.5), 0, 6),
      liqMapDynExitTrailAtrBase: clamp(Number(src.liqMapDynExitTrailAtrBase ?? 3.0), 0, 6),
      liqMapDynExitWeakTp1Rr: clamp(Number(src.liqMapDynExitWeakTp1Rr ?? 0.7), 0.45, 1),
      liqMapStructuralTp1Rr: clamp(Number(src.liqMapStructuralTp1Rr ?? 0.75), 0.5, 1),
      liqMapPartialFrac: clamp(Number(src.liqMapPartialFrac ?? 0.75), 0.25, 0.75),
      liqMapBreakevenAfterPartial: src.liqMapBreakevenAfterPartial === true,
      liqMapUse4hConfirm: src.liqMapUse4hConfirm === true,
      liqMapSlMode: ["ATR_FLOOR", "REVERSAL_WICK"].includes(String(src.liqMapSlMode))
        ? String(src.liqMapSlMode)
        : "ATR_FLOOR",
      liqMapAtrSlMult: clamp(Number(src.liqMapAtrSlMult ?? 1.0), 0, 5),
      liqMapSlRegimeAdjust: src.liqMapSlRegimeAdjust !== false,
      liqMapSlRegimeLowMult: clamp(Number(src.liqMapSlRegimeLowMult ?? 0.75), 0.2, 2),
      liqMapSlRegimeHighMult: clamp(Number(src.liqMapSlRegimeHighMult ?? 1.15), 0.2, 3),
      liqMapTrailStPeriod: clamp(Math.round(Number(src.liqMapTrailStPeriod ?? 10)), 2, 100),
      liqMapTrailStMult: clamp(Number(src.liqMapTrailStMult ?? 3.0), 0.5, 10),
      liqMapTrailAtrHwmMult: clamp(Number(src.liqMapTrailAtrHwmMult ?? 2.75), 0, 6),
      liqMapTrailMfeGiveback: clamp(Number(src.liqMapTrailMfeGiveback ?? 0.16), 0, 0.9),
      liqMapTrailMfeMinR: clamp(Number(src.liqMapTrailMfeMinR ?? 1.5), 0, 10),
      liqMapTrailStepAtrMult: clamp(Number(src.liqMapTrailStepAtrMult ?? 0.6), 0, 2),
      liqMapTrailMergeSt: src.liqMapTrailMergeSt !== false,
      liqMapDeadTradeExitBars: clamp(Math.round(Number(src.liqMapDeadTradeExitBars ?? 0)), 0, 2000),
      liqMapDeadTradeMinMfeR: clamp(Number(src.liqMapDeadTradeMinMfeR ?? 0.5), 0, 5),
      liqMapDeadTradeMaxLossR: clamp(Number(src.liqMapDeadTradeMaxLossR ?? 0.55), 0, 5),
    };
  }

  function applyLiqMapPatchToState(patch) {
    if (!patch || typeof patch !== "object") return;
    const snapKeys = Object.keys(liqMapPublicSnapshot());
    const hasLiqMapKey = snapKeys.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
    if (!hasLiqMapKey) return;
    const merged = { ...state };
    for (const k of snapKeys) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) merged[k] = patch[k];
    }
    Object.assign(state, liqMapPublicSnapshot(merged));
  }

  function buildTradingConfigPersistPayload() {
    return {
      v: 1,
      bot: {
        symbol: state.symbol,
        timeframe: state.timeframe,
        symbolMode: state.symbolMode,
        universePinnedSymbol: state.universePinnedSymbol,
        universeCoinBase: state.universeCoinBase,
        universeCustomSymbols: state.universeCustomSymbols,
        universeCoinSelectMode: state.universeCoinSelectMode,
        universePinControl: state.universePinControl,
        universeAutoCoinPick: state.universeAutoCoinPick,
        universePinnedSymbols: state.universePinnedSymbols,
        aiThreshold: state.aiThreshold,
        riskPerTrade: state.riskPerTrade,
        maxDailyLoss: state.maxDailyLoss,
        riskPerTradeUnit: state.riskPerTradeUnit,
        maxDailyLossUnit: state.maxDailyLossUnit,
        capitalSplitAcrossCoins: Boolean(state.capitalSplitAcrossCoins),
        allowedBudgetUsdt: Number(state.allowedBudgetUsdt) || 0,
        allowedBudgetWalletPct: clamp(Number(state.allowedBudgetWalletPct || 0), 0, 100),
        allowedBudgetInputMode: state.allowedBudgetInputMode === "WALLET_PCT" ? "WALLET_PCT" : "USDT",
        allowedBudgetPnlAnchorMs:
          state.allowedBudgetPnlAnchorMs != null && Number.isFinite(Number(state.allowedBudgetPnlAnchorMs))
            ? Math.round(Number(state.allowedBudgetPnlAnchorMs))
            : null,
        multiTradeUsePctOfUsable: Boolean(state.multiTradeUsePctOfUsable),
        multiTradePctOfUsable: clamp(Number(state.multiTradePctOfUsable ?? 100), 0, 100),
        capitalAllotmentCompoundPnlUi: Boolean(state.capitalAllotmentCompoundPnlUi),
        capitalCycleStrategyBalanceUsdt: Math.max(0, Number(state.capitalCycleStrategyBalanceUsdt) || 0),
        capitalCyclePoolAnchorUsdt: Math.max(0, Number(state.capitalCyclePoolAnchorUsdt) || 0),
        capitalCycleRealizedPnlUsdt: Number(state.capitalCycleRealizedPnlUsdt) || 0,
        capitalCycleSymbols: Array.isArray(state.capitalCycleSymbols) ? [...state.capitalCycleSymbols] : [],
        perTradeBudgetCapEnabled: Boolean(state.perTradeBudgetCapEnabled !== false),
        perTradeBudgetInputMode: state.perTradeBudgetInputMode === "PCT_OF_USABLE" ? "PCT_OF_USABLE" : "USDT",
        multiCoinCapitalSizingActive: Boolean(state.multiCoinCapitalSizingActive),
        multiBudgetSplitMode:
          state.multiBudgetSplitMode === "FULL" ||
          state.multiBudgetSplitMode === "EQUAL" ||
          state.multiBudgetSplitMode === "CUSTOM_USDT" ||
          state.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED"
            ? state.multiBudgetSplitMode
            : null,
        multiBudgetCoinUsdt:
          state.multiBudgetCoinUsdt && typeof state.multiBudgetCoinUsdt === "object" ? { ...state.multiBudgetCoinUsdt } : {},
        multiBudgetCoinPct:
          state.multiBudgetCoinPct && typeof state.multiBudgetCoinPct === "object" ? { ...state.multiBudgetCoinPct } : {},
        strategyMode: state.strategyMode,
        manualStrategy: state.manualStrategy,
        marketMode: state.marketMode,
        futuresLeverageMode: state.futuresLeverageMode,
        futuresLeverage: state.futuresLeverage,
        supertrendSpotAuto: state.supertrendSpotAuto,
        supertrendFuturesAuto: state.supertrendFuturesAuto,
        supertrendFuturesAiConfidenceFilter: state.supertrendFuturesAiConfidenceFilter,
        signalStrengthGatesTrades: state.signalStrengthGatesTrades,
        supertrendMoveQualityGate: state.supertrendMoveQualityGate === true,
        supertrendHtf4hEnabled: state.supertrendHtf4hEnabled === true,
        supertrendHtf4hPeriod: state.supertrendHtf4hPeriod,
        supertrendHtf4hMultiplier: state.supertrendHtf4hMultiplier,
        volumeProfileEnabled: state.volumeProfileEnabled === true,
        volumeProfileSoftGates: state.volumeProfileSoftGates !== false,
        volumeProfileGatesEnabled: state.volumeProfileGatesEnabled === true,
        intradayVpBrackets: state.intradayVpBrackets === true,
        intradayGateLiquidity: state.intradayGateLiquidity !== false,
        intradayGateSession: state.intradayGateSession !== false,
        intradayGateFib: state.intradayGateFib !== false,
        intradayGateVp: state.intradayGateVp !== false,
        intradayGateOrderFlow: state.intradayGateOrderFlow !== false,
        intradayGateHtfRegime: state.intradayGateHtfRegime !== false,
        intradayGateInstitutionalSr: state.intradayGateInstitutionalSr === true,
        intradayGateSmcIct: state.intradayGateSmcIct === true,
        intradaySmcIctMode: state.intradaySmcIctMode === true,
        intradaySmcIctProfile: String(state.intradaySmcIctProfile ?? "sweep").toLowerCase(),
        intradaySmcPickMode: String(state.intradaySmcPickMode ?? "per_signal").toLowerCase(),
        intradaySmcOneTradePerDay: state.intradaySmcOneTradePerDay === true,
        intradaySmcMinScore: clamp(Math.round(Number(state.intradaySmcMinScore ?? 7)), 1, 20),
        intradaySmcRequireMss: state.intradaySmcRequireMss === true,
        intradaySmcRequireRetrace: state.intradaySmcRequireRetrace === true,
        intradaySmcRequireChoch: state.intradaySmcRequireChoch === true,
        intradaySmcRequireBos: state.intradaySmcRequireBos === true,
        intradaySmcRequireConfirm: state.intradaySmcRequireConfirm === true,
        intradaySmcRequireFvgRetrace: state.intradaySmcRequireFvgRetrace === true,
        intradaySmcRequireHtfBias: state.intradaySmcRequireHtfBias !== false,
        intradaySmcLookbackBars: clamp(Math.round(Number(state.intradaySmcLookbackBars ?? 30)), 3, 200),
        intradaySmcMinRr: clamp(Number(state.intradaySmcMinRr ?? 2), 0, 10),
        intradaySmcBosMaxBars: clamp(Math.round(Number(state.intradaySmcBosMaxBars ?? 5)), 1, 20),
        intradaySmcChochMaxBars: clamp(Math.round(Number(state.intradaySmcChochMaxBars ?? 8)), 1, 20),
        intradaySmcEntryZoneMode:
          state.intradaySmcEntryZoneMode === "FVG" || state.intradaySmcEntryZoneMode === "OB"
            ? state.intradaySmcEntryZoneMode
            : "EITHER",
        intradaySmcFvgEntryMode:
          state.intradaySmcFvgEntryMode === "midpoint" ? "midpoint" : "zone",
        intradaySmcTp2Mode:
          state.intradaySmcTp2Mode === "internal" || state.intradaySmcTp2Mode === "tiered"
            ? state.intradaySmcTp2Mode
            : "opposing",
        intradaySmcKillzoneMode: String(state.intradaySmcKillzoneMode ?? "LONDON_NY").toUpperCase(),
        intradaySmcMinAdx: clamp(Math.round(Number(state.intradaySmcMinAdx ?? 18)), 0, 100),
        intradaySmcHtfStrictness: String(state.intradaySmcHtfStrictness ?? "either").toLowerCase(),
        intradaySmcHtfBiasMode: (() => {
          const m = String(state.intradaySmcHtfBiasMode ?? "parallel").toLowerCase();
          return m === "ema" || m === "structure" ? m : "parallel";
        })(),
        intradaySmcChochStrict: state.intradaySmcChochStrict === true,
        intradaySmcRequirePremiumDiscount: state.intradaySmcRequirePremiumDiscount === true,
        intradaySmcPremiumDiscountOte: state.intradaySmcPremiumDiscountOte === true,
        intradaySmcDealingRangeLookback: clamp(
          Math.round(Number(state.intradaySmcDealingRangeLookback ?? 48)),
          10,
          200,
        ),
        intradaySmcSlMode: state.intradaySmcSlMode === "structure" ? "structure" : "sweep",
        intradaySmcMaxTpRr: clamp(Number(state.intradaySmcMaxTpRr ?? 5), 0, 20),
        intradaySmcMaxHoldBars: clamp(Math.round(Number(state.intradaySmcMaxHoldBars ?? 48)), 0, 2000),
        intradaySrAPlusMode: state.intradaySrAPlusMode === true,
        intradaySrMinVolRatio: Number(state.intradaySrMinVolRatio ?? 1.2),
        intradaySrMinHtfSep: Number(state.intradaySrMinHtfSep ?? 0.0004),
        intradaySrZoneWidthPct: Number(state.intradaySrZoneWidthPct ?? 0.002),
        intradaySrBosMaxBarsAfterReclaim: Number(state.intradaySrBosMaxBarsAfterReclaim ?? 3),
        intradaySrMinConfirmWick: Number(state.intradaySrMinConfirmWick ?? 0.38),
        intradaySrRequireBos: state.intradaySrRequireBos !== false,
        intradaySrRequireConfirm: state.intradaySrRequireConfirm !== false,
        intradaySrRequireVolume: state.intradaySrRequireVolume !== false,
        intradaySrRequireHtfTrend: state.intradaySrRequireHtfTrend !== false,
        intradayLiqTp1Enabled: state.intradayLiqTp1Enabled !== false,
        intradayLiqTp2Enabled: state.intradayLiqTp2Enabled !== false,
        intradayLiqBreakevenAfterPartial: state.intradayLiqBreakevenAfterPartial !== false,
        intradayLiqPartialTp: state.intradayLiqPartialTp !== false,
        intradayLiqPartialFrac: clamp(Number(state.intradayLiqPartialFrac ?? 0.5), 0.1, 0.75),
        intradayLiqTp1Rr: Number(state.intradayLiqTp1Rr ?? 1),
        intradayLiqTp2Rr: Number(state.intradayLiqTp2Rr ?? 0),
        intradayLiqTp2PartialFrac: Number(state.intradayLiqTp2PartialFrac ?? 0),
        intradayLiqMinRr: Number(state.intradayLiqMinRr ?? 1.5),
        intradayLiqStrictMode: state.intradayLiqStrictMode !== false,
        intradayLiqMinSweepExtensionPct: Number(state.intradayLiqMinSweepExtensionPct ?? 0.003),
        intradayLiqSessionExtreme: state.intradayLiqSessionExtreme === true,
        intradayLiqMinScore: clamp(Math.round(Number(state.intradayLiqMinScore ?? 6)), 0, 20),
        intradayLiqMinQuality: Number(state.intradayLiqMinQuality ?? 0),
        intradayLiqMinWickRatio: Number(state.intradayLiqMinWickRatio ?? 0),
        intradayLiqMinReclaimBodyRatio: Number(state.intradayLiqMinReclaimBodyRatio ?? 0),
        intradayLiqMinReclaimClosePct: Number(state.intradayLiqMinReclaimClosePct ?? 0),
        intradayLiqRejectSameBarReclaim: state.intradayLiqRejectSameBarReclaim !== false,
        intradayLiqOnePickPerDay: state.intradayLiqOnePickPerDay !== false,
        intradayLiqMaxTradesPerSidePerDay: clamp(
          Math.round(Number(state.intradayLiqMaxTradesPerSidePerDay ?? 1)),
          1,
          10,
        ),
        intradayLiqRequireHtfAlign: state.intradayLiqRequireHtfAlign !== false,
        intradayLiqMinHtfSep: Number(state.intradayLiqMinHtfSep ?? 0.0008),
        intradayLiqMaxTpRr: clamp(
          Number(
            Object.prototype.hasOwnProperty.call(state, "intradayLiqMaxTpRr")
              ? state.intradayLiqMaxTpRr
              : (state.intradaySmcMaxTpRr ?? 5),
          ),
          0,
          20,
        ),
        intradayLiqMaxSlPct: Number(state.intradayLiqMaxSlPct ?? 0.035),
        intradayLiqMaxSweepBars: clamp(Math.round(Number(state.intradayLiqMaxSweepBars ?? 40)), 4, 200),
        intradayLiqFirstCycleOnly: state.intradayLiqFirstCycleOnly === true,
        intradayLiqEntryAtSignalClose: state.intradayLiqEntryAtSignalClose !== false,
        intradayLiqMaxHoldBars: clamp(Math.round(Number(state.intradayLiqMaxHoldBars ?? 0)), 0, 2000),
        ...liqMapPublicSnapshot(),
        srIntradayMaxTradesPerDay: clamp(Math.round(Number(state.srIntradayMaxTradesPerDay ?? 5)), 1, 50),
        srIntradayMinBarGap: clamp(Math.round(Number(state.srIntradayMinBarGap ?? 4)), 1, 200),
        ...volumeProfilePublicSnapshot(state),
        supertrendBigMoveGateEnabled: state.supertrendBigMoveGateEnabled === true,
        supertrendBigMoveMinStrength: state.supertrendBigMoveMinStrength,
        supertrendBigMoveMinMoveSlRatio: state.supertrendBigMoveMinMoveSlRatio,
        supertrendBigMoveMinAdx: state.supertrendBigMoveMinAdx,
        supertrendBigMoveMinScore: state.supertrendBigMoveMinScore,
        supertrendBigMoveMaxCandlesSinceFlip: state.supertrendBigMoveMaxCandlesSinceFlip,
        supertrendBigMoveMinVolumeVsAvg: state.supertrendBigMoveMinVolumeVsAvg,
        supertrendBigMoveExpectedMoveAtrMult: state.supertrendBigMoveExpectedMoveAtrMult,
        supertrendMoveQualityMinScore: state.supertrendMoveQualityMinScore,
        supertrendMoveQualityMinAdx: state.supertrendMoveQualityMinAdx,
        supertrendMoveQualityMinMoveSlRatio: state.supertrendMoveQualityMinMoveSlRatio,
        supertrendMoveQualityExpectedMoveAtrMult: state.supertrendMoveQualityExpectedMoveAtrMult,
        supertrendMoveQualityMinAtrExpansion: state.supertrendMoveQualityMinAtrExpansion,
        supertrendMoveQualityMinBodyVsAvg: state.supertrendMoveQualityMinBodyVsAvg,
        supertrendMoveQualityMinDirectionalBody: state.supertrendMoveQualityMinDirectionalBody,
        supertrendMoveQualityMinVolumeVsAvg: state.supertrendMoveQualityMinVolumeVsAvg,
        ...eliteStPublicSnapshot(),
        marketDecision: state.marketDecision && typeof state.marketDecision === "object" ? { ...state.marketDecision } : {},
        supertrendBreakoutConfirm: state.supertrendBreakoutConfirm === true,
        supertrendBreakoutMaxBars: state.supertrendBreakoutMaxBars,
        signalStrengthOpenMin: state.signalStrengthOpenMin,
        smartSignalStrengthThreshold:
          state.smartSignalStrengthThreshold != null && Number.isFinite(Number(state.smartSignalStrengthThreshold))
            ? clamp(Math.round(Number(state.smartSignalStrengthThreshold)), 0, 100)
            : null,
        smartSignalStrengthThresholdMeta:
          state.smartSignalStrengthThresholdMeta && typeof state.smartSignalStrengthThresholdMeta === "object"
            ? { ...state.smartSignalStrengthThresholdMeta }
            : null,
        supertrendFuturesMinAiProb: state.supertrendFuturesMinAiProb,
        surfPulseMlGateEnabled: state.surfPulseMlGateEnabled !== false,
        surfPulseMlThreshold: state.surfPulseMlThreshold,
        intelligenceGateEnabled: state.intelligenceGateEnabled === true,
        intelligenceGateStrict: state.intelligenceGateStrict === true,
        intelligenceGateHighWinRate: state.intelligenceGateHighWinRate === true,
        intelligenceGateManualStrategies: state.intelligenceGateManualStrategies === true,
        supertrendFuturesExitOnFlip: state.supertrendFuturesExitOnFlip !== false,
        trailingStopLossAuto: state.trailingStopLossAuto,
        trailOnlyAfterTp2Fill: state.trailOnlyAfterTp2Fill === true,
        futuresTrailingStopMode: normalizeFuturesTrailingStopMode(state.futuresTrailingStopMode),
        futuresTrailingStFeeBreakeven: state.futuresTrailingStFeeBreakeven !== false,
        futuresTrailingStAdvanced: state.futuresTrailingStAdvanced !== false,
        trailingStopExtraScalpingPcts: normalizeTrailingExtraPcts(state.trailingStopExtraScalpingPcts),
        trailOpenFeeRate: state.trailOpenFeeRate,
        trailCloseFeeRate: state.trailCloseFeeRate,
        tradeHistoryMakerOpenFeeRate: state.tradeHistoryMakerOpenFeeRate,
        tradeHistoryMakerCloseFeeRate: state.tradeHistoryMakerCloseFeeRate,
        tradeHistoryTakerOpenFeeRate: state.tradeHistoryTakerOpenFeeRate,
        tradeHistoryTakerCloseFeeRate: state.tradeHistoryTakerCloseFeeRate,
        trailFeeBeMultiplier: state.trailFeeBeMultiplier,
        trailBufferRate: state.trailBufferRate,
        trailActivationSlippageFrac: state.trailActivationSlippageFrac,
        trailT01LockSlippageFrac: state.trailT01LockSlippageFrac,
        trailBufferAtrMult: state.trailBufferAtrMult,
        trailBufferMode: normalizeTrailBufferMode(state.trailBufferMode),
        trailPostT02ActivationBufferRate: state.trailPostT02ActivationBufferRate,
        trailMinSlDistFrac: state.trailMinSlDistFrac,
        trailMinGapFromMarkFrac: state.trailMinGapFromMarkFrac,
        trailMaintMarginRate: state.trailMaintMarginRate,
        trailPostT02SpacingFrac: state.trailPostT02SpacingFrac,
        trailPostT02MaxExtraTiers: state.trailPostT02MaxExtraTiers,
        ...trailAdvancedPublicSnapshot(),
        supertrendFuturesFixedSlPct: state.supertrendFuturesFixedSlPct,
        supertrendFuturesFixedTpPct: state.supertrendFuturesFixedTpPct,
        supertrendFuturesUseFixedSl: state.supertrendFuturesUseFixedSl !== false,
        supertrendFuturesUseFixedTp: state.supertrendFuturesUseFixedTp !== false,
        supertrendFuturesTwoWay: state.supertrendFuturesTwoWay,
        supertrendFuturesMaxEntrySlippagePct: clamp(Number(state.supertrendFuturesMaxEntrySlippagePct ?? 0.15), 0, 5),
        supertrendFuturesEntryOpenStyle: (() => {
          const s = String(state.supertrendFuturesEntryOpenStyle || "AUTO").toUpperCase();
          return s === "MARKET" || s === "LIMIT_IOC" ? s : "AUTO";
        })(),
        supertrendFuturesEntryRecheckMs: Math.max(0, Math.floor(Number(state.supertrendFuturesEntryRecheckMs ?? 0))),
        supertrendFuturesIocFallbackMarket: state.supertrendFuturesIocFallbackMarket === true,
        supertrendFuturesRequireMarkPrice: state.supertrendFuturesRequireMarkPrice === true,
        supertrendFuturesRequireBookTicker: state.supertrendFuturesRequireBookTicker === true,
        supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(Number(state.supertrendFuturesMaxSignalLagMs ?? 0))),
        supertrendPeriod: state.supertrendPeriod,
        supertrendMultiplier: state.supertrendMultiplier,
        supertrendWilderAtr: state.supertrendWilderAtr,
        trendHtfStRegimeGate: state.trendHtfStRegimeGate === true,
        trendHtfStSurgicalLossFilter: state.trendHtfStSurgicalLossFilter === true,
        trendHtfStQualityFilter: state.trendHtfStQualityFilter === true,
        trendHtfStFlipExitBeforeSl: state.trendHtfStFlipExitBeforeSl === true,
        trendHtfStMaxEntryRangeAtr: Number(state.trendHtfStMaxEntryRangeAtr) || 0,
        trendHtfStMinHtfSep: Number(state.trendHtfStMinHtfSep) || 0.0005,
        trendHtfStRegimeTpTrend: Number(state.trendHtfStRegimeTpTrend) || 0.03,
        trendHtfStRegimeTpMixed: Number(state.trendHtfStRegimeTpMixed) || 0.035,
        trendHtfStRegimeTpChop: Number(state.trendHtfStRegimeTpChop) || 0.04,
        backtestBreakevenAtMfePct: Number(state.backtestBreakevenAtMfePct) || 0,
      },
      tradingFormDefaults: { ...state.tradingFormDefaults },
    };
  }

  function persistTradingConfigToDisk() {
    try {
      writeBotTradingConfig(buildTradingConfigPersistPayload(), cfgPersistenceSlug);
    } catch (e) {
      log?.warn?.("bot_trading_config_persist_failed", { error: String(e?.message || e) });
    }
  }

  function hydrateTradingConfigFromPersistedObject(raw) {
    if (!raw || typeof raw !== "object") return;
    const b = raw.bot;
    if (b && typeof b === "object") {
      const patch = { ...b };
      if (raw.tradingFormDefaults && typeof raw.tradingFormDefaults === "object") {
        patch.tradingFormDefaults = raw.tradingFormDefaults;
      }
      updateConfig(patch, { fromPersisted: true });
      return;
    }
    if (raw.tradingFormDefaults && typeof raw.tradingFormDefaults === "object") {
      updateConfig({ tradingFormDefaults: raw.tradingFormDefaults }, { fromPersisted: true });
    }
  }

  function hydrateTradingConfigFromDisk() {
    const raw = readBotTradingConfig(cfgPersistenceSlug);
    hydrateTradingConfigFromPersistedObject(raw);
  }

  let smartSsRefreshTimer = null;
  let smartSsRefreshInFlight = false;

  async function refreshSmartSignalStrengthThreshold({ reason } = {}) {
    if (smartSsRefreshInFlight) return;
    if (!marketFeedUsesLiveBinance()) return;
    const sym = String(state.symbol || "").toUpperCase();
    const tf = String(state.timeframe || "1m");
    if (!sym) return;
    smartSsRefreshInFlight = true;
    try {
      const rows = readSupertrendSignalHistory({
        symbol: sym,
        timeframe: tf,
        limit: Math.min(8000, SUPERTREND_SIGNAL_STATE_MAX * 2),
        persistenceSlug: cfgPersistenceSlug,
      });
      if (!rows.length) {
        state.smartSignalStrengthThresholdMeta = {
          ...(state.smartSignalStrengthThresholdMeta && typeof state.smartSignalStrengthThresholdMeta === "object"
            ? state.smartSignalStrengthThresholdMeta
            : {}),
          reason: "no_history",
          updatedAt: Date.now(),
        };
        return;
      }
      const minTs = Math.min(...rows.map((r) => Number(r.ts)));
      const maxTs = Math.max(...rows.map((r) => Number(r.ts)));
      const marginMs = 14 * 24 * 60 * 60 * 1000;
      const startMs = Math.max(0, minTs - marginMs);
      const endMs = maxTs + 6 * 60 * 60 * 1000;
      const klines = await fetchBinanceKlinesRange({
        symbol: sym,
        interval: tf,
        startTime: startMs,
        endTime: endMs,
        maxRows: 60_000,
        feedKind: effectiveMarketFeedKind(),
      });
      const closeBySec = closeBySecFromKlines(klines);
      const verdicts = computeSupertrendSignalVerdictsBackend(rows, closeBySec);
      const prior = state.smartSignalStrengthThreshold;
      const { threshold, meta } = learnSmartSignalStrengthThreshold(rows, verdicts, prior);
      state.smartSignalStrengthThreshold = threshold;
      state.smartSignalStrengthThresholdMeta = {
        ...meta,
        updatedAt: Date.now(),
        symbol: sym,
        timeframe: tf,
        reason: reason || meta?.reason || "recomputed",
      };
      persistTradingConfigToDisk();
      try {
        const candlesSs = feed.getCandles();
        const lastSs = candlesSs.length ? candlesSs[candlesSs.length - 1] : null;
        const pfSs = portfolioMtmForWs(lastSs, candlesSs, _cachedPositions, _cachedAccount, null);
        wsHubRef?.broadcast?.("state", {
          mode: runtimeTradingMode(),
          ...getPublicState(),
          account: pfSs.account,
          positions: pfSs.positionsMtM,
        });
      } catch {
        /* ignore */
      }
    } catch (e) {
      log?.warn?.("smart_ss_threshold_refresh_failed", { error: String(e?.message || e) });
    } finally {
      smartSsRefreshInFlight = false;
    }
  }

  function scheduleSmartSsRefresh(delayMs = 6000) {
    if (smartSsRefreshTimer) clearTimeout(smartSsRefreshTimer);
    smartSsRefreshTimer = setTimeout(() => {
      smartSsRefreshTimer = null;
      void refreshSmartSignalStrengthThreshold({ reason: "debounced" });
    }, delayMs);
    smartSsRefreshTimer.unref?.();
  }

  function loadSupertrendSignalHistoryFromDisk() {
    try {
      maybeMigrateLegacySupertrendSignalHistory(cfgPersistenceSlug);
      state.supertrendSignalHistory = readSupertrendSignalHistory({
        symbol: state.symbol,
        timeframe: state.timeframe,
        limit: SUPERTREND_SIGNAL_STATE_MAX,
        allSymbols: configIndicatesMultiCoinSupertrendSweeps(),
        persistenceSlug: cfgPersistenceSlug,
      });
      scheduleSmartSsRefresh(4000);
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

  /** When `supertrendHtf4hEnabled` OR SUPERTREND_ELITE with 4H gate, block misaligned opens. */
  function htf4hBlocksOpen({ openingSide, candles }) {
    if (manualStrategyUsesLiveBarClose(state) && manualStrategyKey(state) !== "SUPERTREND") {
      return null;
    }
    if (manualStrategyUsesLiveBarClose(state) && state.eliteStRequireHtf4hAlign === true) {
      return null;
    }
    const eliteActive = state.manualStrategy === "SUPERTREND_ELITE" && state.eliteStRequireHtf4hAlign === true;
    if (!state.supertrendHtf4hEnabled && !eliteActive) return null;
    if (openingSide !== "BUY" && openingSide !== "SELL") return null;
    const clean = sanitizeCandlesForSt(candles);
    if (!clean.length) return { reason: "htf4h_no_candles", htf4hTrend: 0 };
    const ctx = buildHtf4hContext(clean, {
      period: state.supertrendHtf4hPeriod,
      multiplier: state.supertrendHtf4hMultiplier,
    });
    const result = evaluateHtf4hFilter(ctx, clean[clean.length - 1], openingSide);
    if (result.pass) return null;
    return { reason: result.reason, htf4hTrend: result.htf4hTrend };
  }

  function bigMoveGateCfgFromState() {
    return readBigMoveGateCfg({
      supertrendBigMoveGateEnabled: state.supertrendBigMoveGateEnabled === true,
      supertrendBigMoveMinStrength: state.supertrendBigMoveMinStrength,
      supertrendBigMoveMinMoveSlRatio: state.supertrendBigMoveMinMoveSlRatio,
      supertrendBigMoveMinAdx: state.supertrendBigMoveMinAdx,
      supertrendBigMoveMinScore: state.supertrendBigMoveMinScore,
      supertrendBigMoveMaxCandlesSinceFlip: state.supertrendBigMoveMaxCandlesSinceFlip,
      supertrendBigMoveMinVolumeVsAvg: state.supertrendBigMoveMinVolumeVsAvg,
      supertrendBigMoveExpectedMoveAtrMult: state.supertrendBigMoveExpectedMoveAtrMult,
    });
  }

  /** When `supertrendBigMoveGateEnabled`, require strength + expected move ≥ T1 on the signal bar. */
  function bigMoveBlocksOpen({ openingSide, candles, latest, venue }) {
    const opts = bigMoveGateCfgFromState();
    if (!opts) return null;
    if (openingSide !== "BUY" && openingSide !== "SELL") return null;
    const clean = sanitizeCandlesForSt(candles);
    if (!clean.length) return { reason: "big_move_gate", detail: { pass: false, reason: "no_candles" } };
    const stSeries = computeSupertrendSeries(clean, {
      period: state.supertrendPeriod,
      multiplier: state.supertrendMultiplier,
      wilder: state.supertrendWilderAtr !== false,
    });
    const idx = clean.length - 1;
    const slEst = estimateSlDistancePctForMoveQualityGate(state, latest, venue);
    const bm = evaluateSupertrendBigMoveGate({
      candles: clean,
      idx,
      barSignal: { action: openingSide },
      stSeries,
      lastFlipIdx: idx,
      slDistancePct: slEst,
      opts,
    });
    if (bm.pass) return null;
    return { reason: "big_move_gate", detail: bm };
  }

  /** When `supertrendMoveQualityGate` is on, require ATR/ADX/body/expansion + composite score (futures/spot opens). */
  function moveQualityBlocksOpen({ openingSide, candles, latest, venue }) {
    if (!state.supertrendMoveQualityGate) return null;
    if (openingSide !== "BUY" && openingSide !== "SELL") return null;
    const slEst = estimateSlDistancePctForMoveQualityGate(state, latest, venue);
    const mqEval = evaluateSupertrendMoveQuality({
      candles,
      latest,
      openingSide,
      slDistancePct: slEst,
      options: supertrendMoveQualityEvalOptions(),
    });
    if (mqEval.pass) return null;
    return {
      reason: "move_quality_gate",
      detail: { mq: mqEval, slEst },
    };
  }

  /**
   * Fee gate inputs: use venue round-trip trail fee rates; when basis is T02_ACTIVATION and sync is on,
   * copy fee-BE multiplier, activation slip, and trail buffer from bot trailing (same for opens + chart snapshots).
   */
  function augmentMarketDecisionConfigForFeeGate(mdCfg) {
    const cfg = { ...mdCfg };
    const rt = Number(state.trailOpenFeeRate ?? 0) + Number(state.trailCloseFeeRate ?? 0);
    if (Number.isFinite(rt) && rt > 0) cfg.defaultRoundTripFeeRate = rt;
    if (cfg.feeGateRequiredMoveBasis === "T02_ACTIVATION" && cfg.feeGateT02SyncFromBotTrailing !== false) {
      cfg.feeGateT02FeeBeMultiplier = clamp(
        Number(state.trailFeeBeMultiplier ?? process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1),
        1,
        2,
      );
      cfg.feeGateT02ActivationSlippageFrac = clamp(Number(state.trailActivationSlippageFrac ?? 0), 0, 0.01);
      cfg.feeGateT02TrailBufferRate = clamp(Number(state.trailBufferRate ?? 0.0005), 0, 0.05);
    }
    return cfg;
  }

  /**
   * When the market decision engine is enabled in bot settings, block **opens** when the snapshot verdict
   * is not ALLOW (e.g. BLOCK / WAIT). When the master switch is off, snapshots carry hypothetical verdicts +
   * engineDisabled; this function returns null early because mdCfg.enabled is false.
   * If a full snapshot cannot be built (insufficient bars while enabled), block conservatively.
   */
  function marketDecisionBlocksOpen({ openingSide, candles, cTs, decisionSnapshotBar, symbol }) {
    const mdCfg = mergeMarketDecisionConfig(state.marketDecision);
    if (!mdCfg.enabled) return null;
    if (openingSide !== "BUY" && openingSide !== "SELL") return null;
    const row = {
      buySignal: openingSide === "BUY",
      sellSignal: openingSide === "SELL",
      trend: null,
    };
    let snap;
    try {
      const cfg = augmentMarketDecisionConfigForFeeGate(mdCfg);
      snap = computeMarketDecisionSnapshot({
        candles,
        cTs,
        row,
        decisionSnapshotBar,
        symbol: String(symbol || "").toUpperCase(),
        timeframe: String(state.timeframe || ""),
        config: cfg,
        regimeBtc: null,
        regimeHtf: null,
      });
    } catch (e) {
      log?.warn?.("market_decision_snapshot_error", { symbol, error: String(e?.message || e) });
      return { reason: "market_decision_error", detail: { message: String(e?.message || e) } };
    }
    if (!snap) {
      return {
        reason: "market_decision_unavailable",
        detail: {
          message: "Insufficient candle history for full market-decision snapshot while engine is enabled",
        },
      };
    }
    const v = String(snap.verdict || "").toUpperCase();
    if (v === "ALLOW" || v === "BYPASS") return null; // BYPASS: legacy snapshots only
    return {
      reason: "market_decision_gate",
      detail: { verdict: snap.verdict, failedStage: snap.failedStage, snapshot: snap },
    };
  }

  function supertrendMoveQualityEvalOptions() {
    return {
      minScore: state.supertrendMoveQualityMinScore,
      minAdx: state.supertrendMoveQualityMinAdx,
      minMoveToSlRatio: state.supertrendMoveQualityMinMoveSlRatio,
      expectedMoveAtrMult: state.supertrendMoveQualityExpectedMoveAtrMult,
      minAtrExpansion: state.supertrendMoveQualityMinAtrExpansion,
      minBodyVsAvg: state.supertrendMoveQualityMinBodyVsAvg,
      minDirectionalBody: clamp(Number(state.supertrendMoveQualityMinDirectionalBody ?? 0), 0, 1),
      minVolumeVsAvgRatio: Math.max(0, Number(state.supertrendMoveQualityMinVolumeVsAvg ?? 0)),
    };
  }

  /**
   * Compact MQ feature vector at entry (stored on position meta → joined on close for tuning analysis).
   * @param {"BUY"|"SELL"} openingSide
   * @param {"SPOT"|"FUTURES"} venue
   */
  function buildMqAtEntrySnapshot(openingSide, candles, latest, venue) {
    try {
      const slEst = estimateSlDistancePctForMoveQualityGate(state, latest, venue);
      const mq = evaluateSupertrendMoveQuality({
        candles,
        latest,
        openingSide,
        slDistancePct: slEst,
        options: supertrendMoveQualityEvalOptions(),
      });
      const d = mq.detail || {};
      return {
        mqScore: Number.isFinite(Number(mq.score)) ? Number(mq.score) : null,
        mqVerdict: mq.verdict != null ? String(mq.verdict) : null,
        adx: d.adx != null && Number.isFinite(Number(d.adx)) ? Number(d.adx) : null,
        atrPct: d.atrPct != null && Number.isFinite(Number(d.atrPct)) ? Number(d.atrPct) : null,
        atrExpand: d.atrExpansion != null && Number.isFinite(Number(d.atrExpansion)) ? Number(d.atrExpansion) : null,
        bodyRatio: d.bodyRatio != null && Number.isFinite(Number(d.bodyRatio)) ? Number(d.bodyRatio) : null,
        moveVsSL: d.moveToSlRatio != null && Number.isFinite(Number(d.moveToSlRatio)) ? Number(d.moveToSlRatio) : null,
        expectedMovePct:
          d.expectedMovePct != null && Number.isFinite(Number(d.expectedMovePct)) ? Number(d.expectedMovePct) : null,
        slDistancePct:
          d.slDistancePct != null && Number.isFinite(Number(d.slDistancePct)) ? Number(d.slDistancePct) : null,
        directionalBody:
          d.directionalBody != null && Number.isFinite(Number(d.directionalBody)) ? Number(d.directionalBody) : null,
        volumeVsAvgRatio:
          d.volumeVsAvgRatio != null && Number.isFinite(Number(d.volumeVsAvgRatio))
            ? Number(d.volumeVsAvgRatio)
            : null,
      };
    } catch (e) {
      log?.warn?.("mq_at_entry_snapshot_failed", { error: String(e?.message || e) });
      return null;
    }
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
  /** Set before market feed connects so kline `onCandleClose` never hits TDZ. */
  let wsHubRef = null;
  /** Phase 3E: exchange OPEN leg id (order / position) → DB `trades.id` (open rows). */
  const dbTradeIdByExchangeOpenRef = new Map();
  function rememberDbTradeRef(exchangeRef, dbTradeUuid) {
    if (exchangeRef == null || dbTradeUuid == null) return;
    const a = String(exchangeRef).trim();
    const b = String(dbTradeUuid).trim();
    if (!a || !b) return;
    dbTradeIdByExchangeOpenRef.set(a, b);
  }
  function takeDbTradeIdForClose(t) {
    const m = t?.meta || {};
    const candidates = [];
    if (m.openRefId != null && String(m.openRefId).trim()) candidates.push(String(m.openRefId).trim());
    if (t?.id != null && String(t.id).trim()) candidates.push(String(t.id).trim());
    for (const c of candidates) {
      if (dbTradeIdByExchangeOpenRef.has(c)) {
        const tid = dbTradeIdByExchangeOpenRef.get(c);
        dbTradeIdByExchangeOpenRef.delete(c);
        return tid;
      }
    }
    return null;
  }
  function persistSupertrendSkippedSignal({
    gateReason,
    direction,
    row,
    cTs,
    symbolU,
    decisionSnapshotBar,
    supertrendStrength01,
    stSpot,
    stFut,
  }) {
    if (!getPool()) return;
    let iid = null;
    try {
      iid = typeof getActiveInstanceId === "function" ? getActiveInstanceId() : null;
    } catch {
      iid = null;
    }
    if (!iid || !symbolU) return;
    const tfMs = binanceIntervalMs(state.timeframe);
    const barCloseWall =
      Number.isFinite(cTs) && cTs > 0 && Number.isFinite(tfMs) && tfMs > 0 ? new Date(cTs + tfMs) : new Date();
    void tradeService
      .recordSignal(String(iid), {
        symbol: symbolU,
        signalType: barCloseStrategyKey(),
        direction: direction === "SHORT" ? "SHORT" : "LONG",
        timeframe: state.timeframe,
        barCloseTime: barCloseWall,
        stValue: row?.line != null ? Number(row.line) : null,
        aiProbability: state.lastAi?.probability ?? null,
        mdeScore:
          decisionSnapshotBar?.long?.total != null
            ? Number(decisionSnapshotBar.long.total)
            : decisionSnapshotBar?.short?.total != null
              ? Number(decisionSnapshotBar.short.total)
              : null,
        signalStrength: supertrendStrength01 != null ? Number(supertrendStrength01) : null,
        wasExecuted: false,
        gateReason: gateReason != null ? String(gateReason) : "skipped",
        rawContext: { barTs: cTs, stSpot, stFut },
      })
      .catch((e) => log?.warn?.("trade_signal_persist_failed", { error: String(e?.message || e) }));
  }
  function persistOpenTradeDbRow({
    dbSignalId,
    symbol,
    venue,
    direction,
    order,
    qty,
    stopLoss,
    takeProfit,
    leverage,
  }) {
    if (!getPool() || !order?.id) return;
    let iid = null;
    try {
      iid = typeof getActiveInstanceId === "function" ? getActiveInstanceId() : null;
    } catch {
      iid = null;
    }
    if (!iid) return;
    const entryPx = Number(order.filledPrice);
    const oidBin = venue === "FUTURES" ? binanceFuturesEntryOrderIdFromPlaceOrder(order) : null;
    const oids = [oidBin || String(order.id)].filter(Boolean);
    const dir = direction === "SHORT" ? "SHORT" : "LONG";
    const fillSide = dir === "SHORT" ? "SELL" : "BUY";
    void tradeService
      .openTrade(String(iid), dbSignalId && String(dbSignalId).trim() ? String(dbSignalId) : null, {
        symbol,
        marketType: venue,
        direction: dir,
        quantity: qty,
        entryPrice: Number.isFinite(entryPx) && entryPx > 0 ? entryPx : null,
        notional:
          Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(Number(qty)) ? entryPx * Math.abs(Number(qty)) : null,
        leverage: leverage != null ? Number(leverage) : null,
        slPrice: stopLoss,
        tpPrice: takeProfit,
        binanceOrderIds: oids,
      })
      .then((trow) => {
        if (trow?.id) rememberDbTradeRef(String(order.id), trow.id);
        if (trow?.id && Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(Number(qty)) && qty !== 0) {
          void tradeService
            .addFill(String(trow.id), {
              binanceOrderId: oids[0] || String(order.id),
              binanceTradeId: order.raw?.tradeId != null ? String(order.raw.tradeId) : null,
              fillType: "entry",
              side: fillSide,
              price: entryPx,
              quantity: Math.abs(Number(qty)),
              feeUsdt: order.fee != null && Number.isFinite(Number(order.fee)) ? Number(order.fee) : null,
              filledAt: new Date(),
            })
            .catch((e) => log?.warn?.("trade_fill_persist_failed", { error: String(e?.message || e) }));
        }
      })
      .catch((e) => log?.warn?.("trade_open_persist_failed", { error: String(e?.message || e) }));
  }

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
    const sk =
      p.strategyKey != null
        ? String(p.strategyKey)
        : manualStrategyUsesLiveBarClose(state)
          ? manualStrategyKey(state)
          : "SUPERTREND";
    const kind = p.kind === "strategy" ? "strategy" : barCloseActivityKindFor(state, sk);
    const label = kind === "supertrend" ? "Supertrend signal" : "Strategy signal";
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
    if (p.stopLoss != null && Number.isFinite(Number(p.stopLoss))) msg += ` · SL=${Number(p.stopLoss).toFixed(4)}`;
    if (p.takeProfit != null && Number.isFinite(Number(p.takeProfit))) msg += ` · TP=${Number(p.takeProfit).toFixed(4)}`;
    if (p.signalBarClose != null && Number.isFinite(Number(p.signalBarClose))) {
      msg += ` · signalClose=${Number(p.signalBarClose).toFixed(4)}`;
    }
    if (p.filledPrice != null && Number.isFinite(Number(p.filledPrice))) {
      msg += ` · fill=${Number(p.filledPrice).toFixed(4)}`;
    }
    const level =
      ac === "ERROR" ? "error" : ac === "SKIPPED" ? "warn" : ac === "PENDING" ? "info" : "info";
    const actSymbol =
      p.symbol != null && String(p.symbol).trim() !== ""
        ? String(p.symbol).trim().toUpperCase()
        : String(state.symbol || "").trim().toUpperCase();
    emitActivity(hub, {
      level,
      msg,
      category: "signal",
      reason: p.reason ? String(p.reason) : undefined,
      symbol: actSymbol,
      detail: { kind, strategyKey: sk, venue: ven || undefined, side: sd, action: ac, ...p },
    });
  }

  /** Demo/paper futures ids like `fut_ADAUSDT` — use for Activity when `tradeSymbol` was omitted on feedback payload. */
  function inferSymbolFromSupertrendOrderId(orderId) {
    if (orderId == null) return null;
    const s = String(orderId).trim();
    if (!s) return null;
    const pref = s.match(/^(?:fut|spot)_([A-Z0-9]+)$/i);
    if (pref) return pref[1].toUpperCase();
    if (/^[A-Z0-9]{6,}$/i.test(s) && /(USDT|USDC|BUSD|FDUSD)$/i.test(s)) return s.toUpperCase();
    return null;
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
      stopLoss,
      takeProfit,
      tradeSymbol,
      symbol: resSymbol,
      signalBarClose,
      filledPrice,
      pendingDedupeKey,
    } = result;
    const fromOrderId = inferSymbolFromSupertrendOrderId(orderId);
    const primaryU = String(state.symbol || "").trim().toUpperCase();
    let feedbackSymbol =
      tradeSymbol != null && String(tradeSymbol).trim() !== ""
        ? String(tradeSymbol).trim().toUpperCase()
        : null;
    if (!feedbackSymbol && fromOrderId) feedbackSymbol = fromOrderId;
    if (!feedbackSymbol && resSymbol != null && String(resSymbol).trim() !== "")
      feedbackSymbol = String(resSymbol).trim().toUpperCase();
    if (feedbackSymbol === primaryU && fromOrderId && fromOrderId !== primaryU) feedbackSymbol = fromOrderId;
    const venU = venue != null ? String(venue).toUpperCase() : "";
    const actU = action != null ? String(action).toUpperCase() : "";
    const sideU = side != null ? String(side).toUpperCase() : "";
    /** USD-M: open long = Buy; later flat/SL/TP = Sell rows on Binance — users often match the wrong row. */
    const entryVenueHint =
      venU === "FUTURES" && actU === "PLACED" && (sideU === "BUY" || sideU === "SELL")
        ? sideU === "BUY"
          ? "This line is the OPEN (long): venue shows Buy. Any later Sell on the symbol is usually exit/reduce (SL/TP/flip), not this open."
          : "This line is the OPEN (short): venue shows Sell. Any later Buy on the symbol is usually exit/reduce (SL/TP/flip), not this open."
        : undefined;
    emitSignalActionActivity(hub, {
      kind: barCloseActivityKindFor(state, barCloseStrategyKey()),
      strategyKey: barCloseStrategyKey(),
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
      stopLoss,
      takeProfit,
      ...(Number.isFinite(Number(signalBarClose)) && Number(signalBarClose) > 0 ? { signalBarClose: Number(signalBarClose) } : {}),
      ...(Number.isFinite(Number(filledPrice)) && Number(filledPrice) > 0 ? { filledPrice: Number(filledPrice) } : {}),
      ...(feedbackSymbol ? { symbol: feedbackSymbol } : {}),
      ...(entryVenueHint ? { entryVenueHint } : {}),
      ...(pendingDedupeKey != null && String(pendingDedupeKey).trim() !== ""
        ? { pendingDedupeKey: String(pendingDedupeKey).trim() }
        : {}),
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
    const { stSpot, stFut } = resolveTradingVenueForBarClose(state, mm);

    const venueWant = String(pending.venue || "").toUpperCase();
    const venueOk = venueWant === "SPOT" ? stSpot : stFut;
    if (!stSpot && !stFut) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: "Pending bar-close action skipped: no trading venue (autotrade off or market mode mismatch)",
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
    const strategyKey = barCloseStrategyKey();

    wsHub?.broadcast?.("log", {
      level: "info",
      msg: `Running pending bar-close ${pending.side} (${venueWant}) from bar ${pending.barTs}`,
      symbol: state.symbol,
    });

    state._intelligenceSizeMultiplier = 1;
    if (intelligenceGateAppliesForOpen()) {
      try {
        const openingIntel =
          pending.side === "BUY"
            ? true
            : pending.side === "SELL" && stFut && state.supertrendFuturesTwoWay === true
              ? false
              : null;
        if (openingIntel != null) {
          const ig = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symU,
            openingLong: openingIntel,
            broadcastLog: (p) =>
              hub?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
            logInfo: (eventName, meta) => log?.info?.(eventName, meta),
          });
          if (ig.veto) {
            wsHub?.broadcast?.("log", {
              level: "warn",
              msg: `Pending Supertrend skipped: intelligence gate (${pending.side})`,
              symbol: state.symbol,
            });
            return;
          }
          state._intelligenceSizeMultiplier = ig.sizeMultiplier;
        }
      } catch {
        /* never block on intelligence error */
      }
    }

    if (pending.side === "BUY") {
      if (stSpot && pending.dedupeKeyBuy) {
        const buyRes = await trySupertrendSpotOrder({
          side: "BUY",
          strategyKey,
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: pending.dedupeKeyBuy,
          decisionSnapshot: resolveSupertrendDecisionSnapshot(null),
          candlesOverride: candles.map((c) => (c && typeof c === "object" ? { ...c } : c)),
          anchorBarTs: pending.barTs,
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
          candlesOverride: candles.map((c) => (c && typeof c === "object" ? { ...c } : c)),
          anchorBarTs: pending.barTs,
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
          candlesOverride: candles.map((c) => (c && typeof c === "object" ? { ...c } : c)),
          anchorBarTs: pending.barTs,
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
          candlesOverride: candles.map((c) => (c && typeof c === "object" ? { ...c } : c)),
          anchorBarTs: pending.barTs,
        });
        emitSupertrendSignalFeedback(hub, sellRes);
        if (sellRes?.action === "placed") await pushImmediateState(hub);
      }
    }
  }

  /**
   * @param {{ side: string, strategyKey: string, wsHub: any, indicatorFullCapital?: boolean, dedupeKey?: string | null, tradeSymbol?: string | null, candlesOverride?: array | null, fixedQuoteSpendUsdt?: number | null, multiUnpinnedOrder?: boolean, anchorBarTs?: number | null }} args
   * `indicatorFullCapital`: spot wallet — BUY spends ~all quote free balance; SELL closes full base position (Supertrend-only path).
   * `anchorBarTs`: when set, size/price use the candle with this `ts` (closed bar) instead of the buffer tail — needed when override ends with the next forming bar (AUTO-multi / mux).
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
    anchorBarTs = null,
    dbSignalId = null,
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
    if (state.paused && side === "BUY") {
      return { venue: "SPOT", side, action: "skipped", reason: "bot_paused" };
    }
    const orderSymbol = String(tradeSymbol || state.symbol).toUpperCase();
    const candles =
      Array.isArray(candlesOverride) && candlesOverride.length ? candlesOverride : feed.getCandles();
    const anchorTsSpot = Number(anchorBarTs);
    let last = candles.length ? candles[candles.length - 1] : null;
    if (Number.isFinite(anchorTsSpot) && anchorTsSpot > 0 && Array.isArray(candles)) {
      const hit = candles.find((c) => Number(c?.ts) === anchorTsSpot);
      if (hit) last = hit;
    }
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
      const htf4hSpot = htf4hBlocksOpen({ openingSide: "BUY", candles });
      if (htf4hSpot) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend spot BUY skipped: 4H ST confirmation (${htf4hSpot.reason}) — 4H trend ${htf4hSpot.htf4hTrend > 0 ? "bullish" : htf4hSpot.htf4hTrend < 0 ? "bearish" : "unknown"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "SPOT",
          side,
          action: "skipped",
          reason: htf4hSpot.reason,
          htf4hTrend: htf4hSpot.htf4hTrend,
        };
      }
      const bmSpot = bigMoveBlocksOpen({
        openingSide: "BUY",
        candles,
        latest: indicators.latest,
        venue: "SPOT",
      });
      if (bmSpot) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend spot BUY skipped: big-move gate — ${bmSpot.detail?.reason ?? "fail"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "SPOT",
          side,
          action: "skipped",
          reason: bmSpot.reason,
          bigMoveGate: bmSpot.detail,
        };
      }
      const gate = state.supertrendBigMoveGateEnabled
        ? null
        : signalStrengthBlocksOpen({ openingSide: "BUY", decisionSnapshot: decisionSnapSpot });
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
      const barTsMd =
        Number.isFinite(anchorTsSpot) && anchorTsSpot > 0 ? anchorTsSpot : Number(last?.ts);
      const mdSpot = marketDecisionBlocksOpen({
        openingSide: "BUY",
        candles,
        cTs: barTsMd,
        decisionSnapshotBar: decisionSnapSpot,
        symbol: orderSymbol,
      });
      if (mdSpot) {
        const sn = mdSpot.detail?.snapshot;
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend spot BUY skipped: market decision — verdict ${sn?.verdict ?? mdSpot.reason} · stage ${sn?.failedStage ?? "—"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "SPOT",
          side,
          action: "skipped",
          reason: mdSpot.reason,
          ...(sn ? { marketDecisionSnapshot: sn } : {}),
        };
      }
      const mqSpot = state.supertrendBigMoveGateEnabled
        ? null
        : moveQualityBlocksOpen({
            openingSide: "BUY",
            candles,
            latest: indicators.latest,
            venue: "SPOT",
          });
      if (mqSpot) {
        const mq = mqSpot.detail?.mq;
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend spot BUY skipped: move-quality gate — score ${mq?.score ?? "—"} verdict ${mq?.verdict ?? "—"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "SPOT",
          side,
          action: "skipped",
          reason: mqSpot.reason,
          moveQuality: mq,
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
        let spend = tradable * bufferPct;
        if (intelligenceGateAppliesForOpen()) {
          const im = Number(state._intelligenceSizeMultiplier);
          if (Number.isFinite(im) && im > 0 && im !== 1) spend *= im;
        }
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
        let spend = Math.min(fixedSpend * bufferPct, tradable * bufferPct);
        if (intelligenceGateAppliesForOpen()) {
          const im = Number(state._intelligenceSizeMultiplier);
          if (Number.isFinite(im) && im > 0 && im !== 1) spend *= im;
        }
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
      const rpSpot = resolveFixedUsdtRiskForOrder(orderSymbol, positions);
      const _pctCapSpot = pctPolicyCapForRiskPlan();
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Sizing · ${orderSymbol} · unit=${String(state.riskPerTradeUnit || "PCT").toUpperCase()} riskPerTrade=${Number(rpSpot.riskPerTrade).toFixed(2)} splitDiv=${Math.max(1, Math.floor(Number(rpSpot.fixedUsdtSplitDivisor) || 1))} pctCap=${_pctCapSpot != null ? Number(_pctCapSpot).toFixed(2) : "—"} allowedPool=${Number(state.allowedBudgetUsdt || 0).toFixed(2)} splitMode=${derivedMultiBudgetSplitMode()}`,
        symbol: orderSymbol,
        category: "capital",
      });
      const plan = await riskPlan({
        exchange: spot,
        side,
        entryPrice: last.close,
        confidence: prob,
        riskPerTrade: rpSpot.riskPerTrade,
        riskPerTradeUnit: state.riskPerTradeUnit,
        fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
        fixedUsdtSplitDivisor: rpSpot.fixedUsdtSplitDivisor,
        pctPolicyCapUsdt: _pctCapSpot,
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
      if (side === "BUY" && intelligenceGateAppliesForOpen()) {
        const im = Number(state._intelligenceSizeMultiplier);
        if (Number.isFinite(im) && im > 0 && im !== 1) qty = roundTo(qty * im, 8);
      }
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
      const mqAtEntrySpot = side === "BUY" ? buildMqAtEntrySnapshot("BUY", candles, indicators.latest, "SPOT") : null;
      const order = await placeOrderWithWalletTelemetry(spot, () =>
        spot.placeOrder({
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
            /** Candle open time (ms) for the Supertrend signal bar used to place this order. */
            signalBarTs: Number.isFinite(Number(last?.ts)) ? Number(last.ts) : undefined,
            signalBarCloseTs:
              Number.isFinite(Number(last?.ts)) && String(state.timeframe || "").trim()
                ? Number(last.ts) + binanceIntervalMs(state.timeframe)
                : undefined,
            ...(mqAtEntrySpot ? { mqAtEntry: mqAtEntrySpot } : {}),
          },
        }),
      );
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
        broadcastTrade(wsHub, {
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
        persistOpenTradeDbRow({
          dbSignalId,
          symbol: orderSymbol,
          venue: "SPOT",
          direction: "LONG",
          order,
          qty,
          stopLoss,
          takeProfit,
          leverage: null,
        });
      } else {
        const exitPx = Number(order.filledPrice);
        broadcastTrade(wsHub, {
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
        tradeSymbol: orderSymbol,
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

  /** symbol → { ts, min } — exchange MIN_NOTIONAL (quote USDT) for USD-M. */
  const futuresMinNotionalCache = new Map();

  async function getFuturesMinNotionalCached(symU) {
    const k = String(symU || "").toUpperCase();
    if (!k) return 5;
    const now = Date.now();
    const prev = futuresMinNotionalCache.get(k);
    if (prev && now - prev.ts < 3_600_000) return prev.min;
    let min = 5;
    try {
      if (typeof exch?.getSymbolOrderConstraints === "function") {
        const c = await exch.getSymbolOrderConstraints({ symbol: k, venue: "FUTURES" });
        if (c && c.minNotional != null && Number.isFinite(Number(c.minNotional)) && Number(c.minNotional) > 0) {
          min = Number(c.minNotional);
        }
      }
    } catch {
      /* keep default */
    }
    futuresMinNotionalCache.set(k, { ts: now, min });
    return min;
  }

  /** Depth book for liquidity guards — WS depth on chart symbol, else REST depth, else book ticker. */
  async function resolveSupertrendLiquidityBook(orderSymbol, bookTicker) {
    const symU = String(orderSymbol || "").toUpperCase();
    const liqCfg = readLiquidityGuardConfig();
    if (!(liqCfg.maxSpreadBps > 0 || liqCfg.minDepthUsd > 0)) return null;

    if (depth) {
      const wsBook = depth.getBook?.();
      if (wsBook && String(wsBook.symbol || "").toUpperCase() === symU && wsBook.bids?.length && wsBook.asks?.length) {
        return wsBook;
      }
    }
    if (marketFeedUsesLiveBinance() && effectiveMarketFeedKind() === "BINANCE_FUTURES") {
      const rest = await fetchUsdMDepthBook(symU, runtimeTradingMode(), liqCfg.depthLevels + 10);
      if (rest?.bids?.length && rest?.asks?.length) return rest;
    }
    return depthBookFromTicker(bookTicker);
  }

  /**
   * Supertrend autotrade on USD-M futures: bar-close BUY/SELL uses AI /predict for leverage (AUTO) and sizing.
   * 1-way: BUY opens long; SELL closes long only. 2-way: BUY flips short→long; SELL flips long→short.
   * With AI confidence filter off: SL/TP default to fixed % (0.002 / 0.015) after risk-based qty.
   * Optional `anchorBarTs`: use the candle with this `ts` for entry mark / sizing when the override buffer tail is a newer forming bar (AUTO-multi / mux).
   * Optional `barCloseAiGates`: when set (e.g. AUTO-multi), reuse one `/predict` result for sizing — avoids a second network round-trip before `placeOrder`.
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
    anchorBarTs = null,
    barCloseAiGates = null,
    dbSignalId = null,
    adapterSignal = null,
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
    const _hasCandlesOverride = Array.isArray(candlesOverride) && candlesOverride.length > 0;
    const candles = _hasCandlesOverride ? candlesOverride : feed.getCandles();
    const anchorTsFut = Number(anchorBarTs);
    let last = candles.length ? candles[candles.length - 1] : null;
    let anchoredFromBarTs = false;
    if (Number.isFinite(anchorTsFut) && anchorTsFut > 0 && Array.isArray(candles)) {
      const hit = candles.find((c) => Number(c?.ts) === anchorTsFut);
      if (hit) {
        last = hit;
        anchoredFromBarTs = true;
      }
    }
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
          const notifyActivity = (partial) =>
            emitActivity(wsHub, {
              category: partial.category || "risk",
              level: partial.level || "info",
              ...partial,
            });
          const r = await closer.closePosition({
            id: closeId,
            ...(Number.isFinite(markPx) && markPx > 0 ? { price: markPx } : {}),
            reason: reasonLabel,
            notifyActivity,
          });
          if (!r?.ok) {
            wsHub?.broadcast?.("log", {
              level: "error",
              msg: `Supertrend futures close failed: ${r?.error || "unknown"}`,
              symbol: orderSymbol,
            });
            return { ok: false, error: String(r?.error || "close_failed") };
          }
          wsHub?.broadcast?.("log", {
            level: "info",
            msg:
              pos.side === "BUY"
                ? "Supertrend — closed futures long (flip / exit; TP/SL on exchange may also apply)"
                : "Supertrend — closed futures short (flip / exit)",
            symbol: orderSymbol,
            strategyKey,
          });
          // Do not broadcastTrade here: USD-M adapters record the real CLOSE via income / getTrades
          // (pnl + fill). A synthetic WS row used last.close as "exit", closePosition() often returns no
          // pnl → UI inferred bogus negative gross next to the true Binance row (duplicate "Signal" line).
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
        tradeSymbol: orderSymbol,
      };
    }

    /** BUY: open long; 2-way closes any short first. */
    if (side === "BUY") {
      if (state.paused) {
        if (shortHere.length > 0 && twoWay) {
          const cr = await closeFuturesLegsForSupertrend(shortHere, "SUPERTREND_EXIT_PAUSED");
          if (!cr.ok) return { venue: "FUTURES", side, action: "error", reason: String(cr.error || "close_failed") };
          const pos0 = shortHere[0];
          return {
            venue: "FUTURES",
            side,
            action: "placed",
            orderId: pos0?.id || pos0?.symbol,
            qty: pos0?.qty,
            tradeSymbol: orderSymbol,
            reason: "paused_close_short_only",
          };
        }
        return { venue: "FUTURES", side, action: "skipped", reason: "bot_paused" };
      }
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
          emitActivity(wsHub, {
            level: "warn",
            msg: `Supertrend flip: close short failed (${String(cr.error || "unknown")}) but exchange has no short — opening long`,
            category: "signal",
            reason: "flip_close_error_but_flat",
            symbol: orderSymbol,
            detail: { priorError: String(cr.error || "") },
          });
        }
        if (state.paused) {
          return {
            venue: "FUTURES",
            side,
            action: "placed",
            tradeSymbol: orderSymbol,
            reason: "paused_no_new_long_after_short_cover",
          };
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
        if (state.paused) {
          return {
            venue: "FUTURES",
            side,
            action: "placed",
            tradeSymbol: orderSymbol,
            reason: "paused_close_long_only",
          };
        }
      }
      if (shortHere.length > 0) {
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: "Supertrend futures SELL skipped: already short on this symbol",
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "already_in_short" };
      }
      if (state.paused) {
        return { venue: "FUTURES", side, action: "skipped", reason: "bot_paused" };
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

    const manualAdapterPath =
      manualStrategyUsesLiveBarClose(state) && manualStrategyKey(state) !== "SUPERTREND";

    const htf4hFut = manualAdapterPath ? null : htf4hBlocksOpen({ openingSide, candles });
    if (htf4hFut) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} skipped: 4H ST confirmation (${htf4hFut.reason}) — 4H trend ${htf4hFut.htf4hTrend > 0 ? "bullish" : htf4hFut.htf4hTrend < 0 ? "bearish" : "unknown"}`,
        symbol: orderSymbol,
      });
      return {
        venue: "FUTURES",
        side,
        action: "skipped",
        reason: htf4hFut.reason,
        htf4hTrend: htf4hFut.htf4hTrend,
      };
    }

    const bmFut = manualAdapterPath
      ? null
      : bigMoveBlocksOpen({
      openingSide,
      candles,
      latest: indicators.latest,
      venue: "FUTURES",
    });
    if (bmFut) {
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} skipped: big-move gate — ${bmFut.detail?.reason ?? "fail"} str=${bmFut.detail?.strength ?? "—"} move/SL=${bmFut.detail?.moveToSlRatio ?? "—"}`,
        symbol: orderSymbol,
      });
      return {
        venue: "FUTURES",
        side,
        action: "skipped",
        reason: bmFut.reason,
        bigMoveGate: bmFut.detail,
      };
    }
    const gate = manualAdapterPath
      ? null
      : state.supertrendBigMoveGateEnabled
      ? null
      : signalStrengthBlocksOpen({ openingSide, decisionSnapshot: snapUsedForOpen });
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

    if (openingSide === "BUY" || (openingSide === "SELL" && twoWay)) {
      const barTsMd =
        Number.isFinite(anchorTsFut) && anchorTsFut > 0 ? anchorTsFut : Number(last?.ts);
      const mdFut = manualAdapterPath
        ? null
        : marketDecisionBlocksOpen({
        openingSide,
        candles,
        cTs: barTsMd,
        decisionSnapshotBar: snapUsedForOpen,
        symbol: orderSymbol,
      });
      if (mdFut) {
        const sn = mdFut.detail?.snapshot;
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend futures ${openingSide} skipped: market decision — verdict ${sn?.verdict ?? mdFut.reason} · stage ${sn?.failedStage ?? "—"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "FUTURES",
          side,
          action: "skipped",
          reason: mdFut.reason,
          ...(sn ? { marketDecisionSnapshot: sn } : {}),
        };
      }
      const mqFut = manualAdapterPath
        ? null
        : state.supertrendBigMoveGateEnabled
        ? null
        : moveQualityBlocksOpen({
            openingSide,
            candles,
            latest: indicators.latest,
            venue: "FUTURES",
          });
      if (mqFut) {
        const mq = mqFut.detail?.mq;
        wsHub?.broadcast?.("log", {
          level: "info",
          msg: `Supertrend futures ${openingSide} skipped: move-quality gate — score ${mq?.score ?? "—"} verdict ${mq?.verdict ?? "—"} hard=${(mq?.hardFails || []).join(",") || "—"}`,
          symbol: orderSymbol,
        });
        return {
          venue: "FUTURES",
          side,
          action: "skipped",
          reason: mqFut.reason,
          moveQuality: mq,
        };
      }
    }

    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let gateProb = manualAdapterPath ? (isFixedUsdtCapitalMode() ? 1 : 0.75) : NaN;
    if (!manualAdapterPath && barCloseAiGates && typeof barCloseAiGates === "object") {
      const g =
        openingSide === "BUY"
          ? barCloseAiGates.aiGateBuy
          : openingSide === "SELL"
            ? barCloseAiGates.aiGateSell
            : null;
      if (Number.isFinite(Number(g))) gateProb = Number(g);
    }
    if (!manualAdapterPath && !Number.isFinite(gateProb) && candles.length >= aiMinCandles) {
      try {
        const aiResp = await withTimeout(
          ai.predict({ symbol: orderSymbol, timeframe: state.timeframe, candles }),
          AI_PREDICT_TIMEOUT_MS,
        );
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
        if (String(errMsg).includes("timeout") && AI_TIMEOUT_IS_HARD_FAIL) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend futures: AI predict timed out (${AI_PREDICT_TIMEOUT_MS}ms) — skipping this signal (hard fail)`,
            symbol: orderSymbol,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "ai_timeout" };
        }
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: "Supertrend futures: AI predict failed; trying last score",
          error: errMsg,
        });
        log.warn("supertrend_futures_predict_failed", { symbol: orderSymbol, error: errMsg });
      }
    }
    if (!manualAdapterPath && !Number.isFinite(gateProb) && !aiPredictNoLastAi) {
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
      !manualAdapterPath &&
      !isFixedUsdtCapitalMode() &&
      state.supertrendFuturesAiConfidenceFilter !== false;
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

    const rpFut = resolveFixedUsdtRiskForOrder(orderSymbol, positions);
    const allotLaneFut = resolveCapitalAllotmentMarginLaneForOrder(orderSymbol, positions);
    const perCoinMarginCapFutRaw = Number(allotLaneFut.riskPerTrade);
    const perCoinMarginCapFut =
      Number.isFinite(perCoinMarginCapFutRaw) ? Math.max(0, perCoinMarginCapFutRaw) : null;
    const _pctCap = pctPolicyCapForRiskPlan();
    if (perCoinMarginCapFut != null && perCoinMarginCapFut <= 0) {
      wsHub?.broadcast?.("log", {
        level: "info",
        category: "capital",
        symbol: orderSymbol,
        msg: `Supertrend futures ${openingSide} skipped: per-coin capital cap exhausted for ${orderSymbol}`,
      });
      return { venue: "FUTURES", side, action: "skipped", reason: "capital_cap_exhausted" };
    }
    /** Sizing diagnostic — always emitted so users can verify capital-allotment is applied. */
    {
      const unit = String(state.riskPerTradeUnit || "PCT").toUpperCase();
      /** riskPerTrade is now always the direct per-coin margin cap (Fix C1 — no inflation). */
      const perCoinMarginCap = perCoinMarginCapFut ?? Number(rpFut.riskPerTrade);
      const estNotional = perCoinMarginCap != null && lev > 0 ? perCoinMarginCap * lev : null;
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Sizing · ${orderSymbol} · unit=${unit} perCoinMarginCap=${perCoinMarginCap.toFixed(2)} estNotional=${estNotional != null ? estNotional.toFixed(2) : "—"} lev=${lev}x allowedPool=${Number(state.allowedBudgetUsdt || 0).toFixed(2)} splitMode=${derivedMultiBudgetSplitMode()} pctCap=${_pctCap != null ? Number(_pctCap).toFixed(2) : "—"}`,
        symbol: orderSymbol,
        category: "capital",
      });
    }
    if (isFixedUsdtCapitalMode()) {
      const splitDiv = Math.max(1, Math.floor(Number(rpFut.fixedUsdtSplitDivisor) || 1));
      /** marginBase = per-coin margin cap (riskPerTrade is now always the direct per-coin value) */
      const marginBase = splitDiv > 1 ? Number(rpFut.riskPerTrade) / splitDiv : Number(rpFut.riskPerTrade);
      const estOpenNotional = marginBase * lev;
      try {
        const minN = await getFuturesMinNotionalCached(orderSymbol);
        if (Number.isFinite(minN) && minN > 0 && estOpenNotional + 1e-9 < minN) {
          wsHub?.broadcast?.("log", {
            level: "info",
            msg: `Supertrend futures ${openingSide} skipped: open notional ~${estOpenNotional.toFixed(2)} USDT < exchange min ${minN} USDT (capital allotment slice for ${orderSymbol})`,
            symbol: orderSymbol,
          });
          return {
            venue: "FUTURES",
            side,
            action: "skipped",
            reason: "below_min_notional",
            estOpenNotional,
            minNotional: minN,
          };
        }
      } catch (e) {
        log?.warn?.("futures_min_notional_lookup_failed", { symbol: orderSymbol, error: String(e?.message || e) });
      }
    }
    const plan = await riskPlan({
      exchange: futuresEx,
      side: openingSide,
      entryPrice: last.close,
      confidence: sizingConfidence,
      riskPerTrade: rpFut.riskPerTrade,
      riskPerTradeUnit: state.riskPerTradeUnit,
      fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
      fixedUsdtSplitDivisor: rpFut.fixedUsdtSplitDivisor,
      pctPolicyCapUsdt: _pctCap,
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
      const useSl = state.supertrendFuturesUseFixedSl !== false;
      const useTp = state.supertrendFuturesUseFixedTp !== false;
      const slPct = useSl ? clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2) : 0;
      const tpPct = useTp ? clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5) : 0;
      if (useSl) {
        stopLoss = openingSide === "BUY" ? pxEntry * (1 - slPct) : pxEntry * (1 + slPct);
      } else {
        stopLoss = null;
      }
      if (useTp) {
        takeProfit = openingSide === "BUY" ? pxEntry * (1 + tpPct) : pxEntry * (1 - tpPct);
      } else {
        takeProfit = null;
      }
      const perUnitRisk = useSl && stopLoss != null ? Math.abs(pxEntry - stopLoss) : 0;
      const riskUsd = Number(plan.riskUsd);
      if (perUnitRisk > 0 && riskUsd > 0) {
        qty = roundTo(riskUsd / perUnitRisk, 6);
        const walletBp = Number(plan.tradableBalance) * lev;
        /**
         * allotmentBp: max notional from capital allotment (per-coin usable margin cap × leverage).
         * This guard is unit-agnostic: if split-allotment is active, enforce it even when risk unit is PCT.
         */
        const allotmentBp = perCoinMarginCapFut != null ? perCoinMarginCapFut * lev : walletBp;
        const maxNotional = Math.min(walletBp, allotmentBp) * 0.9;
        const notional = qty * pxEntry;
        if (notional > maxNotional && pxEntry > 0) qty = roundTo(maxNotional / pxEntry, 6);
      }
    }

    if (manualAdapterPath && adapterSignal && typeof adapterSignal === "object") {
      const sig = adapterSignal;
      const fibBr =
        sig?.fibBrackets?.slPct > 0
          ? resolveFibEntryBrackets(state, sig, pxEntry, openingSide)
          : null;
      const liqBr =
        !fibBr && sig?.liqBrackets?.slPct > 0
          ? resolveLiquidityEntryBrackets(state, sig, pxEntry, openingSide)
          : null;
      const structBr = fibBr || liqBr;
      if (structBr?.slPrice > 0 && state.supertrendFuturesUseFixedSl !== false) {
        stopLoss = structBr.slPrice;
        const liqLegs = liqBr ? mapLiquidityEntryLegs(liqBr, state) : null;
        if (liqLegs?.tp > 0) {
          takeProfit = liqLegs.tp;
        }
        if (liqLegs?.partialTp && liqLegs.tp1 > 0) {
          plan.takeProfitPartial = liqLegs.tp1;
          plan.takeProfitPartialFrac = liqLegs.partialFrac ?? 0.5;
        }
        if (!takeProfit && structBr.tpPrice > 0 && state.supertrendFuturesUseFixedTp !== false) {
          takeProfit = structBr.tp2Price ?? structBr.tpPrice;
        }
        const perUnitRisk = Math.abs(pxEntry - stopLoss);
        const riskUsd = Number(plan.riskUsd);
        if (perUnitRisk > 0 && riskUsd > 0) {
          qty = roundTo(riskUsd / perUnitRisk, 6);
        }
      } else if (sig?.vpBrackets?.slPct > 0 && state.intradayVpBrackets === true) {
        Object.assign(
          plan,
          applyFixedPctBracket(plan, {
            entryPrice: pxEntry,
            side: openingSide,
            slPct: sig.vpBrackets.slPct,
            tpPct:
              state.supertrendFuturesUseFixedTp !== false ? (sig.vpBrackets.tpPct ?? 0) : 0,
            futuresLeverage: lev,
          }),
        );
        stopLoss = plan.stopLoss;
        takeProfit = plan.takeProfit;
        qty = plan.qty;
      } else if (structBr && state.supertrendFuturesUseFixedSl !== false) {
        Object.assign(
          plan,
          applyFixedPctBracket(plan, {
            entryPrice: pxEntry,
            side: openingSide,
            slPct: structBr.slPct,
            tpPct: state.supertrendFuturesUseFixedTp !== false ? structBr.tpPct : 0,
            futuresLeverage: lev,
          }),
        );
        stopLoss = plan.stopLoss;
        takeProfit = plan.takeProfit;
        qty = plan.qty;
      }
      const riskUsdManual = Number(plan.riskUsd);
      if (riskUsdManual > 0 && stopLoss != null) {
        const sizingSl = resolveSizingStopPrice({
          entryFill: pxEntry,
          exitSl: stopLoss,
          side: openingSide,
          cfg: state,
        });
        const perUnitRisk = Math.abs(pxEntry - sizingSl);
        if (perUnitRisk > 0) {
          qty = roundTo(riskUsdManual / perUnitRisk, 6);
        }
      }
    }

    /**
     * HARD CAP: final per-coin margin guard — notional must never exceed the capital allotment
     * margin cap × leverage, regardless of how qty was computed above.
     * Handles edge cases where ATR bracket or tier multiplier overshoot the cap.
     */
    {
      const cq = clampQtyToPerCoinMarginCap({
        symbol: orderSymbol,
        qty,
        entryPx: pxEntry,
        leverage: lev,
        positions,
        wsHub,
        context: "supertrend_open",
      });
      qty = cq.qty;
    }

    const capN = Number(maxNotionalUsd);
    if (Number.isFinite(capN) && capN > 0 && pxEntry > 0) {
      const maxQ = capN / pxEntry;
      if (qty > maxQ) qty = roundTo(maxQ, 6);
    }

    if (intelligenceGateAppliesForOpen()) {
      const intelMult = Number(state._intelligenceSizeMultiplier);
      if (Number.isFinite(intelMult) && intelMult > 0 && intelMult !== 1) {
        qty = roundTo(qty * intelMult, 6);
        {
          const cqM = clampQtyToPerCoinMarginCap({
            symbol: orderSymbol,
            qty,
            entryPx: pxEntry,
            leverage: lev,
            positions,
            wsHub,
            context: "supertrend_open_intel_mult",
          });
          qty = cqM.qty;
        }
        if (Number.isFinite(capN) && capN > 0 && pxEntry > 0) {
          const maxQ2 = capN / pxEntry;
          if (qty > maxQ2) qty = roundTo(maxQ2, 6);
        }
      }
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

    const trailMmOpen = clamp(Number(state.trailMaintMarginRate ?? process.env.SUPERTREND_TRAIL_MAINTENANCE_MARGIN_RATE ?? 0.005), 0, 0.1);
    if (
      state.trailingStopLossAuto &&
      entryRejectedLiquidationBreakeven({
        entryPrice: pxEntry,
        isLong: openingSide === "BUY",
        leverage: lev,
        feeRate: tradeCloseFeeRate(),
        maintenanceMarginRate: trailMmOpen,
      })
    ) {
      wsHub?.broadcast?.("log", {
        level: "warn",
        msg: `Supertrend futures ${openingSide} skipped: approx. liquidation vs fee breakeven invalid at lev=${lev}x (raise leverage or widen fee/MM assumptions).`,
        symbol: orderSymbol,
      });
      emitActivity(wsHub, {
        level: "warn",
        msg: `Open skipped · ${orderSymbol} · liquidation/breakeven geometry (trailing model) at ${lev}x`,
        category: "risk",
        reason: "liquidation_breakeven_reject",
        symbol: orderSymbol,
        detail: { leverage: lev, side: openingSide },
      });
      return { venue: "FUTURES", side, action: "skipped", reason: "liquidation_breakeven_reject" };
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
      // Final just-in-time cap check against freshest open positions.
      {
        const posNow = await exch.getPositions().catch(() => positions);
        const cqLive = clampQtyToPerCoinMarginCap({
          symbol: orderSymbol,
          qty,
          entryPx: Number(last.close),
          leverage: lev,
          positions: Array.isArray(posNow) ? posNow : positions,
          wsHub,
          context: "supertrend_open_live",
        });
        qty = cqLive.qty;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return { venue: "FUTURES", side, action: "skipped", reason: "capital_cap_exhausted" };
      }
      const pxEntryOpen = Number(last.close);
      let slN0 = Number(stopLoss);
      let tpN0 = Number(takeProfit);
      const slOk =
        Number.isFinite(slN0) &&
        slN0 > 0 &&
        Number.isFinite(pxEntryOpen) &&
        pxEntryOpen > 0 &&
        (openingSide === "BUY" ? slN0 < pxEntryOpen : slN0 > pxEntryOpen);
      const tpOk =
        Number.isFinite(tpN0) &&
        tpN0 > 0 &&
        Number.isFinite(pxEntryOpen) &&
        pxEntryOpen > 0 &&
        (openingSide === "BUY" ? tpN0 > pxEntryOpen : tpN0 < pxEntryOpen);
      const useSlFb = state.supertrendFuturesUseFixedSl !== false;
      const useTpFb = state.supertrendFuturesUseFixedTp !== false;
      if ((!slOk && useSlFb) || (!tpOk && useTpFb)) {
        const slPctFb = useSlFb ? clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2) : 0;
        const tpPctFb = useTpFb ? clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5) : 0;
        if (useSlFb && !slOk) {
          stopLoss = openingSide === "BUY" ? pxEntryOpen * (1 - slPctFb) : pxEntryOpen * (1 + slPctFb);
        }
        if (useTpFb && !tpOk) {
          takeProfit = openingSide === "BUY" ? pxEntryOpen * (1 + tpPctFb) : pxEntryOpen * (1 - tpPctFb);
        }
        if ((useSlFb && !slOk) || (useTpFb && !tpOk)) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend futures ${openingSide}: invalid or missing SL/TP vs entry — using configured default SL/TP % (sl=${useSlFb ? slPctFb : "off"}, tp=${useTpFb ? tpPctFb : "off"})`,
            symbol: orderSymbol,
          });
        }
      }
      if (!useSlFb) stopLoss = null;
      if (!useTpFb) takeProfit = null;

      const tfMs = binanceIntervalMs(state.timeframe);
      const barOpenMs = Number(last?.ts);
      const expectedCloseWallMs =
        Number.isFinite(barOpenMs) && barOpenMs > 0 && Number.isFinite(tfMs) && tfMs > 0
          ? barOpenMs + tfMs
          : NaN;
      const signalLagMs = Number.isFinite(expectedCloseWallMs) ? Date.now() - expectedCloseWallMs : NaN;

      const maxLagMs = Math.max(0, Math.floor(Number(state.supertrendFuturesMaxSignalLagMs ?? 0)));
      if (Number.isFinite(maxLagMs) && maxLagMs > 0 && Number.isFinite(signalLagMs) && signalLagMs > maxLagMs) {
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: `Supertrend futures ${openingSide} skipped: bar-close→order delay ${Math.round(signalLagMs)} ms > SUPERTREND_FUTURES_MAX_SIGNAL_LAG_MS=${maxLagMs} (slow AI /predict or network; raise limit or fix AI service).`,
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "stale_signal_lag", signalLagMs };
      }

      const slipPctRaw = clamp(Number(state.supertrendFuturesMaxEntrySlippagePct ?? 0.15), 0, 5);
      const slipFrac = Number.isFinite(slipPctRaw) && slipPctRaw > 0 ? slipPctRaw / 100 : 0;

      const openStyleFromState = String(state.supertrendFuturesEntryOpenStyle || "AUTO").toUpperCase();
      const openStyleUnset = !openStyleFromState || openStyleFromState === "AUTO";
      let openStyle = openStyleUnset
        ? slipFrac > 0
          ? "LIMIT_IOC"
          : "MARKET"
        : openStyleFromState;
      if (openStyle !== "MARKET" && openStyle !== "LIMIT_IOC") openStyle = slipFrac > 0 ? "LIMIT_IOC" : "MARKET";

      const requireBook =
        state.supertrendFuturesRequireBookTicker === true ||
        String(process.env.SUPERTREND_FUTURES_REQUIRE_BOOK_TICKER ?? "0") === "1";
      const requireMark =
        state.supertrendFuturesRequireMarkPrice === true ||
        String(process.env.SUPERTREND_FUTURES_REQUIRE_MARK_PRICE ?? "0") === "1";
      const recheckMs = Math.max(0, Math.floor(Number(state.supertrendFuturesEntryRecheckMs ?? 0)));

      /** Exchange REST bar close for `last.ts` — aligns slippage guard with official OHLC when WS tail lags (live). */
      let slipSignalRef = pxEntryOpen;
      if (slipFrac > 0 && marketFeedUsesLiveBinance() && effectiveMarketFeedKind() === "BINANCE_FUTURES") {
        const barOpenTs = Number(last?.ts);
        if (Number.isFinite(barOpenTs) && barOpenTs > 0) {
          const auth = await fetchUsdMKlineCloseAtOpenTime(
            orderSymbol,
            state.timeframe,
            barOpenTs,
            runtimeTradingMode(),
          );
          if (Number.isFinite(auth) && auth > 0) {
            slipSignalRef = auth;
            if (pxEntryOpen > 0) {
              const rel = Math.abs(auth - pxEntryOpen) / pxEntryOpen;
              if (rel > 0.002) {
                log.warn("supertrend_slip_signal_ref_rest_anchor", {
                  symbol: orderSymbol,
                  feedClose: pxEntryOpen,
                  restBarClose: auth,
                  barOpenTs,
                });
              }
            }
          }
        }
      }

      let bookTicker = null;
      let markPxEntry = null;
      let midPxEntry = null;

      async function loadEntryMicrostructure() {
        const mode = runtimeTradingMode();
        const needBook = slipFrac > 0 || openStyle === "LIMIT_IOC" || requireBook;
        const b = needBook ? await fetchUsdMBookTicker(orderSymbol, mode) : null;
        const mk = slipFrac > 0 || requireMark ? await fetchUsdMPremiumMark(orderSymbol, mode) : null;
        const markPx = mk?.markPrice != null ? Number(mk.markPrice) : null;
        let midPx = null;
        if (b && Number.isFinite(Number(b.bidPrice)) && Number.isFinite(Number(b.askPrice))) {
          midPx = (Number(b.bidPrice) + Number(b.askPrice)) / 2;
        }
        return { bookTicker: b, markPx, midPx };
      }

      function entryDriftFails(bt, markPx, midPx) {
        if (!(slipFrac > 0 && Number.isFinite(slipSignalRef) && slipSignalRef > 0)) return { fail: false };
        const ref = slipSignalRef;
        if (bt) {
          if (openingSide === "BUY") {
            const ask = Number(bt.askPrice);
            if (Number.isFinite(ask) && ask > ref * (1 + slipFrac)) {
              return {
                fail: true,
                msg: `Supertrend futures BUY skipped: best ask ${ask.toFixed(6)} > signal close ${ref.toFixed(6)} + ${slipPctRaw}% (slippage cap; widen SUPERTREND_FUTURES_MAX_ENTRY_SLIPPAGE_PCT or wait)`,
              };
            }
          } else {
            const bid = Number(bt.bidPrice);
            if (Number.isFinite(bid) && bid < ref * (1 - slipFrac)) {
              return {
                fail: true,
                msg: `Supertrend futures SELL skipped: best bid ${bid.toFixed(6)} < signal close ${ref.toFixed(6)} − ${slipPctRaw}%`,
              };
            }
          }
        }
        if (markPx != null && Number.isFinite(markPx) && markPx > 0) {
          if (openingSide === "BUY") {
            if (markPx > ref * (1 + slipFrac)) {
              return {
                fail: true,
                msg: `Supertrend futures BUY skipped: mark ${markPx.toFixed(6)} > signal close ${ref.toFixed(6)} + ${slipPctRaw}% (mark drift vs signal)`,
              };
            }
          } else if (markPx < ref * (1 - slipFrac)) {
            return {
              fail: true,
              msg: `Supertrend futures SELL skipped: mark ${markPx.toFixed(6)} < signal close ${ref.toFixed(6)} − ${slipPctRaw}% (mark drift vs signal)`,
            };
          }
        }
        if (midPx != null && Number.isFinite(midPx) && midPx > 0 && bt) {
          if (openingSide === "BUY") {
            if (midPx > ref * (1 + slipFrac)) {
              return {
                fail: true,
                msg: `Supertrend futures BUY skipped: mid ${midPx.toFixed(6)} > signal close ${ref.toFixed(6)} + ${slipPctRaw}% (book mid drift vs signal)`,
              };
            }
          } else if (midPx < ref * (1 - slipFrac)) {
            return {
              fail: true,
              msg: `Supertrend futures SELL skipped: mid ${midPx.toFixed(6)} < signal close ${ref.toFixed(6)} − ${slipPctRaw}% (book mid drift vs signal)`,
            };
          }
        }
        return { fail: false };
      }

      let micro = await loadEntryMicrostructure();
      bookTicker = micro.bookTicker;
      markPxEntry = micro.markPx;
      midPxEntry = micro.midPx;

      if (
        slipFrac > 0 &&
        !bookTicker &&
        !(Number.isFinite(markPxEntry) && markPxEntry > 0)
      ) {
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: `Supertrend futures ${openingSide} skipped: book ticker and mark price both unavailable — cannot enforce SUPERTREND_FUTURES_MAX_ENTRY_SLIPPAGE_PCT`,
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "entry_quote_unavailable" };
      }

      if (requireBook && slipFrac > 0 && !bookTicker) {
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: `Supertrend futures ${openingSide} skipped: public book ticker unavailable (SUPERTREND_FUTURES_REQUIRE_BOOK_TICKER=1)`,
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "book_ticker_unavailable" };
      }
      if (requireMark && !(Number.isFinite(markPxEntry) && markPxEntry > 0)) {
        wsHub?.broadcast?.("log", {
          level: "warn",
          msg: `Supertrend futures ${openingSide} skipped: mark price unavailable (SUPERTREND_FUTURES_REQUIRE_MARK_PRICE=1)`,
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: "mark_price_unavailable" };
      }

      if (bookTicker) {
        log.info("supertrend_entry_microstructure", {
          symbol: orderSymbol,
          side: openingSide,
          signalBarClose: slipSignalRef,
          feedTailClose: pxEntryOpen,
          bestBid: bookTicker.bidPrice,
          bestAsk: bookTicker.askPrice,
          midPx: midPxEntry,
          markPx: markPxEntry,
          signalLagMs: Number.isFinite(signalLagMs) ? Math.round(signalLagMs) : null,
        });
      } else if (slipFrac > 0 || openStyle === "LIMIT_IOC") {
        log.warn("supertrend_book_ticker_unavailable", { symbol: orderSymbol });
      }

      let drift = entryDriftFails(bookTicker, markPxEntry, midPxEntry);
      if (drift.fail) {
        wsHub?.broadcast?.("log", { level: "warn", msg: drift.msg, symbol: orderSymbol });
        return { venue: "FUTURES", side, action: "skipped", reason: "entry_slippage_guard" };
      }

      if (recheckMs > 0) {
        await new Promise((r) => setTimeout(r, recheckMs));
        micro = await loadEntryMicrostructure();
        bookTicker = micro.bookTicker;
        markPxEntry = micro.markPx;
        midPxEntry = micro.midPx;
        if (
          slipFrac > 0 &&
          !bookTicker &&
          !(Number.isFinite(markPxEntry) && markPxEntry > 0)
        ) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `Supertrend futures ${openingSide} skipped: book + mark unavailable after recheck (SUPERTREND_FUTURES_ENTRY_RECHECK_MS=${recheckMs})`,
            symbol: orderSymbol,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "entry_quote_unavailable_recheck" };
        }
        drift = entryDriftFails(bookTicker, markPxEntry, midPxEntry);
        if (drift.fail) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: `${drift.msg} (after SUPERTREND_FUTURES_ENTRY_RECHECK_MS=${recheckMs})`,
            symbol: orderSymbol,
          });
          return { venue: "FUTURES", side, action: "skipped", reason: "entry_slippage_guard_recheck" };
        }
      }

      const liqRefPx =
        (Number.isFinite(midPxEntry) && midPxEntry > 0 ? midPxEntry : null) ??
        (Number.isFinite(pxEntryOpen) && pxEntryOpen > 0 ? pxEntryOpen : slipSignalRef);
      const estOrderNotional = Number(qty) * Number(liqRefPx);
      const liqBook = await resolveSupertrendLiquidityBook(orderSymbol, bookTicker);
      const liqGuard = evaluateLiquidityGuards({
        book: liqBook,
        side: openingSide,
        referenceMid: liqRefPx,
        orderNotionalUsd: estOrderNotional,
      });
      if (!liqGuard.ok) {
        const liqCfg = readLiquidityGuardConfig();
        noteTradeBlock({
          reason: liqGuard.reason,
          symbol: orderSymbol,
          strategyKey,
          spreadBps: liqGuard.spreadBps,
          maxSpreadBps: liqGuard.maxSpreadBps ?? liqCfg.maxSpreadBps,
          depthNotionalUsd: liqGuard.depthNotionalUsd,
          minDepthUsd: liqGuard.minDepthUsd ?? liqCfg.minDepthUsd,
          orderNotionalUsd: liqGuard.orderNotionalUsd ?? estOrderNotional,
        });
        const liqMsg =
          liqGuard.reason === "spread_too_wide"
            ? `Supertrend futures ${openingSide} skipped: spread ${liqGuard.spreadBps?.toFixed(1)} bps > max ${liqCfg.maxSpreadBps} bps`
            : liqGuard.reason === "order_exceeds_depth"
              ? `Supertrend futures ${openingSide} skipped: order ~${estOrderNotional.toFixed(0)} USDT > ${(liqCfg.maxOrderVsDepthFrac * 100).toFixed(0)}% of visible depth (~${liqGuard.depthNotionalUsd?.toFixed(0)} USDT)`
              : `Supertrend futures ${openingSide} skipped: depth ~${liqGuard.depthNotionalUsd?.toFixed(0)} USDT below min ${liqCfg.minDepthUsd} USDT`;
        wsHub?.broadcast?.("log", { level: "warn", msg: liqMsg, symbol: orderSymbol });
        emitActivity(wsHub, {
          level: "warn",
          msg: `Open skipped · ${orderSymbol} · ${liqGuard.reason}`,
          category: "execution",
          reason: liqGuard.reason,
          symbol: orderSymbol,
        });
        return { venue: "FUTURES", side, action: "skipped", reason: liqGuard.reason };
      }

      let entryMetaExtra = {};
      if (openStyle === "LIMIT_IOC") {
        if (slipFrac <= 0) {
          wsHub?.broadcast?.("log", {
            level: "warn",
            msg: "SUPERTREND_FUTURES_OPEN_STYLE=LIMIT_IOC requires SUPERTREND_FUTURES_MAX_ENTRY_SLIPPAGE_PCT > 0 — using MARKET",
            symbol: orderSymbol,
          });
          openStyle = "MARKET";
        } else if (Number.isFinite(slipSignalRef) && slipSignalRef > 0) {
          entryMetaExtra =
            openingSide === "BUY"
              ? { entryOrderStyle: "LIMIT_IOC", entryLimitPrice: slipSignalRef * (1 + slipFrac) }
              : { entryOrderStyle: "LIMIT_IOC", entryLimitPrice: slipSignalRef * (1 - slipFrac) };
        }
      }

      const mqAtEntryFutures = buildMqAtEntrySnapshot(openingSide, candles, indicators.latest, "FUTURES");

      const openMetaBase = {
        supertrend: true,
        aiProbability: gateProb,
        marketMode: "FUTURES",
        supertrendFuturesAiSized: true,
        supertrendFuturesTwoWay: twoWay,
        futuresLeverage: lev,
        leverage: lev,
        autoMultiUnpinned: Boolean(multiUnpinnedOrder),
        autoTradeTrailing: Boolean(state.trailingStopLossAuto),
        signalLagMs: Number.isFinite(signalLagMs) ? signalLagMs : undefined,
        entryBookBestBid: bookTicker?.bidPrice,
        entryBookBestAsk: bookTicker?.askPrice,
        entryBookMidPx: Number.isFinite(midPxEntry) ? midPxEntry : undefined,
        entryMarkPx: Number.isFinite(markPxEntry) ? markPxEntry : undefined,
        signalBarCloseForEntry:
          Number.isFinite(slipSignalRef) && slipSignalRef > 0 ? slipSignalRef : undefined,
        ...(mqAtEntryFutures ? { mqAtEntry: mqAtEntryFutures } : {}),
        skipStopLoss: state.supertrendFuturesUseFixedSl === false,
        skipTakeProfit: state.supertrendFuturesUseFixedTp === false,
        ...entryMetaExtra,
      };

      let order;
      let entryStyleUsed = openStyle;
      try {
        order = await placeOrderWithWalletTelemetry(futuresEx, () =>
          futuresEx.placeOrder({
            symbol: orderSymbol,
            side: openingSide,
            qty,
            price: last.close,
            stopLoss,
            takeProfit,
            strategy: strategyKey,
            meta: openMetaBase,
          }),
        );
      } catch (e) {
        const errMsg = String(e?.message || e);
        const iocFallback =
          state.supertrendFuturesIocFallbackMarket === true ||
          truthyEnv(process.env.SUPERTREND_FUTURES_IOC_FALLBACK_MARKET);
        if (openStyle === "LIMIT_IOC" && errMsg.includes("limit_ioc_no_fill") && iocFallback) {
          const again = await loadEntryMicrostructure();
          bookTicker = again.bookTicker;
          markPxEntry = again.markPx;
          midPxEntry = again.midPx;
          if (
            slipFrac > 0 &&
            !bookTicker &&
            !(Number.isFinite(markPxEntry) && markPxEntry > 0)
          ) {
            emitActivity(wsHub, {
              level: "warn",
              category: "signal",
              reason: "ioc_fallback_no_quote",
              symbol: orderSymbol,
              msg: `Supertrend futures ${openingSide}: IOC no fill — cannot verify slippage for MARKET fallback (book + mark unavailable)`,
              detail: { priorError: errMsg },
            });
            return { venue: "FUTURES", side, action: "skipped", reason: "ioc_fallback_quote_unavailable" };
          }
          const drift2 = entryDriftFails(bookTicker, markPxEntry, midPxEntry);
          if (drift2.fail) {
            emitActivity(wsHub, {
              level: "warn",
              category: "signal",
              reason: "ioc_no_fill_skip_market",
              symbol: orderSymbol,
              msg: `Supertrend futures ${openingSide}: LIMIT IOC did not fill and price moved beyond cap — skipped`,
              detail: { priorError: errMsg, driftMsg: drift2.msg },
            });
            return { venue: "FUTURES", side, action: "skipped", reason: "ioc_no_fill_price_moved" };
          }
          entryStyleUsed = "MARKET";
          order = await placeOrderWithWalletTelemetry(futuresEx, () =>
            futuresEx.placeOrder({
              symbol: orderSymbol,
              side: openingSide,
              qty,
              price: last.close,
              stopLoss,
              takeProfit,
              strategy: strategyKey,
              meta: {
                ...openMetaBase,
                entryOrderStyle: "MARKET",
                entryLimitPrice: undefined,
                entryIocFallback: true,
                priorIocNoFillError: errMsg,
              },
            }),
          );
        } else throw e;
      }
      const entryExOid = binanceFuturesEntryOrderIdFromPlaceOrder(order);
      const tpSlNote = !aiFilterOn ? "fixed SL/TP (no AI filter)" : "ATR+regime+AI";
      wsHub?.broadcast?.("log", {
        level: "info",
        msg: `Supertrend futures ${openingSide} AI=${gateProb.toFixed(3)} lev=${lev}x qty=${qty} ${tpSlNote}`,
        symbol: orderSymbol,
        qty,
        leverage: lev,
        strategyKey,
      });
      const signalBarClose = Number(last.close);
      const fillPx = Number(order.filledPrice);
      if (Number.isFinite(signalBarClose) && signalBarClose > 0 && Number.isFinite(fillPx) && fillPx > 0) {
        const adverseBps =
          openingSide === "BUY"
            ? ((fillPx - signalBarClose) / signalBarClose) * 10000
            : ((signalBarClose - fillPx) / signalBarClose) * 10000;
        emitActivity(wsHub, {
          level: "info",
          category: "trading",
          reason: "futures_entry_fill_vs_signal",
          symbol: orderSymbol,
          msg: `${orderSymbol} · entry vs signal bar close · ${signalBarClose.toFixed(6)} → fill ${fillPx.toFixed(6)} · ${adverseBps >= 0 ? "+" : ""}${adverseBps.toFixed(1)} bps adverse · ${entryStyleUsed}`,
          detail: {
            signalBarClose,
            fillPx,
            adverseBps,
            entryStyle: entryStyleUsed,
            slipPctConfigured: slipPctRaw,
          },
        });
      }
      broadcastTrade(wsHub, {
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
        meta: {
          supertrend: true,
          ...(entryExOid ? { orderId: entryExOid } : {}),
          leverage: order.leverage ?? lev,
          venue: "FUTURES",
          stopLoss,
          takeProfit,
          /** Candle open time (ms) for the Supertrend signal bar used to place this order. */
          signalBarTs: Number.isFinite(Number(last?.ts)) ? Number(last.ts) : undefined,
          /** Candle close time (ms) ≈ when bar-close fires + order window; aligns UI with fill time on 1m+TF. */
          signalBarCloseTs:
            Number.isFinite(Number(last?.ts)) && String(state.timeframe || "").trim()
              ? Number(last.ts) + binanceIntervalMs(state.timeframe)
              : undefined,
          /** Closed-bar close used for sizing / SL-TP anchor (matches chart signal list “@” when WS is aligned). */
          signalBarClose: Number.isFinite(signalBarClose) && signalBarClose > 0 ? signalBarClose : undefined,
          avgFillPrice: Number.isFinite(fillPx) && fillPx > 0 ? fillPx : undefined,
          signalLagMs: Number.isFinite(signalLagMs) ? signalLagMs : undefined,
          entryBookBestBid: bookTicker?.bidPrice,
          entryBookBestAsk: bookTicker?.askPrice,
          entryBookMidPx: Number.isFinite(midPxEntry) ? midPxEntry : undefined,
          entryMarkPx: Number.isFinite(markPxEntry) ? markPxEntry : undefined,
          entryOrderStyle: entryStyleUsed,
          entryLimitPrice:
            entryStyleUsed === "LIMIT_IOC" && Number.isFinite(entryMetaExtra.entryLimitPrice)
              ? entryMetaExtra.entryLimitPrice
              : undefined,
          entryIocFallback: openStyle === "LIMIT_IOC" && entryStyleUsed === "MARKET",
          ...(mqAtEntryFutures ? { mqAtEntry: mqAtEntryFutures } : {}),
        },
        source: "SUPERTREND",
      });
      persistOpenTradeDbRow({
        dbSignalId,
        symbol: orderSymbol,
        venue: "FUTURES",
        direction: openingSide === "BUY" ? "LONG" : "SHORT",
        order,
        qty,
        stopLoss,
        takeProfit,
        leverage: order.leverage ?? lev,
      });
      if (order.immediateCloseTrade && typeof order.immediateCloseTrade === "object") {
        broadcastTrade(wsHub, {
          ...order.immediateCloseTrade,
          strategyKey,
          strategy: strategyKey,
          source: "SUPERTREND",
        });
        emitActivity(wsHub, {
          level: "warn",
          category: "risk",
          reason: "immediate_flat_after_open",
          symbol: orderSymbol,
          msg: `${orderSymbol} · futures leg went flat within ~${postOpenStableProbeMs()}ms of open (SL/TP/mark noise) — paired CLOSE emitted; you may still see exchange commission with ~0 realized PnL on tiny moves.`,
        });
      }
      const slN = Number(stopLoss);
      const tpN = Number(takeProfit);
      emitActivity(wsHub, {
        level: "info",
        msg: `SL/TP armed · ${orderSymbol} · SL ${Number.isFinite(slN) ? slN.toFixed(4) : "—"} · TP ${Number.isFinite(tpN) ? tpN.toFixed(4) : "—"} · Supertrend futures`,
        category: "risk",
        reason: "sl_tp_armed",
        symbol: orderSymbol,
        detail: {
          stopLoss,
          takeProfit,
          leverage: order.leverage ?? lev,
          trailingAuto: Boolean(state.trailingStopLossAuto),
          signalBarClose: Number.isFinite(signalBarClose) && signalBarClose > 0 ? signalBarClose : null,
          avgFillPrice: Number.isFinite(fillPx) && fillPx > 0 ? fillPx : null,
        },
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
        stopLoss,
        takeProfit,
        tradeSymbol: orderSymbol,
        signalBarClose: Number.isFinite(signalBarClose) && signalBarClose > 0 ? signalBarClose : undefined,
        filledPrice: Number.isFinite(fillPx) && fillPx > 0 ? fillPx : undefined,
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
        const aiResp = await withTimeout(
          ai.predict({
            symbol: state.symbol,
            timeframe: state.timeframe,
            candles: rawCandles,
          }),
          AI_PREDICT_TIMEOUT_MS,
        );
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
        const errMsg = formatAiServiceError(e);
        if (String(errMsg).includes("timeout") && AI_TIMEOUT_IS_HARD_FAIL) {
          // Hard-fail mode: leave gates null; caller may skip or fall back depending on config.
          log.warn("supertrend_bar_close_ai_predict_timeout", { symbol: state.symbol, timeoutMs: AI_PREDICT_TIMEOUT_MS });
        } else {
        log.warn("supertrend_bar_close_ai_predict_failed", {
          symbol: state.symbol,
          error: errMsg,
        });
        }
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
    if (!sym || rawCandles.length < aiMinCandles) {
      return { aiGateBuy: null, aiGateSell: null };
    }

    // Cache AI gates per symbol + bar-close ts so AUTO multi does not stall order placement when /predict is slow.
    // `rawCandles` in the multi path are closed-bar arrays; the tail open time is the bar we are acting on.
    const cTs = rawCandles.length ? Number(rawCandles[rawCandles.length - 1]?.ts) : NaN;
    if (!state._stAiGateCache || typeof state._stAiGateCache !== "object") state._stAiGateCache = Object.create(null);
    const cacheRow = state._stAiGateCache[sym];

    const cachedForThisBar =
      cacheRow && Number.isFinite(cTs) && Number(cacheRow.cTs) === cTs
        ? { aiGateBuy: cacheRow.aiGateBuy, aiGateSell: cacheRow.aiGateSell }
        : null;
    const cachedLast =
      cacheRow && (cacheRow.aiGateBuy != null || cacheRow.aiGateSell != null)
        ? { aiGateBuy: cacheRow.aiGateBuy, aiGateSell: cacheRow.aiGateSell }
        : { aiGateBuy: null, aiGateSell: null };

    if (cachedForThisBar) return cachedForThisBar;

    let aiGateBuy = cachedLast.aiGateBuy;
    let aiGateSell = cachedLast.aiGateSell;

    const startedAt = Date.now();
    const p = (async () => {
      const aiResp = await withTimeout(
        ai.predict({
          symbol: sym,
          timeframe: state.timeframe,
          candles: rawCandles,
        }),
        AI_PREDICT_TIMEOUT_MS,
      );
      const calProb = Number(aiResp?.probability ?? 0);
      const rawProb = Number(aiResp?.raw_probability ?? aiResp?.rawProbability ?? NaN);
      const outBuy = aiGateProbability(calProb, rawProb);
      const shortProb = Number(aiResp?.short_probability ?? aiResp?.shortProbability ?? NaN);
      const shortRaw = Number(aiResp?.short_raw_probability ?? aiResp?.shortRawProbability ?? NaN);
      const outSell = Number.isFinite(shortProb) && shortProb > 0 ? aiGateProbability(shortProb, shortRaw) : null;
      return { aiGateBuy: Number.isFinite(outBuy) ? outBuy : null, aiGateSell: Number.isFinite(outSell) ? outSell : null };
    })()
      .then((g) => {
        try {
          state._stAiGateCache[sym] = {
            cTs: Number.isFinite(cTs) ? cTs : null,
            aiGateBuy: g.aiGateBuy ?? null,
            aiGateSell: g.aiGateSell ?? null,
            computedAt: Date.now(),
            ms: Date.now() - startedAt,
          };
        } catch {
          /* ignore */
        }
        return g;
      })
      .catch((e) => {
        const errMsg = formatAiServiceError(e);
        if (String(errMsg).includes("timeout") && AI_TIMEOUT_IS_HARD_FAIL) {
          log.warn("supertrend_auto_multi_ai_gates_timeout", { symbol: sym, timeoutMs: AI_PREDICT_TIMEOUT_MS });
        } else {
          log.warn("supertrend_auto_multi_ai_gates_failed", { symbol: sym, error: errMsg });
        }
        return null;
      });

    const budget = SUPERTREND_BAR_CLOSE_AI_BUDGET_MS;
    if (budget > 0) {
      const got = await withTimeout(p, budget).catch(() => null);
      if (got && typeof got === "object") {
        aiGateBuy = got.aiGateBuy ?? aiGateBuy;
        aiGateSell = got.aiGateSell ?? aiGateSell;
      }
    }

    return { aiGateBuy, aiGateSell };
  }

  /** SurfPulse ML win probability for chart signal list (same 8 features as /predict/surfpulse). */
  async function fetchSurfPulseScoreForHistory(rawCandles) {
    try {
      const feat = extractSurfPulseFeatures(rawCandles);
      if (!feat) return null;
      const resp = await ai.predictSurfPulse({ features: feat });
      const p = Number(resp?.probability);
      return Number.isFinite(p) ? p : null;
    } catch {
      return null;
    }
  }

  /** Full market-decision snapshot at bar close (JSON-safe clone for signal history + jsonl). */
  function snapMarketDecisionForHistory({ candles, cTs, row, decisionSnapshotBar, symbol, timeframe }) {
    try {
      const mdCfg = mergeMarketDecisionConfig(state.marketDecision);
      const cfg = augmentMarketDecisionConfigForFeeGate(mdCfg);
      const s = computeMarketDecisionSnapshot({
        candles,
        cTs,
        row: {
          buySignal: Boolean(row?.buySignal),
          sellSignal: Boolean(row?.sellSignal),
          trend: row?.trend,
        },
        decisionSnapshotBar,
        symbol: String(symbol || "").toUpperCase(),
        timeframe: String(timeframe || ""),
        config: cfg,
        regimeBtc: null,
        regimeHtf: null,
      });
      return s ? JSON.parse(JSON.stringify(s)) : null;
    } catch {
      return null;
    }
  }

  /** Persist flip to jsonl; merge into in-memory history + WS for every symbol (multi-coin AUTO). */
  function mergeSupertrendSignalHistoryFromAutoMulti(entry, wsHub) {
    appendSupertrendSignalHistoryEntry(entry, cfgPersistenceSlug);
    const symE = String(entry.symbol || "").toUpperCase();
    const tfE = String(entry.timeframe || "");
    if (!symE || tfE !== String(state.timeframe)) {
      scheduleSmartSsRefresh(8000);
      return;
    }
    const prev = Array.isArray(state.supertrendSignalHistory) ? state.supertrendSignalHistory : [];
    const filt = prev.filter(
      (e) =>
        !(
          Number(e?.ts) === entry.ts &&
          e?.side === entry.side &&
          String(e?.symbol || symE).toUpperCase() === symE &&
          String(e?.timeframe || "") === tfE
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
      surfPulse: entry.surfPulse != null && Number.isFinite(Number(entry.surfPulse)) ? Number(entry.surfPulse) : null,
      ...(entry.mqScore != null && Number.isFinite(Number(entry.mqScore)) ? { mqScore: Number(entry.mqScore) } : {}),
      ...(entry.mqVerdict != null && String(entry.mqVerdict).trim() ? { mqVerdict: String(entry.mqVerdict).trim() } : {}),
      ...(entry.signalBarClose != null &&
      Number.isFinite(Number(entry.signalBarClose)) &&
      Number(entry.signalBarClose) > 0
        ? { signalBarClose: Number(entry.signalBarClose) }
        : {}),
      ...(entry.signalBarCloseTs != null &&
      Number.isFinite(Number(entry.signalBarCloseTs)) &&
      Number(entry.signalBarCloseTs) > 0
        ? { signalBarCloseTs: Number(entry.signalBarCloseTs) }
        : {}),
      ...(entry.marketDecisionSnapshot != null && typeof entry.marketDecisionSnapshot === "object"
        ? { marketDecisionSnapshot: entry.marketDecisionSnapshot }
        : {}),
    });
    filt.sort((a, b) => Number(a.ts) - Number(b.ts));
    state.supertrendSignalHistory = filt.slice(-SUPERTREND_SIGNAL_STATE_MAX);
    persistTradingConfigToDisk();
    const candlesHm = feed.getCandles();
    const lastHm = candlesHm.length ? candlesHm[candlesHm.length - 1] : null;
    const pfHm = portfolioMtmForWs(lastHm, candlesHm, _cachedPositions, _cachedAccount, null);
    wsHub?.broadcast?.("state", {
      mode: runtimeTradingMode(),
      ...getPublicState(),
      account: pfHm.account,
      positions: pfHm.positionsMtM,
    });
    scheduleSmartSsRefresh(8000);
  }

  function autoMultiUnpinnedEnvOn() {
    const v = String(process.env.AUTO_MULTI_UNPINNED_SUPERTREND ?? "0").toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }

  function supertrendVenueActive(mmUp) {
    return supertrendAutotradeActive(state, mmUp);
  }

  /** Supertrend autotrade toggles, or MANUAL bar-close adapter path (Elite / Safe Intraday). */
  function resolveTradingVenue(mmUp) {
    return resolveTradingVenueForBarClose(state, mmUp);
  }

  function manualStrategyMultiBarCloseActive(mmUp) {
    if (!manualStrategyBarCloseActive(state, mmUp)) return false;
    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() !== "MULTIPLE") return false;
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    if (!marketFeedUsesLiveBinance()) return false;
    return true;
  }

  function barCloseStrategyKey() {
    return barCloseSignalStrategyKey(state);
  }

  /** Intelligence gate veto/sizing on opens — skipped on MANUAL adapter path unless explicitly enabled. */
  function intelligenceGateAppliesForOpen() {
    if (!state.intelligenceGateEnabled) return false;
    if (manualStrategyUsesLiveBarClose(state) && manualStrategyKey(state) !== "SUPERTREND") {
      return state.intelligenceGateManualStrategies === true;
    }
    return true;
  }

  /** AUTO coin select, no table pin, env on, live Binance feed, bot running, Supertrend autotrade for active venue. */
  function autoMultiUnpinnedActive(mmUp) {
    if (!autoMultiUnpinnedEnvOn()) return false;
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    if (universeManualPinningOn()) {
      if (state.universePinnedSymbol) return false;
      if (Array.isArray(state.universePinnedSymbols) && state.universePinnedSymbols.length > 0) return false;
    }
    if (!state.running) return false;
    if (!marketFeedUsesLiveBinance()) return false;
    return supertrendVenueActive(mmUp);
  }

  /**
   * Multi-coin + ST_SIGNAL_FIRST: run Supertrend sweep over ranked (or pinned) symbols without AUTO_MULTI_UNPINNED_SUPERTREND env.
   */
  function stSignalFirstMultiSweepActive(mmUp) {
    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() !== "MULTIPLE") return false;
    if (String(state.universeAutoCoinPick || "").toUpperCase() !== "ST_SIGNAL_FIRST") return false;
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    if (!state.running) return false;
    if (!marketFeedUsesLiveBinance()) return false;
    if (universeManualPinningOn() && (!Array.isArray(state.universePinnedSymbols) || state.universePinnedSymbols.length === 0)) {
      return false;
    }
    return supertrendVenueActive(mmUp);
  }

  /**
   * MULTIPLE + symbolMode AUTO + live Binance + Supertrend venue: multiplex klines and per-symbol UI snapshots.
   * Broader than auto-trade sweep (`AUTO_MULTI_UNPINNED_SUPERTREND` / `ST_SIGNAL_FIRST`) so signal tabs stay live.
   */
  function multiCoinKlineMuxEnabled(mmUp) {
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() !== "MULTIPLE") return false;
    if (!marketFeedUsesLiveBinance()) return false;
    return barCloseWatchConfigured(state, mmUp);
  }

  /**
   * Combined stream + bar-close gate: multi-coin Supertrend tabs/trades, or legacy AUTO_MULTI_UNPINNED (can be non-MULTIPLE),
   * or ST_SIGNAL_FIRST sweep. Keeps single-coin unpinned path on multiplex when `MULTIPLE` is off.
   */
  function parallelSupertrendWatchGate(mmUp) {
    return (
      multiCoinKlineMuxEnabled(mmUp) ||
      autoMultiUnpinnedActive(mmUp) ||
      stSignalFirstMultiSweepActive(mmUp) ||
      manualStrategyMultiBarCloseActive(mmUp)
    );
  }

  /** Config-only (no running/feed check): load/merge signal history for every watched symbol, not only `state.symbol`. */
  function configIndicatesMultiCoinSupertrendSweeps() {
    if (String(state.symbolMode || "").toUpperCase() !== "AUTO") return false;
    const mmUp = String(state.marketMode || "SPOT");
    if (autoMultiUnpinnedEnvOn()) {
      if (universeManualPinningOn()) {
        if (state.universePinnedSymbol) return false;
        if (Array.isArray(state.universePinnedSymbols) && state.universePinnedSymbols.length > 0) return false;
      }
      return supertrendVenueActive(mmUp);
    }
    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() !== "MULTIPLE") return false;
    if (String(state.universeAutoCoinPick || "").toUpperCase() !== "ST_SIGNAL_FIRST") return false;
    if (universeManualPinningOn() && (!Array.isArray(state.universePinnedSymbols) || state.universePinnedSymbols.length === 0)) {
      return false;
    }
    return supertrendVenueActive(mmUp);
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
   * Strategy bar-close + decision snapshot + SS on a specific closed bar (same pipeline as `processBarCloseTrading`).
   * @param {unknown[]} closedRaw — OHLC buffer: for WS bar-close use **full** per-symbol buffer (like `feed.getCandles()`); for REST sweep use closed bars only.
   * @param {string} [evalSymbol]
   * @param {number} [candleTsOpt] — When set (e.g. `candle.ts` from `onCandleClose`), evaluate **that** bar; matches main chart idx lookup. Omit for REST “last closed only” sweeps.
   * @returns {null | { cTs: number, allowBuy: boolean, allowSell: boolean, row: object, decisionSnapshotBar: object, supertrendStrength01: number | null, closedRaw: array }}
   */
  function evaluateRawSupertrendBarClose(closedRaw, evalSymbol, candleTsOpt) {
    const raw = Array.isArray(closedRaw) ? closedRaw : [];
    if (raw.length < Math.max(30, state.supertrendPeriod + 2)) return null;

    const symForEval =
      evalSymbol != null && String(evalSymbol).trim()
        ? String(evalSymbol).trim().toUpperCase()
        : String(state.symbol || "").toUpperCase();

    const strictChartAlign = String(process.env.SUPERTREND_STRICT_CHART_ALIGN ?? "true").toLowerCase() !== "false";
    const clean = sanitizeCandlesForSt(raw, symForEval);
    const cTs =
      Number.isFinite(Number(candleTsOpt)) && Number(candleTsOpt) > 0
        ? Number(candleTsOpt)
        : Number(raw[raw.length - 1]?.ts);
    if (!Number.isFinite(cTs)) return null;
    const idxC = clean.findIndex((c) => Number(c.ts) === cTs);
    if (idxC < 0) return null;
    const opts = {
      period: state.supertrendPeriod,
      multiplier: state.supertrendMultiplier,
      wilderAtr: state.supertrendWilderAtr,
    };
    const series = computeSupertrendSeries(clean, opts);
    const row = series[idxC] ?? null;

    const chartVisible =
      row?.ready
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

    const strengthBar = clean[idxC] ?? null;
    const supertrendStrength01 =
      row?.ready && strengthBar
        ? computeSupertrendSignalStrength01({
            row,
            candle: strengthBar,
            multiplier: state.supertrendMultiplier,
          })
        : null;

    if (!row?.ready || Number(row.ts) !== cTs) {
      return null;
    }

    const indicatorsBarClose = computeIndicators(raw);
    const decisionSnapshotBar = computeDecisionSnapshot({
      candles: raw,
      indicatorsLatest: indicatorsBarClose.latest,
      supertrendLastRow: row,
      symbol: symForEval,
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
      strategyKey: "SUPERTREND",
      closedRaw: raw.map((c) => (c && typeof c === "object" ? { ...c } : c)),
    };
  }

  async function evaluateSupertrendLastClosedBar(closedRaw, evalSymbol, candleTsOpt) {
    if (manualStrategyUsesLiveBarClose(state)) {
      const strictChartAlign =
        String(process.env.SUPERTREND_STRICT_CHART_ALIGN ?? "true").toLowerCase() !== "false";
      return evaluateLiveStrategyBarClose({
        state,
        closedRaw,
        evalSymbol,
        candleTsOpt,
        chartMarkerVisibleForBar,
        computeIndicators,
        computeDecisionSnapshot,
        computeSupertrendSignalStrength01,
        timeframe: state.timeframe,
        strictChartAlign,
        evaluateRawSupertrendBarClose,
      });
    }

    return evaluateRawSupertrendBarClose(closedRaw, evalSymbol, candleTsOpt);
  }

  /**
   * Walk `candidates` in order; first symbol with Supertrend BUY on last closed bar wins (single-coin auto rotation).
   * If current `state.symbol` already has an open position and is in the list, keep it.
   */
  async function pickFirstStSignalSymbol(candidates, openSyms) {
    const list = Array.isArray(candidates) ? candidates.map((s) => String(s).toUpperCase()).filter(Boolean) : [];
    if (!list.length) return null;
    const cur = String(state.symbol || "").toUpperCase();
    if (openSyms.has(cur) && list.includes(cur)) return cur;
    const klineLimit = Math.max(120, Math.min(500, Number(process.env.UNIVERSE_ST_KLINES_LIMIT ?? 450)));
    for (const sym of list) {
      const symU = String(sym).toUpperCase();
      if (openSyms.has(symU)) continue;
      let rows;
      try {
        rows = await fetchBinanceKlinesRows({
          symbol: symU,
          interval: state.timeframe,
          limit: klineLimit,
          feedKind: effectiveMarketFeedKind(),
        });
      } catch {
        continue;
      }
      const closedRaw = rows.length >= 2 ? rows.slice(0, -1) : rows;
      const ev = await evaluateSupertrendLastClosedBar(closedRaw, symU);
      if (!ev || !ev.allowBuy) continue;
      if (
        isFixedUsdtCapitalMode() &&
        String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE" &&
        String(state.marketMode || "AUTO").toUpperCase() !== "SPOT"
      ) {
        const mm = String(state.marketMode || "AUTO").toUpperCase();
        const futPath = mm === "FUTURES" || (mm === "AUTO" && state.supertrendFuturesAuto);
        if (futPath) {
          let pos = _cachedPositions || [];
          try {
            pos = await exch.getPositions();
            _cachedPositions = pos;
          } catch {
            /* use cache */
          }
          const rp = resolveFixedUsdtRiskForOrder(symU, pos);
          const levPick =
            String(state.futuresLeverageMode || "").toUpperCase() === "MANUAL"
              ? clamp(Number(state.futuresLeverage), 1, 100)
              : decideFuturesLeverage({
                  prob: 0.75,
                  atrPct: state.lastRegime?.atrPct,
                  regime: state.lastRegime?.type || "RANGE",
                });
          const splitDiv = Math.max(1, Math.floor(Number(rp.fixedUsdtSplitDivisor) || 1));
          const est = (Number(rp.riskPerTrade) / splitDiv) * levPick;
          try {
            const minN = await getFuturesMinNotionalCached(symU);
            if (Number.isFinite(minN) && minN > 0 && est + 1e-9 < minN) {
              continue;
            }
          } catch {
            /* allow pick if lookup fails */
          }
        }
      }
      return symU;
    }
    return null;
  }

  /**
   * Shared AUTO-multi Supertrend execution (REST sweep + kline WS bar-close).
   * @param {object} ev — return value of `evaluateSupertrendLastClosedBar`
   */
  async function processAutoMultiFromEval(symU, hubLocal, ev, ctx) {
    const {
      stSpot,
      stFut,
      venueSpot,
      maxOpen,
      openSyms,
      refreshOpenSymsAfterTrade,
    } = ctx;
    const { cTs, allowBuy, allowSell, allowExit, decisionSnapshotBar, supertrendStrength01, closedRaw: cr, row, barSignal } = ev;
    if (Number(state.autoMultiLastSeenBarTs[symU]) === cTs) return;

    const strategyKey = manualStrategyUsesLiveBarClose(state)
      ? manualStrategyKey(state)
      : "SUPERTREND";

    if (allowExit) {
      state.autoMultiLastSeenBarTs[symU] = cTs;
      if (stFut) {
        const positions = _cachedPositions || [];
        const legs = positions.filter(
          (p) => String(p?.symbol || "").toUpperCase() === symU && Number(p?.qty) > 0,
        );
        if (legs.length) {
          await closeFuturesLegsForSupertrend(legs, `${strategyKey}_EXIT`);
          await pushImmediateState(hubLocal);
        }
      }
      return;
    }

    if (!allowBuy && !allowSell) {
      state.autoMultiLastSeenBarTs[symU] = cTs;
      return;
    }
    // Claim this bar before any await so concurrent WS + sweep cannot duplicate history / signals.
    state.autoMultiLastSeenBarTs[symU] = cTs;

    /** One `/predict` per symbol per bar — reused for sizing + history so orders are not queued behind SurfPulse + disk. */
    const gatesSweep = await resolveSupertrendBarCloseAiGatesNoLastAi(cr, symU);

    try {
      state._intelligenceSizeMultiplier = 1;
      if (intelligenceGateAppliesForOpen() && allowBuy) {
        const ig = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symU,
          openingLong: true,
          broadcastLog: (p) =>
            hubLocal?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
          logInfo: (eventName, meta) => log?.info?.(eventName, meta),
        });
        if (ig.veto) return gatesSweep;
        state._intelligenceSizeMultiplier = ig.sizeMultiplier;
      }
    if (allowSell && allowBuy) {
      hubLocal?.broadcast?.("log", {
        level: "warn",
        msg: "AUTO multi: both BUY and SELL on same closed bar — executing SELL before BUY",
        symbol: symU,
      });
    }

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
          anchorBarTs: cTs,
        });
        emitSupertrendSignalFeedback(hubLocal, {
          ...sellRes,
          signalStrength: supertrendStrength01 ?? undefined,
          tradeSymbol: symU,
        });
        if (sellRes?.action === "placed") {
          await pushImmediateState(hubLocal);
          await refreshOpenSymsAfterTrade();
        }
      }
    }
    if (allowSell && stFut && state.supertrendFuturesTwoWay === true && intelligenceGateAppliesForOpen()) {
      try {
        state._intelligenceSizeMultiplier = 1;
        const igShort = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symU,
          openingLong: false,
          broadcastLog: (p) =>
            hubLocal?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
          logInfo: (eventName, meta) => log?.info?.(eventName, meta),
        });
        if (igShort.veto) return gatesSweep;
        state._intelligenceSizeMultiplier = igShort.sizeMultiplier;
      } catch {
        /* never block a trade on intelligence error */
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
        anchorBarTs: cTs,
        barCloseAiGates: gatesSweep,
        adapterSignal: barSignal ?? null,
      });
      emitSupertrendSignalFeedback(hubLocal, {
        ...sellRes,
        signalStrength: supertrendStrength01 ?? undefined,
        tradeSymbol: symU,
      });
      if (sellRes?.action === "placed") {
        await pushImmediateState(hubLocal);
        await refreshOpenSymsAfterTrade();
      }
    }

    let acct = ctx.acct;
    let spendQuote = 0;
    const multiPoolBudgetSizing =
      String(state.riskPerTradeUnit || "").toUpperCase() === "USDT" &&
      String(state.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
    if (allowBuy && stSpot) {
      try {
        acct = await exch.getAccount();
      } catch {
        /* ignore */
      }
      if (!multiPoolBudgetSizing) {
        const freeNow = Number(acct?.freeBalance ?? acct?.equity ?? 0);
        spendQuote =
          Number.isFinite(freeNow) && freeNow > 0
            ? autoMultiQuoteSpendForSlot(freeNow, openSyms.size)
            : 0;
      }
    }

    if (allowBuy && stSpot) {
      if (openSyms.has(symU)) {
        return gatesSweep;
      }
      if (openSyms.size >= maxOpen) {
        return gatesSweep;
      }
      if (!(multiPoolBudgetSizing || (Number.isFinite(spendQuote) && spendQuote > 0))) {
        return gatesSweep;
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
        fixedQuoteSpendUsdt: multiPoolBudgetSizing ? null : spendQuote,
        multiUnpinnedOrder: true,
        anchorBarTs: cTs,
      });
      emitSupertrendSignalFeedback(hubLocal, {
        ...buyRes,
        signalStrength: supertrendStrength01 ?? undefined,
        tradeSymbol: symU,
      });
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
      let positions = _cachedPositions || [];
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
        return gatesSweep;
      }
      if (shortHereSweep.length > 0 && state.supertrendFuturesTwoWay !== true) {
        return gatesSweep;
      }
      if (openSyms.size >= maxOpen && !openSyms.has(symU)) {
        return gatesSweep;
      }
      try {
        acct = await exch.getAccount();
      } catch {
        /* ignore */
      }
      const freeFut = Number(acct?.freeBalance ?? acct?.equity ?? 0);
      const maxNotionalUsd =
        multiPoolBudgetSizing
          ? null
          : Number.isFinite(freeFut) && freeFut > 0
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
        anchorBarTs: cTs,
        barCloseAiGates: gatesSweep,
        adapterSignal: barSignal ?? null,
      });
      emitSupertrendSignalFeedback(hubLocal, {
        ...buyRes,
        signalStrength: supertrendStrength01 ?? undefined,
        tradeSymbol: symU,
      });
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
    } finally {
      const { aiGateBuy: aiGbSweep, aiGateSell: aiGsSweep } = gatesSweep;
      let surfPulseSweep = null;
      try {
        surfPulseSweep = await fetchSurfPulseScoreForHistory(cr);
      } catch {
        /* ignore */
      }
      let moveQualityMulti = null;
      try {
        const sideMq = allowBuy ? "BUY" : "SELL";
        const vEnMq = stFut ? "FUTURES" : "SPOT";
        const indMq = computeIndicators(cr);
        const slMq = estimateSlDistancePctForMoveQualityGate(state, indMq.latest, vEnMq);
        moveQualityMulti = evaluateSupertrendMoveQuality({
          candles: cr,
          latest: indMq.latest,
          openingSide: sideMq,
          slDistancePct: slMq,
          options: supertrendMoveQualityEvalOptions(),
        });
      } catch (e) {
        log?.warn?.("supertrend_move_quality_auto_multi_history_failed", {
          symbol: symU,
          error: String(e?.message || e),
        });
      }
      const histSide = allowBuy ? "BUY" : "SELL";
      const ssHist = decisionSnapshotBar.signalStrength;
      const barAtFlip = Array.isArray(cr) ? cr.find((b) => Number(b?.ts) === Number(cTs)) : null;
      const signalBarCloseMulti =
        barAtFlip != null && Number.isFinite(Number(barAtFlip.close)) && Number(barAtFlip.close) > 0
          ? Number(barAtFlip.close)
          : null;
      const mdMulti = snapMarketDecisionForHistory({
        candles: cr,
        cTs: Number(cTs),
        row,
        decisionSnapshotBar,
        symbol: symU,
        timeframe: state.timeframe,
      });
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
          surfPulse: surfPulseSweep,
          ...(moveQualityMulti != null && Number.isFinite(Number(moveQualityMulti.score))
            ? {
                mqScore: Number(moveQualityMulti.score),
                mqVerdict: moveQualityMulti.verdict != null ? String(moveQualityMulti.verdict) : null,
              }
            : {}),
          ...(signalBarCloseMulti != null ? { signalBarClose: signalBarCloseMulti } : {}),
          signalBarCloseTs:
            Number.isFinite(Number(cTs)) && String(state.timeframe || "").trim()
              ? Number(cTs) + binanceIntervalMs(state.timeframe)
              : undefined,
          ...(mdMulti ? { marketDecisionSnapshot: mdMulti } : {}),
        },
        hubLocal,
      );
    }
    return gatesSweep;
  }

  let autoMultiSweepInFlight = false;

  async function runAutoMultiUnpinnedSweep(hub) {
    if (!hub || autoMultiSweepInFlight) return;
    const mm = String(state.marketMode).toUpperCase();
    if (!autoMultiUnpinnedActive(mm) && !stSignalFirstMultiSweepActive(mm)) return;
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

      const candidates = computeAutoMultiWatchSymbolList();
      if (!candidates.length) return;

      let positions = _cachedPositions || [];
      try {
        positions = await exch.getPositions();
        _cachedPositions = positions;
      } catch {
        /* use cache */
      }
      const openSyms = distinctOpenSymbolsForVenue(positions, venueSpot);
      let maxOpen = autoMultiMaxOpenPositions();
      if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() === "MULTIPLE") {
        maxOpen = Math.min(10, maxOpen);
      }

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

      const minSweepBars = Math.max(30, state.supertrendPeriod + 2);
      for (const sym of candidates) {
        if (!state.running) break;
        const symU = String(sym).toUpperCase();
        let closedRaw;
        const bufSweep = typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(symU) : [];
        if (Array.isArray(bufSweep) && bufSweep.length >= minSweepBars) {
          closedRaw = bufSweep.length >= 2 ? bufSweep.slice(0, -1) : bufSweep;
        } else {
          let rows;
          try {
            rows = await fetchBinanceKlinesRows({
              symbol: symU,
              interval: state.timeframe,
              limit: klineLimit,
              feedKind: effectiveMarketFeedKind(),
            });
          } catch (e) {
            log.warn("auto_multi_klines_failed", { symbol: symU, error: String(e?.message || e) });
            continue;
          }
          closedRaw = rows.length >= 2 ? rows.slice(0, -1) : rows;
        }
        const ev = await evaluateSupertrendLastClosedBar(closedRaw, symU);
        if (!ev) continue;
        const gatesOut = await processAutoMultiFromEval(symU, hub, ev, {
          stSpot,
          stFut,
          venueSpot,
          maxOpen,
          openSyms,
          refreshOpenSymsAfterTrade,
          acct,
        });
        await persistMultiSymbolSnapshot(symU, ev, "sweep", gatesOut);
      }
    } finally {
      autoMultiSweepInFlight = false;
    }
  }

  async function processBarCloseTrading(candle) {
    if (!marketFeedUsesLiveBinance()) return;
    if (String(candle.symbol || "").toUpperCase() !== String(state.symbol).toUpperCase()) return;

    const mm = String(state.marketMode).toUpperCase();
    // Parallel bar-close path (`maybeAutoMultiBarClose`) already handles primary + watch symbols; do not
    // also record signals / autotrade here or the same bar is duplicated in history + jsonl.
    if (parallelSupertrendWatchGate(mm)) {
      return;
    }
    state._intelligenceSizeMultiplier = 1;
    const barCloseTradesEnabled = barCloseTradingConfigured(state, mm);
    const { stSpot, stFut } = resolveTradingVenue(mm);
    const strategyKeyBar = barCloseStrategyKey();

    const rawCandles = feed.getCandles();
    const cTs = Number(candle.ts);
    if (!Number.isFinite(cTs)) return;

    const strictChartAlign = String(process.env.SUPERTREND_STRICT_CHART_ALIGN ?? "true").toLowerCase() !== "false";

    const evBar = await evaluateSupertrendLastClosedBar(rawCandles, state.symbol, cTs);
    if (!evBar) return;

    const clean = sanitizeCandlesForSt(rawCandles, state.symbol);
    const idxC = clean.findIndex((c) => Number(c.ts) === cTs);
    const row = evBar.row;
    const allowBuy = evBar.allowBuy;
    const allowSell = evBar.allowSell;
    const allowExit = evBar.allowExit === true;
    const adapterBarSignal = evBar.barSignal ?? null;
    const strengthBar = idxC >= 0 ? clean[idxC] : null;
    const supertrendStrength01 = evBar.supertrendStrength01;

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
          strategyKey: barCloseStrategyKey(),
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
      if ((allowBuy || allowSell || allowExit) && wsHubRef) {
        const sideLabel = allowExit ? "EXIT" : allowBuy ? "BUY" : "SELL";
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: barCloseStrategyKey(),
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

    /** AUTO + ST autotrade off: chart markers only — skip AI gates, history trade semantics, and orders. */
    if (!barCloseTradesEnabled) {
      state.supertrendLastBarClose = {
        ts: Number(row.ts),
        buySignal: allowBuy === true,
        sellSignal: allowSell === true,
        exitSignal: allowExit === true,
        trend: row.trend != null && Number.isFinite(Number(row.trend)) ? Number(row.trend) : null,
        supertrendStrength01,
        chartStrict: strictChartAlign,
        chartOnly: true,
      };
      state.supertrendStHandledCloseKey = barCloseKey;
      if (wsHubRef) {
        const candlesSt = rawCandles;
        const lastSt = candlesSt.length ? candlesSt[candlesSt.length - 1] : null;
        const pfSt = portfolioMtmForWs(lastSt, candlesSt, _cachedPositions, _cachedAccount, null);
        wsHubRef.broadcast("state", {
          mode: runtimeTradingMode(),
          ...getPublicState(),
          account: pfSt.account,
          positions: pfSt.positionsMtM,
        });
      }
      return;
    }

    const indicatorsBarClose = computeIndicators(rawCandles);
    const decisionSnapshotBar =
      evBar.decisionSnapshotBar ??
      computeDecisionSnapshot({
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

    let moveQualityAtBar = null;
    try {
      const sidePv = allowBuy ? "BUY" : allowSell ? "SELL" : "BUY";
      const vEn = stFut ? "FUTURES" : "SPOT";
      const slP = estimateSlDistancePctForMoveQualityGate(state, indicatorsBarClose.latest, vEn);
      moveQualityAtBar = evaluateSupertrendMoveQuality({
        candles: rawCandles,
        latest: indicatorsBarClose.latest,
        openingSide: sidePv,
        slDistancePct: slP,
        options: supertrendMoveQualityEvalOptions(),
      });
    } catch (e) {
      log?.warn?.("supertrend_move_quality_preview_failed", { error: String(e?.message || e) });
    }

    // --- AI gates: never allow slow /predict to stall bar-close execution for multiple seconds.
    // Use cached gates for this bar when available; otherwise give the predictor a small time budget
    // and fall back to the last known values.
    const symU = String(state.symbol || "").toUpperCase();
    if (!state._stAiGateCache || typeof state._stAiGateCache !== "object") state._stAiGateCache = Object.create(null);
    const cacheRow = state._stAiGateCache[symU];
    const cachedForThisBar =
      cacheRow && Number(cacheRow.cTs) === Number(cTs) ? { aiGateBuy: cacheRow.aiGateBuy, aiGateSell: cacheRow.aiGateSell } : null;
    const cachedLast =
      cacheRow && (cacheRow.aiGateBuy != null || cacheRow.aiGateSell != null)
        ? { aiGateBuy: cacheRow.aiGateBuy, aiGateSell: cacheRow.aiGateSell }
        : { aiGateBuy: null, aiGateSell: null };
    let aiGateBuy = cachedForThisBar ? cachedForThisBar.aiGateBuy : cachedLast.aiGateBuy;
    let aiGateSell = cachedForThisBar ? cachedForThisBar.aiGateSell : cachedLast.aiGateSell;

    if (!cachedForThisBar) {
      const startedAt = Date.now();
      const p = resolveSupertrendBarCloseAiGates(rawCandles)
        .then((g) => {
          try {
            state._stAiGateCache[symU] = {
              cTs,
              aiGateBuy: g.aiGateBuy ?? null,
              aiGateSell: g.aiGateSell ?? null,
              computedAt: Date.now(),
              ms: Date.now() - startedAt,
            };
          } catch {
            /* ignore */
          }
          return g;
        })
        .catch(() => null);

      const budget = SUPERTREND_BAR_CLOSE_AI_BUDGET_MS;
      if (budget > 0) {
        const got = await withTimeout(p, budget).catch(() => null);
        if (got && typeof got === "object") {
          aiGateBuy = got.aiGateBuy ?? aiGateBuy;
          aiGateSell = got.aiGateSell ?? aiGateSell;
        }
      }
    }

    state.supertrendLastBarClose = {
      ts: Number(row.ts),
      /** Chart-aligned: only true when autotrade may act on this bar (see SUPERTREND_STRICT_CHART_ALIGN). */
      buySignal: allowBuy === true,
      sellSignal: allowSell === true,
      exitSignal: allowExit === true,
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
      /** ATR/ADX/body/expansion composite — always computed for UI; gate uses `supertrendMoveQualityGate`. */
      moveQuality: moveQualityAtBar,
    };

    if (wsHubRef) {
      const candlesSt = rawCandles;
      const lastSt = candlesSt.length ? candlesSt[candlesSt.length - 1] : null;
      const pfSt = portfolioMtmForWs(lastSt, candlesSt, _cachedPositions, _cachedAccount, null);
      wsHubRef.broadcast("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: pfSt.account,
        positions: pfSt.positionsMtM,
      });
    }

    async function flushSupertrendFlipSignalHistoryIfNeeded() {
      if (!(allowBuy || allowSell)) return;
      state.supertrendLastFlipBarClose = { ...state.supertrendLastBarClose };
      const side = allowBuy ? "BUY" : "SELL";
      const ss = decisionSnapshotBar.signalStrength;
      const surfPulseHist = await fetchSurfPulseScoreForHistory(rawCandles);
      const signalBarClose =
        strengthBar && Number.isFinite(Number(strengthBar.close)) && Number(strengthBar.close) > 0
          ? Number(strengthBar.close)
          : idxC >= 0 && clean[idxC] && Number.isFinite(Number(clean[idxC].close)) && Number(clean[idxC].close) > 0
            ? Number(clean[idxC].close)
            : null;
      const signalBarCloseTs =
        Number.isFinite(Number(row.ts)) && String(state.timeframe || "").trim()
          ? Number(row.ts) + binanceIntervalMs(state.timeframe)
          : null;
      const mdSnap = snapMarketDecisionForHistory({
        candles: rawCandles,
        cTs: Number(row.ts),
        row,
        decisionSnapshotBar,
        symbol: state.symbol,
        timeframe: state.timeframe,
      });
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
        surfPulse: surfPulseHist,
        ...(moveQualityAtBar != null && Number.isFinite(Number(moveQualityAtBar.score))
          ? {
              mqScore: Number(moveQualityAtBar.score),
              mqVerdict: moveQualityAtBar.verdict != null ? String(moveQualityAtBar.verdict) : null,
            }
          : {}),
        ...(signalBarClose != null ? { signalBarClose } : {}),
        ...(signalBarCloseTs != null ? { signalBarCloseTs } : {}),
        ...(mdSnap ? { marketDecisionSnapshot: mdSnap } : {}),
      };
      appendSupertrendSignalHistoryEntry(entry, cfgPersistenceSlug);
      const prev = Array.isArray(state.supertrendSignalHistory) ? state.supertrendSignalHistory : [];
      const symH = String(entry.symbol).toUpperCase();
      const tfH = String(entry.timeframe);
      const filt = prev.filter(
        (e) =>
          !(
            Number(e?.ts) === entry.ts &&
            e?.side === entry.side &&
            String(e?.symbol || symH).toUpperCase() === symH &&
            String(e?.timeframe || "") === tfH
          ),
      );
      filt.push({
        ts: entry.ts,
        side: entry.side,
        symbol: symH,
        timeframe: tfH,
        aiGate: entry.aiGate,
        strength: entry.strength,
        stAction: entry.stAction,
        surfPulse: entry.surfPulse != null && Number.isFinite(Number(entry.surfPulse)) ? Number(entry.surfPulse) : null,
        ...(entry.mqScore != null && Number.isFinite(Number(entry.mqScore)) ? { mqScore: Number(entry.mqScore) } : {}),
        ...(entry.mqVerdict != null && String(entry.mqVerdict).trim() ? { mqVerdict: String(entry.mqVerdict).trim() } : {}),
        ...(entry.signalBarClose != null &&
        Number.isFinite(Number(entry.signalBarClose)) &&
        Number(entry.signalBarClose) > 0
          ? { signalBarClose: Number(entry.signalBarClose) }
          : {}),
        ...(entry.signalBarCloseTs != null &&
        Number.isFinite(Number(entry.signalBarCloseTs)) &&
        Number(entry.signalBarCloseTs) > 0
          ? { signalBarCloseTs: Number(entry.signalBarCloseTs) }
          : {}),
        ...(entry.marketDecisionSnapshot != null && typeof entry.marketDecisionSnapshot === "object"
          ? { marketDecisionSnapshot: entry.marketDecisionSnapshot }
          : {}),
      });
      filt.sort((a, b) => Number(a.ts) - Number(b.ts));
      state.supertrendSignalHistory = filt.slice(-SUPERTREND_SIGNAL_STATE_MAX);
      persistTradingConfigToDisk();
      scheduleSmartSsRefresh(8000);
      if (wsHubRef) {
        const candlesFl = rawCandles;
        const lastFl = candlesFl.length ? candlesFl[candlesFl.length - 1] : null;
        const pfFl = portfolioMtmForWs(lastFl, candlesFl, _cachedPositions, _cachedAccount, null);
        wsHubRef.broadcast("state", {
          mode: runtimeTradingMode(),
          ...getPublicState(),
          account: pfFl.account,
          positions: pfFl.positionsMtM,
        });
      }
    }

    /** Next-bar breakout: close beyond signal candle high (BUY) or low (SELL). Primary chart only. */
    async function tryConsumeSupertrendBreakoutFromPending() {
      const pend = state.pendingSupertrendBreakout;
      if (!pend) return { handled: false };
      if (String(pend.symbol || "").toUpperCase() !== String(state.symbol).toUpperCase()) {
        state.pendingSupertrendBreakout = null;
        return { handled: false };
      }
      if (pend.stSpot !== stSpot || pend.stFut !== stFut) {
        state.pendingSupertrendBreakout = null;
        return { handled: false };
      }
      if (!Number.isFinite(cTs) || cTs <= Number(pend.signalBarTs)) return { handled: false };
      if (!state.running) {
        state.pendingSupertrendBreakout = null;
        return { handled: false };
      }
      if (state.feedExecutionPause) return { handled: false };
      const hub = wsHubRef;
      if (!hub) return { handled: false };

      const confCl = Number(strengthBar?.close);
      const sigHi = Number(pend.signalHigh);
      const sigLo = Number(pend.signalLow);
      let crossed = false;
      if (pend.side === "BUY" && Number.isFinite(confCl) && Number.isFinite(sigHi) && confCl > sigHi) crossed = true;
      if (pend.side === "SELL" && Number.isFinite(confCl) && Number.isFinite(sigLo) && confCl < sigLo) crossed = true;

      if (!crossed) {
        pend.barsWaited = (pend.barsWaited || 0) + 1;
        if (pend.barsWaited >= pend.maxBars) {
          state.pendingSupertrendBreakout = null;
          emitSignalActionActivity(hub, {
            kind: "supertrend",
            strategyKey: barCloseStrategyKey(),
            venue: pend.stSpot ? "SPOT" : pend.stFut ? "FUTURES" : "—",
            side: pend.side,
            action: "skipped",
            reason: "breakout_confirm_timeout",
            supertrendStrength01: supertrendStrength01 ?? undefined,
          });
        }
        return { handled: false };
      }

      state.pendingSupertrendBreakout = null;

      const symT = String(state.symbol || "").trim().toUpperCase();

      state._intelligenceSizeMultiplier = 1;
      if (intelligenceGateAppliesForOpen()) {
        try {
          const openingIntel =
            pend.side === "BUY"
              ? true
              : pend.side === "SELL" && pend.stFut && state.supertrendFuturesTwoWay === true
                ? false
                : null;
          if (openingIntel != null) {
            const ig = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symT,
              openingLong: openingIntel,
              broadcastLog: (p) =>
                hub?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
              logInfo: (eventName, meta) => log?.info?.(eventName, meta),
            });
            if (ig.veto) {
              emitSignalActionActivity(hub, {
                kind: "supertrend",
                strategyKey: barCloseStrategyKey(),
                venue: pend.stSpot ? "SPOT" : pend.stFut ? "FUTURES" : "—",
                side: pend.side,
                action: "skipped",
                reason: "intelligence_gate",
                supertrendStrength01: supertrendStrength01 ?? undefined,
              });
              return { handled: true };
            }
            state._intelligenceSizeMultiplier = ig.sizeMultiplier;
          }
        } catch {
          /* never block on intelligence error */
        }
      }

      if (idxC > 0 && symT) {
        const prevB = clean[idxC - 1];
        const curB = clean[idxC];
        const prevC = Number(prevB?.close);
        const clb = Number(curB?.close);
        const lo = Number(curB?.low);
        if (
          Number.isFinite(prevC) &&
          prevC > 0 &&
          Number.isFinite(clb) &&
          !isPlausibleCandleClose(symT, clb, lo, prevC)
        ) {
          emitSignalActionActivity(hub, {
            kind: "supertrend",
            strategyKey: barCloseStrategyKey(),
            venue: pend.stSpot ? "SPOT" : pend.stFut ? "FUTURES" : "—",
            side: pend.side,
            action: "skipped",
            reason: "implausible_close_step_vs_prior_sanitized_bar",
            supertrendStrength01: supertrendStrength01 ?? undefined,
          });
          return { handled: true };
        }
      }

      const barCloseCandlesSnapshot = rawCandles.map((c) => (c && typeof c === "object" ? { ...c } : c));
      const anchorTs = Number(pend.signalBarTs);

      if (pend.side === "BUY" && pend.stSpot) {
        const buyRes = await trySupertrendSpotOrder({
          side: "BUY",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${anchorTs}:BUY`,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: anchorTs,
        });
        emitSupertrendSignalFeedback(hub, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
        if (buyRes?.action === "placed") await pushImmediateState(hub);
      } else if (pend.side === "BUY" && pend.stFut) {
        const buyRes = await trySupertrendFuturesOrder({
          side: "BUY",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          dedupeKey: `${anchorTs}:FUT:BUY`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: anchorTs,
          barCloseAiGates: { aiGateBuy, aiGateSell },
        });
        emitSupertrendSignalFeedback(hub, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
        if (buyRes?.action === "placed") await pushImmediateState(hub);
      } else if (pend.side === "SELL" && pend.stSpot) {
        const sellRes = await trySupertrendSpotOrder({
          side: "SELL",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${anchorTs}:SELL`,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: anchorTs,
        });
        emitSupertrendSignalFeedback(hub, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
        if (sellRes?.action === "placed") await pushImmediateState(hub);
      } else if (pend.side === "SELL" && pend.stFut) {
        const sellRes = await trySupertrendFuturesOrder({
          side: "SELL",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          dedupeKey: `${anchorTs}:FUT:SELL`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: anchorTs,
          barCloseAiGates: { aiGateBuy, aiGateSell },
        });
        emitSupertrendSignalFeedback(hub, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
        if (sellRes?.action === "placed") await pushImmediateState(hub);
      }

      return { handled: true };
    }

    if (allowExit && state.running && !state.feedExecutionPause) {
      state.supertrendStHandledCloseKey = barCloseKey;
      if (stFut) {
        const positions = _cachedPositions || [];
        const legs = positions.filter(
          (p) =>
            String(p?.symbol || "").toUpperCase() === String(state.symbol || "").toUpperCase() &&
            Number(p?.qty) > 0,
        );
        if (legs.length) {
          await closeFuturesLegsForSupertrend(legs, `${strategyKeyBar}_EXIT`);
          await pushImmediateState(wsHubRef);
        }
      }
      return;
    }

    const breakoutBar = await tryConsumeSupertrendBreakoutFromPending();
    if (breakoutBar?.handled) {
      state.supertrendStHandledCloseKey = barCloseKey;
      return;
    }

    if (!(allowBuy || allowSell)) return;

    if (!stSpot && !stFut) {
      await flushSupertrendFlipSignalHistoryIfNeeded();
      if (!shouldSuppressBarCloseAutotradeOffActivity(state)) {
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
            strategyKey: barCloseStrategyKey(),
          venue: "—",
          side: allowBuy ? "BUY" : "SELL",
          action: "skipped",
          reason: "supertrend_autotrade_off_or_market_mode_mismatch",
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      persistSupertrendSkippedSignal({
        gateReason: "supertrend_autotrade_off_or_market_mode_mismatch",
        direction: allowBuy ? "LONG" : "SHORT",
        row,
        cTs,
        symbolU: String(state.symbol || "").trim().toUpperCase(),
        decisionSnapshotBar,
        supertrendStrength01,
        stSpot,
        stFut,
      });
      }
      return;
    }

    if (state.running && state.feedExecutionPause && (allowBuy || allowSell)) {
      state.supertrendStHandledCloseKey = barCloseKey;
      await flushSupertrendFlipSignalHistoryIfNeeded();
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: barCloseStrategyKey(),
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: allowBuy ? "BUY" : "SELL",
          action: "skipped",
          reason: `feed_paused:${state.feedExecutionPause.reason}`,
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      persistSupertrendSkippedSignal({
        gateReason: `feed_paused:${state.feedExecutionPause.reason}`,
        direction: allowBuy ? "LONG" : "SHORT",
        row,
        cTs,
        symbolU: String(state.symbol || "").trim().toUpperCase(),
        decisionSnapshotBar,
        supertrendStrength01,
        stSpot,
        stFut,
      });
      return;
    }

    if (!state.running) {
      await flushSupertrendFlipSignalHistoryIfNeeded();
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
          pendingDedupeKey: barCloseKey,
        });
      }
      persistSupertrendSkippedSignal({
        gateReason: "queued_bot_not_running",
        direction: allowBuy ? "LONG" : "SHORT",
        row,
        cTs,
        symbolU: String(state.symbol || "").trim().toUpperCase(),
        decisionSnapshotBar,
        supertrendStrength01,
        stSpot,
        stFut,
      });
      return;
    }

    const hub = wsHubRef;
    if (!hub) {
      await flushSupertrendFlipSignalHistoryIfNeeded();
      return;
    }

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
        await flushSupertrendFlipSignalHistoryIfNeeded();
        emitSignalActionActivity(hub, {
          kind: "supertrend",
          strategyKey: barCloseStrategyKey(),
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: allowBuy ? "BUY" : allowSell ? "SELL" : "—",
          action: "skipped",
          reason: "implausible_close_step_vs_prior_sanitized_bar",
        });
        persistSupertrendSkippedSignal({
          gateReason: "implausible_close_step_vs_prior_sanitized_bar",
          direction: allowBuy ? "LONG" : allowSell ? "SHORT" : "LONG",
          row,
          cTs,
          symbolU: symTrade,
          decisionSnapshotBar,
          supertrendStrength01,
          stSpot,
          stFut,
        });
        return;
      }
    }

    state.supertrendStHandledCloseKey = barCloseKey;

    if (!state.supertrendBreakoutConfirm) {
      state.pendingSupertrendBreakout = null;
    } else if (allowBuy || allowSell) {
      state.pendingSupertrendBreakout = {
        symbol: String(state.symbol).toUpperCase(),
        side: allowBuy ? "BUY" : "SELL",
        signalBarTs: cTs,
        signalHigh: Number(strengthBar?.high),
        signalLow: Number(strengthBar?.low),
        stSpot,
        stFut,
        barsWaited: 0,
        maxBars: Math.max(1, Math.min(20, Math.floor(Number(state.supertrendBreakoutMaxBars ?? 5)))),
      };
      await flushSupertrendFlipSignalHistoryIfNeeded();
      if (wsHubRef) {
        emitSignalActionActivity(wsHubRef, {
          kind: "supertrend",
          strategyKey: barCloseStrategyKey(),
          venue: stSpot ? "SPOT" : stFut ? "FUTURES" : "—",
          side: allowBuy ? "BUY" : "SELL",
          action: "pending",
          reason: "breakout_confirm_wait_next_close",
          supertrendStrength01: supertrendStrength01 ?? undefined,
        });
      }
      persistSupertrendSkippedSignal({
        gateReason: "breakout_confirm_wait_next_close",
        direction: allowBuy ? "LONG" : "SHORT",
        row,
        cTs,
        symbolU: symTrade,
        decisionSnapshotBar,
        supertrendStrength01,
        stSpot,
        stFut,
      });
      return;
    }

    /**
     * `rawCandles` was captured at handler entry (with the closed bar as tail). After `await` work (AI gates,
     * position checks, etc.), `feed.getCandles()` can advance to the next bar — pass this snapshot into
     * `trySupertrend*Order` so `last.close` / indicators match the signal bar, not the live tail.
     * Deep-clone bars so in-buffer updates to the forming next candle cannot mutate objects in this snapshot.
     */
    const barCloseCandlesSnapshot = rawCandles.map((c) =>
      c && typeof c === "object" ? { ...c } : c,
    );

    let barSignalId = null;
    if (getPool()) {
      let iid = null;
      try {
        iid = typeof getActiveInstanceId === "function" ? getActiveInstanceId() : null;
      } catch {
        iid = null;
      }
      if (iid) {
        const tfMsSig = binanceIntervalMs(state.timeframe);
        const barCloseWall =
          Number.isFinite(cTs) && cTs > 0 && Number.isFinite(tfMsSig) && tfMsSig > 0
            ? new Date(cTs + tfMsSig)
            : new Date();
        const dirSig = allowBuy ? "LONG" : "SHORT";
        try {
          const sig = await tradeService.recordSignal(String(iid), {
            symbol: symTrade,
            signalType: strategyKeyBar,
            direction: dirSig,
            timeframe: state.timeframe,
            barCloseTime: barCloseWall,
            stValue: row?.line != null ? Number(row.line) : null,
            aiProbability: state.lastAi?.probability ?? null,
            mdeScore:
              decisionSnapshotBar?.long?.total != null
                ? Number(decisionSnapshotBar.long.total)
                : decisionSnapshotBar?.short?.total != null
                  ? Number(decisionSnapshotBar.short.total)
                  : null,
            signalStrength: supertrendStrength01 != null ? Number(supertrendStrength01) : null,
            wasExecuted: false,
            gateReason: null,
            rawContext: { barTs: cTs, allowBuy, allowSell, stSpot, stFut },
          });
          barSignalId = sig?.id ?? null;
        } catch (e) {
          log?.warn?.("trade_signal_bar_failed", { error: String(e?.message || e) });
        }
      }
    }

    // ── Intelligence gate (optional): LONG opens only here; SHORT-open gate runs only for 2-way futures SELL ──
    try {
      state._intelligenceSizeMultiplier = 1;
      if (intelligenceGateAppliesForOpen() && allowBuy) {
        const ig = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symTrade,
          openingLong: true,
          broadcastLog: (p) =>
            wsHubRef?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
          logInfo: (eventName, meta) => log?.info?.(eventName, meta),
        });
        if (ig.veto) {
          state.supertrendStHandledCloseKey = barCloseKey;
          return;
        }
        state._intelligenceSizeMultiplier = ig.sizeMultiplier;
      }
    } catch {
      /* never block a trade on intelligence error */
    }

    let placedBarExecution = false;
    let skipReasonBar = null;
    const skipFlipEntry = (orderSide) => {
      if (state.supertrendFuturesExitOnFlip !== false || !stFut) return false;
      const symU = String(symTrade || state.symbol || "").trim().toUpperCase();
      const leg = (_cachedPositions || []).find(
        (p) =>
          String(p?.symbol || "").toUpperCase() === symU &&
          Number.isFinite(Number(p?.positionAmt)) &&
          Math.abs(Number(p.positionAmt)) > 1e-12,
      );
      if (!leg) return false;
      const amt = Number(leg.positionAmt);
      if (orderSide === "BUY" && amt < 0) return true;
      if (orderSide === "SELL" && amt > 0) return true;
      return false;
    };
    if (allowBuy && !skipFlipEntry("BUY")) {
      let buyRes;
      if (stSpot) {
        buyRes = await trySupertrendSpotOrder({
          side: "BUY",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${Number(row.ts)}:BUY`,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: cTs,
          dbSignalId: barSignalId,
        });
      } else {
        buyRes = await trySupertrendFuturesOrder({
          side: "BUY",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          dedupeKey: `${Number(row.ts)}:FUT:BUY`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: cTs,
          barCloseAiGates: { aiGateBuy, aiGateSell },
          dbSignalId: barSignalId,
          adapterSignal: adapterBarSignal,
        });
      }
      emitSupertrendSignalFeedback(hub, { ...buyRes, signalStrength: supertrendStrength01 ?? undefined });
      if (buyRes?.action === "placed") {
        placedBarExecution = true;
        await pushImmediateState(hub);
      } else skipReasonBar = skipReasonBar || buyRes?.reason || null;
    }
    if (
      allowSell &&
      !placedBarExecution &&
      stFut &&
      state.supertrendFuturesTwoWay === true &&
      intelligenceGateAppliesForOpen()
    ) {
      try {
        state._intelligenceSizeMultiplier = 1;
        const igShort = evaluateIntelligenceGateForSupertrendOpen({
            gateEnabled: true,
            strictMode: state.intelligenceGateStrict === true,
            symbol: symTrade,
          openingLong: false,
          broadcastLog: (p) =>
            wsHubRef?.broadcast?.("log", { ...p, tradingMode: runtimeTradingMode() }),
          logInfo: (eventName, meta) => log?.info?.(eventName, meta),
        });
        if (igShort.veto) {
          state.supertrendStHandledCloseKey = barCloseKey;
          return;
        }
        state._intelligenceSizeMultiplier = igShort.sizeMultiplier;
      } catch {
        /* never block a trade on intelligence error */
      }
    }
    if (allowSell && !placedBarExecution && !skipFlipEntry("SELL")) {
      let sellRes;
      if (stSpot) {
        sellRes = await trySupertrendSpotOrder({
          side: "SELL",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          indicatorFullCapital: true,
          dedupeKey: `${Number(row.ts)}:SELL`,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: cTs,
          dbSignalId: barSignalId,
        });
      } else {
        sellRes = await trySupertrendFuturesOrder({
          side: "SELL",
          strategyKey: barCloseStrategyKey(),
          wsHub: hub,
          dedupeKey: `${Number(row.ts)}:FUT:SELL`,
          signalStrength: supertrendStrength01,
          decisionSnapshot: decisionSnapshotBar,
          candlesOverride: barCloseCandlesSnapshot,
          anchorBarTs: cTs,
          barCloseAiGates: { aiGateBuy, aiGateSell },
          dbSignalId: barSignalId,
          adapterSignal: adapterBarSignal,
        });
      }
      emitSupertrendSignalFeedback(hub, { ...sellRes, signalStrength: supertrendStrength01 ?? undefined });
      if (sellRes?.action === "placed") {
        placedBarExecution = true;
        await pushImmediateState(hub);
      } else skipReasonBar = skipReasonBar || sellRes?.reason || null;
    }
    if (barSignalId) {
      void tradeService
        .updateSignalOutcome(String(barSignalId), {
          wasExecuted: placedBarExecution,
          gateReason: placedBarExecution ? null : skipReasonBar || "not_placed",
        })
        .catch((e) => log?.warn?.("trade_signal_outcome_failed", { error: String(e?.message || e) }));
    }

    await flushSupertrendFlipSignalHistoryIfNeeded();
  }

  /** @deprecated use processBarCloseTrading */
  const processSupertrendCandleClose = processBarCloseTrading;

  // Disk/strategy hydrate runs after market feed exists (see syncMarketFeedFromState below).

  /**
   * UI chart tabs + WS multiplex candidates. Pins and custom watchlists apply to charts even when
   * Pick control is Auto (pins only filter autotrade candidates).
   */
  function resolveMultiCoinUiSymbolCandidates() {
    const norm = (arr) =>
      [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(
        0,
        10,
      );

    const customBase = String(state.universeCoinBase || "ALL").toUpperCase() === "CUSTOM";
    const custom = norm(state.universeCustomSymbols);
    if (customBase && custom.length) return custom;

    const pins = norm(state.universePinnedSymbols);
    if (pins.length) return pins;

    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() !== "MULTIPLE") return [];

    const snap = state.universe;
    const rankedSyms = Array.isArray(snap?.ranked) ? snap.ranked.map((r) => r?.symbol).filter(Boolean) : [];
    const selectedSyms = Array.isArray(snap?.selected) && snap.selected.length ? snap.selected : [];
      const seen = new Set();
    const merged = [];
      for (const s of selectedSyms) {
        const u = String(s || "").trim().toUpperCase();
        if (!u || seen.has(u)) continue;
        seen.add(u);
      merged.push(u);
      }
      for (const s of rankedSyms) {
        const u = String(s || "").trim().toUpperCase();
        if (!u || seen.has(u)) continue;
        seen.add(u);
      merged.push(u);
    }
    return merged.slice(0, 12);
  }

  /**
   * Same symbol ordering for WS multiplex + REST sweep: primary first, then universe, capped to BINANCE_COMBINED_MAX_STREAMS
   * so every listed symbol has live kline buffers (parallel with main chart).
   */
  function computeAutoMultiWatchSymbolList() {
    const candidatesRaw = resolveMultiCoinUiSymbolCandidates();
    const maxStreams = Math.max(1, Math.min(80, Math.floor(Number(process.env.BINANCE_COMBINED_MAX_STREAMS ?? 12))));
    const watchN = Math.min(autoMultiWatchSize(), maxStreams);
    const primary = String(state.symbol || "").toUpperCase();
    if (!primary) return [];
    const candidates = [...new Set(candidatesRaw.map((s) => String(s).toUpperCase()).filter(Boolean))];
    const merged = [primary, ...candidates.filter((s) => s !== primary)];
    return merged.slice(0, watchN);
  }

  function computeFeedWatchSymbols() {
    if (!marketFeedUsesLiveBinance()) return [];
    const mm = String(state.marketMode || "AUTO").toUpperCase();
    const ttlMs = Math.max(10_000, Math.min(60 * 60 * 1000, Number(process.env.UI_CHART_WATCH_TTL_MS ?? 10 * 60_000)));
    const uiMax = Math.max(0, Math.min(20, Math.floor(Number(process.env.UI_CHART_WATCH_MAX ?? 6))));
    const primary = String(state.symbol || "").toUpperCase();

    // UI-driven chart symbols (MRU + TTL): keep `/api/market/candles?symbol=...` near-real-time via WS buffers.
    const now = Date.now();
    if (!state._uiChartWatch || typeof state._uiChartWatch !== "object") state._uiChartWatch = Object.create(null);
    for (const k of Object.keys(state._uiChartWatch)) {
      if (!state._uiChartWatch[k] || Number(state._uiChartWatch[k]) <= now) delete state._uiChartWatch[k];
    }
    const uiSyms = Object.entries(state._uiChartWatch)
      .filter(([s, exp]) => s && s !== primary && Number(exp) > now)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([s]) => s)
      .slice(0, uiMax);

    /**
     * Multiplex klines for **every** multi-coin tab symbol whenever `MULTIPLE` is on — not only when
     * `parallelSupertrendWatchGate` (AUTO+ST+…) is true. Otherwise live USD-M had WS buffers only for
     * `uiChartFocusSymbol` + MRU UI hits → other tabs saw REST-only candles and looked “frozen” vs demo.
     */
    const multiCoinMode = String(state.universeCoinSelectMode || "SINGLE").toUpperCase() === "MULTIPLE";
    const autoSyms =
      multiCoinMode || parallelSupertrendWatchGate(mm) ? computeAutoMultiWatchSymbolList() : [];
    const focusChart =
      state.uiChartFocusSymbol != null && String(state.uiChartFocusSymbol).trim()
        ? String(state.uiChartFocusSymbol).trim().toUpperCase()
        : "";

    // Union + cap to combined WS stream budget.
    const maxStreams = Math.max(1, Math.min(80, Math.floor(Number(process.env.BINANCE_COMBINED_MAX_STREAMS ?? 12))));
    const out = [];
    const seen = new Set();
    for (const s of [...(focusChart && focusChart !== primary ? [focusChart] : []), ...autoSyms, ...uiSyms]) {
      const u = String(s || "").toUpperCase();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= maxStreams) break;
    }
    /** Chart focus must stay on the wire even if the cap cut it — otherwise tick `market` stays primary-only. */
    if (focusChart && focusChart !== primary && !seen.has(focusChart)) {
      const fu = focusChart;
      if (out.length < maxStreams) {
        out.push(fu);
        seen.add(fu);
      } else {
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i] !== primary) {
            out[i] = fu;
            break;
          }
        }
      }
    }
    return out;
  }

  function noteUiChartWatchSymbol(symU) {
    if (!marketFeedUsesLiveBinance()) return;
    const u = String(symU || "").trim().toUpperCase();
    const primary = String(state.symbol || "").toUpperCase();
    if (!u || u === primary) return;
    const ttlMs = Math.max(10_000, Math.min(60 * 60 * 1000, Number(process.env.UI_CHART_WATCH_TTL_MS ?? 10 * 60_000)));
    if (!state._uiChartWatch || typeof state._uiChartWatch !== "object") state._uiChartWatch = Object.create(null);
    state._uiChartWatch[u] = Date.now() + ttlMs;
    // Debounce WS resubscribe so quick chart clicks don’t thrash.
    try { syncFeedWatchSymbols(); } catch { /* ignore */ }
  }

  async function buildAutoMultiCtx(mm) {
    const { stSpot, stFut } = resolveTradingVenue(mm);
    const venueSpot = stSpot && !stFut;
    let positions = _cachedPositions || [];
    try {
      positions = await exch.getPositions();
      _cachedPositions = positions;
    } catch {
      /* ignore */
    }
    const openSyms = distinctOpenSymbolsForVenue(positions, venueSpot);
    let maxOpen = autoMultiMaxOpenPositions();
    if (String(state.universeCoinSelectMode || "SINGLE").toUpperCase() === "MULTIPLE") {
      maxOpen = Math.min(10, maxOpen);
    }
    let acct = null;
    try {
      acct = await exch.getAccount();
    } catch {
      /* ignore */
    }
    async function refreshOpenSymsAfterTrade() {
      try {
        positions = await exch.getPositions();
        _cachedPositions = positions;
      } catch {
        /* ignore */
      }
      openSyms.clear();
      for (const s of distinctOpenSymbolsForVenue(positions, venueSpot)) openSyms.add(s);
    }
    return {
      stSpot,
      stFut,
      venueSpot,
      maxOpen,
      openSyms,
      refreshOpenSymsAfterTrade,
      acct,
    };
  }

  let maybeAutoMultiBarClose = async () => {};

  feed = createMarketFeed({
    log,
    symbol: state.symbol,
    timeframe: state.timeframe,
    feedKind: effectiveMarketFeedKind(),
    tradingMode: runtimeTradingMode(),
    onCandleClose: async (c) => {
      try {
        if (marketFeedUsesLiveBinance() && getPool()) {
          const symArc = String(c.symbol || state.symbol || "")
            .replace(/[^A-Za-z0-9]/g, "")
            .toUpperCase();
          const tfArc = String(state.timeframe || "15m").trim();
          if (symArc && tfArc) {
            scheduleArchiveLiveOhlcvCandle({
              symbol: symArc,
              timeframe: tfArc,
              feedKind: effectiveMarketFeedKind(),
              candle: {
                ts: Number(c.ts),
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: c.volume != null ? Number(c.volume) : 0,
              },
            });
          }
        }
      } catch {
        /* never block trading on OHLC archive */
      }
      const intelligenceTimer = setTimeout(() => {
        void (async () => {
          try {
            const sym = String(c.symbol || state.symbol || "").toUpperCase();
            const tf = String(state.timeframe || "15m");
            const allCandles =
              typeof feed.getCandlesForSymbol === "function"
                ? feed.getCandlesForSymbol(sym)
                : feed.getCandles();
            if (sym && allCandles.length) {
              updateIntelligenceCandles(sym, tf, allCandles);
              await computeAndBroadcastIntelligenceSnapshot(sym, wsHubRef).catch(() => {});
            }
          } catch {
            /* never block on intelligence */
          }
        })();
      }, 0);
      intelligenceTimer.unref?.();
      void processBarCloseTrading(c);
      void maybeAutoMultiBarClose(c);
    },
    /** Chart/UI: push last bar on each Binance kline WS (throttled); full `market` from `tick()` still ~BOT_TICK_MS. */
    onPrimaryCandleLive: (payload) => {
      const hub = wsHubRef;
      if (!hub || typeof hub.broadcast !== "function") return;
      if (typeof hub.clientCount === "function" && hub.clientCount() === 0) return;
      const payloadSym = String(payload?.symbol || "").trim().toUpperCase();
      const selectedChartSym = String(state.uiChartFocusSymbol || state.symbol || "").trim().toUpperCase();
      if (payloadSym && selectedChartSym && payloadSym !== selectedChartSym) return;
      try {
        hub.broadcast("market", {
          ...payload,
          feedExecutionPause: state.feedExecutionPause,
          originTradingMode: runtimeTradingMode(),
        });
      } catch {
        /* ignore */
      }
    },
  });

  let watchSigBroadcastTimer = null;
  function debouncedBroadcastWatchSignals() {
    if (watchSigBroadcastTimer) clearTimeout(watchSigBroadcastTimer);
    watchSigBroadcastTimer = setTimeout(() => {
      watchSigBroadcastTimer = null;
      try {
        const candlesW = feed.getCandles();
        const lastW = candlesW.length ? candlesW[candlesW.length - 1] : null;
        const pfW = portfolioMtmForWs(lastW, candlesW, _cachedPositions, _cachedAccount, null);
        wsHubRef?.broadcast?.("state", {
          mode: runtimeTradingMode(),
          ...getPublicState(),
          account: pfW.account,
          positions: pfW.positionsMtM,
        });
      } catch {
        /* ignore */
      }
    }, 280);
  }

  async function persistMultiSymbolSnapshot(symU, ev, source, gatesPrecomputed = null) {
    const cr = ev.closedRaw;
    const { aiGateBuy, aiGateSell } =
      gatesPrecomputed && typeof gatesPrecomputed === "object"
        ? {
            aiGateBuy: gatesPrecomputed.aiGateBuy ?? null,
            aiGateSell: gatesPrecomputed.aiGateSell ?? null,
          }
        : await resolveSupertrendBarCloseAiGatesNoLastAi(cr, symU);
    const ss = ev.decisionSnapshotBar?.signalStrength;
    const base = state.multiSymbolWatchSignals && typeof state.multiSymbolWatchSignals === "object" ? state.multiSymbolWatchSignals : {};
    const prevSnap = base[symU];
    const signalUnchanged =
      prevSnap &&
      Number(prevSnap.ts) === Number(ev.cTs) &&
      Boolean(prevSnap.buySignal) === Boolean(ev.allowBuy) &&
      Boolean(prevSnap.sellSignal) === Boolean(ev.allowSell);

    let marketDecisionSnapshot = null;
    try {
      const mdCfg = mergeMarketDecisionConfig(state.marketDecision);
      const cfg = augmentMarketDecisionConfigForFeeGate(mdCfg);
      marketDecisionSnapshot = computeMarketDecisionSnapshot({
        candles: cr,
        cTs: ev.cTs,
        row: {
          buySignal: Boolean(ev.row?.buySignal),
          sellSignal: Boolean(ev.row?.sellSignal),
          trend: ev.row?.trend,
        },
        decisionSnapshotBar: ev.decisionSnapshotBar,
        symbol: symU,
        timeframe: state.timeframe,
        config: cfg,
        regimeBtc: null,
        regimeHtf: null,
      });
    } catch {
      marketDecisionSnapshot = null;
    }

    state.multiSymbolWatchSignals = {
      ...base,
      [symU]: {
        ts: ev.cTs,
        buySignal: Boolean(ev.allowBuy),
        sellSignal: Boolean(ev.allowSell),
        trend: ev.row?.trend != null && Number.isFinite(Number(ev.row.trend)) ? Number(ev.row.trend) : null,
        strength01: ev.supertrendStrength01 ?? null,
        signalStrength: ss?.strength != null && Number.isFinite(Number(ss.strength)) ? Number(ss.strength) : null,
        stAction: ss?.action != null ? String(ss.action) : null,
        aiGateBuy: aiGateBuy ?? null,
        aiGateSell: aiGateSell ?? null,
        bufferBars: typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(symU)?.length ?? null : null,
        updatedAt: Date.now(),
        source: source === "sweep" ? "sweep" : "kline_ws",
        marketDecisionSnapshot,
      },
    };
    if (wsHubRef && (ev.allowBuy || ev.allowSell) && !signalUnchanged) {
      const side = ev.allowBuy ? "BUY" : "SELL";
      emitActivity(wsHubRef, {
        level: "info",
        msg: `Multi-watch Supertrend ${side} signal · ${symU} (bar close · ${source === "sweep" ? "sweep" : "kline_ws"})`,
        category: "strategy",
        reason: "multi_symbol_st_signal",
        symbol: symU,
        detail: {
          ts: ev.cTs,
          buySignal: Boolean(ev.allowBuy),
          sellSignal: Boolean(ev.allowSell),
          source: source === "sweep" ? "sweep" : "kline_ws",
          trend: ev.row?.trend,
        },
      });
    }
    debouncedBroadcastWatchSignals();
  }

  function syncFeedWatchSymbols() {
    if (typeof feed?.setWatchSymbols !== "function") return;
    const mm = String(state.marketMode || "AUTO").toUpperCase();
    if (!parallelSupertrendWatchGate(mm)) {
      // Even when parallel watch mode is off, keep a small WS watchlist for UI chart symbols
      // so `/api/market/candles?symbol=...` can use feed buffers instead of REST polling.
      const primary = String(state.symbol || "").toUpperCase();
      const syms = computeFeedWatchSymbols().filter((s) => s && s !== primary);
      feed.setWatchSymbols(syms);
      state.multiSymbolWatchSignals = Object.create(null);
      void warmSymbolMetaForWatchlist([primary, ...syms].filter(Boolean));
      return;
    }
    const primary = String(state.symbol || "").toUpperCase();
    const syms = computeFeedWatchSymbols().filter((s) => s && s !== primary);
    feed.setWatchSymbols(syms);
    void warmSymbolMetaForWatchlist([primary, ...syms].filter(Boolean));
    const allowed = new Set([primary, ...computeFeedWatchSymbols()].filter(Boolean));
    const prev = state.multiSymbolWatchSignals && typeof state.multiSymbolWatchSignals === "object" ? state.multiSymbolWatchSignals : {};
    const next = { ...prev };
    for (const k of Object.keys(next)) {
      if (!allowed.has(k)) delete next[k];
    }
    state.multiSymbolWatchSignals = next;
  }

  /** Background warmup so first trade on a symbol doesn't block on exchangeInfo/meta. */
  let warmMetaTimer = null;
  async function warmSymbolMetaForWatchlist(symbols) {
    if (!symbols || !Array.isArray(symbols) || typeof exch?.getSymbolOrderConstraints !== "function") return;
    if (!state._warmedSymbolMeta || typeof state._warmedSymbolMeta !== "object") state._warmedSymbolMeta = Object.create(null);
    const uniq = [...new Set(symbols.map((s) => String(s || "").toUpperCase()).filter(Boolean))].slice(0, 20);
    if (!uniq.length) return;
    if (warmMetaTimer) clearTimeout(warmMetaTimer);
    warmMetaTimer = setTimeout(async () => {
      warmMetaTimer = null;
      // Concurrency limit = 2 to avoid hammering REST.
      const queue = uniq.filter((s) => !state._warmedSymbolMeta[s]);
      if (!queue.length) return;
      let idx = 0;
      const worker = async () => {
        while (idx < queue.length) {
          const s = queue[idx++];
          try {
            await withTimeout(exch.getSymbolOrderConstraints({ symbol: s, venue: "BOTH" }), 1500);
            state._warmedSymbolMeta[s] = Date.now();
          } catch {
            // keep retrying on future sync cycles
          }
        }
      };
      await Promise.all([worker(), worker()]);
    }, 300);
  }

  maybeAutoMultiBarClose = async function maybeAutoMultiBarCloseInner(candle) {
    if (!marketFeedUsesLiveBinance()) return;
    if (!wsHubRef) return;
    const mm = String(state.marketMode || "AUTO").toUpperCase();
    if (!parallelSupertrendWatchGate(mm)) return;
    const symU = String(candle.symbol || "").toUpperCase();
    const primaryU = String(state.symbol || "").toUpperCase();
    const watch = computeFeedWatchSymbols();
    /**
     * `watch` is capped (`BINANCE_COMBINED_MAX_STREAMS`) and prepends UI focus first. The trading **primary**
     * is always the multiplex `feed` main symbol (its own stream) but can be **dropped from `watch`** when the
     * cap fills with focus + other alts. `processBarCloseTrading` is a no-op in this mode, so skipping
     * here meant **zero** bar-close orders on the bot’s selected coin.
     */
    if (symU !== primaryU && !watch.includes(symU)) return;
    const minBars = Math.max(30, state.supertrendPeriod + 2);
    let rows = typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(symU) : [];
    if (!Array.isArray(rows) || rows.length < minBars) {
      const klineLimit = Math.max(120, Math.min(1000, Number(process.env.AUTO_MULTI_KLINES_LIMIT ?? 450)));
      try {
        rows = await fetchBinanceKlinesRows({
          symbol: symU,
          interval: state.timeframe,
          limit: klineLimit,
          feedKind: effectiveMarketFeedKind(),
        });
      } catch {
        return;
      }
      const closedRaw = rows.length >= 2 ? rows.slice(0, -1) : rows;
      const ev = await evaluateSupertrendLastClosedBar(closedRaw, symU, Number(candle.ts));
      if (!ev) return;
      if (!state.running) return;
      const ctx = await buildAutoMultiCtx(mm);
      const gatesOut = await processAutoMultiFromEval(symU, wsHubRef, ev, ctx);
      await persistMultiSymbolSnapshot(symU, ev, "kline_ws", gatesOut);
      return;
    }
    const ev = await evaluateSupertrendLastClosedBar(rows, symU, Number(candle.ts));
    if (!ev) return;
    if (!state.running) return;
    const ctx = await buildAutoMultiCtx(mm);
    const gatesOut = await processAutoMultiFromEval(symU, wsHubRef, ev, ctx);
    await persistMultiSymbolSnapshot(symU, ev, "kline_ws", gatesOut);
  };

  syncFeedWatchSymbols();

  const depth = marketFeedUsesLiveBinance()
    ? createBinanceOrderBook({ log, symbol: state.symbol, wsBase: binanceDepthWsBase() })
    : null;

  /** Apply persisted symbol/timeframe to live feed after hydrate/reload (feed not wired during fromPersisted). */
  function syncMarketFeedFromState() {
    if (!feed) return;
    try {
      const sym = String(state.symbol || "").trim().toUpperCase();
      if (sym && SYM_RE.test(sym)) feed.setSymbol(sym);
      if (state.timeframe && PERSISTED_TF.has(state.timeframe)) feed.setTimeframe(state.timeframe);
      syncFeedWatchSymbols();
      if (depth && marketFeedUsesLiveBinance()) {
        const depthSym =
          state.uiChartFocusSymbol && String(state.uiChartFocusSymbol).trim()
            ? String(state.uiChartFocusSymbol).trim().toUpperCase()
            : sym;
        if (depthSym) depth.setSymbol(depthSym);
      }
    } catch (e) {
      log?.warn?.("sync_market_feed_from_state_failed", { error: String(e?.message || e) });
    }
  }

  const universe = createBinanceUniverse({ log, feedKind: effectiveMarketFeedKind() });
  if (marketFeedUsesLiveBinance()) universe.warmTradableSymbolsCache?.();
  const cg = createCoinGeckoClient({ log });
  let lastSeenTradeId = null;
  /** Dedup CLOSE WS broadcasts — same id must not be emitted twice (duplicate rows / findIndex bug). */
  let ingestedCloseBroadcastKeys = new Set();
  let closedSinceRetrain = 0;
  let tickInFlight = false;

  function setWsHub(hub) {
    wsHubRef = hub || null;
    queueMicrotask(() => wireExchangeAccountPushListener());
  }
  let _cachedAccount = null;
  let _cachedPositions = [];
  let _lastAccountFetchAt = 0;
  let _lastStrictAccountWarnAt = 0;
  /** Symbols whose trailing extremePx has already been recovered from OHLCV candles after restart. */
  const _trailingRecoveryDoneSyms = new Set();
  /** True once the real-time trailing poll has been started for the current exchange instance. */
  let _realtimeTrailingPollStarted = false;

  // Disk holds latest runtime edits; when a DB strategy version is bound, it wins over disk.
  if (initialPersistedConfig != null && typeof initialPersistedConfig === "object") {
    hydrateTradingConfigFromPersistedObject(initialPersistedConfig);
  } else {
    hydrateTradingConfigFromDisk();
  }
  loadSupertrendSignalHistoryFromDisk();
  syncMarketFeedFromState();

  /**
   * Build `account` + `positions` for every WS `state` message. If we omit either, the UI keeps the
   * previous portfolio snapshot (see `applyWsStateSnapshot`) — stale open rows after exchange closes.
   */
  function portfolioMtmForWs(lastCandle, candlesArr, positionsIn, accountIn, accountError) {
    const positions = Array.isArray(positionsIn) ? positionsIn : [];
    const account = accountIn;
    if (
      !lastCandle ||
      !Number.isFinite(Number(lastCandle.close)) ||
      Number(lastCandle.close) <= 0
    ) {
      const unrealizedPnl = positions.reduce((a, p) => a + Number(p.unrealizedPnl || 0), 0);
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
              unrealizedPnl,
              equityWithUnrealized: equityWithUnrealizedTick,
              accountError: accountError || undefined,
              dailyPnlPct,
              dailyPnlPctByVenue: dailyPnlPctByVenue || undefined,
            };
      return {
        positionsMtM: positions,
        account: acctBroadcast,
        exceededDailyLoss,
        dailyPnlPct,
        dailyPnlPctByVenue,
      };
    }
    const markPrice = Number(lastCandle.close);
    const symU = String(state.symbol || "").toUpperCase();
    const prevK =
      Array.isArray(candlesArr) && candlesArr.length >= 2 ? candlesArr[candlesArr.length - 2] : null;
    const prevKClose = prevK ? Number(prevK.close) : null;
    if (
      Number.isFinite(markPrice) &&
      markPrice > 0 &&
      !isPlausibleCandleClose(symU, markPrice, Number(lastCandle.low), prevKClose)
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
      if (p.venue === "FUTURES" && p.syncSource === "fapi_v2_account") {
        const apiUpnl = Number(p.unrealizedPnl ?? p.unrealizedProfit ?? 0);
        const rowSym = String(p?.symbol || "").toUpperCase();
        const chartMark = Number.isFinite(markPrice) && markPrice > 0 && rowSym === symU ? markPrice : null;
        const entryPx = Number(p.entryPrice) > 0 ? Number(p.entryPrice) : null;
        const rowMark = chartMark ?? entryPx;
        return { ...p, markPrice: rowMark, unrealizedPnl: Number.isFinite(apiUpnl) ? apiUpnl : null };
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
    return {
      positionsMtM,
      account: acctBroadcast,
      exceededDailyLoss,
      dailyPnlPct,
      dailyPnlPctByVenue,
    };
  }

  /**
   * Persisted `allowedBudgetUsdt` must not exceed what the wallet can support.
   * USD-M: allotment is **quote notional**; max ≈ free margin × leverage (same bound as `resolveFixedUsdtRiskForOrder`).
   * Spot-style: still **margin / quote** vs free balance.
   */
  function clampAllowedBudgetToFreeMargin() {
    const cap = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
    if (cap == null || !Number.isFinite(cap) || cap <= 0) return;
    const ab = Number(state.allowedBudgetUsdt);
    if (!Number.isFinite(ab) || ab <= 0) return;
    const mm = String(state.marketMode || "AUTO").toUpperCase();
    if (mm === "FUTURES" || mm === "AUTO") {
      const lev = futuresLeverageForSizingResolve();
      const maxNotional = cap * lev;
      if (ab > maxNotional) state.allowedBudgetUsdt = roundTo(maxNotional, 6);
      return;
    }
    if (ab > cap) state.allowedBudgetUsdt = roundTo(cap, 6);
  }

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
        exceeded: pct <= -limit / 100,
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
      /** `maxDailyLoss` is 0–100 (percent points); venue returns are fractional (e.g. -0.05 = -5%). */
      const threshold = -limit / 100;
      exceeded = ["spot", "futures"].some((k) => {
        const p = dailyPnlPctByVenue[k];
        if (p == null || !Number.isFinite(p)) return false;
        const start = state.dailyVenueBaseline[k]?.startEquity;
        return Number(start) >= MIN_START && p <= threshold;
      });
    }

    return { dailyPnlPctByVenue, dailyPnlUsdByVenue, dailyPnlPctWorst, dailyPnlUsdWorst, exceeded };
  }

  let _destroyed = false;
  const BOT_TICK_MS = Math.max(1_000, Math.min(30_000, Number(process.env.BOT_TICK_MS || 5000)));
  const _tickTimer = setInterval(() => {
    if (_destroyed) return;
    if (tickInFlight) return;
    tickInFlight = true;
    tick({ wsHub: wsHubRef })
      .catch((e) => log.warn("tick_error", { error: String(e?.message || e) }))
      .finally(() => { tickInFlight = false; });
  }, BOT_TICK_MS);
  // Depth broadcast loop (UI order book). Skip serialization when no client is
  // subscribed — avoids burning CPU on the 500 ms cadence in headless runs.
  const _depthTimer = setInterval(() => {
    if (_destroyed) return;
    if (!depth) return;
    const b = depth.getBook();
    if (b?.symbol && Array.isArray(b.bids) && Array.isArray(b.asks)) {
      try {
        updateIntelligenceOrderBook(String(b.symbol).trim().toUpperCase(), b.bids, b.asks);
      } catch {
        /* optional intelligence feed — never block depth */
      }
    }
    if (!wsHubRef) return;
    if (typeof wsHubRef.clientCount === "function" && wsHubRef.clientCount() === 0) return;
    if (!b?.symbol) return;
    wsHubRef.broadcast("depth", { ...b, originTradingMode: runtimeTradingMode() });
  }, 500);

  // External context loop (CoinGecko market context for current symbol)
  let cgInFlight = false;
  const _cgTimer = setInterval(() => {
    if (_destroyed) return;
    if (!wsHubRef) return;
    if (cgInFlight) return;
    if (String(process.env.ENABLE_COINGECKO || "1") === "0") return;
    cgInFlight = true;
    (async () => {
      try {
        const ctx = await cg.marketContext({ symbol: state.symbol });
        if (ctx?.ok) wsHubRef.broadcast("external", { ...ctx, originTradingMode: runtimeTradingMode() });
      } catch {
        // ignore
      } finally {
        cgInFlight = false;
      }
    })();
  }, 30_000);

  function buildUniverseScanOpts() {
    const coinBase = String(state.universeCoinBase || "ALL").toUpperCase() === "CUSTOM" ? "CUSTOM" : "ALL";
    const customRaw = Array.isArray(state.universeCustomSymbols) ? state.universeCustomSymbols : [];
    const cleanedCustom = [...new Set(customRaw.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10);
    const customSymbols = coinBase === "CUSTOM" && cleanedCustom.length ? cleanedCustom : null;
    return {
      timeframe: state.timeframe,
      universeSize: customSymbols ? Math.max(10, cleanedCustom.length) : Number(process.env.UNIVERSE_SIZE || 50),
      topKlines: customSymbols ? Math.min(10, cleanedCustom.length) : Number(process.env.UNIVERSE_TOP_KLINES || 28),
      minQuoteVolumeUSDT: Number(process.env.UNIVERSE_MIN_QUOTE_VOL || 5_000_000),
      maxSpreadPct: Number(process.env.UNIVERSE_MAX_SPREAD_PCT || 0.0015),
      excludeStablePairs: String(process.env.UNIVERSE_EXCLUDE_STABLES || "1") !== "0",
      aiClient: ai,
      customSymbols,
      rankByAiPrimary: !customSymbols,
      aiRankedDisplayTop: customSymbols ? 0 : 10,
    };
  }

  // Coin selection loop (runs even if bot stopped so you can see ranks).
  let scanInFlight = false;
  let lastUniverseScanFailLogAt = 0;
  let lastUniverseScanFailErr = "";
  const _scanTimer = setInterval(() => {
    if (_destroyed) return;
    if (!universeScanEnabled()) return;
    if (scanInFlight) return;
    if (!marketFeedUsesLiveBinance()) return;
    if (state.symbolMode !== "AUTO") return;
    scanInFlight = true;
    (async () => {
      try {
        if (String(state.universeCoinBase || "ALL").toUpperCase() === "CUSTOM") {
          const cr = Array.isArray(state.universeCustomSymbols) ? state.universeCustomSymbols : [];
          const cleaned = [...new Set(cr.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10);
          if (!cleaned.length) {
            state.universe = {
              ok: true,
              asOf: new Date().toISOString(),
              timeframe: state.timeframe,
              ranked: [],
              selected: [],
              tradable: 0,
              universeSize: 0,
              emptyCustom: true,
            };
            const acct0 = await exch.getAccount().catch(() => null);
            const pos0 = await exch.getPositions().catch(() => []);
            wsHubRef?.broadcast?.("state", { mode: runtimeTradingMode(), ...getPublicState(), account: acct0, positions: pos0 });
            return;
          }
        }

        const snap = await universe.scanAndRank(buildUniverseScanOpts());
        state.universe = snap;
        // Attach account + positions so the UI doesn't flash empty
        const acct = await exch.getAccount().catch(() => null);
        const pos = await exch.getPositions().catch(() => []);
        wsHubRef?.broadcast?.("state", { mode: runtimeTradingMode(), ...getPublicState(), account: acct, positions: pos });
        syncFeedWatchSymbols();

        const isMultiPin = String(state.universeCoinSelectMode || "SINGLE").toUpperCase() === "MULTIPLE";
        const pinSym =
          universeManualPinningOn() && !isMultiPin && state.universePinnedSymbol
            ? String(state.universePinnedSymbol).toUpperCase()
            : "";
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
          syncFeedWatchSymbols();
          return;
        }

        const mmScan = String(state.marketMode || "AUTO").toUpperCase();
        if (isMultiPin && (autoMultiUnpinnedActive(mmScan) || stSignalFirstMultiSweepActive(mmScan))) {
          syncFeedWatchSymbols();
          await runAutoMultiUnpinnedSweep(wsHubRef);
          return;
        }

        const positions = await exch.getPositions().catch(() => []);
        const openPositions = Array.isArray(positions) ? positions : [];
        const openCount = openPositions.length;
        const maxConc = isMultiPin
          ? Math.min(10, Math.max(1, Math.floor(Number(state.maxConcurrentPositions) || 1)))
          : Math.max(1, Math.floor(Number(state.maxConcurrentPositions) || 1));
        if (openCount >= maxConc) return;

        const openSymbols = new Set(
          openPositions
            .map((p) => String(p?.symbol || "").toUpperCase())
            .filter(Boolean)
        );

        if (!isMultiPin && openCount >= 1) return;

        // Prefer a candidate we don't already hold, so we can open multi-crypto positions.
        const selectedSyms = Array.isArray(snap?.selected) && snap.selected.length ? snap.selected : [];
        const rankedSyms = Array.isArray(snap?.ranked) ? snap.ranked.map((r) => r?.symbol).filter(Boolean) : [];
        let candidates = selectedSyms.length ? selectedSyms : rankedSyms;
        if (
          universeManualPinningOn() &&
          isMultiPin &&
          Array.isArray(state.universePinnedSymbols) &&
          state.universePinnedSymbols.length > 0
        ) {
          const ps = new Set(state.universePinnedSymbols.map((s) => String(s).toUpperCase()));
          candidates = candidates.filter((s) => ps.has(String(s).toUpperCase()));
          if (!candidates.length) candidates = [...ps];
        }
        let best = null;
        if (!isMultiPin && String(state.universeAutoCoinPick || "").toUpperCase() === "ST_SIGNAL_FIRST") {
          try {
            best = await pickFirstStSignalSymbol(candidates, openSymbols);
          } catch (e) {
            log.warn("st_signal_pick_failed", { error: String(e?.message || e) });
          }
        }
        if (!best) {
          best =
            candidates.find((s) => !openSymbols.has(String(s).toUpperCase())) ||
            snap?.selected?.[0] ||
            rankedSyms?.[0] ||
            null;
        }

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
        syncFeedWatchSymbols();
        if (wsHubRef) {
          queueMicrotask(() => {
            tick({ wsHub: wsHubRef }).catch((e) =>
              log.warn("universe_tick_flush_failed", { error: String(e?.message || e) }),
            );
          });
        }
      } catch (e) {
        const err = String(e?.message || e);
        const now = Date.now();
        if (now - lastUniverseScanFailLogAt > 5 * 60_000 || err !== lastUniverseScanFailErr) {
          lastUniverseScanFailLogAt = now;
          lastUniverseScanFailErr = err;
          wsHubRef?.broadcast?.("log", { level: "warn", msg: "Universe scan failed", error: err });
        }
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
   * Autotrade in `processBarCloseTrading` still runs only on kline close (k.x).
   */
  /**
   * @param {boolean} [opts.withChartArrays=true] If false, skips building full `line` / `signals` (1000s of points).
   *        Tick still needs `lastRow` for decisions; chart arrays are omitted from high-frequency WS to cut bandwidth/CPU.
   */
  function computeSupertrendChartModel(chartCandles, opts = {}) {
    const withChartArrays = opts.withChartArrays !== false;
    const empty = { line: null, signals: [], lastRow: null };
    if (!chartCandles?.length) return empty;
    const symOpt =
      opts.symbol != null && String(opts.symbol).trim()
        ? String(opts.symbol).trim().toUpperCase()
        : String(state.symbol || "").toUpperCase();
    const clean = sanitizeCandlesForSt(chartCandles, symOpt);
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

  /** Chart snapshot from an in-feed symbol buffer (multiplex watchlist). */
  function getChartSnapshotFromFeedSymbol(symU, opts = {}) {
    const hours = Math.max(0.25, Number(opts.hours ?? 24));
    const s = String(symU || "").trim().toUpperCase();
    if (!SYM_RE.test(s)) return null;
    const raw = typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(s) || [] : [];
    const n = maxBarsForHistory(state.timeframe, hours);
    const slice = raw.length <= n ? raw.slice() : raw.slice(-n);
    const candles = sanitizeCandlesForSt(slice, s);
    const st = computeSupertrendChartModel(candles, { symbol: s });
    return {
      symbol: s,
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

  /**
   * Last candle `ts` is bar **open** time. If the feed WebSocket stops advancing, the UI REST poll
   * (`/market/candles`) used to re-read the same frozen buffer — this detects that and triggers REST OHLCV.
   */
  function feedChartTailLooksStale(candles) {
    if (!marketFeedUsesLiveBinance()) return false;
    if (!Array.isArray(candles) || !candles.length) return true;
    const last = candles[candles.length - 1];
    const ts = Number(last?.ts);
    if (!Number.isFinite(ts) || ts <= 0) return true;
    const tfMs = binanceIntervalMs(state.timeframe);
    if (!Number.isFinite(tfMs) || tfMs <= 0) return false;
    const age = Date.now() - ts;
    return age > tfMs * 2 + 15_000;
  }

  /** Same shape as `getChartSnapshot`, but fetches Binance REST klines when the in-memory tail is stale or too thin. */
  async function getChartSnapshotOrRestRepair(opts = {}) {
    const focusU =
      state.uiChartFocusSymbol != null && String(state.uiChartFocusSymbol).trim()
        ? String(state.uiChartFocusSymbol).trim().toUpperCase()
        : "";
    const primaryU = String(state.symbol || "").toUpperCase();
    const stPeriod = Number(state.supertrendPeriod ?? 10);
    const needsRepair = (candles) =>
      chartSnapshotNeedsRestRepair(candles, {
        supertrendPeriod: stPeriod,
        tailStale: feedChartTailLooksStale(candles),
      });
    if (focusU && focusU !== primaryU) {
      const snapF = getChartSnapshotFromFeedSymbol(focusU, opts);
      if (snapF?.candles?.length && !needsRepair(snapF.candles)) return snapF;
      log.warn("chart_snapshot_feed_repair_using_rest", {
        symbol: focusU,
        timeframe: state.timeframe,
        barCount: snapF?.candles?.length ?? 0,
        uiChartFocus: true,
      });
      const repairedF = await getChartSnapshotForSymbol(focusU, { ...opts, forceRest: true });
      return repairedF?.candles?.length ? repairedF : snapF || getChartSnapshot(opts);
    }
    const snap = getChartSnapshot(opts);
    if (!needsRepair(snap?.candles)) return snap;
    log.warn("chart_snapshot_feed_repair_using_rest", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      barCount: snap?.candles?.length ?? 0,
    });
    const repaired = await getChartSnapshotForSymbol(String(state.symbol || ""), { ...opts, forceRest: true });
    return repaired?.candles?.length ? repaired : snap;
  }

  function buildChartSnapshotFromRawCandles(symU, rawCandles, hours) {
    const candles = sanitizeCandlesForSt(rawCandles, symU);
    if (!candles.length) return null;
        const st = computeSupertrendChartModel(candles, { symbol: symU });
        return {
          symbol: symU,
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

  function getChartSnapshotFromFeedBuffer(symU, hours) {
    if (!marketFeedUsesLiveBinance() || typeof feed.getCandlesForSymbol !== "function") return null;
    const buf = feed.getCandlesForSymbol(symU);
    if (!Array.isArray(buf) || !buf.length) return null;
    const n = maxBarsForHistory(state.timeframe, hours);
    const raw = buf.length <= n ? buf.slice() : buf.slice(-n);
    return buildChartSnapshotFromRawCandles(symU, raw, hours);
  }

  async function getChartSnapshotForSymbol(sym, opts = {}) {
    const forceRest = Boolean(opts.forceRest);
    const hours = Math.max(0.25, Math.min(168, Number(opts.hours ?? 24)));
    const symU = String(sym || "").trim().toUpperCase();
    if (!SYM_RE.test(symU)) return null;
    noteUiChartWatchSymbol(symU);
    const n = maxBarsForHistory(state.timeframe, hours);
    const minBars = Math.max(30, state.supertrendPeriod + 2);
    if (!forceRest) {
      const fromFeed = getChartSnapshotFromFeedBuffer(symU, hours);
      if (fromFeed?.candles?.length >= minBars) return fromFeed;
    }
    const limit = Math.min(1000, Math.max(50, n + 20));
    let rows = [];
    try {
      rows = await fetchBinanceKlinesRows({
        symbol: symU,
        interval: state.timeframe,
        limit,
        feedKind: effectiveMarketFeedKind(),
        tradingMode: runtimeTradingMode(),
        chartPublic: true,
      });
    } catch {
      rows = [];
    }
    if (Array.isArray(rows) && rows.length) {
    const raw = rows.map((r) => ({
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
      const fromRest = buildChartSnapshotFromRawCandles(symU, raw, hours);
      if (fromRest?.candles?.length) {
        if (typeof feed.seedCandlesForSymbol === "function") {
          try {
            const buf =
              typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(symU) : [];
            const lastTs = Array.isArray(buf) && buf.length ? Number(buf[buf.length - 1]?.ts) : NaN;
            const tailStale =
              !Array.isArray(buf) ||
              !buf.length ||
              !Number.isFinite(lastTs) ||
              Date.now() - lastTs > 120_000;
            if (tailStale) feed.seedCandlesForSymbol(symU, fromRest.candles);
          } catch {
            /* ignore */
          }
        }
        return fromRest;
      }
    }
    return getChartSnapshotFromFeedBuffer(symU, hours);
  }

  function getPublicState() {
    return {
      running: state.running,
      paused: Boolean(state.paused),
      symbol: state.symbol,
      timeframe: state.timeframe,
      symbolMode: state.symbolMode,
      aiThreshold: state.aiThreshold,
      riskPerTrade: state.riskPerTrade,
      maxDailyLoss: state.maxDailyLoss,
      riskPerTradeUnit: state.riskPerTradeUnit === "USDT" ? "USDT" : "PCT",
      maxDailyLossUnit: state.maxDailyLossUnit === "USDT" ? "USDT" : "PCT",
      capitalSplitAcrossCoins: Boolean(state.capitalSplitAcrossCoins),
      allowedBudgetUsdt: Number(state.allowedBudgetUsdt) || 0,
      allowedBudgetWalletPct: clamp(Number(state.allowedBudgetWalletPct || 0), 0, 100),
      allowedBudgetInputMode: state.allowedBudgetInputMode === "WALLET_PCT" ? "WALLET_PCT" : "USDT",
      allowedBudgetPnlAnchorMs:
        state.allowedBudgetPnlAnchorMs != null && Number.isFinite(Number(state.allowedBudgetPnlAnchorMs))
          ? Math.round(Number(state.allowedBudgetPnlAnchorMs))
          : null,
      multiTradeUsePctOfUsable: Boolean(state.multiTradeUsePctOfUsable),
      multiTradePctOfUsable: clamp(Number(state.multiTradePctOfUsable ?? 100), 0, 100),
      capitalAllotmentCompoundPnlUi: Boolean(state.capitalAllotmentCompoundPnlUi),
      capitalCycleStrategyBalanceUsdt: Math.max(0, Number(state.capitalCycleStrategyBalanceUsdt) || 0),
      capitalCyclePoolAnchorUsdt: Math.max(0, Number(state.capitalCyclePoolAnchorUsdt) || 0),
      capitalCycleRealizedPnlUsdt: Number(state.capitalCycleRealizedPnlUsdt) || 0,
      capitalCycleSymbols: Array.isArray(state.capitalCycleSymbols) ? [...state.capitalCycleSymbols] : [],
      perTradeBudgetCapEnabled: Boolean(state.perTradeBudgetCapEnabled !== false),
      perTradeBudgetInputMode: state.perTradeBudgetInputMode === "PCT_OF_USABLE" ? "PCT_OF_USABLE" : "USDT",
      multiCoinCapitalSizingActive: Boolean(state.multiCoinCapitalSizingActive),
      usableCapitalBufferPct: usableCapitalBufferPctFromEnv(),
      multiBudgetSplitMode:
        state.multiBudgetSplitMode === "FULL" ||
        state.multiBudgetSplitMode === "EQUAL" ||
        state.multiBudgetSplitMode === "CUSTOM_USDT" ||
        state.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED"
          ? state.multiBudgetSplitMode
          : null,
      multiBudgetCoinUsdt:
        state.multiBudgetCoinUsdt && typeof state.multiBudgetCoinUsdt === "object" ? { ...state.multiBudgetCoinUsdt } : {},
      multiBudgetCoinPct:
        state.multiBudgetCoinPct && typeof state.multiBudgetCoinPct === "object" ? { ...state.multiBudgetCoinPct } : {},
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
      lastSurfPulseMl: state.lastSurfPulseMl,
      lastRegime: state.lastRegime,
      topStrategies: topStrategies(state.stats),
      universe: state.universe,
      universeLastPick: state.universeLastPick,
      universePinnedSymbol: state.universePinnedSymbol,
      universeCoinBase: state.universeCoinBase,
      universeCustomSymbols: Array.isArray(state.universeCustomSymbols) ? [...state.universeCustomSymbols] : [],
      universeCoinSelectMode: state.universeCoinSelectMode,
      universePinControl: state.universePinControl === "MANUAL" ? "MANUAL" : "AUTO",
      universeAutoCoinPick: state.universeAutoCoinPick === "ST_SIGNAL_FIRST" ? "ST_SIGNAL_FIRST" : "RANKED_AI_SS",
      universePinnedSymbols: Array.isArray(state.universePinnedSymbols) ? [...state.universePinnedSymbols] : [],
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
      supertrendMoveQualityGate: state.supertrendMoveQualityGate === true,
      supertrendHtf4hEnabled: state.supertrendHtf4hEnabled === true,
      supertrendHtf4hPeriod: clamp(Math.round(Number(state.supertrendHtf4hPeriod ?? 10)), 2, 50),
      supertrendHtf4hMultiplier: Math.max(0.5, Number(state.supertrendHtf4hMultiplier ?? 3)),
      volumeProfileEnabled: state.volumeProfileEnabled === true,
      volumeProfileSoftGates: state.volumeProfileSoftGates !== false,
      volumeProfileGatesEnabled: state.volumeProfileGatesEnabled === true,
      intradayVpBrackets: state.intradayVpBrackets === true,
      intradayGateLiquidity: state.intradayGateLiquidity !== false,
      intradayGateSession: state.intradayGateSession !== false,
      intradayGateFib: state.intradayGateFib !== false,
      intradayGateVp: state.intradayGateVp !== false,
      intradayGateOrderFlow: state.intradayGateOrderFlow !== false,
      intradayGateHtfRegime: state.intradayGateHtfRegime !== false,
      intradayGateInstitutionalSr: state.intradayGateInstitutionalSr === true,
      intradayGateSmcIct: state.intradayGateSmcIct === true,
      intradaySmcIctMode: state.intradaySmcIctMode === true,
      intradaySmcIctProfile: String(state.intradaySmcIctProfile ?? "sweep").toLowerCase(),
      intradaySmcPickMode: String(state.intradaySmcPickMode ?? "per_signal").toLowerCase(),
      intradaySmcOneTradePerDay: state.intradaySmcOneTradePerDay === true,
      intradaySmcMinScore: clamp(Math.round(Number(state.intradaySmcMinScore ?? 7)), 1, 20),
      intradaySmcRequireMss: state.intradaySmcRequireMss === true,
      intradaySmcRequireRetrace: state.intradaySmcRequireRetrace === true,
      intradaySmcRequireChoch: state.intradaySmcRequireChoch === true,
      intradaySmcRequireBos: state.intradaySmcRequireBos === true,
      intradaySmcRequireConfirm: state.intradaySmcRequireConfirm === true,
      intradaySmcRequireFvgRetrace: state.intradaySmcRequireFvgRetrace === true,
      intradaySmcRequireHtfBias: state.intradaySmcRequireHtfBias !== false,
      intradaySmcLookbackBars: clamp(Math.round(Number(state.intradaySmcLookbackBars ?? 30)), 3, 200),
      intradaySmcMinRr: clamp(Number(state.intradaySmcMinRr ?? 2), 0, 10),
      intradaySmcBosMaxBars: clamp(Math.round(Number(state.intradaySmcBosMaxBars ?? 5)), 1, 20),
      intradaySmcChochMaxBars: clamp(Math.round(Number(state.intradaySmcChochMaxBars ?? 8)), 1, 20),
      intradaySmcEntryZoneMode:
        state.intradaySmcEntryZoneMode === "FVG" || state.intradaySmcEntryZoneMode === "OB"
          ? state.intradaySmcEntryZoneMode
          : "EITHER",
      intradaySmcFvgEntryMode:
        state.intradaySmcFvgEntryMode === "midpoint" ? "midpoint" : "zone",
      intradaySmcTp2Mode:
        state.intradaySmcTp2Mode === "internal" || state.intradaySmcTp2Mode === "tiered"
          ? state.intradaySmcTp2Mode
          : "opposing",
      intradaySmcKillzoneMode: String(state.intradaySmcKillzoneMode ?? "LONDON_NY").toUpperCase(),
      intradaySmcMinAdx: clamp(Math.round(Number(state.intradaySmcMinAdx ?? 18)), 0, 100),
      intradaySmcHtfStrictness: String(state.intradaySmcHtfStrictness ?? "either").toLowerCase(),
      intradaySmcHtfBiasMode: (() => {
        const m = String(state.intradaySmcHtfBiasMode ?? "parallel").toLowerCase();
        return m === "ema" || m === "structure" ? m : "parallel";
      })(),
      intradaySmcChochStrict: state.intradaySmcChochStrict === true,
      intradaySmcRequirePremiumDiscount: state.intradaySmcRequirePremiumDiscount === true,
      intradaySmcPremiumDiscountOte: state.intradaySmcPremiumDiscountOte === true,
      intradaySmcDealingRangeLookback: clamp(
        Math.round(Number(state.intradaySmcDealingRangeLookback ?? 48)),
        10,
        200,
      ),
      intradaySmcSlMode: state.intradaySmcSlMode === "structure" ? "structure" : "sweep",
      intradaySmcMaxTpRr: clamp(Number(state.intradaySmcMaxTpRr ?? 5), 0, 20),
      intradaySmcMaxHoldBars: clamp(Math.round(Number(state.intradaySmcMaxHoldBars ?? 48)), 0, 2000),
      intradaySrAPlusMode: state.intradaySrAPlusMode === true,
      intradaySrMinVolRatio: clamp(Number(state.intradaySrMinVolRatio ?? 1.2), 0, 5),
      intradaySrMinHtfSep: clamp(Number(state.intradaySrMinHtfSep ?? 0.0004), 0, 0.01),
      intradaySrZoneWidthPct: clamp(Number(state.intradaySrZoneWidthPct ?? 0.002), 0.0001, 0.02),
      intradaySrBosMaxBarsAfterReclaim: clamp(
        Math.round(Number(state.intradaySrBosMaxBarsAfterReclaim ?? 3)),
        0,
        10,
      ),
      intradaySrMinConfirmWick: clamp(Number(state.intradaySrMinConfirmWick ?? 0.38), 0, 1),
      intradaySrRequireBos: state.intradaySrRequireBos !== false,
      intradaySrRequireConfirm: state.intradaySrRequireConfirm !== false,
      intradaySrRequireVolume: state.intradaySrRequireVolume !== false,
      intradaySrRequireHtfTrend: state.intradaySrRequireHtfTrend !== false,
      intradayLiqTp1Enabled: state.intradayLiqTp1Enabled !== false,
      intradayLiqTp2Enabled: state.intradayLiqTp2Enabled !== false,
      intradayLiqBreakevenAfterPartial: state.intradayLiqBreakevenAfterPartial !== false,
      intradayLiqPartialTp: state.intradayLiqPartialTp !== false,
      intradayLiqPartialFrac: clamp(Number(state.intradayLiqPartialFrac ?? 0.5), 0.1, 0.75),
      intradayLiqTp1Rr: clamp(Number(state.intradayLiqTp1Rr ?? 1), 0.25, 2),
      intradayLiqTp2Rr: clamp(Number(state.intradayLiqTp2Rr ?? 0), 0, 20),
      intradayLiqTp2PartialFrac: clamp(Number(state.intradayLiqTp2PartialFrac ?? 0), 0, 0.75),
      intradayLiqMinRr: clamp(Number(state.intradayLiqMinRr ?? 1.5), 0, 5),
      intradayLiqStrictMode: state.intradayLiqStrictMode !== false,
      intradayLiqMinSweepExtensionPct: clamp(Number(state.intradayLiqMinSweepExtensionPct ?? 0.003), 0, 0.05),
      intradayLiqSessionExtreme: state.intradayLiqSessionExtreme === true,
      intradayLiqMinScore: clamp(Math.round(Number(state.intradayLiqMinScore ?? 6)), 0, 20),
      intradayLiqMinReclaimBodyRatio: clamp(Number(state.intradayLiqMinReclaimBodyRatio ?? 0), 0, 1),
      intradayLiqRejectSameBarReclaim: state.intradayLiqRejectSameBarReclaim !== false,
      intradayLiqOnePickPerDay: state.intradayLiqOnePickPerDay !== false,
      intradayLiqRequireHtfAlign: state.intradayLiqRequireHtfAlign !== false,
      intradayLiqSlBufferPct: clamp(Number(state.intradayLiqSlBufferPct ?? 0.0015), 0, 0.01),
      intradayLiqSessionExtremeMinTouches: clamp(
        Math.round(Number(state.intradayLiqSessionExtremeMinTouches ?? 3)),
        1,
        20,
      ),
      intradayLiqSessionExtremeMinExtensionPct: clamp(
        Number(state.intradayLiqSessionExtremeMinExtensionPct ?? 0.008),
        0,
        0.05,
      ),
      srIntradaySweepPct: clamp(Number(state.srIntradaySweepPct ?? 0.0015), 0, 0.05),
      intradayLiqMaxTpRr: clamp(
        Number(
          Object.prototype.hasOwnProperty.call(state, "intradayLiqMaxTpRr")
            ? state.intradayLiqMaxTpRr
            : (state.intradaySmcMaxTpRr ?? 5),
        ),
        0,
        20,
      ),
      intradayLiqMaxHoldBars: clamp(Math.round(Number(state.intradayLiqMaxHoldBars ?? 0)), 0, 2000),
      ...liqMapPublicSnapshot(),
      ...volumeProfilePublicSnapshot(state),
      supertrendBigMoveGateEnabled: state.supertrendBigMoveGateEnabled === true,
      supertrendBigMoveMinStrength: clamp(Math.round(Number(state.supertrendBigMoveMinStrength ?? 65)), 0, 100),
      supertrendBigMoveMinMoveSlRatio: Math.max(1, Number(state.supertrendBigMoveMinMoveSlRatio ?? 1.5)),
      supertrendBigMoveMinAdx: clamp(Math.round(Number(state.supertrendBigMoveMinAdx ?? 22)), 0, 100),
      supertrendBigMoveMinScore: clamp(Number(state.supertrendBigMoveMinScore ?? 0.55), 0, 1),
      supertrendBigMoveMaxCandlesSinceFlip: Math.max(
        0,
        Math.min(20, Math.floor(Number(state.supertrendBigMoveMaxCandlesSinceFlip ?? 2))),
      ),
      supertrendBigMoveMinVolumeVsAvg: Math.max(0, Number(state.supertrendBigMoveMinVolumeVsAvg ?? 1.1)),
      supertrendBigMoveExpectedMoveAtrMult: Math.max(0.1, Number(state.supertrendBigMoveExpectedMoveAtrMult ?? 1.8)),
      supertrendMoveQualityMinScore: clamp(Number(state.supertrendMoveQualityMinScore ?? 0.6), 0, 1),
      supertrendMoveQualityMinAdx: clamp(Math.round(Number(state.supertrendMoveQualityMinAdx ?? 23)), 0, 100),
      supertrendMoveQualityMinMoveSlRatio: Math.max(1, Number(state.supertrendMoveQualityMinMoveSlRatio ?? 1.5)),
      supertrendMoveQualityExpectedMoveAtrMult: Math.max(0.1, Number(state.supertrendMoveQualityExpectedMoveAtrMult ?? 1.0)),
      supertrendMoveQualityMinAtrExpansion: Math.max(0, Number(state.supertrendMoveQualityMinAtrExpansion ?? 1.08)),
      supertrendMoveQualityMinBodyVsAvg: clamp(Number(state.supertrendMoveQualityMinBodyVsAvg ?? 0.62), 0.15, 1),
      supertrendMoveQualityMinDirectionalBody: clamp(Number(state.supertrendMoveQualityMinDirectionalBody ?? 0), 0, 1),
      supertrendMoveQualityMinVolumeVsAvg: Math.max(0, Number(state.supertrendMoveQualityMinVolumeVsAvg ?? 0)),
      srIntradayMaxTradesPerDay: clamp(Math.round(Number(state.srIntradayMaxTradesPerDay ?? 5)), 1, 50),
      srIntradayMinBarGap: clamp(Math.round(Number(state.srIntradayMinBarGap ?? 4)), 1, 200),
      srIntradayMinScore: clamp(Number(state.srIntradayMinScore ?? 7), 1, 20),
      intradayMinTechniqueCount: clamp(Math.round(Number(state.intradayMinTechniqueCount ?? 1)), 1, 10),
      intradayRequireSessionReclaim: state.intradayRequireSessionReclaim === true,
      intradayRequireFibOrVp: state.intradayRequireFibOrVp === true,
      intradayLearnedRulesEnabled: state.intradayLearnedRulesEnabled === true,
      ...eliteStPublicSnapshot(),
      marketDecision: mergeMarketDecisionConfig(state.marketDecision),
      supertrendBreakoutConfirm: state.supertrendBreakoutConfirm === true,
      supertrendBreakoutMaxBars: Math.max(1, Math.min(20, Math.floor(Number(state.supertrendBreakoutMaxBars ?? 5)))),
      signalStrengthOpenMin: clamp(Math.round(Number(state.signalStrengthOpenMin ?? 65)), 0, 100),
      smartSignalStrengthThreshold:
        state.smartSignalStrengthThreshold != null && Number.isFinite(Number(state.smartSignalStrengthThreshold))
          ? clamp(Math.round(Number(state.smartSignalStrengthThreshold)), 0, 100)
          : null,
      smartSignalStrengthThresholdMeta:
        state.smartSignalStrengthThresholdMeta && typeof state.smartSignalStrengthThresholdMeta === "object"
          ? { ...state.smartSignalStrengthThresholdMeta }
          : null,
      supertrendFuturesMinAiProb: clamp(Number(state.supertrendFuturesMinAiProb ?? 0.55), 0, 1),
      surfPulseMlGateEnabled: state.surfPulseMlGateEnabled !== false,
      surfPulseMlThreshold: clamp(Number(state.surfPulseMlThreshold ?? 0.6), 0, 1),
      intelligenceGateEnabled: state.intelligenceGateEnabled === true,
      intelligenceGateStrict: state.intelligenceGateStrict === true,
      intelligenceGateHighWinRate: state.intelligenceGateHighWinRate === true,
      intelligenceGateManualStrategies: state.intelligenceGateManualStrategies === true,
      supertrendFuturesExitOnFlip: state.supertrendFuturesExitOnFlip !== false,
      trailingStopLossAuto: state.trailingStopLossAuto === true,
      trailOnlyAfterTp2Fill: state.trailOnlyAfterTp2Fill === true,
      futuresTrailingStopMode: normalizeFuturesTrailingStopMode(state.futuresTrailingStopMode),
      futuresTrailingStFeeBreakeven: state.futuresTrailingStFeeBreakeven !== false,
      futuresTrailingStAdvanced: state.futuresTrailingStAdvanced !== false,
      trailingStopExtraScalpingPcts: normalizeTrailingExtraPcts(state.trailingStopExtraScalpingPcts),
      trailOpenFeeRate: clamp(Number(state.trailOpenFeeRate ?? 0.0004), 0, 0.01),
      trailCloseFeeRate: clamp(Number(state.trailCloseFeeRate ?? 0.0004), 0, 0.01),
      tradeHistoryMakerOpenFeeRate: clamp(Number(state.tradeHistoryMakerOpenFeeRate ?? 0.0002), 0, 0.01),
      tradeHistoryMakerCloseFeeRate: clamp(Number(state.tradeHistoryMakerCloseFeeRate ?? 0.0002), 0, 0.01),
      tradeHistoryTakerOpenFeeRate: clamp(Number(state.tradeHistoryTakerOpenFeeRate ?? 0.0005), 0, 0.01),
      tradeHistoryTakerCloseFeeRate: clamp(Number(state.tradeHistoryTakerCloseFeeRate ?? 0.0005), 0, 0.01),
      trailFeeBeMultiplier: clamp(
        Number(state.trailFeeBeMultiplier ?? process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1.0),
        1,
        2,
      ),
      trailBufferRate: clamp(Number(state.trailBufferRate ?? 0.0005), 0, 0.05),
      trailActivationSlippageFrac: clamp(Number(state.trailActivationSlippageFrac ?? 0), 0, 0.01),
      trailT01LockSlippageFrac: clamp(
        Number(state.trailT01LockSlippageFrac ?? process.env.FUTURES_TRAIL_T01_LOCK_SLIPPAGE_FRAC ?? 0),
        0,
        0.01,
      ),
      trailBufferAtrMult: clamp(Number(state.trailBufferAtrMult ?? 0), 0, 1),
      trailBufferMode: normalizeTrailBufferMode(state.trailBufferMode),
      trailPostT02ActivationBufferRate:
        state.trailPostT02ActivationBufferRate != null &&
        Number.isFinite(Number(state.trailPostT02ActivationBufferRate))
          ? clamp(Number(state.trailPostT02ActivationBufferRate), 0, 0.05)
          : null,
      trailMinSlDistFrac: clamp(Number(state.trailMinSlDistFrac ?? 0.002), 0, 0.1),
      trailMinGapFromMarkFrac: clamp(Number(state.trailMinGapFromMarkFrac ?? 0), 0, 0.2),
      trailMaintMarginRate: clamp(Number(state.trailMaintMarginRate ?? 0.005), 0, 0.1),
      trailPostT02SpacingFrac:
        state.trailPostT02SpacingFrac != null && Number.isFinite(Number(state.trailPostT02SpacingFrac))
          ? clamp(Number(state.trailPostT02SpacingFrac), 0.00001, 0.05)
          : null,
      trailPostT02MaxExtraTiers: Math.max(
        10,
        Math.min(500, Math.floor(Number(state.trailPostT02MaxExtraTiers ?? 150))),
      ),
      ...trailAdvancedPublicSnapshot(),
      supertrendFuturesFixedSlPct: clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2),
      supertrendFuturesFixedTpPct: clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5),
      supertrendFuturesUseFixedSl: state.supertrendFuturesUseFixedSl !== false,
      supertrendFuturesUseFixedTp: state.supertrendFuturesUseFixedTp !== false,
      supertrendFuturesTwoWay: state.supertrendFuturesTwoWay === true,
      supertrendFuturesMaxEntrySlippagePct: clamp(Number(state.supertrendFuturesMaxEntrySlippagePct ?? 0.15), 0, 5),
      supertrendFuturesEntryOpenStyle: (() => {
        const s = String(state.supertrendFuturesEntryOpenStyle || "AUTO").toUpperCase();
        return s === "MARKET" || s === "LIMIT_IOC" ? s : "AUTO";
      })(),
      supertrendFuturesEntryRecheckMs: Math.max(0, Math.floor(Number(state.supertrendFuturesEntryRecheckMs ?? 0))),
      supertrendFuturesIocFallbackMarket: state.supertrendFuturesIocFallbackMarket === true,
      supertrendFuturesRequireMarkPrice: state.supertrendFuturesRequireMarkPrice === true,
      supertrendFuturesRequireBookTicker: state.supertrendFuturesRequireBookTicker === true,
      supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(Number(state.supertrendFuturesMaxSignalLagMs ?? 0))),
      supertrendPeriod: state.supertrendPeriod,
      supertrendMultiplier: state.supertrendMultiplier,
      supertrendWilderAtr: state.supertrendWilderAtr,
      trendHtfStRegimeGate: state.trendHtfStRegimeGate === true,
      trendHtfStSurgicalLossFilter: state.trendHtfStSurgicalLossFilter === true,
      trendHtfStQualityFilter: state.trendHtfStQualityFilter === true,
      trendHtfStFlipExitBeforeSl: state.trendHtfStFlipExitBeforeSl === true,
      trendHtfStMaxEntryRangeAtr: Number(state.trendHtfStMaxEntryRangeAtr) || 0,
      trendHtfStMinHtfSep: Number(state.trendHtfStMinHtfSep) || 0.0005,
      trendHtfStRegimeTpTrend: Number(state.trendHtfStRegimeTpTrend) || 0.03,
      trendHtfStRegimeTpMixed: Number(state.trendHtfStRegimeTpMixed) || 0.035,
      trendHtfStRegimeTpChop: Number(state.trendHtfStRegimeTpChop) || 0.04,
      backtestBreakevenAtMfePct: Number(state.backtestBreakevenAtMfePct) || 0,
      supertrendLast: state.supertrendLast,
      supertrendLastBarClose: state.supertrendLastBarClose,
      supertrendLastFlipBarClose: state.supertrendLastFlipBarClose,
      supertrendSignalHistory: Array.isArray(state.supertrendSignalHistory)
        ? state.supertrendSignalHistory.slice(-SUPERTREND_SIGNAL_STATE_MAX)
        : [],
      decisionEngine: state.decisionEngine,
      pendingSupertrendAction: state.pendingSupertrendAction,
      pendingSupertrendBreakout: state.pendingSupertrendBreakout,
      pendingAutoRestartAfterFeedStale: state.pendingAutoRestartAfterFeedStale,
      feedExecutionPause: state.feedExecutionPause,
      lastStopReason: state.lastStopReason,
      tradingFormDefaults: { ...state.tradingFormDefaults },
      multiSymbolWatchSignals:
        state.multiSymbolWatchSignals && typeof state.multiSymbolWatchSignals === "object"
          ? { ...state.multiSymbolWatchSignals }
          : {},
      uiChartFocusSymbol: state.uiChartFocusSymbol != null ? String(state.uiChartFocusSymbol).toUpperCase() : null,
      multiCoinSignalTabSymbols: resolveMultiCoinUiSymbolCandidates().length ? computeAutoMultiWatchSymbolList() : [],
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

    let sawClosedTrade = false;
    for (const t of newTrades) {
      if (t.type !== "CLOSE") continue;
      sawClosedTrade = true;
      const bkey = closeBroadcastKey(t);
      if (ingestedCloseBroadcastKeys.has(bkey)) continue;
      ingestedCloseBroadcastKeys.add(bkey);
      if (ingestedCloseBroadcastKeys.size > 12_000) {
        ingestedCloseBroadcastKeys = new Set([...ingestedCloseBroadcastKeys].slice(-6000));
      }
      const enrichedClose = enrichCloseTradeForHistory({ ...t });
      broadcastTrade(wsHub, enrichedClose);

      // Feed institutional consecutive-loss overlay + VP novelty monitor.
      {
        const net = Number(enrichedClose.pnl ?? 0);
        const exitTs = Date.parse(enrichedClose.ts) || Date.now();
        if (!Array.isArray(state.recentClosedTrades)) state.recentClosedTrades = [];
        state.recentClosedTrades.push({
          netPnl: net,
          exitTs,
          exitReason: enrichedClose.reason ?? enrichedClose.meta?.exitReason ?? null,
          entryReason: enrichedClose.meta?.entryReason ?? enrichedClose.entryReason ?? null,
          vpConditionCellKey: enrichedClose.meta?.vpConditionCellKey ?? null,
        });
        if (state.recentClosedTrades.length > 80) {
          state.recentClosedTrades = state.recentClosedTrades.slice(-80);
        }
        const cellKey = enrichedClose.meta?.vpConditionCellKey;
        if (cellKey && state.vpNoveltyEnabled !== false) {
          try {
            const { recordLiveVpCellTrade } = await import("../strategy/vpNoveltyLive.js");
            const riskUsd = Number(enrichedClose.meta?.riskUsd ?? enrichedClose.meta?.riskAtSl ?? 0);
            const rMult = riskUsd > 0 ? net / riskUsd : net / Math.max(1, Number(state.equity ?? 100) * 0.025);
            recordLiveVpCellTrade(state, String(cellKey), rMult, exitTs);
          } catch {
            /* optional */
          }
        }
      }

      if (isIncomeLedgerClose(t)) {
        continue;
      }

      const dbTid = takeDbTradeIdForClose(enrichedClose);
      if (dbTid && getPool()) {
        const m = enrichedClose.meta || {};
        const exitPx = Number(
          enrichedClose.price ?? enrichedClose.exitPrice ?? m.closePrice ?? m.exitPrice ?? m.markPx,
        );
        const net = Number(enrichedClose.pnl ?? 0);
        const fee = Number(enrichedClose.fee ?? 0);
        let gross = enrichedClose.grossPnl != null ? Number(enrichedClose.grossPnl) : null;
        if (!Number.isFinite(gross) && Number.isFinite(net) && Number.isFinite(fee)) {
          gross = net + fee;
        }
        const roi = m.pnlPct != null ? Number(m.pnlPct) : null;
        const openedMs =
          m.signalBarCloseTs != null
            ? Number(m.signalBarCloseTs)
            : m.signalBarTs != null
              ? Number(m.signalBarTs)
              : null;
        const closedMs = Date.parse(enrichedClose.ts);
        const holdSec =
          Number.isFinite(openedMs) && Number.isFinite(closedMs)
            ? Math.max(0, Math.floor((closedMs - openedMs) / 1000))
            : null;
        const orderIds = [];
        if (m.orderId) orderIds.push(String(m.orderId));
        if (enrichedClose.id) orderIds.push(String(enrichedClose.id));
        void tradeService
          .closeTrade(String(dbTid), {
            exitPrice: Number.isFinite(exitPx) && exitPx > 0 ? exitPx : null,
            exitReason: String(enrichedClose.reason ?? m.closeReason ?? ""),
            grossPnl: Number.isFinite(gross) ? gross : null,
            feesUsdt: Number.isFinite(fee) ? fee : null,
            netPnl: Number.isFinite(net) ? net : null,
            roiPct: Number.isFinite(roi) ? roi : null,
            holdDurationSec: holdSec,
            binanceOrderIds: orderIds,
          })
          .then((trow) => {
            if (!trow) return;
            if (Number.isFinite(exitPx) && exitPx > 0 && Number.isFinite(Number(enrichedClose.qty))) {
              void tradeService
                .addFill(String(dbTid), {
                  binanceOrderId: String(enrichedClose.id || orderIds[0] || "exit"),
                  binanceTradeId: m.binanceTradeId != null ? String(m.binanceTradeId) : null,
                  fillType: "exit",
                  side: String(enrichedClose.side || "SELL"),
                  price: exitPx,
                  quantity: Math.abs(Number(enrichedClose.qty)),
                  feeUsdt: Number.isFinite(fee) ? fee : null,
                  filledAt: new Date(enrichedClose.ts || Date.now()),
                })
                .catch(() => {});
            }
          })
          .catch((e) => log?.warn?.("trade_close_persist_failed", { error: String(e?.message || e) }));
      }

      if (
        enrichedClose?.meta?.mqAtEntry &&
        typeof enrichedClose.meta.mqAtEntry === "object" &&
        String(enrichedClose.strategy || "").toUpperCase() === "SUPERTREND"
      ) {
        try {
          const mq = enrichedClose.meta.mqAtEntry;
          appendMqTradeOutcomeRow(
            {
              symbol: enrichedClose.symbol,
              venue: enrichedClose.meta?.venue ?? null,
              openSide: enrichedClose.meta?.positionSideAtClose ?? null,
              entryBarTs: enrichedClose.meta?.signalBarTs ?? null,
              closeTs: enrichedClose.ts,
              ...mq,
              outcome: enrichedClose.meta?.outcome ?? null,
              pnlPct: enrichedClose.meta?.pnlPct ?? null,
              pnl: Number(enrichedClose.pnl),
              mfe: null,
              mae: null,
              closeReason: enrichedClose.reason ?? enrichedClose.meta?.closeReason ?? null,
            },
            cfgPersistenceSlug,
          );
        } catch (e) {
          log?.warn?.("mq_trade_outcome_log_failed", { error: String(e?.message || e) });
        }
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
      if (capitalCycleModeActive()) {
        ensureCapitalCycleInitialized();
        state.capitalCycleStrategyBalanceUsdt = Math.max(
          0,
          Number(state.capitalCycleStrategyBalanceUsdt || 0) + pnlVal,
        );
        state.capitalCycleRealizedPnlUsdt = Number(state.capitalCycleRealizedPnlUsdt || 0) + pnlVal;

        // Immediately sync pool anchor + allowed budget so the UI reflects PnL after every close,
        // not only when all positions are flat.
        const walletCapSync = walletFreeMarginUsdtForAllowedCap(_cachedAccount, state.marketMode);
        let liveAnchor = Math.max(0, Number(state.capitalCycleStrategyBalanceUsdt) || 0);
        if (walletCapSync != null && Number.isFinite(walletCapSync) && walletCapSync > 0) {
          liveAnchor = Math.min(liveAnchor, walletCapSync);
        }
        state.capitalCyclePoolAnchorUsdt = liveAnchor;
        if (String(state.allowedBudgetInputMode || "USDT").toUpperCase() !== "WALLET_PCT") {
          state.allowedBudgetUsdt = clamp(liveAnchor, 0, 10_000_000);
        }
      }

      // Drawdown tracking (skip if we don't have a real wallet equity — avoids fake zeros on failed Binance fetches)
      const acctIngest = await exch.getAccount().catch(() => null);
      const eqIngest = walletBaseFromAccount(acctIngest);
      if (eqIngest != null) {
        const equity = eqIngest;
        if (equity > (state.peakEquity || 0)) state.peakEquity = equity;
        const weekFloor = Math.floor(Date.now() / (7 * 86_400_000)) * (7 * 86_400_000);
        if (!state.weekStartMs || state.weekStartMs < weekFloor) {
          state.weekStartMs = weekFloor;
          state.weekStartEquity = equity;
        }
        if (!(state.weekStartEquity > 0)) state.weekStartEquity = equity;
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
        emitActivity(wsHub, {
          level: "info",
          msg: "Auto-retraining AI model from feedback…",
          category: "ai",
          reason: "retrain_scheduled",
          source: "ingest_closed_trades",
        });
        const r = await ai.retrainFromFeedback({ minRows });
        emitActivity(wsHub, {
          level: "info",
          msg: "AI retrain complete",
          category: "ai",
          reason: "retrain_ok",
          detail: r && typeof r === "object" ? r : { result: r },
        });
      } catch (e) {
        emitActivity(wsHub, {
          level: "warn",
          msg: "AI retrain failed",
          category: "ai",
          reason: "retrain_error",
          detail: { error: String(e?.message || e) },
        });
      }
    }

    if (sawClosedTrade) {
      let iid = null;
      try {
        iid = typeof getActiveInstanceId === "function" ? getActiveInstanceId() : null;
      } catch {
        iid = null;
      }
      if (iid && getPool()) {
        void computeInstanceStats(String(iid))
          .then((stats) => updateInstanceStats(String(iid), stats))
          .then((row) => {
            if (!row || !wsHub?.broadcast) return;
            const hub = wsHub;
            const tt = row.total_trades != null ? Math.floor(Number(row.total_trades)) : null;
            const pnl = row.total_pnl_usdt != null ? Number(row.total_pnl_usdt) : null;
            hub.broadcast("instance_status", {
              instanceId: String(iid),
              totalTrades: Number.isFinite(Number(tt)) ? Number(tt) : null,
              totalPnlUsdt: Number.isFinite(Number(pnl)) ? Number(pnl) : null,
              triggeredBy: "system",
              updatedAt: new Date().toISOString(),
            });
          })
          .catch((e) => log?.warn?.("[instance] stats sync failed", { error: String(e?.message || e) }));
      }
      await maybeRebalanceCapitalCycleOnFlat({ wsHub, source: "ingest_closed_trades" });
    }
  }

  function broadcastRuntimeState(wsHub, payload = {}) {
    if (!wsHub?.broadcast) return;
    wsHub.broadcast("runtime_state", {
      mode: runtimeTradingMode(),
      running: Boolean(state.running),
      ...payload,
    });
  }

  /** Refresh Portfolio (positions + account + trade tail) over WS right after Supertrend fills. */
  async function pushImmediateState(wsHub, options = {}) {
    const withTrades = options.withTrades !== false;
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

      // Do not overwrite exchange-reported `markPrice` with the last kline close — they are different concepts.
      // The UI compares to Binance "Mark" for futures; overwriting it here makes the chart/portfolio disagree.
      const positionsMtM = _cachedPositions.map((p) => {
        if (String(p?.venue || "").toUpperCase() !== "FUTURES") return p;
        const mp = Number(p?.markPrice ?? p?.markPx ?? NaN);
        const up = Number(p?.unrealizedPnl ?? p?.unrealizedProfit ?? NaN);
        const hasUp = Number.isFinite(up);
        const hasMp = Number.isFinite(mp) && mp > 0;
        // Keep markPrice from exchange snapshot; keep uPnL if provided.
        return {
          ...p,
          ...(hasMp ? { markPrice: mp } : {}),
          ...(hasUp ? { unrealizedPnl: up } : {}),
        };
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
              // Keep account markPrice if the exchange provides one; do not overwrite from candles.
              unrealizedPnl,
              equityWithUnrealized,
              dailyPnlPct: dailyPnlPctEff,
              dailyPnlPctByVenue: dv.dailyPnlPctByVenue || undefined,
            };

      broadcastRuntimeState(wsHub, {
        account: acctPayload,
        positions: positionsMtM,
      });

      if (withTrades) {
        /** Same merge as WS hello + `/state`: full audit trail + exchange mem (no 400-line audit shrink). */
        let mergedTrades;
        if (strict && account == null) {
          mergedTrades = mergePersistedTradesWithExchange(runtimeTradingMode(), []);
        } else {
          const recentTrades = await exch.getTrades().catch(() => []);
          mergedTrades = mergePersistedTradesWithExchange(runtimeTradingMode(), recentTrades || []);
        }
        wsHub.broadcast("trades_snapshot", {
          replace: true,
          trades: mergedTrades,
          mode: runtimeTradingMode(),
        });
      }
    } catch {
      /* ignore */
    }
  }

  let _unsubExchangeAccountPush = null;
  let _udsUiPushTimer = null;
  function wireExchangeAccountPushListener() {
    if (_unsubExchangeAccountPush) {
      try {
        _unsubExchangeAccountPush();
      } catch {
        /* ignore */
      }
      _unsubExchangeAccountPush = null;
    }
    if (_destroyed || !exch || typeof exch.subscribeAccountPush !== "function") return;
    _unsubExchangeAccountPush = exch.subscribeAccountPush(() => {
      if (_destroyed || !wsHubRef?.broadcast) return;
      if (_udsUiPushTimer) clearTimeout(_udsUiPushTimer);
      _udsUiPushTimer = setTimeout(() => {
        _udsUiPushTimer = null;
        void pushImmediateState(wsHubRef, { withTrades: false });
      }, 100);
    });
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

    // Feed health (execution only — see `feedExecutionPause`): `../lib/binanceFeedHealth.js`
    // - Stale = no timely **inbound** kline socket activity and/or no **accepted** primary kline (post-sanity).
    // - Threshold = 2× chart interval (clamped), or `FEED_STALE_MS` override — not a random fixed 60s.
    // - Data-plane staleness triggers debounced `feed.requestReconnect()` (zombie open socket).
    const feedStatus = feed.getStatus ? feed.getStatus() : null;
    const inGrace =
      state.coinLastSwitchedAt && Date.now() - Number(state.coinLastSwitchedAt) < Number(state.feedGraceMsAfterSwitch || 0);

    const feedUseBinance = marketFeedUsesLiveBinance();
    const gate = feedUseBinance
      ? evaluateLiveBinanceFeedExecutionGate({
          now: Date.now(),
          timeframe: state.timeframe,
          inTradingGrace: Boolean(inGrace),
          combinedWsOk: feedStatus?.ok === true,
          lastKlineSocketInboundAt: feedStatus?.lastMsgAt,
          lastPrimaryAcceptedKlineAt: feedStatus?.lastPrimaryBufferPushAt,
          deltaWsOk: feedStatus?.delta?.ok,
          lastDeltaInboundAt: feedStatus?.delta?.lastMsgAt,
        })
      : null;

    const feedStaleMs = gate?.thresholdMs ?? 60_000;
    const feedAutoRestartOn =
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "0" &&
      String(process.env.FEED_AUTO_RESTART ?? "1").toLowerCase() !== "false";

    if (
      !state.running &&
      state.pendingAutoRestartAfterFeedStale &&
      feedAutoRestartOn &&
      feedUseBinance &&
      gate &&
      feedStatus?.ok === true &&
      feedRecoveredForAutoRestart({
        now: Date.now(),
        maxActivityRef: gate.maxActivityRef,
        thresholdMs: gate.thresholdMs,
      })
    ) {
      state.pendingAutoRestartAfterFeedStale = false;
      state.metrics.feedRecoveryRestarts += 1;
      start({
        wsHub,
        reason: "feed_recovery",
        source: "safety_tick",
        detail: {
          maxActivityRef: gate.maxActivityRef,
          thresholdMs: gate.thresholdMs,
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

    const shouldPauseExecution = Boolean(gate?.shouldPauseExecution);

    if (feedUseBinance && gate && shouldPauseExecution && gate.dataStale && !gate.wsUnhealthy && typeof feed.requestReconnect === "function") {
      feed.requestReconnect("binance_public_feed_stale");
    }

    if (shouldPauseExecution) {
      const reason = gate?.wsUnhealthy ? "feed_ws" : "feed_stale";
      const prev = state.feedExecutionPause;
      if (!prev || prev.reason !== reason) {
        state.feedExecutionPause = { reason, since: Date.now() };
        if (state.running) {
          emitActivity(wsHub, {
            level: "warn",
            msg:
              reason === "feed_ws"
                ? "Market WebSocket reconnecting — autotrade paused; chart still updates from candle buffer"
                : "Market data stale — autotrade paused until live ticks resume",
            category: "feed",
            reason,
            detail: {
              ...gate?.detail,
              klineLastMsgAt: feedStatus?.lastMsgAt ?? null,
              aggTradeLastMsgAt: feedStatus?.delta?.lastMsgAt ?? null,
              primaryBufferPushAt: feedStatus?.lastPrimaryBufferPushAt ?? null,
              primaryKlineExchangeEventMs: feedStatus?.lastPrimaryKlineExchangeEventMs ?? null,
              minActivityRef: gate?.minActivityRef ?? null,
              maxActivityRef: gate?.maxActivityRef ?? null,
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
          minActivityRef: gate?.minActivityRef ?? null,
          maxActivityRef: gate?.maxActivityRef ?? null,
          primaryKlineExchangeEventMs: feedStatus?.lastPrimaryKlineExchangeEventMs ?? null,
          thresholdMs: feedStaleMs,
          staleMs:
            gate?.stalenessRef != null
              ? Date.now() - gate.stalenessRef
              : gate?.minActivityRef != null
                ? Date.now() - gate.minActivityRef
                : null,
        });
      }
    } else if (state.feedExecutionPause) {
      const had = state.feedExecutionPause;
      state.feedExecutionPause = null;
      if (state.running && had) {
        emitActivity(wsHub, {
          level: "info",
          msg: "Market feed healthy — autotrade eligible again",
          category: "feed",
          reason: "feed_recovered",
        });
      }
    }

    if (!last) return;
    state.metrics.tickCount += 1;

    const indicators = computeIndicators(candles);
    const rawRegime = detectRegime({ candles, indicators });
    try {
      const symU = String(state.symbol || '').toUpperCase();
      if (symU && indicators?.adx != null) updateIntelligenceAdx(symU, indicators.adx);
    } catch { /* never block on intelligence */ }
    if (!state.regimeCandidate || state.regimeCandidate.type !== rawRegime.type) {
      state.regimeCandidate = { type: rawRegime.type, seen: 1 };
    } else {
      state.regimeCandidate.seen += 1;
    }
    const confirmed = state.regimeCandidate.seen >= Math.max(1, state.regimeConfirmCandles);
    const regime = confirmed ? rawRegime : { ...rawRegime, type: state.lastRegime?.type || rawRegime.type, pending: rawRegime.type };
    state.lastRegime = regime;

    /**
     * Chart `market` must be broadcast **before** `await exch.markToMarket` / trailing recovery. Live futures
     * `markToMarket` can block on signed REST or exchange latency; demo/paper often returns fast — that
     * mismatch looked like a “frozen” OHLC tail and could leave `tickInFlight` stuck if a tick hung.
     *
     * When `uiChartFocusSymbol` differs from the trading symbol, OHLC + ST follow the **focused** pair
     * (multiplex buffer) while strategy below still uses `candles` / `indicators` for `state.symbol`.
     *
     * Use the focus buffer as soon as it has **any** bars (REST backfill + WS). Requiring 30+ bars meant
     * `market` fell back to the bot’s primary symbol while the UI tab was another pair — `mergeMarketIntoState`
     * then ignored every tick → frozen “selected coin” chart on live multiplex.
     */
    const focusRaw =
      state.uiChartFocusSymbol != null && String(state.uiChartFocusSymbol).trim()
        ? String(state.uiChartFocusSymbol).trim().toUpperCase()
        : "";
    const primaryUForMarket = String(state.symbol || "").toUpperCase();
    const focusBuf =
      focusRaw &&
      focusRaw !== primaryUForMarket &&
      typeof feed.getCandlesForSymbol === "function" &&
      marketFeedUsesLiveBinance()
        ? feed.getCandlesForSymbol(focusRaw) || []
        : [];
    const useFocusMarket = Boolean(focusRaw && focusRaw !== primaryUForMarket && focusBuf.length > 0);
    const marketSymU = useFocusMarket ? focusRaw : primaryUForMarket;
    const candlesMarketSeries = useFocusMarket ? focusBuf : candles;
    const lastForMarket = useFocusMarket ? focusBuf[focusBuf.length - 1] : last;
    const indicatorsForMarket = useFocusMarket ? computeIndicators(candlesMarketSeries) : indicators;
    const regimeForMarket = useFocusMarket
      ? detectRegime({ candles: candlesMarketSeries, indicators: indicatorsForMarket })
      : regime;

    const chartCandlesPrimary24 = getChartCandles({ hours: 24 });
    const stModelPrimaryFast = computeSupertrendChartModel(chartCandlesPrimary24, {
      withChartArrays: false,
      symbol: state.symbol,
    });
    let stModelForMarket;
    if (!useFocusMarket) {
      stModelForMarket = stModelPrimaryFast;
    } else {
      const nWs = maxBarsForHistory(state.timeframe, 24);
      const windowed =
        candlesMarketSeries.length <= nWs ? candlesMarketSeries.slice() : candlesMarketSeries.slice(-nWs);
      const chartCandlesForWs = sanitizeCandlesForSt(windowed, marketSymU);
      stModelForMarket = computeSupertrendChartModel(chartCandlesForWs, {
        withChartArrays: false,
        symbol: marketSymU,
      });
    }
    if (!useFocusMarket && stModelPrimaryFast.lastRow) {
      state.supertrendLast = {
        ts: stModelPrimaryFast.lastRow.ts,
        up: stModelPrimaryFast.lastRow.up,
        dn: stModelPrimaryFast.lastRow.dn,
        trend: stModelPrimaryFast.lastRow.trend,
        line: stModelPrimaryFast.lastRow.line,
      };
    }
    try {
      state.decisionEngine = computeDecisionSnapshot({
        candles,
        indicatorsLatest: indicators.latest,
        supertrendLastRow: stModelPrimaryFast.lastRow,
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
      symbol: marketSymU,
      timeframe: state.timeframe,
      candle: lastForMarket,
      indicators: indicatorsForMarket.latest,
      regime: regimeForMarket,
      supertrend: useFocusMarket
        ? stModelForMarket.lastRow
          ? {
              ts: stModelForMarket.lastRow.ts,
              up: stModelForMarket.lastRow.up,
              dn: stModelForMarket.lastRow.dn,
              trend: stModelForMarket.lastRow.trend,
              line: stModelForMarket.lastRow.line,
            }
          : null
        : state.supertrendLast,
      supertrendLine: stModelForMarket.line,
      supertrendSignals: stModelForMarket.signals,
      feedExecutionPause: state.feedExecutionPause,
      originTradingMode: runtimeTradingMode(),
    });

    /**
     * After AUTO coin switch, skip **venue-sensitive** work until the kline socket has caught up — chart data
     * still advances from the in-memory buffer (market WS above). A full `return` before broadcast froze live.
     */
    const skipVenueSensitiveTick = Boolean(
      state.coinLastSwitchedAt &&
        inGrace &&
        feedStatus?.lastMsgAt &&
        Number(feedStatus.lastMsgAt) < Number(state.coinLastSwitchedAt),
    );

    if (!state.feedExecutionPause && !skipVenueSensitiveTick) {
      const extraTrailPcts = normalizeTrailingExtraPcts(state.trailingStopExtraScalpingPcts);
      const trailMode = normalizeFuturesTrailingStopMode(state.futuresTrailingStopMode);
      let supertrendTrailPx = null;
      if (state.trailingStopLossAuto && trailMode === "SUPERTREND") {
        try {
          const chartCandlesForTrail = sanitizeCandlesForSt(getChartCandles({ hours: 48 }), state.symbol);
          const stTrail = computeSupertrendChartModel(chartCandlesForTrail, {
            withChartArrays: false,
            symbol: state.symbol,
          });
          const symTrailU = String(state.symbol || "").toUpperCase();
          const ilPri = futuresSideIsLongCached(_cachedPositions, symTrailU);
          supertrendTrailPx = supertrendTrailPxPickFromStRow(stTrail.lastRow, ilPri);
        } catch {
          supertrendTrailPx = null;
        }
      }
      const trailSlip = clamp(Number(state.trailActivationSlippageFrac ?? process.env.FUTURES_TRAIL_ACTIVATION_SLIPPAGE_FRAC ?? 0), 0, 0.01);
      const trailT01LockSlip = clamp(
        Number(state.trailT01LockSlippageFrac ?? process.env.FUTURES_TRAIL_T01_LOCK_SLIPPAGE_FRAC ?? 0),
        0,
        0.01,
      );
      const trailBufAtrMult = clamp(Number(state.trailBufferAtrMult ?? process.env.FUTURES_TRAIL_BUFFER_ATR_MULT ?? 0), 0, 1);
      const trailBufMode = normalizeTrailBufferMode(state.trailBufferMode);
      const trailBuf = clamp(Number(state.trailBufferRate ?? process.env.SUPERTREND_TRAIL_BUFFER_RATE ?? 0.0015), 0, 0.05);
      const trailMm = clamp(Number(state.trailMaintMarginRate ?? process.env.SUPERTREND_TRAIL_MAINTENANCE_MARGIN_RATE ?? 0.005), 0, 0.1);
      const trailMinSlFrac = clamp(Number(state.trailMinSlDistFrac ?? process.env.SUPERTREND_TRAIL_MIN_SL_DISTANCE_FRAC ?? 0.002), 0, 0.1);
      const trailMinGapMarkFrac = clamp(
        Number(state.trailMinGapFromMarkFrac ?? process.env.SUPERTREND_TRAIL_MIN_GAP_FROM_MARK_FRAC ?? 0),
        0,
        0.2,
      );
      const trailFeeBeMultiplier = clamp(Number(state.trailFeeBeMultiplier ?? process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1.25), 1, 2);
      /** Per-symbol last ST line for USD-M trailing when multiple futures legs are open (not only `state.symbol`). */
      const supertrendBySymbol = {};
      if (state.trailingStopLossAuto && trailMode === "SUPERTREND" && Array.isArray(_cachedPositions)) {
        const trailSyms = [
          ...new Set(
            _cachedPositions
              .filter(
                (p) =>
                  String(p?.venue || "").toUpperCase() === "FUTURES" &&
                  p?.meta?.autoTradeTrailing === true &&
                  String(p?.symbol || "").trim(),
              )
              .map((p) => String(p.symbol).toUpperCase()),
          ),
        ];
        const primaryU = String(state.symbol || "").toUpperCase();
        const unresolved = [];
        for (const s of trailSyms) {
          if (s === primaryU) {
            if (supertrendTrailPx != null && Number.isFinite(supertrendTrailPx) && supertrendTrailPx > 0) {
              supertrendBySymbol[s] = supertrendTrailPx;
            }
            continue;
          }
          // Unified data path: prefer one-time live feed buffers over extra REST snapshots.
          let stV = null;
          try {
            if (typeof feed.getCandlesForSymbol === "function") {
              const buf = feed.getCandlesForSymbol(s) || [];
              if (Array.isArray(buf) && buf.length >= Math.max(20, Number(state.supertrendPeriod || 10) + 5)) {
                const c = sanitizeCandlesForSt(buf, s);
                const stM = computeSupertrendChartModel(c, { withChartArrays: false, symbol: s });
                const ilS = futuresSideIsLongCached(_cachedPositions, s);
                stV = supertrendTrailPxPickFromStRow(stM?.lastRow, ilS);
              }
            }
          } catch {
            stV = null;
          }
          if (stV != null && Number.isFinite(Number(stV)) && Number(stV) > 0) {
            supertrendBySymbol[s] = Number(stV);
          } else {
            unresolved.push(s);
          }
        }
        // Fallback for symbols missing feed buffers: resolve snapshots in parallel (not sequential).
        if (unresolved.length > 0) {
          const rows = await Promise.all(
            unresolved.map(async (s) => {
              try {
                const snap = await getChartSnapshotForSymbol(s, { hours: 48 });
                const rowS = snap?.supertrend;
                const ilS = futuresSideIsLongCached(_cachedPositions, s);
                const v = supertrendTrailPxPickFromStRow(rowS, ilS);
                return { s, v };
              } catch {
                return { s, v: null };
              }
            }),
          );
          for (const r of rows) {
            if (r.v != null && Number.isFinite(Number(r.v)) && Number(r.v) > 0) {
              supertrendBySymbol[r.s] = Number(r.v);
            }
          }
        }
        if (
          primaryU &&
          supertrendTrailPx != null &&
          Number.isFinite(supertrendTrailPx) &&
          supertrendTrailPx > 0 &&
          supertrendBySymbol[primaryU] == null
        ) {
          supertrendBySymbol[primaryU] = supertrendTrailPx;
        }
      }
      const postT02MaxExtraTiers = Math.max(
        10,
        Math.min(500, Math.floor(Number(state.trailPostT02MaxExtraTiers ?? 150))),
      );
      const trailingStopLoss = state.trailingStopLossAuto
        ? {
            enabled: true,
            mode: trailMode,
            /** Legacy single-rate fallback (closeFeeRate); newer callers use openFeeRate + closeFeeRate for round-trip. */
            feeRate: clamp(Number(state.trailCloseFeeRate ?? 0.0004), 0, 0.01),
            openFeeRate: clamp(Number(state.trailOpenFeeRate ?? 0.0004), 0, 0.01),
            closeFeeRate: clamp(Number(state.trailCloseFeeRate ?? 0.0004), 0, 0.01),
            feeBeMultiplier: trailFeeBeMultiplier,
            extraScalpingPcts: extraTrailPcts,
            maxTrailSteps: maxTrailStepsForConfig(extraTrailPcts, postT02MaxExtraTiers),
            trailPostT02SpacingFrac:
              state.trailPostT02SpacingFrac != null && Number.isFinite(Number(state.trailPostT02SpacingFrac))
                ? clamp(Number(state.trailPostT02SpacingFrac), 0.00001, 0.05)
                : null,
            trailPostT02MaxExtraTiers: postT02MaxExtraTiers,
            supertrendPx: supertrendTrailPx,
            supertrendBySymbol: Object.keys(supertrendBySymbol).length ? supertrendBySymbol : undefined,
            bufferRate: trailBuf,
            activationSlippageFrac: trailSlip,
            trailT01LockSlippageFrac: trailT01LockSlip,
            atrPct: state.lastRegime?.atrPct,
            trailBufferAtrMult: trailBufAtrMult,
            trailBufferMode: trailBufMode,
            /** Independent post-T02 (T1/T2/T3…) activation buffer. Null = inherit `bufferRate`. */
            postT02ActivationBufferRate:
              state.trailPostT02ActivationBufferRate != null &&
              Number.isFinite(Number(state.trailPostT02ActivationBufferRate))
                ? clamp(Number(state.trailPostT02ActivationBufferRate), 0, 0.05)
                : null,
            maintenanceMarginRate: trailMm,
            minSlDistanceFrac: trailMinSlFrac,
            minTrailGapFromMarkFrac: trailMinGapMarkFrac,
            supertrendUseFeeBreakeven: state.futuresTrailingStFeeBreakeven !== false,
            supertrendUseAdvancedTrail: state.futuresTrailingStAdvanced !== false,
          }
        : null;
      const onTrailingSlAdvance = (evt) => {
        _lastAccountFetchAt = 0;
        const prev = Number(evt.prevStopLoss);
        const next = Number(evt.newStopLoss);
        const ps = Number.isFinite(prev) ? prev.toFixed(6) : String(evt.prevStopLoss);
        const ns = Number.isFinite(next) ? next.toFixed(6) : String(evt.newStopLoss);
        const st =
          evt.supertrendPx != null && Number.isFinite(Number(evt.supertrendPx))
            ? Number(evt.supertrendPx).toFixed(6)
            : "—";
        const be =
          evt.breakeven != null && Number.isFinite(Number(evt.breakeven))
            ? Number(evt.breakeven).toFixed(6)
            : "—";
        const step = Number(evt.trailStep ?? 0);
        const maxS = Math.max(1, Number(evt.maxTrailSteps ?? 1));
        const tierLabel = evt.tierLabel != null ? String(evt.tierLabel) : null;
        const tierBit = tierLabel ? ` [${tierLabel}]` : ` (step ${step}/${maxS})`;
        const label = evt.kind === "fee_ladder_trailing_sl" ? "Fee-ladder trailing SL" : "Supertrend trailing SL";
        const src = evt.source != null ? String(evt.source) : "";
        const srcBit = src ? ` · ${src}` : "";
        const slChange =
          Number.isFinite(prev) && Number.isFinite(next)
            ? `SL trail ${tierLabel ?? ""}  ${prev.toFixed(6)} → ${next.toFixed(6)}`
            : `SL trail ${tierLabel ?? ""}  ${ps} → ${ns}`;
        const detail = {
          symbol: evt.symbol != null ? String(evt.symbol) : null,
          venue: evt.venue != null ? String(evt.venue) : "FUTURES",
          slChange,
          prevStopLoss: Number.isFinite(prev) ? prev : evt.prevStopLoss,
          newStopLoss: Number.isFinite(next) ? next : evt.newStopLoss,
          trailStep: step,
          tierLabel,
          maxTrailSteps: maxS,
          supertrendPx:
            evt.supertrendPx != null && Number.isFinite(Number(evt.supertrendPx)) ? Number(evt.supertrendPx) : null,
          breakeven: evt.breakeven != null && Number.isFinite(Number(evt.breakeven)) ? Number(evt.breakeven) : null,
          activationPrice:
            evt.activationPrice != null && Number.isFinite(Number(evt.activationPrice))
              ? Number(evt.activationPrice)
              : null,
          trailStatus: evt.trailStatus != null ? String(evt.trailStatus) : null,
          kind: evt.kind != null ? String(evt.kind) : null,
          trailingMode: evt.trailingMode != null ? String(evt.trailingMode) : null,
          isLong: evt.isLong === true ? true : evt.isLong === false ? false : null,
          entryPrice: evt.entryPrice != null && Number.isFinite(Number(evt.entryPrice)) ? Number(evt.entryPrice) : null,
          leverage: evt.leverage != null && Number.isFinite(Number(evt.leverage)) ? Number(evt.leverage) : null,
          source: src || null,
        };
        emitActivity(wsHub, {
          level: "info",
          msg: `${label} · ${evt.symbol} · ${slChange} · ST ${st} · fee BE ${be}${tierBit}${srcBit}`,
          category: "risk",
          reason: "trailing_sl_advance",
          symbol: evt.symbol,
          detail,
        });
      };
      const notifyActivity = (partial) =>
        emitActivity(wsHub, {
          category: "risk",
          level: partial.level || "info",
          ...partial,
        });

      // On first tick after startup, recover extremePx for open trailing positions
      // using historical candles so any price excursion during downtime is captured.
      if (state.trailingStopLossAuto && typeof exch.recoverTrailingExtremeFromCandles === "function") {
        const symU = String(state.symbol || "").toUpperCase();
        if (!_trailingRecoveryDoneSyms.has(symU)) {
          _trailingRecoveryDoneSyms.add(symU);
          const candlesBySymbol = {};
          if (candles.length) candlesBySymbol[symU] = candles;
          // Recover other symbols by reading their candles — use positions loaded from snapshot
          if (typeof feed.getCandlesForSymbol === "function") {
            try {
              // Use exch.getPositions() to access positions loaded from snapshot (not _cachedPositions which is empty on first tick)
              const snapPositions = typeof exch.getPositions === "function" ? await exch.getPositions() : [];
              for (const p of snapPositions) {
                const ps = String(p?.symbol || "").toUpperCase();
                if (ps && ps !== symU) {
                  const pbars = feed.getCandlesForSymbol(ps);
                  if (pbars?.length) candlesBySymbol[ps] = pbars;
                }
              }
            } catch {
              /* non-critical */
            }
          }
          try {
            exch.recoverTrailingExtremeFromCandles(candlesBySymbol);
            // Immediately run one poll cycle so the farthest crossed tier is applied at once,
            // without waiting for the next candle or the first poll interval to expire.
            if (trailingStopLoss?.enabled && typeof exch.runRealtimePollOnce === "function") {
              exch
                .runRealtimePollOnce({
                  trailingStopLoss,
                  onTrailingSlAdvance,
                  notifyActivity,
                  primaryChartSymU: String(state.symbol || "").toUpperCase(),
                })
                .catch(() => null);
            }
          } catch {
            /* non-critical */
          }
        }
      }

      await exch.markToMarket({
        symbol: state.symbol,
        price: last.close,
        trailingStopLoss,
        onTrailingSlAdvance,
        notifyActivity,
      });

      // Keep the real-time trailing poll config current every candle tick.
      // The poll runs between ticks so trailing fires immediately when activation is crossed,
      // not just when the next candle arrives.
      if (typeof exch.updateRealtimeTrailingConfig === "function") {
        exch.updateRealtimeTrailingConfig({
          trailingStopLoss,
          onTrailingSlAdvance,
          notifyActivity,
          primaryChartSymU: String(state.symbol || "").toUpperCase(),
        });
      }
      if (!_realtimeTrailingPollStarted && trailingStopLoss?.enabled && typeof exch.startRealtimeTrailingPoll === "function") {
        exch.startRealtimeTrailingPoll(1000);
        _realtimeTrailingPollStarted = true;
      }
    }

    let account = _cachedAccount;
    let positions = _cachedPositions;
    let accountError = null;
    const strictAcc = requiresStrictBinanceAccount();
    const nowMs = Date.now();
    if (nowMs - _lastAccountFetchAt >= effectiveAccountFetchIntervalMs() || !_cachedAccount) {
      try {
        account = await exch.getAccount();
        if (account == null) {
          positions = [];
          _cachedAccount = null;
          _cachedPositions = [];
          if (strictAcc && nowMs - _lastStrictAccountWarnAt > 60_000) {
            _lastStrictAccountWarnAt = nowMs;
            emitActivity(wsHub, {
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
              emitActivity(wsHub, {
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
            clampAllowedBudgetToFreeMargin();
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
          emitActivity(wsHub, {
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
            emitActivity(wsHub, {
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

    const pfTick = portfolioMtmForWs(last, candles, positions, account, accountError);
    const {
      positionsMtM,
      account: acctBroadcast,
      exceededDailyLoss,
      dailyPnlPct,
      dailyPnlPctByVenue,
    } = pfTick;

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
      broadcastRuntimeState(wsHub, {
        account: acctBroadcast,
        positions: positionsMtM,
      });
      return;
    }

    const mmUp = String(state.marketMode).toUpperCase();
    const manualBarCloseActive = manualStrategyBarCloseActive(state, mmUp);
    const barCloseOwnsTick = tickExecutionOwnedByBarClose(state, mmUp, {
      liveFeed: marketFeedUsesLiveBinance(),
    });

    const strategyKey = barCloseOwnsTick
      ? manualBarCloseActive
        ? manualStrategyKey(state)
        : "SUPERTREND"
      : state.strategyMode === "AUTO"
        ? pickStrategyAuto({ regime, indicators, stats: state.stats })
        : state.manualStrategy;

    const strat = strategies[strategyKey] || strategies.EMA_CROSS;
    let signal;
    if (barCloseOwnsTick) {
      signal = strategies.SUPERTREND.signal({ candles, indicators, regime });
    } else if (strategyKey === "SURF_PULSE_ML") {
      const fr = await getCachedFunding(state.symbol);
      signal = strat.signal({ candles, indicators, regime, surfPulse: { fundingRate: fr } });
      state.lastSurfPulseMl = null;
      if (signal.action !== "HOLD" && signal.features) {
        if (state.surfPulseMlGateEnabled !== false) {
          const surfTh = clamp(Number(state.surfPulseMlThreshold ?? 0.6), 0, 1);
          try {
            const sp = await ai.predictSurfPulse({ features: signal.features });
            const p = Number(sp.probability ?? 0);
            state.lastSurfPulseMl = { probability: p, threshold: surfTh, at: Date.now() };
            if (!Number.isFinite(p) || p < surfTh) {
              signal = {
                action: "HOLD",
                reason: "surfpulse_ml_below_threshold",
                features: signal.features,
              };
            }
          } catch (e) {
            const errMsg = formatAiServiceError(e);
            log.warn("surfpulse_ml_predict_failed", { symbol: state.symbol, error: errMsg });
            signal = { action: "HOLD", reason: "surfpulse_ml_predict_failed", features: signal.features };
          }
        }
      }
    } else if (
      strategyKey === "SR_INTRADAY" ||
      strategyKey === "INTRADAY_PRO" ||
      strategyKey === "SITUATION_INTRADAY" ||
      strategyKey === "CRT_TBS" ||
      strategyKey === "SCALP_MR" ||
      strategyKey === "TOKYO_SESSION"
    ) {
      const symKey = String(state.symbol || "")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase();
      const obSnap = intelligenceCache.orderBook?.[symKey] ?? null;
      const cfgWithBook = obSnap ? { ...state, orderBookSnapshot: obSnap } : state;
      signal = strat.signal({ candles, indicators, regime, cfg: cfgWithBook, timeframe: state.timeframe });
    } else {
      signal = strat.signal({ candles, indicators, regime });
    }

    state.lastDecision = { ts: new Date().toISOString(), strategyKey, signal };
    log.info("decision_made", {
      symbol: state.symbol,
      timeframe: state.timeframe,
      regime: regime?.type,
      pendingRegime: regime?.pending,
      strategyKey,
      action: signal?.action,
    });

    broadcastRuntimeState(wsHub, {
      account: acctBroadcast,
      positions: positionsMtM,
    });

    // After OHLC/state: demo futures `getTrades()` chains income + userTrade lookups and can take many
    // seconds — must not block `market` or the chart appears frozen while live (often faster) stays fine.
    await ingestClosedTrades({ wsHub });

    if (!state.running) return;

    if (state.feedExecutionPause) return;

    if (barCloseOwnsTick) {
      /** Bar-close (`processBarCloseTrading`) is the sole order engine for MANUAL adapter + ST autotrade. */
      return;
    }

    // --- Main /predict model (optional for SurfPulse ML — separate XGBoost on 8 features) ---
    const AI_PREDICT_INTERVAL_MS = 5_000;
    const aiLastCalledAt = state._aiLastCalledAt || 0;
    const tickNow = Date.now();
    let aiResp = null;
    let prob = 0;

    const aiMinCandles = Math.max(30, Number(process.env.AI_PREDICT_MIN_CANDLES || 30));
    let didPredict = false;
    const skipMainAiForSurf =
      strategyKey === "SURF_PULSE_ML" &&
      String(process.env.SURF_PULSE_ML_SKIP_MAIN_AI || "1").toLowerCase() !== "0";

    if (skipMainAiForSurf) {
      const sp = state.lastSurfPulseMl?.probability;
      prob = Number.isFinite(sp) ? aiGateProbability(sp, sp) : 0;
    } else if (tickNow - aiLastCalledAt >= AI_PREDICT_INTERVAL_MS) {
      if (candles.length < aiMinCandles) {
        // FastAPI /predict requires min 30 candles; WS-only feed may be sparse if REST backfill failed.
        state._aiLastCalledAt = tickNow;
        if (!state._predictWarmupLogged && candles.length >= 5) {
          state._predictWarmupLogged = true;
          emitActivity(wsHub, {
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
          aiResp = await withTimeout(
            ai.predict({ symbol: state.symbol, timeframe: state.timeframe, candles }),
            AI_PREDICT_TIMEOUT_MS,
          );
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
          if (String(errMsg).includes("timeout")) {
            emitActivity(wsHub, {
              level: AI_TIMEOUT_IS_HARD_FAIL ? "error" : "warn",
              msg: `AI predict timed out (${AI_PREDICT_TIMEOUT_MS}ms)${AI_TIMEOUT_IS_HARD_FAIL ? "; skipping trade" : "; using last AI if present"}`,
              category: "ai",
              reason: "predict_timeout",
              detail: { timeoutMs: AI_PREDICT_TIMEOUT_MS, symbol: state.symbol },
            });
            log.warn("ai_predict_timeout", { symbol: state.symbol, timeoutMs: AI_PREDICT_TIMEOUT_MS });
            if (AI_TIMEOUT_IS_HARD_FAIL) {
              noteTradeBlock({ reason: "ai_predict_timeout", detail: String(AI_PREDICT_TIMEOUT_MS), symbol: state.symbol });
              return;
            }
            // Soft timeout: fall through; the gate uses `state.lastAi` below.
          } else {
          emitActivity(wsHub, {
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
    }

    if (skipMainAiForSurf) {
      log.info("surfpulse_ml_gate_prob", {
        symbol: state.symbol,
        gateProbability: prob,
        strategySignal: signal.action,
        surf: state.lastSurfPulseMl,
      });
    } else if (didPredict && aiResp) {
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
    if (tradeAction === "SELL" && strategyKey !== "SURF_PULSE_ML") {
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
    const skipMainAiThresholdForSurf =
      strategyKey === "SURF_PULSE_ML" &&
      String(process.env.SURF_PULSE_ML_SKIP_MAIN_AI_GATE || "1").toLowerCase() !== "0";

    if (!skipMainAiThresholdForSurf && !isFixedUsdtCapitalMode() && prob < adaptiveThreshold) {
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
    // Institutional risk overlay (account DD / weekly / consecutive losses) — mirrors runner.js.
    {
      const { evaluateInstitutionalRiskOverlay } = await import("../risk/institutionalRiskOverlay.js");
      const equityNow = Number(state.equity ?? state.paperEquity ?? state.peakEquity ?? 0);
      const peak = Number(state.peakEquity ?? equityNow);
      const weekStart = Number(state.weekStartEquity ?? peak);
      const overlay = evaluateInstitutionalRiskOverlay({
        equity: equityNow,
        peakEquity: peak,
        weekStartEquity: weekStart,
        barDayMs: Math.floor(Date.now() / 86_400_000) * 86_400_000,
        trades: Array.isArray(state.recentClosedTrades) ? state.recentClosedTrades : [],
        cfg: state,
      });
      if (overlay.blocked) {
        noteTradeBlock({ reason: overlay.blocked, detail: overlay.detail, symbol: state.symbol, strategyKey });
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: overlay.blocked,
          probability: prob,
        });
        return;
      }
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

    const liqCfgStrategy = readLiquidityGuardConfig({
      maxSpreadBps: Number(process.env.TRADE_MAX_SPREAD_BPS || 0),
      minDepthUsd: Number(process.env.TRADE_MIN_DEPTH_NOTIONAL_USD || 0),
    });
    if ((liqCfgStrategy.maxSpreadBps > 0 || liqCfgStrategy.minDepthUsd > 0) && depth) {
      const book = depth.getBook();
      const estNotional =
        Number.isFinite(Number(last?.close)) && Number(last.close) > 0
          ? Number(last.close) * 100
          : 0;
      const guard = evaluateLiquidityGuards({
        book,
          side: tradeAction,
        referenceMid: Number(last?.close),
        orderNotionalUsd: estNotional,
        config: liqCfgStrategy,
      });
      if (guard.spreadBps != null) state.metrics.lastSpreadBps = guard.spreadBps;
      if (guard.depthNotionalUsd != null) state.metrics.lastDepthNotionalUsd = guard.depthNotionalUsd;
      if (!guard.ok) {
        noteTradeBlock({
          reason: guard.reason,
          spreadBps: guard.spreadBps,
          maxSpreadBps: guard.maxSpreadBps ?? liqCfgStrategy.maxSpreadBps,
          depthNotionalUsd: guard.depthNotionalUsd,
          minDepthUsd: guard.minDepthUsd ?? liqCfgStrategy.minDepthUsd,
          symbol: state.symbol,
          strategyKey,
        });
        emitSignalActionActivity(wsHub, {
          kind: "strategy",
          strategyKey,
          venue: stratVenue,
          side: tradeAction,
          action: "skipped",
          reason: guard.reason === "spread_too_wide" ? `spread_too_wide_${guard.spreadBps?.toFixed(1)}bps` : guard.reason,
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
    const rpTick = resolveFixedUsdtRiskForOrder(state.symbol, positions);
    const allotLaneTick = resolveCapitalAllotmentMarginLaneForOrder(state.symbol, positions);
    const perCoinMarginCapTickRaw = Number(allotLaneTick.riskPerTrade);
    const perCoinMarginCapTick =
      Number.isFinite(perCoinMarginCapTickRaw) ? Math.max(0, perCoinMarginCapTickRaw) : null;
    const _pctCapTick = pctPolicyCapForRiskPlan();
    if (isFuturesVenue && perCoinMarginCapTick != null && perCoinMarginCapTick <= 0) {
      noteTradeBlock({ reason: "capital_cap_exhausted", symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "capital_cap_exhausted",
        probability: prob,
      });
      return;
    }
    wsHub?.broadcast?.("log", {
      level: "info",
      msg: `Sizing · ${state.symbol} · unit=${String(state.riskPerTradeUnit || "PCT").toUpperCase()} riskPerTrade=${Number(rpTick.riskPerTrade).toFixed(2)} perCoinMarginCap=${perCoinMarginCapTick != null ? perCoinMarginCapTick.toFixed(2) : "—"} splitDiv=${Math.max(1, Math.floor(Number(rpTick.fixedUsdtSplitDivisor) || 1))} pctCap=${_pctCapTick != null ? Number(_pctCapTick).toFixed(2) : "—"} lev=${futuresLeverage ?? "—"} allowedPool=${Number(state.allowedBudgetUsdt || 0).toFixed(2)} splitMode=${derivedMultiBudgetSplitMode()}`,
      symbol: state.symbol,
      category: "capital",
    });
    const plan = await riskPlan({
      exchange: venueEx,
      side: tradeAction,
      entryPrice: last.close,
      confidence: prob,
      riskPerTrade: rpTick.riskPerTrade,
      riskPerTradeUnit: state.riskPerTradeUnit,
      fixedUsdtCapitalSizing: isFixedUsdtCapitalMode(),
      fixedUsdtSplitDivisor: rpTick.fixedUsdtSplitDivisor,
      pctPolicyCapUsdt: _pctCapTick,
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

    let liqLegs = null;

    /** MANUAL signal paths: fib structure brackets or fixed SL/TP % (backtest parity). */
    if (
      isFuturesVenue &&
      String(state.strategyMode || "").toUpperCase() === "MANUAL" &&
      !barCloseOwnsTick
    ) {
      const fibBr = signal?.fibBrackets?.slPct > 0
        ? resolveFibEntryBrackets(state, signal, last.close, tradeAction)
        : null;
      const liqBr =
        !fibBr && signal?.liqBrackets?.slPct > 0
          ? resolveLiquidityEntryBrackets(state, signal, last.close, tradeAction)
          : null;
      const structBr = fibBr || liqBr;
      liqLegs = liqBr ? mapLiquidityEntryLegs(liqBr, state) : null;
      if (structBr?.slPrice > 0 && state.supertrendFuturesUseFixedSl !== false) {
        plan.stopLoss = structBr.slPrice;
        if (liqLegs?.tp > 0) {
          plan.takeProfit = liqLegs.tp;
        }
        if (liqLegs?.partialTp && liqLegs.tp1 > 0) {
          plan.takeProfitPartial = liqLegs.tp1;
          plan.takeProfitPartialFrac = liqLegs.partialFrac ?? 0.5;
        }
        if (!plan.takeProfit && structBr.tpPrice > 0 && state.supertrendFuturesUseFixedTp !== false) {
          plan.takeProfit = structBr.tp2Price ?? structBr.tpPrice;
        }
        const perUnitRisk = Math.abs(last.close - plan.stopLoss);
        const riskUsd = Number(plan.riskUsd);
        if (perUnitRisk > 0 && riskUsd > 0) {
          plan.qty = roundTo(riskUsd / perUnitRisk, 6);
        }
      } else if (structBr && state.supertrendFuturesUseFixedSl !== false) {
        Object.assign(
          plan,
          applyFixedPctBracket(plan, {
            entryPrice: last.close,
            side: tradeAction,
            slPct: structBr.slPct,
            tpPct: state.supertrendFuturesUseFixedTp !== false ? structBr.tpPct : 0,
            futuresLeverage,
          }),
        );
      } else {
        const useSl = state.supertrendFuturesUseFixedSl !== false;
        const useTp = state.supertrendFuturesUseFixedTp !== false;
        const slPct = useSl ? clamp(Number(state.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2) : 0;
        const tpPct = useTp ? clamp(Number(state.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5) : 0;
        if (slPct > 0) {
          Object.assign(
            plan,
            applyFixedPctBracket(plan, {
              entryPrice: last.close,
              side: tradeAction,
              slPct,
              tpPct,
              futuresLeverage,
            }),
          );
        } else {
          plan.stopLoss = null;
          plan.takeProfit = useTp && tpPct > 0 ? (tradeAction === "BUY" ? last.close * (1 + tpPct) : last.close * (1 - tpPct)) : null;
        }
      }
      const riskUsdManual = Number(plan.riskUsd);
      if (riskUsdManual > 0) {
        const sizingSl = resolveSizingStopPrice({
          entryFill: last.close,
          exitSl: plan.stopLoss ?? structBr?.slPrice ?? 0,
          side: tradeAction,
          cfg: state,
        });
        const perUnitRisk = Math.abs(last.close - sizingSl);
        if (perUnitRisk > 0) {
          plan.qty = roundTo(riskUsdManual / perUnitRisk, 6);
        }
      }
    }

    const trailMmStrat = clamp(Number(state.trailMaintMarginRate ?? process.env.SUPERTREND_TRAIL_MAINTENANCE_MARGIN_RATE ?? 0.005), 0, 0.1);
    if (
      isFuturesVenue &&
      state.trailingStopLossAuto &&
      futuresLeverage != null &&
      entryRejectedLiquidationBreakeven({
        entryPrice: last.close,
        isLong: tradeAction === "BUY",
        leverage: futuresLeverage,
        feeRate: tradeCloseFeeRate(),
        maintenanceMarginRate: trailMmStrat,
      })
    ) {
      noteTradeBlock({
        reason: "liquidation_breakeven_reject",
        symbol: state.symbol,
        strategyKey,
        detail: { leverage: futuresLeverage },
      });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "liquidation_breakeven_reject",
        probability: prob,
      });
      emitActivity(wsHub, {
        level: "warn",
        msg: `Open skipped · ${state.symbol} · liquidation/breakeven geometry (Supertrend trailing) at ${futuresLeverage}x`,
        category: "risk",
        reason: "liquidation_breakeven_reject",
        symbol: state.symbol,
        detail: { leverage: futuresLeverage, strategyKey },
      });
      return;
    }

    /**
     * HARD CAP (ticker path): per-coin margin cap guard.
     * riskPlan Fix C2 already caps tierMult, but defensively enforce here too.
     */
    let finalQtyTick = plan.qty;
    if (isFuturesVenue && futuresLeverage != null) {
      const cqTick = clampQtyToPerCoinMarginCap({
        symbol: state.symbol,
        qty: finalQtyTick,
        entryPx: Number(last.close),
        leverage: futuresLeverage,
        positions,
        wsHub,
        context: "ticker_open",
      });
      finalQtyTick = cqTick.qty;
    }
    if (isFuturesVenue && futuresLeverage != null && Number.isFinite(finalQtyTick) && finalQtyTick > 0) {
      const posNow = await exch.getPositions().catch(() => positions);
      const cqTickLive = clampQtyToPerCoinMarginCap({
        symbol: state.symbol,
        qty: finalQtyTick,
        entryPx: Number(last.close),
        leverage: futuresLeverage,
        positions: Array.isArray(posNow) ? posNow : positions,
        wsHub,
        context: "ticker_open_live",
      });
      finalQtyTick = cqTickLive.qty;
    }
    if (!Number.isFinite(finalQtyTick) || finalQtyTick <= 0) {
      noteTradeBlock({ reason: "capital_cap_exhausted", symbol: state.symbol, strategyKey });
      emitSignalActionActivity(wsHub, {
        kind: "strategy",
        strategyKey,
        venue: stratVenue,
        side: tradeAction,
        action: "skipped",
        reason: "capital_cap_exhausted",
        probability: prob,
      });
      return;
    }

    let order;
    const orderStartMs = Date.now();
    try {
      order = await placeOrderWithWalletTelemetry(venueEx, () =>
        venueEx.placeOrder({
          symbol: state.symbol,
          side: tradeAction,
          qty: finalQtyTick,
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
            autoTradeTrailing: isFuturesVenue && Boolean(state.trailingStopLossAuto),
            takeProfitPartial: plan.takeProfitPartial,
            takeProfitPartialFrac: plan.takeProfitPartialFrac,
            liqPartialTp: plan.takeProfitPartial != null,
            liqTp2Enabled: state.intradayLiqTp2Enabled !== false,
            liqBreakevenAfterPartial: state.intradayLiqBreakevenAfterPartial !== false,
            liqBeAt1R: liqLegs?.beAt1R === true,
            liqBeTriggerPx: liqLegs?.beTriggerPx > 0 ? liqLegs.beTriggerPx : undefined,
          },
        }),
      );
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
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
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

    const entryExOidStrategy = binanceFuturesEntryOrderIdFromPlaceOrder(order);
    broadcastTrade(wsHub, {
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
      ...(isFuturesVenue && entryExOidStrategy
        ? { meta: { orderId: entryExOidStrategy, venue: "FUTURES" } }
        : {}),
    });
    if (isFuturesVenue && order.immediateCloseTrade && typeof order.immediateCloseTrade === "object") {
      broadcastTrade(wsHub, {
        ...order.immediateCloseTrade,
        strategyKey,
        strategy: strategyKey,
        source: "STRATEGY",
      });
      emitActivity(wsHub, {
        level: "warn",
        category: "risk",
        reason: "immediate_flat_after_open",
        symbol: state.symbol,
        msg: `${state.symbol} · futures leg went flat within ~${postOpenStableProbeMs()}ms of open — paired CLOSE emitted.`,
      });
    }
    if (isFuturesVenue && (plan.stopLoss != null || plan.takeProfit != null)) {
      const slN = Number(plan.stopLoss);
      const tpN = Number(plan.takeProfit);
      emitActivity(wsHub, {
        level: "info",
        msg: `SL/TP armed · ${state.symbol} · SL ${Number.isFinite(slN) ? slN.toFixed(4) : "—"} · TP ${Number.isFinite(tpN) ? tpN.toFixed(4) : "—"} · ${strategyKey}`,
        category: "risk",
        reason: "sl_tp_armed",
        symbol: state.symbol,
        detail: {
          stopLoss: plan.stopLoss,
          takeProfit: plan.takeProfit,
          strategyKey,
          trailingAuto: Boolean(state.trailingStopLossAuto),
        },
      });
    }

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
    state.paused = false;
    state.running = true;
    // Reset poll flag so it gets restarted fresh on first tick
    _realtimeTrailingPollStarted = false;
    state.pendingAutoRestartAfterFeedStale = false;
    if (state.universePinnedSymbol || (state.universePinnedSymbols && state.universePinnedSymbols.length)) {
      state.universePinnedSymbol = null;
      state.universePinnedSymbols = [];
      emitActivity(wsHub, {
        level: "info",
        msg: "Universe pin cleared (bot started)",
        category: "universe",
        reason: "pin_cleared_on_start",
      });
    }
    emitActivity(wsHub, {
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
    const effKind = effectiveMarketFeedKind();
    if ((state.supertrendSpotAuto || state.supertrendFuturesAuto) && feedSrc === "SYNTH") {
      emitActivity(wsHub, {
        level: "warn",
        msg:
          runtimeTradingMode() === "PAPER"
            ? "Supertrend autotrade is ON but the candle feed is SYNTH — set PAPER_MARKET_FEED=BINANCE or BINANCE_FUTURES (or set MARKET_FEED globally), or keep MARKET_FEED=BINANCE / BINANCE_FUTURES for paper to inherit."
            : "Supertrend autotrade is ON but MARKET_FEED is SYNTH — no Binance kline close (k.x) events fire; set MARKET_FEED=BINANCE or BINANCE_FUTURES in backend .env and restart.",
        category: "feed",
        reason: "supertrend_requires_live_feed",
        detail: {
          feedSource: feedSrc,
          marketFeed: process.env.MARKET_FEED || "SYNTH",
          effectiveMarketFeedKind: effKind,
        },
      });
    }
    try {
      const candlesRun = feed.getCandles();
      const lastRun = candlesRun.length ? candlesRun[candlesRun.length - 1] : null;
      const pfRun = portfolioMtmForWs(lastRun, candlesRun, _cachedPositions, _cachedAccount, null);
      wsHub?.broadcast?.("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: pfRun.account,
        positions: pfRun.positionsMtM,
      });
    } catch {
      /* ignore */
    }
    syncFeedWatchSymbols();
  }

  function stop({ wsHub, reason = "user_request", source = "api", detail } = {}) {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    // Stop real-time trailing poll when the bot stops
    if (_realtimeTrailingPollStarted && typeof exch?.stopRealtimeTrailingPoll === "function") {
      exch.stopRealtimeTrailingPoll();
      _realtimeTrailingPollStarted = false;
    }
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
    emitActivity(wsHub, {
      level,
      msg: activityStopMsg(reason),
      category: "bot_lifecycle",
      reason: r,
      source: String(source),
      detail: det,
    });
    try {
      const candlesStop = feed.getCandles();
      const lastStop = candlesStop.length ? candlesStop[candlesStop.length - 1] : null;
      const pfStop = portfolioMtmForWs(lastStop, candlesStop, _cachedPositions, _cachedAccount, null);
      wsHub?.broadcast?.("state", {
        mode: runtimeTradingMode(),
        ...getPublicState(),
        account: pfStop.account,
        positions: pfStop.positionsMtM,
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
    emitActivity(wsHub, {
      level: "warn",
      msg: "Daily loss baseline reset — counter re-anchored to current wallet equity; bot resuming",
      category: "bot_lifecycle",
      reason: "daily_loss_baseline_reset",
      source: String(source),
      detail: { symbol: state.symbol },
    });
    start({ wsHub, reason: "daily_loss_reset_resume", source });
  }

  function scheduleDeferredChartFocusWork(focusSym) {
    if (!wsHubRef) return;
    const hub = wsHubRef;
    setImmediate(() => {
      void (async () => {
        try {
          const primaryU = String(state.symbol || "").trim().toUpperCase();
          const focusU =
            focusSym != null && String(focusSym).trim()
              ? String(focusSym).trim().toUpperCase()
              : "";
          if (focusU && focusU !== primaryU) {
            try {
              noteUiChartWatchSymbol(focusU);
            } catch {
              /* ignore */
            }
            const minBars = Math.max(30, state.supertrendPeriod + 2);
            const buf =
              typeof feed.getCandlesForSymbol === "function" ? feed.getCandlesForSymbol(focusU) : [];
            const hasLiveBuf = Array.isArray(buf) && buf.length >= minBars;
            if (!hasLiveBuf) {
              if (typeof feed.prioritizeWatchSymbol === "function") {
                await feed.prioritizeWatchSymbol(focusU);
              } else {
                await getChartSnapshotForSymbol(focusU, { hours: 24 });
              }
            }
          }
          await tick({ wsHub: hub });
        } catch (e) {
          log.warn("chart_focus_flush_failed", {
            error: String(e?.message || e),
            symbol: focusSym,
          });
        }
      })();
    });
  }

  /** Fast path for multi-coin chart tab switches — depth sync only; feed/tick deferred. */
  function updateChartFocus(rawF) {
    const prevFocusU =
      state.uiChartFocusSymbol != null && String(state.uiChartFocusSymbol).trim()
        ? String(state.uiChartFocusSymbol).trim().toUpperCase()
        : "";
      if (rawF == null || rawF === "") {
        state.uiChartFocusSymbol = null;
      } else {
        const u = String(rawF).trim().toUpperCase();
        state.uiChartFocusSymbol = SYM_RE.test(u) ? u : null;
      }
    const focusU = state.uiChartFocusSymbol ? String(state.uiChartFocusSymbol).trim().toUpperCase() : "";
    const primaryU = String(state.symbol || "").trim().toUpperCase();
    const focusChanged = focusU !== prevFocusU;
    if (focusChanged) {
      if (depth && marketFeedUsesLiveBinance()) {
        try {
          const depthSymU = focusU || primaryU;
          if (depthSymU) depth.setSymbol(depthSymU);
        } catch {
          /* ignore */
        }
      }
      scheduleDeferredChartFocusWork(state.uiChartFocusSymbol);
    }
    return {
      uiChartFocusSymbol:
        state.uiChartFocusSymbol != null ? String(state.uiChartFocusSymbol).toUpperCase() : null,
    };
  }

  function updateConfig(patch, opts = {}) {
    const fromPersisted = opts.fromPersisted === true;
    let capitalCycleResetNeeded = false;
    let deferredChartFocusTick = false;
    if (patch.uiChartFocusSymbol !== undefined) {
      const prevFocusU =
        state.uiChartFocusSymbol != null && String(state.uiChartFocusSymbol).trim()
          ? String(state.uiChartFocusSymbol).trim().toUpperCase()
          : "";
      const rawF = patch.uiChartFocusSymbol;
      if (rawF == null || rawF === "") {
        state.uiChartFocusSymbol = null;
      } else {
        const u = String(rawF).trim().toUpperCase();
        state.uiChartFocusSymbol = SYM_RE.test(u) ? u : null;
      }
      const focusU = state.uiChartFocusSymbol ? String(state.uiChartFocusSymbol).trim().toUpperCase() : "";
      const primaryU = String(state.symbol || "").trim().toUpperCase();
      const focusChanged = focusU !== prevFocusU;
      if (focusChanged && !fromPersisted) {
      /** Order book WS stayed on `state.symbol` while `market` followed `uiChartFocusSymbol` → UI hid all rows as “mismatch”. */
      if (depth && marketFeedUsesLiveBinance()) {
        try {
          const depthSymU =
            state.uiChartFocusSymbol && String(state.uiChartFocusSymbol).trim()
              ? String(state.uiChartFocusSymbol).trim().toUpperCase()
              : String(state.symbol || "").trim().toUpperCase();
          if (depthSymU) depth.setSymbol(depthSymU);
          } catch {
            /* ignore */
          }
        }
        deferredChartFocusTick = true;
      } else if (!fromPersisted && depth && marketFeedUsesLiveBinance() && focusU) {
        /** Re-assert depth when duplicate focus patches arrive but book drifted back to primary. */
        try {
          const cur = String(depth.getBook?.()?.symbol || "").trim().toUpperCase();
          if (cur && cur !== focusU) depth.setSymbol(focusU);
        } catch {
          /* ignore */
        }
      }
    }
    if (patch.symbol) {
      state.symbol = patch.symbol;
      if (!fromPersisted) {
      state.coinLastSwitchedAt = Date.now();
        feed?.setSymbol?.(patch.symbol);
      state.feedExecutionPause = null;
      state.supertrendStHandledCloseKey = null;
      state.supertrendLastBarClose = null;
      state.supertrendLastFlipBarClose = null;
      state.supertrendSignalHistory = [];
      state.pendingSupertrendAction = null;
      state.pendingSupertrendBreakout = null;
      state._pendingSupertrendFlushOnNextTick = false;
      state.pendingAutoRestartAfterFeedStale = false;
      try {
        depth?.setSymbol?.(patch.symbol);
      } catch {
        // ignore
        }
      }
    }
    if (patch.symbolMode) {
      const v = String(patch.symbolMode).toUpperCase();
      if (v === "SINGLE" || v === "AUTO") state.symbolMode = v;
      if (v === "SINGLE" && (state.universePinnedSymbol || state.universePinnedSymbols?.length)) {
        state.universePinnedSymbol = null;
        state.universePinnedSymbols = [];
      }
    }
    if (patch.universeCoinBase === "ALL" || patch.universeCoinBase === "CUSTOM") {
      state.universeCoinBase = patch.universeCoinBase;
      state.universe = null;
      capitalCycleResetNeeded = true;
    }
    if (patch.universePinControl === "AUTO" || patch.universePinControl === "MANUAL") {
      state.universePinControl = patch.universePinControl;
      capitalCycleResetNeeded = true;
    }
    if (patch.universeAutoCoinPick === "RANKED_AI_SS" || patch.universeAutoCoinPick === "ST_SIGNAL_FIRST") {
      state.universeAutoCoinPick = patch.universeAutoCoinPick;
    }
    if (patch.universeCoinSelectMode === "SINGLE" || patch.universeCoinSelectMode === "MULTIPLE") {
      state.universeCoinSelectMode = patch.universeCoinSelectMode;
      capitalCycleResetNeeded = true;
      if (patch.universeCoinSelectMode === "SINGLE") {
        state.uiChartFocusSymbol = null;
        if (state.universePinnedSymbols?.length > 1) {
          state.universePinnedSymbols = state.universePinnedSymbols.slice(0, 1);
        }
        state.universePinnedSymbol = state.universePinnedSymbols?.[0] ?? null;
        try {
          depth?.setSymbol?.(String(state.symbol || "").trim().toUpperCase() || state.symbol);
        } catch {
          /* ignore */
        }
      } else {
        state.universePinnedSymbol = null;
      }
    }
    if (patch.universeCustomSymbols !== undefined) {
      state.universeCustomSymbols = Array.isArray(patch.universeCustomSymbols)
        ? [...new Set(patch.universeCustomSymbols.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10)
        : [];
      state.universe = null;
      capitalCycleResetNeeded = true;
    }
    if (patch.universePinnedSymbols !== undefined && Array.isArray(patch.universePinnedSymbols)) {
      let arr = [...new Set(patch.universePinnedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10);
      if (state.universeCoinSelectMode !== "MULTIPLE") {
        arr = arr.slice(0, 1);
      }
      state.universePinnedSymbols = arr;
      capitalCycleResetNeeded = true;
      state.universePinnedSymbol = state.universeCoinSelectMode === "MULTIPLE" ? null : arr[0] ?? null;
      if (state.universePinnedSymbol) {
        state.symbolMode = "AUTO";
        state.symbol = state.universePinnedSymbol;
        if (!fromPersisted) {
        state.coinLastSwitchedAt = Date.now();
          feed?.setSymbol?.(state.universePinnedSymbol);
        state.feedExecutionPause = null;
        state.supertrendStHandledCloseKey = null;
        state.supertrendLastBarClose = null;
        state.supertrendLastFlipBarClose = null;
        state.supertrendSignalHistory = [];
        state.pendingSupertrendAction = null;
        state.pendingSupertrendBreakout = null;
        state._pendingSupertrendFlushOnNextTick = false;
        state.pendingAutoRestartAfterFeedStale = false;
        try {
          depth?.setSymbol?.(state.universePinnedSymbol);
        } catch {
          // ignore
          }
        }
      }
    }
    if (patch.universePinnedSymbol !== undefined) {
      capitalCycleResetNeeded = true;
      const raw = patch.universePinnedSymbol;
      if (raw == null || raw === "") {
        state.universePinnedSymbol = null;
        state.universePinnedSymbols = [];
      } else if (state.universeCoinSelectMode !== "MULTIPLE") {
        const up = String(raw).toUpperCase();
        if (SYM_RE.test(up)) {
          state.universePinnedSymbol = up;
          state.universePinnedSymbols = [up];
          state.symbolMode = "AUTO";
          state.symbol = up;
          if (!fromPersisted) {
          state.coinLastSwitchedAt = Date.now();
            feed?.setSymbol?.(up);
          state.feedExecutionPause = null;
          state.supertrendStHandledCloseKey = null;
          state.supertrendLastBarClose = null;
          state.supertrendLastFlipBarClose = null;
          state.supertrendSignalHistory = [];
          state.pendingSupertrendAction = null;
          state.pendingSupertrendBreakout = null;
          state._pendingSupertrendFlushOnNextTick = false;
          state.pendingAutoRestartAfterFeedStale = false;
          try {
            depth?.setSymbol?.(up);
          } catch {
            // ignore
            }
          }
        }
      }
    }
    if (patch.timeframe) {
      state.timeframe = patch.timeframe;
      if (!fromPersisted) {
        feed?.setTimeframe?.(patch.timeframe);
      state.feedExecutionPause = null;
      state.supertrendStHandledCloseKey = null;
      state.supertrendLastBarClose = null;
      state.supertrendLastFlipBarClose = null;
      state.supertrendSignalHistory = [];
      state.pendingSupertrendAction = null;
      state.pendingSupertrendBreakout = null;
      state._pendingSupertrendFlushOnNextTick = false;
      state.pendingAutoRestartAfterFeedStale = false;
      }
    }
    if (patch.aiThreshold != null) state.aiThreshold = clamp(Number(patch.aiThreshold), 0, 1);
    if (patch.riskPerTradeUnit === "PCT" || patch.riskPerTradeUnit === "USDT") {
      state.riskPerTradeUnit = patch.riskPerTradeUnit;
      capitalCycleResetNeeded = true;
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
    if (patch.multiBudgetSplitMode != null) {
      const v = String(patch.multiBudgetSplitMode).toUpperCase();
      if (v === "FULL" || v === "EQUAL" || v === "CUSTOM_USDT" || v === "CUSTOM_PCT_ALLOWED") {
        state.multiBudgetSplitMode = v;
        state.capitalSplitAcrossCoins = v === "EQUAL";
        // Split mode alone does not imply multi-coin pool — UI / explicit `multiCoinCapitalSizingActive` controls that.
        capitalCycleResetNeeded = true;
      }
    }
    if (patch.perTradeBudgetInputMode === "USDT" || patch.perTradeBudgetInputMode === "PCT_OF_USABLE") {
      state.perTradeBudgetInputMode = patch.perTradeBudgetInputMode;
    }
    if (patch.multiCoinCapitalSizingActive != null) {
      state.multiCoinCapitalSizingActive = Boolean(patch.multiCoinCapitalSizingActive);
      capitalCycleResetNeeded = true;
    }
    if (patch.capitalSplitAcrossCoins != null) {
      state.capitalSplitAcrossCoins = Boolean(patch.capitalSplitAcrossCoins);
      if (patch.multiBudgetSplitMode == null) {
        state.multiBudgetSplitMode = state.capitalSplitAcrossCoins ? "EQUAL" : "FULL";
      }
      capitalCycleResetNeeded = true;
    }
    if (patch.allowedBudgetUsdt != null && Number.isFinite(Number(patch.allowedBudgetUsdt))) {
      const nextAb = clamp(Number(patch.allowedBudgetUsdt), 0, 10_000_000);
      if (nextAb !== Number(state.allowedBudgetUsdt)) state.allowedBudgetPnlAnchorMs = Date.now();
      state.allowedBudgetUsdt = nextAb;
      capitalCycleResetNeeded = true;
    }
    if (patch.allowedBudgetWalletPct != null && Number.isFinite(Number(patch.allowedBudgetWalletPct))) {
      const nextW = clamp(Number(patch.allowedBudgetWalletPct), 0, 100);
      if (nextW !== Number(state.allowedBudgetWalletPct)) state.allowedBudgetPnlAnchorMs = Date.now();
      state.allowedBudgetWalletPct = nextW;
    }
    if (patch.allowedBudgetInputMode === "USDT" || patch.allowedBudgetInputMode === "WALLET_PCT") {
      if (patch.allowedBudgetInputMode !== state.allowedBudgetInputMode) state.allowedBudgetPnlAnchorMs = Date.now();
      state.allowedBudgetInputMode = patch.allowedBudgetInputMode;
      capitalCycleResetNeeded = true;
    }
    if (patch.multiTradeUsePctOfUsable != null) state.multiTradeUsePctOfUsable = Boolean(patch.multiTradeUsePctOfUsable);
    if (patch.multiTradePctOfUsable != null && Number.isFinite(Number(patch.multiTradePctOfUsable))) {
      state.multiTradePctOfUsable = clamp(Number(patch.multiTradePctOfUsable), 0, 100);
      capitalCycleResetNeeded = true;
    }
    if (patch.capitalAllotmentCompoundPnlUi != null) state.capitalAllotmentCompoundPnlUi = Boolean(patch.capitalAllotmentCompoundPnlUi);
    if (patch.perTradeBudgetCapEnabled != null) state.perTradeBudgetCapEnabled = Boolean(patch.perTradeBudgetCapEnabled);
    if (patch.multiBudgetCoinUsdt != null && typeof patch.multiBudgetCoinUsdt === "object") {
      state.multiBudgetCoinUsdt = { ...state.multiBudgetCoinUsdt, ...patch.multiBudgetCoinUsdt };
      capitalCycleResetNeeded = true;
    }
    if (patch.multiBudgetCoinPct != null && typeof patch.multiBudgetCoinPct === "object") {
      state.multiBudgetCoinPct = { ...state.multiBudgetCoinPct, ...patch.multiBudgetCoinPct };
      capitalCycleResetNeeded = true;
    }
    normalizeRiskLimits(state);
    normalizeCapitalBudgetFields(state, SYM_RE);
    if (patch.strategyMode) state.strategyMode = patch.strategyMode;
    if (patch.manualStrategy) {
      state.manualStrategy = patch.manualStrategy;
      if (String(patch.manualStrategy).toUpperCase() === "SUPERTREND_ELITE") {
        for (const [k, v] of Object.entries(ELITE_ST_ACTIVATION_PATCH)) {
          if (patch[k] === undefined) state[k] = v;
        }
      }
    }
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
    if (patch.supertrendMoveQualityGate != null) state.supertrendMoveQualityGate = Boolean(patch.supertrendMoveQualityGate);
    if (patch.supertrendMoveQualityMinScore != null && Number.isFinite(Number(patch.supertrendMoveQualityMinScore))) {
      state.supertrendMoveQualityMinScore = clamp(Number(patch.supertrendMoveQualityMinScore), 0, 1);
    }
    if (patch.supertrendMoveQualityMinAdx != null && Number.isFinite(Number(patch.supertrendMoveQualityMinAdx))) {
      state.supertrendMoveQualityMinAdx = clamp(Math.round(Number(patch.supertrendMoveQualityMinAdx)), 0, 100);
    }
    if (patch.supertrendMoveQualityMinMoveSlRatio != null && Number.isFinite(Number(patch.supertrendMoveQualityMinMoveSlRatio))) {
      state.supertrendMoveQualityMinMoveSlRatio = Math.max(1, Number(patch.supertrendMoveQualityMinMoveSlRatio));
    }
    if (patch.supertrendMoveQualityExpectedMoveAtrMult != null && Number.isFinite(Number(patch.supertrendMoveQualityExpectedMoveAtrMult))) {
      state.supertrendMoveQualityExpectedMoveAtrMult = Math.max(0.1, Number(patch.supertrendMoveQualityExpectedMoveAtrMult));
    }
    if (patch.supertrendMoveQualityMinAtrExpansion != null && Number.isFinite(Number(patch.supertrendMoveQualityMinAtrExpansion))) {
      state.supertrendMoveQualityMinAtrExpansion = Math.max(0, Number(patch.supertrendMoveQualityMinAtrExpansion));
    }
    if (patch.supertrendMoveQualityMinBodyVsAvg != null && Number.isFinite(Number(patch.supertrendMoveQualityMinBodyVsAvg))) {
      state.supertrendMoveQualityMinBodyVsAvg = clamp(Number(patch.supertrendMoveQualityMinBodyVsAvg), 0.15, 1);
    }
    if (patch.supertrendMoveQualityMinDirectionalBody != null && Number.isFinite(Number(patch.supertrendMoveQualityMinDirectionalBody))) {
      state.supertrendMoveQualityMinDirectionalBody = clamp(Number(patch.supertrendMoveQualityMinDirectionalBody), 0, 1);
    }
    if (patch.supertrendMoveQualityMinVolumeVsAvg != null && Number.isFinite(Number(patch.supertrendMoveQualityMinVolumeVsAvg))) {
      state.supertrendMoveQualityMinVolumeVsAvg = Math.max(0, Number(patch.supertrendMoveQualityMinVolumeVsAvg));
    }
    if (patch.supertrendHtf4hEnabled != null) state.supertrendHtf4hEnabled = Boolean(patch.supertrendHtf4hEnabled);
    if (patch.supertrendHtf4hPeriod != null && Number.isFinite(Number(patch.supertrendHtf4hPeriod))) {
      state.supertrendHtf4hPeriod = clamp(Math.round(Number(patch.supertrendHtf4hPeriod)), 2, 50);
    }
    if (patch.supertrendHtf4hMultiplier != null && Number.isFinite(Number(patch.supertrendHtf4hMultiplier))) {
      state.supertrendHtf4hMultiplier = Math.max(0.5, Number(patch.supertrendHtf4hMultiplier));
    }
    if (patch.volumeProfileEnabled != null) state.volumeProfileEnabled = Boolean(patch.volumeProfileEnabled);
    if (patch.volumeProfileSoftGates != null) state.volumeProfileSoftGates = Boolean(patch.volumeProfileSoftGates);
    if (patch.volumeProfileGatesEnabled != null) state.volumeProfileGatesEnabled = Boolean(patch.volumeProfileGatesEnabled);
    if (patch.intradayVpBrackets != null) state.intradayVpBrackets = Boolean(patch.intradayVpBrackets);
    for (const gk of [
      "intradayGateLiquidity",
      "intradayGateSession",
      "intradayGateFib",
      "intradayGateVp",
      "intradayGateOrderFlow",
      "intradayGateHtfRegime",
      "intradayGateInstitutionalSr",
      "intradayGateSmcIct",
      "intradaySmcIctMode",
      "intradaySmcRequireMss",
      "intradaySmcRequireRetrace",
      "intradaySmcRequireChoch",
      "intradaySmcRequireBos",
      "intradaySmcRequireConfirm",
      "intradaySmcRequireFvgRetrace",
      "intradaySrAPlusMode",
      "intradaySrRequireBos",
      "intradaySrRequireConfirm",
      "intradaySrRequireVolume",
      "intradaySrRequireHtfTrend",
      "intradayLiqTp1Enabled",
      "intradayLiqTp2Enabled",
      "intradayLiqBreakevenAfterPartial",
      "intradayLiqPartialTp",
    ]) {
      if (patch[gk] != null) state[gk] = Boolean(patch[gk]);
    }
    if (patch.intradayGateSmcIct != null || patch.intradaySmcIctMode != null) {
      const smcOn =
        patch.intradayGateSmcIct != null
          ? Boolean(patch.intradayGateSmcIct)
          : patch.intradaySmcIctMode != null
            ? Boolean(patch.intradaySmcIctMode)
            : state.intradayGateSmcIct === true || state.intradaySmcIctMode === true;
      state.intradayGateSmcIct = smcOn;
      state.intradaySmcIctMode = smcOn;
    }
    if (patch.intradayGateInstitutionalSr != null || patch.intradaySrAPlusMode != null) {
      const instOn =
        patch.intradayGateInstitutionalSr != null
          ? Boolean(patch.intradayGateInstitutionalSr)
          : patch.intradaySrAPlusMode != null
            ? Boolean(patch.intradaySrAPlusMode)
            : state.intradayGateInstitutionalSr === true || state.intradaySrAPlusMode === true;
      state.intradayGateInstitutionalSr = instOn;
      state.intradaySrAPlusMode = instOn;
    }
    if (patch.intradaySmcMinScore != null && Number.isFinite(Number(patch.intradaySmcMinScore))) {
      state.intradaySmcMinScore = clamp(Math.round(Number(patch.intradaySmcMinScore)), 1, 20);
    }
    if (patch.intradaySmcBosMaxBars != null && Number.isFinite(Number(patch.intradaySmcBosMaxBars))) {
      state.intradaySmcBosMaxBars = clamp(Math.round(Number(patch.intradaySmcBosMaxBars)), 1, 20);
    }
    if (patch.intradaySmcChochMaxBars != null && Number.isFinite(Number(patch.intradaySmcChochMaxBars))) {
      state.intradaySmcChochMaxBars = clamp(Math.round(Number(patch.intradaySmcChochMaxBars)), 1, 30);
    }
    if (patch.intradaySmcEntryZoneMode != null) {
      const m = String(patch.intradaySmcEntryZoneMode).toUpperCase();
      state.intradaySmcEntryZoneMode = m === "FVG" || m === "OB" ? m : "EITHER";
    }
    if (patch.intradaySmcFvgEntryMode != null) {
      const m = String(patch.intradaySmcFvgEntryMode).toLowerCase();
      state.intradaySmcFvgEntryMode = m === "midpoint" || m === "ce" ? "midpoint" : "zone";
    }
    if (patch.intradaySmcTp2Mode != null) {
      const m = String(patch.intradaySmcTp2Mode).toLowerCase();
      state.intradaySmcTp2Mode =
        m === "internal" || m === "tiered" ? m : "opposing";
    }
    if (patch.intradaySmcKillzoneMode != null) {
      const kz = String(patch.intradaySmcKillzoneMode).toUpperCase();
      const valid = ["LONDON", "NY", "LONDON_NY", "OVERLAP", "SILVER_BULLET", "ASIA", "ALL", "CUSTOM"];
      state.intradaySmcKillzoneMode = valid.includes(kz) ? kz : "LONDON_NY";
    }
    if (patch.intradaySmcLookbackBars != null && Number.isFinite(Number(patch.intradaySmcLookbackBars))) {
      state.intradaySmcLookbackBars = clamp(Math.round(Number(patch.intradaySmcLookbackBars)), 3, 200);
    }
    if (patch.intradaySmcDealingRangeLookback != null && Number.isFinite(Number(patch.intradaySmcDealingRangeLookback))) {
      state.intradaySmcDealingRangeLookback = clamp(
        Math.round(Number(patch.intradaySmcDealingRangeLookback)),
        10,
        200,
      );
    }
    if (patch.intradaySmcRequirePremiumDiscount != null) {
      state.intradaySmcRequirePremiumDiscount = Boolean(patch.intradaySmcRequirePremiumDiscount);
    }
    if (patch.intradaySmcPremiumDiscountOte != null) {
      state.intradaySmcPremiumDiscountOte = Boolean(patch.intradaySmcPremiumDiscountOte);
    }
    if (patch.intradaySmcMinRr != null && Number.isFinite(Number(patch.intradaySmcMinRr))) {
      state.intradaySmcMinRr = clamp(Number(patch.intradaySmcMinRr), 0, 10);
    }
    if (patch.intradaySmcMinAdx != null && Number.isFinite(Number(patch.intradaySmcMinAdx))) {
      state.intradaySmcMinAdx = clamp(Math.round(Number(patch.intradaySmcMinAdx)), 0, 100);
    }
    if (patch.intradaySmcHtfStrictness != null) {
      const s = String(patch.intradaySmcHtfStrictness).toLowerCase();
      state.intradaySmcHtfStrictness =
        s === "both" || s === "4h" || s === "1h" || s === "either" ? s : "both";
    }
    if (patch.intradaySmcHtfBiasMode != null) {
      const m = String(patch.intradaySmcHtfBiasMode).toLowerCase();
      state.intradaySmcHtfBiasMode =
        m === "ema" || m === "structure" || m === "parallel" ? m : "parallel";
    }
    if (patch.intradaySmcRequireHtfBias != null) {
      state.intradaySmcRequireHtfBias = Boolean(patch.intradaySmcRequireHtfBias);
    }
    if (patch.intradaySmcSlMode != null) {
      const slm = String(patch.intradaySmcSlMode).toLowerCase();
      state.intradaySmcSlMode = slm === "structure" ? "structure" : "sweep";
    }
    if (patch.intradaySmcMaxTpRr != null && Number.isFinite(Number(patch.intradaySmcMaxTpRr))) {
      state.intradaySmcMaxTpRr = clamp(Number(patch.intradaySmcMaxTpRr), 0, 20);
    }
    if (patch.intradaySmcMaxHoldBars != null && Number.isFinite(Number(patch.intradaySmcMaxHoldBars))) {
      state.intradaySmcMaxHoldBars = clamp(Math.round(Number(patch.intradaySmcMaxHoldBars)), 0, 2000);
    }
    if (patch.intradaySmcIctProfile != null) {
      const p = String(patch.intradaySmcIctProfile).toLowerCase();
      const valid = ["full", "sweep", "ict2022", "lite", "balanced", "daily"];
      state.intradaySmcIctProfile = valid.includes(p) ? p : "sweep";
    }
    if (patch.intradaySmcPickMode != null) {
      const pm = String(patch.intradaySmcPickMode).toLowerCase();
      state.intradaySmcPickMode =
        pm === "per_signal" || pm === "daily_best" ? pm : "daily_sniper";
    }
    if (patch.intradaySmcOneTradePerDay != null) {
      state.intradaySmcOneTradePerDay = Boolean(patch.intradaySmcOneTradePerDay);
    }
    if (patch.intradaySmcChochStrict != null) {
      state.intradaySmcChochStrict = Boolean(patch.intradaySmcChochStrict);
    }
    if (patch.intradayLiqOnePickPerDay != null) {
      state.intradayLiqOnePickPerDay = Boolean(patch.intradayLiqOnePickPerDay);
    }
    if (patch.intradayLiqSessionExtreme != null) {
      state.intradayLiqSessionExtreme = Boolean(patch.intradayLiqSessionExtreme);
    }
    if (patch.intradayLiqMinSweepExtensionPct != null && Number.isFinite(Number(patch.intradayLiqMinSweepExtensionPct))) {
      state.intradayLiqMinSweepExtensionPct = clamp(Number(patch.intradayLiqMinSweepExtensionPct), 0, 0.05);
    }
    if (patch.intradayLiqStrictMode != null) {
      state.intradayLiqStrictMode = Boolean(patch.intradayLiqStrictMode);
    }
    if (patch.srIntradayMaxTradesPerDay != null && Number.isFinite(Number(patch.srIntradayMaxTradesPerDay))) {
      state.srIntradayMaxTradesPerDay = clamp(Math.round(Number(patch.srIntradayMaxTradesPerDay)), 1, 50);
    }
    if (patch.srIntradayMinBarGap != null && Number.isFinite(Number(patch.srIntradayMinBarGap))) {
      state.srIntradayMinBarGap = clamp(Math.round(Number(patch.srIntradayMinBarGap)), 1, 100);
    }
    if (patch.srIntradayMinScore != null && Number.isFinite(Number(patch.srIntradayMinScore))) {
      state.srIntradayMinScore = clamp(Number(patch.srIntradayMinScore), 1, 20);
    }
    if (patch.intradayMinTechniqueCount != null && Number.isFinite(Number(patch.intradayMinTechniqueCount))) {
      state.intradayMinTechniqueCount = clamp(Math.round(Number(patch.intradayMinTechniqueCount)), 1, 10);
    }
    if (patch.intradayRequireSessionReclaim != null) {
      state.intradayRequireSessionReclaim = Boolean(patch.intradayRequireSessionReclaim);
    }
    if (patch.intradayRequireFibOrVp != null) {
      state.intradayRequireFibOrVp = Boolean(patch.intradayRequireFibOrVp);
    }
    if (patch.intradayLearnedRulesEnabled != null) {
      state.intradayLearnedRulesEnabled = Boolean(patch.intradayLearnedRulesEnabled);
    }
    if (patch.intradaySrMinVolRatio != null && Number.isFinite(Number(patch.intradaySrMinVolRatio))) {
      state.intradaySrMinVolRatio = clamp(Number(patch.intradaySrMinVolRatio), 0, 5);
    }
    if (patch.intradaySrMinHtfSep != null && Number.isFinite(Number(patch.intradaySrMinHtfSep))) {
      state.intradaySrMinHtfSep = clamp(Number(patch.intradaySrMinHtfSep), 0, 0.01);
    }
    if (patch.intradaySrZoneWidthPct != null && Number.isFinite(Number(patch.intradaySrZoneWidthPct))) {
      state.intradaySrZoneWidthPct = clamp(Number(patch.intradaySrZoneWidthPct), 0.0001, 0.02);
    }
    if (patch.intradaySrBosMaxBarsAfterReclaim != null && Number.isFinite(Number(patch.intradaySrBosMaxBarsAfterReclaim))) {
      state.intradaySrBosMaxBarsAfterReclaim = clamp(Math.round(Number(patch.intradaySrBosMaxBarsAfterReclaim)), 0, 10);
    }
    if (patch.intradaySrMinConfirmWick != null && Number.isFinite(Number(patch.intradaySrMinConfirmWick))) {
      state.intradaySrMinConfirmWick = clamp(Number(patch.intradaySrMinConfirmWick), 0, 1);
    }
    if (patch.intradayLiqMinRr != null && Number.isFinite(Number(patch.intradayLiqMinRr))) {
      state.intradayLiqMinRr = clamp(Number(patch.intradayLiqMinRr), 0, 5);
    }
    if (patch.intradayLiqTp1Rr != null && Number.isFinite(Number(patch.intradayLiqTp1Rr))) {
      state.intradayLiqTp1Rr = clamp(Number(patch.intradayLiqTp1Rr), 0.25, 2);
    }
    if (patch.intradayLiqTp2Rr != null && Number.isFinite(Number(patch.intradayLiqTp2Rr))) {
      state.intradayLiqTp2Rr = clamp(Number(patch.intradayLiqTp2Rr), 0, 20);
    }
    if (patch.intradayLiqTp2PartialFrac != null && Number.isFinite(Number(patch.intradayLiqTp2PartialFrac))) {
      state.intradayLiqTp2PartialFrac = clamp(Number(patch.intradayLiqTp2PartialFrac), 0, 0.75);
    }
    if (patch.intradayLiqMaxTpRr != null && Number.isFinite(Number(patch.intradayLiqMaxTpRr))) {
      state.intradayLiqMaxTpRr = clamp(Number(patch.intradayLiqMaxTpRr), 0, 20);
    }
    if (patch.intradayLiqMaxHoldBars != null && Number.isFinite(Number(patch.intradayLiqMaxHoldBars))) {
      state.intradayLiqMaxHoldBars = clamp(Math.round(Number(patch.intradayLiqMaxHoldBars)), 0, 2000);
    }
    if (patch.intradayLiqPartialFrac != null && Number.isFinite(Number(patch.intradayLiqPartialFrac))) {
      state.intradayLiqPartialFrac = clamp(Number(patch.intradayLiqPartialFrac), 0.1, 0.75);
    }
    if (patch.intradayLiqMinScore != null && Number.isFinite(Number(patch.intradayLiqMinScore))) {
      state.intradayLiqMinScore = clamp(Math.round(Number(patch.intradayLiqMinScore)), 0, 20);
    }
    if (patch.intradayLiqMinReclaimBodyRatio != null && Number.isFinite(Number(patch.intradayLiqMinReclaimBodyRatio))) {
      state.intradayLiqMinReclaimBodyRatio = clamp(Number(patch.intradayLiqMinReclaimBodyRatio), 0, 1);
    }
    if (patch.intradayLiqRequireHtfAlign != null) {
      state.intradayLiqRequireHtfAlign = Boolean(patch.intradayLiqRequireHtfAlign);
    }
    if (patch.intradayLiqRejectSameBarReclaim != null) {
      state.intradayLiqRejectSameBarReclaim = Boolean(patch.intradayLiqRejectSameBarReclaim);
    }
    if (patch.intradayLiqBreakevenAfterPartial != null) {
      state.intradayLiqBreakevenAfterPartial = Boolean(patch.intradayLiqBreakevenAfterPartial);
    }
    if (patch.intradayLiqTp1Enabled != null) {
      state.intradayLiqTp1Enabled = Boolean(patch.intradayLiqTp1Enabled);
    }
    if (patch.intradayLiqTp2Enabled != null) {
      state.intradayLiqTp2Enabled = Boolean(patch.intradayLiqTp2Enabled);
    }
    if (patch.intradayLiqPartialTp != null) {
      state.intradayLiqPartialTp = Boolean(patch.intradayLiqPartialTp);
    }
    if (patch.intradayLiqSlBufferPct != null && Number.isFinite(Number(patch.intradayLiqSlBufferPct))) {
      state.intradayLiqSlBufferPct = clamp(Number(patch.intradayLiqSlBufferPct), 0, 0.01);
    }
    if (patch.intradayLiqSessionExtremeMinTouches != null && Number.isFinite(Number(patch.intradayLiqSessionExtremeMinTouches))) {
      state.intradayLiqSessionExtremeMinTouches = clamp(Math.round(Number(patch.intradayLiqSessionExtremeMinTouches)), 1, 20);
    }
    if (patch.intradayLiqSessionExtremeMinExtensionPct != null && Number.isFinite(Number(patch.intradayLiqSessionExtremeMinExtensionPct))) {
      state.intradayLiqSessionExtremeMinExtensionPct = clamp(Number(patch.intradayLiqSessionExtremeMinExtensionPct), 0, 0.05);
    }
    if (patch.srIntradaySweepPct != null && Number.isFinite(Number(patch.srIntradaySweepPct))) {
      state.srIntradaySweepPct = clamp(Number(patch.srIntradaySweepPct), 0, 0.05);
    }
    applyVolumeProfilePatchToState(state, patch);
    if (patch.supertrendBigMoveGateEnabled != null) state.supertrendBigMoveGateEnabled = Boolean(patch.supertrendBigMoveGateEnabled);
    if (patch.supertrendBigMoveMinStrength != null && Number.isFinite(Number(patch.supertrendBigMoveMinStrength))) {
      state.supertrendBigMoveMinStrength = clamp(Math.round(Number(patch.supertrendBigMoveMinStrength)), 0, 100);
    }
    if (patch.supertrendBigMoveMinMoveSlRatio != null && Number.isFinite(Number(patch.supertrendBigMoveMinMoveSlRatio))) {
      state.supertrendBigMoveMinMoveSlRatio = Math.max(1, Number(patch.supertrendBigMoveMinMoveSlRatio));
    }
    if (patch.supertrendBigMoveMinAdx != null && Number.isFinite(Number(patch.supertrendBigMoveMinAdx))) {
      state.supertrendBigMoveMinAdx = clamp(Math.round(Number(patch.supertrendBigMoveMinAdx)), 0, 100);
    }
    if (patch.supertrendBigMoveMinScore != null && Number.isFinite(Number(patch.supertrendBigMoveMinScore))) {
      state.supertrendBigMoveMinScore = clamp(Number(patch.supertrendBigMoveMinScore), 0, 1);
    }
    if (patch.supertrendBigMoveMaxCandlesSinceFlip != null && Number.isFinite(Number(patch.supertrendBigMoveMaxCandlesSinceFlip))) {
      state.supertrendBigMoveMaxCandlesSinceFlip = Math.max(0, Math.round(Number(patch.supertrendBigMoveMaxCandlesSinceFlip)));
    }
    if (patch.supertrendBigMoveMinVolumeVsAvg != null && Number.isFinite(Number(patch.supertrendBigMoveMinVolumeVsAvg))) {
      state.supertrendBigMoveMinVolumeVsAvg = Math.max(0, Number(patch.supertrendBigMoveMinVolumeVsAvg));
    }
    if (patch.supertrendBigMoveExpectedMoveAtrMult != null && Number.isFinite(Number(patch.supertrendBigMoveExpectedMoveAtrMult))) {
      state.supertrendBigMoveExpectedMoveAtrMult = Math.max(0.1, Number(patch.supertrendBigMoveExpectedMoveAtrMult));
    }
    applyLiqMapPatchToState(patch);
    // ── SUPERTREND_ELITE gate config ─────────────────────────────────────────
    if (patch.eliteStRequireHtf4hAlign   != null) state.eliteStRequireHtf4hAlign   = Boolean(patch.eliteStRequireHtf4hAlign);
    if (patch.eliteStHtf4hPeriod         != null && Number.isFinite(Number(patch.eliteStHtf4hPeriod)))
      state.eliteStHtf4hPeriod = clamp(Math.round(Number(patch.eliteStHtf4hPeriod)), 2, 50);
    if (patch.eliteStHtf4hMultiplier     != null && Number.isFinite(Number(patch.eliteStHtf4hMultiplier)))
      state.eliteStHtf4hMultiplier = Math.max(0.5, Number(patch.eliteStHtf4hMultiplier));
    if (patch.eliteStRequireHtf1hEmaAlign != null) state.eliteStRequireHtf1hEmaAlign = Boolean(patch.eliteStRequireHtf1hEmaAlign);
    if (patch.eliteStHtf1hMinSep         != null && Number.isFinite(Number(patch.eliteStHtf1hMinSep)))
      state.eliteStHtf1hMinSep = Math.max(0, Number(patch.eliteStHtf1hMinSep));
    if (patch.eliteStHtf1hSepMode != null) {
      const m = String(patch.eliteStHtf1hSepMode).toUpperCase();
      if (["FIXED", "ATR", "PERCENTILE", "ADX", "CALIBRATED"].includes(m)) state.eliteStHtf1hSepMode = m;
    }
    if (patch.eliteStHtf1hMinSepAtrMult != null && Number.isFinite(Number(patch.eliteStHtf1hMinSepAtrMult)))
      state.eliteStHtf1hMinSepAtrMult = clamp(Number(patch.eliteStHtf1hMinSepAtrMult), 0.05, 2);
    if (patch.eliteStHtf1hMinSepFloor != null && Number.isFinite(Number(patch.eliteStHtf1hMinSepFloor)))
      state.eliteStHtf1hMinSepFloor = clamp(Number(patch.eliteStHtf1hMinSepFloor), 0, 0.01);
    if (patch.eliteStHtf1hMinSepCeil != null && Number.isFinite(Number(patch.eliteStHtf1hMinSepCeil)))
      state.eliteStHtf1hMinSepCeil = clamp(Number(patch.eliteStHtf1hMinSepCeil), 0, 0.01);
    if (patch.eliteStHtf1hSepPercentileLookback != null && Number.isFinite(Number(patch.eliteStHtf1hSepPercentileLookback)))
      state.eliteStHtf1hSepPercentileLookback = clamp(Math.round(Number(patch.eliteStHtf1hSepPercentileLookback)), 20, 200);
    if (patch.eliteStHtf1hSepPercentileMult != null && Number.isFinite(Number(patch.eliteStHtf1hSepPercentileMult)))
      state.eliteStHtf1hSepPercentileMult = clamp(Number(patch.eliteStHtf1hSepPercentileMult), 0.5, 3);
    if (patch.eliteStHtf1hSepAdxBase != null && Number.isFinite(Number(patch.eliteStHtf1hSepAdxBase)))
      state.eliteStHtf1hSepAdxBase = clamp(Number(patch.eliteStHtf1hSepAdxBase), 0, 0.01);
    if (patch.eliteStHtf1hSepAdxAlpha != null && Number.isFinite(Number(patch.eliteStHtf1hSepAdxAlpha)))
      state.eliteStHtf1hSepAdxAlpha = clamp(Number(patch.eliteStHtf1hSepAdxAlpha), 0, 5);
    if (patch.eliteStHtf1hSepAdxRef != null && Number.isFinite(Number(patch.eliteStHtf1hSepAdxRef)))
      state.eliteStHtf1hSepAdxRef = clamp(Math.round(Number(patch.eliteStHtf1hSepAdxRef)), 1, 100);
    if (patch.eliteStHtf1hSepCalibratePct != null && Number.isFinite(Number(patch.eliteStHtf1hSepCalibratePct)))
      state.eliteStHtf1hSepCalibratePct = clamp(Math.round(Number(patch.eliteStHtf1hSepCalibratePct)), 1, 99);
    if (patch.eliteStHtf1hSepCalibrateBars != null && Number.isFinite(Number(patch.eliteStHtf1hSepCalibrateBars)))
      state.eliteStHtf1hSepCalibrateBars = clamp(Math.round(Number(patch.eliteStHtf1hSepCalibrateBars)), 20, 200);
    if (patch.eliteStMinAdx              != null && Number.isFinite(Number(patch.eliteStMinAdx)))
      state.eliteStMinAdx = clamp(Math.round(Number(patch.eliteStMinAdx)), 0, 100);
    if (patch.eliteStRequireAdxRising    != null) state.eliteStRequireAdxRising    = Boolean(patch.eliteStRequireAdxRising);
    if (patch.eliteStAdxRisingLookback   != null && Number.isFinite(Number(patch.eliteStAdxRisingLookback)))
      state.eliteStAdxRisingLookback = Math.max(1, Math.round(Number(patch.eliteStAdxRisingLookback)));
    if (patch.eliteStMinVolumeVsAvg      != null && Number.isFinite(Number(patch.eliteStMinVolumeVsAvg)))
      state.eliteStMinVolumeVsAvg = Math.max(0, Number(patch.eliteStMinVolumeVsAvg));
    if (patch.eliteStRequireAtrExpansion != null) state.eliteStRequireAtrExpansion = Boolean(patch.eliteStRequireAtrExpansion);
    if (patch.eliteStMinAtrExpansion     != null && Number.isFinite(Number(patch.eliteStMinAtrExpansion)))
      state.eliteStMinAtrExpansion = Math.max(1, Number(patch.eliteStMinAtrExpansion));
    if (patch.eliteStAtrExpansionLookback != null && Number.isFinite(Number(patch.eliteStAtrExpansionLookback)))
      state.eliteStAtrExpansionLookback = Math.max(2, Math.round(Number(patch.eliteStAtrExpansionLookback)));
    if (patch.eliteStLiqSweepEnabled     != null) state.eliteStLiqSweepEnabled     = Boolean(patch.eliteStLiqSweepEnabled);
    if (patch.eliteStAutoCalibrate       != null) state.eliteStAutoCalibrate       = Boolean(patch.eliteStAutoCalibrate);
    if (patch.eliteStAutoProfileBars != null && Number.isFinite(Number(patch.eliteStAutoProfileBars)))
      state.eliteStAutoProfileBars = clamp(Math.round(Number(patch.eliteStAutoProfileBars)), 40, 200);
    if (patch.eliteStAutoBracketMode != null) {
      const bm = String(patch.eliteStAutoBracketMode).toUpperCase();
      if (["ATR", "OFF", "FIXED"].includes(bm)) state.eliteStAutoBracketMode = bm;
    }
    if (patch.eliteStAutoMinAdxFloor != null && Number.isFinite(Number(patch.eliteStAutoMinAdxFloor)))
      state.eliteStAutoMinAdxFloor = clamp(Math.round(Number(patch.eliteStAutoMinAdxFloor)), 0, 100);
    if (patch.eliteStAutoMinAdxCeil != null && Number.isFinite(Number(patch.eliteStAutoMinAdxCeil)))
      state.eliteStAutoMinAdxCeil = clamp(Math.round(Number(patch.eliteStAutoMinAdxCeil)), 1, 100);
    // ─────────────────────────────────────────────────────────────────────────
    if (patch.supertrendBreakoutConfirm != null) {
      state.supertrendBreakoutConfirm = Boolean(patch.supertrendBreakoutConfirm);
      if (!state.supertrendBreakoutConfirm) state.pendingSupertrendBreakout = null;
    }
    if (patch.supertrendBreakoutMaxBars != null && Number.isFinite(Number(patch.supertrendBreakoutMaxBars))) {
      state.supertrendBreakoutMaxBars = Math.max(1, Math.min(20, Math.floor(Number(patch.supertrendBreakoutMaxBars))));
    }
    if (patch.signalStrengthOpenMin != null && Number.isFinite(Number(patch.signalStrengthOpenMin))) {
      state.signalStrengthOpenMin = clamp(Math.round(Number(patch.signalStrengthOpenMin)), 0, 100);
    }
    if (patch.supertrendFuturesMinAiProb != null && Number.isFinite(Number(patch.supertrendFuturesMinAiProb))) {
      state.supertrendFuturesMinAiProb = clamp(Number(patch.supertrendFuturesMinAiProb), 0, 1);
    }
    if (patch.surfPulseMlGateEnabled != null) {
      state.surfPulseMlGateEnabled = Boolean(patch.surfPulseMlGateEnabled);
    }
    if (patch.intelligenceGateEnabled != null) {
      state.intelligenceGateEnabled = Boolean(patch.intelligenceGateEnabled);
    }
    if (patch.intelligenceGateStrict != null) {
      state.intelligenceGateStrict = Boolean(patch.intelligenceGateStrict);
    }
    if (patch.intelligenceGateHighWinRate != null) {
      state.intelligenceGateHighWinRate = Boolean(patch.intelligenceGateHighWinRate);
    }
    if (patch.intelligenceGateManualStrategies != null) {
      state.intelligenceGateManualStrategies = Boolean(patch.intelligenceGateManualStrategies);
    }
    if (patch.supertrendFuturesExitOnFlip != null) {
      state.supertrendFuturesExitOnFlip = Boolean(patch.supertrendFuturesExitOnFlip);
    }
    if (patch.surfPulseMlThreshold != null && Number.isFinite(Number(patch.surfPulseMlThreshold))) {
      state.surfPulseMlThreshold = clamp(Number(patch.surfPulseMlThreshold), 0, 1);
    }
    if (patch.trailingStopLossAuto != null) state.trailingStopLossAuto = Boolean(patch.trailingStopLossAuto);
    if (patch.trailOnlyAfterTp2Fill != null) {
      state.trailOnlyAfterTp2Fill = Boolean(patch.trailOnlyAfterTp2Fill);
    }
    if (patch.futuresTrailingStopMode != null) {
      state.futuresTrailingStopMode = normalizeFuturesTrailingStopMode(patch.futuresTrailingStopMode);
    }
    if (patch.futuresTrailingStFeeBreakeven != null) {
      state.futuresTrailingStFeeBreakeven = Boolean(patch.futuresTrailingStFeeBreakeven);
    }
    if (patch.futuresTrailingStAdvanced != null) {
      state.futuresTrailingStAdvanced = Boolean(patch.futuresTrailingStAdvanced);
    }
    if (state.futuresTrailingStFeeBreakeven === false && state.futuresTrailingStAdvanced === false) {
      state.futuresTrailingStAdvanced = true;
    }
    if (patch.trailingStopExtraScalpingPcts != null) {
      state.trailingStopExtraScalpingPcts = normalizeTrailingExtraPcts(patch.trailingStopExtraScalpingPcts);
    }
    if (patch.supertrendFuturesFixedSlPct != null && Number.isFinite(Number(patch.supertrendFuturesFixedSlPct))) {
      const v = Number(patch.supertrendFuturesFixedSlPct);
      state.supertrendFuturesFixedSlPct = v <= 0 ? 0 : clamp(v, 0.00005, 0.2);
    }
    if (patch.supertrendFuturesFixedTpPct != null && Number.isFinite(Number(patch.supertrendFuturesFixedTpPct))) {
      const v = Number(patch.supertrendFuturesFixedTpPct);
      state.supertrendFuturesFixedTpPct = v <= 0 ? 0 : clamp(v, 0.00005, 0.5);
    }
    if (patch.supertrendFuturesUseFixedSl != null) {
      state.supertrendFuturesUseFixedSl = Boolean(patch.supertrendFuturesUseFixedSl);
    }
    if (patch.supertrendFuturesUseFixedTp != null) {
      state.supertrendFuturesUseFixedTp = Boolean(patch.supertrendFuturesUseFixedTp);
    }
    if (patch.supertrendFuturesTwoWay != null) state.supertrendFuturesTwoWay = Boolean(patch.supertrendFuturesTwoWay);
    if (patch.supertrendFuturesMaxEntrySlippagePct != null && Number.isFinite(Number(patch.supertrendFuturesMaxEntrySlippagePct))) {
      state.supertrendFuturesMaxEntrySlippagePct = clamp(Number(patch.supertrendFuturesMaxEntrySlippagePct), 0, 5);
    }
    if (patch.supertrendFuturesEntryOpenStyle != null) {
      const s = String(patch.supertrendFuturesEntryOpenStyle).toUpperCase();
      if (s === "AUTO" || s === "MARKET" || s === "LIMIT_IOC") state.supertrendFuturesEntryOpenStyle = s;
    }
    if (patch.supertrendFuturesEntryRecheckMs != null && Number.isFinite(Number(patch.supertrendFuturesEntryRecheckMs))) {
      state.supertrendFuturesEntryRecheckMs = Math.max(0, Math.floor(Number(patch.supertrendFuturesEntryRecheckMs)));
    }
    if (patch.supertrendFuturesIocFallbackMarket != null) {
      state.supertrendFuturesIocFallbackMarket = Boolean(patch.supertrendFuturesIocFallbackMarket);
    }
    if (patch.supertrendFuturesRequireMarkPrice != null) {
      state.supertrendFuturesRequireMarkPrice = Boolean(patch.supertrendFuturesRequireMarkPrice);
    }
    if (patch.supertrendFuturesRequireBookTicker != null) {
      state.supertrendFuturesRequireBookTicker = Boolean(patch.supertrendFuturesRequireBookTicker);
    }
    if (patch.supertrendFuturesMaxSignalLagMs != null && Number.isFinite(Number(patch.supertrendFuturesMaxSignalLagMs))) {
      state.supertrendFuturesMaxSignalLagMs = Math.max(0, Math.floor(Number(patch.supertrendFuturesMaxSignalLagMs)));
    }
    if (patch.supertrendPeriod != null) {
      state.supertrendPeriod = clamp(Math.floor(Number(patch.supertrendPeriod)), 2, 100);
    }
    if (patch.supertrendMultiplier != null) {
      state.supertrendMultiplier = clamp(Number(patch.supertrendMultiplier), 0.5, 20);
    }
    if (patch.supertrendWilderAtr != null) state.supertrendWilderAtr = Boolean(patch.supertrendWilderAtr);

    if (patch.trailOpenFeeRate != null && Number.isFinite(Number(patch.trailOpenFeeRate))) {
      state.trailOpenFeeRate = clamp(Number(patch.trailOpenFeeRate), 0, 0.01);
    }
    if (patch.trailCloseFeeRate != null && Number.isFinite(Number(patch.trailCloseFeeRate))) {
      state.trailCloseFeeRate = clamp(Number(patch.trailCloseFeeRate), 0, 0.01);
    }
    if (patch.tradeHistoryMakerOpenFeeRate != null && Number.isFinite(Number(patch.tradeHistoryMakerOpenFeeRate))) {
      state.tradeHistoryMakerOpenFeeRate = clamp(Number(patch.tradeHistoryMakerOpenFeeRate), 0, 0.01);
    }
    if (patch.tradeHistoryMakerCloseFeeRate != null && Number.isFinite(Number(patch.tradeHistoryMakerCloseFeeRate))) {
      state.tradeHistoryMakerCloseFeeRate = clamp(Number(patch.tradeHistoryMakerCloseFeeRate), 0, 0.01);
    }
    if (patch.tradeHistoryTakerOpenFeeRate != null && Number.isFinite(Number(patch.tradeHistoryTakerOpenFeeRate))) {
      state.tradeHistoryTakerOpenFeeRate = clamp(Number(patch.tradeHistoryTakerOpenFeeRate), 0, 0.01);
    }
    if (patch.tradeHistoryTakerCloseFeeRate != null && Number.isFinite(Number(patch.tradeHistoryTakerCloseFeeRate))) {
      state.tradeHistoryTakerCloseFeeRate = clamp(Number(patch.tradeHistoryTakerCloseFeeRate), 0, 0.01);
    }
    if (patch.trailFeeBeMultiplier != null && Number.isFinite(Number(patch.trailFeeBeMultiplier))) {
      state.trailFeeBeMultiplier = clamp(Number(patch.trailFeeBeMultiplier), 1, 2);
    }
    if (patch.trailBufferRate != null && Number.isFinite(Number(patch.trailBufferRate))) {
      state.trailBufferRate = clamp(Number(patch.trailBufferRate), 0, 0.05);
    }
    if (patch.trailActivationSlippageFrac != null && Number.isFinite(Number(patch.trailActivationSlippageFrac))) {
      state.trailActivationSlippageFrac = clamp(Number(patch.trailActivationSlippageFrac), 0, 0.01);
    }
    if (patch.trailT01LockSlippageFrac != null && Number.isFinite(Number(patch.trailT01LockSlippageFrac))) {
      state.trailT01LockSlippageFrac = clamp(Number(patch.trailT01LockSlippageFrac), 0, 0.01);
    }
    if (patch.trailBufferAtrMult != null && Number.isFinite(Number(patch.trailBufferAtrMult))) {
      state.trailBufferAtrMult = clamp(Number(patch.trailBufferAtrMult), 0, 1);
    }
    if (patch.trailBufferMode != null) {
      state.trailBufferMode = normalizeTrailBufferMode(patch.trailBufferMode);
    }
    if (patch.trailPostT02ActivationBufferRate === null) {
      state.trailPostT02ActivationBufferRate = null;
    } else if (
      patch.trailPostT02ActivationBufferRate != null &&
      Number.isFinite(Number(patch.trailPostT02ActivationBufferRate))
    ) {
      state.trailPostT02ActivationBufferRate = clamp(Number(patch.trailPostT02ActivationBufferRate), 0, 0.05);
    }
    if (patch.trailMinSlDistFrac != null && Number.isFinite(Number(patch.trailMinSlDistFrac))) {
      state.trailMinSlDistFrac = clamp(Number(patch.trailMinSlDistFrac), 0, 0.1);
    }
    if (patch.trailMinGapFromMarkFrac != null && Number.isFinite(Number(patch.trailMinGapFromMarkFrac))) {
      state.trailMinGapFromMarkFrac = clamp(Number(patch.trailMinGapFromMarkFrac), 0, 0.2);
    }
    if (patch.trailMaintMarginRate != null && Number.isFinite(Number(patch.trailMaintMarginRate))) {
      state.trailMaintMarginRate = clamp(Number(patch.trailMaintMarginRate), 0, 0.1);
    }
    if (patch.trailPostT02SpacingFrac === null) {
      state.trailPostT02SpacingFrac = null;
    } else if (patch.trailPostT02SpacingFrac != null && Number.isFinite(Number(patch.trailPostT02SpacingFrac))) {
      state.trailPostT02SpacingFrac = clamp(Number(patch.trailPostT02SpacingFrac), 0.00001, 0.05);
    }
    if (patch.trailPostT02MaxExtraTiers != null && Number.isFinite(Number(patch.trailPostT02MaxExtraTiers))) {
      state.trailPostT02MaxExtraTiers = Math.max(10, Math.min(500, Math.floor(Number(patch.trailPostT02MaxExtraTiers))));
    }
    applyTrailAdvancedPatchToState(patch);

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

    if (patch.marketDecision != null && typeof patch.marketDecision === "object") {
      state.marketDecision = { ...(state.marketDecision || {}), ...patch.marketDecision };
    }

    if (patch.trendHtfStRegimeGate != null) state.trendHtfStRegimeGate = Boolean(patch.trendHtfStRegimeGate);
    if (patch.trendHtfStSurgicalLossFilter != null) {
      state.trendHtfStSurgicalLossFilter = Boolean(patch.trendHtfStSurgicalLossFilter);
    }
    if (patch.trendHtfStQualityFilter != null) state.trendHtfStQualityFilter = Boolean(patch.trendHtfStQualityFilter);
    if (patch.trendHtfStFlipExitBeforeSl != null) {
      state.trendHtfStFlipExitBeforeSl = Boolean(patch.trendHtfStFlipExitBeforeSl);
    }
    if (patch.trendHtfStMaxEntryRangeAtr != null && Number.isFinite(Number(patch.trendHtfStMaxEntryRangeAtr))) {
      state.trendHtfStMaxEntryRangeAtr = clamp(Number(patch.trendHtfStMaxEntryRangeAtr), 0, 10);
    }
    if (patch.trendHtfStMinHtfSep != null && Number.isFinite(Number(patch.trendHtfStMinHtfSep))) {
      state.trendHtfStMinHtfSep = clamp(Number(patch.trendHtfStMinHtfSep), 0, 0.05);
    }
    if (patch.trendHtfStRegimeTpTrend != null && Number.isFinite(Number(patch.trendHtfStRegimeTpTrend))) {
      state.trendHtfStRegimeTpTrend = clamp(Number(patch.trendHtfStRegimeTpTrend), 0.0005, 0.5);
    }
    if (patch.trendHtfStRegimeTpMixed != null && Number.isFinite(Number(patch.trendHtfStRegimeTpMixed))) {
      state.trendHtfStRegimeTpMixed = clamp(Number(patch.trendHtfStRegimeTpMixed), 0.0005, 0.5);
    }
    if (patch.trendHtfStRegimeTpChop != null && Number.isFinite(Number(patch.trendHtfStRegimeTpChop))) {
      state.trendHtfStRegimeTpChop = clamp(Number(patch.trendHtfStRegimeTpChop), 0.0005, 0.5);
    }
    if (patch.backtestBreakevenAtMfePct != null && Number.isFinite(Number(patch.backtestBreakevenAtMfePct))) {
      state.backtestBreakevenAtMfePct = clamp(Number(patch.backtestBreakevenAtMfePct), 0, 0.1);
    }

    // Futures Supertrend AI filter only applies when futures autotrade is on; otherwise reset to default.
    if (!state.supertrendFuturesAuto || state.marketMode === "SPOT") {
      state.supertrendFuturesAiConfidenceFilter = true;
    }

    if (
      patch.symbol ||
      patch.timeframe ||
      patch.universePinnedSymbol !== undefined ||
      patch.universePinnedSymbols !== undefined ||
      patch.symbolMode ||
      patch.universeCoinSelectMode ||
      patch.universeAutoCoinPick
    ) {
      loadSupertrendSignalHistoryFromDisk();
    }

    const focusOnlyPatch =
      Object.keys(patch).filter((k) => patch[k] !== undefined).length === 1 &&
      patch.uiChartFocusSymbol !== undefined;
    if (!focusOnlyPatch && !fromPersisted) {
    syncFeedWatchSymbols();
    }

    if (!fromPersisted) {
    clampAllowedBudgetToFreeMargin();
    if (capitalCycleResetNeeded && capitalCycleModeActive()) {
      resetCapitalCycleFromAllowedBase();
    }
    }
    if (!focusOnlyPatch) persistTradingConfigToDisk();

    if (!fromPersisted && (patch.symbol || patch.timeframe) && wsHubRef) {
      queueMicrotask(() => {
        tick({ wsHub: wsHubRef }).catch((e) =>
          log.warn("config_tick_flush_failed", { error: String(e?.message || e) }),
        );
      });
    }

    if (deferredChartFocusTick) {
      scheduleDeferredChartFocusWork(state.uiChartFocusSymbol);
    }

    return getPublicState();
  }

  async function manualTrade({ wsHub, side, amountUsd, stopLossPct, takeProfitPct, strategyKey = "MANUAL" }) {
    if (state.feedExecutionPause) return { ok: false, reason: "feed_execution_paused" };
    const candles = feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) return { ok: false, reason: "no_market_data" };

    const px = last.close;
    let qty = roundTo(Number(amountUsd) / px, 6);
    const isLong = side === "BUY";
    const useSl = stopLossPct != null && Number.isFinite(Number(stopLossPct)) && Number(stopLossPct) > 0;
    const useTp = takeProfitPct != null && Number.isFinite(Number(takeProfitPct)) && Number(takeProfitPct) > 0;
    const stopLoss = useSl
      ? isLong
        ? px * (1 - Math.abs(Number(stopLossPct)))
        : px * (1 + Math.abs(Number(stopLossPct)))
      : null;
    const takeProfit = useTp
      ? isLong
        ? px * (1 + Math.abs(Number(takeProfitPct)))
        : px * (1 - Math.abs(Number(takeProfitPct)))
      : null;

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

    if (isFutManual && manualLev != null) {
      const posNow = await exch.getPositions().catch(() => []);
      const cq = clampQtyToPerCoinMarginCap({
        symbol: state.symbol,
        qty,
        entryPx: px,
        leverage: manualLev ?? state.futuresLeverage,
        positions: posNow,
        wsHub,
        context: "manual_open",
      });
      qty = cq.qty;
      if (!Number.isFinite(qty) || qty <= 0) {
        emitActivity(wsHub, {
          level: "warn",
          category: "capital",
          reason: "manual_trade_cap_block",
          symbol: state.symbol,
          msg: `Manual trade blocked · ${side} ${state.symbol} · per-coin capital cap exhausted`,
        });
        return { ok: false, reason: "manual_trade_cap_block" };
      }
    }

    const order = await placeOrderWithWalletTelemetry(venueEx, () =>
      venueEx.placeOrder({
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
          skipStopLoss: !useSl,
          skipTakeProfit: !useTp,
        },
      }),
    );

    const entryExOidManual = binanceFuturesEntryOrderIdFromPlaceOrder(order);
    broadcastTrade(wsHub, {
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
      ...(entryExOidManual ? { meta: { orderId: entryExOidManual, venue: "FUTURES" } } : {}),
    });
    if (order.immediateCloseTrade && typeof order.immediateCloseTrade === "object") {
      broadcastTrade(wsHub, {
        ...order.immediateCloseTrade,
        strategyKey,
        strategy: strategyKey,
        source: "MANUAL",
      });
      emitActivity(wsHub, {
        level: "warn",
        category: "risk",
        reason: "immediate_flat_after_open",
        symbol: state.symbol,
        msg: `${state.symbol} · futures leg went flat within ~${postOpenStableProbeMs()}ms of open — paired CLOSE emitted.`,
      });
    }
    emitActivity(wsHub, {
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
    getChartSnapshotOrRestRepair,
    getChartSnapshotForSymbol,
    getMetrics() {
      return {
        ...state.metrics,
        uptimeSec: Math.round((Date.now() - state.metrics.startedAt) / 1000),
        symbol: state.symbol,
        running: state.running,
      };
    },
    async getUniverseScan({ force = false } = {}) {
      if (!universeScanEnabled()) {
        const stub = buildUniverseStubFromUiCandidates();
        if (force || !state.universe) state.universe = stub;
        return state.universe && typeof state.universe === "object" ? state.universe : stub;
      }
      if (!force && state.universe && !state.universe.emptyCustom) return state.universe;
      if (!marketFeedUsesLiveBinance()) return null;
      if (String(state.universeCoinBase || "ALL").toUpperCase() === "CUSTOM") {
        const cr = Array.isArray(state.universeCustomSymbols) ? state.universeCustomSymbols : [];
        const cleaned = [...new Set(cr.map((s) => String(s || "").trim().toUpperCase()).filter((s) => SYM_RE.test(s)))].slice(0, 10);
        if (!cleaned.length) {
          const empty = {
            ok: true,
            asOf: new Date().toISOString(),
            timeframe: state.timeframe,
            ranked: [],
            selected: [],
            tradable: 0,
            universeSize: 0,
            emptyCustom: true,
          };
          if (force) state.universe = empty;
          return empty;
        }
      }
      const snap = await universe.scanAndRank(buildUniverseScanOpts());
      state.universe = snap;
      return snap;
    },
    async listTradableUniverseSymbols({ q = null } = {}) {
      if (!marketFeedUsesLiveBinance()) return null;
      try {
        const symbols = await universe.listTradableUsdtSymbols({ q });
        return { ok: true, symbols, cached: true };
      } catch (e) {
        return { ok: false, error: String(e?.message || e), symbols: [] };
      }
    },
    start,
    stop,
    resetDailyLossBaselineAndStart,
    updateConfig,
    updateChartFocus,
    manualTrade,
    saveTradingConfigToDisk() {
      persistTradingConfigToDisk();
    },
    getTradingConfigPersistPayload() {
      return buildTradingConfigPersistPayload();
    },
    reloadTradingConfigFromPersisted(raw) {
      hydrateTradingConfigFromPersistedObject(raw);
      loadSupertrendSignalHistoryFromDisk();
      syncMarketFeedFromState();
    },
    reloadTradingConfigFromDisk() {
      hydrateTradingConfigFromDisk();
      loadSupertrendSignalHistoryFromDisk();
      syncMarketFeedFromState();
    },
    setExchange(next) {
      exch = next;
      lastSeenTradeId = null;
      ingestedCloseBroadcastKeys = new Set();
      closedSinceRetrain = 0;
      queueMicrotask(() => wireExchangeAccountPushListener());
    },
    setPaused(next) {
      state.paused = Boolean(next);
    },
    destroy() {
      _destroyed = true;
      if (_udsUiPushTimer) {
        clearTimeout(_udsUiPushTimer);
        _udsUiPushTimer = null;
      }
      if (_unsubExchangeAccountPush) {
        try {
          _unsubExchangeAccountPush();
        } catch {
          /* ignore */
        }
        _unsubExchangeAccountPush = null;
      }
      clearInterval(_tickTimer);
      clearInterval(_depthTimer);
      clearInterval(_cgTimer);
      clearInterval(_scanTimer);
      wsHubRef = null;
    },
  };
}

