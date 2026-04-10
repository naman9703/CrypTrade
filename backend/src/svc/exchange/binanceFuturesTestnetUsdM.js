import crypto from "crypto";
import axios from "axios";
import { refineUsdMTriggersVsMark, usdmBracketPriceStrings } from "../../lib/binanceFuturesBracketPrices.js";
import { placeUsdMSlTpAfterMarketEntry, futuresOrderIs4120 } from "../../lib/binanceFuturesSlTpBracket.js";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBinanceFuturesTestnetUsdMExchange({ log }) {
  const apiKey = process.env.BINANCE_FUTURES_API_KEY || "";
  const apiSecret = process.env.BINANCE_FUTURES_API_SECRET || "";
  const baseURL = process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com";
  const defaultLeverage = Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5)));

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
    const leverage = Math.max(1, Math.min(100, Number(lev || defaultLeverage)));
    try {
      await signed("POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) });
    } catch (e) {
      log?.warn?.("binance_futures_set_leverage_failed", { symbol, leverage, error: String(e?.message || e) });
    }
    return leverage;
  }

  let accountModeCache = { at: 0, dual: false };
  async function hedgePositionSideExtras(isLong) {
    try {
      const now = Date.now();
      if (now - accountModeCache.at < 10_000) {
        if (!accountModeCache.dual) return {};
        return { positionSide: isLong ? "LONG" : "SHORT" };
      }
      const a = await signed("GET", "/fapi/v2/account");
      const dual = String(a?.dualSidePosition ?? "").toLowerCase() === "true";
      accountModeCache = { at: now, dual };
      if (!dual) return {};
      return { positionSide: isLong ? "LONG" : "SHORT" };
    } catch {
      return {};
    }
  }

  function reanchorSlTpToFill({ isLong, anchorPx, filledPx, stopPx, tpPx }) {
    const a = Number(anchorPx);
    const f = Number(filledPx);
    let s = Number(stopPx);
    let t = Number(tpPx);
    if (!Number.isFinite(a) || !Number.isFinite(f) || a <= 0 || f <= 0 || !Number.isFinite(s) || !Number.isFinite(t)) {
      return { stopPx: s, tpPx: t };
    }
    if (isLong) {
      const slDist = a - s;
      const tpDist = t - a;
      return { stopPx: f - slDist, tpPx: f + tpDist };
    }
    const slDist = s - a;
    const tpDist = a - t;
    return { stopPx: f + slDist, tpPx: f - tpDist };
  }

  let slTpOpenOrdersCache = { at: 0, map: new Map() };
  async function stopTakeFromExchangeOpenOrders(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const now = Date.now();
    if (now - slTpOpenOrdersCache.at < 2000 && slTpOpenOrdersCache.map.has(sym)) {
      return slTpOpenOrdersCache.map.get(sym);
    }
    const map = new Map();
    try {
      const all = await signed("GET", "/fapi/v1/openOrders");
      for (const o of Array.isArray(all) ? all : []) {
        const s = String(o.symbol || "").toUpperCase();
        if (!map.has(s)) map.set(s, { sl: null, tp: null });
        const typ = String(o.type || "");
        const st = Number(o.stopPrice);
        if (!Number.isFinite(st) || st <= 0) continue;
        const row = map.get(s);
        if (typ.includes("TAKE_PROFIT")) row.tp = st;
        else if (typ.includes("STOP") && !typ.includes("TAKE")) row.sl = st;
      }
    } catch (e) {
      log?.warn?.("binance_futures_testnet_open_orders_failed", { error: String(e?.message || e) });
    }
    slTpOpenOrdersCache = { at: now, map };
    return map.get(sym) || { sl: null, tp: null };
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
        const rows = ps
          .filter((p) => Math.abs(Number(p?.positionAmt || 0)) > 1e-8)
          .map((p) => {
            const sym = p.symbol;
            const lb = localBrackets[sym];
            const lev = Number(p.leverage || defaultLeverage);
            return { sym, lb, lev, p };
          });
        const out = [];
        for (const { sym, lb, lev, p } of rows) {
          const oo = await stopTakeFromExchangeOpenOrders(sym);
          out.push({
            id: `${sym}`,
            symbol: sym,
            side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
            qty: Math.abs(Number(p.positionAmt)),
            entryPrice: Number(p.entryPrice || 0),
            unrealizedPnl: Number(p.unrealizedProfit || 0),
            stopLoss: oo.sl ?? lb?.stopLoss ?? null,
            takeProfit: oo.tp ?? lb?.takeProfit ?? null,
            leverage: Number.isFinite(lev) && lev > 0 ? lev : defaultLeverage,
            venue: "FUTURES",
            syncSource: "fapi_v2_account",
          });
        }
        return out;
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
      const hedgeExtras = await hedgePositionSideExtras(isLong);

      // 1) MARKET entry
      const out = await signed("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qtyStr,
        newClientOrderId: `ai_${Date.now()}`,
        ...hedgeExtras,
      });

      const orderId = String(out?.orderId || Date.now());
      const filledPrice = Number(out?.avgPrice || out?.price || price || 0) || Number(price || 0);
      const posId = `fut_${orderId}`;

      const executedQty = formatToStep(Number(out?.executedQty || out?.origQty || qty), m) || qtyStr;

      const anchorPx = Number.isFinite(markPx) && markPx > 0 ? markPx : filledPrice;
      let adjStop = Number(stopLoss);
      let adjTp = Number(takeProfit);
      const r2 = reanchorSlTpToFill({ isLong, anchorPx, filledPx: filledPrice, stopPx: adjStop, tpPx: adjTp });
      adjStop = r2.stopPx;
      adjTp = r2.tpPx;

      const closeSide = isLong ? "SELL" : "BUY";
      let markRef = filledPrice;
      try {
        const pi = await publicGet("/fapi/v1/premiumIndex", { symbol });
        const mp = Number(pi?.markPrice);
        if (Number.isFinite(mp) && mp > 0) markRef = mp;
      } catch {
        // use filledPrice
      }
      const refined = refineUsdMTriggersVsMark({
        isLong,
        stopPx: adjStop,
        tpPx: adjTp,
        markPrice: markRef,
        meta: m,
      });
      if (refined.adjusted) {
        log?.info?.("binance_futures_testnet_sltp_refined_vs_mark", {
          symbol,
          markPrice: markRef,
          beforeStop: adjStop,
          beforeTp: adjTp,
          afterStop: refined.stopPx,
          afterTp: refined.tpPx,
        });
      }
      adjStop = refined.stopPx;
      adjTp = refined.tpPx;
      const { stopStr, tpStr, slLimitStr, tpLimitStr } = usdmBracketPriceStrings({
        isLong,
        stopPx: adjStop,
        tpPx: adjTp,
        meta: m,
        closeSide,
      });
      if (!stopStr || !tpStr || !slLimitStr || !tpLimitStr) throw new Error("bad_bracket_prices");

      let bracketsPlaced = false;
      try {
        await placeUsdMSlTpAfterMarketEntry({
          signed,
          symbol,
          closeSide,
          stopStr,
          tpStr,
          slLimitStr,
          tpLimitStr,
          executedQty,
          hedgeExtras,
          log,
          logPrefix: "binance_futures_testnet",
        });
        bracketsPlaced = true;
      } catch (e) {
        const is4120 = futuresOrderIs4120(e);
        if (is4120) {
          log?.warn?.("binance_futures_brackets_unsupported_using_local", {
            symbol,
            stopLoss: adjStop,
            takeProfit: adjTp,
          });
          localBrackets[symbol] = {
            posId,
            isLong,
            entryPrice: filledPrice,
            stopLoss: adjStop,
            takeProfit: adjTp,
            qty: executedQty,
            closeSide,
            strategy: strategy || "AUTO",
            openedAt: Date.now(),
            leverage,
            positionSide: hedgeExtras.positionSide,
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
            ...hedgeExtras,
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
              ...(b.positionSide ? { positionSide: b.positionSide } : {}),
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
      const hedgeCloseExtras = await hedgePositionSideExtras(p.side === "BUY");
      try {
        await signed("POST", "/fapi/v1/order", {
          symbol: p.symbol,
          side: closeSide,
          type: "MARKET",
          quantity: qtyStr,
          reduceOnly: "true",
          newClientOrderId: `mclose_${Date.now()}`,
          ...hedgeCloseExtras,
        });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      delete localBrackets[p.symbol];
      return { ok: true };
    },
    async getSymbolOrderConstraints(symbol) {
      const sym = String(symbol || "").toUpperCase();
      const m = await getOrLoadSymbolMeta(sym);
      return {
        ok: true,
        symbol: sym,
        venue: "FUTURES",
        minNotional: m.minNotional ?? null,
        quoteAsset: "USDT",
        rule: "Binance USD-M futures exchangeInfo: MIN_NOTIONAL notional (USDT)",
      };
    },
    async close() {
      // no-op
    },
    getStatus() {
      return { udf: { ok: false, syncMode: "polling", error: "not_implemented" } };
    },
  };
}

