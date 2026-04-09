import crypto from "crypto";
import axios from "axios";
import { createBinanceTestnetStore } from "./binanceTestnetStore.js";
import WebSocket from "ws";
import { resolveDefaultTestnetSpotStoreDir } from "../../lib/tradingModePersistence.js";
import { roundTo } from "../../lib/math.js";
import {
  sumCommissionsByAssetFromFills,
  commissionsByAssetToUsdApprox,
  mergeByAsset,
  createUsdtTicker,
  spotRoundTripPnlWithFees,
} from "../../lib/binanceSpotCommissions.js";
import { extractMinNotionalFromFilters } from "../../lib/binanceMinNotional.js";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBinanceTestnetSpotExchange({ log }) {
  const apiKey = process.env.BINANCE_API_KEY || "";
  const apiSecret = process.env.BINANCE_API_SECRET || "";
  const baseURL = process.env.BINANCE_TESTNET_REST_BASE || "https://testnet.binance.vision";

  if (!apiKey || !apiSecret) {
    log.warn("binance_testnet_missing_keys", {});
  }

  const http = axios.create({
    baseURL,
    timeout: 10_000,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  const usdtPriceForAsset = createUsdtTicker({ http, path: "/api/v3/ticker/price", log });

  const wsBase = process.env.BINANCE_TESTNET_WS_BASE || "wss://testnet.binance.vision/ws";
  const udf = {
    listenKey: null,
    listenKeyRestBase: null,
    ws: null,
    keepAliveTimer: null,
    udfRetryTimer: null,
    status: { ok: false, lastMsgAt: null, error: null, syncMode: "polling", listenKeyRestBase: null },
  };

  function udfRestBaseCandidates() {
    const fromEnv = process.env.BINANCE_TESTNET_USERDATA_REST_BASES || "";
    const parts = fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const defaults = [baseURL, "https://testnet.binance.vision"].filter(Boolean);
    return [...new Set([...parts, ...defaults])];
  }
  const symbolMeta = new Map(); // symbol -> { stepSize, minQty, tickSize }

  async function signed(method, path, params = {}) {
    const ts = Date.now();
    const qp = new URLSearchParams({ ...params, timestamp: String(ts) });
    const sig = hmacSha256(apiSecret, qp.toString());
    qp.set("signature", sig);

    const url = `${path}?${qp.toString()}`;
    try {
      const { data } = await http.request({ method, url });
      return data;
    } catch (e) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      const msg = body?.msg || body?.message || e?.message || "binance_request_failed";
      const code = body?.code;
      const err = new Error(`binance_testnet_http_${method}_${path}:${status ?? "?"}:${code ?? "?"}:${msg}`);
      err.cause = e;
      throw err;
    }
  }

  const store = createBinanceTestnetStore({ baseDir: resolveDefaultTestnetSpotStoreDir() });
  // We model positions as: entry order + attached OCO list.
  const mem = { trades: [], openOrders: 0, positions: new Map(), lastSyncAt: null };
  const maxNotional = Number(process.env.MAX_ORDER_NOTIONAL_USDT || 50);
  const maxOpenOrders = Number(process.env.MAX_OPEN_ORDERS || 3);

  function avgFillPrice(orderResp) {
    const fills = orderResp?.fills;
    if (Array.isArray(fills) && fills.length > 0) {
      let cost = 0;
      let qty = 0;
      for (const f of fills) {
        const p = Number(f.price);
        const q = Number(f.qty);
        if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
        cost += p * q;
        qty += q;
      }
      if (qty) return cost / qty;
    }
    const ap = Number(orderResp?.avgPrice || orderResp?.price || 0);
    if (Number.isFinite(ap) && ap > 0) return ap;
    const exq = Number(orderResp?.executedQty || 0);
    const quote = Number(orderResp?.cummulativeQuoteQty || 0);
    if (exq > 0 && quote > 0) return quote / exq;
    return null;
  }

  async function getOrderList(orderListId) {
    return signed("GET", "/api/v3/orderList", { orderListId: String(orderListId) });
  }

  async function createListenKey() {
    const bases = udfRestBaseCandidates();
    let lastErr = null;
    for (const b of bases) {
      try {
        const client = axios.create({
          baseURL: b,
          timeout: 10_000,
          headers: { "X-MBX-APIKEY": apiKey },
        });
        const { data } = await client.post("/api/v3/userDataStream");
        if (data?.listenKey) {
          udf.listenKeyRestBase = b;
          return data.listenKey;
        }
      } catch (e) {
        const status = e?.response?.status;
        const body = e?.response?.data;
        const msg = typeof body === "string" && body.includes("410") ? "410 Gone (edge)" : body?.msg || body?.message || e?.message;
        lastErr = new Error(`binance_testnet_listenkey_failed:${status ?? "?"}:${msg}`);
      }
    }
    throw lastErr || new Error("binance_testnet_listenkey_failed:unknown");
  }

  async function keepAliveListenKey(listenKey) {
    const b = udf.listenKeyRestBase || baseURL;
    const client = axios.create({
      baseURL: b,
      timeout: 10_000,
      headers: { "X-MBX-APIKEY": apiKey },
    });
    try {
      await client.put("/api/v3/userDataStream", null, { params: { listenKey } });
    } catch (e) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      const msg = body?.msg || body?.message || e?.message || "udf_keepalive_failed";
      throw new Error(`binance_testnet_keepalive_failed:${status ?? "?"}:${msg}`);
    }
  }

  function stepPrecision(stepSize) {
    const s = String(stepSize || "");
    const dot = s.indexOf(".");
    if (dot < 0) return 0;
    const frac = s.slice(dot + 1).replace(/0+$/, "");
    return frac.length;
  }

  function formatPriceToTick(px, tickSize, mode) {
    const p = Number(px);
    const t = Number(tickSize || 0);
    if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return String(px);
    const stepped = mode === "up" ? Math.ceil(p / t - 1e-12) * t : Math.floor(p / t + 1e-12) * t;
    const prec = stepPrecision(String(tickSize));
    return stepped.toFixed(prec);
  }

  /** Binance OCO SELL after spot BUY: limit TP price > ref, stop trigger < ref, stopLimit < stop. */
  function ocoSellPrices({ refPx, takeProfitPx, stopLossPx, tickSize }) {
    const ref = Number(refPx);
    let tp = Number(takeProfitPx);
    let stop = Number(stopLossPx);
    const tick = Number(tickSize || 0.01);
    if (!Number.isFinite(ref) || ref <= 0) return null;

    const minMove = Math.max(tick * 3, ref * 0.0005);
    if (!Number.isFinite(tp) || tp <= ref) tp = ref + minMove;
    if (!Number.isFinite(stop) || stop >= ref) stop = ref - minMove;

    let stopLimit = stop - Math.max(tick, stop * 0.0002);
    if (stopLimit >= stop) stopLimit = stop - tick;

    const priceStr = formatPriceToTick(tp, tickSize, "up");
    const stopStr = formatPriceToTick(stop, tickSize, "down");
    let stopLimitStr = formatPriceToTick(stopLimit, tickSize, "down");

    if (Number(stopLimitStr) >= Number(stopStr)) {
      stopLimitStr = formatPriceToTick(Number(stopStr) - tick, tickSize, "down");
    }
    if (Number(priceStr) <= ref || Number(stopStr) >= ref || Number(stopLimitStr) >= Number(stopStr)) return null;
    return { price: priceStr, stopPrice: stopStr, stopLimitPrice: stopLimitStr };
  }

  function formatQty(qty, stepSize) {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return null;
    const step = Number(stepSize || 0);
    if (!Number.isFinite(step) || step <= 0) return null;
    const stepped = Math.floor(q / step) * step;
    if (stepped <= 0) return null;
    const prec = stepPrecision(stepSize);
    return stepped.toFixed(prec);
  }

  async function getOrLoadSymbolMeta(symbol) {
    const key = String(symbol || "").toUpperCase();
    const cached = symbolMeta.get(key);
    if (cached) return cached;

    // Public endpoint: no signature required.
    const { data } = await http.get("/api/v3/exchangeInfo", { params: { symbol: key } });
    const s = Array.isArray(data?.symbols) ? data.symbols[0] : null;
    const filters = Array.isArray(s?.filters) ? s.filters : [];
    const lot = filters.find((f) => f?.filterType === "LOT_SIZE") || null;
    const pf = filters.find((f) => f?.filterType === "PRICE_FILTER") || null;

    const stepSize = lot?.stepSize;
    const minQty = lot?.minQty;
    if (!stepSize || !minQty) throw new Error("exchangeinfo_missing_lot_size");

    const tickSize = pf?.tickSize || "0.01";
    const mn = extractMinNotionalFromFilters(filters);
    const meta = {
      stepSize: String(stepSize),
      minQty: Number(minQty),
      tickSize: String(tickSize),
      minNotional: mn != null && Number.isFinite(mn) && mn > 0 ? mn : 5,
      quoteAsset: String(s?.quoteAsset || "USDT"),
    };
    symbolMeta.set(key, meta);
    return meta;
  }

  function closeUdf() {
    try {
      if (udf.keepAliveTimer) clearInterval(udf.keepAliveTimer);
    } catch {
      // ignore
    }
    udf.keepAliveTimer = null;
    try {
      if (udf.udfRetryTimer) clearTimeout(udf.udfRetryTimer);
    } catch {
      // ignore
    }
    udf.udfRetryTimer = null;
    try {
      udf.ws?.terminate?.();
    } catch {
      // ignore
    }
    udf.ws = null;
    udf.listenKey = null;
    udf.listenKeyRestBase = null;
    udf.status = {
      ok: false,
      lastMsgAt: udf.status.lastMsgAt,
      error: udf.status.error,
      syncMode: "polling",
      listenKeyRestBase: null,
    };
  }

  function scheduleUdfRetry(delayMs) {
    if (udf.udfRetryTimer) return;
    udf.udfRetryTimer = setTimeout(() => {
      udf.udfRetryTimer = null;
      openUdf().catch(() => {});
    }, delayMs);
  }

  async function openUdf() {
    if (!apiKey) return;
    try {
      const lk = await createListenKey();
      if (!lk) throw new Error("no_listen_key");
      udf.listenKey = lk;
      const url = `${wsBase}/${lk}`;
      const ws = new WebSocket(url);
      udf.ws = ws;

      ws.on("open", () => {
        udf.status = {
          ok: true,
          lastMsgAt: Date.now(),
          error: null,
          syncMode: "websocket",
          listenKeyRestBase: udf.listenKeyRestBase,
        };
        log.info("binance_testnet_udf_open", { listenKeyRestBase: udf.listenKeyRestBase });
      });

      ws.on("message", (raw) => {
        udf.status = { ...udf.status, lastMsgAt: Date.now() };
        try {
          const msg = JSON.parse(String(raw));
          const et = msg?.e;

          if (et === "executionReport") {
            // order update
            const symbol = msg?.s;
            const side = msg?.S;
            const status = msg?.X; // FILLED, CANCELED...
            const orderId = String(msg?.i);
            const avgPrice = Number(msg?.L || 0) || Number(msg?.ap || 0) || null;
            const filledQty = Number(msg?.z || 0);

            // If a SELL order fills, it could be OCO leg. Find matching position by symbol + qty.
            if (side === "SELL" && status === "FILLED") {
              for (const [pid, p] of mem.positions.entries()) {
                if (p.symbol !== symbol) continue;
                if (Math.abs(Number(p.qty) - filledQty) > 1e-9) continue;
                const pSnapshot = { ...p };
                const oid = String(msg?.i || orderId || "");
                (async () => {
                  let exitByAsset = {};
                  let exitFeeUsd = null;
                  if (oid) {
                    try {
                      const od = await signed("GET", "/api/v3/order", { symbol, orderId: oid });
                      exitByAsset = sumCommissionsByAssetFromFills(od.fills);
                      exitFeeUsd = await commissionsByAssetToUsdApprox(exitByAsset, usdtPriceForAsset, log);
                    } catch (fe) {
                      log.warn("binance_testnet_ws_exit_order_fetch", { symbol, orderId: oid, error: String(fe) });
                    }
                  }
                  const exitPrice =
                    avgPrice || Number(msg?.p || 0) || Number(pSnapshot.takeProfit) || Number(pSnapshot.stopLoss);
                  const { grossPnl, pnl, fee } = spotRoundTripPnlWithFees(
                    pSnapshot,
                    exitPrice,
                    pSnapshot.qty,
                    exitFeeUsd,
                  );
                  mem.trades.push({
                    id: pid,
                    ts: new Date().toISOString(),
                    symbol,
                    side: "SELL",
                    qty: Number(pSnapshot.qty),
                    price: Number(exitPrice),
                    type: "CLOSE",
                    reason: "EXECUTION_REPORT",
                    pnl,
                    grossPnl,
                    fee: fee ?? undefined,
                    strategy: pSnapshot.strategy,
                    meta: {
                      ...(pSnapshot.meta || {}),
                      spotCommissionsByAsset: mergeByAsset(pSnapshot.spotEntryCommissionByAsset || {}, exitByAsset),
                      spotExitFeeUsd: exitFeeUsd,
                    },
                    exitOrderId: oid,
                  });
                  mem.positions.delete(pid);
                  log.info("binance_testnet_position_closed_ws", { id: pid, symbol, pnl });
                  persist();
                })();
                break;
              }
            }
          }
        } catch {
          // ignore
        }
      });

      ws.on("error", (err) => {
        udf.status = {
          ...udf.status,
          ok: false,
          lastMsgAt: udf.status.lastMsgAt,
          error: String(err?.message || err),
          syncMode: "polling",
        };
        log.warn("binance_testnet_udf_error", { error: udf.status.error });
      });

      ws.on("close", () => {
        udf.status = {
          ...udf.status,
          ok: false,
          lastMsgAt: udf.status.lastMsgAt,
          syncMode: "polling",
        };
        log.warn("binance_testnet_udf_close", {});
        closeUdf();
        scheduleUdfRetry(3000);
      });

      // Keepalive every 30 minutes (Binance requirement); we use 25m.
      udf.keepAliveTimer = setInterval(() => {
        if (!udf.listenKey) return;
        keepAliveListenKey(udf.listenKey).catch((e) => {
          udf.status = {
            ...udf.status,
            ok: false,
            lastMsgAt: udf.status.lastMsgAt,
            error: String(e?.message || e),
            syncMode: "polling",
          };
        });
      }, 25 * 60_000);
    } catch (e) {
      udf.status = {
        ok: false,
        lastMsgAt: udf.status.lastMsgAt,
        error: String(e?.message || e),
        syncMode: "polling",
        listenKeyRestBase: udf.listenKeyRestBase,
      };
      log.warn("binance_testnet_udf_init_failed", { error: udf.status.error });
      closeUdf();
      scheduleUdfRetry(Number(process.env.BINANCE_TESTNET_UDF_RETRY_MS || 15_000));
    }
  }

  function persist() {
    try {
      store.saveSnapshot({
        trades: mem.trades.slice(-500),
        positions: Array.from(mem.positions.values()),
      });
    } catch (e) {
      log.warn("binance_testnet_persist_failed", { error: String(e?.message || e) });
    }
  }

  // load snapshot (best-effort)
  const snap = store.loadSnapshot();
  if (snap) {
    if (Array.isArray(snap.trades)) mem.trades = snap.trades;
    if (Array.isArray(snap.positions)) {
      for (const p of snap.positions) mem.positions.set(p.id, p);
    }
    log.info("binance_testnet_loaded_snapshot", { snapshotPath: store.snapshotPath, positions: mem.positions.size });
  }

  return {
    name: "binance_testnet_spot",
    supportsAutoTrading: true,
    storeInfo: { baseURL, wsBase, dir: store.dir, snapshotPath: store.snapshotPath },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_testnet_missing_keys");
      const a = await signed("GET", "/api/v3/account");
      const balances = (a.balances || [])
        .map((b) => ({
          asset: b.asset,
          free: Number(b.free),
          locked: Number(b.locked),
          total: Number(b.free) + Number(b.locked),
        }))
        .filter((b) => b.total > 0);

      let equity = 0;
      const nonUsdt = [];
      for (const b of balances) {
        if (b.asset === "USDT") {
          equity += b.total;
        } else {
          nonUsdt.push(b);
        }
      }

      if (nonUsdt.length > 0) {
        try {
          // Testnet may not have ticker, fall back to production prices
          let tickers;
          try {
            const resp = await http.get("/api/v3/ticker/price");
            tickers = resp.data;
          } catch {
            const resp = await axios.get("https://api.binance.com/api/v3/ticker/price");
            tickers = resp.data;
          }
          const priceMap = new Map();
          for (const t of Array.isArray(tickers) ? tickers : []) {
            priceMap.set(t.symbol, Number(t.price));
          }
          for (const b of nonUsdt) {
            const px = priceMap.get(b.asset + "USDT") || 0;
            equity += b.total * px;
          }
        } catch {
          for (const pos of mem.positions.values()) {
            equity += Number(pos.qty || 0) * Number(pos.entryPrice || 0);
          }
        }
      }

      const usdtBal = balances.find((b) => b.asset === "USDT");
      const freeUsdt = usdtBal ? usdtBal.free : 0;
      const lockedUsdt = usdtBal ? usdtBal.locked : 0;
      return {
        equity,
        freeBalance: freeUsdt,
        spotUsdt: { free: freeUsdt, locked: lockedUsdt, total: freeUsdt + lockedUsdt },
        dailyStartEquity: null,
        dailyPnlPct: 0,
        balances,
      };
    },
    async getPositions() {
      return Array.from(mem.positions.values()).map((p) => ({ ...p }));
    },
    async getTrades() {
      return mem.trades.slice(-200);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) {
        throw new Error("binance_testnet_missing_keys");
      }
      // Safety checks
      const estNotional = Math.abs(Number(qty) * Number(price || 0));
      if (Number.isFinite(estNotional) && estNotional > maxNotional) {
        throw new Error(`max_order_notional_exceeded:${estNotional.toFixed(2)}>${maxNotional}`);
      }
      if (mem.openOrders >= maxOpenOrders) throw new Error("max_open_orders_exceeded");

      if (side !== "BUY") {
        // Spot short selling is not supported in this build.
        throw new Error("spot_sell_not_supported");
      }

      const metaInfo = await getOrLoadSymbolMeta(symbol);
      const qtyStr = formatQty(qty, metaInfo.stepSize);
      if (!qtyStr) throw new Error("invalid_qty");

      const stopLossPx = Number(stopLoss);
      const takeProfitPx = Number(takeProfit);
      if (!stopLossPx || !takeProfitPx) throw new Error("stoploss_takeprofit_required");

      // Market BUY + attached OCO. Track openOrders defensively so failed requests don't "leak" slots.
      mem.openOrders += 1;
      let out = null;
      let oco = null;
      let ocoPx = null;
      try {
        out = await signed("POST", "/api/v3/order", {
          symbol,
          side,
          type: "MARKET",
          quantity: qtyStr,
          newClientOrderId: `ai_${Date.now()}`,
        });

        const filledPx = avgFillPrice(out) ?? Number(price || 0);
        const refPx = Number.isFinite(filledPx) && filledPx > 0 ? filledPx : Number(price || 0);
        ocoPx = ocoSellPrices({
          refPx,
          takeProfitPx,
          stopLossPx,
          tickSize: metaInfo.tickSize || "0.01",
        });
        if (!ocoPx) throw new Error("oco_prices_invalid");

        try {
          oco = await signed("POST", "/api/v3/order/oco", {
            symbol,
            side: "SELL",
            quantity: qtyStr,
            price: ocoPx.price,
            stopPrice: ocoPx.stopPrice,
            stopLimitPrice: ocoPx.stopLimitPrice,
            stopLimitTimeInForce: "GTC",
          });
        } catch (e) {
          log.warn("binance_testnet_oco_failed_flatten", { symbol, error: String(e?.message || e) });
          await signed("POST", "/api/v3/order", {
            symbol,
            side: "SELL",
            type: "MARKET",
            quantity: qtyStr,
            newClientOrderId: `flatten_${Date.now()}`,
          });
          throw e;
        }
      } finally {
        mem.openOrders = Math.max(0, mem.openOrders - 1);
      }

      const filledPrice = avgFillPrice(out) ?? Number(price || 0);
      const entryByAsset = sumCommissionsByAssetFromFills(out.fills);
      const entryFeeUsd = await commissionsByAssetToUsdApprox(entryByAsset, usdtPriceForAsset, log);
      const posId = `bn_${String(out.orderId)}`;
      mem.positions.set(posId, {
        id: posId,
        symbol,
        side: "BUY",
        qty: Number(qty),
        entryPrice: filledPrice,
        stopLoss: Number(ocoPx?.stopPrice || stopLossPx),
        takeProfit: Number(ocoPx?.price || takeProfitPx),
        openedAt: new Date().toISOString(),
        strategy,
        meta: meta || {},
        entryOrderId: String(out.orderId),
        ocoOrderListId: oco?.orderListId ?? null,
        spotEntryCommissionByAsset: entryByAsset,
        spotEntryFeeUsd: entryFeeUsd,
      });

      mem.trades.push({
        // Keep trade id consistent with positions id so UI can correlate OPEN rows to open positions.
        id: posId,
        ts: new Date().toISOString(),
        symbol,
        side,
        qty: Number(qty),
        price: filledPrice,
        type: "OPEN",
        strategy,
        fee: entryFeeUsd != null ? roundTo(entryFeeUsd, 6) : undefined,
        meta: {
          ...(meta || {}),
          spotCommissionsByAsset: entryByAsset,
          spotEntryFeeUsd: entryFeeUsd,
        },
        ocoOrderListId: oco?.orderListId ?? null,
      });

      log.info("binance_testnet_order", { orderId: out.orderId, ocoOrderListId: oco?.orderListId, symbol, side, qty: Number(qty) });
      persist();
      return { id: posId, filledPrice };
    },
    async markToMarket() {
      // Ensure userDataStream is up (best-effort).
      if (!udf.ws && apiKey) openUdf().catch(() => {});

      // Poll OCO lists; if filled, emit CLOSE trade and remove position.
      const now = Date.now();
      if (mem.lastSyncAt && now - mem.lastSyncAt < 1500) return;
      mem.lastSyncAt = now;

      for (const [id, p] of mem.positions.entries()) {
        if (!p.ocoOrderListId) continue;
        try {
          const ol = await getOrderList(p.ocoOrderListId);
          const status = String(ol?.listStatusType || "");
          const orderStatus = String(ol?.listOrderStatus || "");
          const orders = Array.isArray(ol?.orders) ? ol.orders : [];
          const filled = orders.find((o) => String(o?.status) === "FILLED") || null;

          // When one leg fills, the other is canceled and listOrderStatus becomes ALL_DONE.
          if (orderStatus === "ALL_DONE" || status === "ALL_DONE" || filled) {
            const exitOrderId = filled ? String(filled.orderId) : null;
            let exitByAsset = {};
            let exitFeeUsd = null;
            // Best-effort exit price: query order if we have an id; otherwise use stop/tp levels.
            let exitPrice = null;
            if (exitOrderId) {
              const od = await signed("GET", "/api/v3/order", { symbol: p.symbol, orderId: exitOrderId });
              exitPrice = Number(od?.price || 0) || Number(od?.avgPrice || 0) || null;
              if (!exitPrice && Array.isArray(od?.fills) && od.fills.length) {
                exitPrice = avgFillPrice(od);
              }
              exitByAsset = sumCommissionsByAssetFromFills(od.fills);
              exitFeeUsd = await commissionsByAssetToUsdApprox(exitByAsset, usdtPriceForAsset, log);
            }
            if (!exitPrice) exitPrice = Number(p.takeProfit) || Number(p.stopLoss) || Number(p.entryPrice);

            const { grossPnl, pnl, fee } = spotRoundTripPnlWithFees(p, exitPrice, p.qty, exitFeeUsd);
            mem.trades.push({
              id,
              ts: new Date().toISOString(),
              symbol: p.symbol,
              side: "SELL",
              qty: Number(p.qty),
              price: Number(exitPrice),
              type: "CLOSE",
              reason: "OCO_FILLED",
              pnl,
              grossPnl,
              fee: fee ?? undefined,
              strategy: p.strategy,
              meta: {
                ...(p.meta || {}),
                spotCommissionsByAsset: mergeByAsset(p.spotEntryCommissionByAsset || {}, exitByAsset),
                spotExitFeeUsd: exitFeeUsd,
              },
            });
            mem.positions.delete(id);
            log.info("binance_testnet_position_closed", { id, symbol: p.symbol, pnl });
            persist();
          }
        } catch (e) {
          log.warn("binance_testnet_sync_failed", { id, error: String(e?.message || e) });
        }
      }
    },
    async closePosition() {
      return { ok: false, error: "not_supported" };
    },
    async reset() {
      return { ok: false, error: "not_supported" };
    },
    async getSymbolOrderConstraints(symbol) {
      const sym = String(symbol || "").toUpperCase();
      const m = await getOrLoadSymbolMeta(sym);
      return {
        ok: true,
        symbol: sym,
        venue: "SPOT",
        minNotional: m.minNotional ?? null,
        quoteAsset: m.quoteAsset || "USDT",
        rule: "Binance spot exchangeInfo: NOTIONAL / MIN_NOTIONAL minNotional (quote)",
      };
    },
    async close() {
      closeUdf();
    },
    getStatus() {
      return { udf: { ...udf.status, listenKey: Boolean(udf.listenKey) } };
    },
  };
}

