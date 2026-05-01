import { query, withTransaction } from "../query.js";
import { getLatestSnapshot } from "./walletService.js";

export class InsufficientCapitalError extends Error {
  constructor(message = "insufficient_capital") {
    super(message);
    this.name = "InsufficientCapitalError";
    this.code = "insufficient_capital";
  }
}

export class AllotmentExceededError extends Error {
  constructor(message = "allotment_exceeded") {
    super(message);
    this.name = "AllotmentExceededError";
    this.code = "allotment_exceeded";
  }
}

const ALLOTMENT_MODES = new Set(["FIXED", "PCT"]);
const EPS = 1e-8;

async function advisoryLockAccount(client, accountId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [String(accountId)]);
}

/**
 * @param {string} accountId
 */
export async function getAccountReservedTotal(accountId) {
  const r = await query(
    `SELECT COALESCE(SUM(reserved_usdt), 0)::text AS s
     FROM capital_allotments
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  const n = Number(r.rows[0]?.s ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Latest snapshot available USDT minus active reserved total.
 * @param {string} accountId
 */
export async function getAccountFreeCapital(accountId) {
  const snap = await getLatestSnapshot(accountId);
  if (!snap || snap.available_usdt == null) return null;
  const avail = Number(snap.available_usdt);
  if (!Number.isFinite(avail)) return null;
  const reserved = await getAccountReservedTotal(accountId);
  return avail - reserved;
}

/**
 * Wallet `available_usdt` minus sum of active allotment caps (`configured_usdt`).
 * Aligns with `createAllotment` checks (not the same as `getAccountFreeCapital`).
 * @param {string} accountId
 * @returns {Promise<{ availableUsdt: number; committedUsdt: number; headroomUsdt: number } | null>}
 */
export async function getAccountAllotmentHeadroom(accountId) {
  const snap = await getLatestSnapshot(accountId);
  if (!snap || snap.available_usdt == null) return null;
  const avail = Number(snap.available_usdt);
  if (!Number.isFinite(avail) || avail < 0) return null;
  const sumRow = await query(
    `SELECT COALESCE(SUM(configured_usdt), 0)::text AS s
     FROM capital_allotments
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  const committed = Number(sumRow.rows[0]?.s ?? 0);
  if (!Number.isFinite(committed)) return null;
  return {
    availableUsdt: avail,
    committedUsdt: committed,
    headroomUsdt: avail - committed,
  };
}

/**
 * @param {string} instanceId
 */
export async function getAllotmentForInstance(instanceId) {
  const r = await query(
    `SELECT * FROM capital_allotments
     WHERE instance_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [instanceId],
  );
  return r.rows[0] ?? null;
}

/**
 * Cross-instance safe new allotment: sum(existing configured caps for active rows) + new cap ≤ latest snapshot available.
 * @param {string} instanceId
 * @param {string} accountId
 * @param {string} mode FIXED | PCT
 * @param {number|string} configuredUsdt
 * @param {number|string|null|undefined} configuredPct
 * @param {string|null} [_walletSnapshotId] ignored — FK uses the same row as `getLatestSnapshot` below (avoids mismatched `(captured_at, id)` vs hypertable PK).
 * @param {Date|string|null} [_walletSnapshotCapturedAt] ignored
 */
/**
 * @param {import('pg').PoolClient} client
 */
export async function createAllotmentWithClient(
  client,
  instanceId,
  accountId,
  mode,
  configuredUsdt,
  configuredPct = null,
  _walletSnapshotId = null,
  _walletSnapshotCapturedAt = null,
) {
  const m = String(mode || "").toUpperCase();
  if (!ALLOTMENT_MODES.has(m)) throw new InsufficientCapitalError("invalid_allotment_mode");
  const cap = Number(configuredUsdt);
  if (!Number.isFinite(cap) || cap < 0) throw new InsufficientCapitalError("invalid_configured_usdt");
  const pct =
    configuredPct != null && configuredPct !== "" && Number.isFinite(Number(configuredPct)) ? Number(configuredPct) : null;

  await advisoryLockAccount(client, accountId);

  const snap = await getLatestSnapshot(accountId);
  if (!snap || snap.available_usdt == null) throw new InsufficientCapitalError("no_wallet_snapshot");
  const avail = Number(snap.available_usdt);
  if (!Number.isFinite(avail) || avail < 0) throw new InsufficientCapitalError("invalid_wallet_snapshot");

  const sumRow = await client.query(
    `SELECT COALESCE(SUM(configured_usdt), 0)::text AS s
     FROM capital_allotments
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  const existingConfigured = Number(sumRow.rows[0]?.s ?? 0);
  if (!Number.isFinite(existingConfigured)) throw new InsufficientCapitalError("invalid_existing_sum");
  if (existingConfigured + cap > avail + EPS) {
    throw new InsufficientCapitalError("account_over_committed");
  }

  /**
   * Bind FK columns from one `wallet_snapshots` row in SQL so `(captured_at, id)` always matches the
   * hypertable PK (avoids driver/timestamp drift vs composite `fk_capital_wallet_snapshot`).
   */
  const ins = await client.query(
    `INSERT INTO capital_allotments (
       instance_id, account_id, allotment_mode, configured_usdt, configured_pct,
       reserved_usdt, realised_pnl, status, wallet_snapshot_id, wallet_snapshot_captured_at
     )
     SELECT $1::uuid, $2::uuid, $3::text, $4::numeric, $5::numeric, 0::numeric, 0::numeric, 'active'::text,
            ws.id, ws.captured_at
     FROM wallet_snapshots ws
     WHERE ws.account_id = $2::uuid
     ORDER BY ws.captured_at DESC, ws.id DESC
     LIMIT 1
     RETURNING *`,
    [instanceId, accountId, m, cap, pct],
  );
  if (!ins.rows[0]) throw new InsufficientCapitalError("no_wallet_snapshot");
  return ins.rows[0];
}

export async function createAllotment(
  instanceId,
  accountId,
  mode,
  configuredUsdt,
  configuredPct = null,
  walletSnapshotId = null,
  walletSnapshotCapturedAt = null,
) {
  return withTransaction((client) =>
    createAllotmentWithClient(
      client,
      instanceId,
      accountId,
      mode,
      configuredUsdt,
      configuredPct,
      walletSnapshotId,
      walletSnapshotCapturedAt,
    ),
  );
}

/**
 * @param {string} allotmentId
 * @param {number|string} additionalUsdt
 */
export async function reserveCapital(allotmentId, additionalUsdt) {
  const add = Number(additionalUsdt);
  if (!Number.isFinite(add) || add < 0) throw new AllotmentExceededError("invalid_additional_usdt");

  return withTransaction(async (client) => {
    const cur = await client.query(`SELECT * FROM capital_allotments WHERE id = $1`, [allotmentId]);
    const a = cur.rows[0];
    if (!a) throw new AllotmentExceededError("allotment_not_found");
    if (a.status !== "active") throw new AllotmentExceededError("allotment_not_active");

    const accountId = a.account_id;
    await advisoryLockAccount(client, accountId);

    const newReserved = Number(a.reserved_usdt) + add;
    if (!Number.isFinite(newReserved) || newReserved > Number(a.configured_usdt) + EPS) {
      throw new AllotmentExceededError("instance_reserved_over_configured");
    }

    const snap = await getLatestSnapshot(accountId);
    if (!snap || snap.available_usdt == null) throw new InsufficientCapitalError("no_wallet_snapshot");
    const avail = Number(snap.available_usdt);
    if (!Number.isFinite(avail)) throw new InsufficientCapitalError("invalid_wallet_snapshot");

    const other = await client.query(
      `SELECT COALESCE(SUM(reserved_usdt), 0)::text AS s
       FROM capital_allotments
       WHERE account_id = $1 AND status = 'active' AND id <> $2`,
      [accountId, allotmentId],
    );
    const otherSum = Number(other.rows[0]?.s ?? 0);
    if (!Number.isFinite(otherSum)) throw new InsufficientCapitalError("invalid_reserved_sum");
    if (otherSum + newReserved > avail + EPS) {
      throw new InsufficientCapitalError("account_reserved_over_wallet");
    }

    await client.query(`UPDATE capital_allotments SET reserved_usdt = $1 WHERE id = $2`, [newReserved, allotmentId]);
    const out = await client.query(`SELECT * FROM capital_allotments WHERE id = $1`, [allotmentId]);
    return out.rows[0];
  });
}

/**
 * @param {string} allotmentId
 * @param {number|string} realisedPnlDelta
 */
export async function releaseCapital(allotmentId, realisedPnlDelta = 0) {
  const d = Number(realisedPnlDelta);
  const delta = Number.isFinite(d) ? d : 0;

  return withTransaction(async (client) => {
    const cur = await client.query(`SELECT account_id FROM capital_allotments WHERE id = $1`, [allotmentId]);
    if (!cur.rows[0]) throw new AllotmentExceededError("allotment_not_found");
    await advisoryLockAccount(client, cur.rows[0].account_id);
    await client.query(
      `UPDATE capital_allotments
       SET reserved_usdt = 0,
           realised_pnl = realised_pnl + $2,
           status = 'released',
           released_at = NOW()
       WHERE id = $1`,
      [allotmentId, delta],
    );
    const out = await client.query(`SELECT * FROM capital_allotments WHERE id = $1`, [allotmentId]);
    return out.rows[0];
  });
}

/**
 * @param {string} allotmentId
 * @param {number|string} currentReservedUsdt
 */
export async function updateReserved(allotmentId, currentReservedUsdt) {
  const v = Number(currentReservedUsdt);
  if (!Number.isFinite(v) || v < 0) throw new AllotmentExceededError("invalid_reserved_usdt");

  return withTransaction(async (client) => {
    const cur = await client.query(`SELECT * FROM capital_allotments WHERE id = $1`, [allotmentId]);
    const a = cur.rows[0];
    if (!a) throw new AllotmentExceededError("allotment_not_found");
    if (a.status !== "active") throw new AllotmentExceededError("allotment_not_active");
    if (v > Number(a.configured_usdt) + EPS) throw new AllotmentExceededError("instance_reserved_over_configured");

    const accountId = a.account_id;
    await advisoryLockAccount(client, accountId);

    const snap = await getLatestSnapshot(accountId);
    if (!snap || snap.available_usdt == null) throw new InsufficientCapitalError("no_wallet_snapshot");
    const avail = Number(snap.available_usdt);
    if (!Number.isFinite(avail)) throw new InsufficientCapitalError("invalid_wallet_snapshot");

    const other = await client.query(
      `SELECT COALESCE(SUM(reserved_usdt), 0)::text AS s
       FROM capital_allotments
       WHERE account_id = $1 AND status = 'active' AND id <> $2`,
      [accountId, allotmentId],
    );
    const otherSum = Number(other.rows[0]?.s ?? 0);
    if (!Number.isFinite(otherSum)) throw new InsufficientCapitalError("invalid_reserved_sum");
    if (otherSum + v > avail + EPS) throw new InsufficientCapitalError("account_reserved_over_wallet");

    await client.query(`UPDATE capital_allotments SET reserved_usdt = $1 WHERE id = $2`, [v, allotmentId]);
    const out = await client.query(`SELECT * FROM capital_allotments WHERE id = $1`, [allotmentId]);
    return out.rows[0];
  });
}

/**
 * @param {string} allotmentId
 */
export async function suspendAllotment(allotmentId) {
  const r = await query(
    `UPDATE capital_allotments SET status = 'suspended' WHERE id = $1 AND status = 'active' RETURNING *`,
    [allotmentId],
  );
  return r.rows[0] ?? null;
}
