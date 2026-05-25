/**
 * Single-warm-worker pool for backtests.
 *
 * Spawns a Node `worker_thread` on demand, runs queued jobs serially, and
 * recycles the worker if it crashes. Concurrency is intentionally bounded to
 * a small number (default 3, override `BACKTEST_WORKER_CONCURRENCY`) so a
 * misconfigured optimization sweep can't
 * starve the API event loop.
 */

import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { broadcastActivity } from "../../lib/activityLog.js";
import { query } from "../../db/query.js";
import { getPool } from "../../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, "worker.js");

const MAX_CONCURRENCY = Math.max(1, Number(process.env.BACKTEST_WORKER_CONCURRENCY || 3));

/** @type {Set<{ runId:string, worker:Worker }>} */
const active = new Set();
/** @type {Array<{ runId:string, resolve:Function, reject:Function }>} */
const queue = [];
const events = new EventEmitter();

let wsHubRef = null;

/** Wire wsHub once at boot so progress events can be broadcast. */
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

/**
 * @param {string} runId
 * @param {{ priority?: "high" }} [opts] Manual POST /runs uses `high` so a user backtest is not stuck behind a large optimization sweep.
 */
/** True when this run is already in the in-memory worker queue or executing. */
export function isRunInPool(runId) {
  const id = String(runId);
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

/**
 * After API restart the DB may still have `queued` / `running` rows while the
 * in-memory queue is empty — those runs show "Waiting in queue…" forever.
 * Re-enqueue them once at boot (and via POST /runs/:id/requeue).
 */
export async function recoverOrphanedBacktestRuns() {
  if (!getPool()) return { resetRunning: 0, requeued: 0 };

  const reset = await query(
    `UPDATE backtest_runs
        SET status = 'queued',
            progress_pct = 0,
            started_at = NULL
      WHERE status = 'running'
      RETURNING id`,
  );

  const pending = await query(
    `SELECT id FROM backtest_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC`,
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

/** Cancels a running job by sending a `cancel` message. The worker resolves cooperatively. */
export function cancelRun(runId) {
  for (const job of active) {
    if (job.runId === String(runId)) {
      try {
        job.worker.postMessage({ type: "cancel" });
      } catch {
        /* ignore */
      }
      return true;
    }
  }
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].runId === String(runId)) {
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
      spawn(next);
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

function spawn(job) {
  const worker = new Worker(WORKER_PATH, {
    workerData: { runId: job.runId },
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

  worker.on("message", (msg) => {
    if (!msg) return;
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
    } else if (msg.type === "failed") {
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
    }
  });

  worker.on("error", (err) => {
    console.error("[backtest:pool] worker error", err);
    job.reject(err);
    cleanup(entry);
  });

  worker.on("exit", (code) => {
    cleanup(entry);
    if (code === 0) job.resolve({ runId: job.runId });
    else job.reject(new Error(`backtest_worker_exit_${code}`));
  });
}

function cleanup(entry) {
  if (active.has(entry)) active.delete(entry);
  drain();
}

export const backtestEvents = events;
