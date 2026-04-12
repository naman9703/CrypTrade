import crypto from "crypto";
import axios from "axios";
import WebSocket from "ws";
import { roundTo } from "../../lib/math.js";
import {
  sumCommissionsByAssetFromFills,
  commissionsByAssetToUsdApprox,
  mergeByAsset,
  createUsdtTicker,
  spotRoundTripPnlWithFees,
} from "../../lib/binanceSpotCommissions.js";
import { extractMinNotionalFromFilters } from "../../lib/binanceMinNotional.js";
import { buildSpotOcoSellPrices, reanchorSpotLongSlTpToFill } from "../../lib/binanceSpotOco.js";

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

  const usdtPriceForAsset = createUsdtTicker({ http, path: "/v3/ticker/price", log });

  const wsBase = process.env.BINANCE_DEMO_WS_BASE || "wss://demo-stream.binance.com/ws";
  const symbolMeta = new Map(); // symbol -> { stepSize, minQty, tickSize }
  const udf = {
    listenKey: null,
    ws: null,
    keepAliveTimer: null,
    userStreamDisabled: false,
    status: { ok: false, lastMsgAt: null, error: null, syncMode: "polling" },
  };

  /** Binance spot MARKET BUY `quoteOrderQty` minimum (USDT); demo and mainnet use similar floors. */
  function minSpotQuoteUsdt() {
    return Number(process.env.BINANCE_SPOT_MIN_QUOTE_USDT ?? 5.5);
  }

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

  /** Base asset for common *USDT / *USDC spot symbols (wallet balance lookup after OCO cancel). */
  function spotBaseAssetFromSymbol(sym) {
    const s = String(sym || "").toUpperCase();
    const quotes = ["USDT", "USDC", "BUSD", "TUSD", "FDUSD", "EUR", "TRY", "BRL", "BTC", "ETH"];
    for (const q of quotes) {
      if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
    }
    return null;
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

  async function getSpotFreeBalance(asset) {
    const a = await signed("GET", "/v3/account");
    const row = (a.balances || []).find((b) => String(b.asset).toUpperCase() === String(asset).toUpperCase());
    return row ? Number(row.free) : 0;
  }

  /** Quote asset for the pair (e.g. BTCUSDT → USDT) — used to cap MARKET BUY `quoteOrderQty` to wallet. */
  function spotQuoteAssetFromPairSymbol(sym) {
    const s = String(sym || "").toUpperCase();
    const quotes = ["USDT", "USDC", "BUSD", "TUSD", "FDUSD", "EUR", "TRY", "BRL", "BTC", "ETH"];
    for (const q of quotes) {
      if (s.endsWith(q) && s.length > q.length) return q;
    }
    return "USDT";
  }

  /**
   * Cap requested quote spend to what the wallet can actually pay (avoids -2010 when `qty*px` or
   * `spendQuoteUsdt` rounds to slightly more than free quote, or fees leave no headroom).
   * `BINANCE_SPOT_QUOTE_RESERVE_PCT` default 0.002 (=0.2%) kept unspent for fee / filter slack.
   */
  function capQuoteToSpendableWallet(requestedQuote, freeQuote, symbolForLog) {
    const req = Number(requestedQuote);
    const free = Number(freeQuote);
    if (!Number.isFinite(req) || req <= 0) return req;
    if (!Number.isFinite(free) || free <= 0) return req;
    const reservePct = Math.min(0.05, Math.max(0, Number(process.env.BINANCE_SPOT_QUOTE_RESERVE_PCT ?? 0.002)));
    const maxSpend = free * (1 - reservePct);
    const capped = Math.min(req, Math.floor(maxSpend * 100) / 100);
    if (capped + 1e-9 < req) {
      log.info("binance_demo_quote_capped_to_wallet", {
        symbol: symbolForLog,
        requestedQuote: req,
        cappedQuote: capped,
        freeQuote: free,
        reservePct,
      });
    }
    return capped;
  }

  /** Cancel bracket OCO, then MARKET SELL (qty from wallet if `meta.indicatorFullCapital`, else min(qtyHint, free)). */
  async function flattenSpotLongForExit(pos, posId, priceHint, qtyHint, meta, strategyKey) {
    const symbol = pos.symbol;
    const metaInfo = await getOrLoadSymbolMeta(symbol);
    if (pos.ocoOrderListId) {
      try {
        await signed("DELETE", "/v3/orderList", {
          symbol,
          orderListId: String(pos.ocoOrderListId),
        });
      } catch (e) {
        log.warn("binance_demo_cancel_oco_before_exit", { symbol, error: String(e?.message || e) });
      }
    }
    const baseAsset = spotBaseAssetFromSymbol(symbol);
    if (!baseAsset) throw new Error("demo_spot_unknown_base_asset");
    const free = await getSpotFreeBalance(baseAsset);
    if (!Number.isFinite(free) || free <= 0) throw new Error("no_free_base_after_oco");

    let sellFrom = Number(qtyHint);
    if (!Number.isFinite(sellFrom) || sellFrom <= 0) throw new Error("invalid_qty");
    if (meta?.indicatorFullCapital) sellFrom = free;
    else sellFrom = Math.min(sellFrom, free);

    const qtyStr = formatQty(sellFrom, metaInfo.stepSize);
    if (!qtyStr) throw new Error("invalid_qty_step");

    const out = await signed("POST", "/v3/order", {
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qtyStr,
      newClientOrderId: `demo_exit_${Date.now()}`,
    });
    const filledPrice = avgFillPrice(out) ?? Number(priceHint || pos.entryPrice || 0);
    const exitPx = Number(filledPrice);
    const soldQty = Number(out?.executedQty || qtyStr);
    const exitByAsset = sumCommissionsByAssetFromFills(out.fills);
    const exitFeeUsd = await commissionsByAssetToUsdApprox(exitByAsset, usdtPriceForAsset, log);
    const { grossPnl, pnl, fee } = spotRoundTripPnlWithFees(pos, exitPx, soldQty, exitFeeUsd);
    const reason =
      meta?.supertrend === true ? "SUPERTREND_EXIT" : meta?.manualClose === true ? "MANUAL_CLOSE" : "MARKET_SELL";
    mem.trades.push({
      id: posId,
      ts: new Date().toISOString(),
      symbol,
      side: "SELL",
      qty: soldQty,
      price: exitPx,
      type: "CLOSE",
      reason,
      pnl,
      grossPnl,
      fee: fee ?? undefined,
      strategy: strategyKey ?? pos.strategy,
      meta: {
        ...(pos.meta || {}),
        ...(meta || {}),
        spotCommissionsByAsset: mergeByAsset(pos.spotEntryCommissionByAsset || {}, exitByAsset),
        spotExitFeeUsd: exitFeeUsd,
      },
    });
    mem.positions.delete(posId);
    log.info("binance_demo_spot_exit_sell", { posId, symbol, qty: qtyStr, soldQty, exitPx, reason });
    return { id: posId, filledPrice: exitPx, pnl };
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
      /** Spendable USDT for MARKET BUY (`quoteOrderQty`); excludes locked margin/orders. */
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
      if (!apiKey || !apiSecret) throw new Error("binance_demo_missing_keys");

      /** Flatten an in-app tracked long: first matching BUY for symbol (Supertrend — use distinct closes via closePosition). */
      if (side === "SELL") {
        const baseQtyHint = Number(qty);
        if (!Number.isFinite(baseQtyHint) || baseQtyHint <= 0) throw new Error("invalid_qty");

        let posId = null;
        let pos = null;
        for (const [id, p] of mem.positions.entries()) {
          if (String(p.symbol).toUpperCase() === String(symbol).toUpperCase() && String(p.side).toUpperCase() === "BUY") {
            posId = id;
            pos = p;
            break;
          }
        }
        if (!pos || !posId) throw new Error("no_spot_long_to_close");

        return await flattenSpotLongForExit(pos, posId, price, baseQtyHint, meta, strategy);
      }

      if (side !== "BUY") throw new Error("spot_sell_not_supported");
      if (!stopLoss || !takeProfit) throw new Error("stoploss_takeprofit_required");

      const metaInfo = await getOrLoadSymbolMeta(symbol);
      const pxRef = Number(price);
      const baseQty = Number(qty);
      if (!Number.isFinite(baseQty) || baseQty <= 0) throw new Error("invalid_qty");
      if (!Number.isFinite(pxRef) || pxRef <= 0) throw new Error("invalid_price_for_quote");

      // MARKET BUY: prefer quoteOrderQty (USDT spent). Full-capital path passes `spendQuoteUsdt` so we spend ≈all
      // free quote without losing size to qty*price rounding. Floor to 2 dp to reduce "insufficient balance" rejects.
      let quoteUsd;
      const spendIn = Number(meta?.spendQuoteUsdt);
      if (Number.isFinite(spendIn) && spendIn > 0 && meta?.indicatorFullCapital) {
        quoteUsd = Math.floor(spendIn * 100) / 100;
      } else {
        quoteUsd = baseQty * pxRef;
      }
      const minQ = minSpotQuoteUsdt();
      const quoteAsset = spotQuoteAssetFromPairSymbol(symbol);
      const freeQuote = await getSpotFreeBalance(quoteAsset);
      const quoteBeforeCap = quoteUsd;
      quoteUsd = capQuoteToSpendableWallet(quoteUsd, freeQuote, symbol);
      if (quoteUsd < minQ) {
        throw new Error(
          `below_min_notional: quote ~${quoteUsd.toFixed(2)} ${quoteAsset} after wallet cap (requested ~${quoteBeforeCap.toFixed(2)}, free ~${freeQuote.toFixed(2)}) — need ≥ ~${minQ} spendable on spot`,
        );
      }
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
      const entryByAsset = sumCommissionsByAssetFromFills(out.fills);
      const entryFeeUsd = await commissionsByAssetToUsdApprox(entryByAsset, usdtPriceForAsset, log);

      const baseAsset = spotBaseAssetFromSymbol(symbol);
      if (!baseAsset) throw new Error("demo_spot_unknown_base_asset");
      const baseFreeForOco = await getSpotFreeBalance(baseAsset);
      const ocoQtyRaw = Math.min(executedQty, baseFreeForOco);
      if (!(ocoQtyRaw > 0)) throw new Error("oco_qty_zero_after_buy");
      const ocoQtyStr = formatQty(ocoQtyRaw, metaInfo.stepSize);
      if (!ocoQtyStr) throw new Error("invalid_executed_qty_for_oco");

      const refPx = Number.isFinite(Number(filledPrice)) && Number(filledPrice) > 0 ? Number(filledPrice) : Number(price || 0);
      const anchorPx = Number.isFinite(pxRef) && pxRef > 0 ? pxRef : refPx;
      const { stopLoss: slAnchored, takeProfit: tpAnchored } = reanchorSpotLongSlTpToFill({
        anchorPx,
        filledPx: refPx,
        stopLossPx: stopLoss,
        takeProfitPx: takeProfit,
      });
      const ocoPx = buildSpotOcoSellPrices({
        refPx,
        takeProfitPx: tpAnchored,
        stopLossPx: slAnchored,
        tickSize: metaInfo.tickSize,
      });
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
        let flattenThrown = null;
        try {
          const baseAvail = await getSpotFreeBalance(baseAsset);
          const flatStr = formatQty(baseAvail, metaInfo.stepSize);
          if (flatStr) {
            await signed("POST", "/v3/order", {
              symbol,
              side: "SELL",
              type: "MARKET",
              quantity: flatStr,
              newClientOrderId: `flatten_${Date.now()}`,
            });
          }
        } catch (fe) {
          flattenThrown = fe;
          log.warn("binance_demo_emergency_flatten_failed", { symbol, error: String(fe?.message || fe) });
        }
        const ocoMsg = String(e?.message || e);
        if (flattenThrown) {
          throw new Error(
            `spot_bracket_failed_and_flatten_failed: oco=${ocoMsg}; emergency_sell=${String(flattenThrown?.message || flattenThrown)} — check Binance for an open base balance.`,
          );
        }
        throw new Error(
          `spot_bracket_failed_market_buy_had_filled_then_emergency_market_sold: ${ocoMsg} — Orders: check Binance history; app did not keep a bracketed position.`,
        );
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
        spotEntryCommissionByAsset: entryByAsset,
        spotEntryFeeUsd: entryFeeUsd,
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
        fee: entryFeeUsd != null ? roundTo(entryFeeUsd, 6) : undefined,
        meta: {
          ...(meta || {}),
          spotCommissionsByAsset: entryByAsset,
          spotEntryFeeUsd: entryFeeUsd,
        },
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
            let exitByAsset = {};
            let exitFeeUsd = null;
            if (filled?.orderId) {
              try {
                const detail = await signed("GET", "/v3/order", {
                  symbol: p.symbol,
                  orderId: String(filled.orderId),
                });
                exitByAsset = sumCommissionsByAssetFromFills(detail.fills);
                exitFeeUsd = await commissionsByAssetToUsdApprox(exitByAsset, usdtPriceForAsset, log);
              } catch (fe) {
                log.warn("binance_demo_oco_exit_fills_fetch", { id, error: String(fe?.message || fe) });
              }
            }
            const { grossPnl, pnl, fee } = spotRoundTripPnlWithFees(p, exitPrice, p.qty, exitFeeUsd);
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
          }
        } catch (e) {
          log.warn("binance_demo_sync_failed", { id, error: String(e?.message || e) });
        }
      }
    },
    async closePosition({ id, price } = {}) {
      if (!apiKey || !apiSecret) return { ok: false, error: "binance_demo_missing_keys" };
      const posId = String(id || "");
      const pos = mem.positions.get(posId);
      if (!pos) return { ok: false, error: "not_found" };
      if (String(pos.side).toUpperCase() !== "BUY") {
        return { ok: false, error: "only_spot_long_supported" };
      }
      try {
        const px = Number(price);
        const out = await flattenSpotLongForExit(
          pos,
          posId,
          Number.isFinite(px) ? px : pos.entryPrice,
          Number(pos.qty),
          { indicatorFullCapital: true, manualClose: true },
          pos.strategy,
        );
        return { ok: true, pnl: out.pnl, id: out.id };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
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

