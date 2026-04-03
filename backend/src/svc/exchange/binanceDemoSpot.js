import crypto from "crypto";
import axios from "axios";
import WebSocket from "ws";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBinanceDemoSpotExchange({ log }) {
  const apiKey = process.env.BINANCE_DEMO_API_KEY || "";
  const apiSecret = process.env.BINANCE_DEMO_API_SECRET || "";
  const baseURL = process.env.BINANCE_DEMO_REST_BASE || "https://demo-api.binance.com/api";
  const allowAuto = String(process.env.BINANCE_DEMO_ALLOW_AUTO || "0") === "1";

  if (!apiKey || !apiSecret) {
    log.warn("binance_demo_missing_keys", {});
  }

  // Note: demo REST base already includes `/api` prefix in Binance docs.
  const http = axios.create({
    baseURL,
    timeout: 10_000,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  const wsBase = process.env.BINANCE_DEMO_WS_BASE || "wss://demo-stream.binance.com/ws";
  const symbolMeta = new Map(); // symbol -> { stepSize, minQty, tickSize }
  const udf = {
    listenKey: null,
    ws: null,
    keepAliveTimer: null,
    userStreamDisabled: false,
    status: { ok: false, lastMsgAt: null, error: null, syncMode: "polling" },
  };

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
      const msg = body?.msg || body?.message || e?.message || "binance_demo_request_failed";
      const code = body?.code;
      const err = new Error(`binance_demo_http_${method}_${path}:${status ?? "?"}:${code ?? "?"}:${msg}`);
      err.cause = e;
      throw err;
    }
  }

  function stepPrecision(stepSize) {
    const s = String(stepSize || "");
    const dot = s.indexOf(".");
    if (dot < 0) return 0;
    const frac = s.slice(dot + 1).replace(/0+$/, "");
    return frac.length;
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

  function formatPriceToTick(px, tickSize, mode) {
    const p = Number(px);
    const t = Number(tickSize || 0);
    if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return String(px);
    const stepped = mode === "up" ? Math.ceil(p / t - 1e-12) * t : Math.floor(p / t + 1e-12) * t;
    const prec = stepPrecision(String(tickSize));
    return stepped.toFixed(prec);
  }

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

  async function getOrLoadSymbolMeta(symbol) {
    const key = String(symbol || "").toUpperCase();
    const cached = symbolMeta.get(key);
    if (cached) return cached;
    // Demo Mode exchangeInfo is a public endpoint; do NOT send signed params (timestamp/signature)
    // or Binance returns -1104 (unread parameters).
    const { data: info } = await http.get("/v3/exchangeInfo", { params: { symbol: key } });
    const s = Array.isArray(info?.symbols) ? info.symbols[0] : null;
    const filters = Array.isArray(s?.filters) ? s.filters : [];
    const lot = filters.find((f) => f?.filterType === "LOT_SIZE") || null;
    const pf = filters.find((f) => f?.filterType === "PRICE_FILTER") || null;
    const stepSize = lot?.stepSize;
    const minQty = lot?.minQty;
    const tickSize = pf?.tickSize || "0.01";
    if (!stepSize || !minQty) throw new Error("demo_exchangeinfo_missing_filters");
    const meta = { stepSize: String(stepSize), minQty: Number(minQty), tickSize: String(tickSize) };
    symbolMeta.set(key, meta);
    return meta;
  }

  async function createListenKey() {
    try {
      const { data } = await http.post("/v3/userDataStream");
      return data?.listenKey;
    } catch (e) {
      const st = e?.response?.status;
      const msg = String(e?.response?.data?.msg || e?.message || "");
      if (st === 410 || st === 404 || /\b410\b|gone|deprecated/i.test(msg)) {
        const err = new Error("user_data_stream_unavailable");
        err.code = "UDF_UNSUPPORTED";
        err.status = st;
        throw err;
      }
      throw e;
    }
  }

  async function keepAliveListenKey(listenKey) {
    await http.put("/v3/userDataStream", null, { params: { listenKey } });
  }

  function closeUdf() {
    try {
      if (udf.keepAliveTimer) clearInterval(udf.keepAliveTimer);
    } catch {
      // ignore
    }
    udf.keepAliveTimer = null;
    try {
      udf.ws?.terminate?.();
    } catch {
      // ignore
    }
    udf.ws = null;
    udf.status = { ...udf.status, ok: false };
  }

  async function openUdf() {
    if (!apiKey || udf.userStreamDisabled) return;
    try {
      const lk = await createListenKey();
      if (!lk) throw new Error("no_listen_key");
      udf.listenKey = lk;
      const url = `${wsBase}/${lk}`;
      const ws = new WebSocket(url);
      udf.ws = ws;

      ws.on("open", () => {
        udf.status = { ok: true, lastMsgAt: Date.now(), error: null, syncMode: "websocket" };
        log.info("binance_demo_udf_open", {});
      });

      ws.on("message", () => {
        udf.status = { ...udf.status, lastMsgAt: Date.now() };
      });

      ws.on("error", (err) => {
        udf.status = { ...udf.status, ok: false, error: String(err?.message || err), syncMode: "polling" };
        log.warn("binance_demo_udf_error", { error: udf.status.error });
      });

      ws.on("close", () => {
        udf.status = { ...udf.status, ok: false, syncMode: "polling" };
        log.warn("binance_demo_udf_close", {});
        closeUdf();
        if (!udf.userStreamDisabled) {
          setTimeout(() => openUdf().catch(() => {}), 3000);
        }
      });

      udf.keepAliveTimer = setInterval(() => {
        if (!udf.listenKey) return;
        keepAliveListenKey(udf.listenKey).catch((e) => {
          udf.status = { ...udf.status, ok: false, error: String(e?.message || e), syncMode: "polling" };
        });
      }, 25 * 60_000);
    } catch (e) {
      if (e?.code === "UDF_UNSUPPORTED") {
        udf.userStreamDisabled = true;
        udf.status = {
          ok: false,
          lastMsgAt: udf.status?.lastMsgAt ?? null,
          error:
            "User-data stream unavailable on demo REST (HTTP 410). Orders sync via REST polling — this is normal on some demo edges.",
          syncMode: "polling",
        };
        log.info("binance_demo_udf_skipped", { status: e?.status, note: "rest_polling_only" });
        return;
      }
      udf.status = { ...udf.status, ok: false, error: String(e?.message || e), syncMode: "polling" };
      log.warn("binance_demo_udf_init_failed", { error: udf.status.error });
      closeUdf();
    }
  }

  const mem = { trades: [], positions: new Map(), lastSyncAt: null };

  async function getOrderList(orderListId) {
    return signed("GET", "/v3/orderList", { orderListId: String(orderListId) });
  }

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

  return {
    name: "binance_demo_spot",
    // Off by default so you can verify demo UI + fills first.
    supportsAutoTrading: allowAuto,
    storeInfo: { baseURL, wsBase },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_demo_missing_keys");
      const a = await signed("GET", "/v3/account");
      const balances = (a.balances || [])
        .map((b) => ({ asset: b.asset, total: Number(b.free) + Number(b.locked) }))
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

      // Value non-USDT assets at current market price
      if (nonUsdt.length > 0) {
        try {
          const { data: tickers } = await http.get("/v3/ticker/price");
          const priceMap = new Map();
          for (const t of Array.isArray(tickers) ? tickers : []) {
            priceMap.set(t.symbol, Number(t.price));
          }
          for (const b of nonUsdt) {
            const px = priceMap.get(b.asset + "USDT") || 0;
            equity += b.total * px;
          }
        } catch {
          // If ticker fetch fails, just count positions from memory
          for (const pos of mem.positions.values()) {
            const px = Number(pos.entryPrice || 0);
            equity += Number(pos.qty || 0) * px;
          }
        }
      }

      const usdtBal = balances.find((b) => b.asset === "USDT");
      const freeUsdt = usdtBal ? usdtBal.total : 0;
      return { equity, freeBalance: freeUsdt, dailyStartEquity: null, dailyPnlPct: 0, balances };
    },
    async getPositions() {
      return Array.from(mem.positions.values()).map((p) => ({ ...p }));
    },
    async getTrades() {
      return mem.trades.slice(-200);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) throw new Error("binance_demo_missing_keys");
      if (side !== "BUY") throw new Error("spot_sell_not_supported");
      if (!stopLoss || !takeProfit) throw new Error("stoploss_takeprofit_required");

      const metaInfo = await getOrLoadSymbolMeta(symbol);
      const pxRef = Number(price);
      const baseQty = Number(qty);
      if (!Number.isFinite(baseQty) || baseQty <= 0) throw new Error("invalid_qty");
      if (!Number.isFinite(pxRef) || pxRef <= 0) throw new Error("invalid_price_for_quote");

      // MARKET BUY: prefer quoteOrderQty (USDT spent). Base `quantity` often hits MARKET_LOT_SIZE on demo/mainnet
      // when step rounding interacts with filters; quote spend is what Binance documents for BUY.
      const quoteUsd = baseQty * pxRef;
      if (quoteUsd < 5.5) throw new Error(`below_min_notional: quote ~${quoteUsd.toFixed(2)} USDT — need ≥ ~5.5 USDT on spot`);
      const quoteStr = quoteUsd.toFixed(2);

      const out = await signed("POST", "/v3/order", {
        symbol,
        side,
        type: "MARKET",
        quoteOrderQty: quoteStr,
        newClientOrderId: `demo_${Date.now()}`,
      });
      const filledPrice = avgFillPrice(out) ?? Number(price || 0);
      const executedQty = Number(out?.executedQty || 0);
      if (!Number.isFinite(executedQty) || executedQty <= 0) throw new Error("market_buy_zero_fill");
      const ocoQtyStr = formatQty(executedQty, metaInfo.stepSize);
      if (!ocoQtyStr) throw new Error("invalid_executed_qty_for_oco");

      const refPx = Number.isFinite(Number(filledPrice)) && Number(filledPrice) > 0 ? Number(filledPrice) : Number(price || 0);
      const ocoPx = ocoSellPrices({ refPx, takeProfitPx: takeProfit, stopLossPx: stopLoss, tickSize: metaInfo.tickSize });
      if (!ocoPx) throw new Error("oco_prices_invalid");

      // OCO SELL for TP/SL (strict safety: if OCO fails, flatten immediately)
      let oco = null;
      try {
        oco = await signed("POST", "/v3/order/oco", {
          symbol,
          side: "SELL",
          quantity: ocoQtyStr,
          price: ocoPx.price,
          stopPrice: ocoPx.stopPrice,
          stopLimitPrice: ocoPx.stopLimitPrice,
          stopLimitTimeInForce: "GTC",
        });
      } catch (e) {
        log.warn("binance_demo_oco_failed_flatten", { symbol, error: String(e?.message || e) });
        await signed("POST", "/v3/order", {
          symbol,
          side: "SELL",
          type: "MARKET",
          quantity: ocoQtyStr,
          newClientOrderId: `flatten_${Date.now()}`,
        });
        throw e;
      }

      const posId = `demo_${String(out.orderId)}`;
      mem.positions.set(posId, {
        id: posId,
        symbol,
        side: "BUY",
        qty: Number(ocoQtyStr),
        entryPrice: filledPrice,
        stopLoss: Number(ocoPx.stopPrice),
        takeProfit: Number(ocoPx.price),
        openedAt: new Date().toISOString(),
        strategy,
        meta: meta || {},
        entryOrderId: String(out.orderId),
        ocoOrderListId: oco?.orderListId ?? null,
      });

      mem.trades.push({
        // Keep trade id consistent with positions id so UI can correlate OPEN rows to open positions.
        id: posId,
        ts: new Date().toISOString(),
        symbol,
        side,
        qty: Number(ocoQtyStr),
        price: filledPrice,
        type: "OPEN",
        strategy,
        meta: meta || {},
        ocoOrderListId: oco?.orderListId ?? null,
      });

      return { id: posId, filledPrice };
    },
    async markToMarket() {
      if (!udf.ws && apiKey) openUdf().catch(() => {});
      const now = Date.now();
      if (mem.lastSyncAt && now - mem.lastSyncAt < 1500) return;
      mem.lastSyncAt = now;

      for (const [id, p] of mem.positions.entries()) {
        if (!p.ocoOrderListId) continue;
        try {
          const ol = await getOrderList(p.ocoOrderListId);
          const orderStatus = String(ol?.listOrderStatus || "");
          const orders = Array.isArray(ol?.orders) ? ol.orders : [];
          const filled = orders.find((o) => String(o?.status) === "FILLED") || null;
          if (orderStatus === "ALL_DONE" || filled) {
            // Determine actual exit price from the filled leg
            let exitPrice = Number(p.entryPrice);
            if (filled) {
              try {
                const detail = await signed("GET", "/v3/order", { symbol: p.symbol, orderId: String(filled.orderId) });
                const avgPx = Number(detail?.price || detail?.cummulativeQuoteQty / detail?.executedQty || 0);
                if (avgPx > 0) exitPrice = avgPx;
              } catch {
                // Fallback: TP if LIMIT_MAKER filled, else SL
                const isLimit = String(filled.type || "").includes("LIMIT");
                exitPrice = isLimit ? (Number(p.takeProfit) || Number(p.stopLoss)) : (Number(p.stopLoss) || Number(p.takeProfit));
              }
            } else {
              exitPrice = Number(p.takeProfit) || Number(p.stopLoss) || Number(p.entryPrice);
            }
            const pnl = (Number(exitPrice) - Number(p.entryPrice)) * Number(p.qty);
            mem.trades.push({
              id,
              ts: new Date().toISOString(),
              symbol: p.symbol,
              side: "SELL",
              qty: Number(p.qty),
              price: Number(exitPrice),
              type: "CLOSE",
              reason: "OCO_DONE",
              pnl,
              strategy: p.strategy,
              meta: p.meta || {},
            });
            mem.positions.delete(id);
          }
        } catch (e) {
          log.warn("binance_demo_sync_failed", { id, error: String(e?.message || e) });
        }
      }
    },
    async closePosition() {
      return { ok: false, error: "not_supported" };
    },
    async reset() {
      return { ok: false, error: "not_supported" };
    },
    async close() {
      closeUdf();
    },
    getStatus() {
      return {
        udf: {
          ...udf.status,
          listenKey: Boolean(udf.listenKey),
          userStreamDisabled: Boolean(udf.userStreamDisabled),
          restOnly: Boolean(udf.userStreamDisabled),
        },
      };
    },
  };
}

