import test from "node:test";
import assert from "node:assert/strict";
import {
  createDataSyncJob,
  getDataSyncJob,
  updateDataSyncJob,
  publicDataSyncJob,
} from "./dataSyncJobs.js";

test("data sync job lifecycle", () => {
  const job = createDataSyncJob("ohlc");
  assert.equal(job.status, "queued");
  assert.ok(job.id);

  updateDataSyncJob(job.id, { status: "running", progressPct: 42, phase: "klines" });
  const got = getDataSyncJob(job.id);
  assert.equal(got?.status, "running");
  assert.equal(got?.progressPct, 42);

  const pub = publicDataSyncJob(got);
  assert.equal(pub?.jobId, job.id);
  assert.equal(pub?.progressPct, 42);
  assert.equal(pub?.result, undefined);

  updateDataSyncJob(job.id, { status: "done", progressPct: 100, result: { ok: true } });
  assert.deepEqual(publicDataSyncJob(getDataSyncJob(job.id))?.result, { ok: true });
});
