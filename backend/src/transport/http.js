import express from "express";
import { z } from "zod";
import { runBacktest } from "../backtest/backtest.js";
import { getTradingEvaluationChecklist } from "../evaluation/tradingChecklist.js";
import { formatAiServiceError } from "../svc/aiHttpError.js";
import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import {
  isStrictBinanceAccountMode,
  persistenceSlugToTradingMode,
  tradingModeToPersistenceSlug,
} from "../lib/tradingModePersistence.js";
import { computeMqTuningPatch, readMqTradeOutcomeRows } from "../lib/mqTuneFromOutcomes.js";
import {
  requireAccountsDbUser,
  resolveAccountsOwnerUserId,
  resolveDbActingUserId,
  assertAccountMutable,
  assertAccountVisible,
} from "../auth/accountsAccess.js";
import { requireAdmin, requireDbUserSession, uiAuthEnabled } from "../auth/uiGate.js";
import * as accountsService from "../db/services/accountsService.js";
import * as credentialsService from "../db/services/credentialsService.js";
import * as usersService from "../db/services/usersService.js";
import { normalizeModeSlugParam } from "../lib/modeSlug.js";
import { getPool } from "../db/pool.js";
import { query } from "../db/query.js";
import * as strategyService from "../db/services/strategyService.js";
import { getLatestIntelligenceApiPayload, getIntelligenceHistory } from "../db/services/intelligenceService.js";
import { getLiquidationPayloadForSymbol } from "../intelligence/collectors/liquidationCollector.js";
import {
  refreshMarketIntelApisFromStore,
  getResolvedMarketIntelApis,
  marketIntelEncryptionKeyConfigured,
} from "../intelligence/marketIntelResolvedApis.js";
import { encryptSecret, decryptSecret } from "../lib/encryption.js";
import * as marketEventsService from "../db/services/marketEventsService.js";
import * as whaleAlertsService from "../db/services/whaleAlertsService.js";
import * as strategyEdgeService from "../db/services/strategyEdgeService.js";
import { readBotTradingConfig } from "../lib/botTradingConfigStore.js";
import { modeSlugRequiresSelectedAccount, normalizeTradingMode } from "../state/appState.js";
import {
  getPaperSystemAccountId,
  getLatestSnapshot,
  getSnapshotHistory,
  resolveWalletSnapshotAccountId,
  scheduleWalletSnapshotWrite,
  writeSnapshot,
} from "../db/services/walletService.js";
import * as instanceService from "../db/services/instanceService.js";
import * as tradeService from "../db/services/tradeService.js";
import * as performanceService from "../db/services/performanceService.js";
import { getAccountAllotmentHeadroom, InsufficientCapitalError } from "../db/services/capitalAllotmentService.js";
import { extractInstanceConfig } from "../lib/strategyInstanceSplit.js";
import { createBacktestRouter } from "./backtestRoutes.js";
const BOT_TARGET_MODES = z.enum(["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"]);

/** Accept true/false and common JSON/proxy coercions so toggles never 400 on edge clients. */
const optionalBoolLoose = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return v;
}, z.boolean().optional());

/** Same idea as toggles: require confirm=true but accept "true" / 1 from proxies or older clients. */
const modeSetConfirmLoose = z.preprocess((v) => {
  if (v === true || v === 1 || v === "1" || v === "true" || String(v).toLowerCase() === "true") return true;
  return v;
}, z.literal(true));

const modeSetBody = z.object({
  mode: BOT_TARGET_MODES,
  confirm: modeSetConfirmLoose,
});

const marketIntelProvidersPutBody = z.object({
  finnhubApiKey: z.string().optional(),
  cryptoquantApiKey: z.string().optional(),
  whaleAlertApiKey: z.string().optional(),
  aiBaseUrl: z.string().max(512).optional(),
});

export function createRouter({ appState }) {
  const r = express.Router();

  r.use("/backtest", createBacktestRouter({ appState }));

  /** DB `users.id` for this request: session login, or `dbActingUserId` set by `requireDbUserSession`. */
  function effectiveSessionUserId(req) {
    const a = req.session?.uiUserId;
    if (a != null && String(a).trim() !== "") return String(a);
    const b = req.dbActingUserId;
    if (b != null && String(b).trim() !== "") return String(b);
    return null;
  }

  /** Phase 3D — richer `instance_status` WS for lifecycle + capital/stats hints. */
  async function broadcastInstanceStatusFromDetail(instanceId, userId, extra = {}) {
    if (!appState.wsHub?.broadcast || !getPool()) return;
    try {
      const inst = await instanceService.getInstanceDetail(String(instanceId), String(userId));
      if (!inst) return;
      appState.wsHub.broadcast("instance_status", {
        instanceId: String(instanceId),
        status: inst.status,
        reason: extra.reason != null ? String(extra.reason) : null,
        triggeredBy: extra.triggeredBy != null ? String(extra.triggeredBy) : "user",
        errorMessage: String(inst.status || "").toLowerCase() === "error" ? inst.errorMessage : null,
        reservedUsdt: inst.allotment != null ? Number(inst.allotment.reservedUsdt) : null,
        totalTrades: inst.totalTrades != null ? Number(inst.totalTrades) : null,
        totalPnlUsdt: inst.totalPnlUsdt != null ? Number(inst.totalPnlUsdt) : null,
        updatedAt: inst.updatedAt != null ? String(inst.updatedAt) : new Date().toISOString(),
      });
    } catch (e) {
      appState.log?.warn?.("instance_status_broadcast_failed", { error: String(e?.message || e) });
    }
  }

  const symbolRe = /^[A-Z0-9]{5,20}$/;
  const allowedTimeframes = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

  const botLifecycleBody = z.object({
    reason: z.string().max(400).optional(),
    detail: z.record(z.unknown()).optional(),
    /** Start/stop this mode’s bot without switching UI mode (parallel engines). */
    mode: BOT_TARGET_MODES.optional(),
  });

  /** Active engine for this HTTP request: explicit body.mode, else session UI mode (when auth), else server default. */
  function resolveViewTradingMode(req, bodyMode) {
    if (bodyMode != null) return normalizeTradingMode(bodyMode);
    if (uiAuthEnabled() && req.session?.uiAuthOk && req.session?.uiTradingMode) {
      return normalizeTradingMode(req.session.uiTradingMode);
    }
    return appState.mode;
  }

  async function getEngineForBotRequest(req, bodyMode) {
    const m = resolveViewTradingMode(req, bodyMode);
    await appState.ensureEngine(m);
    const row = appState.getEngine(m);
    if (!row?.bot) throw new Error(`engine_missing:${m}`);
    return row;
  }

  /** Merged audit + exchange `getTrades()`, then WS `trades_snapshot` replace (all clients). */
  async function broadcastMergedTradesSnapshot(req, bodyMode, { forceReconcile = false } = {}) {
    const row = await getEngineForBotRequest(req, bodyMode);
    const viewM = resolveViewTradingMode(req, bodyMode);
    const ex = row.exchange;
    let trades = [];
    try {
      trades = await ex.getTrades({ forceReconcile });
    } catch {
      trades = [];
    }
    if (isStrictBinanceAccountMode(viewM)) {
      const acct = await ex.getAccount().catch(() => null);
      if (acct == null) trades = [];
    }
    trades = mergePersistedTradesWithExchange(viewM, trades);
    appState.wsHub?.broadcast?.("trades_snapshot", {
      replace: true,
      trades,
      mode: viewM,
    });
    return { ok: true, count: trades.length };
  }

  async function withTimeout(promise, ms) {
    return await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
    ]);
  }

  r.get("/state", async (req, res) => {
    const viewM = resolveViewTradingMode(req, undefined);
    const row = await getEngineForBotRequest(req, undefined);
    const ex = row.exchange;
    let account = null;
    let positions = [];
    let trades = [];
    try {
      account = await withTimeout(ex.getAccount(), 2000);
    } catch {
      account = null;
    }
    try {
      positions = await withTimeout(ex.getPositions(), 2000);
    } catch {
      positions = [];
    }
    try {
      trades = await withTimeout(ex.getTrades(), 2000);
    } catch {
      trades = [];
    }
    if (isStrictBinanceAccountMode(viewM) && account == null) {
      positions = [];
      trades = [];
    } else {
      trades = mergePersistedTradesWithExchange(viewM, trades);
    }
    void (async () => {
      try {
        const aid = await resolveWalletSnapshotAccountId(appState, viewM);
        if (aid && account != null) scheduleWalletSnapshotWrite(aid, account, positions);
      } catch {
        /* ignore */
      }
    })();
    res.json({
      ok: true,
      mode: viewM,
      bot: row.bot.getPublicState(),
      runningByMode: appState.getRunningByMode?.() ?? {},
      activeAccountByMode: appState.getActiveAccountByModeSnapshot(),
      activeStrategyVersionByMode: appState.getActiveStrategyVersionByModeSnapshot?.() ?? {},
      activeInstanceByMode: appState.getActiveInstanceByModeSnapshot?.() ?? {},
      account,
      positions,
      trades,
    });
  });

  /**
   * Binance min order notional from exchangeInfo filters (NOTIONAL / MIN_NOTIONAL).
   * Query: symbol (defaults to bot symbol), venue = SPOT | FUTURES | BOTH (defaults from bot marketMode; AUTO → BOTH).
   */
  r.get("/symbol/constraints", async (req, res) => {
    const row = await getEngineForBotRequest(req, undefined);
    const botState = row.bot.getPublicState();
    const symbol = String(req.query.symbol || botState.symbol || "").toUpperCase();
    let venue = String(req.query.venue || "").toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required" });
    const mm = String(botState.marketMode || "AUTO").toUpperCase();
    if (!venue) {
      venue = mm === "AUTO" ? "BOTH" : mm === "SPOT" ? "SPOT" : "FUTURES";
    }
    try {
      const ex = row.exchange;
      if (!ex?.getSymbolOrderConstraints) {
        return res.json({
          ok: true,
          symbol,
          venue,
          minNotional: 5,
          quoteAsset: "USDT",
          synthetic: true,
          rule: "Fallback — exchange has no constraints hook",
        });
      }
      const out = await ex.getSymbolOrderConstraints({ symbol, venue });
      res.json(out && typeof out === "object" ? out : { ok: false, error: "constraints_failed" });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Last N bars for chart (~24h). Default: bot symbol + live buffer. `?symbol=OTHERUSDT` fetches REST OHLC for multi-chart tiles. */
  r.get("/market/candles", async (req, res) => {
    try {
      const row = await getEngineForBotRequest(req, undefined);
      const bot = row.bot;
      const hours = Math.max(0.25, Math.min(168, Number(req.query.hours ?? 24)));
      const symQ = String(req.query.symbol || "").trim().toUpperCase();
      const botSym = String(bot.getPublicState().symbol || "").toUpperCase();
      if (symQ && symQ !== botSym && typeof bot.getChartSnapshotForSymbol === "function") {
        const snap = await bot.getChartSnapshotForSymbol(symQ, { hours });
        if (!snap?.candles?.length) return res.status(503).json({ ok: false, error: "no_candles" });
        return res.json({ ok: true, ...snap });
      }
      const snap =
        typeof bot.getChartSnapshotOrRestRepair === "function"
          ? await bot.getChartSnapshotOrRestRepair({ hours })
          : bot.getChartSnapshot({ hours });
      if (!snap?.candles?.length) return res.status(503).json({ ok: false, error: "no_candles" });
      res.json({ ok: true, ...snap });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/ai/health", async (_req, res) => {
    try {
      const data = await appState.ai.health();
      res.json({ ok: true, data });
    } catch (e) {
      res.status(503).json({ ok: false, error: formatAiServiceError(e) });
    }
  });

  r.get("/ai/validation-summary", async (_req, res) => {
    try {
      const h = await appState.ai.health();
      const m = h?.meta || {};
      res.json({
        ok: true,
        data: {
          trained_at: m.trained_at ?? null,
          trained_rows: m.trained_rows ?? null,
          val_accuracy: m.val_accuracy ?? null,
          val_log_loss: m.val_log_loss ?? null,
          val_brier: m.val_brier ?? null,
          val_roc_auc: m.val_roc_auc ?? null,
          val_baseline_wr: m.val_baseline_wr ?? null,
          val_top_decile_wr: m.val_top_decile_wr ?? null,
          val_lift: m.val_lift ?? null,
          val_half1_top_decile_wr: m.val_half1_top_decile_wr ?? null,
          val_half2_top_decile_wr: m.val_half2_top_decile_wr ?? null,
          horizon: m.horizon ?? null,
          fee_bps: m.fee_bps ?? null,
          symbols: m.symbols ?? null,
          model_kind: m.model_kind ?? null,
          stabilityHint:
            m.val_half1_top_decile_wr != null &&
            m.val_half2_top_decile_wr != null &&
            Math.abs(m.val_half1_top_decile_wr - m.val_half2_top_decile_wr) > 0.15
              ? "large_split_between_val_halves_retrain_or_more_data"
              : "ok",
        },
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: formatAiServiceError(e) });
    }
  });

  r.get("/metrics", async (req, res) => {
    try {
      const row = await getEngineForBotRequest(req, undefined);
      res.json({ ok: true, data: row.bot.getMetrics?.() || {} });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/ai/train-real", async (req, res) => {
    const schema = z.object({
      symbols: z.array(z.string().regex(symbolRe)).min(1).max(20).optional(),
      interval: z.string().refine((v) => allowedTimeframes.has(v)).optional(),
      candlesPerSymbol: z.number().int().min(1000).max(100000).optional(),
      horizon: z.number().int().min(5).max(300).optional(),
      atrMult: z.number().min(0.3).max(3).optional(),
      rr: z.number().min(1).max(5).optional(),
      labelProfile: z.enum(["risk_aligned", "legacy"]).optional(),
      feeBps: z.number().min(0).max(50).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const out = await appState.ai.trainFromBinance({
        symbols: parsed.data.symbols,
        interval: parsed.data.interval || "1m",
        candlesPerSymbol: parsed.data.candlesPerSymbol ?? 35000,
        horizon: parsed.data.horizon ?? 90,
        atrMult: parsed.data.atrMult,
        rr: parsed.data.rr,
        labelProfile: parsed.data.labelProfile,
        feeBps: parsed.data.feeBps ?? 10,
      });
      res.json({ ok: true, data: out });
    } catch (e) {
      const detail = formatAiServiceError(e);
      const hint =
        /fetch usable data|binance|451|not reachable|ECONNREFUSED/i.test(detail)
          ? "Binance often blocks cloud IPs (HTTP 451). Try MARKET_FEED=BINANCE_FUTURES (public USDT-M), Train synthetic (quick), MARKET_FEED=SYNTH, or deploy where Binance REST works."
          : null;
      res.status(400).json({ ok: false, error: hint ? `${detail} — ${hint}` : detail });
    }
  });

  r.post("/ai/train-bootstrap", async (req, res) => {
    const schema = z.object({
      rows: z.number().int().min(500).max(200_000).optional(),
      horizon: z.number().int().min(1).max(240).optional(),
      seed: z.number().int().min(0).max(1_000_000).optional(),
      start_price: z.number().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const out = await appState.ai.trainBootstrap({
        rows: parsed.data.rows,
        horizon: parsed.data.horizon,
        seed: parsed.data.seed,
        start_price: parsed.data.start_price,
      });
      res.json({ ok: true, data: out });
    } catch (e) {
      res.status(400).json({ ok: false, error: formatAiServiceError(e) });
    }
  });

  r.post("/ai/retrain", async (req, res) => {
    const schema = z.object({ minRows: z.number().int().min(10).max(1_000_000).optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const out = await appState.ai.retrainFromFeedback({ minRows: parsed.data.minRows ?? Number(process.env.RETRAIN_MIN_ROWS || 200) });
      res.json({ ok: true, data: out });
    } catch (e) {
      res.status(400).json({ ok: false, error: "retrain_failed" });
    }
  });

  r.post("/bot/start", async (req, res) => {
    try {
      const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
      const body = parsed.success ? parsed.data : {};
      const targetM = resolveViewTradingMode(req, body.mode);
      const slug = tradingModeToPersistenceSlug(targetM);
      if (modeSlugRequiresSelectedAccount(slug)) {
        const hasAcct = Boolean(appState.getActiveAccount(slug));
        const hasInst = Boolean(appState.getActiveInstance?.(slug));
        if (!hasAcct && !hasInst) {
          return res.status(400).json({
            ok: false,
            error: "no_account_selected",
            message: "Select an account before starting the bot in this mode",
          });
        }
      }
      const row = await getEngineForBotRequest(req, body.mode);
      row.bot.start({
        wsHub: appState.wsHub,
        reason: body.reason ?? "user_request",
        source: "http",
        detail: body.detail,
      });
      const iid = appState.getActiveInstance?.(slug);
      if (iid && getPool()) {
        try {
          const reason = body.reason ?? "User started";
          await instanceService.updateInstanceStatus(String(iid), "running", reason, "user", null);
          const uid = await resolveDbActingUserId(req);
          if (uid) {
            await broadcastInstanceStatusFromDetail(String(iid), uid, { reason, triggeredBy: "user" });
          } else {
            appState.wsHub?.broadcast?.("instance_status", {
              instanceId: String(iid),
              status: "running",
              reason,
              triggeredBy: "user",
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          appState.log?.warn?.("instance_status_on_start_failed", { error: String(e?.message || e) });
        }
      }
      res.json({
        ok: true,
        mode: targetM,
        targetMode: targetM,
        bot: row.bot.getPublicState(),
        runningByMode: appState.getRunningByMode?.() ?? {},
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/bot/stop", async (req, res) => {
    try {
      const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
      const body = parsed.success ? parsed.data : {};
      const row = await getEngineForBotRequest(req, body.mode);
      const targetM = resolveViewTradingMode(req, body.mode);
      const slug = tradingModeToPersistenceSlug(targetM);
      row.bot.stop({
        wsHub: appState.wsHub,
        reason: body.reason ?? "user_request",
        source: "http",
        detail: body.detail,
      });
      const iid = appState.getActiveInstance?.(slug);
      if (iid && getPool()) {
        try {
          const reason = body.reason ?? "User stopped";
          await instanceService.updateInstanceStatus(String(iid), "stopped", reason, "user", null);
          const uid = await resolveDbActingUserId(req);
          if (uid) {
            await broadcastInstanceStatusFromDetail(String(iid), uid, { reason, triggeredBy: "user" });
          } else {
            appState.wsHub?.broadcast?.("instance_status", {
              instanceId: String(iid),
              status: "stopped",
              reason,
              triggeredBy: "user",
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          appState.log?.warn?.("instance_status_on_stop_failed", { error: String(e?.message || e) });
        }
      }
      res.json({
        ok: true,
        mode: targetM,
        targetMode: targetM,
        bot: row.bot.getPublicState(),
        runningByMode: appState.getRunningByMode?.() ?? {},
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Re-anchor hybrid daily loss baselines to current wallet equity and start the bot (after max-daily-loss stop). */
  r.post("/bot/reset-daily-loss", async (req, res) => {
    try {
      const row = await getEngineForBotRequest(req, undefined);
      row.bot.resetDailyLossBaselineAndStart({ wsHub: appState.wsHub, source: "http" });
      res.json({ ok: true, bot: row.bot.getPublicState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/bot/config", async (req, res) => {
    const schema = z.object({
      /** Apply patch to this mode’s bot (defaults to UI’s active mode). */
      mode: BOT_TARGET_MODES.optional(),
      symbol: z.string().regex(symbolRe).optional(),
      symbolMode: z.enum(["SINGLE", "AUTO"]).optional(),
      timeframe: z.string().refine((v) => allowedTimeframes.has(v), "Unsupported timeframe").optional(),
      aiThreshold: z.number().min(0).max(1).optional(),
      /** Interpretation set by `riskPerTradeUnit`: PCT = fraction of balance at stop; USDT = target per-trade notional / investing capital in USDT (≥1). */
      riskPerTrade: z.number().min(0).max(10_000_000).optional(),
      /** Interpretation set by `maxDailyLossUnit`: PCT = max daily drawdown 0–100 (% points); USDT = max daily loss USD per venue. */
      maxDailyLoss: z.number().min(0).max(10_000_000).optional(),
      riskPerTradeUnit: z
        .preprocess((v) => (v === "PCT_EQUITY" ? "PCT" : v), z.enum(["PCT", "USDT"]).optional()),
      maxDailyLossUnit: z.enum(["PCT", "USDT"]).optional(),
      /** With fixed USDT risk + max daily USDT and MULTIPLE pins (2+), divide per-trade notional by pin count. */
      capitalSplitAcrossCoins: z.boolean().optional(),
      /** Strategy pool cap (USDT). Fixed-USDT sizing uses only this (after wallet clamp); no fallback to `riskPerTrade`. */
      allowedBudgetUsdt: z.number().min(0).max(10_000_000).optional(),
      /** 0–100 of wallet equity when `allowedBudgetInputMode` is WALLET_PCT (UI sync). */
      allowedBudgetWalletPct: z.number().min(0).max(100).optional(),
      allowedBudgetInputMode: z.enum(["USDT", "WALLET_PCT"]).optional(),
      multiTradeUsePctOfUsable: z.boolean().optional(),
      multiTradePctOfUsable: z.number().min(0).max(100).optional(),
      /** UI-only: compound close + unrealized P&L into Capital allotment headline pool. */
      capitalAllotmentCompoundPnlUi: z.boolean().optional(),
      perTradeBudgetCapEnabled: z.boolean().optional(),
      /** USDT = `riskPerTrade` is margin cap; PCT_OF_USABLE = cap = that % of sized usable (after buffer). */
      perTradeBudgetInputMode: z.enum(["USDT", "PCT_OF_USABLE"]).optional(),
      /** MULTIPLE fixed-USDT: multi-budget splits vs per-trade cap path (mutually exclusive). */
      multiCoinCapitalSizingActive: z.boolean().optional(),
      multiBudgetSplitMode: z.enum(["FULL", "EQUAL", "CUSTOM_USDT", "CUSTOM_PCT_ALLOWED"]).optional(),
      multiBudgetCoinUsdt: z.record(z.string().regex(symbolRe), z.number().min(0).max(10_000_000)).optional(),
      multiBudgetCoinPct: z.record(z.string().regex(symbolRe), z.number().min(0).max(100)).optional(),
      strategyMode: z.enum(["AUTO", "MANUAL"]).optional(),
      manualStrategy: z.string().optional(),
      marketMode: z.enum(["SPOT", "FUTURES", "AUTO"]).optional(),
      futuresLeverageMode: z.enum(["AUTO", "MANUAL"]).optional(),
      futuresLeverage: z.number().int().min(1).max(100).optional(),
      supertrendSpotAuto: z.boolean().optional(),
      supertrendFuturesAuto: z.boolean().optional(),
      /** When true, Supertrend futures BUY enforces `supertrendFuturesMinAiProb`. When false, that gate is skipped (signal-based sizing). */
      supertrendFuturesAiConfidenceFilter: z.boolean().optional(),
      /** When true, Supertrend opening legs require composite strength ≥ `signalStrengthOpenMin` and matching BUY/SELL. Default off: strength is metrics-only. */
      signalStrengthGatesTrades: z.boolean().optional(),
      /** Min composite signal strength (0–100) for opens when `signalStrengthGatesTrades` is on. */
      signalStrengthOpenMin: z.number().int().min(0).max(100).optional(),
      /** When true, Supertrend (and backtest) opens pass `evaluateSupertrendMoveQuality` thresholds below. */
      supertrendMoveQualityGate: z.boolean().optional(),
      supertrendMoveQualityMinScore: z.number().min(0).max(1).optional(),
      supertrendMoveQualityMinAdx: z.number().int().min(0).max(100).optional(),
      supertrendMoveQualityMinMoveSlRatio: z.number().min(1).max(10).optional(),
      supertrendMoveQualityExpectedMoveAtrMult: z.number().min(0.05).max(10).optional(),
      supertrendMoveQualityMinAtrExpansion: z.number().min(0).max(5).optional(),
      supertrendMoveQualityMinBodyVsAvg: z.number().min(0.05).max(1).optional(),
      supertrendMoveQualityMinDirectionalBody: z.number().min(0).max(1).optional(),
      supertrendMoveQualityMinVolumeVsAvg: z.number().min(0).max(10).optional(),
      supertrendConfirmationGateEnabled: z.boolean().optional(),
      supertrendConfirmationMinAdx: z.number().min(0).max(100).optional(),
      supertrendConfirmationMinVolRatio: z.number().min(0).max(10).optional(),
      supertrendConfirmationMinBodyAtrRatio: z.number().min(0).max(3).optional(),
      supertrendConfirmationMaxAdverseWickFrac: z.number().min(0).max(3).optional(),
      supertrendConfirmationMaxDistFromStAtr: z.number().min(0).max(10).optional(),
      supertrendConfirmationRequireHtfAlign: z.boolean().optional(),
      supertrendConfirmationHtfPeriod: z.number().int().min(2).max(100).optional(),
      supertrendConfirmationHtfMultiplier: z.number().min(0.5).max(50).optional(),
      supertrendConfirmationHtfBarsPerStrategyBar: z.number().int().min(1).max(96).optional(),
      supertrendHtf4hEnabled: z.boolean().optional(),
      supertrendHtf4hPeriod: z.number().int().min(2).max(50).optional(),
      supertrendHtf4hMultiplier: z.number().min(0.5).max(20).optional(),
      volumeProfileEnabled: z.boolean().optional(),
      volumeProfileSoftGates: z.boolean().optional(),
      volumeProfileGatesEnabled: z.boolean().optional(),
      intradayVpBrackets: z.boolean().optional(),
      /** SR_INTRADAY / Intraday Pro per-technique toggles (default on when omitted). */
      intradayGateLiquidity: z.boolean().optional(),
      intradayGateSession: z.boolean().optional(),
      intradayGateFib: z.boolean().optional(),
      intradayGateVp: z.boolean().optional(),
      intradayGateOrderFlow: z.boolean().optional(),
      intradayOfKillzoneMode: z.enum(["LONDON", "NY", "LONDON_NY", "OVERLAP", "SILVER_BULLET", "ASIA", "ALL", "CUSTOM"]).optional(),
      intradayOfRequireKeyLevel: z.boolean().optional(),
      intradayOfRequireConfirmation: z.boolean().optional(),
      intradayOfMinStackBars: z.number().int().min(2).max(8).optional(),
      intradayOfMinConfluence: z.number().int().min(1).max(4).optional(),
      intradayOfUseOrderBook: z.boolean().optional(),
      intradayOfAllowProxy: z.boolean().optional(),
      intradayOfLevelProximityPct: z.number().min(0.0001).max(0.01).optional(),
      intradayOfDivergenceLookback: z.number().int().min(6).max(30).optional(),
      intradayOfAbsorptionVolMult: z.number().min(1.1).max(3).optional(),
      intradayOfAbsorptionRangeAtrMult: z.number().min(0.1).max(1).optional(),
      intradayOfStackDeltaRatio: z.number().min(0.2).max(0.8).optional(),
      intradayOfBookImbalanceMin: z.number().min(0.5).max(0.9).optional(),
      intradayOfSoloMinScore: z.number().min(1).max(20).optional(),
      intradayOfVetoMode: z.boolean().optional(),
      intradayOfMinPartialScore: z.number().min(1).max(20).optional(),
      intradayOfConfluenceMode: z.enum(["full", "layer3", "research"]).optional(),
      intradayOfAllowCvdOnly: z.boolean().optional(),
      intradayOfRequirePremiumDiscount: z.boolean().optional(),
      intradayOfTp1Enabled: z.boolean().optional(),
      intradayOfTp2Enabled: z.boolean().optional(),
      intradayOfPartialFrac: z.number().min(0.1).max(0.6).optional(),
      intradayOfMinRr: z.number().min(0).max(10).optional(),
      intradayOfBreakevenAfterPartial: z.boolean().optional(),
      intradayOfApproachLookback: z.number().int().min(3).max(20).optional(),
      intradayOfEntryAtSignalClose: z.boolean().optional(),
      intradayOfExitOnDeltaAgainst: z.boolean().optional(),
      intradayOfExitGraceBars: z.number().int().min(0).max(50).optional(),
      intradayOfExitMinDeltaRatio: z.number().min(0.2).max(0.9).optional(),
      intradayOfMaxHoldBars: z.number().int().min(0).max(2000).optional(),
      // Regime-adaptive strategy.
      regimeAdaptiveEnableTrend: z.boolean().optional(),
      regimeAdaptiveEnableRange: z.boolean().optional(),
      regimeAdaptiveEnableBreakout: z.boolean().optional(),
      regimeAdaptiveMinGrade: z.enum(["A", "B"]).optional(),
      regimeAdaptiveConfidenceFloor: z.number().min(0).max(1).optional(),
      regimeAdaptiveMaxTradesPerDay: z.number().int().min(1).max(20).optional(),
      regimeAdaptiveMinBarGap: z.number().int().min(0).max(100).optional(),
      regimeAdaptiveKillzoneMode: z.enum(["LONDON_NY", "ALL"]).optional(),
      regimeAdaptiveTrendRR: z.number().min(0.5).max(10).optional(),
      regimeAdaptiveRangeRR: z.number().min(0.5).max(10).optional(),
      regimeAdaptiveBreakoutRR: z.number().min(0.5).max(10).optional(),
      regimeAdaptiveAtrSlMult: z.number().min(0.1).max(5).optional(),
      regimeAdaptiveTrendAdx: z.number().min(10).max(60).optional(),
      regimeAdaptiveSqueezePctile: z.number().min(0.01).max(0.9).optional(),
      regimeAdaptiveVolatileAtrPct: z.number().min(0.002).max(0.1).optional(),
      // Institutional risk overlay.
      riskScale: z.number().min(0.1).max(5).optional(),
      volTargetSizing: z.boolean().optional(),
      volTargetAtrPct: z.number().min(0.0005).max(0.1).optional(),
      volTargetMaxMult: z.number().min(1).max(5).optional(),
      volTargetMinMult: z.number().min(0.05).max(1).optional(),
      riskKillSwitchDdPct: z.number().min(0).max(100).optional(),
      riskConsecutiveLossLimit: z.number().int().min(0).max(50).optional(),
      riskWeeklyMaxLossPct: z.number().min(0).max(100).optional(),
      intradaySmcUseOrderFlow: z.boolean().optional(),
      intradayGateHtfRegime: z.boolean().optional(),
      intradayGateInstitutionalSr: z.boolean().optional(),
      intradayGateSmcIct: z.boolean().optional(),
      intradaySmcIctMode: z.boolean().optional(),
      intradaySmcMinScore: z.number().min(1).max(20).optional(),
      intradaySmcIctProfile: z.enum(["full", "sweep", "ict2022", "lite", "balanced", "daily"]).optional(),
      intradaySmcPickMode: z.enum(["daily_sniper", "daily_best", "per_signal"]).optional(),
      intradaySmcOneTradePerDay: z.boolean().optional(),
      intradaySmcRequireHtfBias: z.boolean().optional(),
      intradaySmcChochStrict: z.boolean().optional(),
      intradaySmcRequirePremiumDiscount: z.boolean().optional(),
      intradaySmcPremiumDiscountOte: z.boolean().optional(),
      intradaySmcDealingRangeLookback: z.number().int().min(10).max(200).optional(),
      intradaySmcRequireMss: z.boolean().optional(),
      intradaySmcRequireRetrace: z.boolean().optional(),
      intradaySmcRequireChoch: z.boolean().optional(),
      intradaySmcRequireBos: z.boolean().optional(),
      intradaySmcRequireConfirm: z.boolean().optional(),
      intradaySmcLookbackBars: z.number().int().min(3).max(200).optional(),
      intradaySmcMinRr: z.number().min(0).max(10).optional(),
      intradaySmcBosMaxBars: z.number().int().min(1).max(20).optional(),
      intradaySmcChochMaxBars: z.number().int().min(1).max(30).optional(),
      intradaySmcEntryZoneMode: z.enum(["FVG", "OB", "EITHER"]).optional(),
      /** FVG CE (`midpoint`) vs full-zone retrace — required for frozen SMC research preset. */
      intradaySmcFvgEntryMode: z.enum(["midpoint", "ce", "zone"]).optional(),
      /** TP2 at internal swing vs opposing pool — required for frozen SMC research preset. */
      intradaySmcTp2Mode: z.enum(["internal", "opposing", "tiered"]).optional(),
      intradaySmcRequireFvgRetrace: z.boolean().optional(),
      intradaySmcKillzoneMode: z.enum(["LONDON", "NY", "LONDON_NY", "OVERLAP", "SILVER_BULLET", "ASIA", "ALL", "CUSTOM"]).optional(),
      intradaySmcMinAdx: z.number().min(0).max(100).optional(),
      intradaySmcHtfStrictness: z.enum(["both", "4h", "1h", "either"]).optional(),
      intradaySmcHtfBiasMode: z.enum(["ema", "structure", "parallel"]).optional(),
      intradaySmcSlMode: z.enum(["sweep", "structure"]).optional(),
      intradaySmcMaxTpRr: z.number().min(0).max(20).optional(),
      intradaySmcMaxHoldBars: z.number().int().min(0).max(2000).optional(),
      intradaySrAPlusMode: z.boolean().optional(),
      intradaySrMinVolRatio: z.number().min(0).max(5).optional(),
      intradaySrMinHtfSep: z.number().min(0).max(0.01).optional(),
      intradaySrZoneWidthPct: z.number().min(0.0001).max(0.02).optional(),
      intradaySrBosMaxBarsAfterReclaim: z.number().int().min(0).max(10).optional(),
      intradaySrMinConfirmWick: z.number().min(0).max(1).optional(),
      intradaySrRequireBos: z.boolean().optional(),
      intradaySrRequireConfirm: z.boolean().optional(),
      intradaySrRequireVolume: z.boolean().optional(),
      intradaySrRequireHtfTrend: z.boolean().optional(),
      intradayLiqTp1Enabled: z.boolean().optional(),
      intradayLiqTp2Enabled: z.boolean().optional(),
      intradayLiqBreakevenAfterPartial: z.boolean().optional(),
      intradayLiqPartialTp: z.boolean().optional(),
      intradayLiqMinRr: z.number().min(0).max(5).optional(),
      intradayLiqMaxTpRr: z.number().min(0).max(20).optional(),
      intradayLiqMaxHoldBars: z.number().int().min(0).max(2000).optional(),
      intradayLiqOnePickPerDay: z.boolean().optional(),
      intradayLiqSessionExtreme: z.boolean().optional(),
      intradayLiqMinSweepExtensionPct: z.number().min(0).max(0.05).optional(),
      intradayLiqStrictMode: z.boolean().optional(),
      srIntradayMaxTradesPerDay: z.number().int().min(1).max(50).optional(),
      srIntradayMinBarGap: z.number().int().min(1).max(100).optional(),
      srIntradayMinScore: z.number().min(1).max(20).optional(),
      intradayMinTechniqueCount: z.number().int().min(1).max(10).optional(),
      intradayRequireSessionReclaim: z.boolean().optional(),
      intradayRequireFibOrVp: z.boolean().optional(),
      intradayLearnedRulesEnabled: z.boolean().optional(),
      intradaySoloGateMinScore: z.number().min(1).max(20).optional(),
      intradayFibStrictMode: z.boolean().optional(),
      intradayFibConfirmNextBar: z.boolean().optional(),
      intradayFibRequireRsiAlign: z.boolean().optional(),
      intradayFibRequireHtfAlign: z.boolean().optional(),
      intradayFibMinScore: z.number().min(1).max(20).optional(),
      intradayFibTpMode: z.enum(["leg", "scalp", "partial_leg", "extension"]).optional(),
      intradayFibExtensionFrac: z.number().min(0.1).max(0.9).optional(),
      intradayFibBracketSource: z.enum(["signal", "ui_fixed", "scalp"]).optional(),
      intradayFibScalpTpPct: z.number().min(0.0005).max(0.05).optional(),
      intradayFibScalpSlPct: z.number().min(0.0005).max(0.02).optional(),
      intradayFibAllowedRatios: z.array(z.number().min(0.1).max(0.9)).optional(),
      intradayFibMinRetraceRatio: z.number().min(0.2).max(0.9).optional(),
      intradayFibMaxRetraceRatio: z.number().min(0.2).max(0.95).optional(),
      intradayFibMinWickRatio: z.number().min(0.1).max(1).optional(),
      intradayFibMinAdx: z.number().min(0).max(100).optional(),
      intradayFibMinLegAtrMult: z.number().min(0.5).max(10).optional(),
      intradayFibLookback: z.number().int().min(20).max(300).optional(),
      intradayFibLearnedRulesEnabled: z.boolean().optional(),
      intradayFibRequireRetraceCoherence: z.boolean().optional(),
      intradayFibGoldenRetraceMin: z.number().min(0.2).max(0.9).optional(),
      intradayFibGoldenRetraceMax: z.number().min(0.2).max(0.95).optional(),
      intradayFibMidRetraceMin: z.number().min(0.2).max(0.9).optional(),
      intradayFibMidRetraceMax: z.number().min(0.2).max(0.95).optional(),
      intradayFibGoldenScalpTpPct: z.number().min(0.0005).max(0.05).optional(),
      intradayFibGoldenScalpSlPct: z.number().min(0.0005).max(0.02).optional(),
      intradayFibMidScalpTpPct: z.number().min(0.0005).max(0.05).optional(),
      intradayFibMidScalpSlPct: z.number().min(0.0005).max(0.02).optional(),
      intradayFibMinHtfSep: z.number().min(0).max(0.01).optional(),
      intradayFibMaxBarsSinceSwing: z.number().int().min(8).max(80).optional(),
      intradayFibTolPct: z.number().min(0.0005).max(0.01).optional(),
      intradayFibMinRr: z.number().min(0.8).max(5).optional(),
      intradayFibMaxSlPct: z.number().min(0.0005).max(0.02).optional(),
      intradayFibMaxTpPct: z.number().min(0.0005).max(0.05).optional(),
      intradayFibEntryAtSignalClose: z.boolean().optional(),
      intradayTierMode: z.enum(["all", "A", "B"]).optional(),
      vpLookbackBars: z.number().int().min(48).max(2000).optional(),
      vpMinRR: z.number().min(0.8).max(5).optional(),
      // SUPERTREND_ELITE gate parameters
      eliteStRequireHtf4hAlign: z.boolean().optional(),
      eliteStHtf4hPeriod: z.number().int().min(2).max(50).optional(),
      eliteStHtf4hMultiplier: z.number().min(0.5).max(20).optional(),
      eliteStRequireHtf1hEmaAlign: z.boolean().optional(),
      eliteStHtf1hMinSep: z.number().min(0).max(1).optional(),
      eliteStHtf1hSepMode: z.enum(["FIXED", "ATR", "PERCENTILE", "ADX", "CALIBRATED"]).optional(),
      eliteStHtf1hMinSepAtrMult: z.number().min(0.05).max(2).optional(),
      eliteStHtf1hMinSepFloor: z.number().min(0).max(0.01).optional(),
      eliteStHtf1hMinSepCeil: z.number().min(0).max(0.01).optional(),
      eliteStHtf1hSepPercentileLookback: z.number().int().min(20).max(200).optional(),
      eliteStHtf1hSepPercentileMult: z.number().min(0.5).max(3).optional(),
      eliteStHtf1hSepAdxBase: z.number().min(0).max(0.01).optional(),
      eliteStHtf1hSepAdxAlpha: z.number().min(0).max(5).optional(),
      eliteStHtf1hSepAdxRef: z.number().int().min(1).max(100).optional(),
      eliteStHtf1hSepCalibratePct: z.number().int().min(1).max(99).optional(),
      eliteStHtf1hSepCalibrateBars: z.number().int().min(20).max(200).optional(),
      eliteStMinAdx: z.number().min(0).max(100).optional(),
      eliteStRequireAdxRising: z.boolean().optional(),
      eliteStAdxRisingLookback: z.number().int().min(1).max(20).optional(),
      eliteStMinVolumeVsAvg: z.number().min(0).max(10).optional(),
      eliteStRequireAtrExpansion: z.boolean().optional(),
      eliteStMinAtrExpansion: z.number().min(1).max(5).optional(),
      eliteStAtrExpansionLookback: z.number().int().min(2).max(50).optional(),
      eliteStLiqSweepEnabled: z.boolean().optional(),
      eliteStAutoCalibrate: z.boolean().optional(),
      eliteStAutoProfileBars: z.number().int().min(40).max(200).optional(),
      eliteStAutoBracketMode: z.enum(["ATR", "OFF", "FIXED"]).optional(),
      eliteStAutoMinAdxFloor: z.number().int().min(0).max(100).optional(),
      eliteStAutoMinAdxCeil: z.number().int().min(1).max(100).optional(),
      supertrendBigMoveGateEnabled: z.boolean().optional(),
      supertrendBigMoveMinStrength: z.number().min(0).max(100).optional(),
      supertrendBigMoveMinMoveSlRatio: z.number().min(0.5).max(10).optional(),
      supertrendBigMoveMinAdx: z.number().min(0).max(100).optional(),
      supertrendBigMoveMinScore: z.number().min(0).max(1).optional(),
      supertrendBigMoveMaxCandlesSinceFlip: z.number().int().min(0).max(20).optional(),
      supertrendBigMoveMinVolumeVsAvg: z.number().min(0).max(10).optional(),
      supertrendBigMoveExpectedMoveAtrMult: z.number().min(0.1).max(10).optional(),
      /** Defer entry until a bar closes beyond signal high/low (Supertrend paths). */
      supertrendBreakoutConfirm: z.boolean().optional(),
      supertrendBreakoutMaxBars: z.number().int().min(1).max(20).optional(),
      /** Min AI probability (0–1) for Supertrend futures opens when `supertrendFuturesAiConfidenceFilter` is on. */
      supertrendFuturesMinAiProb: z.number().min(0).max(1).optional(),
      /** Enable/disable SurfPulse ML gate for SURF_PULSE_ML opens. */
      surfPulseMlGateEnabled: z.boolean().optional(),
      /** Min SurfPulse XGBoost win probability (0–1) when strategy SURF_PULSE_ML is active. */
      surfPulseMlThreshold: z.number().min(0).max(1).optional(),
      /** When true, high-confidence opposing composite intelligence score can skip Supertrend opens. */
      intelligenceGateEnabled: z.boolean().optional(),
      intelligenceGateStrict: z.boolean().optional(),
      intelligenceGateHighWinRate: z.boolean().optional(),
      supertrendFuturesExitOnFlip: z.boolean().optional(),
      trailingStopLossAuto: z.boolean().optional(),
      /** `SUPERTREND` vs `FEE_LADDER` — see bot `futuresTrailingStopMode`. */
      futuresTrailingStopMode: z.enum(["SUPERTREND", "FEE_LADDER"]).optional(),
      /** Supertrend trailing: fee breakeven floor (default on). */
      futuresTrailingStFeeBreakeven: z.boolean().optional(),
      /** Supertrend trailing: follow chart Supertrend line (default on). */
      futuresTrailingStAdvanced: z.boolean().optional(),
      /** Up to 3 extra trailing locks after fee breakeven + fee-based first scalping; each % of entry (e.g. 0.5 = 0.5%). */
      trailingStopExtraScalpingPcts: z.array(z.number().min(0.01).max(5)).max(3).optional(),
      /** Fixed stop fraction of price (Supertrend futures). 0 = no fixed bracket (trail/ATR only). */
      supertrendFuturesFixedSlPct: z.number().min(0).max(0.2).optional(),
      /** Fixed take-profit fraction of price. 0 = no fixed TP (trail or flip exit only). */
      supertrendFuturesFixedTpPct: z.number().min(0).max(0.5).optional(),
      /** When false, Supertrend futures opens without fixed-% stop brackets. */
      supertrendFuturesUseFixedSl: z.boolean().optional(),
      /** When false, Supertrend futures opens without fixed-% take-profit brackets. */
      supertrendFuturesUseFixedTp: z.boolean().optional(),
      /** When true, Supertrend futures SELL opens short after closing long; BUY closes short then opens long. */
      supertrendFuturesTwoWay: z.boolean().optional(),
      /** Max adverse move vs signal candle close (percent points, e.g. 0.15 = 0.15%). 0 = off. */
      supertrendFuturesMaxEntrySlippagePct: z.number().min(0).max(5).optional(),
      /** AUTO = default (LIMIT_IOC if slippage > 0), else MARKET or LIMIT_IOC. */
      supertrendFuturesEntryOpenStyle: z.enum(["AUTO", "MARKET", "LIMIT_IOC"]).optional(),
      /** Delay before re-fetching book/mark and re-checking slippage (ms). */
      supertrendFuturesEntryRecheckMs: z.number().int().min(0).max(60_000).optional(),
      /** After IOC no-fill, optionally retry as MARKET if still within cap. */
      supertrendFuturesIocFallbackMarket: z.boolean().optional(),
      supertrendFuturesRequireMarkPrice: optionalBoolLoose,
      supertrendFuturesRequireBookTicker: optionalBoolLoose,
      /** Skip stale signals if bar-close→order delay exceeds this (ms). 0 = off. */
      supertrendFuturesMaxSignalLagMs: z.number().int().min(0).max(3_600_000).optional(),
      supertrendPeriod: z.number().int().min(2).max(100).optional(),
      supertrendMultiplier: z.number().min(0.5).max(20).optional(),
      supertrendWilderAtr: z.boolean().optional(),
      /** Futures trailing fee / buffer / distance (fractions; UI advanced trailing + fee ladder). */
      trailOpenFeeRate: z.number().min(0).max(0.01).optional(),
      trailCloseFeeRate: z.number().min(0).max(0.01).optional(),
      tradeHistoryMakerOpenFeeRate: z.number().min(0).max(0.01).optional(),
      tradeHistoryMakerCloseFeeRate: z.number().min(0).max(0.01).optional(),
      tradeHistoryTakerOpenFeeRate: z.number().min(0).max(0.01).optional(),
      tradeHistoryTakerCloseFeeRate: z.number().min(0).max(0.01).optional(),
      trailFeeBeMultiplier: z.number().min(1).max(2).optional(),
      trailBufferRate: z.number().min(0).max(0.05).optional(),
      trailActivationSlippageFrac: z.number().min(0).max(0.01).optional(),
      /** Tiered T01: SL lock offset from entry (fraction); LONG locks above entry. */
      trailT01LockSlippageFrac: z.number().min(0).max(0.01).optional(),
      trailBufferAtrMult: z.number().min(0).max(1).optional(),
      trailBufferMode: z.enum(["PERCENT", "ATR"]).optional(),
      /**
       * Independent activation buffer for post-T02 profit rungs (T1, T2, T3…). Fraction of price.
       * `null` clears to the T01/T02 buffer value (`trailBufferRate`). Decouples profit-rung pull-back
       * cushion from the fee-recovery (T01/T02) cushion.
       */
      trailPostT02ActivationBufferRate: z.union([z.number().min(0).max(0.05), z.null()]).optional(),
      trailMinSlDistFrac: z.number().min(0).max(0.1).optional(),
      /** Min |mark−SL|/mark for Supertrend trail (0 = off; e.g. 0.005 = 0.5%). */
      trailMinGapFromMarkFrac: z.number().min(0).max(0.2).optional(),
      trailMaintMarginRate: z.number().min(0).max(0.1).optional(),
      /** Tiered ST: spacing between post‑T02 lock rungs as fraction of entry; `null` clears to engine default. */
      trailPostT02SpacingFrac: z.union([z.number().min(0.00001).max(0.05), z.null()]).optional(),
      trailPostT02MaxExtraTiers: z.number().int().min(10).max(500).optional(),
      /** Lock AUTO universe to one symbol (table stays open in UI); null clears. */
      universePinnedSymbol: z.union([z.string().regex(symbolRe), z.null()]).optional(),
      /** Broad Binance universe + AI top-N vs custom watchlist (max 10 symbols). */
      universeCoinBase: z.enum(["ALL", "CUSTOM"]).optional(),
      universeCustomSymbols: z.array(z.string().regex(symbolRe)).max(10).optional(),
      /** SINGLE = one pin; MULTIPLE = up to 10 pins for auto-pick filtering. */
      universeCoinSelectMode: z.enum(["SINGLE", "MULTIPLE"]).optional(),
      /** AUTO = ranked pins UI read-only for bot; MANUAL = pins constrain auto-pick. */
      universePinControl: z.enum(["AUTO", "MANUAL"]).optional(),
      /** RANKED_AI_SS = universe rank (AI + opp); ST_SIGNAL_FIRST = walk list for first Supertrend bar-close signal. */
      universeAutoCoinPick: z.enum(["RANKED_AI_SS", "ST_SIGNAL_FIRST"]).optional(),
      universePinnedSymbols: z.array(z.string().regex(symbolRe)).max(10).optional(),
      /**
       * Ephemeral UI: main chart symbol in multi-coin mode (multiplex klines + WS `market`); null follows `symbol`.
       * Not persisted in bot-trading-config.json.
       */
      uiChartFocusSymbol: z.union([z.string().regex(symbolRe), z.null()]).optional(),
      /** Manual order form (persisted with bot settings). */
      tradingFormDefaults: z
        .object({
          amountUsdStr: z.string().max(32).optional(),
          slPctStr: z.string().max(32).optional(),
          tpPctStr: z.string().max(32).optional(),
          manualUseSl: z.boolean().optional(),
          manualUseTp: z.boolean().optional(),
        })
        .optional(),
      /** Market regime + signal-quality engine (merged with server defaults). */
      marketDecision: z.record(z.string(), z.unknown()).optional(),
      /** TREND_HTF_ST — macro regime gate (blocks ~50% entries; avoid for max return). */
      trendHtfStRegimeGate: z.boolean().optional(),
      /** Surgical chop-only loss filter (keeps trade count). */
      trendHtfStSurgicalLossFilter: z.boolean().optional(),
      trendHtfStQualityFilter: z.boolean().optional(),
      trendHtfStFlipExitBeforeSl: z.boolean().optional(),
      trendHtfStMaxEntryRangeAtr: z.number().min(0).max(10).optional(),
      trendHtfStMinHtfSep: z.number().min(0).max(0.05).optional(),
      trendHtfStRegimeTpTrend: z.number().min(0.0005).max(0.5).optional(),
      trendHtfStRegimeTpMixed: z.number().min(0.0005).max(0.5).optional(),
      trendHtfStRegimeTpChop: z.number().min(0.0005).max(0.5).optional(),
      backtestBreakevenAtMfePct: z.number().min(0).max(0.1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { mode: configTargetMode, ...patch } = parsed.data;
    const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    const chartFocusOnlyPatch = patchKeys.length === 1 && patchKeys[0] === "uiChartFocusSymbol";
    let row;
    try {
      row = await getEngineForBotRequest(req, configTargetMode);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
    let bot;
    try {
      bot = row.bot.updateConfig(patch);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
    if (!chartFocusOnlyPatch) {
      try {
        broadcastActivity(
          appState.wsHub,
          {
            level: "info",
            msg: "Bot configuration updated",
            category: "config",
            reason: "api_patch",
            detail: { ...patch, targetMode: configTargetMode ?? resolveViewTradingMode(req, undefined) },
            tradingMode: configTargetMode ?? resolveViewTradingMode(req, undefined),
          },
          { persistenceSlug: tradingModeToPersistenceSlug(String(configTargetMode ?? resolveViewTradingMode(req, undefined))) },
        );
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }

    // Auto-save to strategy versions is intentionally disabled.
    // Config edits are persisted to bot config, and explicit Save / Save-as-New actions
    // are handled by dedicated strategy save endpoints.
    // Match WS `state` shape so the UI doesn't drop account/positions until the next heartbeat.
    const ex = row.exchange;
    Promise.all([ex.getAccount().catch(() => null), ex.getPositions().catch(() => [])])
      .then(([account, positions]) => {
        const m = String(configTargetMode ?? resolveViewTradingMode(req, undefined)).toUpperCase();
        appState.wsHub?.broadcast("state", { mode: m, ...bot, account, positions });
      })
      .catch(() => {
        const m = String(configTargetMode ?? resolveViewTradingMode(req, undefined)).toUpperCase();
        appState.wsHub?.broadcast("state", { mode: m, ...bot, account: null, positions: [] });
      });
    res.json({ ok: true, bot, targetMode: configTargetMode ?? resolveViewTradingMode(req, undefined) });
  });

  /**
   * Analyze `mq-trade-outcomes.jsonl` for this trading mode and suggest / apply Move Quality thresholds
   * from winning-trade percentiles (see `mqTuneFromOutcomes.js`).
   */
  r.post("/bot/tune-move-quality", async (req, res) => {
    const schema = z.object({
      mode: BOT_TARGET_MODES.optional(),
      apply: z.boolean().optional(),
      minTrades: z.number().int().min(3).max(500).optional(),
      winPercentileFloor: z.number().min(5).max(50).optional(),
    });
    const parsed = schema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const row = await getEngineForBotRequest(req, parsed.data.mode);
      const viewM = resolveViewTradingMode(req, parsed.data.mode);
      const slug = tradingModeToPersistenceSlug(viewM);
      const { path: logPath, rows } = readMqTradeOutcomeRows(slug);
      const tuned = computeMqTuningPatch(rows, {
        minTrades: parsed.data.minTrades,
        winPercentileFloor: parsed.data.winPercentileFloor,
      });
      if (!tuned.ok) {
        return res.status(400).json({
          ok: false,
          ...tuned,
          logPath,
        });
      }
      const apply = parsed.data.apply !== false;
      if (apply) {
        row.bot.updateConfig(tuned.patch);
        broadcastActivity(
          appState.wsHub,
          {
            level: "info",
            msg: "Move quality tuned from your logged Supertrend trade outcomes",
            category: "config",
            reason: "mq_tune",
            detail: { patch: tuned.patch, n: tuned.n, nWins: tuned.nWins },
            tradingMode: viewM,
          },
          { persistenceSlug: slug },
        );
        const ex = row.exchange;
        Promise.all([ex.getAccount().catch(() => null), ex.getPositions().catch(() => [])])
          .then(([account, positions]) => {
            const m = String(viewM).toUpperCase();
            appState.wsHub?.broadcast("state", {
              mode: m,
              ...row.bot.getPublicState(),
              account,
              positions,
            });
          })
          .catch(() => {
            const m = String(viewM).toUpperCase();
            appState.wsHub?.broadcast("state", {
              mode: m,
              ...row.bot.getPublicState(),
              account: null,
              positions: [],
            });
          });
      }
      res.json({
        ok: true,
        apply,
        logPath,
        ...tuned,
        bot: row.bot.getPublicState(),
        targetMode: viewM,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Scan and rank coins (Binance only). Returns ranked list + selected top symbols.
  // ?refresh=1 forces a fresh scan (otherwise last cached snapshot may be returned).
  r.get("/universe/scan", async (req, res) => {
    try {
      const row = await getEngineForBotRequest(req, undefined);
      const force = String(req.query?.refresh || "") === "1";
      const out = await row.bot.getUniverseScan?.({ force });
      if (!out) return res.status(400).json({ ok: false, error: "universe_unavailable" });
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Tradable USDT symbols for the active spot/futures universe (custom coin-base picker). */
  r.get("/universe/symbols", async (req, res) => {
    try {
      const row = await getEngineForBotRequest(req, undefined);
      const out = await row.bot.listTradableUniverseSymbols?.();
      if (!out) return res.status(400).json({ ok: false, error: "universe_unavailable" });
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trade/manual", async (req, res) => {
    const schema = z.object({
      side: z.enum(["BUY", "SELL"]),
      amountUsd: z.number().positive(),
      stopLossPct: z.number().min(0.001).max(0.2).optional().nullable(),
      takeProfitPct: z.number().min(0.001).max(0.5).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    try {
      const row = await getEngineForBotRequest(req, undefined);
      const out = await row.bot.manualTrade({ wsHub: appState.wsHub, ...parsed.data });
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trade/close", async (req, res) => {
    const schema = z.object({ id: z.string().min(3) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    let row;
    try {
      row = await getEngineForBotRequest(req, undefined);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
    const ex = row.exchange;
    const viewM = resolveViewTradingMode(req, undefined);
    if (typeof ex?.closePosition !== "function") {
      return res.status(400).json({ ok: false, error: "close_not_supported" });
    }
    const candles = row.bot.feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) return res.status(400).json({ ok: false, error: "no_market_data" });
    try {
      const notifyActivity = (partial) =>
        broadcastActivity(
          appState.wsHub,
          {
            category: partial.category || "risk",
            level: partial.level || "info",
            ...partial,
            tradingMode: viewM,
          },
          { persistenceSlug: tradingModeToPersistenceSlug(viewM) },
        );
      const out = await ex.closePosition({
        id: parsed.data.id,
        price: Number(last.close),
        notifyActivity,
      });
      if (!out || out.ok === false || out.error) {
        return res.status(400).json(out ?? { ok: false, error: "close_failed" });
      }
      try {
        await broadcastMergedTradesSnapshot(req, undefined);
      } catch {
        /* WS snapshot is best-effort; client may POST /trade/refresh */
      }
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trade/refresh", async (req, res) => {
    try {
      const { count } = await broadcastMergedTradesSnapshot(req, undefined, { forceReconcile: true });
      res.json({ ok: true, count });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/mode/set", async (req, res) => {
    const parsed = modeSetBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      return res.status(400).json({
        ok: false,
        error: `mode_set_invalid_body:${JSON.stringify(fieldErrors)}`,
      });
    }
    const next = normalizeTradingMode(parsed.data.mode);
    try {
      await appState.ensureEngine(next);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
    if (uiAuthEnabled() && req.session?.uiAuthOk) {
      req.session.uiTradingMode = next;
      return req.session.save((err) => {
        if (err) return res.status(500).json({ ok: false, error: "session_save_failed" });
        try {
          appState.wsHub?.notifySessionTradingMode?.(req.sessionID, next);
        } catch {
          /* ignore */
        }
        return res.json({ ok: true, mode: next, scope: "session" });
      });
    }
    try {
      const out = await appState.setMode(next);
      return res.json({ ...out, scope: "server" });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies", async (req, res) => {
    const row = await getEngineForBotRequest(req, undefined);
    res.json({ ok: true, strategies: row.bot.getPublicState().topStrategies });
  });

  r.get("/trading/evaluation", async (req, res) => {
    const row = await getEngineForBotRequest(req, undefined);
    const viewM = resolveViewTradingMode(req, undefined);
    res.json(
      getTradingEvaluationChecklist({
        mode: viewM,
        bot: row.bot.getPublicState(),
      })
    );
  });

  r.get("/backtest", async (req, res) => {
    const row = await getEngineForBotRequest(req, undefined);
    const limit = Math.max(200, Math.min(1500, Number(req.query.limit || 600)));
    const feeBps = Math.max(0, Math.min(50, Number(req.query.feeBps || 10)));
    const slippageBps = Math.max(0, Math.min(50, Number(req.query.slippageBps || 3)));
    const candles = row.bot.feed.getCandles().slice(-limit);
    if (!candles?.length) return res.status(400).json({ ok: false, error: "no_candles" });
    const results = runBacktest({ candles, feeBps, slippageBps });
    res.json({
      ok: true,
      symbol: row.bot.getPublicState().symbol,
      timeframe: row.bot.getPublicState().timeframe,
      limit,
      feeBps,
      slippageBps,
      results,
    });
  });

  r.post("/paper/reset", async (req, res) => {
    const schema = z.object({ confirm: z.literal(true) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "confirm_required" });
    const row = await getEngineForBotRequest(req, undefined);
    if (row.exchange?.name !== "paper") return res.status(400).json({ ok: false, error: "not_paper_mode" });
    const out = await row.exchange.reset({ confirm: true });
    return res.json(out);
  });

  const accountUuid = z.string().uuid();
  const credentialsBody = z.object({
    apiKey: z.string().min(1).max(4000),
    secret: z.string().min(1).max(4000),
  });
  const createAccountBody = z.object({
    label: z.string().min(1).max(200),
    accountType: z.enum(["main", "sub"]),
    binanceUid: z.string().max(100).optional(),
    notes: z.string().max(4000).optional(),
  });
  const patchAccountBody = z.object({
    label: z.string().min(1).max(200).optional(),
    notes: z.string().max(4000).optional().nullable(),
    binance_uid: z.string().max(100).optional().nullable(),
  });

  r.get("/trading-modes/:modeSlug/accounts", requireAccountsDbUser, async (req, res) => {
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
      if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
      const accounts = await accountsService.getAllAccountsForMode(modeSlug, ownerId);
      res.json({ ok: true, accounts });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.post("/trading-modes/:modeSlug/accounts", requireAccountsDbUser, async (req, res) => {
    const parsed = createAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body" });
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
      if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
      const acc = await accountsService.createAccount(modeSlug, ownerId, {
        label: parsed.data.label,
        accountType: parsed.data.accountType,
        binanceUid: parsed.data.binanceUid,
        notes: parsed.data.notes,
      });
      res.json({ ok: true, account: acc });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "paper_accounts_not_user_created") {
        return res.status(400).json({ ok: false, error: "paper_read_only" });
      }
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  const setActiveAccountBody = z.object({ accountId: z.string().uuid() });

  r.post("/trading-modes/:modeSlug/active-account", requireAccountsDbUser, async (req, res) => {
    const parsed = setActiveAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body" });
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
      if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
      if (modeSlug === "paper") {
        return res.status(400).json({ ok: false, error: "paper_no_active_account" });
      }
      const accessRow = await accountsService.getAccountAccessRow(parsed.data.accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(vis === "not_found" ? 404 : 403).json({ ok: false, error: vis });
      if (String(accessRow.mode_slug || "") !== modeSlug) {
        return res.status(400).json({ ok: false, error: "account_mode_mismatch" });
      }
      if (accessRow.requires_api === false) {
        return res.status(400).json({ ok: false, error: "account_does_not_use_api_keys" });
      }
      const merged = await usersService.mergeUiPrefsForUser(ownerId, {
        activeAccountByMode: { [modeSlug]: parsed.data.accountId },
      });
      // Rebuild the engine only when the account actually changes — this swaps in the new credentials
      // without destroying a running engine unnecessarily on repeated auto-selects of the same account.
      const prevActiveAccount = appState.getActiveAccount?.(modeSlug) ?? null;
      const accountChanged = prevActiveAccount !== parsed.data.accountId;
      appState.setActiveAccount(modeSlug, parsed.data.accountId, { rebuildEngine: accountChanged });
      const snap =
        merged && typeof merged === "object" && merged.activeAccountByMode && typeof merged.activeAccountByMode === "object"
          ? merged.activeAccountByMode
          : appState.getActiveAccountByModeSnapshot();
      res.json({ ok: true, activeAccountByMode: snap });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.patch("/accounts/:accountId", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    const parsed = patchAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body" });
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(403).json({ ok: false, error: "forbidden" });
      const mut = assertAccountMutable(req, accessRow, ownerId);
      if (mut) {
        const code = mut === "system_readonly" ? "system_readonly" : "forbidden";
        return res.status(mut === "system_readonly" ? 400 : 403).json({ ok: false, error: code });
      }
      const acc = await accountsService.updateAccount(accountId, parsed.data);
      res.json({ ok: true, account: acc });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.delete("/accounts/:accountId", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(403).json({ ok: false, error: "forbidden" });
      const mut = assertAccountMutable(req, accessRow, ownerId);
      if (mut) {
        const code = mut === "system_readonly" ? "system_readonly" : "forbidden";
        return res.status(mut === "system_readonly" ? 400 : 403).json({ ok: false, error: code });
      }
      const out = await accountsService.deactivateAccount(accountId);
      res.json({ ok: true, ...out });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.get("/accounts/:accountId/wallet/history", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(vis === "not_found" ? 404 : 403).json({ ok: false, error: vis });
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
      const rows = await getSnapshotHistory(accountId, limit);
      res.json({ ok: true, rows });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.get("/accounts/:accountId/credentials", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(403).json({ ok: false, error: "forbidden" });
      if (accessRow.requires_api === false) {
        return res.json({ ok: true, meta: null });
      }
      const row = await credentialsService.getCredentials(accountId);
      if (!row) return res.json({ ok: true, meta: null });
      res.json({
        ok: true,
        meta: {
          id: row.id,
          apiKey: accountsService.maskApiKey(String(row.api_key || "")),
          isActive: row.is_active,
          lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
          permissions: row.permissions != null && typeof row.permissions === "object" ? row.permissions : null,
        },
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.post("/accounts/:accountId/credentials", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    const parsed = credentialsBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body" });
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(403).json({ ok: false, error: "forbidden" });
      const mut = assertAccountMutable(req, accessRow, ownerId);
      if (mut) {
        const code = mut === "system_readonly" ? "system_readonly" : "forbidden";
        return res.status(mut === "system_readonly" ? 400 : 403).json({ ok: false, error: code });
      }
      if (accessRow.requires_api === false) {
        return res.status(400).json({ ok: false, error: "credentials_not_applicable" });
      }
      const row = await credentialsService.addCredentials(accountId, parsed.data.apiKey, parsed.data.secret);
      res.json({
        ok: true,
        credential: {
          id: row.id,
          account_id: row.account_id,
          api_key: accountsService.maskApiKey(String(row.api_key || "")),
          encryption_ver: row.encryption_ver,
          permissions: row.permissions ?? null,
          last_verified_at: row.last_verified_at ?? null,
          is_active: row.is_active,
          created_at: row.created_at,
        },
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("API_CREDENTIALS_ENCRYPTION_KEY")) {
        return res.status(503).json({ ok: false, error: "encryption_not_configured" });
      }
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.delete("/accounts/:accountId/credentials", requireAccountsDbUser, async (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountUuid.safeParse(accountId).success) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
      const ownerId = await resolveAccountsOwnerUserId(req, res);
      if (!ownerId) return;
      const accessRow = await accountsService.getAccountAccessRow(accountId);
      if (!accessRow) return res.status(404).json({ ok: false, error: "account_not_found" });
      const vis = assertAccountVisible(req, accessRow, ownerId);
      if (vis) return res.status(403).json({ ok: false, error: "forbidden" });
      const mut = assertAccountMutable(req, accessRow, ownerId);
      if (mut) {
        const code = mut === "system_readonly" ? "system_readonly" : "forbidden";
        return res.status(mut === "system_readonly" ? 400 : 403).json({ ok: false, error: code });
      }
      if (accessRow.requires_api === false) {
        return res.status(400).json({ ok: false, error: "credentials_not_applicable" });
      }
      const out = await credentialsService.revokeCredentials(accountId);
      res.json({ ok: true, ...out });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.get("/trading-modes/:modeSlug/strategies", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const includeArchived = String(req.query?.includeArchived || "") === "1";
    try {
      const uid = effectiveSessionUserId(req);
      let strategies = await strategyService.listStrategiesWithLatest(uid, {
        includeArchived,
      });
      if (!strategies.length) {
        const fileRaw = readBotTradingConfig(modeSlug);
        const configRaw =
          fileRaw && typeof fileRaw === "object"
            ? fileRaw
            : { v: 1, bot: {}, tradingFormDefaults: { amountUsdStr: "", slPctStr: "", tpPctStr: "" } };
        const def = await strategyService.createStrategy(
          uid,
          null,
          "Default Strategy",
          "Default starter strategy. Use Save As New to branch.",
          ["default-strategy", "auto-migrated"],
        );
        if (def?.id) {
          await strategyService.createVersion(def.id, uid, configRaw, "v1 — starter", null);
          strategies = await strategyService.listStrategiesWithLatest(uid, {
            includeArchived,
          });
        }
      }
      res.json({ ok: true, strategies });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trading-modes/:modeSlug/strategies", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(4000).optional().nullable(),
      tags: z.array(z.string().max(64)).max(48).optional(),
    });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const fileRaw = readBotTradingConfig(modeSlug);
      const configRaw =
        fileRaw && typeof fileRaw === "object"
          ? fileRaw
          : { v: 1, bot: {}, tradingFormDefaults: { amountUsdStr: "", slPctStr: "", tpPctStr: "" } };
      const strategy = await strategyService.createStrategy(
        effectiveSessionUserId(req),
        null,
        parsed.data.name,
        parsed.data.description ?? null,
        parsed.data.tags ?? [],
      );
      if (!strategy) {
        return res.status(500).json({ ok: false, error: "create_strategy_failed" });
      }
      const version = await strategyService.createVersion(
        strategy.id,
        effectiveSessionUserId(req),
        configRaw,
        "v1 — cloned from current",
        null,
      );
      res.json({ ok: true, strategy, version });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/trading-modes/:modeSlug/active-strategy", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    const versionId = appState.getActiveStrategyVersion?.(modeSlug) ?? null;
    res.json({ ok: true, modeSlug, versionId });
  });

  r.post("/trading-modes/:modeSlug/active-strategy", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({ versionId: z.string().uuid() });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const st = await strategyService.getStrategyByVersionId(parsed.data.versionId);
      if (!st || st.userId !== effectiveSessionUserId(req)) {
        return res.status(404).json({ ok: false, error: "version_not_found" });
      }
      appState.setActiveStrategyVersion(modeSlug, parsed.data.versionId);
      await usersService.mergeUiPrefsForUser(effectiveSessionUserId(req), {
        activeStrategyVersionByMode: { [modeSlug]: parsed.data.versionId },
      });
      res.json({ ok: true, modeSlug, versionId: parsed.data.versionId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trading-modes/:modeSlug/strategy-config/save", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({
      action: z.enum(["save", "save_as_new"]),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).optional().nullable(),
      tags: z.array(z.string().max(64)).max(48).optional(),
      label: z.string().max(200).optional().nullable(),
    });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const uid = effectiveSessionUserId(req);
      // Mode-level active strategy may be unset when the user only selects an instance
      // (instance tab drives engine binding). Fall back to the instance's bound version.
      let activeVid = appState.getActiveStrategyVersion?.(modeSlug) ?? null;
      if (!activeVid) {
        const iid = appState.getActiveInstance?.(modeSlug) ?? null;
        if (iid) {
          try {
            const bind = await instanceService.getInstanceEngineBinding(String(iid));
            if (bind && !bind.isDeleted && String(bind.accountModeSlug || "") === String(modeSlug)) {
              activeVid = bind.strategyVersionId ?? null;
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (!activeVid) return res.status(400).json({ ok: false, error: "no_active_strategy_version" });
      const st = await strategyService.getStrategyByVersionId(activeVid);
      if (!st || st.userId !== uid) return res.status(404).json({ ok: false, error: "active_strategy_not_found" });
      const row = await getEngineForBotRequest(req);
      const payload = row?.bot?.getTradingConfigPersistPayload?.();
      if (!payload || typeof payload !== "object") {
        return res.status(500).json({ ok: false, error: "config_snapshot_unavailable" });
      }
      const rawSaveBody = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const labelForSaveAsNew =
        parsed.data.label != null && String(parsed.data.label).trim() !== ""
          ? String(parsed.data.label)
          : "v1 — save as new";
      /** `undefined` = leave DB `label` unchanged (in-place save). */
      const labelForInPlaceSave = Object.prototype.hasOwnProperty.call(rawSaveBody, "label")
        ? parsed.data.label == null
          ? null
          : String(parsed.data.label)
        : undefined;

      // Strategy version stores SIGNAL-BRAIN only (createVersion strips inst_* fields
      // from cfg_raw automatically). Instance-owned operational fields are routed to
      // the active instance below so a single "Save" persists both sides correctly.
      const instanceOpCols = (() => {
        const inst = extractInstanceConfig(payload);
        // Drop capital fields here — they are managed via capital_allotments + the
        // dedicated allotment endpoint. The non-capital inst_* fields (symbol,
        // timeframe, market mode, universe, risk) are safe to mirror onto the row.
        const { inst_capital_mode: _a, inst_capital_usdt: _b, inst_capital_pct: _c, ...rest } = inst;
        return rest;
      })();
      const activeInstanceId = appState.getActiveInstance?.(modeSlug) ?? null;
      const persistInstanceOverrides = async () => {
        if (!activeInstanceId) return;
        try {
          await instanceService.updateInstanceOperationalConfig(
            String(activeInstanceId),
            uid,
            instanceOpCols,
          );
        } catch (e) {
          // Non-fatal — the strategy save itself succeeded.
          // eslint-disable-next-line no-console
          console.warn("instance_operational_config_persist_failed", String(e?.message || e));
        }
      };

      if (parsed.data.action === "save") {
        const nv = await strategyService.updateVersion(activeVid, uid, payload, labelForInPlaceSave);
        if (!nv) return res.status(500).json({ ok: false, error: "strategy_version_update_failed" });
        appState.setActiveStrategyVersion(modeSlug, nv.id, { rebuildEngine: false });
        const postSave = [
          usersService.mergeUiPrefsForUser(uid, {
            activeStrategyVersionByMode: { [modeSlug]: nv.id },
          }),
          persistInstanceOverrides(),
        ];
        if (activeInstanceId) {
          postSave.push(
            instanceService
              .updateInstanceStrategyVersion(String(activeInstanceId), uid, String(nv.id))
              .catch((e) => {
                // eslint-disable-next-line no-console
                console.warn("instance_strategy_version_update_failed", String(e?.message || e));
              }),
          );
        }
        await Promise.all(postSave);
        return res.json({ ok: true, action: "save", strategy: st, version: nv });
      }
      const name = String(parsed.data.name || "").trim() || `${st.name} copy`;
      const newStrategy = await strategyService.createStrategy(
        uid,
        null,
        name,
        parsed.data.description ?? st.description ?? null,
        Array.isArray(parsed.data.tags) ? parsed.data.tags : st.tags ?? [],
      );
      if (!newStrategy) return res.status(500).json({ ok: false, error: "create_strategy_failed" });
      const nv = await strategyService.createVersion(newStrategy.id, uid, payload, labelForSaveAsNew, activeVid);
      appState.setActiveStrategyVersion(modeSlug, nv.id, { rebuildEngine: false });
      const postSaveNew = [
        usersService.mergeUiPrefsForUser(uid, {
          activeStrategyVersionByMode: { [modeSlug]: nv.id },
        }),
        persistInstanceOverrides(),
      ];
      if (activeInstanceId) {
        postSaveNew.push(
          instanceService
            .updateInstanceStrategyVersion(String(activeInstanceId), uid, String(nv.id))
            .catch((e) => {
              // eslint-disable-next-line no-console
              console.warn("instance_strategy_version_update_failed", String(e?.message || e));
            }),
        );
      }
      await Promise.all(postSaveNew);
      return res.json({ ok: true, action: "save_as_new", strategy: newStrategy, version: nv });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Operational overrides accepted at instance creation / update. All optional;
   *  any field omitted falls back to the strategy version's stored default. */
  const operationalOverridesShape = z
    .object({
      symbol: z.string().min(1).max(64).nullable(),
      timeframe: z.string().min(1).max(8).nullable(),
      symbolMode: z.string().min(1).max(32).nullable(),
      marketMode: z.string().min(1).max(32).nullable(),
      universe: z.record(z.unknown()).nullable(),
      riskPerTrade: z.number().nullable(),
      riskUnit: z.string().min(1).max(8).nullable(),
      maxDailyLoss: z.number().nullable(),
      maxDailyLossUnit: z.string().min(1).max(8).nullable(),
      compoundPnl: z.boolean().nullable(),
    })
    .partial();

  /** UI-shape → service-shape (`inst_*` keys) */
  function operationalToInstColumns(op) {
    if (!op || typeof op !== "object") return {};
    const out = {};
    if ("symbol" in op) out.inst_symbol = op.symbol;
    if ("timeframe" in op) out.inst_timeframe = op.timeframe;
    if ("symbolMode" in op) out.inst_symbol_mode = op.symbolMode;
    if ("marketMode" in op) out.inst_market_mode = op.marketMode;
    if ("universe" in op) out.inst_universe = op.universe;
    if ("riskPerTrade" in op) out.inst_risk_per_trade = op.riskPerTrade;
    if ("riskUnit" in op) out.inst_risk_unit = op.riskUnit;
    if ("maxDailyLoss" in op) out.inst_max_daily_loss = op.maxDailyLoss;
    if ("maxDailyLossUnit" in op) out.inst_max_daily_loss_unit = op.maxDailyLossUnit;
    if ("compoundPnl" in op) out.inst_compound_pnl = op.compoundPnl;
    return out;
  }

  const createInstanceBody = z
    .object({
      strategyVersionId: z.string().uuid(),
      label: z.string().min(1).max(200),
      capitalMode: z.enum(["FIXED", "PCT"]),
      capitalUsdt: z.number().nonnegative().nullable().optional(),
      capitalPct: z.number().min(0).max(100).nullable().optional(),
      operational: operationalOverridesShape.optional(),
    })
    .superRefine((data, ctx) => {
      if (data.capitalMode === "FIXED") {
        const v = data.capitalUsdt;
        if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "capitalUsdt_required", path: ["capitalUsdt"] });
        }
      } else {
        const p = data.capitalPct;
        if (p == null || !Number.isFinite(Number(p)) || Number(p) <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "capitalPct_required", path: ["capitalPct"] });
        }
      }
    });

  r.get("/trading-modes/:modeSlug/instances", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const rows = await instanceService.listInstancesForMode(effectiveSessionUserId(req), modeSlug);
      res.json({ ok: true, modeSlug, instances: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/trading-modes/:modeSlug/allotment-headroom", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      let accountId;
      /** @type {string | null} */
      let snapshotWarmupErr = null;
      if (modeSlug === "paper") {
        accountId = await getPaperSystemAccountId();
        if (!accountId) return res.status(503).json({ ok: false, error: "paper_account_missing" });
      } else {
        accountId = appState.getActiveAccount(modeSlug);
        if (!accountId) {
          return res.status(400).json({ ok: false, error: "no_account_selected", message: "Select an account for this mode" });
        }
      }
      // New account/key wiring path: if snapshot is missing, fetch account immediately and persist one.
      // This avoids a UX dead-end ("No wallet snapshot yet") before the periodic poller/WS writes first row.
      const latest = await getLatestSnapshot(String(accountId));
      if (!latest) {
        try {
          const tm = normalizeTradingMode(persistenceSlugToTradingMode(modeSlug));
          await appState.ensureEngine(tm);
          const row = appState.getEngine(tm);
          const ex = row?.exchange;
          if (ex && typeof ex.getAccount === "function") {
            const account = await ex.getAccount().catch(() => null);
            const positions = typeof ex?.getPositions === "function" ? await ex.getPositions().catch(() => []) : [];
            if (account != null) {
              await writeSnapshot(String(accountId), "scheduled", account, Array.isArray(positions) ? positions : []);
            }
          }
        } catch (e) {
          snapshotWarmupErr = String(e?.message || e);
        }
      }
      const afterWarmup = latest ? latest : await getLatestSnapshot(String(accountId));
      if (!afterWarmup && snapshotWarmupErr) {
        return res.status(502).json({
          ok: false,
          error: "account_fetch_failed",
          message: snapshotWarmupErr,
        });
      }
      const headroom = await getAccountAllotmentHeadroom(String(accountId));
      res.json({ ok: true, modeSlug, accountId: String(accountId), headroom });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trading-modes/:modeSlug/instances", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const parsed = createInstanceBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      let accountId;
      if (modeSlug === "paper") {
        accountId = await getPaperSystemAccountId();
        if (!accountId) return res.status(503).json({ ok: false, error: "paper_account_missing" });
      } else {
        accountId = appState.getActiveAccount(modeSlug);
        if (!accountId) {
          return res.status(400).json({
            ok: false,
            error: "no_account_selected",
            message: "Select an account before creating an instance in this mode",
          });
        }
      }
      const inst = await instanceService.createInstance(
        effectiveSessionUserId(req),
        modeSlug,
        String(accountId),
        parsed.data.strategyVersionId,
        parsed.data.label,
        parsed.data.capitalMode,
        parsed.data.capitalUsdt ?? null,
        parsed.data.capitalPct ?? null,
        operationalToInstColumns(parsed.data.operational ?? {}),
      );
      res.json({ ok: true, instance: inst });
    } catch (e) {
      if (e instanceof instanceService.ModesMismatchError) {
        return res.status(400).json({ ok: false, error: e.code, message: e.message });
      }
      if (e instanceof InsufficientCapitalError) {
        return res.status(400).json({ ok: false, error: e.code, message: String(e.message || e.code) });
      }
      const msg = String(e?.message || e);
      if (msg === "strategy_version_not_found" || msg === "account_not_found") {
        return res.status(404).json({ ok: false, error: msg });
      }
      if (msg === "account_forbidden") return res.status(403).json({ ok: false, error: msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.get("/trading-modes/:modeSlug/active-instance", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    const instanceId = appState.getActiveInstance?.(modeSlug) ?? null;
    res.json({ ok: true, modeSlug, instanceId });
  });

  r.post("/trading-modes/:modeSlug/active-instance", requireDbUserSession, async (req, res) => {
    const modeSlug = normalizeModeSlugParam(req.params.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({ instanceId: z.string().uuid().nullable() });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const instanceId = parsed.data.instanceId;
    try {
      // Tab selection should not stop/recreate the running mode engine.
      appState.setActiveInstance(modeSlug, instanceId, { rebuildEngine: false });
      if (instanceId) {
        // Validate ownership/mode only; selecting an instance must not mutate mode-level
        // account/strategy bindings (that can silently swap API credentials).
        await instanceService.assertInstanceMatchesMode(String(instanceId), effectiveSessionUserId(req), modeSlug);
        await usersService.mergeUiPrefsForUser(effectiveSessionUserId(req), {
          activeInstanceByMode: { [modeSlug]: instanceId },
        });
      } else {
        await usersService.mergeUiPrefsForUser(effectiveSessionUserId(req), {
          activeInstanceByMode: { [modeSlug]: null },
        });
      }
      res.json({
        ok: true,
        modeSlug,
        instanceId,
        activeAccountByMode: appState.getActiveAccountByModeSnapshot(),
        activeStrategyVersionByMode: appState.getActiveStrategyVersionByModeSnapshot(),
      });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      const msg = String(e?.message || e);
      if (msg === "instance_mode_mismatch") return res.status(400).json({ ok: false, error: msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.get("/instances/:instanceId", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const inst = await instanceService.getInstanceDetail(instanceId, effectiveSessionUserId(req));
      if (!inst) return res.status(404).json({ ok: false, error: "instance_not_found" });
      res.json({ ok: true, instance: inst });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * Patch the operational (instance-side) config — symbol/timeframe/risk/capital/etc.
   * The signal brain (strategy) is updated via /trading-modes/:mode/strategy-config/save.
   * Capital allotment values flow through the existing capital-allotment service in
   * a follow-up endpoint; this PATCH only updates the instance-owned defaults.
   */
  r.patch("/instances/:instanceId/operational-config", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const parsed = operationalOverridesShape.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const cols = operationalToInstColumns(parsed.data);
      const detail = await instanceService.updateInstanceOperationalConfig(
        instanceId,
        effectiveSessionUserId(req),
        cols,
      );
      if (!detail) return res.status(404).json({ ok: false, error: "instance_not_found" });
      res.json({ ok: true, instance: detail });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.patch("/instances/:instanceId", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({ label: z.string().min(1).max(200) });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const inst = await instanceService.updateInstanceLabel(instanceId, effectiveSessionUserId(req), parsed.data.label);
      res.json({ ok: true, instance: inst });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete("/instances/:instanceId", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      await instanceService.deleteInstance(instanceId, effectiveSessionUserId(req));
      for (const slug of ["paper", "demo_api", "testnet", "live"]) {
        if (appState.getActiveInstance?.(slug) === instanceId) {
          appState.setActiveInstance(slug, null, { rebuildEngine: false });
          await usersService.mergeUiPrefsForUser(effectiveSessionUserId(req), { activeInstanceByMode: { [slug]: null } });
        }
      }
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      if (e instanceof instanceService.InstanceNotStoppedError) {
        return res.status(400).json({ ok: false, error: e.code, message: "Stop the bot before deleting" });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/instances/:instanceId/status-log", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    try {
      const log = await instanceService.getStatusLog(instanceId, effectiveSessionUserId(req), lim);
      res.json({ ok: true, entries: log });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/instances/:instanceId/trades", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const status = req.query.status != null && String(req.query.status).trim() ? String(req.query.status).trim() : undefined;
    try {
      await instanceService.assertInstanceOwned(instanceId, effectiveSessionUserId(req));
      const trades = await tradeService.getTradesForInstance(instanceId, { limit, offset, status });
      res.json({ ok: true, trades, limit, offset });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/instances/:instanceId/signals", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const we = req.query.wasExecuted;
    const wasExecuted = we === "true" ? true : we === "false" ? false : undefined;
    try {
      await instanceService.assertInstanceOwned(instanceId, effectiveSessionUserId(req));
      const signals = await tradeService.getSignalsForInstance(instanceId, { limit, wasExecuted });
      res.json({ ok: true, signals, limit });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/trades/:tradeId", requireDbUserSession, async (req, res) => {
    const tradeId = String(req.params.tradeId || "");
    if (!z.string().uuid().safeParse(tradeId).success) {
      return res.status(400).json({ ok: false, error: "invalid_trade_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const row = await tradeService.getTradeById(tradeId);
      if (!row) return res.status(404).json({ ok: false, error: "trade_not_found" });
      await instanceService.assertInstanceOwned(String(row.instanceId), effectiveSessionUserId(req));
      res.json({ ok: true, trade: row });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/instances/:instanceId/clear-error", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const uid = effectiveSessionUserId(req);
    try {
      const preview = await instanceService.getInstanceDetail(instanceId, uid);
      if (!preview) {
        return res.status(404).json({ ok: false, error: "instance_not_found" });
      }
      if (String(preview.status || "").toLowerCase() !== "error") {
        return res.status(400).json({ ok: false, error: "not_in_error_state" });
      }
      const slug = preview.accountModeSlug != null ? String(preview.accountModeSlug).toLowerCase() : "";
      if (!slug) {
        return res.status(400).json({ ok: false, error: "instance_mode_unknown" });
      }
      const tm = persistenceSlugToTradingMode(slug);
      await appState.ensureEngine(tm);
      const eng = appState.getEngine(tm);
      if (eng?.bot?.getPublicState?.()?.running) {
        return res.status(400).json({ ok: false, error: "bot_still_running" });
      }
      const inst = await instanceService.clearInstanceError(instanceId, uid);
      await broadcastInstanceStatusFromDetail(instanceId, uid, {
        reason: "Error cleared by user",
        triggeredBy: "user",
      });
      res.json({ ok: true, instance: inst });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      const msg = String(e?.message || e);
      if (msg === "not_in_error_state") return res.status(400).json({ ok: false, error: msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.post("/instances/:instanceId/pause", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const uid = effectiveSessionUserId(req);
    try {
      const inst0 = await instanceService.getInstanceDetail(instanceId, uid);
      if (!inst0) return res.status(404).json({ ok: false, error: "instance_not_found" });
      const slug = inst0.accountModeSlug != null ? String(inst0.accountModeSlug).toLowerCase() : "";
      if (!slug || appState.getActiveInstance?.(slug) !== instanceId) {
        return res.status(400).json({ ok: false, error: "instance_not_active_for_mode" });
      }
      const tm = persistenceSlugToTradingMode(slug);
      await appState.ensureEngine(tm);
      const row = appState.getEngine(tm);
      const pub = row?.bot?.getPublicState?.();
      if (!pub?.running) {
        return res.status(400).json({ ok: false, error: "bot_not_running" });
      }
      row.bot.setPaused?.(true);
      await instanceService.updateInstanceStatus(instanceId, "paused", "User paused", "user", null);
      await broadcastInstanceStatusFromDetail(instanceId, uid, { reason: "User paused", triggeredBy: "user" });
      const inst = await instanceService.getInstanceDetail(instanceId, uid);
      res.json({ ok: true, instance: inst, bot: row.bot.getPublicState?.() });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/instances/:instanceId/resume", requireDbUserSession, async (req, res) => {
    const instanceId = String(req.params.instanceId || "");
    if (!z.string().uuid().safeParse(instanceId).success) {
      return res.status(400).json({ ok: false, error: "invalid_instance_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const uid = effectiveSessionUserId(req);
    try {
      const inst0 = await instanceService.getInstanceDetail(instanceId, uid);
      if (!inst0) return res.status(404).json({ ok: false, error: "instance_not_found" });
      if (String(inst0.status || "").toLowerCase() !== "paused") {
        return res.status(400).json({ ok: false, error: "instance_not_paused" });
      }
      const slug = inst0.accountModeSlug != null ? String(inst0.accountModeSlug).toLowerCase() : "";
      if (!slug || appState.getActiveInstance?.(slug) !== instanceId) {
        return res.status(400).json({ ok: false, error: "instance_not_active_for_mode" });
      }
      const tm = persistenceSlugToTradingMode(slug);
      await appState.ensureEngine(tm);
      const row = appState.getEngine(tm);
      const pub = row?.bot?.getPublicState?.();
      if (!pub?.running) {
        return res.status(400).json({ ok: false, error: "bot_not_running" });
      }
      row.bot.setPaused?.(false);
      await instanceService.updateInstanceStatus(instanceId, "running", "User resumed", "user", null);
      await broadcastInstanceStatusFromDetail(instanceId, uid, { reason: "User resumed", triggeredBy: "user" });
      const inst = await instanceService.getInstanceDetail(instanceId, uid);
      res.json({ ok: true, instance: inst, bot: row.bot.getPublicState?.() });
    } catch (e) {
      if (e instanceof instanceService.InstanceNotFoundError) {
        return res.status(404).json({ ok: false, error: e.code });
      }
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies/:strategyId", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const strategy = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!strategy) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const latestVersion = await strategyService.getLatestVersion(strategyId);
      res.json({ ok: true, strategy, latestVersion });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.patch("/strategies/:strategyId", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).optional().nullable(),
      tags: z.array(z.string().max(64)).max(48).optional(),
    });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const strategy = await strategyService.updateStrategyMeta(strategyId, parsed.data);
      res.json({ ok: true, strategy });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete("/strategies/:strategyId", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      if (Array.isArray(owned.tags) && owned.tags.includes("default-strategy")) {
        return res.status(400).json({ ok: false, error: "default_strategy_cannot_be_archived" });
      }
      await strategyService.archiveStrategy(strategyId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies/:strategyId/versions", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const versions = await strategyService.listVersions(strategyId);
      res.json({ ok: true, versions });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies/:strategyId/versions/:versionId", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    const versionId = String(req.params.versionId || "");
    if (!accountUuid.safeParse(strategyId).success || !accountUuid.safeParse(versionId).success) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const version = await strategyService.getVersion(versionId);
      if (!version || version.strategyId !== strategyId) {
        return res.status(404).json({ ok: false, error: "version_not_found" });
      }
      res.json({ ok: true, version });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/strategies/:strategyId/versions", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({
      configRaw: z.record(z.unknown()),
      label: z.string().max(500).optional().nullable(),
      promotedFrom: z.string().uuid().optional().nullable(),
    });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const version = await strategyService.createVersion(
        strategyId,
        effectiveSessionUserId(req),
        parsed.data.configRaw,
        parsed.data.label ?? null,
        parsed.data.promotedFrom ?? null,
      );
      res.json({ ok: true, version });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/strategies/:strategyId/versions/:versionId/clone", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    const versionId = String(req.params.versionId || "");
    if (!accountUuid.safeParse(strategyId).success || !accountUuid.safeParse(versionId).success) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({
      targetStrategyId: z.string().uuid().optional(),
      label: z.string().max(500).optional().nullable(),
    });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const ownedSrc = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!ownedSrc) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const ver = await strategyService.getVersion(versionId);
      if (!ver || ver.strategyId !== strategyId) {
        return res.status(404).json({ ok: false, error: "version_not_found" });
      }
      const destId = parsed.data.targetStrategyId ?? strategyId;
      const ownedDest = await strategyService.assertStrategyOwnedByUser(destId, effectiveSessionUserId(req));
      if (!ownedDest) return res.status(404).json({ ok: false, error: "target_strategy_not_found" });
      const cfgRaw = ver.cfgRaw && typeof ver.cfgRaw === "object" ? ver.cfgRaw : {};
      const defaultLabel = `Cloned from v${ver.versionNumber}`;
      const version = await strategyService.createVersion(
        destId,
        effectiveSessionUserId(req),
        cfgRaw,
        parsed.data.label != null && String(parsed.data.label).trim() ? String(parsed.data.label).trim() : defaultLabel,
        versionId,
      );
      res.json({ ok: true, version });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/strategies/:strategyId/versions/snapshot", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const bodySchema = z.object({ label: z.string().max(500).optional().nullable() });
    const parsed = bodySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const strategy = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!strategy) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const viewM = resolveViewTradingMode(req, undefined);
      const sessionSlug = tradingModeToPersistenceSlug(viewM);
      await appState.ensureEngine(viewM);
      const row = appState.getEngine(viewM);
      if (!row?.bot?.getTradingConfigPersistPayload) {
        return res.status(500).json({ ok: false, error: "engine_bot_missing" });
      }
      const payload = row.bot.getTradingConfigPersistPayload();
      const activeVid = appState.getActiveStrategyVersion?.(sessionSlug) ?? null;
      let promotedFrom = null;
      if (activeVid) {
        const av = await strategyService.getVersion(activeVid);
        if (av && av.strategyId === strategyId) promotedFrom = activeVid;
      }
      const version = await strategyService.createVersion(
        strategyId,
        effectiveSessionUserId(req),
        payload,
        parsed.data.label != null && String(parsed.data.label).trim()
          ? String(parsed.data.label).trim()
          : "Manual snapshot",
        promotedFrom,
      );
      res.json({ ok: true, version });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Phase 4 — strategy performance (closed trades aggregated per version). */
  r.get("/strategies/:strategyId/performance", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    if (!accountUuid.safeParse(strategyId).success) {
      return res.status(400).json({ ok: false, error: "invalid_strategy_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const rows = await performanceService.getPerformanceRowsForStrategy(strategyId);
      res.json({ ok: true, versions: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies/:strategyId/versions/:versionId/performance", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    const versionId = String(req.params.versionId || "");
    if (!accountUuid.safeParse(strategyId).success || !accountUuid.safeParse(versionId).success) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const ver = await strategyService.getVersion(versionId);
      if (!ver || ver.strategyId !== strategyId) {
        return res.status(404).json({ ok: false, error: "version_not_found" });
      }
      const rows = await performanceService.getPerformanceRowsForStrategy(strategyId);
      const hit = rows.find((x) => x.versionId === versionId);
      res.json({ ok: true, metrics: hit?.metrics ?? null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies/:strategyId/versions/:versionId/equity-curve", requireDbUserSession, async (req, res) => {
    const strategyId = String(req.params.strategyId || "");
    const versionId = String(req.params.versionId || "");
    if (!accountUuid.safeParse(strategyId).success || !accountUuid.safeParse(versionId).success) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const owned = await strategyService.assertStrategyOwnedByUser(strategyId, effectiveSessionUserId(req));
      if (!owned) return res.status(404).json({ ok: false, error: "strategy_not_found" });
      const ver = await strategyService.getVersion(versionId);
      if (!ver || ver.strategyId !== strategyId) {
        return res.status(404).json({ ok: false, error: "version_not_found" });
      }
      const curve = await performanceService.getEquityCurve(versionId);
      res.json({ ok: true, curve });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/trading-modes/:modeSlug/performance/compare", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const slug = normalizeModeSlugParam(req.params.modeSlug);
    if (!slug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    try {
      const rows = await performanceService.listPerformanceCompareForUserMode(effectiveSessionUserId(req), slug);
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/admin/recalculate-performance", requireAdmin, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const out = await performanceService.recalculateAllStrategyPerformance();
      res.json({ ok: true, processed: out.processed, errors: out.errors });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/me/ui-prefs", requireDbUserSession, async (req, res) => {
    try {
      const uid = effectiveSessionUserId(req);
      if (!uid) return res.status(403).json({ ok: false, error: "db_user_required" });
      const prefs = await usersService.getUiPrefsByUserId(uid);
      res.json({ ok: true, ui_prefs: prefs });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  r.patch("/me/ui-prefs", requireDbUserSession, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: "invalid_body" });
    }
    try {
      const uid = effectiveSessionUserId(req);
      if (!uid) return res.status(403).json({ ok: false, error: "db_user_required" });
      const next = await usersService.mergeUiPrefsForUser(uid, body);
      res.json({ ok: true, ui_prefs: next });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "db_not_configured") return res.status(503).json({ ok: false, error: "db_not_configured" });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Market Intelligence provider APIs (encrypted prefs on first active user; overrides env) ──
  r.get("/market-intelligence/providers", requireDbUserSession, async (_req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const apis = getResolvedMarketIntelApis();
      const envPresent = {
        finnhubApiKey: Boolean(String(process.env.FINNHUB_API_KEY ?? "").trim()),
        cryptoquantApiKey: Boolean(String(process.env.CRYPTOQUANT_API_KEY ?? "").trim()),
        whaleAlertApiKey: Boolean(String(process.env.WHALE_ALERT_API_KEY ?? "").trim()),
        aiBaseUrl: Boolean(String(process.env.AI_BASE_URL ?? "").trim()),
      };
      const effectivePresent = {
        finnhubApiKey: Boolean(apis.finnhubApiKey),
        cryptoquantApiKey: Boolean(apis.cryptoquantApiKey),
        whaleAlertApiKey: Boolean(apis.whaleAlertApiKey),
        aiBaseUrl: Boolean(apis.aiBaseUrl),
      };

      /** @type {Record<string, string | null>} */
      const storedPreview = {};
      let storedBlobPresent = false;
      const ownerId = await usersService.getFirstActiveUserId();
      if (ownerId && marketIntelEncryptionKeyConfigured()) {
        const prefs = await usersService.getUiPrefsByUserId(ownerId);
        const c = prefs.marketIntelProvidersCipher;
        if (typeof c === "string" && c.length > 5) {
          storedBlobPresent = true;
          try {
            const o = JSON.parse(decryptSecret(c));
            for (const k of ["finnhubApiKey", "cryptoquantApiKey", "whaleAlertApiKey", "aiBaseUrl"]) {
              const v = o[k];
              storedPreview[k] =
                typeof v === "string" && v.length > 4 ? `…${v.slice(-4)}` : v ? "••••" : null;
            }
          } catch {
            for (const k of ["finnhubApiKey", "cryptoquantApiKey", "whaleAlertApiKey", "aiBaseUrl"]) {
              storedPreview[k] = null;
            }
          }
        }
      }

      res.json({
        ok: true,
        encryptionConfigured: marketIntelEncryptionKeyConfigured(),
        storedBlobPresent,
        envPresent,
        effectivePresent,
        storedPreview,
        /** Safe to display — resolved AI base URL (env or stored). */
        effectiveAiBaseUrl: apis.aiBaseUrl || null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.put("/market-intelligence/providers", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    if (!marketIntelEncryptionKeyConfigured()) {
      return res.status(400).json({
        ok: false,
        error: "encryption_not_configured",
        message:
          "Set API_CREDENTIALS_ENCRYPTION_KEY in the server environment to store provider secrets, or configure providers via backend .env.",
      });
    }
    const parsed = marketIntelProvidersPutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "invalid_body", detail: parsed.error.flatten() });
    }
    try {
      const ownerId = await usersService.getFirstActiveUserId();
      if (!ownerId) return res.status(503).json({ ok: false, error: "no_active_user" });

      const prefs = await usersService.getUiPrefsByUserId(ownerId);
      /** @type {Record<string, string>} */
      let cur = {};
      const c = prefs.marketIntelProvidersCipher;
      if (typeof c === "string" && c.length > 5) {
        try {
          cur = JSON.parse(decryptSecret(c));
          if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
        } catch {
          cur = {};
        }
      }

      const body = parsed.data;
      for (const k of ["finnhubApiKey", "cryptoquantApiKey", "whaleAlertApiKey", "aiBaseUrl"]) {
        if (body[k] !== undefined) {
          const v = String(body[k] ?? "").trim();
          if (!v) delete cur[k];
          else cur[k] = v;
        }
      }

      const nextCipher =
        Object.keys(cur).length > 0 ? encryptSecret(JSON.stringify(cur)) : null;
      await usersService.mergeUiPrefsForUser(ownerId, {
        marketIntelProvidersCipher: nextCipher,
      });
      await refreshMarketIntelApisFromStore();
      res.json({ ok: true });
    } catch (e) {
      const msg = String(e?.message || e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Market Intelligence ─────────────────────────────────────────────────────
  r.get('/intelligence/:symbol', async (req, res) => {
    try {
      const data = await getLatestIntelligenceApiPayload(req.params.symbol);
      res.json(data ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/intelligence/:symbol/liquidations', async (req, res) => {
    try {
      const sym = String(req.params.symbol || '').trim().toUpperCase();
      const data =
        getLiquidationPayloadForSymbol(sym) ?? {
          longUsd: 0,
          shortUsd: 0,
          totalUsd: 0,
          count: 0,
          dominance: 'neutral',
          intensity: 'low',
          windowHours: 4,
          lastUpdated: Date.now(),
        };
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/intelligence/:symbol/history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit ?? '100'), 500);
      const data  = await getIntelligenceHistory(req.params.symbol, limit);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/market/events', requireDbUserSession, async (req, res) => {
    try {
      if (!getPool()) return res.json({ ok: true, events: [] });
      const from = String(req.query.from ?? '').trim();
      const to = String(req.query.to ?? '').trim();
      const assetsRaw = String(req.query.assets ?? '').trim();
      const assets = assetsRaw ? assetsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!from || !to) return res.status(400).json({ ok: false, error: 'from_and_to_required' });
      const events = await marketEventsService.listMarketEventsInRange({ fromIso: from, toIso: to, assets });
      res.json({ ok: true, events });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/market/whales', requireDbUserSession, async (req, res) => {
    try {
      if (!getPool()) return res.json({ ok: true, alerts: [] });
      const from = String(req.query.from ?? '').trim();
      const to = String(req.query.to ?? '').trim();
      const symbol = req.query.symbol != null ? String(req.query.symbol).trim().toUpperCase() : '';
      if (!from || !to) return res.status(400).json({ ok: false, error: 'from_and_to_required' });
      const alerts = await whaleAlertsService.listWhaleAlertsInRange({
        fromIso: from,
        toIso: to,
        symbol: symbol || undefined,
      });
      res.json({ ok: true, alerts });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/analytics/strategy-edge', requireDbUserSession, async (req, res) => {
    try {
      if (!getPool()) return res.status(503).json({ ok: false, error: 'db_not_configured' });
      const uid = effectiveSessionUserId(req);
      if (!uid) return res.status(403).json({ ok: false, error: 'db_user_required' });
      const instanceId = req.query.instanceId != null ? String(req.query.instanceId).trim() : '';
      const strategyVersionId =
        req.query.strategyVersionId != null ? String(req.query.strategyVersionId).trim() : '';
      const windowDays = Math.min(730, Math.max(7, parseInt(String(req.query.windowDays ?? '90'), 10) || 90));
      if (!instanceId && !strategyVersionId) {
        return res.status(400).json({ ok: false, error: 'instance_or_version_required' });
      }
      if (instanceId) {
        const inst = await instanceService.getInstanceDetail(instanceId, uid);
        if (!inst) return res.status(404).json({ ok: false, error: 'instance_not_found' });
        const metrics = await strategyEdgeService.getStrategyEdgeForInstance(instanceId, windowDays);
        return res.json({ ok: true, metrics });
      }
      const st = await strategyService.getStrategyByVersionId(strategyVersionId);
      if (!st || String(st.userId || '') !== String(uid)) {
        return res.status(404).json({ ok: false, error: 'version_not_found' });
      }
      const metrics = await strategyEdgeService.getStrategyEdgeForVersion(strategyVersionId, windowDays);
      return res.json({ ok: true, metrics });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}

