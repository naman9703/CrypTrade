import express from "express";
import { z } from "zod";
import { runBacktest } from "../backtest/backtest.js";
import { getTradingEvaluationChecklist } from "../evaluation/tradingChecklist.js";
import { formatAiServiceError } from "../svc/aiHttpError.js";
import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import { isStrictBinanceAccountMode, tradingModeToPersistenceSlug } from "../lib/tradingModePersistence.js";
import { computeMqTuningPatch, readMqTradeOutcomeRows } from "../lib/mqTuneFromOutcomes.js";
import { uiAuthEnabled } from "../auth/uiGate.js";
import { normalizeTradingMode } from "../state/appState.js";

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

export function createRouter({ appState }) {
  const r = express.Router();

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

  function getEngineForBotRequest(req, bodyMode) {
    const m = resolveViewTradingMode(req, bodyMode);
    appState.ensureEngine(m);
    const row = appState.getEngine(m);
    if (!row?.bot) throw new Error(`engine_missing:${m}`);
    return row;
  }

  /** Merged audit + exchange `getTrades()`, then WS `trades_snapshot` replace (all clients). */
  async function broadcastMergedTradesSnapshot(req, bodyMode, { forceReconcile = false } = {}) {
    const row = getEngineForBotRequest(req, bodyMode);
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
    const row = getEngineForBotRequest(req, undefined);
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
    res.json({
      ok: true,
      mode: viewM,
      bot: row.bot.getPublicState(),
      runningByMode: appState.getRunningByMode?.() ?? {},
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
    const row = getEngineForBotRequest(req, undefined);
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
      const row = getEngineForBotRequest(req, undefined);
      const bot = row.bot;
      const hours = Math.max(0.25, Math.min(168, Number(req.query.hours ?? 24)));
      const symQ = String(req.query.symbol || "").trim().toUpperCase();
      const botSym = String(bot.getPublicState().symbol || "").toUpperCase();
      if (symQ && symQ !== botSym && typeof bot.getChartSnapshotForSymbol === "function") {
        const snap = await bot.getChartSnapshotForSymbol(symQ, { hours });
        if (!snap?.candles?.length) return res.status(503).json({ ok: false, error: "no_candles" });
        return res.json({ ok: true, ...snap });
      }
      const snap = bot.getChartSnapshot({ hours });
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

  r.get("/metrics", (req, res) => {
    try {
      const row = getEngineForBotRequest(req, undefined);
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

  r.post("/bot/start", (req, res) => {
    try {
      const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
      const body = parsed.success ? parsed.data : {};
      const row = getEngineForBotRequest(req, body.mode);
      const targetM = resolveViewTradingMode(req, body.mode);
      row.bot.start({
        wsHub: appState.wsHub,
        reason: body.reason ?? "user_request",
        source: "http",
        detail: body.detail,
      });
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

  r.post("/bot/stop", (req, res) => {
    try {
      const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
      const body = parsed.success ? parsed.data : {};
      const row = getEngineForBotRequest(req, body.mode);
      const targetM = resolveViewTradingMode(req, body.mode);
      row.bot.stop({
        wsHub: appState.wsHub,
        reason: body.reason ?? "user_request",
        source: "http",
        detail: body.detail,
      });
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
  r.post("/bot/reset-daily-loss", (req, res) => {
    try {
      const row = getEngineForBotRequest(req, undefined);
      row.bot.resetDailyLossBaselineAndStart({ wsHub: appState.wsHub, source: "http" });
      res.json({ ok: true, bot: row.bot.getPublicState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/bot/config", (req, res) => {
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
      riskPerTradeUnit: z.enum(["PCT", "USDT"]).optional(),
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
      /** Min AI probability (0–1) for Supertrend futures opens when `supertrendFuturesAiConfidenceFilter` is on. */
      supertrendFuturesMinAiProb: z.number().min(0).max(1).optional(),
      /** Min SurfPulse XGBoost win probability (0–1) when strategy SURF_PULSE_ML is active. */
      surfPulseMlThreshold: z.number().min(0).max(1).optional(),
      trailingStopLossAuto: z.boolean().optional(),
      /** `SUPERTREND` vs `FEE_LADDER` — see bot `futuresTrailingStopMode`. */
      futuresTrailingStopMode: z.enum(["SUPERTREND", "FEE_LADDER"]).optional(),
      /** Supertrend trailing: fee breakeven floor (default on). */
      futuresTrailingStFeeBreakeven: z.boolean().optional(),
      /** Supertrend trailing: follow chart Supertrend line (default on). */
      futuresTrailingStAdvanced: z.boolean().optional(),
      /** Up to 3 extra trailing locks after fee breakeven + fee-based first scalping; each % of entry (e.g. 0.5 = 0.5%). */
      trailingStopExtraScalpingPcts: z.array(z.number().min(0.01).max(5)).max(3).optional(),
      /** Fixed stop fraction of price (Supertrend futures, AI filter off). */
      supertrendFuturesFixedSlPct: z.number().min(0.00005).max(0.2).optional(),
      /** Fixed take-profit fraction of price (Supertrend futures, AI filter off). */
      supertrendFuturesFixedTpPct: z.number().min(0.00005).max(0.5).optional(),
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
      /** Manual order form (persisted with bot settings). */
      tradingFormDefaults: z
        .object({
          amountUsdStr: z.string().max(32).optional(),
          slPctStr: z.string().max(32).optional(),
          tpPctStr: z.string().max(32).optional(),
        })
        .optional(),
      /** Market regime + signal-quality engine (merged with server defaults). */
      marketDecision: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { mode: configTargetMode, ...patch } = parsed.data;
    let row;
    try {
      row = getEngineForBotRequest(req, configTargetMode);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
    let bot;
    try {
      bot = row.bot.updateConfig(patch);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
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
  r.post("/bot/tune-move-quality", (req, res) => {
    const schema = z.object({
      mode: BOT_TARGET_MODES.optional(),
      apply: z.boolean().optional(),
      minTrades: z.number().int().min(3).max(500).optional(),
      winPercentileFloor: z.number().min(5).max(50).optional(),
    });
    const parsed = schema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    try {
      const row = getEngineForBotRequest(req, parsed.data.mode);
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
      const row = getEngineForBotRequest(req, undefined);
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
      const row = getEngineForBotRequest(req, undefined);
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
      stopLossPct: z.number().min(0.001).max(0.2),
      takeProfitPct: z.number().min(0.001).max(0.5),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    try {
      const row = getEngineForBotRequest(req, undefined);
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
    const row = getEngineForBotRequest(req, undefined);
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
      appState.ensureEngine(next);
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

  r.get("/strategies", (req, res) => {
    const row = getEngineForBotRequest(req, undefined);
    res.json({ ok: true, strategies: row.bot.getPublicState().topStrategies });
  });

  r.get("/trading/evaluation", (req, res) => {
    const row = getEngineForBotRequest(req, undefined);
    const viewM = resolveViewTradingMode(req, undefined);
    res.json(
      getTradingEvaluationChecklist({
        mode: viewM,
        bot: row.bot.getPublicState(),
      })
    );
  });

  r.get("/backtest", (req, res) => {
    const row = getEngineForBotRequest(req, undefined);
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
    const row = getEngineForBotRequest(req, undefined);
    if (row.exchange?.name !== "paper") return res.status(400).json({ ok: false, error: "not_paper_mode" });
    const out = await row.exchange.reset({ confirm: true });
    return res.json(out);
  });

  return r;
}

