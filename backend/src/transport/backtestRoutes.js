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
 *   GET    /api/backtest/runs/:id/trail-tick-audit/estimate
 *   POST   /api/backtest/runs/:id/trail-tick-audit
 *   GET    /api/backtest/runs/:id/trail-tick-audit
 *   POST   /api/backtest/runs/:id/cancel          cooperative cancel
 *   DELETE /api/backtest/runs/:id                 cancel-or-delete
 *   GET    /api/backtest/data/coverage            (symbol, tf[, from, to])
 *   POST   /api/backtest/data/sync                start async OHLC backfill (returns jobId)
 *   POST   /api/backtest/data/sync-mark           start async mark backfill (returns jobId)
 *   GET    /api/backtest/data/sync/:jobId         poll sync job progress
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
import { pickRawIntradayPanelFromBot, materializeIntradayPanelOnCfg, materializeLiqTrailingGateOnCfg } from "../strategy/intradayPanelKeys.js";
import { fillSmcSoloPresetDefaults, materializeIntradayEngineCfgSync } from "../strategy/presets/srIntradayOptimized.js";
import { mergeInstanceIntoCfgRaw, ensureBacktestMarketMode, stripInstanceFieldsFromCfgRaw, uiOperationalPatchToInstColumns, applyInstanceOperationalToConfigSnapshot, applyInstanceOperationalToBot, INSTANCE_FIELD_KEYS } from "../lib/strategyInstanceSplit.js";
import { sanitizeSignalBrainCfgRaw, sanitizeBacktestConfigSnapshot, BACKTEST_SNAPSHOT_META_KEYS } from "../lib/strategySignalBrain.js";
import { resolveSituationRouterCfg } from "../strategy/situationIntraday.js";
import { resolveCrtTbsCfg } from "../strategy/crtTbsIntraday.js";
import { resolveTokyoSessionCfg } from "../strategy/tokyoSessionIntraday.js";
import { InsufficientCapitalError } from "../db/services/capitalAllotmentService.js";
import {
  enqueueRun,
  cancelRun as poolCancel,
  isRunInPool,
  recoverOrphanedBacktestRuns,
} from "../backtest/engine/pool.js";
import { failRun } from "../backtest/engine/persistence.js";
import { ensureKlines, readCandles } from "../backtest/data/klineIngest.js";
import { ensureMarkKlines, getMarkCoverage, getMarkMonthlyCoverage } from "../backtest/data/markPriceIngest.js";
import { ensureFunding } from "../backtest/data/fundingIngest.js";
import { ensureFearGreed } from "../backtest/data/fearGreedIngest.js";
import { ensureOpenInterest } from "../backtest/data/openInterestIngest.js";
import { getCoverage, getMonthlyCoverage } from "../backtest/data/dataCoverage.js";
import {
  createDataSyncJob,
  getDataSyncJob,
  updateDataSyncJob,
  publicDataSyncJob,
} from "../backtest/data/dataSyncJobs.js";
import { SUPPORTED_TIMEFRAMES, tfToMs } from "../backtest/data/timeframe.js";
import { resolveTrailActivationOn } from "../backtest/engine/trailingSim.js";
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
    symbol: z.string().regex(SYMBOL_RE).optional(),
    /** Multi-coin portfolio mode: 2–10 symbols; server sets symbol=PORTFOLIO. */
    symbols: z.array(z.string().regex(SYMBOL_RE)).min(2).max(10).optional(),
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
    positionSizing: z.enum(["RISK_AT_SL", "RISK_AT_SL_FULL_MARGIN", "FULL_EQUITY_MARGIN"]).optional(),
    /**
     * Portfolio-only capital model:
     * - EQUAL_SLICE_FULL_MARGIN: 100% of equal slice (default)
     * - EQUAL_SLICE_RISK_AT_SL: risk-at-SL vs equal slice
     * - TOTAL_CAPITAL_RISK_AT_SL: risk-at-SL vs total capital; skip overlapping later entries
     */
    portfolioPositionSizing: z
      .enum(["EQUAL_SLICE_FULL_MARGIN", "EQUAL_SLICE_RISK_AT_SL", "TOTAL_CAPITAL_RISK_AT_SL"])
      .optional(),
    /** Trailing micro timeframe for backtest replay (`off`, `1m`, `5m`, …). */
    trailMicroTf: z.enum(["off", "1m", "3m", "5m", "15m", "30m"]).optional(),
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
    const multi = Array.isArray(d.symbols) && d.symbols.length >= 2;
    if (!multi && !d.symbol) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "symbol_or_symbols_required", path: ["symbol"] });
    }
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
      const portfolioSymbols = Array.isArray(data.symbols)
        ? [...new Set(data.symbols.map((s) => String(s).toUpperCase()))]
        : null;
      const isPortfolio = portfolioSymbols != null && portfolioSymbols.length >= 2;
      const runSymbol = isPortfolio ? "PORTFOLIO" : String(data.symbol).toUpperCase();
      const snapshot = await buildRunConfigSnapshot({
        ver,
        userId,
        strategyVersionId,
        botInstanceId: data.botInstanceId,
        symbol: isPortfolio ? portfolioSymbols[0] : runSymbol,
        timeframe: data.timeframe,
        positionSizing: data.positionSizing,
        portfolioPositionSizing: isPortfolio ? data.portfolioPositionSizing : undefined,
        trailMicroTf: data.trailMicroTf,
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
      const snapBot = pickBotFromConfigSnapshot(snapshot.configSnapshot);
      const trailTfSaved = snapBot.backtestTrailMicroTf ?? null;
      if (data.trailMicroTf != null && trailTfSaved !== data.trailMicroTf) {
        console.warn(
          "[backtest] trailMicroTf mismatch after snapshot build",
          { requested: data.trailMicroTf, saved: trailTfSaved },
        );
      }
      const gateModeEffective = snapBot.intelligenceGateEnabled === true ? "approx" : "off";
      const engineType = pickEngineType(snapshot.configSnapshot);
      const ins = await query(
        `INSERT INTO backtest_runs (
            strategy_version_id, user_id, label,
            symbol, timeframe, start_date, end_date,
            initial_capital, engine_type,
            cost_model, gate_mode, config_snapshot, walk_forward_split,
            bot_instance_id, instance_operational_snapshot, config_source,
            symbols, is_portfolio,
            status, progress_pct
         ) VALUES (
            $1,$2,$3, $4,$5,$6,$7, $8,$9, $10::jsonb,$11,$12::jsonb,$13::jsonb,
            $14,$15::jsonb,$16, $17, $18, 'queued', 0
         )
         RETURNING id`,
        [
          strategyVersionId,
          userId,
          data.label ?? (isPortfolio ? `Portfolio ${portfolioSymbols.join(",")}` : null),
          runSymbol,
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
          isPortfolio ? portfolioSymbols : null,
          isPortfolio,
        ],
      );
      const runId = String(ins.rows[0].id);
      if (trailTfSaved) {
        console.info(`[backtest] run ${runId} trailMicroTf=${trailTfSaved}`);
      } else if (data.trailMicroTf) {
        console.warn(`[backtest] run ${runId} trailMicroTf not persisted (requested ${data.trailMicroTf})`);
      }
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
                data_coverage_pct, metrics,
                bot_instance_id, config_source,
                symbols, is_portfolio,
                created_at, started_at, finished_at
           FROM backtest_runs
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit],
      );
      res.json({ ok: true, runs: r2.rows.map((row) => mapRunRow(row, { list: true })) });
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
      let row = r2.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: "run_not_found" });
      try {
        const { backfillWalkForwardMetrics } = await import("../backtest/engine/walkForwardBackfill.js");
        row = await backfillWalkForwardMetrics(row);
      } catch {
        /* optional */
      }
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

  r.get("/runs/:id/trail-tick-audit/estimate", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const { estimateTrailTickAuditForRun } = await import("../backtest/engine/trailTickAudit.js");
      const estimate = await estimateTrailTickAuditForRun(String(req.params.id), userId);
      res.json({ ok: true, estimate });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/runs/:id/trail-tick-audit", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const { getTrailTickAudit, isTrailTickAuditRunning } = await import("../backtest/engine/trailTickAudit.js");
      const audit = await getTrailTickAudit(String(req.params.id), userId);
      res.json({
        ok: true,
        audit,
        running: isTrailTickAuditRunning(String(req.params.id)),
      });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/runs/:id/trail-tick-audit", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const modeRaw = String(body.mode ?? "mark_1m_ohlc").toLowerCase();
    const mode = ["hybrid", "mark_1m_ohlc", "aggtrade_proxy", "aggTrade_proxy"].includes(modeRaw)
      ? modeRaw === "aggtrade_proxy"
        ? "aggTrade_proxy"
        : modeRaw
      : "mark_1m_ohlc";
    const force = body.force === true;
    const forceInline = body.forceInline === true;
    try {
      await assertRunOwned(String(req.params.id), userId);
      const {
        runTrailTickAuditInlineOrBackground,
        isTrailTickAuditRunning,
      } = await import("../backtest/engine/trailTickAudit.js");
      if (isTrailTickAuditRunning(String(req.params.id))) {
        return res.status(409).json({ ok: false, error: "audit_already_running" });
      }
      const out = await runTrailTickAuditInlineOrBackground({
        runId: String(req.params.id),
        userId,
        mode,
        force,
        forceInline,
        wsHub: appState.wsHub,
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
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

  /* ───────────── strategy testing battery (validation + grading) ───────────── */

  const STRATEGY_TEST_JOB_PREFIX = "strategy-test:";

  r.post("/strategy-tests", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const seedRunId = String(req.body?.seedRunId ?? "").trim();
    if (!seedRunId) return res.status(400).json({ ok: false, error: "seed_run_id_required" });
    try {
      const seed = await query(
        `SELECT id, status FROM backtest_runs WHERE id = $1 AND user_id = $2`,
        [seedRunId, userId],
      );
      if (!seed.rows.length) return res.status(404).json({ ok: false, error: "run_not_found" });
      if (String(seed.rows[0].status) !== "done") {
        return res.status(400).json({ ok: false, error: "seed_run_not_done" });
      }
      const dupe = await query(
        `SELECT 1 FROM backtest_strategy_tests
          WHERE user_id = $1 AND status IN ('queued','running')`,
        [userId],
      );
      if (dupe.rows.length) {
        return res.status(409).json({ ok: false, error: "strategy_test_already_running" });
      }
      const ins = await query(
        `INSERT INTO backtest_strategy_tests (user_id, seed_run_id, status, progress_pct)
         VALUES ($1, $2, 'queued', 0)
         RETURNING id`,
        [userId, seedRunId],
      );
      const testId = String(ins.rows[0].id);
      enqueueRun(`${STRATEGY_TEST_JOB_PREFIX}${testId}`).catch(async (e) => {
        console.error("[backtest] strategy test enqueue failed", testId, e?.message || e);
        const { failTest } = await import("../backtest/engine/strategyTest.js");
        void failTest(testId, e);
      });
      res.json({ ok: true, testId });
    } catch (e) {
      res.status(statusForError(e)).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategy-tests", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    try {
      const r2 = await query(
        `SELECT st.id, st.seed_run_id, st.status, st.progress_pct, st.current_phase,
                st.grade, st.live_fidelity_score, st.error_message,
                st.created_at, st.started_at, st.finished_at,
                br.symbol AS seed_symbol, br.symbols AS seed_symbols, br.timeframe AS seed_timeframe,
                br.label AS seed_label, br.engine_type AS seed_engine_type
           FROM backtest_strategy_tests st
           JOIN backtest_runs br ON br.id = st.seed_run_id
          WHERE st.user_id = $1
          ORDER BY st.created_at DESC
          LIMIT $2`,
        [userId, limit],
      );
      res.json({ ok: true, tests: r2.rows.map(mapStrategyTestRow) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get("/strategy-tests/:id", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const r2 = await query(
        `SELECT st.*, br.symbol AS seed_symbol, br.symbols AS seed_symbols, br.timeframe AS seed_timeframe,
                br.label AS seed_label, br.engine_type AS seed_engine_type
           FROM backtest_strategy_tests st
           JOIN backtest_runs br ON br.id = st.seed_run_id
          WHERE st.id = $1 AND st.user_id = $2`,
        [String(req.params.id), userId],
      );
      const row = r2.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: "strategy_test_not_found" });
      res.json({ ok: true, test: mapStrategyTestRow(row, { detail: true }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/strategy-tests/:id/cancel", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      const owned = await query(
        `SELECT 1 FROM backtest_strategy_tests WHERE id = $1 AND user_id = $2`,
        [String(req.params.id), userId],
      );
      if (!owned.rows.length) return res.status(404).json({ ok: false, error: "strategy_test_not_found" });
      const cancelled = poolCancel(`${STRATEGY_TEST_JOB_PREFIX}${String(req.params.id)}`);
      await query(
        `UPDATE backtest_strategy_tests
            SET status = 'cancelled', finished_at = NOW()
          WHERE id = $1 AND status IN ('queued','running')`,
        [String(req.params.id)],
      );
      res.json({ ok: true, cancelled });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete("/strategy-tests/:id", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const userId = uid(req);
    if (!userId) return res.status(403).json({ ok: false, error: "db_user_required" });
    try {
      poolCancel(`${STRATEGY_TEST_JOB_PREFIX}${String(req.params.id)}`);
      await query(`DELETE FROM backtest_strategy_tests WHERE id = $1 AND user_id = $2`, [
        String(req.params.id),
        userId,
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    const marketQ = String(req.query.market ?? req.query.marketMode ?? "futures").toLowerCase();
    const market = marketQ === "spot" ? "spot" : "futures";
    try {
      const candles = await readCandles(symbol, tf, from, to, { market });
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
      let markCoverage = null;
      let markMonthly = [];
      if (from != null && to != null) {
        markCoverage = await getMarkCoverage(symbol, { from, to });
        markMonthly = await getMarkMonthlyCoverage(symbol, from, to);
      }
      res.json({ ok: true, coverage: summary, monthly, markCoverage, markMonthly });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** Batch coverage for multi-coin selector: ?symbols=BTC,ETH&timeframe=1h&from=&to= */
  r.get("/data/coverage-batch", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const raw = String(req.query.symbols ?? "");
    const symbols = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => SYMBOL_RE.test(s));
    if (!symbols.length) return res.status(400).json({ ok: false, error: "symbols_required" });
    const tf = String(req.query.timeframe ?? req.query.tf ?? "");
    if (!SUPPORTED_TIMEFRAMES.includes(tf)) return res.status(400).json({ ok: false, error: "invalid_timeframe" });
    const from = req.query.from != null ? toMs(req.query.from) : null;
    const to = req.query.to != null ? toMs(req.query.to) : null;
    try {
      const out = {};
      await Promise.all(
        symbols.map(async (sym) => {
          const summary = await getCoverage(sym, tf, {
            from: from ?? undefined,
            to: to ?? undefined,
          });
          out[sym] = summary;
        }),
      );
      res.json({ ok: true, coverageBySymbol: out });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post("/data/sync-mark", requireDbUserSession, async (req, res) => {
    if (!getPool()) return res.status(503).json({ ok: false, error: "db_not_configured" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const symbol = String(body.symbol ?? "").toUpperCase();
    const from = body.from != null ? toMs(body.from) : null;
    const to = body.to != null ? toMs(body.to) : Date.now();
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "invalid_symbol" });
    if (from == null) return res.status(400).json({ ok: false, error: "from_required" });

    const job = createDataSyncJob("mark");
    const broadcast = (patch) => {
      const j = updateDataSyncJob(job.id, patch);
      if (!j) return;
      appState.wsHub?.broadcast?.("data_sync_progress", publicDataSyncJob(j));
    };
    broadcast({ status: "running", progressPct: 0, phase: "mark" });
    res.json({ ok: true, async: true, ...publicDataSyncJob(job) });

    void (async () => {
      try {
        const markKlines = await ensureMarkKlines(symbol, {
          from,
          to,
          onProgress: ({ pct, phase }) => broadcast({ progressPct: pct, phase: phase ?? "mark" }),
        });
        broadcast({ status: "done", progressPct: 100, phase: "done", result: { markKlines } });
      } catch (e) {
        broadcast({
          status: "failed",
          phase: "failed",
          error: String(e?.message || e),
        });
      }
    })();
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

    const job = createDataSyncJob("ohlc");
    const broadcast = (patch) => {
      const j = updateDataSyncJob(job.id, patch);
      if (!j) return;
      appState.wsHub?.broadcast?.("data_sync_progress", publicDataSyncJob(j));
    };
    broadcast({ status: "running", progressPct: 0, phase: "klines" });
    // Return immediately — multi-year backfills exceed HTTP/proxy idle timeouts.
    res.json({ ok: true, async: true, ...publicDataSyncJob(job) });

    void (async () => {
      try {
        const mapPct = (local0to100, lo, hi) => {
          const local = Math.max(0, Math.min(100, Number(local0to100) || 0));
          return lo + (local / 100) * (hi - lo);
        };

        const klines = await ensureKlines(symbol, tf, {
          from,
          to,
          market,
          onProgress: ({ pct }) => {
            const mapped = mapPct(pct, 0, market === "futures" ? 70 : 90);
            // Show at least 1% once OHLC work has started past the first tick.
            const shown = pct > 0 ? Math.max(1, Math.round(mapped)) : Math.round(mapped);
            broadcast({ progressPct: shown, phase: "klines" });
          },
        });

        let markKlines = { inserted: 0, gaps: 0 };
        if (market === "futures") {
          markKlines = await ensureMarkKlines(symbol, {
            from,
            to,
            onProgress: ({ pct }) => {
              const mapped = mapPct(pct, 70, 85);
              broadcast({ progressPct: Math.max(70, Math.round(mapped)), phase: "mark" });
            },
          }).catch(() => ({ inserted: 0, gaps: 0 }));
          if (tf !== "1m") {
            await ensureKlines(symbol, "1m", {
              from,
              to,
              market: "futures",
              onProgress: ({ pct }) => {
                const mapped = mapPct(pct, 85, 92);
                broadcast({ progressPct: Math.max(85, Math.round(mapped)), phase: "klines_1m" });
              },
            }).catch(() => ({ inserted: 0, gaps: 0 }));
          } else {
            broadcast({ progressPct: 92, phase: "klines_1m" });
          }
        }

        broadcast({ progressPct: 94, phase: "funding" });
        let funding = { inserted: 0 };
        if (market === "futures") {
          funding = await ensureFunding(symbol, { from, to }).catch(() => ({ inserted: 0 }));
        }
        broadcast({ progressPct: 96, phase: "fear_greed" });
        const fng = await ensureFearGreed({ limit: 0 }).catch(() => ({ inserted: 0 }));
        broadcast({ progressPct: 98, phase: "open_interest" });
        const oi =
          market === "futures"
            ? await ensureOpenInterest(symbol, { from, to, period: "1h" }).catch(() => ({ inserted: 0 }))
            : { inserted: 0 };

        broadcast({
          status: "done",
          progressPct: 100,
          phase: "done",
          result: { klines, markKlines, funding, fearGreed: fng, openInterest: oi },
        });
      } catch (e) {
        broadcast({
          status: "failed",
          phase: "failed",
          error: String(e?.message || e),
        });
      }
    })();
  });

  r.get("/data/sync/:jobId", requireDbUserSession, async (req, res) => {
    const job = getDataSyncJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job_not_found" });
    res.json({ ok: true, ...publicDataSyncJob(job) });
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

function materializeTrailingGateOnSnapshot(configSnapshot) {
  if (!configSnapshot || typeof configSnapshot !== "object") return configSnapshot;
  if (configSnapshot.bot && typeof configSnapshot.bot === "object") {
    const prior = configSnapshot.bot;
    const bot = materializeLiqTrailingGateOnCfg(materializeIntradayPanelOnCfg(prior));
    return {
      ...configSnapshot,
      bot: retainSnapshotBotMeta(prior, bot),
    };
  }
  return materializeLiqTrailingGateOnCfg(materializeIntradayPanelOnCfg(configSnapshot));
}

async function buildRunConfigSnapshot({
  ver,
  userId,
  strategyVersionId,
  botInstanceId,
  symbol,
  timeframe,
  positionSizing,
  portfolioPositionSizing,
  trailMicroTf,
  useLivePanelOverrides = false,
  instanceOperational,
  req,
  appState,
}) {
  const base = sanitizeSignalBrainCfgRaw(cloneStrategyCfgSnapshot(ver?.cfgRaw), { hydrate: true });
  if (!botInstanceId) {
    let configSnapshot = withBacktestRunOptions(withRequestedMarket(base, symbol, timeframe), {
      positionSizing,
      portfolioPositionSizing,
      trailMicroTf,
      strategyTimeframe: timeframe,
    });
    configSnapshot = await overlayOperationalDefaultsOnSnapshot(configSnapshot, { req, appState });
    if (useLivePanelOverrides) {
      configSnapshot = await overlayLiveIntradayPanelOnSnapshot(configSnapshot, {
        appState,
        req,
        botInstanceId: null,
      });
    }
    configSnapshot = finalizeBacktestConfigSnapshot(configSnapshot);
    return {
      configSnapshot: sanitizeBacktestConfigSnapshot(configSnapshot),
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
  const operationalConfig = resolveInstanceOperationalForBacktest(binding, { instanceOperational });
  const merged = mergeInstanceIntoCfgRaw(base, operationalConfig);
  let configSnapshot = withBacktestRunOptions(withRequestedMarket(merged, symbol, timeframe), {
    positionSizing,
    portfolioPositionSizing,
    trailMicroTf,
    strategyTimeframe: timeframe,
  });
  applyInstanceOperationalToConfigSnapshot(configSnapshot, operationalConfig);
  if (useLivePanelOverrides) {
    configSnapshot = await overlayLiveIntradayPanelOnSnapshot(configSnapshot, {
      appState,
      req,
      botInstanceId,
    });
  }
  configSnapshot = finalizeBacktestConfigSnapshot(configSnapshot);
  return {
    configSnapshot: sanitizeBacktestConfigSnapshot(configSnapshot),
    botInstanceId: String(botInstanceId),
    instanceOperationalSnapshot: operationalConfig ?? null,
    configSource: useLivePanelOverrides ? "instance_snapshot_with_live_panel" : "instance_snapshot",
  };
}

/** Merge DB instance ops + UI submit patch (instance-owned fields only; no live engine fill). */
function resolveInstanceOperationalForBacktest(binding, { instanceOperational }) {
  const op = { ...(binding.operationalConfig ?? {}) };
  const clientPatch = uiOperationalPatchToInstColumns(instanceOperational);
  for (const [k, v] of Object.entries(clientPatch)) {
    if (v != null) op[k] = v;
  }
  return op;
}

/** Materialize intraday/SMC engine cfg on the snapshot so backtest = saved panel values. */
function retainSnapshotBotMeta(priorBot, engine) {
  const out = { ...engine };
  for (const key of BACKTEST_SNAPSHOT_META_KEYS) {
    if (priorBot[key] !== undefined) out[key] = priorBot[key];
  }
  return out;
}

/** Materialize intraday/SMC engine cfg on the snapshot so backtest = saved panel values. */
function materializeBacktestEngineSnapshot(cfgRaw) {
  const root = cloneStrategyCfgSnapshot(cfgRaw);
  const b = pickBotFromConfigSnapshot(root);
  const preserved = {};
  for (const key of INSTANCE_FIELD_KEYS) {
    if (b[key] !== undefined) preserved[key] = b[key];
  }
  const strat = String(b.manualStrategy ?? "").toUpperCase();
  let engine = b;
  let didIntradayMaterialize = false;
  if (strat === "SITUATION_INTRADAY") {
    // SR_INTRADAY materialized keys pollute situation bracket simulation.
    engine = { ...resolveSituationRouterCfg(b), ...preserved };
  } else if (strat === "CRT_TBS") {
    engine = { ...resolveCrtTbsCfg(b), ...preserved };
  } else if (strat === "TOKYO_SESSION") {
    engine = { ...resolveTokyoSessionCfg(b), ...preserved };
  } else if (strat === "SUPERTREND_ELITE" || strat === "UNIFIED_ELITE") {
    engine = { ...b, ...preserved };
  } else {
    engine = materializeIntradayEngineCfgSync(b, materializeIntradayPanelOnCfg);
    Object.assign(engine, preserved);
    didIntradayMaterialize = true;
  }
  engine._intradayEngineMaterialized = true;
  engine._intradayEngineMaterializedAt = new Date().toISOString();
  const replaceBotRoot =
    strat === "SITUATION_INTRADAY" ||
    strat === "CRT_TBS" ||
    strat === "TOKYO_SESSION" ||
    didIntradayMaterialize;
  if (replaceBotRoot) {
    const botOut = retainSnapshotBotMeta(b, engine);
    if (root.bot && typeof root.bot === "object") {
      root.bot = botOut;
    } else {
      return { v: root.v ?? 1, bot: botOut };
    }
  } else if (root.bot && typeof root.bot === "object") {
    root.bot = { ...root.bot, ...engine };
  } else {
    return { v: root.v ?? 1, bot: engine };
  }
  return root;
}

/** Per-run simulator options stored on the strategy snapshot (`config_snapshot.bot`). */
function withBacktestRunOptions(
  cfgRaw,
  { positionSizing, portfolioPositionSizing, trailMicroTf, strategyTimeframe } = {},
) {
  const root = cloneStrategyCfgSnapshot(cfgRaw);
  const b = pickBotFromConfigSnapshot(root);
  if (positionSizing) b.backtestPositionSizing = positionSizing;
  if (portfolioPositionSizing) {
    b.portfolioPositionSizing = portfolioPositionSizing;
    // Unit-sim sizing implied by portfolio mode (worker also re-applies).
    if (portfolioPositionSizing === "EQUAL_SLICE_FULL_MARGIN") {
      b.backtestPositionSizing = "FULL_EQUITY_MARGIN";
    } else {
      b.backtestPositionSizing = "RISK_AT_SL";
    }
  }
  if (trailMicroTf != null) {
    const tf = String(trailMicroTf).trim().toLowerCase();
    const stratTf = String(strategyTimeframe ?? b.timeframe ?? "15m").trim().toLowerCase();
    let microTf = tf;
    if (microTf !== "off") {
      try {
        const microMs = tfToMs(microTf);
        const stratMs = tfToMs(stratTf);
        // Micro TF must not be coarser than the strategy bar (5m trail on 15m ok; 30m on 15m invalid).
        if (!Number.isFinite(microMs) || !Number.isFinite(stratMs) || microMs > stratMs) microTf = "1m";
      } catch {
        microTf = "1m";
      }
    }
    b.backtestTrailMicroTf = microTf;
    b.backtestTrailActivationOn = resolveTrailActivationOn(microTf);
  }
  b._engineVersion = BACKTEST_ENGINE_VERSION;
  return root;
}

/** Materialize engine + trailing gates — call after optional live-panel overlay. */
function finalizeBacktestConfigSnapshot(configSnapshot) {
  let out = materializeBacktestEngineSnapshot(configSnapshot);
  out = materializeTrailingGateOnSnapshot(out);
  return out;
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

function mapStrategyTestRow(row, { detail = false } = {}) {
  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === "object") return v;
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  };
  return {
    id: String(row.id),
    seedRunId: String(row.seed_run_id),
    seedLabel: row.seed_label != null ? String(row.seed_label) : null,
    seedSymbol: row.seed_symbol != null ? String(row.seed_symbol) : null,
    seedSymbols: Array.isArray(row.seed_symbols) ? row.seed_symbols.map(String) : null,
    seedTimeframe: row.seed_timeframe != null ? String(row.seed_timeframe) : null,
    seedEngineType: row.seed_engine_type != null ? String(row.seed_engine_type) : null,
    status: String(row.status),
    progressPct: Number(row.progress_pct ?? 0),
    currentPhase: row.current_phase != null ? String(row.current_phase) : null,
    grade: row.grade != null ? String(row.grade) : null,
    liveFidelityScore: row.live_fidelity_score != null ? Number(row.live_fidelity_score) : null,
    error: row.error_message != null ? String(row.error_message) : null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    ...(detail
      ? {
          report: parseJson(row.report),
          suggestion: parseJson(row.suggestion),
        }
      : {}),
  };
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

function parseJsonColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function mapRunRow(row, opts = {}) {
  const list = opts.list === true;
  return {
    id: String(row.id),
    strategyVersionId: row.strategy_version_id != null ? String(row.strategy_version_id) : null,
    botInstanceId: row.bot_instance_id != null ? String(row.bot_instance_id) : null,
    label: row.label != null ? String(row.label) : null,
    symbol: String(row.symbol),
    isPortfolio: row.is_portfolio === true,
    symbols: Array.isArray(row.symbols) ? row.symbols.map((s) => String(s)) : null,
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
    walkForwardSplit: parseJsonColumn(row.walk_forward_split),
    costModel: list ? null : (row.cost_model ?? null),
    configSnapshot: list ? null : parseJsonColumn(row.config_snapshot),
    instanceOperationalSnapshot: list ? null : parseJsonColumn(row.instance_operational_snapshot),
    configSource: row.config_source != null ? String(row.config_source) : "strategy_only",
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? row.completed_at ?? null,
  };
}

function parseTradeSignalContext(row) {
  const sc = row.signal_context;
  if (!sc) return null;
  if (typeof sc === "object") return sc;
  try {
    return JSON.parse(sc);
  } catch {
    return null;
  }
}

function signalContextMsToIso(sc, key) {
  const v = sc?.[key];
  if (v == null || !Number.isFinite(Number(v))) return null;
  return new Date(Number(v)).toISOString();
}

function mapTradeRow(row) {
  const sc = parseTradeSignalContext(row);
  return {
    tradeNumber: Number(row.trade_number),
    symbol: row.symbol != null ? String(row.symbol) : null,
    direction: String(row.direction),
    entryTs: row.entry_time,
    entryBarTs: signalContextMsToIso(sc, "entryBarTs") ?? row.entry_time,
    entryFillTs: signalContextMsToIso(sc, "entryFillTs"),
    entrySameBar: sc?.entrySameBar === true ? true : sc?.entrySameBar === false ? false : null,
    entryMarkPx: sc?.entryMarkPx != null && Number.isFinite(Number(sc.entryMarkPx)) ? Number(sc.entryMarkPx) : null,
    exitTs: row.exit_time,
    exitFillTs: signalContextMsToIso(sc, "exitFillTs"),
    entryPrice: Number(row.entry_price ?? 0),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    qty: Number(row.quantity ?? 0),
    slPrice: (() => {
      const n = Number(row.sl_price);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    tpPrice: (() => {
      const n = Number(row.tp_price);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
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
      if (!sc) return null;
      return sc.trailTierLabel != null ? String(sc.trailTierLabel) : null;
    })(),
    trailStep: (() => {
      if (!sc) return 0;
      return sc.trailStep != null ? Number(sc.trailStep) : 0;
    })(),
    trailEvents: (() => {
      if (!sc || !Array.isArray(sc.trailEvents)) return null;
      return sc.trailEvents.map((ev) => ({
        ts: ev.ts != null ? Number(ev.ts) : null,
        step: ev.step != null ? Number(ev.step) : 0,
        tierLabel: ev.tierLabel != null ? String(ev.tierLabel) : null,
        slPrice: ev.slPrice != null && Number.isFinite(Number(ev.slPrice)) ? Number(ev.slPrice) : null,
        favorablePx:
          ev.favorablePx != null && Number.isFinite(Number(ev.favorablePx)) ? Number(ev.favorablePx) : null,
        nextActivationPx:
          ev.nextActivationPx != null && Number.isFinite(Number(ev.nextActivationPx))
            ? Number(ev.nextActivationPx)
            : null,
      }));
    })(),
    equityAtEntry: (() => {
      if (!sc) return null;
      const v = sc.equityAtEntry;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    marginUsdt: (() => {
      if (!sc) return null;
      const v = sc.marginUsdt;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    initialSlPrice: (() => {
      if (!sc) return null;
      const v = sc.initialSlPrice;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    initialRiskUsd: (() => {
      if (!sc) return null;
      const v = sc.initialRiskUsd;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    })(),
    entryQuality: (() => {
      if (!sc) return null;
      return sc.entryQuality ?? null;
    })(),
    lossPattern: (() => {
      if (!sc) return null;
      return sc.lossPattern != null ? String(sc.lossPattern) : null;
    })(),
    entryReason: (() => {
      if (!sc) return null;
      return sc.entryReason != null ? String(sc.entryReason) : null;
    })(),
    liqContext: (() => {
      if (!sc) return null;
      const liq = sc.liq;
      return liq && typeof liq === "object" ? liq : null;
    })(),
  };
}
