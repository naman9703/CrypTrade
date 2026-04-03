import crypto from "crypto";
import axios from "axios";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBinanceFuturesTestnetUsdMExchange({ log }) {
  const apiKey = process.env.BINANCE_FUTURES_API_KEY || "";
  const apiSecret = process.env.BINANCE_FUTURES_API_SECRET || "";
  const baseURL = process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com";
  const defaultLeverage = Math.max(1, Math.min(50, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5)));

  const http = axios.create({
    baseURL,
    timeout: 10_000,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  async function signed(method, path, params = {}) {
    const ts = Date.now();
    const qp = new URLSearchParams({ ...params, timestamp: String(ts) });
    const sig = hmacSha256(apiSecret, qp.toString());
    qp.set("signature", sig);
    const url = `${path}?${qp.toString()}`;
    const { data } = await http.request({ method, url });
    return data;
  }

  async function publicGet(path, params = {}) {
    const qp = new URLSearchParams({ ...params });
    const url = qp.toString() ? `${path}?${qp.toString()}` : path;
    const { data } = await http.request({ method: "GET", url, headers: {} });
    return data;
  }

  const metaCache = new Map();
  let exchangeInfoCache = null;
  let exchangeInfoCacheTs = 0;
  const EXCHANGE_INFO_TTL_MS = 30 * 60 * 1000;

  async function getOrLoadSymbolMeta(symbol) {
    const key = String(symbol || "").toUpperCase();
    if (metaCache.has(key)) return metaCache.get(key);
    const now = Date.now();
    if (!exchangeInfoCache || now - exchangeInfoCacheTs > EXCHANGE_INFO_TTL_MS) {
      exchangeInfoCache = await publicGet("/fapi/v1/exchangeInfo");
      exchangeInfoCacheTs = now;
    }
    const allSyms = Array.isArray(exchangeInfoCache?.symbols) ? exchangeInfoCache.symbols : [];
    const s = allSyms.find((x) => String(x?.symbol).toUpperCase() === key) || null;
    if (!s) throw new Error(`binance_futures_testnet_exchangeinfo_missing_symbol:${key}`);
    const filters = Array.isArray(s?.filters) ? s.filters : [];
    const lot = filters.find((f) => f.filterType === "LOT_SIZE") || {};
    const marketLot = filters.find((f) => f.filterType === "MARKET_LOT_SIZE") || {};
    const price = filters.find((f) => f.filterType === "PRICE_FILTER") || {};
    const minN = filters.find((f) => f.filterType === "MIN_NOTIONAL") || {};
    const lotStepSize = String(lot.stepSize || "0.001");
    const marketStepSize = String(marketLot.stepSize || lot.stepSize || "0.001");
    const qtyStepSize = pickUnifiedQtyStep(lotStepSize, marketStepSize);
    const tickSize = String(price.tickSize || "0.01");
    const minNotional = Number(minN.notional || minN.minNotional || 5);
    const quantityPrecision = Number(s?.quantityPrecision);
    const pricePrecision = Number(s?.pricePrecision);
    const out = {
      stepSize: lotStepSize,
      qtyStepSize,
      tickSize,
      minNotional: Number.isFinite(minNotional) && minNotional > 0 ? minNotional : 5,
      quantityPrecision: Number.isInteger(quantityPrecision) && quantityPrecision >= 0 ? quantityPrecision : null,
      pricePrecision: Number.isInteger(pricePrecision) && pricePrecision >= 0 ? pricePrecision : null,
    };
    metaCache.set(key, out);
    return out;
  }

  function pickUnifiedQtyStep(lotStr, mktStr) {
    const L = Number(lotStr);
    const M = Number(mktStr);
    if (!Number.isFinite(L) || L <= 0) return String(mktStr);
    if (!Number.isFinite(M) || M <= 0) return String(lotStr);
    const r = L / M;
    if (Math.abs(r - Math.round(r)) < 1e-9) return String(lotStr);
    const r2 = M / L;
    if (Math.abs(r2 - Math.round(r2)) < 1e-9) return String(mktStr);
    return String(lotStr);
  }

  function filterFractionalDigits(filterStr) {
    const t = String(filterStr ?? "").trim();
    const dot = t.indexOf(".");
    return dot < 0 ? 0 : t.length - dot - 1;
  }

  function effectivePrecision(filterStr) {
    const t = String(filterStr ?? "").trim().replace(/0+$/, "").replace(/\.$/, "");
    const dot = t.indexOf(".");
    return dot < 0 ? 0 : t.length - dot - 1;
  }

  function formatToStep(qty, meta) {
    const stepStr = meta?.qtyStepSize || meta?.stepSize;
    const q = Number(qty);
    const stepNum = Number(stepStr);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(stepNum) || stepNum <= 0) return null;
    const dec = filterFractionalDigits(stepStr);
    const scaleExp = Math.min(dec, 15);
    const scale = 10 ** scaleExp;
    const stepUnits = Math.round(stepNum * scale);
    if (stepUnits <= 0) return null;
    const qUnits = Math.floor((q * scale) / stepUnits + 1e-9) * stepUnits;
    if (qUnits <= 0) return null;
    const aligned = qUnits / scale;
    const stepEffective = effectivePrecision(stepStr);
    const prec = Math.min(
      stepEffective,
      meta.quantityPrecision != null ? meta.quantityPrecision : stepEffective,
    );
    const s = aligned.toFixed(prec);
    return Number(s) > 0 ? s : null;
  }

  function formatToTick(px, meta) {
    const tickStr = meta?.tickSize;
    const p = Number(px);
    const tickNum = Number(tickStr);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(tickNum) || tickNum <= 0) return null;
    const dec = filterFractionalDigits(tickStr);
    const scaleExp = Math.min(dec, 15);
    const scale = 10 ** scaleExp;
    const tickUnits = Math.round(tickNum * scale);
    if (tickUnits <= 0) return null;
    const pUnits = Math.round((p * scale) / tickUnits) * tickUnits;
    if (pUnits <= 0) return null;
    const aligned = pUnits / scale;
    const tickEffective = effectivePrecision(tickStr);
    const prec = Math.min(
      tickEffective,
      meta.pricePrecision != null ? meta.pricePrecision : tickEffective,
    );
    const s = aligned.toFixed(prec);
    return Number(s) > 0 ? s : null;
  }

  async function ensureLeverage(symbol, lev) {
    const leverage = Math.max(1, Math.min(50, Number(lev || defaultLeverage)));
    try {
      await signed("POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) });
    } catch (e) {
      log?.warn?.("binance_futures_set_leverage_failed", { symbol, leverage, error: String(e?.message || e) });
    }
    return leverage;
  }

  const localBrackets = {};

  return {
    name: "binance_futures_testnet_usdm",
    supportsAutoTrading: true,
    storeInfo: { baseURL, note: "USD-M Futures Testnet" },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_futures_testnet_missing_keys");
      // Futures account endpoint
      const a = await signed("GET", "/fapi/v2/account");
      const w = Number(a?.totalWalletBalance || 0);
      const free = Number(a?.availableBalance || 0);
      return { equity: w, freeBalance: free, dailyStartEquity: null, dailyPnlPct: 0, leverage: defaultLeverage };
    },
    async getPositions() {
      try {
        const a = await signed("GET", "/fapi/v2/account");
        const ps = Array.isArray(a?.positions) ? a.positions : [];
        return ps
          .filter((p) => Math.abs(Number(p?.positionAmt || 0)) > 1e-8)
          .map((p) => {
            const sym = p.symbol;
            const lb = localBrackets[sym];
            const lev = Number(p.leverage || defaultLeverage);
            return {
              id: `${sym}`,
              symbol: sym,
              side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
              qty: Math.abs(Number(p.positionAmt)),
              entryPrice: Number(p.entryPrice || 0),
              unrealizedPnl: Number(p.unrealizedProfit || 0),
              stopLoss: lb?.stopLoss ?? null,
              takeProfit: lb?.takeProfit ?? null,
              leverage: Number.isFinite(lev) && lev > 0 ? lev : defaultLeverage,
              venue: "FUTURES",
              syncSource: "fapi_v2_account",
            };
          });
      } catch (e) {
        log?.warn?.("binance_futures_positions_failed", { error: String(e?.message || e) });
        return [];
      }
    },
    async getTrades() {
      if (!apiKey || !apiSecret) return [];
      try {
        const incomes = await signed("GET", "/fapi/v1/income", {
          incomeType: "REALIZED_PNL",
          limit: "200",
        });
        if (!Array.isArray(incomes)) return [];
        return incomes
          .filter((i) => Math.abs(Number(i?.income || 0)) > 1e-12)
          .map((i) => ({
            id: `inc_${i.tranId || i.time}`,
            ts: new Date(Number(i.time)).toISOString(),
            type: "CLOSE",
            symbol: i.symbol || "UNKNOWN",
            side: "SELL",
            qty: 0,
            price: 0,
            pnl: Number(i.income || 0),
            strategy: i.info || "UNKNOWN",
            meta: { source: "fapi_income", raw: i },
          }));
      } catch (e) {
        log?.warn?.("binance_futures_testnet_getTrades_failed", { error: String(e?.message || e) });
        return [];
      }
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) throw new Error("binance_futures_testnet_missing_keys");
      const isLong = side === "BUY";
      if (side !== "BUY" && side !== "SELL") throw new Error("bad_side");

      const m = await getOrLoadSymbolMeta(symbol);
      const qtyStr = formatToStep(qty, m);
      if (!qtyStr) throw new Error("invalid_qty");

      const markPx = Number(price);
      if (Number.isFinite(markPx) && markPx > 0 && m.minNotional) {
        const approxNotional = Number(qtyStr) * markPx;
        if (approxNotional + 1e-8 < Number(m.minNotional)) {
          throw new Error(
            `below_min_notional: ~${approxNotional.toFixed(2)} USDT < exchange min ${m.minNotional} — increase risk per trade, leverage, or balance`
          );
        }
      }

      const stopPx = Number(stopLoss);
      const tpPx = Number(takeProfit);
      if (!stopPx || !tpPx) throw new Error("stoploss_takeprofit_required");

      const leverage = await ensureLeverage(symbol, meta?.leverage || meta?.futuresLeverage || defaultLeverage);

      // 1) MARKET entry
      const out = await signed("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qtyStr,
        newClientOrderId: `ai_${Date.now()}`,
      });

      const orderId = String(out?.orderId || Date.now());
      const filledPrice = Number(out?.avgPrice || price || 0) || Number(price || 0);
      const posId = `fut_${orderId}`;

      const executedQty = formatToStep(Number(out?.executedQty || out?.origQty || qty), m) || qtyStr;

      const closeSide = isLong ? "SELL" : "BUY";
      const stopStr = formatToTick(stopPx, m);
      const tpStr = formatToTick(tpPx, m);
      if (!stopStr || !tpStr) throw new Error("bad_bracket_prices");

      const slippageMult = closeSide === "SELL" ? 0.995 : 1.005;
      const slLimitStr = formatToTick(stopPx * slippageMult, m) || stopStr;
      const tpLimitStr = formatToTick(tpPx * slippageMult, m) || tpStr;

      async function placeBracketOrder(type, triggerPrice, limitPrice, tag) {
        const marketType = `${type}_MARKET`;
        const params = {
          symbol,
          side: closeSide,
          reduceOnly: "true",
          quantity: executedQty,
          stopPrice: triggerPrice,
          workingType: "MARK_PRICE",
          newClientOrderId: `${tag}_${Date.now()}`,
        };
        try {
          await signed("POST", "/fapi/v1/order", { ...params, type: marketType });
        } catch (e1) {
          const errCode = e1?.cause?.response?.data?.code;
          const is4120 = errCode === -4120 || String(e1?.message || "").includes("-4120");
          if (is4120) {
            log?.info?.("binance_futures_bracket_fallback_limit", { symbol, type, marketType });
            await signed("POST", "/fapi/v1/order", {
              ...params,
              type,
              price: limitPrice,
              timeInForce: "GTC",
            });
          } else {
            throw e1;
          }
        }
      }

      let bracketsPlaced = false;
      try {
        await placeBracketOrder("STOP", stopStr, slLimitStr, "sl");
        await placeBracketOrder("TAKE_PROFIT", tpStr, tpLimitStr, "tp");
        bracketsPlaced = true;
      } catch (e) {
        const is4120 = String(e?.message || "").includes("-4120");
        if (is4120) {
          log?.warn?.("binance_futures_brackets_unsupported_using_local", {
            symbol,
            stopLoss: stopPx,
            takeProfit: tpPx,
          });
          localBrackets[symbol] = {
            posId,
            isLong,
            entryPrice: filledPrice,
            stopLoss: stopPx,
            takeProfit: tpPx,
            qty: executedQty,
            closeSide,
            strategy: strategy || "AUTO",
            openedAt: Date.now(),
          };
        } else {
          log?.warn?.("binance_futures_bracket_failed_flatten", { symbol, error: String(e?.message || e) });
          await signed("POST", "/fapi/v1/order", {
            symbol,
            side: closeSide,
            type: "MARKET",
            quantity: executedQty,
            reduceOnly: "true",
            newClientOrderId: `flatten_${Date.now()}`,
          });
          throw e;
        }
      }

      return { id: posId, filledPrice, leverage, venue: "FUTURES", raw: out, strategy, meta: meta || {} };
    },
    async markToMarket({ symbol, price } = {}) {
      const markPx = Number(price);
      if (symbol && Number.isFinite(markPx) && markPx > 0 && localBrackets[symbol]) {
        const b = localBrackets[symbol];
        const bracketLo = Math.min(b.stopLoss, b.takeProfit) * 0.90;
        const bracketHi = Math.max(b.stopLoss, b.takeProfit) * 1.10;
        if (markPx >= bracketLo && markPx <= bracketHi) {
        let hit = null;
        if (b.isLong) {
          if (markPx <= b.stopLoss) hit = "SL";
          else if (markPx >= b.takeProfit) hit = "TP";
        } else {
          if (markPx >= b.stopLoss) hit = "SL";
          else if (markPx <= b.takeProfit) hit = "TP";
        }
        if (hit) {
          try {
            await signed("POST", "/fapi/v1/order", {
              symbol,
              side: b.closeSide,
              type: "MARKET",
              quantity: b.qty,
              reduceOnly: "true",
              newClientOrderId: `local_${hit.toLowerCase()}_${Date.now()}`,
            });
            log?.info?.("binance_futures_local_bracket_hit", { symbol, hit, markPx, sl: b.stopLoss, tp: b.takeProfit });
            delete localBrackets[symbol];
          } catch (e) {
            log?.warn?.("binance_futures_local_bracket_close_failed", { symbol, hit, error: String(e?.message || e) });
          }
        }
        } // end price sanity check
      }
    },
    async closePosition({ id }) {
      if (!apiKey || !apiSecret) return { ok: false, error: "binance_futures_testnet_missing_keys" };
      let positions;
      try {
        const a = await signed("GET", "/fapi/v2/account");
        const ps = Array.isArray(a?.positions) ? a.positions : [];
        positions = ps
          .filter((p) => Math.abs(Number(p?.positionAmt || 0)) > 1e-8)
          .map((p) => ({
            symbol: p.symbol,
            side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
            qty: Math.abs(Number(p.positionAmt)),
          }));
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      const sid = String(id || "");
      const symFromId = sid.startsWith("fut_") ? sid.slice(4) : sid;
      const p = positions.find((x) => x.symbol === sid || x.symbol === symFromId);
      if (!p) return { ok: false, error: "not_found" };
      const m = await getOrLoadSymbolMeta(p.symbol);
      const qtyStr = formatToStep(p.qty, m);
      if (!qtyStr) return { ok: false, error: "invalid_qty" };
      const closeSide = p.side === "BUY" ? "SELL" : "BUY";
      try {
        await signed("POST", "/fapi/v1/order", {
          symbol: p.symbol,
          side: closeSide,
          type: "MARKET",
          quantity: qtyStr,
          reduceOnly: "true",
          newClientOrderId: `mclose_${Date.now()}`,
        });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      delete localBrackets[p.symbol];
      return { ok: true };
    },
    async close() {
      // no-op
    },
    getStatus() {
      return { udf: { ok: false, syncMode: "polling", error: "not_implemented" } };
    },
  };
}

