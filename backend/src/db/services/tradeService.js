import { query } from "../query.js";
import * as performanceService from "./performanceService.js";

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapSignalRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    instanceId: String(row.instance_id),
    symbol: String(row.symbol),
    signalType: String(row.signal_type),
    direction: String(row.direction),
    timeframe: String(row.timeframe),
    barCloseTime: row.bar_close_time ? new Date(row.bar_close_time).toISOString() : null,
    stValue: row.st_value != null ? Number(row.st_value) : null,
    aiProbability: row.ai_probability != null ? Number(row.ai_probability) : null,
    mdeScore: row.mde_score != null ? Number(row.mde_score) : null,
    signalStrength: row.signal_strength != null ? Number(row.signal_strength) : null,
    wasExecuted: Boolean(row.was_executed),
    gateReason: row.gate_reason != null ? String(row.gate_reason) : null,
    rawContext: row.raw_context,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapTradeRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    instanceId: String(row.instance_id),
    strategyVersionId: row.strategy_version_id != null ? String(row.strategy_version_id) : null,
    signalId: row.signal_id != null ? String(row.signal_id) : null,
    symbol: String(row.symbol),
    marketType: String(row.market_type),
    direction: String(row.direction),
    status: String(row.status),
    entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
    notionalUsdt: row.notional_usdt != null ? Number(row.notional_usdt) : null,
    leverage: row.leverage != null ? Number(row.leverage) : null,
    slPrice: row.sl_price != null ? Number(row.sl_price) : null,
    tpPrice: row.tp_price != null ? Number(row.tp_price) : null,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : null,
    grossPnl: row.gross_pnl != null ? Number(row.gross_pnl) : null,
    feesUsdt: row.fees_usdt != null ? Number(row.fees_usdt) : null,
    netPnl: row.net_pnl != null ? Number(row.net_pnl) : null,
    roiPct: row.roi_pct != null ? Number(row.roi_pct) : null,
    holdDurationSec: row.hold_duration_sec != null ? Number(row.hold_duration_sec) : null,
    binanceOrderIds: Array.isArray(row.binance_order_ids) ? row.binance_order_ids.map(String) : null,
    openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapFillRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tradeId: String(row.trade_id),
    binanceOrderId: String(row.binance_order_id),
    binanceTradeId: row.binance_trade_id != null ? String(row.binance_trade_id) : null,
    fillType: String(row.fill_type),
    side: String(row.side),
    price: Number(row.price),
    quantity: Number(row.quantity),
    feeAsset: row.fee_asset != null ? String(row.fee_asset) : null,
    feeAmount: row.fee_amount != null ? Number(row.fee_amount) : null,
    feeUsdt: row.fee_usdt != null ? Number(row.fee_usdt) : null,
    isMaker: row.is_maker != null ? Boolean(row.is_maker) : null,
    filledAt: row.filled_at ? new Date(row.filled_at).toISOString() : null,
  };
}

/**
 * @param {string} instanceId
 * @param {object} fields
 */
export async function updateSignalOutcome(signalId, { wasExecuted, gateReason }) {
  await query(`UPDATE trade_signals SET was_executed = $2, gate_reason = $3 WHERE id = $1`, [
    signalId,
    Boolean(wasExecuted),
    gateReason != null ? String(gateReason) : null,
  ]);
}

export async function recordSignal(instanceId, fields) {
  const sym = String(fields.symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("signal_symbol_required");
  const signalType = String(fields.signalType || "SUPERTREND");
  const direction = String(fields.direction || "LONG").toUpperCase();
  const timeframe = String(fields.timeframe || "1m");
  const barCloseTime = fields.barCloseTime instanceof Date ? fields.barCloseTime : new Date(fields.barCloseTime);
  const r = await query(
    `INSERT INTO trade_signals (
       instance_id, symbol, signal_type, direction, timeframe, bar_close_time,
       st_value, ai_probability, mde_score, signal_strength,
       was_executed, gate_reason, raw_context
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING *`,
    [
      instanceId,
      sym,
      signalType,
      direction,
      timeframe,
      barCloseTime,
      fields.stValue != null ? numOrNull(fields.stValue) : null,
      fields.aiProbability != null ? numOrNull(fields.aiProbability) : null,
      fields.mdeScore != null ? numOrNull(fields.mdeScore) : null,
      fields.signalStrength != null ? numOrNull(fields.signalStrength) : null,
      Boolean(fields.wasExecuted),
      fields.gateReason != null ? String(fields.gateReason) : null,
      fields.rawContext != null ? JSON.stringify(fields.rawContext) : null,
    ],
  );
  return mapSignalRow(r.rows[0]);
}

async function resolveStrategyVersionIdForInstance(instanceId) {
  const r = await query(`SELECT strategy_version_id FROM bot_instances WHERE id = $1 AND is_deleted = false`, [
    instanceId,
  ]);
  const id = r.rows[0]?.strategy_version_id;
  return id != null ? String(id) : null;
}

/**
 * @param {string} instanceId
 * @param {string|null} signalId
 * @param {object} o
 */
export async function openTrade(instanceId, signalId, o) {
  const sym = String(o.symbol || "").trim().toUpperCase();
  const marketType = String(o.marketType || "FUTURES").toUpperCase();
  const direction = String(o.direction || "LONG").toUpperCase();
  const qty = numOrNull(o.quantity);
  const entryPx = numOrNull(
    o.entryPrice ?? (o.notional != null && qty ? Number(o.notional) / qty : null),
  );
  const notional =
    o.notional != null
      ? numOrNull(o.notional)
      : entryPx != null && qty != null && qty > 0
        ? entryPx * qty
        : null;
  const stratId = o.strategyVersionId != null ? String(o.strategyVersionId) : await resolveStrategyVersionIdForInstance(instanceId);
  const oids = Array.isArray(o.binanceOrderIds) ? o.binanceOrderIds.map(String).filter(Boolean) : [];
  const r = await query(
    `INSERT INTO trades (
       instance_id, strategy_version_id, signal_id, symbol, market_type, direction, status,
       entry_price, quantity, notional_usdt, leverage, sl_price, tp_price, binance_order_ids, opened_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13::text[], NOW())
     RETURNING *`,
    [
      instanceId,
      stratId,
      signalId && String(signalId).trim() ? String(signalId) : null,
      sym,
      marketType === "SPOT" ? "SPOT" : "FUTURES",
      direction === "SHORT" ? "SHORT" : "LONG",
      entryPx,
      qty,
      notional,
      o.leverage != null ? Math.floor(Number(o.leverage)) : null,
      o.slPrice != null ? numOrNull(o.slPrice) : null,
      o.tpPrice != null ? numOrNull(o.tpPrice) : null,
      oids.length ? oids : null,
    ],
  );
  return mapTradeRow(r.rows[0]);
}

/**
 * @param {string} tradeId
 * @param {object} o
 */
export async function closeTrade(tradeId, o) {
  const exitPx = o.exitPrice != null ? numOrNull(o.exitPrice) : null;
  const gross = o.grossPnl != null ? numOrNull(o.grossPnl) : null;
  const fees = o.feesUsdt != null ? numOrNull(o.feesUsdt) : null;
  const net = o.netPnl != null ? numOrNull(o.netPnl) : null;
  const roi = o.roiPct != null ? numOrNull(o.roiPct) : null;
  const hold = o.holdDurationSec != null ? Math.floor(Number(o.holdDurationSec)) : null;
  const reason = o.exitReason != null ? String(o.exitReason) : null;
  const extraOids = Array.isArray(o.binanceOrderIds) ? o.binanceOrderIds.map(String).filter(Boolean) : [];

  const cur = await query(`SELECT binance_order_ids FROM trades WHERE id = $1`, [tradeId]);
  const prevOids = cur.rows[0]?.binance_order_ids;
  const merged =
    Array.isArray(prevOids) && prevOids.length
      ? [...new Set([...prevOids.map(String), ...extraOids])]
      : extraOids.length
        ? extraOids
        : null;

  const r = await query(
    `UPDATE trades SET
       status = 'closed',
       exit_price = COALESCE($2, exit_price),
       exit_reason = COALESCE($3, exit_reason),
       gross_pnl = COALESCE($4, gross_pnl),
       fees_usdt = COALESCE($5, fees_usdt),
       net_pnl = COALESCE($6, net_pnl),
       roi_pct = COALESCE($7, roi_pct),
       hold_duration_sec = COALESCE($8, hold_duration_sec),
       binance_order_ids = COALESCE($9::text[], binance_order_ids),
       closed_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [tradeId, exitPx, reason, gross, fees, net, roi, hold, merged],
  );
  const mapped = mapTradeRow(r.rows[0]);
  if (mapped) {
    const vid = mapped.strategyVersionId;
    if (vid) {
      void performanceService.recalculateStrategyPerformance(vid).catch(() => {});
    } else {
      void getStrategyVersionIdForTrade(tradeId)
        .then((v) => (v ? performanceService.recalculateStrategyPerformance(v) : null))
        .catch(() => {});
    }
  }
  return mapped;
}

/**
 * @param {string} tradeId
 * @returns {Promise<string|null>}
 */
export async function getStrategyVersionIdForTrade(tradeId) {
  const r = await query(
    `SELECT COALESCE(t.strategy_version_id, i.strategy_version_id) AS sid
     FROM trades t
     JOIN bot_instances i ON t.instance_id = i.id
     WHERE t.id = $1`,
    [tradeId],
  );
  const sid = r.rows[0]?.sid;
  return sid != null ? String(sid) : null;
}

/**
 * @param {string} tradeId
 * @param {object} f
 */
export async function addFill(tradeId, f) {
  const oid = String(f.binanceOrderId || "").trim();
  if (!oid) throw new Error("fill_order_id_required");
  const r = await query(
    `INSERT INTO trade_fills (
       trade_id, binance_order_id, binance_trade_id, fill_type, side,
       price, quantity, fee_asset, fee_amount, fee_usdt, is_maker, filled_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      tradeId,
      oid,
      f.binanceTradeId != null ? String(f.binanceTradeId) : null,
      String(f.fillType || "entry"),
      String(f.side || "BUY"),
      numOrNull(f.price),
      numOrNull(f.quantity),
      f.feeAsset != null ? String(f.feeAsset) : null,
      f.feeAmount != null ? numOrNull(f.feeAmount) : null,
      f.feeUsdt != null ? numOrNull(f.feeUsdt) : null,
      f.isMaker != null ? Boolean(f.isMaker) : null,
      f.filledAt instanceof Date ? f.filledAt : new Date(f.filledAt || Date.now()),
    ],
  );
  return mapFillRow(r.rows[0]);
}

/**
 * @param {string} tradeId
 * @param {string} reason
 */
export async function cancelTrade(tradeId, reason) {
  const r = await query(
    `UPDATE trades SET status = 'cancelled', exit_reason = $2, closed_at = NOW() WHERE id = $1 AND status = 'open' RETURNING *`,
    [tradeId, reason != null ? String(reason) : "cancelled"],
  );
  return mapTradeRow(r.rows[0]);
}

/**
 * @param {string} instanceId
 * @param {{ limit?: number, offset?: number, status?: string }} opts
 */
export async function getTradesForInstance(instanceId, opts = {}) {
  const lim = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 50)));
  const off = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const st = opts.status != null && String(opts.status).trim() ? String(opts.status).trim().toLowerCase() : null;
  if (st && ["open", "closed", "cancelled", "pending", "error"].includes(st)) {
    const r = await query(
      `SELECT * FROM trades WHERE instance_id = $1 AND status = $4 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [instanceId, lim, off, st],
    );
    return r.rows.map((row) => mapTradeRow(row));
  }
  const r = await query(
    `SELECT * FROM trades WHERE instance_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [instanceId, lim, off],
  );
  return r.rows.map((row) => mapTradeRow(row));
}

/**
 * @param {string} tradeId
 */
export async function getTradeById(tradeId) {
  const r = await query(`SELECT * FROM trades WHERE id = $1`, [tradeId]);
  const t = mapTradeRow(r.rows[0]);
  if (!t) return null;
  const f = await query(`SELECT * FROM trade_fills WHERE trade_id = $1 ORDER BY filled_at ASC`, [tradeId]);
  return { ...t, fills: f.rows.map(mapFillRow) };
}

/**
 * @param {string} instanceId
 * @param {{ limit?: number, wasExecuted?: boolean }} opts
 */
export async function getSignalsForInstance(instanceId, opts = {}) {
  const lim = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 50)));
  const params = [instanceId, lim];
  let where = "WHERE instance_id = $1";
  if (opts.wasExecuted === true) {
    where += " AND was_executed = true";
  } else if (opts.wasExecuted === false) {
    where += " AND was_executed = false";
  }
  const r = await query(`SELECT * FROM trade_signals ${where} ORDER BY created_at DESC LIMIT $2`, params);
  return r.rows.map(mapSignalRow);
}
