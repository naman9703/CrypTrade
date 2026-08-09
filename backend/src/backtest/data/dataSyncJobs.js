/**
 * In-memory jobs for UI data sync (klines / mark). Long backfills outlive typical
 * HTTP/proxy timeouts, so POST returns a jobId and the client polls progress.
 */

import { randomUUID } from "node:crypto";

/** @typedef {"queued"|"running"|"done"|"failed"} DataSyncStatus */

/**
 * @typedef {object} DataSyncJob
 * @property {string} id
 * @property {"ohlc"|"mark"} kind
 * @property {DataSyncStatus} status
 * @property {number} progressPct
 * @property {string|null} phase
 * @property {string|null} error
 * @property {unknown} result
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string|null} symbol
 * @property {string|null} timeframe
 * @property {string|null} market
 * @property {string|null} mode
 * @property {number|null} windowFrom
 * @property {number|null} windowTo
 * @property {number|null} remainingMs
 * @property {number|null} remainingDays
 */

/** @type {Map<string, DataSyncJob>} */
const jobs = new Map();

const MAX_JOBS = 40;
const TTL_MS = 2 * 60 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}

/**
 * @param {"ohlc"|"mark"} kind
 * @param {object} [meta]
 * @returns {DataSyncJob}
 */
export function createDataSyncJob(kind, meta = {}) {
  prune();
  const now = Date.now();
  const job = {
    id: randomUUID(),
    kind,
    status: /** @type {DataSyncStatus} */ ("queued"),
    progressPct: 0,
    phase: null,
    error: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    symbol: meta.symbol != null ? String(meta.symbol).toUpperCase() : null,
    timeframe: meta.timeframe != null ? String(meta.timeframe).toLowerCase() : null,
    market: meta.market != null ? String(meta.market).toLowerCase() : null,
    mode: meta.mode != null ? String(meta.mode).toLowerCase() : null,
    windowFrom: meta.windowFrom != null && Number.isFinite(Number(meta.windowFrom)) ? Number(meta.windowFrom) : null,
    windowTo: meta.windowTo != null && Number.isFinite(Number(meta.windowTo)) ? Number(meta.windowTo) : null,
    remainingMs: meta.remainingMs != null && Number.isFinite(Number(meta.remainingMs)) ? Number(meta.remainingMs) : null,
    remainingDays: meta.remainingDays != null && Number.isFinite(Number(meta.remainingDays)) ? Number(meta.remainingDays) : null,
  };
  jobs.set(job.id, job);
  return job;
}

/** @param {string} id */
export function getDataSyncJob(id) {
  prune();
  return jobs.get(String(id || "")) ?? null;
}

/**
 * Find a still-running job for reconnect after page refresh.
 * @param {{ kind?: string, symbol?: string, timeframe?: string, market?: string }} q
 */
export function findActiveDataSyncJob(q = {}) {
  prune();
  const kind = q.kind != null ? String(q.kind) : null;
  const symbol = q.symbol != null ? String(q.symbol).toUpperCase() : null;
  const timeframe = q.timeframe != null ? String(q.timeframe).toLowerCase() : null;
  const market = q.market != null ? String(q.market).toLowerCase() : null;
  const active = [...jobs.values()]
    .filter((j) => j.status === "queued" || j.status === "running")
    .filter((j) => (kind ? j.kind === kind : true))
    .filter((j) => (symbol ? j.symbol === symbol : true))
    .filter((j) => (timeframe ? j.timeframe === timeframe : true))
    .filter((j) => (market ? j.market === market : true))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return active[0] ?? null;
}

/**
 * @param {string} id
 * @param {Partial<Pick<DataSyncJob, "status"|"progressPct"|"phase"|"error"|"result"|"remainingMs"|"remainingDays"|"mode">>} patch
 */
export function updateDataSyncJob(id, patch) {
  const job = jobs.get(String(id || ""));
  if (!job) return null;
  if (patch.status != null) job.status = patch.status;
  if (patch.progressPct != null) {
    const n = Number(patch.progressPct);
    if (Number.isFinite(n)) {
      const next = Math.max(0, Math.min(100, Math.round(n)));
      // Never let a late stale callback shrink the bar.
      job.progressPct = Math.max(job.progressPct, next);
    }
  }
  if (patch.phase !== undefined) job.phase = patch.phase;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.remainingMs !== undefined) job.remainingMs = patch.remainingMs;
  if (patch.remainingDays !== undefined) job.remainingDays = patch.remainingDays;
  if (patch.mode !== undefined) job.mode = patch.mode;
  job.updatedAt = Date.now();
  return job;
}

/**
 * @param {DataSyncJob} job
 */
export function publicDataSyncJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    progressPct: job.progressPct,
    phase: job.phase,
    error: job.error,
    symbol: job.symbol,
    timeframe: job.timeframe,
    market: job.market,
    mode: job.mode,
    windowFrom: job.windowFrom,
    windowTo: job.windowTo,
    remainingMs: job.remainingMs,
    remainingDays: job.remainingDays,
    result: job.status === "done" ? job.result : undefined,
  };
}
