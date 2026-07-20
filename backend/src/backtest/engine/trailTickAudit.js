/**
 * Orchestrator: trailing tick audit for completed backtest runs.
 */

import { query } from "../../db/query.js";
import { readCandles } from "../data/klineIngest.js";
import { readMicroTrailBars } from "../data/markPriceIngest.js";
import { ensureAggTradesForWindow, estimateTickCount, readAggTrades } from "../data/visionTickIngest.js";
import { resolveBacktestTickSize } from "./backtestSymbolMeta.js";
import { resolveCostModel } from "./costModel.js";
import { buildSupertrendSeries } from "./signals/supertrend.js";
import { tfToMs } from "../data/timeframe.js";
import {
  buildHybridTickSeries,
  calendarDaysInRange,
  indexMarkBarsByMinute,
  maybeDownsampleTicks,
  mergeHoldWindows,
} from "./trailTickSeries.js";
import { buildSupertrendAtTs, computeTrailReplayStartMs, isTrailReplaySkipped, replayTradeTrailingMicro, replayTradeTrailingTicks } from "./trailTickReplay.js";
import { isTrailingEnabledInCfg } from "../../lib/trailingOptsFromCfg.js";
import { normalizeEliteStRunCfg } from "../../strategy/supertrendElite.js";
import { normalizeLiquidityMapRunCfg } from "../../strategy/liquidityMapStrategy.js";

const INLINE_MAX_TRADES = 20;
const INLINE_MAX_TICKS = 200_000;

function pickBotCfg(snapshot, fallback) {
  if (snapshot?.bot && typeof snapshot.bot === "object") return { ...snapshot.bot };
  if (snapshot && typeof snapshot === "object" && !snapshot.bot) return { ...snapshot };
  const fb = fallback?.bot && typeof fallback.bot === "object" ? fallback.bot : fallback;
  return fb && typeof fb === "object" ? { ...fb } : {};
}

function parseSignalContext(row) {
  const sc = row?.signal_context;
  if (!sc) return {};
  if (typeof sc === "string") {
    try {
      return JSON.parse(sc);
    } catch {
      return {};
    }
  }
  return sc;
}

function mapDbTrade(row) {
  const sc = parseSignalContext(row);
  return {
    tradeNumber: Number(row.trade_number),
    symbol: row.symbol != null ? String(row.symbol) : null,
    direction: String(row.direction),
    entryTs: row.entry_time,
    exitTs: row.exit_time,
    entryPrice: Number(row.entry_price ?? 0),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    qty: Number(row.quantity ?? 0),
    slPrice: row.sl_price != null ? Number(row.sl_price) : null,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : null,
    netPnl: row.net_pnl != null ? Number(row.net_pnl) : 0,
    trailStep: sc.trailStep != null ? Number(sc.trailStep) : 0,
    trailTierLabel: sc.trailTierLabel != null ? String(sc.trailTierLabel) : null,
    initialSlPrice: sc.initialSlPrice != null ? Number(sc.initialSlPrice) : null,
  };
}

export async function prepareAuditCfg(run) {
  let cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  try {
    const { stripRuntimePollutionFromBot, mergeMissingSignalBrainBot, sanitizeSignalBrainCfgRaw } =
      await import("../../lib/strategySignalBrain.js");
    const { sanitizeCfgForStrategy } = await import("../../strategy/strategyConfigProfile.js");
    stripRuntimePollutionFromBot(cfg);
    if (run.strategy_cfg_raw && typeof run.strategy_cfg_raw === "object") {
      const versionBrain = sanitizeSignalBrainCfgRaw(run.strategy_cfg_raw, { hydrate: true }).bot ?? {};
      mergeMissingSignalBrainBot(cfg, versionBrain);
    }
    const stratKey = String(cfg.manualStrategy ?? "").toUpperCase();
    Object.assign(cfg, sanitizeCfgForStrategy(stratKey, cfg, { phase: "runtime" }));
    if (stratKey === "SUPERTREND_ELITE" || stratKey === "UNIFIED_ELITE") {
      Object.assign(cfg, normalizeEliteStRunCfg(cfg));
    } else if (stratKey === "LIQUIDITY_MAP") {
      Object.assign(cfg, normalizeLiquidityMapRunCfg(cfg));
    }
  } catch {
    /* optional */
  }
  return cfg;
}

function normalizeTier(label) {
  if (label == null) return "";
  return String(label).trim().toUpperCase();
}

function compareTrade(backtest, replay) {
  if (replay.replaySkipped) {
    return {
      tradeNumber: backtest.tradeNumber,
      replaySkipped: true,
      skipReason: replay.reason ?? backtest.exitReason,
      match: null,
    };
  }
  const btReason = String(backtest.exitReason ?? "").toLowerCase();
  const rpReason = String(replay.exitReason ?? "").toLowerCase();
  const reasonMatch =
    rpReason === btReason ||
    (["trail", "be", "sl"].includes(btReason) && ["trail", "be", "sl"].includes(rpReason) && btReason === rpReason);
  const tierMatch =
    normalizeTier(backtest.trailTierLabel) === normalizeTier(replay.trailTierLabel) ||
    (Number(backtest.trailStep) === Number(replay.trailStep) && Number(replay.trailStep) > 0);
  const btExitTs = new Date(backtest.exitTs).getTime();
  const rpExitTs = replay.exitTs != null ? Number(replay.exitTs) : null;
  const exitTimeDeltaMs =
    rpExitTs != null && Number.isFinite(btExitTs) ? rpExitTs - btExitTs : null;
  const btExitPx = Number(backtest.exitPrice);
  const rpExitPx = replay.exitPrice != null ? Number(replay.exitPrice) : null;
  const exitPriceDeltaPct =
    rpExitPx != null && Number.isFinite(btExitPx) && btExitPx > 0
      ? ((rpExitPx - btExitPx) / btExitPx) * 100
      : null;
  const netPnlDelta =
    replay.netPnl != null && Number.isFinite(Number(backtest.netPnl))
      ? Number(replay.netPnl) - Number(backtest.netPnl)
      : null;

  return {
    tradeNumber: backtest.tradeNumber,
    replaySkipped: false,
    backtest: {
      exitReason: btReason,
      exitTs: btExitTs,
      exitPrice: btExitPx,
      trailStep: backtest.trailStep,
      trailTierLabel: backtest.trailTierLabel,
      netPnl: Number(backtest.netPnl),
    },
    replay: {
      exitReason: rpReason,
      exitTs: rpExitTs,
      exitPrice: rpExitPx,
      trailStep: replay.trailStep,
      trailTierLabel: replay.trailTierLabel,
      netPnl: replay.netPnl,
      noExitInWindow: replay.noExitInWindow === true,
    },
    reasonMatch,
    tierMatch,
    exitTimeDeltaMs,
    exitPriceDeltaPct,
    netPnlDelta,
    match: reasonMatch && tierMatch,
  };
}

function buildVerdict(perTrade, { backtestNetSum, replayNetSum }) {
  const replayable = perTrade.filter((t) => !t.replaySkipped);
  const compared = replayable.filter((t) => !t.replay?.noExitInWindow);
  const reasonHits = compared.filter((t) => t.reasonMatch).length;
  const tierHits = compared.filter((t) => t.tierMatch).length;
  const exitReasonMatchPct = compared.length ? (reasonHits / compared.length) * 100 : 0;
  const trailTierMatchPct = compared.length ? (tierHits / compared.length) * 100 : 0;
  const deltas = compared.map((t) => t.exitTimeDeltaMs).filter((x) => x != null && Number.isFinite(x));
  deltas.sort((a, b) => a - b);
  const medianExitTimeDeltaMs = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  const netPnlDeltaPct =
    Math.abs(backtestNetSum) > 1e-9 ? ((replayNetSum - backtestNetSum) / Math.abs(backtestNetSum)) * 100 : 0;
  const parityPct = exitReasonMatchPct * 0.45 + trailTierMatchPct * 0.35 + Math.max(0, 100 - Math.min(100, Math.abs(netPnlDeltaPct) * 10)) * 0.2;
  return {
    parityPct: Math.round(parityPct * 10) / 10,
    exitReasonMatchPct: Math.round(exitReasonMatchPct * 10) / 10,
    trailTierMatchPct: Math.round(trailTierMatchPct * 10) / 10,
    medianExitTimeDeltaMs,
    netPnlDeltaPct: Math.round(netPnlDeltaPct * 10) / 10,
    replayableCount: replayable.length,
    comparedCount: compared.length,
    skippedCount: perTrade.length - replayable.length,
  };
}

/**
 * @param {string} runId
 * @param {Array<object>} trades
 */
export function estimateTrailTickAudit(run, trades) {
  const cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const trailingOn = isTrailingEnabledInCfg(cfg);
  const replayable = (trades ?? []).filter((t) => !isTrailReplaySkipped(t.exitReason));
  const windows = mergeHoldWindows(
    replayable.map((t) => ({
      symbol: t.symbol || run.symbol,
      fromMs: new Date(t.entryTs).getTime(),
      toMs: new Date(t.exitTs).getTime(),
    })),
  );
  let holdMs = 0;
  let estTicks = 0;
  const daysSet = new Set();
  for (const w of windows) {
    holdMs += w.toMs - w.fromMs;
    estTicks += estimateTickCount(w.toMs - w.fromMs);
    for (const d of calendarDaysInRange(w.fromMs, w.toMs)) daysSet.add(`${w.symbol}:${d}`);
  }
  const etaSec = Math.max(5, Math.round(estTicks / 50_000) * 10 + daysSet.size * 8);
  return {
    trailingEnabled: trailingOn,
    tradeCount: trades?.length ?? 0,
    replayableCount: replayable.length,
    holdHours: Math.round((holdMs / 3_600_000) * 10) / 10,
    aggTradeDays: daysSet.size,
    estimatedTicks: estTicks,
    etaSec,
    recommendBackground: replayable.length > INLINE_MAX_TRADES || estTicks > INLINE_MAX_TICKS,
  };
}

async function loadRunAndTrades(runId, userId) {
  const r = await query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
       FROM backtest_runs br
       LEFT JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      WHERE br.id = $1 AND br.user_id = $2`,
    [String(runId), String(userId)],
  );
  const run = r.rows[0];
  if (!run) throw Object.assign(new Error("run_not_found"), { status: 404 });
  const tr = await query(
    `SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number ASC`,
    [String(runId)],
  );
  return { run, trades: tr.rows.map(mapDbTrade) };
}

async function persistTrailTickAudit(runId, audit) {
  const cur = await query(`SELECT metrics FROM backtest_runs WHERE id = $1`, [String(runId)]);
  const metrics = cur.rows[0]?.metrics && typeof cur.rows[0].metrics === "object" ? { ...cur.rows[0].metrics } : {};
  metrics.trailTickAudit = audit;
  await query(`UPDATE backtest_runs SET metrics = $2::jsonb WHERE id = $1`, [String(runId), JSON.stringify(metrics)]);
}

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.userId
 * @param {'hybrid'|'mark_1m_ohlc'|'aggTrade_proxy'} [opts.mode]
 * @param {boolean} [opts.force]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {object} [opts.wsHub]
 */
export async function runTrailTickAudit({
  runId,
  userId,
  mode = "mark_1m_ohlc",
  force = false,
  onProgress,
  wsHub = null,
}) {
  const broadcast = (payload) => {
    onProgress?.(payload);
    try {
      wsHub?.broadcast?.("trail_tick_audit_progress", { runId, ...payload });
    } catch {
      /* ignore */
    }
  };

  broadcast({ status: "running", progressPct: 0, phase: "load" });
  const { run, trades } = await loadRunAndTrades(runId, userId);
  if (String(run.status) !== "done") throw Object.assign(new Error("run_not_done"), { status: 400 });

  const cfg = await prepareAuditCfg(run);
  if (!isTrailingEnabledInCfg(cfg)) throw Object.assign(new Error("trailing_not_enabled"), { status: 400 });

  const costModel =
    run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
  const cm = resolveCostModel(cfg, costModel);
  const tf = String(run.timeframe);
  const tfMs = tfToMs(tf);
  const replayable = trades.filter((t) => !isTrailReplaySkipped(t.exitReason));

  const windows = mergeHoldWindows(
    replayable.map((t) => ({
      symbol: t.symbol || run.symbol,
      fromMs: new Date(t.entryTs).getTime(),
      toMs: new Date(t.exitTs).getTime(),
    })),
  );

  broadcast({ status: "running", progressPct: 5, phase: "fetch_ticks" });

  const tickSizeBySymbol = new Map();
  const markBySymbol = new Map();
  const aggBySymbol = new Map();

  function appendUniqueBars(map, sym, bars) {
    const key = String(sym).toUpperCase();
    const byTs = new Map();
    for (const b of map.get(key) ?? []) {
      const ts = Number(b.ts);
      if (Number.isFinite(ts)) byTs.set(ts, b);
    }
    for (const b of bars ?? []) {
      const ts = Number(b.ts);
      if (Number.isFinite(ts)) byTs.set(ts, b);
    }
    map.set(
      key,
      [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
    );
  }

  function appendUniqueAgg(map, sym, rows) {
    const key = String(sym).toUpperCase();
    const byKey = new Map();
    for (const a of map.get(key) ?? []) {
      const ts = Number(a.ts);
      const id = a.aggId ?? a.agg_id;
      if (Number.isFinite(ts)) byKey.set(`${ts}:${id ?? ""}`, a);
    }
    for (const a of rows ?? []) {
      const ts = Number(a.ts);
      const id = a.aggId ?? a.agg_id;
      if (Number.isFinite(ts)) byKey.set(`${ts}:${id ?? ""}`, a);
    }
    map.set(
      key,
      [...byKey.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
    );
  }

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const sym = String(w.symbol).toUpperCase();
    broadcast({
      status: "running",
      progressPct: 5 + Math.round((i / Math.max(1, windows.length)) * 35),
      phase: "fetch_ticks",
      detail: sym,
    });

    if (!tickSizeBySymbol.has(sym)) {
      tickSizeBySymbol.set(sym, await resolveBacktestTickSize(sym, cfg.backtestTickSize ?? cfg.tickSize));
    }

    const markBars = await readMicroTrailBars(sym, w.fromMs, w.toMs + tfMs, { priceSource: "mark" });
    appendUniqueBars(markBySymbol, sym, markBars);

    if (mode === "hybrid" || mode === "aggTrade_proxy") {
      await ensureAggTradesForWindow(sym, w.fromMs, w.toMs + tfMs, {
        onProgress: (p) => broadcast({ ...p, status: "running", symbol: sym }),
      });
      const agg = await readAggTrades(sym, w.fromMs, w.toMs + tfMs);
      appendUniqueAgg(aggBySymbol, sym, agg);
    }
  }

  const runSymbol = String(run.symbol).toUpperCase();
  const parentFrom = Math.min(
    ...replayable.map((t) => new Date(t.entryTs).getTime()),
    new Date(run.start_date).getTime(),
  );
  const parentTo = Math.max(
    ...replayable.map((t) => new Date(t.exitTs).getTime()),
    new Date(run.end_date).getTime(),
  );

  const parentCtxCache = new Map();
  async function parentCtxForSymbol(sym) {
    if (parentCtxCache.has(sym)) return parentCtxCache.get(sym);
    const candles = await readCandles(sym, tf, parentFrom, parentTo);
    const stSeries = buildSupertrendSeries(candles, {
      period: Number(cfg.supertrendPeriod ?? 10),
      multiplier: Number(cfg.supertrendMultiplier ?? 3),
      wilderAtr: cfg.supertrendWilderAtr !== false,
    });
    const ctx = {
      candles,
      stSeries,
      supertrendAtTs: buildSupertrendAtTs(stSeries, candles, tfMs),
    };
    parentCtxCache.set(sym, ctx);
    return ctx;
  }

  broadcast({ status: "running", progressPct: 45, phase: "replay" });

  const perTrade = [];
  let backtestNetSum = 0;
  let replayNetSum = 0;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    broadcast({
      status: "running",
      progressPct: 45 + Math.round((i / Math.max(1, trades.length)) * 50),
      phase: "replay",
      tradeNumber: t.tradeNumber,
    });

    if (isTrailReplaySkipped(t.exitReason)) {
      perTrade.push(compareTrade(t, { replaySkipped: true, reason: t.exitReason }));
      continue;
    }

    backtestNetSum += Number(t.netPnl) || 0;
    const sym = String(t.symbol || runSymbol).toUpperCase();
    const fromMs = new Date(t.entryTs).getTime();
    const toMs = new Date(t.exitTs).getTime();
    const markBars = (markBySymbol.get(sym) ?? []).filter((b) => b.ts >= fromMs - 60_000 && b.ts <= toMs + tfMs);

    let replay;
    if (mode === "mark_1m_ohlc") {
      const parentCtx = await parentCtxForSymbol(sym);
      replay = replayTradeTrailingMicro({
        trade: { ...t, trailReplayStartMs: computeTrailReplayStartMs(fromMs, tfMs) },
        cfg,
        costModel,
        markBars,
        parentCandles: parentCtx.candles,
        stSeries: parentCtx.stSeries,
        tfMs,
        tickSize: tickSizeBySymbol.get(sym) ?? null,
      });
    } else {
      const agg = (aggBySymbol.get(sym) ?? []).filter((a) => a.ts >= fromMs && a.ts <= toMs);
      const markIdx = indexMarkBarsByMinute(markBars);
      let ticks = buildHybridTickSeries(agg, markIdx, mode === "aggTrade_proxy" ? "aggTrade_proxy" : "hybrid");
      ticks = maybeDownsampleTicks(ticks, { force, maxTicks: force ? 2_000_000 : 500_000 });
      const parentCtx = await parentCtxForSymbol(sym);
      replay = replayTradeTrailingTicks({
        trade: { ...t, trailReplayTfMs: tfMs },
        cfg,
        costModel,
        ticks,
        supertrendAtTs: parentCtx.supertrendAtTs,
        tickSize: tickSizeBySymbol.get(sym) ?? null,
        leverage: cm.leverage,
      });
    }

    const cmp = compareTrade(t, replay);
    perTrade.push(cmp);
    if (!cmp.replaySkipped && replay.netPnl != null) replayNetSum += Number(replay.netPnl);
  }

  const verdict = buildVerdict(perTrade, { backtestNetSum, replayNetSum });
  const result = {
    status: "done",
    mode,
    completedAt: new Date().toISOString(),
    tradeCount: trades.length,
    verdict,
    perTrade,
  };

  await persistTrailTickAudit(runId, result);
  broadcast({ status: "done", progressPct: 100, phase: "complete", verdict });
  return result;
}

export async function getTrailTickAudit(runId, userId) {
  const r = await query(`SELECT metrics, status FROM backtest_runs WHERE id = $1 AND user_id = $2`, [
    String(runId),
    String(userId),
  ]);
  const row = r.rows[0];
  if (!row) throw Object.assign(new Error("run_not_found"), { status: 404 });
  const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics : {};
  return metrics.trailTickAudit ?? { status: "idle" };
}

export async function estimateTrailTickAuditForRun(runId, userId) {
  const { run, trades } = await loadRunAndTrades(runId, userId);
  return estimateTrailTickAudit(run, trades);
}

/** In-flight audits keyed by runId */
const auditJobs = new Map();

export function isTrailTickAuditRunning(runId) {
  return auditJobs.has(String(runId));
}

export function startTrailTickAuditJob(args) {
  const id = String(args.runId);
  if (auditJobs.has(id)) return { started: false, reason: "already_running" };
  const job = (async () => {
    try {
      await runTrailTickAudit(args);
    } catch (err) {
      const fail = {
        status: "failed",
        error: String(err?.message || err),
        completedAt: new Date().toISOString(),
      };
      await persistTrailTickAudit(id, fail).catch(() => {});
      args.onProgress?.({ status: "failed", error: fail.error });
      try {
        args.wsHub?.broadcast?.("trail_tick_audit_progress", { runId: id, ...fail });
      } catch {
        /* ignore */
      }
    } finally {
      auditJobs.delete(id);
    }
  })();
  auditJobs.set(id, job);
  return { started: true };
}

export async function runTrailTickAuditInlineOrBackground(args) {
  const { run, trades } = await loadRunAndTrades(args.runId, args.userId);
  const est = estimateTrailTickAudit(run, trades);
  if (!est.trailingEnabled) throw Object.assign(new Error("trailing_not_enabled"), { status: 400 });
  if (est.recommendBackground && !args.forceInline) {
    return startTrailTickAuditJob(args);
  }
  const result = await runTrailTickAudit(args);
  return { started: false, inline: true, result };
}
