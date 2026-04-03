import express from "express";
import { z } from "zod";
import { runBacktest } from "../backtest/backtest.js";
import { getTradingEvaluationChecklist } from "../evaluation/tradingChecklist.js";

export function createRouter({ appState }) {
  const r = express.Router();

  const symbolRe = /^[A-Z0-9]{5,20}$/;
  const allowedTimeframes = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

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
    res.json({
      ok: true,
      mode: appState.mode,
      bot: appState.bot.getPublicState(),
      account,
      positions,
      trades,
    });
  });

  r.get("/ai/health", async (_req, res) => {
    try {
      const data = await appState.ai.health();
      res.json({ ok: true, data });
    } catch (e) {
      res.status(503).json({ ok: false, error: "ai_unreachable" });
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
      res.status(503).json({ ok: false, error: "ai_unreachable" });
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
      res.status(400).json({ ok: false, error: String(e?.message || e) });
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
      res.status(400).json({ ok: false, error: String(e?.message || e) });
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

  r.post("/bot/start", (_req, res) => {
    appState.bot.start({ wsHub: appState.wsHub });
    res.json({ ok: true, bot: appState.bot.getPublicState() });
  });

  r.post("/bot/stop", (_req, res) => {
    appState.bot.stop({ wsHub: appState.wsHub });
    res.json({ ok: true, bot: appState.bot.getPublicState() });
  });

  r.post("/bot/config", (req, res) => {
    const schema = z.object({
      symbol: z.string().regex(symbolRe).optional(),
      symbolMode: z.enum(["SINGLE", "AUTO"]).optional(),
      timeframe: z.string().refine((v) => allowedTimeframes.has(v), "Unsupported timeframe").optional(),
      aiThreshold: z.number().min(0).max(1).optional(),
      riskPerTrade: z.number().min(0.001).max(0.05).optional(),
      maxDailyLoss: z.number().min(0.01).max(0.2).optional(),
      strategyMode: z.enum(["AUTO", "MANUAL"]).optional(),
      manualStrategy: z.string().optional(),
      marketMode: z.enum(["SPOT", "FUTURES", "AUTO"]).optional(),
      futuresLeverageMode: z.enum(["AUTO", "MANUAL"]).optional(),
      futuresLeverage: z.number().int().min(1).max(50).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const bot = appState.bot.updateConfig(parsed.data);
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
      mode: z.enum(["PAPER", "BINANCE_DEMO", "BINANCE_DEMO_FUTURES", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_FUTURES_TESTNET"]),
      confirm: z.literal(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    // Stop bot before switching
    appState.bot.stop({ wsHub: appState.wsHub });
    const out = await appState.setMode(parsed.data.mode);
    return res.json(out);
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

