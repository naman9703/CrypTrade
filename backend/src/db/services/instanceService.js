import { query, withTransaction } from "../query.js";
import { normalizeModeSlugParam } from "../../lib/modeSlug.js";
import { getLatestSnapshot } from "./walletService.js";
import * as accountsService from "./accountsService.js";
import * as strategyService from "./strategyService.js";
import { extractInstanceConfig } from "../../lib/strategyInstanceSplit.js";
import {
  createAllotmentWithClient,
  getAllotmentForInstance,
  InsufficientCapitalError,
  releaseCapital,
} from "./capitalAllotmentService.js";

/** Keys allowed on the operational config patch payload (HTTP/Service). */
export const INSTANCE_OPERATIONAL_KEYS = Object.freeze([
  "inst_symbol",
  "inst_timeframe",
  "inst_symbol_mode",
  "inst_market_mode",
  "inst_universe",
  "inst_risk_per_trade",
  "inst_risk_unit",
  "inst_max_daily_loss",
  "inst_max_daily_loss_unit",
  "inst_capital_mode",
  "inst_capital_usdt",
  "inst_capital_pct",
  "inst_compound_pnl",
]);

export class ModesMismatchError extends Error {
  constructor(message = "Account and strategy must belong to the same mode") {
    super(message);
    this.name = "ModesMismatchError";
    this.code = "modes_mismatch";
  }
}

export class InstanceNotFoundError extends Error {
  constructor(message = "instance_not_found") {
    super(message);
    this.name = "InstanceNotFoundError";
    this.code = "instance_not_found";
  }
}

export class InstanceNotStoppedError extends Error {
  constructor(message = "instance_not_stopped") {
    super(message);
    this.name = "InstanceNotStoppedError";
    this.code = "instance_not_stopped";
  }
}

const SLUGS = ["paper", "demo_api", "testnet", "live"];

function mapAllotmentRow(ca) {
  if (!ca) return null;
  return {
    id: String(ca.id),
    allotmentMode: String(ca.allotment_mode || ""),
    configuredUsdt: Number(ca.configured_usdt),
    configuredPct: ca.configured_pct != null ? Number(ca.configured_pct) : null,
    reservedUsdt: Number(ca.reserved_usdt ?? 0),
    status: String(ca.status || ""),
  };
}

function mapInstanceRow(row, allotment = null) {
  if (!row) return null;
  const a = mapAllotmentRow(allotment);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    strategyVersionId: String(row.strategy_version_id),
    label: row.label != null ? String(row.label) : null,
    status: String(row.status || "stopped"),
    lastStartAt: row.last_start_at ? new Date(row.last_start_at).toISOString() : null,
    lastStopAt: row.last_stop_at ? new Date(row.last_stop_at).toISOString() : null,
    lastStopReason: row.last_stop_reason != null ? String(row.last_stop_reason) : null,
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    totalTrades: Number(row.total_trades ?? 0),
    totalPnlUsdt: Number(row.total_pnl_usdt ?? 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    accountLabel: row.account_label != null ? String(row.account_label) : null,
    accountModeSlug: row.account_mode_slug != null ? String(row.account_mode_slug) : null,
    strategyId: row.strategy_id != null ? String(row.strategy_id) : null,
    strategyName: row.strategy_name != null ? String(row.strategy_name) : null,
    strategyVersionNumber: row.version_number != null ? Number(row.version_number) : null,
    strategyVersionLabel: row.version_label != null ? String(row.version_label) : null,
    operational: {
      symbol: row.inst_symbol ?? null,
      timeframe: row.inst_timeframe ?? null,
      symbolMode: row.inst_symbol_mode ?? null,
      marketMode: row.inst_market_mode ?? null,
      universe: row.inst_universe ?? null,
      riskPerTrade: row.inst_risk_per_trade != null ? Number(row.inst_risk_per_trade) : null,
      riskUnit: row.inst_risk_unit ?? null,
      maxDailyLoss: row.inst_max_daily_loss != null ? Number(row.inst_max_daily_loss) : null,
      maxDailyLossUnit: row.inst_max_daily_loss_unit ?? null,
      capitalMode: row.inst_capital_mode ?? null,
      capitalUsdt: row.inst_capital_usdt != null ? Number(row.inst_capital_usdt) : null,
      capitalPct: row.inst_capital_pct != null ? Number(row.inst_capital_pct) : null,
      compoundPnl: row.inst_compound_pnl ?? null,
    },
    allotment: a,
  };
}

/**
 * Return the raw inst_* columns for an instance (used by appState.ensureEngine
 * to merge operational overrides INTO the strategy's flat cfg_raw before bot hydrate).
 *
 * @param {string} instanceId
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function getInstanceOperationalConfig(instanceId) {
  const r = await query(
    `SELECT inst_symbol, inst_timeframe, inst_symbol_mode, inst_market_mode,
            inst_universe, inst_risk_per_trade, inst_risk_unit,
            inst_max_daily_loss, inst_max_daily_loss_unit,
            inst_capital_mode, inst_capital_usdt, inst_capital_pct, inst_compound_pnl
     FROM bot_instances
     WHERE id = $1 AND is_deleted = false`,
    [instanceId],
  );
  return r.rows[0] ?? null;
}

/**
 * @param {string} instanceId
 * @returns {Promise<{
 *   accountId: string;
 *   strategyVersionId: string;
 *   accountModeSlug: string;
 *   isDeleted: boolean;
 *   status: string;
 *   operationalConfig: Record<string, unknown>|null;
 * } | null>}
 */
export async function getInstanceEngineBinding(instanceId) {
  const r = await query(
    `SELECT bi.id, bi.account_id, bi.strategy_version_id, bi.is_deleted, bi.status,
            tm.slug AS account_mode_slug,
            bi.inst_symbol, bi.inst_timeframe, bi.inst_symbol_mode, bi.inst_market_mode,
            bi.inst_universe,
            bi.inst_risk_per_trade, bi.inst_risk_unit,
            bi.inst_max_daily_loss, bi.inst_max_daily_loss_unit,
            bi.inst_capital_mode, bi.inst_capital_usdt, bi.inst_capital_pct, bi.inst_compound_pnl
     FROM bot_instances bi
     JOIN accounts a ON a.id = bi.account_id
     JOIN trading_modes tm ON tm.id = a.mode_id
     WHERE bi.id = $1`,
    [instanceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    strategyVersionId: String(row.strategy_version_id),
    accountModeSlug: String(row.account_mode_slug || ""),
    isDeleted: Boolean(row.is_deleted),
    status: String(row.status || "stopped"),
    operationalConfig: {
      inst_symbol: row.inst_symbol ?? null,
      inst_timeframe: row.inst_timeframe ?? null,
      inst_symbol_mode: row.inst_symbol_mode ?? null,
      inst_market_mode: row.inst_market_mode ?? null,
      inst_universe: row.inst_universe ?? null,
      inst_risk_per_trade: row.inst_risk_per_trade != null ? Number(row.inst_risk_per_trade) : null,
      inst_risk_unit: row.inst_risk_unit ?? null,
      inst_max_daily_loss: row.inst_max_daily_loss != null ? Number(row.inst_max_daily_loss) : null,
      inst_max_daily_loss_unit: row.inst_max_daily_loss_unit ?? null,
      inst_capital_mode: row.inst_capital_mode ?? null,
      inst_capital_usdt: row.inst_capital_usdt != null ? Number(row.inst_capital_usdt) : null,
      inst_capital_pct: row.inst_capital_pct != null ? Number(row.inst_capital_pct) : null,
      inst_compound_pnl: row.inst_compound_pnl ?? null,
    },
  };
}

/**
 * Sync sidebar selections from persisted active instance ids (server startup).
 * Instance choice must not overwrite mode-level active account/strategy bindings.
 * @param {{ getActiveInstance: (slug: string) => string | null }} appState
 */
export async function syncSidebarFromActiveInstances(appState) {
  for (const slug of SLUGS) {
    const id = appState.getActiveInstance?.(slug);
    if (!id) continue;
    const b = await getInstanceEngineBinding(String(id));
    if (!b || b.isDeleted) continue;
    const wantSlug = normalizeModeSlugParam(slug);
    if (wantSlug && b.accountModeSlug !== wantSlug) continue;
  }
}

/**
 * Create a new bot_instance with capital allotment + operational config.
 *
 * @param {string} userId
 * @param {string} modeSlug
 * @param {string} accountId
 * @param {string} strategyVersionId
 * @param {string|null} label
 * @param {'FIXED'|'PCT'} capitalMode
 * @param {number|null} capitalUsdt
 * @param {number|null} capitalPct
 * @param {Partial<{
 *   inst_symbol: string|null,
 *   inst_timeframe: string|null,
 *   inst_symbol_mode: string|null,
 *   inst_market_mode: string|null,
 *   inst_universe: Record<string, unknown>|null,
 *   inst_risk_per_trade: number|null,
 *   inst_risk_unit: string|null,
 *   inst_max_daily_loss: number|null,
 *   inst_max_daily_loss_unit: string|null,
 *   inst_compound_pnl: boolean|null,
 * }>} [operational]
 *
 * Operational fields default to whatever the strategy version's flat cfg_raw
 * carries today (so existing UX is preserved). Capital fields are also persisted
 * to inst_capital_* so the instance is the single source of truth at runtime.
 */
export async function createInstance(
  userId,
  modeSlug,
  accountId,
  strategyVersionId,
  label,
  capitalMode,
  capitalUsdt,
  capitalPct,
  operational = {},
) {
  const mslug = normalizeModeSlugParam(modeSlug);
  if (!mslug) throw new Error("invalid_mode_slug");

  const accRow = await accountsService.getAccountAccessRow(accountId);
  if (!accRow) throw new Error("account_not_found");
  if (String(accRow.user_id) !== String(userId) && !(mslug === "paper" && accRow.account_type === "system")) {
    throw new Error("account_forbidden");
  }
  if (String(accRow.mode_slug || "") !== mslug) throw new ModesMismatchError();

  const st = await strategyService.getStrategyByVersionId(strategyVersionId);
  if (!st || String(st.userId) !== String(userId)) throw new Error("strategy_version_not_found");

  const capMode = String(capitalMode || "").toUpperCase();
  if (capMode !== "FIXED" && capMode !== "PCT") throw new InsufficientCapitalError("invalid_allotment_mode");

  const snap = await getLatestSnapshot(accountId);
  if (!snap || snap.available_usdt == null) throw new InsufficientCapitalError("no_wallet_snapshot");
  const avail = Number(snap.available_usdt);
  if (!Number.isFinite(avail) || avail < 0) throw new InsufficientCapitalError("invalid_wallet_snapshot");

  let configuredUsdt = 0;
  let configuredPct = null;
  if (capMode === "FIXED") {
    const u = Number(capitalUsdt);
    if (!Number.isFinite(u) || u <= 0) throw new InsufficientCapitalError("invalid_configured_usdt");
    configuredUsdt = u;
  } else {
    const p = Number(capitalPct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) throw new InsufficientCapitalError("invalid_configured_pct");
    configuredPct = p;
    configuredUsdt = (p / 100) * avail;
    if (!Number.isFinite(configuredUsdt) || configuredUsdt <= 0) throw new InsufficientCapitalError("invalid_configured_usdt");
  }

  const snapId = snap.id != null ? String(snap.id) : null;
  const snapAt = snap.captured_at ?? null;

  // Seed inst_* defaults from the strategy version's flat cfg_raw, then overlay
  // any explicit overrides supplied by the caller.
  const ver = await strategyService.getVersion(strategyVersionId);
  const defaults = extractInstanceConfig(ver?.cfgRaw ?? {});
  const op = operational && typeof operational === "object" ? operational : {};
  const inst = {
    inst_symbol: op.inst_symbol ?? defaults.inst_symbol,
    inst_timeframe: op.inst_timeframe ?? defaults.inst_timeframe,
    inst_symbol_mode: op.inst_symbol_mode ?? defaults.inst_symbol_mode,
    inst_market_mode: op.inst_market_mode ?? defaults.inst_market_mode,
    inst_universe: op.inst_universe ?? defaults.inst_universe,
    inst_risk_per_trade: op.inst_risk_per_trade ?? defaults.inst_risk_per_trade,
    inst_risk_unit: op.inst_risk_unit ?? defaults.inst_risk_unit,
    inst_max_daily_loss: op.inst_max_daily_loss ?? defaults.inst_max_daily_loss,
    inst_max_daily_loss_unit: op.inst_max_daily_loss_unit ?? defaults.inst_max_daily_loss_unit,
    inst_compound_pnl: op.inst_compound_pnl ?? defaults.inst_compound_pnl,
  };

  const newId = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO bot_instances (
         account_id, strategy_version_id, label, status,
         inst_symbol, inst_timeframe, inst_symbol_mode, inst_market_mode,
         inst_universe, inst_risk_per_trade, inst_risk_unit,
         inst_max_daily_loss, inst_max_daily_loss_unit,
         inst_capital_mode, inst_capital_usdt, inst_capital_pct, inst_compound_pnl
       )
       VALUES (
         $1, $2, $3, 'stopped',
         $4, $5, $6, $7,
         $8::jsonb, $9, $10,
         $11, $12,
         $13, $14, $15, $16
       )
       RETURNING *`,
      [
        accountId,
        strategyVersionId,
        label != null && String(label).trim() ? String(label).trim() : null,
        inst.inst_symbol,
        inst.inst_timeframe,
        inst.inst_symbol_mode,
        inst.inst_market_mode,
        inst.inst_universe,
        inst.inst_risk_per_trade,
        inst.inst_risk_unit,
        inst.inst_max_daily_loss,
        inst.inst_max_daily_loss_unit,
        capMode,
        configuredUsdt,
        configuredPct,
        inst.inst_compound_pnl,
      ],
    );
    const row = ins.rows[0];
    if (!row) throw new Error("insert_instance_failed");

    await createAllotmentWithClient(
      client,
      String(row.id),
      accountId,
      capMode,
      configuredUsdt,
      configuredPct,
      snapId,
      snapAt,
    );

    return String(row.id);
  });

  /** `getInstanceDetail` uses pool `query()` — must run after COMMIT so the new row is visible. */
  const detail = await getInstanceDetail(newId, userId);
  if (!detail) throw new Error("instance_load_failed");
  return detail;
}

/**
 * Update operational config (`inst_*`) on an existing instance.
 * Only keys present in `patch` are written; null is treated as "clear".
 *
 * @param {string} instanceId
 * @param {string} userId
 * @param {Partial<Record<typeof INSTANCE_OPERATIONAL_KEYS[number], unknown>>} patch
 */
export async function updateInstanceOperationalConfig(instanceId, userId, patch) {
  await assertInstanceOwned(instanceId, userId);
  if (!patch || typeof patch !== "object") throw new Error("invalid_patch");
  const sets = [];
  const params = [instanceId];
  let i = 2;
  for (const key of INSTANCE_OPERATIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (key === "inst_universe") {
      sets.push(`${key} = $${i}::jsonb`);
      params.push(v == null ? null : JSON.stringify(v));
    } else {
      sets.push(`${key} = $${i}`);
      params.push(v == null ? null : v);
    }
    i++;
  }
  if (!sets.length) return getInstanceDetail(instanceId, userId);
  sets.push(`updated_at = NOW()`);
  await query(
    `UPDATE bot_instances SET ${sets.join(", ")} WHERE id = $1 AND is_deleted = false`,
    params,
  );
  return getInstanceDetail(instanceId, userId);
}

/**
 * Point an instance at a different strategy version (after Save / Save as New).
 * Validates ownership and that the version belongs to the same user.
 *
 * @param {string} instanceId
 * @param {string} userId
 * @param {string} strategyVersionId
 */
export async function updateInstanceStrategyVersion(instanceId, userId, strategyVersionId) {
  await assertInstanceOwned(instanceId, userId);
  const st = await strategyService.getStrategyByVersionId(strategyVersionId);
  if (!st || String(st.userId) !== String(userId)) throw new Error("strategy_version_not_found");
  const r = await query(
    `UPDATE bot_instances SET strategy_version_id = $2, updated_at = NOW()
     WHERE id = $1 AND is_deleted = false
     RETURNING *`,
    [instanceId, strategyVersionId],
  );
  if (!r.rows[0]) throw new InstanceNotFoundError();
  return getInstanceDetail(instanceId, userId);
}

const LIST_SELECT = `
  SELECT DISTINCT ON (bi.id)
    bi.*,
    a.label AS account_label,
    tm.slug AS account_mode_slug,
    s.id AS strategy_id,
    s.name AS strategy_name,
    sv.version_number,
    sv.label AS version_label,
    ca.id AS ca_id,
    ca.allotment_mode AS ca_allotment_mode,
    ca.configured_usdt AS ca_configured_usdt,
    ca.configured_pct AS ca_configured_pct,
    ca.reserved_usdt AS ca_reserved_usdt,
    ca.status AS ca_status
  FROM bot_instances bi
  JOIN accounts a ON a.id = bi.account_id
  JOIN trading_modes tm ON tm.id = a.mode_id
  JOIN strategy_versions sv ON sv.id = bi.strategy_version_id
  JOIN strategies s ON s.id = sv.strategy_id
  LEFT JOIN capital_allotments ca ON ca.instance_id = bi.id AND ca.status = 'active'
  WHERE bi.is_deleted = false
    AND tm.slug = $2
    AND (a.user_id = $1 OR (tm.slug = 'paper' AND s.user_id = $1))
  ORDER BY bi.id, ca.created_at DESC NULLS LAST, bi.created_at ASC
`;

/**
 * @param {string} userId
 * @param {string} modeSlug
 */
export async function listInstancesForMode(userId, modeSlug) {
  const mslug = normalizeModeSlugParam(modeSlug);
  if (!mslug) return [];
  const r = await query(LIST_SELECT, [userId, mslug]);
  return r.rows.map((row) => {
    const ca =
      row.ca_id != null
        ? {
            id: row.ca_id,
            allotment_mode: row.ca_allotment_mode,
            configured_usdt: row.ca_configured_usdt,
            configured_pct: row.ca_configured_pct,
            reserved_usdt: row.ca_reserved_usdt,
            status: row.ca_status,
          }
        : null;
    return mapInstanceRow(row, ca);
  });
}

/**
 * @param {string} instanceId
 * @param {string} userId
 */
export async function getInstanceDetail(instanceId, userId) {
  const r2 = await query(
    `SELECT DISTINCT ON (bi.id)
       bi.*,
       a.label AS account_label,
       tm.slug AS account_mode_slug,
       s.id AS strategy_id,
       s.name AS strategy_name,
       sv.version_number,
       sv.label AS version_label,
       ca.id AS ca_id,
       ca.allotment_mode AS ca_allotment_mode,
       ca.configured_usdt AS ca_configured_usdt,
       ca.configured_pct AS ca_configured_pct,
       ca.reserved_usdt AS ca_reserved_usdt,
       ca.status AS ca_status
     FROM bot_instances bi
     JOIN accounts a ON a.id = bi.account_id
     JOIN trading_modes tm ON tm.id = a.mode_id
     JOIN strategy_versions sv ON sv.id = bi.strategy_version_id
     JOIN strategies s ON s.id = sv.strategy_id
     LEFT JOIN capital_allotments ca ON ca.instance_id = bi.id AND ca.status = 'active'
     WHERE bi.is_deleted = false AND bi.id = $1
       AND (a.user_id = $2 OR (tm.slug = 'paper' AND s.user_id = $2))
     ORDER BY bi.id, ca.created_at DESC NULLS LAST`,
    [instanceId, userId],
  );
  const row = r2.rows[0];
  if (!row) return null;
  const ca =
    row.ca_id != null
      ? {
          id: row.ca_id,
          allotment_mode: row.ca_allotment_mode,
          configured_usdt: row.ca_configured_usdt,
          configured_pct: row.ca_configured_pct,
          reserved_usdt: row.ca_reserved_usdt,
          status: row.ca_status,
        }
      : null;
  return mapInstanceRow(row, ca);
}

/**
 * @param {string} instanceId
 * @param {string} userId
 */
export async function assertInstanceOwned(instanceId, userId) {
  const d = await getInstanceDetail(instanceId, userId);
  if (!d) throw new InstanceNotFoundError();
  return d;
}

/**
 * @param {string} instanceId
 * @param {string} toStatus
 * @param {string|null} reason
 * @param {string} triggeredBy
 * @param {Record<string, unknown>|null} metadata
 */
export async function updateInstanceStatus(instanceId, toStatus, reason, triggeredBy, metadata = null) {
  const t = String(toStatus || "").toLowerCase();
  if (!["running", "stopped", "error", "paused"].includes(t)) throw new Error("invalid_status");

  return withTransaction(async (client) => {
    const cur = await client.query(`SELECT * FROM bot_instances WHERE id = $1 AND is_deleted = false`, [instanceId]);
    const prev = cur.rows[0];
    if (!prev) throw new InstanceNotFoundError();
    const fromStatus = String(prev.status || "stopped");

    const now = new Date();
    let sql = `UPDATE bot_instances SET status = $1, updated_at = $2`;
    const params = [t, now];
    let i = 3;
    if (t === "running") {
      sql += `, last_start_at = $${i}, error_message = NULL`;
      params.push(now);
      i++;
    } else if (t === "stopped") {
      sql += `, last_stop_at = $${i}, last_stop_reason = $${i + 1}, error_message = NULL`;
      params.push(now, reason != null ? String(reason) : null);
      i += 2;
    } else if (t === "error") {
      sql += `, last_stop_at = $${i}, error_message = $${i + 1}`;
      params.push(now, reason != null ? String(reason) : "error");
      i += 2;
    }
    sql += ` WHERE id = $${i}`;
    params.push(instanceId);
    await client.query(sql, params);

    await client.query(
      `INSERT INTO instance_status_log (instance_id, from_status, to_status, reason, triggered_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        instanceId,
        fromStatus,
        t,
        reason != null ? String(reason) : null,
        String(triggeredBy || "system"),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    const out = await client.query(`SELECT * FROM bot_instances WHERE id = $1`, [instanceId]);
    return out.rows[0] ?? null;
  });
}

/**
 * @param {string} instanceId
 * @param {{ totalTrades?: number, totalPnlUsdt?: number }} stats
 */
/**
 * Aggregate closed-trade stats for an instance (Phase 3E `trades` rows may be sparse until wired).
 * @param {string} instanceId
 * @returns {Promise<{ totalTrades: number; totalPnlUsdt: number }>}
 */
export async function computeInstanceStats(instanceId) {
  const r = await query(
    `SELECT COUNT(*)::text AS c, COALESCE(SUM(net_pnl), 0)::text AS pnl
     FROM trades WHERE instance_id = $1`,
    [instanceId],
  );
  const row = r.rows[0];
  const c = Math.max(0, Math.floor(Number(row?.c ?? 0)));
  const pnl = Number(row?.pnl ?? 0);
  return {
    totalTrades: Number.isFinite(c) ? c : 0,
    totalPnlUsdt: Number.isFinite(pnl) ? pnl : 0,
  };
}

export async function updateInstanceStats(instanceId, stats) {
  const tt = stats.totalTrades;
  const pnl = stats.totalPnlUsdt;
  const sets = [];
  const params = [instanceId];
  let i = 2;
  if (tt != null && Number.isFinite(Number(tt))) {
    sets.push(`total_trades = $${i}`);
    params.push(Math.floor(Number(tt)));
    i++;
  }
  if (pnl != null && Number.isFinite(Number(pnl))) {
    sets.push(`total_pnl_usdt = $${i}`);
    params.push(Number(pnl));
    i++;
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  const r = await query(`UPDATE bot_instances SET ${sets.join(", ")} WHERE id = $1 AND is_deleted = false RETURNING *`, params);
  return r.rows[0] ?? null;
}

/**
 * @param {string} instanceId
 * @param {string} userId
 * @param {string|null} label
 */
export async function updateInstanceLabel(instanceId, userId, label) {
  await assertInstanceOwned(instanceId, userId);
  const r = await query(
    `UPDATE bot_instances SET label = $2, updated_at = NOW() WHERE id = $1 AND is_deleted = false RETURNING *`,
    [instanceId, label != null && String(label).trim() ? String(label).trim() : null],
  );
  const row = r.rows[0];
  if (!row) throw new InstanceNotFoundError();
  return getInstanceDetail(instanceId, userId);
}

/**
 * @param {string} instanceId
 * @param {string} userId
 */
export async function clearInstanceError(instanceId, userId) {
  await assertInstanceOwned(instanceId, userId);
  const r = await query(`SELECT status, error_message FROM bot_instances WHERE id = $1 AND is_deleted = false`, [instanceId]);
  const row = r.rows[0];
  if (!row) throw new InstanceNotFoundError();
  if (String(row.status) !== "error") throw new Error("not_in_error_state");
  await query(
    `UPDATE bot_instances SET status = 'stopped', error_message = NULL, updated_at = NOW() WHERE id = $1`,
    [instanceId],
  );
  await query(
    `INSERT INTO instance_status_log (instance_id, from_status, to_status, reason, triggered_by, metadata)
     VALUES ($1, 'error', 'stopped', $2, 'user', NULL)`,
    [instanceId, "Error cleared by user"],
  );
  return getInstanceDetail(instanceId, userId);
}

/**
 * @param {string} instanceId
 * @param {string} userId
 */
export async function deleteInstance(instanceId, userId) {
  const d = await assertInstanceOwned(instanceId, userId);
  const st = String(d.status || "").toLowerCase();
  if (st !== "stopped") throw new InstanceNotStoppedError();

  const allot = await getAllotmentForInstance(instanceId);
  if (allot?.id) await releaseCapital(String(allot.id), 0);

  await query(`UPDATE bot_instances SET is_deleted = true, updated_at = NOW() WHERE id = $1`, [instanceId]);
  return { ok: true };
}

/**
 * @param {string} instanceId
 * @param {string} userId
 * @param {number} [limit=50]
 */
export async function getStatusLog(instanceId, userId, limit = 50) {
  await assertInstanceOwned(instanceId, userId);
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const r = await query(
    `SELECT * FROM instance_status_log WHERE instance_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [instanceId, lim],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    instanceId: String(row.instance_id),
    fromStatus: row.from_status != null ? String(row.from_status) : null,
    toStatus: String(row.to_status),
    reason: row.reason != null ? String(row.reason) : null,
    triggeredBy: String(row.triggered_by || ""),
    metadata: row.metadata,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

/**
 * @param {string} instanceId
 * @param {string} userId
 * @param {string} modeSlug
 */
export async function assertInstanceMatchesMode(instanceId, userId, modeSlug) {
  const d = await getInstanceDetail(instanceId, userId);
  if (!d) throw new InstanceNotFoundError();
  const m = normalizeModeSlugParam(modeSlug);
  if (!m || d.accountModeSlug !== m) throw new Error("instance_mode_mismatch");
  return d;
}

function instanceIsBusy(row) {
  const st = String(row?.status ?? "").toLowerCase();
  if (st === "running" || st === "paused") return true;
  const open = Number(row?.open_trades ?? row?.openTrades ?? 0);
  return Number.isFinite(open) && open > 0;
}

/** All non-deleted instances bound to a strategy (any mode). */
export async function listInstancesUsingStrategy(userId, strategyId) {
  const r = await query(
    `SELECT bi.id, bi.label, bi.status, tm.slug AS mode_slug,
            s.id AS strategy_id,
            (SELECT COUNT(*)::int FROM trades t WHERE t.instance_id = bi.id AND t.status = 'open') AS open_trades
     FROM bot_instances bi
     JOIN strategy_versions sv ON sv.id = bi.strategy_version_id
     JOIN strategies s ON s.id = sv.strategy_id
     JOIN accounts a ON a.id = bi.account_id
     JOIN trading_modes tm ON tm.id = a.mode_id
     WHERE s.id = $1 AND bi.is_deleted = false AND s.user_id = $2
     ORDER BY tm.slug ASC, bi.created_at ASC`,
    [strategyId, userId],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    label: row.label != null ? String(row.label) : null,
    status: String(row.status || "stopped"),
    modeSlug: String(row.mode_slug || ""),
    strategyId: String(row.strategy_id),
    openTrades: Number(row.open_trades ?? 0),
  }));
}

/**
 * @param {string} userId
 * @param {string} strategyId
 * @param {string|null|undefined} [currentInstanceId]
 */
export async function getStrategyUsageContext(userId, strategyId, currentInstanceId = null) {
  const instances = await listInstancesUsingStrategy(userId, strategyId);
  const curId = currentInstanceId != null ? String(currentInstanceId) : null;
  const others = curId ? instances.filter((i) => i.id !== curId) : instances;
  const otherInstancesBusy = others.some(instanceIsBusy);
  const anyBusy = instances.some(instanceIsBusy);
  let blockReason = null;
  if (otherInstancesBusy) {
    blockReason =
      "Another instance using this strategy is running, paused, or has open trades. Save as new to fork a private copy for this instance.";
  }
  let renameBlockReason = null;
  if (anyBusy) {
    renameBlockReason =
      "Stop every instance using this strategy and close open trades before changing its name.";
  }
  return {
    instanceCount: instances.length,
    shared: instances.length > 1,
    instances,
    otherInstancesBusy,
    canSaveInPlace: !otherInstancesBusy,
    canRename: !anyBusy,
    blockReason,
    renameBlockReason,
  };
}
