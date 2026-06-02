/**
 * Backtest HTTP API.
 *
 * Mounted from `createRouter` in backend/src/transport/http.js so it inherits the
 * existing session middleware + appState. Routes:
 *   POST   /api/backtest/runs                     create + enqueue
 *   GET    /api/backtest/runs                     list (current user)
 *   GET    /api/backtest/runs/:id                 detail (run + metrics)
 *   GET    /api/backtest/runs/:id/trades          paginated trade list
 *   GET    /api/backtest/runs/:id/equity-curve    downsampled curve
 *   POST   /api/backtest/runs/:id/cancel          cooperative cancel
 *   DELETE /api/backtest/runs/:id                 cancel-or-delete
 *   GET    /api/backtest/data/coverage            (symbol, tf[, from, to])
 *   POST   /api/backtest/data/sync                manual ingestion
 *   POST   /api/backtest/optimize                 spawn parameter sweep
 *   GET    /api/backtest/optimize/:id             sweep summary + heatmap
 *   POST   /api/backtest/promote/:runId           run → strategy version → instance
 */

import express from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { query, withTransaction } from "../db/query.js";
import { requireDbUserSession } from "../auth/uiGate.js";
import * as strategyService from "../db/services/strategyService.js";
import * as instanceService from "../db/services/instanceService.js";
import { getPaperSystemAccountId } from "../db/services/walletService.js";
import { normalizeModeSlugParam } from "../lib/modeSlug.js";
import { normalizeTradingMode } from "../state/appState.js";
import { pickRawIntradayPanelFromBot, materializeIntradayPanelOnCfg } from "../strategy/intradayPanelKeys.js";
import { fillSmcSoloPresetDefaults, materializeIntradayEngineCfgSync } from "../strategy/presets/srIntradayOptimized.js";
import { mergeInstanceIntoCfgRaw, ensureBacktestMarketMode, stripInstanceFieldsFromCfgRaw, uiOperationalPatchToInstColumns, applyInstanceOperationalToConfigSnapshot, applyInstanceOperationalToBot, INSTANCE_FIELD_KEYS } from "../lib/strategyInstanceSplit.js";
import { normalizeEliteStRunCfg } from "../strategy/supertrendElite.js";
import { InsufficientCapitalError } from "../db/services/capitalAllotmentService.js";
import {
  enqueueRun,
  cancelRun as poolCancel,
  isRunInPool,
  recoverOrphanedBacktestRuns,
} from "../backtest/engine/pool.js";
import { failRun } from "../backtest/engine/persistence.js";
import { ensureKlines, readCandles } from "../backtest/data/klineIngest.js";
import { ensureFunding } from "../backtest/data/fundingIngest.js";
import { ensureFearGreed } from "../backtest/data/fearGreedIngest.js";
import { ensureOpenInterest } from "../backtest/data/openInterestIngest.js";
import { getCoverage, getMonthlyCoverage } from "../backtest/data/dataCoverage.js";
import { SUPPORTED_TIMEFRAMES } from "../backtest/data/timeframe.js";
import { BACKTEST_ENGINE_VERSION } from "../backtest/engine/version.js";

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;

const isoDate = z.union([
  z.string().refine((s) => Number.isFinite(Date.parse(s)), "invalid_date"),
  z.number().int().positive(),
  z.date(),
]);

const createRunBody = z
  .object({
    strategyVersionId: z.string().uuid(),
    botInstanceId: z.string().uuid().optional(),
    symbol: z.string().regex(SYMBOL_RE),
    timeframe: z.string().refine((tf) => SUPPORTED_TIMEFRAMES.includes(tf), "invalid_timeframe"),
    from: isoDate,
    to: isoDate,
    startingUsdt: z.number().positive().max(10_000_000).default(10_000),
    label: z.string().max(200).optional(),
    costModel: z.record(z.any()).optional(),
    gateMode: z.enum(["off", "approx"]).default("off"),
    walkForward: z
      .object({
        trainPct: z.number().min(0.1).max(0.9).default(0.7),
      })
      .optional(),
    /** `FULL_EQUITY_MARGIN` = each trade uses all equity as futures margin (compounded). */
    positionSizing: z.enum(["RISK_AT_SL", "FULL_EQUITY_MARGIN"]).optional(),
    /** When true (default), merge live engine intraday/SMC panel fields into the snapshot. */
    useLivePanelOverrides: z.boolean().optional(),
    /** Instance-owned operational fields from the UI at submit time (risk, market mode, etc.). */
    instanceOperational: z
      .object({
        symbol: z.string().min(1).max(64).nullable().optional(),
        timeframe: z.string().min(1).max(8).nullable().optional(),
        symbolMode: z.string().min(1).max(32).nullable().optional(),
        marketMode: z.string().min(1).max(32).nullable().optional(),
        riskPerTrade: z.number().nullable().optional(),
        riskUnit: z.string().min(1).max(8).nullable().optional(),
        maxDailyLoss: z.number().nullable().optional(),
        maxDailyLossUnit: z.string().min(1).max(8).nullable().optional(),
      })
      .optional(),
  })
  .superRefine((d, ctx) => {
    const f = toMs(d.from);
    const t = toMs(d.to);
    if (!(f < t)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to_must_be_after_from", path: ["to"] });
  });

const optimizeBody = z.object({
  strategyVersionId: z.string().uuid(),
  botInstanceId: z.string().uuid().optional(),
  symbol: z.string().regex(SYMBOL_RE),
  timeframe: z.string().refine((tf) => SUPPORTED_TIMEFRAMES.includes(tf), "invalid_timeframe"),
  from: isoDate,
  to: isoDate,
  startingUsdt: z.number().positive().max(10_000_000).default(10_000),
  costModel: z.record(z.any()).optional(),
  gateMode: z.enum(["off", "approx"]).default("off"),
  paramGrid: z.record(z.array(z.number())).refine((g) => Object.keys(g).length > 0, "param_grid_empty"),
  walkForward: z
    .object({ trainPct: z.number().min(0.1).max(0.9).default(0.7) })
    .optional(),
});

const promoteBody = z.object({
  modeSlug: z.string().min(1),
  label: z.string().min(1).max(200),
  capitalMode: z.enum(["FIXED", "PCT"]),
  capitalUsdt: z.number().nonnegative().optional(),
  capitalPct: z.number().min(0).max(100).optional(),
  ignoreThresholds: z.boolean().optional(),
});

/**
 * @param {{ appState: any }} ctx
 */
export function createBacktestRouter({ appState }) {
  const r = express.Router();

  function uid(req) {
    const a = req.session?.uiUserId;
    if (a != null && String(a).trim() !== "") return String(a);
    const b = req.dbActingUserId;
    if (b != null && String(b).trim() !== "") return String(b);
    return null;
  }

  r.post("/runs", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const parsed = createRunBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const data = parsed.data;
    try {
      let strategyVersionId = data.strategyVersionId;
      if (data.botInstanceId) {
        const binding = await instanceService.getInstanceEngineBinding(String(data.botInstanceId));
        if (!binding || binding.isDeleted) {
          return res.status(404).json({ ok: false, error: "bot_instance_not_found" });
        }
        await assertBotInstanceOwned(String(data.botInstanceId), userId);
        strategyVersionId = String(binding.strategyVersionId);
      }
      const ver = await strategyService.getVersion(strategyVersionId);
      if (!ver) return res.status(404).json({ ok: false, error: "strategy_version_not_found" });
      const st = await strategyService.getStrategyByVersionId(strategyVersionId);
      if (!st || String(st.userId) !== userId) {
        return res.status(404).json({ ok: false, error: "strategy_version_not_found" });
      }
      const fromDate = new Date(toMs(data.from));
      const toDate = new Date(toMs(data.to));
      const snapshot = await buildRunConfigSnapshot({
        ver,
        userId,
        strategyVersionId,
        botInstanceId: data.botInstanceId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        positionSizing: data.positionSizing,
        useLivePanelOverrides: data.useLivePanelOverrides === true,
        instanceOperational: data.instanceOperational,
        req,
        appState,
      });
      if (data.botInstanceId && data.instanceOperational) {
        try {
          await instanceService.updateInstanceOperationalConfig(
            String(data.botInstanceId),
            userId,
            uiOperationalPatchToInstColumns(data.instanceOperational),
          );
        } catch (err) {
          console.warn("backtest_instance_operational_persist_failed", String(err?.message || err));
        }
      }
      /** Intelligence replay mode follows saved strategy snapshot only (live parity); ignore client gateMode. */
      const snapBot = pickBotFromConfigSnapshot(snapshot.configSnapshot);
      const gateModeEffective = snapBot.intelligenceGateEnabled === true ? "approx" : "off";
      const engineType = pickEngineType(snapshot.configSnapshot);
      const ins = await query(
        `INSERT INTO backtest_runs (
            strategy_version_id, user_id, label,
            symbol, timeframe, start_date, end_date,
            initial_capital, engine_type,
            cost_model, gate_mode, config_snapshot, walk_forward_split,
            bot_instance_id, instance_operational_snapshot, config_source,
            status, progress_pct
         ) VALUES (
            $1,$2,$3, $4,$5,$6,$7, $8,$9, $10::jsonb,$11,$12::jsonb,$13::jsonb,
            $14,$15::jsonb,$16, 'queued', 0
         )
         RETURNING id`,
        [
          strategyVersionId,
          userId,
          data.label ?? null,
          data.symbol,
          data.timeframe,
          fromDate,
          toDate,
          data.startingUsdt,
          engineType,
          JSON.stringify(data.costModel ?? {}),
          gateModeEffective,
          JSON.stringify(snapshot.configSnapshot),
          data.walkForward ? JSON.stringify(data.walkForward) : null,
          snapshot.botInstanceId,
          snapshot.instanceOperationalSnapshot ? JSON.stringify(snapshot.instanceOperationalSnapshot) : null,
          snapshot.configSource,
        ],
      );
      const runId = String(ins.rows[0].id);
      await query(
        `UPDATE backtest_runs
            SET status = 'failed',
                error_message = 'superseded_by_new_run',
                finished_at = NOW()
          WHERE user_id = $1
            AND status = 'queued'
            AND id <> $2
            AND created_at < NOW() - INTERVAL '2 minutes'`,
        [userId, runId],
      ).catch(() => {});
      enqueueRun(runId, { priority: "high" }).catch((e) => {
        console.error("[backtest] enqueue/run failed", runId, e?.message || e);
        void failRun(runId, e);
        try {
          appState.wsHub?.broadcast?.("backtest_failed", {
            runId,
            error: String(e?.message || e),
          });
        } catch {
          /* ignore */
        }
      });
      try {
        appState.wsHub?.broadcast?.("backtest_progress", { runId, progressPct: 0, status: "queued" });
      } catch {
        /* ignore */
      }
      res.json({ ok: true, runId });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/runs", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    try {
      const r2 = await query(
        `SELECT id, strategy_version_id, label, symbol, timeframe,
                start_date, end_date, initial_capital, final_capital,
                engine_type, status, progress_pct, total_trades,
                win_rate_pct, total_pnl_usdt, max_drawdown_pct,
                sharpe_ratio, profit_factor, gate_mode, error_message,
                data_coverage_pct, metrics, cost_model, config_snapshot,
                bot_instance_id, instance_operational_snapshot, config_source,
                created_at, started_at, finished_at
           FROM backtest_runs
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit],
      );
      res.json({ ok: true, runs: r2.rows.map(mapRunRow) });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/runs/:id", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const r2 = await query(
        `SELECT * FROM backtest_runs WHERE id = $1 AND user_id = $2`,
        [String(req.params.id), userId],
      );
      const row = r2.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: "run_not_found" });
      res.json({ ok: true, run: mapRunRow(row) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/runs/:id/trades", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 500)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    try {
      await assertRunOwned(req.params.id, userId);
      const r2 = await query(
        `SELECT *
           FROM backtest_trades
          WHERE backtest_run_id = $1
          ORDER BY trade_number ASC
          LIMIT $2 OFFSET $3`,
        [String(req.params.id), limit, offset],
      );
      res.json({ ok: true, trades: r2.rows.map(mapTradeRow) });
    } catch (e) {
      res.status(notFoundFor(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/runs/:id/equity-curve", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      await assertRunOwned(req.params.id, userId);
      const r2 = await query(
        `SELECT EXTRACT(EPOCH FROM ts)::BIGINT * 1000 AS ts,
                equity::FLOAT8 AS equity,
                drawdown_pct::FLOAT8 AS dd
           FROM backtest_equity_points
          WHERE run_id = $1
          ORDER BY ts ASC`,
        [String(req.params.id)],
      );
      const rows = r2.rows;
      const target = 3000;
      const stride = Math.max(1, Math.ceil(rows.length / target));
      const points = [];
      for (let i = 0; i < rows.length; i += stride) {
        points.push({ ts: Number(rows[i].ts), equity: Number(rows[i].equity), drawdownPct: Number(rows[i].dd) });
      }
      if (rows.length && (rows.length - 1) % stride !== 0) {
        const last = rows[rows.length - 1];
        points.push({ ts: Number(last.ts), equity: Number(last.equity), drawdownPct: Number(last.dd) });
      }
      res.json({ ok: true, points });
    } catch (e) {
      res.status(notFoundFor(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/runs/:id/requeue", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const runId = String(req.params.id);
    try {
      await assertRunOwned(runId, userId);
      const row = await query(`SELECT status FROM backtest_runs WHERE id = $1`, [runId]);
      const st = String(row.rows[0]?.status ?? "");
      if (!["queued", "running"].includes(st)) {
        return res.status(400).json({ ok: false, error: "run_not_requeueable", status: st });
      }
      if (st === "running" && isRunInPool(runId)) {
        return res.json({ ok: true, requeued: false, reason: "already_running" });
      }
      if (st === "running") {
        await query(
          `UPDATE backtest_runs
              SET status = 'queued', progress_pct = 0, started_at = NULL
            WHERE id = $1`,
          [runId],
        );
      }
      await enqueueRun(runId, { priority: "high" });
      try {
        appState.wsHub?.broadcast?.("backtest_progress", { runId, progressPct: 0, status: "queued" });
      } catch {
        /* ignore */
      }
      res.json({ ok: true, requeued: true });
    } catch (e) {
      res.status(notFoundFor(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Re-enqueue all DB-queued runs not present in the worker pool (admin recovery). */
  r.post("/runs/recover-orphaned", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    try {
      const result = await recoverOrphanedBacktestRuns();
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/runs/:id/cancel", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      await assertRunOwned(req.params.id, userId);
      const cancelled = poolCancel(String(req.params.id));
      await query(
        `UPDATE backtest_runs
            SET status = 'cancelled', finished_at = NOW()
          WHERE id = $1 AND status IN ('queued','running')`,
        [String(req.params.id)],
      );
      res.json({ ok: true, cancelled });
    } catch (e) {
      res.status(notFoundFor(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete("/runs/:id", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      await assertRunOwned(req.params.id, userId);
      poolCancel(String(req.params.id));
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM backtest_equity_points WHERE run_id = $1`, [String(req.params.id)]);
        await client.query(`DELETE FROM backtest_trades WHERE backtest_run_id = $1`, [String(req.params.id)]);
        await client.query(`DELETE FROM backtest_runs WHERE id = $1 AND user_id = $2`, [
          String(req.params.id),
          userId,
        ]);
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(notFoundFor(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Read stored OHLCV candles for the backtest chart (no live Binance call — DB only). */
  r.get("/data/candles", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const symbol = String(req.query.symbol ?? "").toUpperCase();
    const tf = String(req.query.timeframe ?? req.query.tf ?? "");
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "invalid_symbol" });
    if (!SUPPORTED_TIMEFRAMES.includes(tf)) return res.status(400).json({ ok: false, error: "invalid_timeframe" });
    let from, to;
    try {
      from = req.query.from != null ? toMs(req.query.from) : null;
      to = req.query.to != null ? toMs(req.query.to) : null;
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_date_params" });
    }
    if (from == null || to == null) return res.status(400).json({ ok: false, error: "from_and_to_required" });
    try {
      const candles = await readCandles(symbol, tf, from, to);
      res.json({ ok: true, candles });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/data/coverage", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const symbol = String(req.query.symbol ?? "").toUpperCase();
    const tf = String(req.query.timeframe ?? req.query.tf ?? "");
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "invalid_symbol" });
    if (!SUPPORTED_TIMEFRAMES.includes(tf)) return res.status(400).json({ ok: false, error: "invalid_timeframe" });
    const from = req.query.from != null ? toMs(req.query.from) : null;
    const to = req.query.to != null ? toMs(req.query.to) : null;
    try {
      const summary = await getCoverage(symbol, tf, { from: from ?? undefined, to: to ?? undefined });
      let monthly = [];
      if (from != null && to != null) {
        monthly = await getMonthlyCoverage(symbol, tf, from, to);
      }
      res.json({ ok: true, coverage: summary, monthly });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/data/sync", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const symbol = String(body.symbol ?? "").toUpperCase();
    const tf = String(body.timeframe ?? body.tf ?? "");
    const from = body.from != null ? toMs(body.from) : null;
    const to = body.to != null ? toMs(body.to) : Date.now();
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "invalid_symbol" });
    if (!SUPPORTED_TIMEFRAMES.includes(tf)) return res.status(400).json({ ok: false, error: "invalid_timeframe" });
    if (from == null) return res.status(400).json({ ok: false, error: "from_required" });
    const market = String(body.market || "futures").toLowerCase() === "spot" ? "spot" : "futures";
    try {
      const klines = await ensureKlines(symbol, tf, { from, to, market });
      let funding = { inserted: 0 };
      if (market === "futures") {
        funding = await ensureFunding(symbol, { from, to }).catch(() => ({ inserted: 0 }));
      }
      const fng = await ensureFearGreed({ limit: 0 }).catch(() => ({ inserted: 0 }));
      const oi =
        market === "futures"
          ? await ensureOpenInterest(symbol, { from, to, period: "1h" }).catch(() => ({ inserted: 0 }))
          : { inserted: 0 };
      res.json({ ok: true, klines, funding, fearGreed: fng, openInterest: oi });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/optimize", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const parsed = optimizeBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const data = parsed.data;
    try {
      const st = await strategyService.getStrategyByVersionId(data.strategyVersionId);
      if (!st || String(st.userId) !== userId) {
        return res.status(404).json({ ok: false, error: "strategy_version_not_found" });
      }
      const ver = await strategyService.getVersion(data.strategyVersionId);
      if (!ver) return res.status(404).json({ ok: false, error: "strategy_version_not_found" });
      const grid = expandParamGrid(data.paramGrid);
      if (grid.length > 200) return res.status(400).json({ ok: false, error: "grid_too_large_max_200" });
      const baseSnapshot = await buildRunConfigSnapshot({
        ver,
        userId,
        strategyVersionId: data.strategyVersionId,
        botInstanceId: data.botInstanceId,
        symbol: data.symbol,
        timeframe: data.timeframe,
      });

      const optIns = await query(
        `INSERT INTO backtest_optimizations
           (user_id, strategy_version_id, symbol, timeframe, param_grid, walk_forward_split, n_runs, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,'running')
         RETURNING id`,
        [
          userId,
          data.strategyVersionId,
          data.symbol,
          data.timeframe,
          JSON.stringify(data.paramGrid),
          data.walkForward ? JSON.stringify(data.walkForward) : null,
          grid.length,
        ],
      );
      const optimizationId = String(optIns.rows[0].id);

      for (const params of grid) {
        const cfgSnap = mergeCfgWithParams(baseSnapshot.configSnapshot, params);
        await query(
          `INSERT INTO backtest_runs (
              strategy_version_id, user_id, label,
              symbol, timeframe, start_date, end_date,
              initial_capital, engine_type,
              cost_model, gate_mode, config_snapshot, walk_forward_split,
              bot_instance_id, instance_operational_snapshot, config_source,
              optimization_id, status, progress_pct
           ) VALUES (
              $1,$2,$3, $4,$5,$6,$7, $8,$9, $10::jsonb,$11,$12::jsonb,$13::jsonb,
              $14,$15::jsonb,$16, $17, 'queued', 0
           )
           RETURNING id`,
          [
            data.strategyVersionId,
            userId,
            `opt:${shortLabel(params)}`,
            data.symbol,
            data.timeframe,
            new Date(toMs(data.from)),
            new Date(toMs(data.to)),
            data.startingUsdt,
            pickEngineType(cfgSnap),
            JSON.stringify(data.costModel ?? {}),
            data.gateMode,
            JSON.stringify(cfgSnap),
            data.walkForward ? JSON.stringify(data.walkForward) : null,
            baseSnapshot.botInstanceId,
            baseSnapshot.instanceOperationalSnapshot ? JSON.stringify(baseSnapshot.instanceOperationalSnapshot) : null,
            baseSnapshot.configSource,
            optimizationId,
          ],
        );
      }
      const r2 = await query(
        `SELECT id FROM backtest_runs WHERE optimization_id = $1`,
        [optimizationId],
      );
      for (const row of r2.rows) {
        const rid = String(row.id);
        enqueueRun(rid).catch((e) => {
          console.error("[backtest] optimization run enqueue failed", rid, e?.message || e);
          void failRun(rid, e);
        });
      }
      res.json({ ok: true, optimizationId, runs: r2.rows.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/optimize/:id", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const r2 = await query(
        `SELECT * FROM backtest_optimizations WHERE id = $1 AND user_id = $2`,
        [String(req.params.id), userId],
      );
      const opt = r2.rows[0];
      if (!opt) return res.status(404).json({ ok: false, error: "optimization_not_found" });
      const runs = await query(
        `SELECT id, label, status, progress_pct,
                config_snapshot,
                total_trades, win_rate_pct, total_pnl_usdt,
                max_drawdown_pct, sharpe_ratio, profit_factor, metrics
           FROM backtest_runs
          WHERE optimization_id = $1
          ORDER BY created_at ASC`,
        [String(req.params.id)],
      );
      const completed = runs.rows.filter((x) => x.status === "done");
      let bestRunId = null;
      let bestSharpe = -Infinity;
      for (const x of completed) {
        const s = Number(x.sharpe_ratio ?? -Infinity);
        if (s > bestSharpe) {
          bestSharpe = s;
          bestRunId = String(x.id);
        }
      }
      if (bestRunId && opt.best_run_id !== bestRunId) {
        await query(`UPDATE backtest_optimizations SET best_run_id = $2 WHERE id = $1`, [
          String(req.params.id),
          bestRunId,
        ]);
      }
      res.json({
        ok: true,
        optimization: {
          id: String(opt.id),
          symbol: opt.symbol,
          timeframe: opt.timeframe,
          status: opt.status,
          paramGrid: opt.param_grid,
          walkForward: opt.walk_forward_split,
          nRuns: opt.n_runs,
          nCompleted: completed.length,
          bestRunId,
          createdAt: opt.created_at,
          finishedAt: opt.finished_at,
        },
        runs: runs.rows.map((x) => ({
          id: String(x.id),
          label: x.label,
          status: x.status,
          progressPct: Number(x.progress_pct ?? 0),
          configSnapshot: x.config_snapshot,
          totalTrades: Number(x.total_trades ?? 0),
          winRatePct: x.win_rate_pct != null ? Number(x.win_rate_pct) : null,
          totalPnlUsdt: x.total_pnl_usdt != null ? Number(x.total_pnl_usdt) : null,
          maxDrawdownPct: x.max_drawdown_pct != null ? Number(x.max_drawdown_pct) : null,
          sharpeRatio: x.sharpe_ratio != null ? Number(x.sharpe_ratio) : null,
          profitFactor: x.profit_factor != null ? Number(x.profit_factor) : null,
          metrics: normalizeBacktestMetrics(x.metrics),
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/promote/:runId", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const parsed = promoteBody.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const data = parsed.data;
    const modeSlug = normalizeModeSlugParam(data.modeSlug);
    if (!modeSlug) return res.status(400).json({ ok: false, error: "invalid_mode_slug" });
    try {
      const r2 = await query(
        `SELECT br.*, sv.strategy_id
           FROM backtest_runs br
           JOIN strategy_versions sv ON sv.id = br.strategy_version_id
          WHERE br.id = $1 AND br.user_id = $2`,
        [String(req.params.runId), userId],
      );
      const run = r2.rows[0];
      if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
      if (run.status !== "done") return res.status(400).json({ ok: false, error: "run_not_done" });

      if (!data.ignoreThresholds) {
        const fail = thresholdCheck(run);
        if (fail) return res.status(400).json({ ok: false, error: fail });
      }

      const newVersion = await strategyService.createVersion(
        String(run.strategy_id),
        userId,
        run.config_snapshot ?? {},
        `from backtest #${String(run.id).slice(0, 8)}`,
        String(run.strategy_version_id),
      );
      if (!newVersion) return res.status(500).json({ ok: false, error: "create_version_failed" });

      let accountId;
      if (modeSlug === "paper") {
        accountId = await getPaperSystemAccountId();
        if (!accountId) return res.status(503).json({ ok: false, error: "paper_account_missing" });
      } else {
        accountId = appState.getActiveAccount?.(modeSlug);
        if (!accountId) return res.status(400).json({ ok: false, error: "no_account_selected" });
      }

      const inst = await instanceService.createInstance(
        userId,
        modeSlug,
        String(accountId),
        newVersion.id,
        data.label,
        data.capitalMode,
        data.capitalUsdt ?? null,
        data.capitalPct ?? null,
        {},
      );

      res.json({
        ok: true,
        strategyVersionId: newVersion.id,
        instanceId: inst.id,
        instance: inst,
      });
    } catch (e) {
      if (e instanceof InsufficientCapitalError) {
        return res.status(400).json({ ok: false, error: e.code, message: String(e.message || e.code) });
      }
      const msg = String(e?.message || e);
      if (msg === "strategy_version_not_found" || msg === "account_not_found") {
        return res.status(404).json({ ok: false, error: msg });
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return r;
}

function thresholdCheck(run) {
  const winRatePct = Number(run.win_rate_pct ?? 0);
  const pf = Number(run.profit_factor ?? 0);
  const dd = Number(run.max_drawdown_pct ?? 100);
  const sh = Number(run.sharpe_ratio ?? 0);
  const trades = Number(run.total_trades ?? 0);
  if (trades < 50) return "promote_threshold_trades_lt_50";
  if (winRatePct < 55) return "promote_threshold_winrate_lt_55";
  if (pf < 1.5) return "promote_threshold_profit_factor_lt_1_5";
  if (dd > 15) return "promote_threshold_max_drawdown_gt_15";
  if (sh < 1) return "promote_threshold_sharpe_lt_1";
  const cm = run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
  const taker =
    Number(cm.takerOpenFeeRate ?? cm.takerCloseFeeRate ?? 0.0005) > 0;
  if (!taker) return "promote_threshold_zero_fee_disallowed";
  return null;
}

/**
 * Determine the display engine label for the backtest run history.
 * Mirrors the live-bot's strategy-key priority exactly:
 *   1. supertrendAuto on  → "SUPERTREND"
 *   2. strategyMode MANUAL → manualStrategy (or "SUPERTREND" if blank)
 *   3. strategyMode AUTO   → "AUTO"
 *   4. fallback            → "SUPERTREND"
 */
function pickEngineType(cfg) {
  const root = cfg && typeof cfg === "object" ? cfg : {};
  const b = root.bot && typeof root.bot === "object" ? root.bot : root;

  const mmUp = String(b.marketMode || b.market || "").toUpperCase();
  const stSpot = Boolean(b.supertrendSpotAuto);
  const stFut = Boolean(b.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";

  const stratMode = String(b.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(b.manualStrategy ?? "").toUpperCase();
    return m && m !== "MANUAL" && m !== "AUTO" ? m : "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";

  return "SUPERTREND";
}

/** Deep-clone saved strategy cfg for the run — no per-run overrides; backtest = that snapshot. */
function cloneStrategyCfgSnapshot(cfgRaw) {
  return cfgRaw && typeof cfgRaw === "object" ? JSON.parse(JSON.stringify(cfgRaw)) : {};
}

function resolveBacktestLiveEngineMode(req, appState) {
  if (req?.session?.uiAuthOk && req.session?.uiTradingMode) {
    return normalizeTradingMode(req.session.uiTradingMode);
  }
  if (appState?.mode) return normalizeTradingMode(appState.mode);
  return null;
}

/**
 * Strategy versions omit instance fields (symbol, marketMode, capital). Strategy-only
 * backtests must still stamp market mode or the simulator runs spot (blocks SELL / shorts).
 */
async function overlayOperationalDefaultsOnSnapshot(configSnapshot, { req, appState, botInstanceId }) {
  const bot = pickBotFromConfigSnapshot(configSnapshot);
  await overlayMissingOperationalFromLive(bot, { req, appState, botInstanceId });

  if (!String(bot.marketMode ?? bot.market ?? "").trim()) {
    const strat = String(bot.manualStrategy ?? "").toUpperCase();
    if (strat === "SR_INTRADAY" || strat === "INTRADAY_PRO") {
      bot.marketMode = "FUTURES";
      if (bot.futuresLeverage == null) bot.futuresLeverage = 12;
      bot._backtestOperationalOverlayAt = new Date().toISOString();
    }
  }
  syncLeverageAliasOnBot(bot);
  return configSnapshot;
}

/** Fill instance-owned bot fields from the live engine when absent on the snapshot. */
async function overlayMissingOperationalFromLive(bot, { req, appState, botInstanceId, accountModeSlug }) {
  if (!bot || typeof bot !== "object" || !appState) return;
  const needs =
    bot.riskPerTrade == null ||
    bot.riskPerTradeUnit == null ||
    bot.maxDailyLoss == null ||
    bot.maxDailyLossUnit == null ||
    !String(bot.marketMode ?? bot.market ?? "").trim();
  if (!needs) return;

  let mode = accountModeSlug ? normalizeTradingMode(accountModeSlug) : null;
  if (!mode && botInstanceId) {
    try {
      const binding = await instanceService.getInstanceEngineBinding(String(botInstanceId));
      if (binding?.accountModeSlug) mode = normalizeTradingMode(binding.accountModeSlug);
    } catch {
      /* ignore */
    }
  }
  if (!mode) mode = resolveBacktestLiveEngineMode(req, appState);
  if (!mode) return;

  try {
    await appState.ensureEngine(mode, botInstanceId ?? undefined);
    const live = appState.getEngine(mode)?.bot?.getPublicState?.();
    if (!live || typeof live !== "object") return;
    if (bot.riskPerTrade == null && live.riskPerTrade != null) bot.riskPerTrade = Number(live.riskPerTrade);
    if (bot.riskPerTradeUnit == null && live.riskPerTradeUnit != null) {
      bot.riskPerTradeUnit = String(live.riskPerTradeUnit);
    }
    if (bot.maxDailyLoss == null && live.maxDailyLoss != null) bot.maxDailyLoss = Number(live.maxDailyLoss);
    if (bot.maxDailyLossUnit == null && live.maxDailyLossUnit != null) {
      bot.maxDailyLossUnit = String(live.maxDailyLossUnit);
    }
    if (!String(bot.marketMode ?? bot.market ?? "").trim() && live.marketMode != null) {
      bot.marketMode = String(live.marketMode);
    }
    if (live.futuresLeverage != null && bot.futuresLeverage == null) {
      bot.futuresLeverage = live.futuresLeverage;
    }
    bot._backtestOperationalOverlayAt = new Date().toISOString();
  } catch {
    /* engine not ready */
  }
}

async function overlayLiveIntradayPanelOnSnapshot(configSnapshot, { appState, req, botInstanceId }) {
  let mode = null;
  if (botInstanceId) {
    const binding = await instanceService.getInstanceEngineBinding(String(botInstanceId));
    if (binding?.accountModeSlug) mode = normalizeTradingMode(binding.accountModeSlug);
  }
  if (!mode) mode = resolveBacktestLiveEngineMode(req, appState);
  if (!mode || !appState) return configSnapshot;
  try {
    await appState.ensureEngine(mode);
    const row = appState.getEngine(mode);
    const live = row?.bot?.getPublicState?.();
    if (!live || typeof live !== "object") return configSnapshot;
    const overlay = pickRawIntradayPanelFromBot(live);
    const bot = pickBotFromConfigSnapshot(configSnapshot);
    Object.assign(bot, overlay);
    bot._livePanelOverlayAt = new Date().toISOString();
  } catch {
    /* engine not ready — use strategy snapshot only */
  }
  return configSnapshot;
}

async function buildRunConfigSnapshot({
  ver,
  userId,
  strategyVersionId,
  botInstanceId,
  symbol,
  timeframe,
  positionSizing,
  useLivePanelOverrides = false,
  instanceOperational,
  req,
  appState,
}) {
  const base = stripInstanceFieldsFromCfgRaw(cloneStrategyCfgSnapshot(ver?.cfgRaw));
  if (!botInstanceId) {
    let configSnapshot = withBacktestRunOptions(withRequestedMarket(base, symbol, timeframe), {
      positionSizing,
    });
    configSnapshot = await overlayOperationalDefaultsOnSnapshot(configSnapshot, { req, appState });
    if (useLivePanelOverrides) {
      configSnapshot = await overlayLiveIntradayPanelOnSnapshot(configSnapshot, {
        appState,
        req,
        botInstanceId: null,
      });
    }
    return {
      configSnapshot,
      botInstanceId: null,
      instanceOperationalSnapshot: null,
      configSource: useLivePanelOverrides ? "strategy_with_live_panel" : "strategy_only",
    };
  }

  const binding = await instanceService.getInstanceEngineBinding(String(botInstanceId));
  if (!binding || binding.isDeleted) throw httpError("bot_instance_not_found", 404);
  if (String(binding.strategyVersionId) !== String(strategyVersionId)) {
    throw httpError("bot_instance_strategy_version_mismatch", 400);
  }

  // The strategy version has already been ownership-checked for this user. Matching
  // version ids plus account ownership make the instance a valid runtime binding.
  await assertBotInstanceOwned(String(botInstanceId), userId);
  const operationalConfig = await resolveInstanceOperationalForBacktest(binding, {
    instanceOperational,
    req,
    appState,
    botInstanceId: String(botInstanceId),
  });
  const merged = mergeInstanceIntoCfgRaw(base, operationalConfig);
  let configSnapshot = withBacktestRunOptions(withRequestedMarket(merged, symbol, timeframe), {
    positionSizing,
  });
  applyInstanceOperationalToConfigSnapshot(configSnapshot, operationalConfig);
  await overlayMissingOperationalFromLive(pickBotFromConfigSnapshot(configSnapshot), {
    req,
    appState,
    botInstanceId: String(botInstanceId),
    accountModeSlug: binding.accountModeSlug,
  });
  applyInstanceOperationalToConfigSnapshot(configSnapshot, operationalConfig);
  if (useLivePanelOverrides) {
    configSnapshot = await overlayLiveIntradayPanelOnSnapshot(configSnapshot, {
      appState,
      req,
      botInstanceId,
    });
  }
  return {
    configSnapshot,
    botInstanceId: String(botInstanceId),
    instanceOperationalSnapshot: operationalConfig ?? null,
    configSource: useLivePanelOverrides ? "instance_snapshot_with_live_panel" : "instance_snapshot",
  };
}

/** Merge DB instance ops + UI submit patch + live engine null-fill (instance-owned fields only). */
async function resolveInstanceOperationalForBacktest(binding, { instanceOperational, req, appState, botInstanceId }) {
  const op = { ...(binding.operationalConfig ?? {}) };
  const clientPatch = uiOperationalPatchToInstColumns(instanceOperational);
  for (const [k, v] of Object.entries(clientPatch)) {
    if (v != null) op[k] = v;
  }
  await fillNullInstanceOperationalFromLiveEngine(op, {
    appState,
    accountModeSlug: binding.accountModeSlug,
    botInstanceId,
    req,
  });
  return op;
}

async function fillNullInstanceOperationalFromLiveEngine(op, { appState, accountModeSlug, botInstanceId, req }) {
  const needs =
    op.inst_risk_per_trade == null ||
    op.inst_risk_unit == null ||
    op.inst_max_daily_loss == null ||
    op.inst_max_daily_loss_unit == null ||
    op.inst_market_mode == null;
  if (!needs || !appState) return op;

  let mode = accountModeSlug ? normalizeTradingMode(accountModeSlug) : null;
  if (!mode) mode = resolveBacktestLiveEngineMode(req, appState);
  if (!mode) return op;

  try {
    await appState.ensureEngine(mode, botInstanceId ?? undefined);
    const live = appState.getEngine(mode)?.bot?.getPublicState?.();
    if (!live || typeof live !== "object") return op;
    if (op.inst_risk_per_trade == null && live.riskPerTrade != null) {
      op.inst_risk_per_trade = Number(live.riskPerTrade);
    }
    if (op.inst_risk_unit == null && live.riskPerTradeUnit != null) {
      op.inst_risk_unit = String(live.riskPerTradeUnit);
    }
    if (op.inst_max_daily_loss == null && live.maxDailyLoss != null) {
      op.inst_max_daily_loss = Number(live.maxDailyLoss);
    }
    if (op.inst_max_daily_loss_unit == null && live.maxDailyLossUnit != null) {
      op.inst_max_daily_loss_unit = String(live.maxDailyLossUnit);
    }
    if (op.inst_market_mode == null && live.marketMode != null) {
      op.inst_market_mode = String(live.marketMode);
    }
    if (op.inst_timeframe == null && live.timeframe != null) {
      op.inst_timeframe = String(live.timeframe);
    }
  } catch {
    /* engine not ready */
  }
  return op;
}

/** Materialize intraday/SMC engine cfg on the snapshot so backtest = saved panel values. */
function materializeBacktestEngineSnapshot(cfgRaw) {
  const root = cloneStrategyCfgSnapshot(cfgRaw);
  const b = pickBotFromConfigSnapshot(root);
  const preserved = {};
  for (const key of INSTANCE_FIELD_KEYS) {
    if (b[key] !== undefined) preserved[key] = b[key];
  }
  const engine = materializeIntradayEngineCfgSync(b, materializeIntradayPanelOnCfg);
  Object.assign(engine, preserved);
  engine._intradayEngineMaterialized = true;
  engine._intradayEngineMaterializedAt = new Date().toISOString();
  if (root.bot && typeof root.bot === "object") {
    root.bot = { ...root.bot, ...engine };
  } else {
    return { v: root.v ?? 1, bot: engine };
  }
  return root;
}

/** Per-run simulator options stored on the strategy snapshot (`config_snapshot.bot`). */
function withBacktestRunOptions(cfgRaw, { positionSizing } = {}) {
  const root = materializeBacktestEngineSnapshot(cfgRaw);
  const b = pickBotFromConfigSnapshot(root);
  if (positionSizing) b.backtestPositionSizing = positionSizing;
  b._engineVersion = BACKTEST_ENGINE_VERSION;
  if (String(b.manualStrategy ?? "").toUpperCase() === "SUPERTREND_ELITE") {
    Object.assign(b, normalizeEliteStRunCfg(b));
  }
  return root;
}

function pickBotFromConfigSnapshot(snap) {
  if (!snap || typeof snap !== "object") return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

function withRequestedMarket(cfgRaw, symbol, timeframe) {
  const root = cloneStrategyCfgSnapshot(cfgRaw);
  const target = root.bot && typeof root.bot === "object" ? root.bot : root;
  if (symbol != null) target.symbol = String(symbol).trim().toUpperCase();
  if (timeframe != null) target.timeframe = String(timeframe).trim();
  syncLeverageAliasOnBot(target);
  return root;
}

/**
 * Live config uses `futuresLeverage` (+ `futuresLeverageMode`); some UI paths use `leverage`.
 * Keep both in sync on the snapshot the worker + results panel consume.
 */
function syncLeverageAliasOnBot(b) {
  if (!b || typeof b !== "object") return;
  const fl = b.futuresLeverage;
  const lv = b.leverage;
  const flN = fl != null && Number.isFinite(Number(fl)) ? Math.max(1, Math.floor(Number(fl))) : null;
  const lvN = lv != null && Number.isFinite(Number(lv)) ? Math.max(1, Math.floor(Number(lv))) : null;
  if (flN != null) {
    b.futuresLeverage = flN;
    b.leverage = flN;
  } else if (lvN != null) {
    b.leverage = lvN;
    b.futuresLeverage = lvN;
  }
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function statusForError(e) {
  const s = Number(e?.status);
  if (Number.isInteger(s) && s >= 400 && s < 600) return s;
  return 500;
}

async function assertBotInstanceOwned(botInstanceId, userId) {
  const r = await query(
    `SELECT 1
       FROM bot_instances bi
       JOIN accounts a ON a.id = bi.account_id
      WHERE bi.id = $1
        AND COALESCE(bi.is_deleted, false) = false
        AND (a.user_id = $2 OR a.account_type = 'system')`,
    [botInstanceId, userId],
  );
  if (!r.rows.length) throw httpError("bot_instance_not_found", 404);
}

function expandParamGrid(grid) {
  const keys = Object.keys(grid);
  if (!keys.length) return [];
  const arrays = keys.map((k) => grid[k].map((v) => ({ [k]: v })));
  return arrays.reduce(
    (acc, list) => acc.flatMap((prev) => list.map((item) => ({ ...prev, ...item }))),
    [{}],
  );
}

function mergeCfgWithParams(cfgRaw, params) {
  const root = cfgRaw && typeof cfgRaw === "object" ? cfgRaw : {};
  const next = JSON.parse(JSON.stringify(root));
  const target = next.bot && typeof next.bot === "object" ? next.bot : next;
  const map = {
    period: "supertrendPeriod",
    multiplier: "supertrendMultiplier",
    wilder: "supertrendWilderAtr",
    mlThreshold: "surfPulseMlThreshold",
    signalStrengthOpenMin: "signalStrengthOpenMin",
    trailBufferRate: "trailBufferRate",
  };
  for (const [k, v] of Object.entries(params)) {
    target[map[k] ?? k] = v;
  }
  return next;
}

function shortLabel(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : v}`)
    .join(" ");
}

async function assertRunOwned(runId, userId) {
  const r = await query(`SELECT 1 FROM backtest_runs WHERE id = $1 AND user_id = $2`, [String(runId), userId]);
  if (!r.rows.length) throw new Error("run_not_found");
}

function notFoundFor(e) {
  return String(e?.message || e) === "run_not_found" ? 404 : 500;
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  // Query params arrive as strings. A pure numeric string (e.g. "1746057600000")
  // is a millisecond epoch — Date.parse rejects it, so handle it first.
  const n = Number(v);
  if (Number.isFinite(n) && n > 1_000_000_000_000) return n; // looks like ms since epoch
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new Error("invalid_date");
  return t;
}

/** jsonb is usually an object; coerce string + alias snake_case monthly_returns for the UI. */
function normalizeBacktestMetrics(raw) {
  if (raw == null) return null;
  let m = raw;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (m.monthlyReturns == null && m.monthly_returns != null) {
    return { ...m, monthlyReturns: m.monthly_returns };
  }
  return m;
}

function mapRunRow(row) {
  return {
    id: String(row.id),
    strategyVersionId: row.strategy_version_id != null ? String(row.strategy_version_id) : null,
    botInstanceId: row.bot_instance_id != null ? String(row.bot_instance_id) : null,
    label: row.label != null ? String(row.label) : null,
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    startDate: row.start_date,
    endDate: row.end_date,
    initialCapital: Number(row.initial_capital ?? 0),
    finalCapital: row.final_capital != null ? Number(row.final_capital) : null,
    engineType: row.engine_type != null ? String(row.engine_type) : null,
    status: String(row.status),
    progressPct: Number(row.progress_pct ?? 0),
    totalTrades: row.total_trades != null ? Number(row.total_trades) : null,
    winRatePct: row.win_rate_pct != null ? Number(row.win_rate_pct) : null,
    totalPnlUsdt: row.total_pnl_usdt != null ? Number(row.total_pnl_usdt) : null,
    maxDrawdownPct: row.max_drawdown_pct != null ? Number(row.max_drawdown_pct) : null,
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    profitFactor: row.profit_factor != null ? Number(row.profit_factor) : null,
    gateMode: row.gate_mode != null ? String(row.gate_mode) : "off",
    error: row.error_message != null ? String(row.error_message) : null,
    coveragePct: row.data_coverage_pct != null ? Number(row.data_coverage_pct) : null,
    metrics: normalizeBacktestMetrics(row.metrics),
    costModel: row.cost_model ?? null,
    configSnapshot: row.config_snapshot ?? null,
    instanceOperationalSnapshot: row.instance_operational_snapshot ?? null,
    configSource: row.config_source != null ? String(row.config_source) : "strategy_only",
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? row.completed_at ?? null,
  };
}

function mapTradeRow(row) {
  return {
    tradeNumber: Number(row.trade_number),
    direction: String(row.direction),
    entryTs: row.entry_time,
    exitTs: row.exit_time,
    entryPrice: Number(row.entry_price ?? 0),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    qty: Number(row.quantity ?? 0),
    slPrice: row.sl_price != null ? Number(row.sl_price) : null,
    tpPrice: row.tp_price != null ? Number(row.tp_price) : null,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : null,
    grossPnl: row.gross_pnl != null ? Number(row.gross_pnl) : 0,
    fees: row.fees_usdt != null ? Number(row.fees_usdt) : 0,
    fundingPaid: row.funding_paid != null ? Number(row.funding_paid) : 0,
    slippageCost: row.slippage_cost != null ? Number(row.slippage_cost) : 0,
    netPnl: row.net_pnl != null ? Number(row.net_pnl) : 0,
    barsHeld: row.bars_held != null ? Number(row.bars_held) : 0,
    maePct: row.mae_pct != null ? Number(row.mae_pct) : null,
    mfePct: row.mfe_pct != null ? Number(row.mfe_pct) : null,
    intelScoreAtEntry: row.intel_score_at_entry != null ? Number(row.intel_score_at_entry) : null,
    gateAction: row.gate_action != null ? String(row.gate_action) : null,
    trailTierLabel: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      return obj?.trailTierLabel != null ? String(obj.trailTierLabel) : null;
    })(),
    trailStep: (() => {
      const sc = row.signal_context;
      if (!sc) return 0;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      return obj?.trailStep != null ? Number(obj.trailStep) : 0;
    })(),
    equityAtEntry: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      const v = obj?.equityAtEntry;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    marginUsdt: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      const v = obj?.marginUsdt;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    entryQuality: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      return obj?.entryQuality ?? null;
    })(),
    lossPattern: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      return obj?.lossPattern != null ? String(obj.lossPattern) : null;
    })(),
    entryReason: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      return obj?.entryReason != null ? String(obj.entryReason) : null;
    })(),
    liqContext: (() => {
      const sc = row.signal_context;
      if (!sc) return null;
      const obj = typeof sc === "string" ? (() => { try { return JSON.parse(sc); } catch { return null; } })() : sc;
      const liq = obj?.liq;
      return liq && typeof liq === "object" ? liq : null;
    })(),
  };
}
