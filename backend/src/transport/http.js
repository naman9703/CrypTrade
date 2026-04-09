import express from "express";
import { z } from "zod";
import { runBacktest } from "../backtest/backtest.js";
import { getTradingEvaluationChecklist } from "../evaluation/tradingChecklist.js";
import { formatAiServiceError } from "../svc/aiHttpError.js";
import { broadcastActivity } from "../lib/activityLog.js";
import { isStrictBinanceAccountMode } from "../lib/tradingModePersistence.js";

export function createRouter({ appState }) {
  const r = express.Router();

  const symbolRe = /^[A-Z0-9]{5,20}$/;
  const allowedTimeframes = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

  const botLifecycleBody = z.object({
    reason: z.string().max(400).optional(),
    detail: z.record(z.unknown()).optional(),
  });

  async function withTimeout(promise, ms) {
    return await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
    ]);
  }

  r.get("/state", async (_req, res) => {
    let account = null;
    let positions = [];
    let trades = [];
    try {
      account = await withTimeout(appState.exchange.getAccount(), 2000);
    } catch {
      account = null;
    }
    try {
      positions = await withTimeout(appState.exchange.getPositions(), 2000);
    } catch {
      positions = [];
    }
    try {
      trades = await withTimeout(appState.exchange.getTrades(), 2000);
    } catch {
      trades = [];
    }
    if (isStrictBinanceAccountMode(appState.mode) && account == null) {
      positions = [];
      trades = [];
    }
    res.json({
      ok: true,
      mode: appState.mode,
      bot: appState.bot.getPublicState(),
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
    const botState = appState.bot.getPublicState();
    const symbol = String(req.query.symbol || botState.symbol || "").toUpperCase();
    let venue = String(req.query.venue || "").toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required" });
    const mm = String(botState.marketMode || "AUTO").toUpperCase();
    if (!venue) {
      venue = mm === "AUTO" ? "BOTH" : mm === "SPOT" ? "SPOT" : "FUTURES";
    }
    try {
      const ex = appState.exchange;
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

  /** Last N bars for chart (~24h for current bot symbol/timeframe); Binance REST backfill + live buffer when MARKET_FEED is Binance. */
  r.get("/market/candles", (_req, res) => {
    try {
      const hours = Math.max(0.25, Math.min(168, Number(_req.query.hours ?? 24)));
      const snap = appState.bot.getChartSnapshot({ hours });
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

  r.get("/metrics", (_req, res) => {
    try {
      res.json({ ok: true, data: appState.bot.getMetrics?.() || {} });
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
    const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    const body = parsed.success ? parsed.data : {};
    appState.bot.start({
      wsHub: appState.wsHub,
      reason: body.reason ?? "user_request",
      source: "http",
      detail: body.detail,
    });
    res.json({ ok: true, bot: appState.bot.getPublicState() });
  });

  r.post("/bot/stop", (req, res) => {
    const parsed = botLifecycleBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    const body = parsed.success ? parsed.data : {};
    appState.bot.stop({
      wsHub: appState.wsHub,
      reason: body.reason ?? "user_request",
      source: "http",
      detail: body.detail,
    });
    res.json({ ok: true, bot: appState.bot.getPublicState() });
  });

  /** Re-anchor hybrid daily loss baselines to current wallet equity and start the bot (after max-daily-loss stop). */
  r.post("/bot/reset-daily-loss", (_req, res) => {
    try {
      appState.bot.resetDailyLossBaselineAndStart({ wsHub: appState.wsHub, source: "http" });
      res.json({ ok: true, bot: appState.bot.getPublicState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/bot/config", (req, res) => {
    const schema = z.object({
      symbol: z.string().regex(symbolRe).optional(),
      symbolMode: z.enum(["SINGLE", "AUTO"]).optional(),
      timeframe: z.string().refine((v) => allowedTimeframes.has(v), "Unsupported timeframe").optional(),
      aiThreshold: z.number().min(0).max(1).optional(),
      /** Interpretation set by `riskPerTradeUnit`: PCT = fraction of balance at stop; USDT = target per-trade notional / investing capital in USDT (≥1). */
      riskPerTrade: z.number().min(0.000001).max(10_000_000).optional(),
      /** Interpretation set by `maxDailyLossUnit`: PCT = max daily drawdown fraction; USDT = max daily loss USD per venue. */
      maxDailyLoss: z.number().min(0.000001).max(10_000_000).optional(),
      riskPerTradeUnit: z.enum(["PCT", "USDT"]).optional(),
      maxDailyLossUnit: z.enum(["PCT", "USDT"]).optional(),
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
      /** Fixed stop fraction of price (Supertrend futures, AI filter off). */
      supertrendFuturesFixedSlPct: z.number().min(0.00005).max(0.2).optional(),
      /** Fixed take-profit fraction of price (Supertrend futures, AI filter off). */
      supertrendFuturesFixedTpPct: z.number().min(0.00005).max(0.5).optional(),
      /** When true, Supertrend futures SELL opens short after closing long; BUY closes short then opens long. */
      supertrendFuturesTwoWay: z.boolean().optional(),
      supertrendPeriod: z.number().int().min(2).max(100).optional(),
      supertrendMultiplier: z.number().min(0.5).max(20).optional(),
      supertrendWilderAtr: z.boolean().optional(),
      /** Lock AUTO universe to one symbol (table stays open in UI); null clears. */
      universePinnedSymbol: z.union([z.string().regex(symbolRe), z.null()]).optional(),
      /** Manual order form (persisted with bot settings). */
      tradingFormDefaults: z
        .object({
          amountUsdStr: z.string().max(32).optional(),
          slPctStr: z.string().max(32).optional(),
          tpPctStr: z.string().max(32).optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const bot = appState.bot.updateConfig(parsed.data);
    broadcastActivity(appState.wsHub, {
      level: "info",
      msg: "Bot configuration updated",
      category: "config",
      reason: "api_patch",
      detail: parsed.data,
    });
    // Match WS `state` shape so the UI doesn't drop account/positions until the next heartbeat.
    Promise.all([appState.exchange.getAccount().catch(() => null), appState.exchange.getPositions().catch(() => [])])
      .then(([account, positions]) => {
        appState.wsHub?.broadcast("state", { mode: appState.mode, ...bot, account, positions });
      })
      .catch(() => {
        appState.wsHub?.broadcast("state", { mode: appState.mode, ...bot, account: null, positions: [] });
      });
    res.json({ ok: true, bot });
  });

  // Scan and rank coins (Binance only). Returns ranked list + selected top symbols.
  r.get("/universe/scan", async (req, res) => {
    try {
      const out = await appState.bot.getUniverseScan?.();
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
      const out = await appState.bot.manualTrade({ wsHub: appState.wsHub, ...parsed.data });
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/trade/close", async (req, res) => {
    const schema = z.object({ id: z.string().min(3) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const ex = appState.exchange;
    if (typeof ex?.closePosition !== "function") {
      return res.status(400).json({ ok: false, error: "close_not_supported" });
    }
    const candles = appState.bot.feed.getCandles();
    const last = candles[candles.length - 1];
    if (!last) return res.status(400).json({ ok: false, error: "no_market_data" });
    try {
      const out = await ex.closePosition({ id: parsed.data.id, price: Number(last.close) });
      if (!out || out.ok === false || out.error) {
        return res.status(400).json(out ?? { ok: false, error: "close_failed" });
      }
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/mode/set", async (req, res) => {
    const schema = z.object({
      mode: z.enum(["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"]),
      confirm: z.literal(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    // Stop bot before switching
    appState.bot.stop({
      wsHub: appState.wsHub,
      reason: "trading_mode_switch",
      source: "http_mode_set",
      detail: { nextMode: parsed.data.mode },
    });
    try {
      const out = await appState.setMode(parsed.data.mode);
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategies", (_req, res) => {
    res.json({ ok: true, strategies: appState.bot.getPublicState().topStrategies });
  });

  r.get("/trading/evaluation", (_req, res) => {
    res.json(
      getTradingEvaluationChecklist({
        mode: appState.mode,
        bot: appState.bot.getPublicState(),
      })
    );
  });

  r.get("/backtest", (req, res) => {
    const limit = Math.max(200, Math.min(1500, Number(req.query.limit || 600)));
    const feeBps = Math.max(0, Math.min(50, Number(req.query.feeBps || 10)));
    const slippageBps = Math.max(0, Math.min(50, Number(req.query.slippageBps || 3)));
    const candles = appState.bot.feed.getCandles().slice(-limit);
    if (!candles?.length) return res.status(400).json({ ok: false, error: "no_candles" });
    const results = runBacktest({ candles, feeBps, slippageBps });
    res.json({
      ok: true,
      symbol: appState.bot.getPublicState().symbol,
      timeframe: appState.bot.getPublicState().timeframe,
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
    if (appState.exchange?.name !== "paper") return res.status(400).json({ ok: false, error: "not_paper_mode" });
    const out = await appState.exchange.reset({ confirm: true });
    return res.json(out);
  });

  return r;
}

