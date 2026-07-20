/**
 * Backtest worker pool — serial warm worker by default.
 *
 * Reuses one persistent worker_thread across runs (DB pool + signal cache stay warm).
 * Override concurrency via BACKTEST_WORKER_CONCURRENCY (default 1).
 */

import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { broadcastActivity } from "../../lib/activityLog.js";
import { query } from "../../db/query.js";
import { getPool } from "../../db/pool.js";
import { BACKTEST_ENGINE_VERSION } from "./version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, "worker.js");
const WORKER_EXEC_ARGV = process.execArgv.filter((arg) => !String(arg).startsWith("--input-type"));

/** Serial by default — parallel workers thrash CPU and stall SR_INTRADAY signal builds. */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.BACKTEST_WORKER_CONCURRENCY || 1));
const USE_WARM_WORKER = process.env.BACKTEST_ENABLE_WARM_WORKER === "true" && MAX_CONCURRENCY === 1;

/** @type {Set<{ runId:string, worker:Worker, warm?: boolean }>} */
const active = new Set();
/** @type {Array<{ runId:string, resolve:Function, reject:Function }>} */
const queue = [];
const events = new EventEmitter();

let wsHubRef = null;
/** @type {Worker | null} */
let warmWorker = null;
/** Engine build loaded in the warm worker — recycle when this changes. */
let warmWorkerEngineVersion = null;
/** @type {Promise<void> | null} */
let warmReady = null;
/** @type {((v?: void) => void) | null} */
let warmReadyResolve = null;
/** @type {((err: Error) => void) | null} */
let warmReadyReject = null;
/** @type {{ runId: string, resolve: Function, reject: Function } | null} */
let warmJob = null;

export function setBacktestWsHub(hub) {
  wsHubRef = hub;
}

function backtestActivity(payload) {
  if (!wsHubRef?.broadcast) return;
  try {
    broadcastActivity(wsHubRef, { category: "backtest", ...payload });
  } catch {
    /* never break pool */
  }
}

export function isRunInPool(runId) {
  const id = String(runId);
  if (warmJob?.runId === id) return true;
  for (const entry of active) {
    if (entry.runId === id) return true;
  }
  return queue.some((j) => j.runId === id);
}

export function enqueueRun(runId, opts = {}) {
  const id = String(runId);
  if (isRunInPool(id)) {
    return Promise.resolve({ runId: id, alreadyQueued: true });
  }
  return new Promise((resolve, reject) => {
    const item = { runId: id, resolve, reject };
    if (opts.priority === "high") queue.unshift(item);
    else queue.push(item);
    drain();
  });
}

export async function recoverOrphanedBacktestRuns() {
  if (!getPool()) return { resetRunning: 0, requeued: 0 };

  // Strategy tests don't survive a restart (battery state is in-memory) — fail them.
  await query(
    `UPDATE backtest_strategy_tests
        SET status = 'failed', error_message = 'orphaned_after_restart', finished_at = NOW()
      WHERE status IN ('queued','running')`,
  ).catch(() => {});

  const reset = await query(
    `UPDATE backtest_runs
        SET status = 'queued',
            progress_pct = 0,
            started_at = NULL
      WHERE status = 'running'
      RETURNING id`,
  );

  const maxRequeue = Math.max(1, Number(process.env.BACKTEST_MAX_RECOVER_REQUEUE || 8));
  const pending = await query(
    `SELECT id FROM backtest_runs
      WHERE status = 'queued'
        AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY created_at ASC
      LIMIT $1`,
    [maxRequeue],
  );

  await query(
    `UPDATE backtest_runs
        SET status = 'failed',
            error_message = 'stale_queued_run_cleared',
            finished_at = NOW()
      WHERE status = 'queued'
        AND created_at <= NOW() - INTERVAL '48 hours'`,
  );

  let requeued = 0;
  for (const row of pending.rows) {
    const runId = String(row.id);
    if (isRunInPool(runId)) continue;
    try {
      await enqueueRun(runId, { priority: "high" });
      requeued++;
    } catch (err) {
      console.error("[backtest:pool] recover enqueue failed", runId, err?.message || err);
    }
  }

  if (reset.rowCount > 0 || requeued > 0) {
    console.info(
      `[backtest:pool] recovered orphaned runs: reset_running=${reset.rowCount} requeued=${requeued}`,
    );
  }
  return { resetRunning: reset.rowCount, requeued };
}

export function cancelRun(runId) {
  const id = String(runId);
  if (warmJob?.runId === id && warmWorker) {
    try {
      warmWorker.postMessage({ type: "cancel" });
    } catch {
      /* ignore */
    }
    scheduleWarmWorkerRecycle(id);
    return true;
  }
  if (warmJob?.runId === id) {
    finishWarmJob(new Error("cancelled"));
    return true;
  }
  for (const job of active) {
    if (job.runId === id) {
      try {
        job.worker.postMessage({ type: "cancel" });
      } catch {
        /* ignore */
      }
      return true;
    }
  }
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].runId === id) {
      queue[i].reject(new Error("cancelled_before_start"));
      queue.splice(i, 1);
      return true;
    }
  }
  return false;
}

function drain() {
  while (active.size < MAX_CONCURRENCY && queue.length) {
    const next = queue.shift();
    if (!next) break;
    try {
      if (USE_WARM_WORKER) spawnWarm(next);
      else spawn(next);
    } catch (err) {
      console.error("[backtest:pool] spawn failed", err);
      try {
        wsHubRef?.broadcast?.("backtest_failed", {
          runId: next.runId,
          error: String(err?.message || err),
        });
      } catch {
        /* ignore */
      }
      next.reject(err);
    }
  }
}

function wireWorkerEvents(worker, job, entry, onDone) {
  const runShort = job.runId.length > 8 ? `${job.runId.slice(0, 8)}…` : job.runId;

  worker.on("message", (msg) => {
    if (!msg) return;
    if (msg.type === "ready") return;
    if (msg.type === "progress") {
      events.emit("progress", { runId: job.runId, pct: Number(msg.pct) });
      try {
        wsHubRef?.broadcast?.("backtest_progress", {
          runId: job.runId,
          progressPct: Number(msg.pct),
          status: "running",
        });
      } catch {
        /* must not break worker */
      }
    } else if (msg.type === "complete") {
      if (String(msg.runId) !== job.runId) return;
      events.emit("complete", { runId: job.runId });
      backtestActivity({
        level: "info",
        reason: "backtest_complete",
        msg: `Backtest completed · ${runShort}`,
        detail: { runId: job.runId },
      });
      try {
        wsHubRef?.broadcast?.("backtest_complete", { runId: job.runId });
      } catch {
        /* ignore */
      }
      onDone(null);
    } else if (msg.type === "failed") {
      if (msg.runId && String(msg.runId) !== job.runId) return;
      const errStr = String(msg.error || "");
      events.emit("failed", { runId: job.runId, error: errStr });
      backtestActivity({
        level: "error",
        reason: "backtest_failed",
        msg: `Backtest failed · ${runShort}${errStr ? ` — ${errStr.slice(0, 220)}` : ""}`,
        detail: { runId: job.runId, error: errStr },
      });
      try {
        wsHubRef?.broadcast?.("backtest_failed", {
          runId: job.runId,
          error: errStr,
        });
      } catch {
        /* ignore */
      }
      onDone(new Error(errStr || "backtest_failed"));
    }
  });

  worker.on("error", (err) => {
    console.error("[backtest:pool] worker error", err);
    onDone(err);
  });
}

function rejectWarmReady(err) {
  if (warmReadyReject) warmReadyReject(err);
  warmReadyResolve = null;
  warmReadyReject = null;
  warmReady = null;
}

function terminateWarmWorker(err) {
  const w = warmWorker;
  warmWorker = null;
  warmWorkerEngineVersion = null;
  rejectWarmReady(err ?? new Error("warm_worker_recycled"));
  if (w) {
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  }
  finishWarmJob(err ?? new Error("warm_worker_recycled"));
}

function scheduleWarmWorkerRecycle(runId, ms = 2500) {
  setTimeout(() => {
    if (warmJob?.runId !== String(runId)) return;
    console.warn("[backtest:pool] recycling warm worker after cancel", runId);
    terminateWarmWorker(new Error("cancelled"));
  }, ms);
}

function finishWarmJob(err) {
  const job = warmJob;
  if (!job) return;
  warmJob = null;
  for (const entry of active) {
    if (entry.warm && entry.runId === job.runId) {
      active.delete(entry);
      break;
    }
  }
  if (err) job.reject(err);
  else job.resolve({ runId: job.runId });
  drain();
}

function ensureWarmWorker() {
  if (warmWorker && warmWorkerEngineVersion !== BACKTEST_ENGINE_VERSION) {
    console.info(
      `[backtest:pool] recycling warm worker (${warmWorkerEngineVersion} → ${BACKTEST_ENGINE_VERSION})`,
    );
    terminateWarmWorker(new Error("engine_version_changed"));
  }
  if (warmWorker) return warmReady ?? Promise.resolve();

  warmWorkerEngineVersion = BACKTEST_ENGINE_VERSION;
  warmReady = new Promise((resolve, reject) => {
    warmReadyResolve = resolve;
    warmReadyReject = reject;
    const worker = new Worker(WORKER_PATH, { workerData: { persistent: true }, execArgv: WORKER_EXEC_ARGV });
    warmWorker = worker;
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      warmReadyResolve = null;
      warmReadyReject = null;
      fn(val);
    };

    worker.on("message", (msg) => {
      if (!msg) return;
      if (msg.type === "ready") {
        settle(resolve, undefined);
        return;
      }
      const job = warmJob;
      if (!job || (msg.runId && String(msg.runId) !== job.runId)) return;

      if (msg.type === "progress") {
        events.emit("progress", { runId: job.runId, pct: Number(msg.pct) });
        try {
          wsHubRef?.broadcast?.("backtest_progress", {
            runId: job.runId,
            progressPct: Number(msg.pct),
            status: "running",
          });
        } catch {
          /* ignore */
        }
      } else if (msg.type === "complete") {
        const runShort = job.runId.length > 8 ? `${job.runId.slice(0, 8)}…` : job.runId;
        events.emit("complete", { runId: job.runId });
        backtestActivity({
          level: "info",
          reason: "backtest_complete",
          msg: `Backtest completed · ${runShort}`,
          detail: { runId: job.runId },
        });
        try {
          wsHubRef?.broadcast?.("backtest_complete", { runId: job.runId });
        } catch {
          /* ignore */
        }
        finishWarmJob(null);
      } else if (msg.type === "failed") {
        const errStr = String(msg.error || "");
        const runShort = job.runId.length > 8 ? `${job.runId.slice(0, 8)}…` : job.runId;
        events.emit("failed", { runId: job.runId, error: errStr });
        backtestActivity({
          level: "error",
          reason: "backtest_failed",
          msg: `Backtest failed · ${runShort}${errStr ? ` — ${errStr.slice(0, 220)}` : ""}`,
          detail: { runId: job.runId, error: errStr },
        });
        try {
          wsHubRef?.broadcast?.("backtest_failed", { runId: job.runId, error: errStr });
        } catch {
          /* ignore */
        }
        finishWarmJob(new Error(errStr || "backtest_failed"));
      }
    });

    worker.on("error", (err) => {
      console.error("[backtest:pool] warm worker error", err);
      if (!settled) settle(reject, err);
      const w = warmWorker;
      warmWorker = null;
      warmReady = null;
      warmReadyResolve = null;
      warmReadyReject = null;
      finishWarmJob(err);
      if (w) {
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
      }
    });

    worker.on("exit", (code) => {
      if (!settled) settle(reject, new Error(`backtest_worker_exit_${code}`));
      if (warmWorker === worker) {
        warmWorker = null;
        warmReady = null;
        warmReadyResolve = null;
        warmReadyReject = null;
      }
      if (warmJob) finishWarmJob(new Error(`backtest_worker_exit_${code}`));
      drain();
    });
  });

  return warmReady;
}

function spawnWarm(job) {
  const entry = { runId: job.runId, worker: warmWorker, warm: true };
  active.add(entry);
  warmJob = job;

  const runShort = job.runId.length > 8 ? `${job.runId.slice(0, 8)}…` : job.runId;
  backtestActivity({
    level: "info",
    reason: "backtest_started",
    msg: `Backtest started · ${runShort}`,
    detail: { runId: job.runId },
  });

  try {
    wsHubRef?.broadcast?.("backtest_progress", {
      runId: job.runId,
      progressPct: 0,
      status: "running",
    });
  } catch {
    /* ignore */
  }

  ensureWarmWorker()
    .then(() => {
      if (!warmWorker) throw new Error("warm_worker_unavailable");
      if (warmJob?.runId !== job.runId) return;
      warmWorker.postMessage({ type: "run", runId: job.runId });
    })
    .catch((err) => {
      finishWarmJob(err);
    });
}

function spawn(job) {
  const worker = new Worker(WORKER_PATH, {
    workerData: { runId: job.runId },
    execArgv: WORKER_EXEC_ARGV,
  });
  const entry = { runId: job.runId, worker };
  active.add(entry);
  const runShort = job.runId.length > 8 ? `${job.runId.slice(0, 8)}…` : job.runId;
  backtestActivity({
    level: "info",
    reason: "backtest_started",
    msg: `Backtest started · ${runShort}`,
    detail: { runId: job.runId },
  });

  try {
    wsHubRef?.broadcast?.("backtest_progress", {
      runId: job.runId,
      progressPct: 0,
      status: "running",
    });
  } catch {
    /* ignore */
  }

  const finish = (err) => {
    cleanup(entry);
    if (err) job.reject(err);
    else job.resolve({ runId: job.runId });
  };

  wireWorkerEvents(worker, job, entry, finish);

  worker.on("exit", (code) => {
    cleanup(entry);
    if (code !== 0) job.reject(new Error(`backtest_worker_exit_${code}`));
  });
}

function cleanup(entry) {
  if (active.has(entry)) active.delete(entry);
  drain();
}

export const backtestEvents = events;
