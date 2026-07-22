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
 * @returns {DataSyncJob}
 */
export function createDataSyncJob(kind) {
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
 * @param {string} id
 * @param {Partial<Pick<DataSyncJob, "status"|"progressPct"|"phase"|"error"|"result">>} patch
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
    result: job.status === "done" ? job.result : undefined,
  };
}
