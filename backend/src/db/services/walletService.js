import { tradingModeToPersistenceSlug } from "../../lib/tradingModePersistence.js";
import { query } from "../query.js";
import { getPool } from "../pool.js";

/** @type {number | null} */
let cachedPaperSystemAccountId = null;

/**
 * Lazy-resolve paper system account UUID (FK target for PAPER mode snapshots).
 * @returns {Promise<string | null>}
 */
export async function getPaperSystemAccountId() {
  if (cachedPaperSystemAccountId) return cachedPaperSystemAccountId;
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await query(
      `SELECT a.id
       FROM accounts a
       JOIN trading_modes tm ON tm.id = a.mode_id
       JOIN users u ON u.id = a.user_id
       WHERE tm.slug = 'paper' AND a.account_type = 'system' AND u.username = '_paper_system'
       LIMIT 1`,
    );
    const id = r.rows[0]?.id;
    if (id) cachedPaperSystemAccountId = String(id);
    return cachedPaperSystemAccountId;
  } catch {
    return null;
  }
}

export function invalidatePaperSystemAccountIdCache() {
  cachedPaperSystemAccountId = null;
}

/**
 * @param {{ getActiveAccount: (slug: string) => string | null }} appState
 * @param {string} tradingMode TRADING_MODE e.g. PAPER, BINANCE_LIVE
 * @returns {Promise<string | null>}
 */
/** Avoid importing instanceService here (it imports walletService). */
async function accountIdForBotInstance(instanceId) {
  const r = await query(`SELECT account_id, COALESCE(is_deleted, false) AS is_deleted FROM bot_instances WHERE id = $1`, [
    instanceId,
  ]);
  const row = r.rows[0];
  if (!row || row.is_deleted) return null;
  return String(row.account_id);
}

export async function resolveWalletSnapshotAccountId(appState, tradingMode) {
  const m = String(tradingMode || "PAPER").toUpperCase();
  if (m === "PAPER") return getPaperSystemAccountId();
  const slug = tradingModeToPersistenceSlug(m);
  const inst = appState.getActiveInstance?.(slug);
  if (inst) {
    const aid = await accountIdForBotInstance(String(inst));
    if (aid) return aid;
  }
  const id = appState.getActiveAccount(slug);
  return id && String(id).trim() ? String(id).trim() : null;
}

const SNAPSHOT_TYPES = new Set(["scheduled", "pre_trade", "post_trade"]);

/** In-memory throttle for high-frequency triggers (WS hello, /api/state). */
const lastScheduledWriteMs = new Map();

/**
 * @param {string} accountId
 * @param {number} [minIntervalMs=45000]
 * @returns {boolean} true if caller should skip this scheduled write
 */
export function shouldThrottleScheduled(accountId, minIntervalMs = 45_000) {
  const id = String(accountId || "");
  if (!id) return true;
  const now = Date.now();
  const prev = lastScheduledWriteMs.get(id) ?? 0;
  if (now - prev < minIntervalMs) return true;
  lastScheduledWriteMs.set(id, now);
  return false;
}

/**
 * Map live `getAccount()` (+ optional positions) to wallet_snapshots row fields.
 * @param {Record<string, unknown> | null | undefined} account
 * @param {unknown[] | null | undefined} positions
 */
export function mapAccountToSnapshotRow(account, positions) {
  const acc = account && typeof account === "object" ? account : {};
  const v = acc.venues && typeof acc.venues === "object" ? acc.venues : null;
  const spot = v?.spot && typeof v.spot === "object" ? v.spot : null;
  const fut = v?.futures && typeof v.futures === "object" ? v.futures : null;

  let total = null;
  let available = null;

  if (spot || fut) {
    const se = spot?.equity != null ? Number(spot.equity) : NaN;
    const fe = fut?.equity != null ? Number(fut.equity) : NaN;
    const sf = spot?.freeBalance != null ? Number(spot.freeBalance) : NaN;
    const ff = fut?.freeBalance != null ? Number(fut.freeBalance) : NaN;
    const hasE = [se, fe].some((x) => Number.isFinite(x));
    const hasF = [sf, ff].some((x) => Number.isFinite(x));
    if (hasE) {
      total = (Number.isFinite(se) ? se : 0) + (Number.isFinite(fe) ? fe : 0);
    }
    if (hasF) {
      available = (Number.isFinite(sf) ? Math.max(0, sf) : 0) + (Number.isFinite(ff) ? Math.max(0, ff) : 0);
    }
  }

  if (total == null && acc.equity != null && Number.isFinite(Number(acc.equity))) {
    total = Number(acc.equity);
  }
  if (available == null && acc.freeBalance != null && Number.isFinite(Number(acc.freeBalance))) {
    available = Math.max(0, Number(acc.freeBalance));
  }

  const totalN = total != null && Number.isFinite(total) ? total : 0;
  const availN = available != null && Number.isFinite(available) ? available : 0;
  let inPos = totalN - availN;
  if (!Number.isFinite(inPos) || inPos < 0) inPos = 0;

  let balances = [];
  if (Array.isArray(acc.balances)) balances = acc.balances;
  let positionsJson = null;
  if (Array.isArray(positions) && positions.length > 0) {
    try {
      positionsJson = JSON.parse(JSON.stringify(positions));
    } catch {
      positionsJson = null;
    }
  }

  return {
    total_usdt: totalN,
    available_usdt: availN,
    in_positions_usdt: inPos,
    balances,
    positions: positionsJson,
  };
}

/**
 * @param {string} accountId
 * @param {string} snapshotType scheduled | pre_trade | post_trade
 * @param {Record<string, unknown> | null | undefined} account getAccount() result
 * @param {unknown[] | null | undefined} positions getPositions() when available
 * @returns {Promise<{ id: string, captured_at: Date } | null>}
 */
export async function writeSnapshot(accountId, snapshotType, account, positions = null) {
  const pool = getPool();
  if (!pool || !accountId) return null;
  const st = String(snapshotType || "").toLowerCase();
  if (!SNAPSHOT_TYPES.has(st)) return null;

  const row = mapAccountToSnapshotRow(account, positions);
  const ins = await query(
    `INSERT INTO wallet_snapshots (account_id, snapshot_type, total_usdt, available_usdt, in_positions_usdt, balances, positions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     RETURNING id, captured_at`,
    [
      accountId,
      st,
      row.total_usdt,
      row.available_usdt,
      row.in_positions_usdt,
      JSON.stringify(row.balances),
      row.positions != null ? JSON.stringify(row.positions) : null,
    ],
  );
  const out = ins.rows[0];
  if (!out?.id || !out.captured_at) return null;
  return { id: String(out.id), captured_at: out.captured_at };
}

/**
 * @param {string} accountId
 */
export async function getLatestSnapshot(accountId) {
  const r = await query(
    `SELECT id, account_id, snapshot_type, total_usdt, available_usdt, in_positions_usdt, balances, positions, captured_at
     FROM wallet_snapshots
     WHERE account_id = $1
     ORDER BY captured_at DESC
     LIMIT 1`,
    [accountId],
  );
  return r.rows[0] ?? null;
}

/**
 * @param {string} accountId
 * @param {number} [limit=50]
 */
export async function getSnapshotHistory(accountId, limit = 50) {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const r = await query(
    `SELECT id, account_id, snapshot_type, total_usdt, available_usdt, in_positions_usdt, balances, positions, captured_at
     FROM wallet_snapshots
     WHERE account_id = $1
     ORDER BY captured_at DESC
     LIMIT $2`,
    [accountId, lim],
  );
  return r.rows;
}

/**
 * Fire-and-forget scheduled snapshot with throttle (WS / HTTP / poller).
 * @param {string | null | undefined} accountId
 * @param {Record<string, unknown> | null | undefined} account
 * @param {unknown[] | null | undefined} positions
 */
export function scheduleWalletSnapshotWrite(accountId, account, positions = null) {
  const id = accountId && String(accountId).trim();
  if (!id || !getPool()) return;
  if (shouldThrottleScheduled(id)) return;
  void writeSnapshot(id, "scheduled", account, positions).catch(() => {});
}

/**
 * Pre/post trade telemetry (no throttle).
 * @param {string | null | undefined} accountId
 * @param {'pre_trade'|'post_trade'} kind
 * @param {{ getAccount?: () => Promise<unknown>, getPositions?: () => Promise<unknown[]> }} exchange
 */
export async function writeSnapshotFromExchange(accountId, kind, exchange) {
  const id = accountId && String(accountId).trim();
  if (!id || !getPool() || !exchange) return;
  const acct = await exchange.getAccount().catch(() => null);
  const pos = await exchange.getPositions().catch(() => []);
  const positions = Array.isArray(pos) ? pos : [];
  await writeSnapshot(id, kind, acct, positions);
}

/**
 * @param {string | null | undefined} accountId
 * @param {'pre_trade'|'post_trade'} kind
 * @param {{ getAccount?: () => Promise<unknown>, getPositions?: () => Promise<unknown[]> }} exchange
 */
export function fireAndForgetWalletSnapshot(accountId, kind, exchange) {
  if (!accountId || !getPool()) return;
  void writeSnapshotFromExchange(accountId, kind, exchange).catch(() => {});
}
