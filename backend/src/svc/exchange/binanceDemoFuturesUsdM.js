import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { resolveDefaultDemoFuturesIncomeSyncPath } from "../../lib/tradingModePersistence.js";
import { tradeCloseFeeUsdtFromNotional } from "../../lib/tradeCloseFee.js";
import { refineUsdMTriggersVsMark, usdmBracketPriceStrings } from "../../lib/binanceFuturesBracketPrices.js";
import { placeUsdMSlTpAfterMarketEntry, futuresOrderIs4120 } from "../../lib/binanceFuturesSlTpBracket.js";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBinanceDemoFuturesUsdMExchange({ log }) {
  // By default, reuse demo API keys unless dedicated futures demo keys are provided.
  const apiKey = process.env.BINANCE_DEMO_FUTURES_API_KEY || process.env.BINANCE_DEMO_API_KEY || "";
  const apiSecret = process.env.BINANCE_DEMO_FUTURES_API_SECRET || process.env.BINANCE_DEMO_API_SECRET || "";
  const baseURL = process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com";
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
    try {
      const { data } = await http.request({ method, url });
      return data;
    } catch (e) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      const msg = body?.msg || body?.message || e?.message || "binance_demo_futures_request_failed";
      const code = body?.code;
      const err = new Error(`binance_demo_futures_http_${method}_${path}:${status ?? "?"}:${code ?? "?"}:${msg}`);
      err.cause = e;
      throw err;
    }
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
  const EXCHANGE_INFO_TTL_MS = 30 * 60 * 1000; // 30 min

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
    if (!s) throw new Error(`binance_demo_futures_exchangeinfo_missing_symbol:${key}`);
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
    log?.info?.("binance_demo_futures_symbol_meta", {
      symbol: key,
      stepSize: lotStepSize,
      qtyStepSize,
      tickSize,
      quantityPrecision: out.quantityPrecision,
      pricePrecision: out.pricePrecision,
      minNotional: out.minNotional,
    });
    metaCache.set(key, out);
    return out;
  }

  /**
   * MARKET_LOT_SIZE.stepSize can differ from LOT_SIZE (e.g. LOT 3, MARKET 1). Using only the
   * MARKET step fills amounts that fail STOP/TP quantity filters (-1111). Use the coarser grid
   * that satisfies both (multiples of 3 work for MARKET step 1; multiples of 1 may not for LOT 3).
   */
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

  /** Count ALL fractional digits (including trailing zeros) — used for integer-scaling math. */
  function filterFractionalDigits(filterStr) {
    const t = String(filterStr ?? "").trim();
    const dot = t.indexOf(".");
    return dot < 0 ? 0 : t.length - dot - 1;
  }

  /** Count only significant fractional digits (strip trailing zeros) — used for `.toFixed()`. */
  function effectivePrecision(filterStr) {
    const t = String(filterStr ?? "").trim().replace(/0+$/, "").replace(/\.$/, "");
    const dot = t.indexOf(".");
    return dot < 0 ? 0 : t.length - dot - 1;
  }

  /** Floor qty to step using integer scaling (avoids IEEE noise); cap decimal digits to the minimum
   *  of the step's effective precision, quantityPrecision from the exchange, and the aligned value's
   *  own significant digits — whichever is smallest — so trailing zeros never exceed the API limit. */
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

  /** Round price to tick with integer scaling; cap decimal digits like formatToStep. */
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
      log?.warn?.("binance_demo_futures_set_leverage_failed", { symbol, leverage, error: String(e?.message || e) });
    }
    return leverage;
  }

  /** Binance USDM: one-way vs hedge (dual) position mode — reduce-only brackets need `positionSide` in hedge mode. */
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

  /** Keep SL/TP distance from planned anchor (e.g. last close) but re-base to actual fill so triggers are valid vs mark. */
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

  /** SL/TP trigger prices from exchange open conditional orders (when brackets posted, localBrackets may be empty). */
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
      log?.warn?.("binance_demo_futures_open_orders_failed", { error: String(e?.message || e) });
    }
    slTpOpenOrdersCache = { at: now, map };
    return map.get(sym) || { sl: null, tp: null };
  }

  const incomeSyncPath = resolveDefaultDemoFuturesIncomeSyncPath();
  const bootIncomeLookbackMs = Math.max(
    60_000,
    Math.min(24 * 3600 * 1000, Number(process.env.BINANCE_DEMO_FUT_INCOME_BOOT_LOOKBACK_MS || 600_000))
  ); // default 10 min — never pull full account history as “new” closes

  const mem = {
    trades: [],
    seenIncomeIds: new Set(),
    /** @type {number | null} */
    incomeCursorMs: null,
    lastIncomePollAt: 0,
    /** SL/TP targets when exchange-side brackets couldn't be placed (demo API limitation) */
    localBrackets: {},
    /** Recent local bracket closes — income sync uses these to attribute PnL to strategy, not ledger */
    recentLocalCloses: [],
  };

  const MAX_MEM_TRADES = 800;

  function loadIncomeSyncFromDisk() {
    try {
      if (!fs.existsSync(incomeSyncPath)) return;
      const raw = JSON.parse(fs.readFileSync(incomeSyncPath, "utf8"));
      if (raw.incomeCursorMs != null) mem.incomeCursorMs = Number(raw.incomeCursorMs);
      for (const id of (raw.seenTranIds || []).slice(-8000)) mem.seenIncomeIds.add(String(id));
    } catch (e) {
      log?.warn?.("binance_demo_futures_income_sync_load_failed", { error: String(e?.message || e) });
    }
  }

  function saveIncomeSyncToDisk() {
    try {
      fs.mkdirSync(path.dirname(incomeSyncPath), { recursive: true });
      fs.writeFileSync(
        incomeSyncPath,
        JSON.stringify(
          {
            incomeCursorMs: mem.incomeCursorMs,
            seenTranIds: [...mem.seenIncomeIds].slice(-8000),
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch (e) {
      log?.warn?.("binance_demo_futures_income_sync_save_failed", { error: String(e?.message || e) });
    }
  }

  loadIncomeSyncFromDisk();

  async function syncRealizedIncomeFromExchange() {
    if (!apiKey || !apiSecret) return;
    const now = Date.now();
    if (now - mem.lastIncomePollAt < 2500) return;
    mem.lastIncomePollAt = now;
    // First run (no cursor file): only a short boot window — NOT 7d of historical REALIZED_PNL
    const start =
      mem.incomeCursorMs != null
        ? Math.max(0, mem.incomeCursorMs - 180_000)
        : Math.max(0, Date.now() - bootIncomeLookbackMs);
    let rows;
    try {
      rows = await signed("GET", "/fapi/v1/income", {
        incomeType: "REALIZED_PNL",
        startTime: String(start),
        limit: "1000",
      });
    } catch (e) {
      log?.warn?.("binance_demo_futures_income_poll_failed", { error: String(e?.message || e) });
      return;
    }
    if (!Array.isArray(rows)) return;
    if (!rows.length) {
      if (mem.incomeCursorMs == null) {
        mem.incomeCursorMs = Date.now();
        saveIncomeSyncToDisk();
      }
      return;
    }
    // Expire local close hints (manual close + local SL/TP) — income can lag a few minutes on demo
    const LOCAL_CLOSE_TTL_MS = Math.max(
      120_000,
      Math.min(600_000, Number(process.env.BINANCE_DEMO_INCOME_MATCH_TTL_MS || 300_000))
    );
    const nowLc = Date.now();
    mem.recentLocalCloses = mem.recentLocalCloses.filter((c) => nowLc - c.closedAt < LOCAL_CLOSE_TTL_MS);

    /** Income rows more than this *before* our local close are older trades — do not bind to `recentLocalCloses`. */
    const INCOME_PRE_CLOSE_SKEW_MS = Math.max(
      30_000,
      Math.min(600_000, Number(process.env.BINANCE_DEMO_INCOME_PRE_CLOSE_SKEW_MS || 120_000))
    );

    let maxT = mem.incomeCursorMs != null ? mem.incomeCursorMs : start;
    for (const row of rows) {
      const tid =
        row.tranId != null
          ? String(row.tranId)
          : `${row.time || 0}_${row.symbol || ""}_${row.income || ""}`;
      if (mem.seenIncomeIds.has(tid)) continue;
      mem.seenIncomeIds.add(tid);
      const pnl = Number(row.income || 0);
      const sym = String(row.symbol || "UNKNOWN").toUpperCase();
      const t = Number(row.time || 0);
      const eventMs = t > 0 ? t : Date.now();
      const tsIso = t ? new Date(t).toISOString() : new Date().toISOString();

      // Match most recent pending close for this symbol (manual close or local SL/TP).
      // Use a one-sided window: income must land at/after (close − skew) and within TTL after close.
      // `abs(event - close) < TTL` wrongly bound REALIZED_PNL from *earlier* exits minutes before this close.
      let localMatch = -1;
      for (let i = mem.recentLocalCloses.length - 1; i >= 0; i--) {
        const c = mem.recentLocalCloses[i];
        if (c.symbol !== sym) continue;
        if (eventMs < c.closedAt - INCOME_PRE_CLOSE_SKEW_MS) continue;
        if (eventMs > c.closedAt + LOCAL_CLOSE_TTL_MS) continue;
        localMatch = i;
        break;
      }

      if (localMatch >= 0) {
        const lc = mem.recentLocalCloses[localMatch];
        const localCloseKey = `${sym}_${lc.closedAt}`;
        let mergeInto = null;
        for (let i = mem.trades.length - 1; i >= 0; i--) {
          const tr = mem.trades[i];
          if (
            tr.type === "CLOSE" &&
            tr.meta?.localEnforcement === true &&
            String(tr.symbol) === sym &&
            tr.meta?.localCloseKey === localCloseKey
          ) {
            mergeInto = tr;
            break;
          }
        }

        if (mergeInto) {
          mergeInto.pnl = Number(mergeInto.pnl || 0) + pnl;
          mergeInto.meta._incomeEventMs = Math.max(
            Number(mergeInto.meta._incomeEventMs || 0),
            eventMs
          );
          const ids = Array.isArray(mergeInto.meta.tranIds)
            ? mergeInto.meta.tranIds
            : [String(mergeInto.meta.tranId || "")];
          if (!ids.includes(tid)) ids.push(tid);
          mergeInto.meta.tranIds = ids;
          mergeInto.meta.tranId = ids[ids.length - 1];
          if (lc.posId && String(mergeInto.id).startsWith("finc_")) mergeInto.id = String(lc.posId);
          if ((mergeInto.qty == null || !Number.isFinite(Number(mergeInto.qty))) && lc.qty != null) {
            mergeInto.qty = Number(lc.qty);
          }
          if (mergeInto.price == null && lc.markPx != null) mergeInto.price = Number(lc.markPx);
          if (mergeInto.leverage == null && lc.leverage != null) mergeInto.leverage = Number(lc.leverage);
          if (mergeInto.stopLoss == null && lc.stopLoss != null) mergeInto.stopLoss = Number(lc.stopLoss);
          if (mergeInto.takeProfit == null && lc.takeProfit != null) mergeInto.takeProfit = Number(lc.takeProfit);
          if (mergeInto.entryPrice == null && lc.entryPrice != null) mergeInto.entryPrice = Number(lc.entryPrice);
          if (mergeInto.meta && mergeInto.meta.leverage == null && lc.leverage != null) {
            mergeInto.meta.leverage = Number(lc.leverage);
          }
          {
            const feePx =
              mergeInto.price ??
              mergeInto.meta?.exitPrice ??
              (lc.markPx != null ? Number(lc.markPx) : NaN);
            const f = tradeCloseFeeUsdtFromNotional(mergeInto.qty, feePx);
            if (f != null) mergeInto.fee = f;
          }
        } else {
          const closeQtyN = lc.qty != null ? Number(lc.qty) : NaN;
          const closePxN =
            lc.markPx != null && Number.isFinite(Number(lc.markPx)) ? Number(lc.markPx) : NaN;
          mem.trades.push({
            type: "CLOSE",
            id: lc.posId ? String(lc.posId) : `finc_${tid}`,
            ts: tsIso,
            symbol: sym,
            side: lc.closeSide || "—",
            qty: lc.qty != null ? Number(lc.qty) : undefined,
            price: lc.markPx != null && Number.isFinite(Number(lc.markPx)) ? Number(lc.markPx) : undefined,
            entryPrice: lc.entryPrice != null ? Number(lc.entryPrice) : undefined,
            stopLoss: lc.stopLoss != null ? Number(lc.stopLoss) : undefined,
            takeProfit: lc.takeProfit != null ? Number(lc.takeProfit) : undefined,
            leverage: lc.leverage != null ? Number(lc.leverage) : undefined,
            pnl,
            fee: tradeCloseFeeUsdtFromNotional(closeQtyN, closePxN) ?? undefined,
            strategy: lc.strategy || "AUTO",
            meta: {
              source: "fapi_income",
              incomeType: row.incomeType || "REALIZED_PNL",
              tranId: tid,
              tranIds: [tid],
              bracketType: lc.bracketType,
              localEnforcement: true,
              localCloseKey,
              _incomeEventMs: eventMs,
              leverage: lc.leverage != null ? Number(lc.leverage) : undefined,
              exitPrice: lc.markPx != null ? Number(lc.markPx) : undefined,
            },
          });
        }
      } else {
        mem.trades.push({
          type: "CLOSE",
          id: `finc_${tid}`,
          ts: tsIso,
          symbol: sym,
          side: "—",
          pnl,
          strategy: "INCOME_LEDGER",
          ledgerEvent: true,
          meta: {
            source: "fapi_income",
            incomeType: row.incomeType || "REALIZED_PNL",
            tranId: tid,
            note: "realized_pnl_ledger_row",
          },
        });
      }
      if (t) maxT = Math.max(maxT, t);
    }
    mem.incomeCursorMs = maxT + 1;
    saveIncomeSyncToDisk();
    if (mem.seenIncomeIds.size > 20_000) {
      mem.seenIncomeIds = new Set([...mem.seenIncomeIds].slice(-10_000));
    }
    if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);
  }

  return {
    name: "binance_demo_futures_usdm",
    supportsAutoTrading: true,
    storeInfo: { baseURL, note: "USD-M Futures Demo (real demo futures)" },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_demo_futures_missing_keys");
      const a = await signed("GET", "/fapi/v2/account");
      const equity = Number(a?.totalWalletBalance || 0);
      const free = Number(a?.availableBalance || 0);
      return { equity, freeBalance: free, dailyStartEquity: null, dailyPnlPct: 0, leverage: defaultLeverage };
    },
    async getPositions() {
      try {
        const a = await signed("GET", "/fapi/v2/account");
        const ps = Array.isArray(a?.positions) ? a.positions : [];
        const rows = ps
          .filter((p) => Math.abs(Number(p?.positionAmt || 0)) > 1e-8)
          .map((p) => {
            const sym = p.symbol;
            const lb = mem.localBrackets[sym];
            const lev = Number(p.leverage || defaultLeverage);
            return { sym, lb, lev, p };
          });
        const out = [];
        for (const { sym, lb, lev, p } of rows) {
          const oo = await stopTakeFromExchangeOpenOrders(sym);
          out.push({
            id: `fut_${sym}`,
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
        log?.warn?.("binance_demo_futures_positions_failed", { error: String(e?.message || e) });
        return [];
      }
    },
    async getTrades() {
      await syncRealizedIncomeFromExchange();
      // Do not truncate here — hybrid / ingestClosedTrades rely on a monotonically growing tail length.
      return mem.trades.slice(-MAX_MEM_TRADES);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) throw new Error("binance_demo_futures_missing_keys");
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

      let stopPx = Number(stopLoss);
      let tpPx = Number(takeProfit);
      if (!stopPx || !tpPx) throw new Error("stoploss_takeprofit_required");

      const leverage = await ensureLeverage(symbol, meta?.futuresLeverage || meta?.leverage || defaultLeverage);
      const hedgeExtras = await hedgePositionSideExtras(isLong);

      const out = await signed("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qtyStr,
        newClientOrderId: `ai_${Date.now()}`,
        ...hedgeExtras,
      });

      const orderId = String(out?.orderId || Date.now());
      const filledPrice =
        Number(out?.avgPrice || out?.price || price || 0) || Number(price || 0);
      /** Match `getPositions()` id (`fut_${symbol}`) so UI open trades ↔ positions links for indicator/AI fills. */
      const posId = `fut_${symbol}`;

      // Use executed qty for bracket legs (handles partial fills)
      const executedQty = formatToStep(Number(out?.executedQty || out?.origQty || qty), m) || qtyStr;

      const anchorPx = Number.isFinite(markPx) && markPx > 0 ? markPx : filledPrice;
      const r2 = reanchorSlTpToFill({ isLong, anchorPx, filledPx: filledPrice, stopPx, tpPx });
      stopPx = r2.stopPx;
      tpPx = r2.tpPx;

      const closeSide = isLong ? "SELL" : "BUY";
      let markRef = filledPrice;
      try {
        const pi = await publicGet("/fapi/v1/premiumIndex", { symbol });
        const mp = Number(pi?.markPrice);
        if (Number.isFinite(mp) && mp > 0) markRef = mp;
      } catch {
        // use filledPrice
      }
      const refined = refineUsdMTriggersVsMark({ isLong, stopPx, tpPx, markPrice: markRef, meta: m });
      if (refined.adjusted) {
        log?.info?.("binance_demo_futures_sltp_refined_vs_mark", {
          symbol,
          markPrice: markRef,
          beforeStop: stopPx,
          beforeTp: tpPx,
          afterStop: refined.stopPx,
          afterTp: refined.tpPx,
        });
      }
      stopPx = refined.stopPx;
      tpPx = refined.tpPx;
      const { stopStr, tpStr, slLimitStr, tpLimitStr } = usdmBracketPriceStrings({
        isLong,
        stopPx,
        tpPx,
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
          logPrefix: "binance_demo_futures",
        });
        bracketsPlaced = true;
      } catch (e) {
        const is4120 = futuresOrderIs4120(e);
        if (is4120) {
          log?.warn?.("binance_demo_futures_brackets_unsupported_using_local", {
            symbol,
            stopLoss: stopPx,
            takeProfit: tpPx,
          });
          mem.localBrackets[symbol] = {
            posId,
            isLong,
            entryPrice: filledPrice,
            stopLoss: stopPx,
            takeProfit: tpPx,
            qty: executedQty,
            closeSide,
            strategy: strategy || "AUTO",
            openedAt: Date.now(),
            leverage,
            positionSide: hedgeExtras.positionSide,
          };
        } else {
          log?.warn?.("binance_demo_futures_bracket_failed_flatten", { symbol, error: String(e?.message || e) });
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

      mem.trades.push({
        type: "OPEN",
        id: posId,
        ts: new Date().toISOString(),
        symbol,
        side,
        qty: Number(qtyStr),
        price: filledPrice,
        stopLoss: stopPx,
        takeProfit: tpPx,
        leverage,
        strategy: strategy || "AUTO",
        meta: { ...(meta || {}), leverage, venue: "FUTURES" },
      });
      if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);

      return { id: posId, filledPrice, leverage, venue: "FUTURES", raw: out, strategy, meta: meta || {} };
    },
    async markToMarket({ symbol, price } = {}) {
      await syncRealizedIncomeFromExchange();

      // Local SL/TP enforcement for positions where exchange brackets failed (-4120)
      const markPx = Number(price);
      if (symbol && Number.isFinite(markPx) && markPx > 0 && mem.localBrackets[symbol]) {
        const b = mem.localBrackets[symbol];
        // Sanity check: reject stale prices from symbol switches.
        // Valid range: bracket levels ±10% — tighter than entry-based check to catch
        // cross-symbol data leaks during AUTO mode symbol rotation.
        const bracketLo = Math.min(b.stopLoss, b.takeProfit) * 0.90;
        const bracketHi = Math.max(b.stopLoss, b.takeProfit) * 1.10;
        if (markPx < bracketLo || markPx > bracketHi) {
          // Price is outside the bracket band — likely stale data from another symbol
        } else {
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
            log?.info?.("binance_demo_futures_local_bracket_hit", { symbol, hit, markPx, sl: b.stopLoss, tp: b.takeProfit });
            // Record the close so income sync attributes PnL to strategy (not ledger).
            // The actual CLOSE trade will be created by syncRealizedIncomeFromExchange
            // when the REALIZED_PNL row arrives, with the real PnL from Binance.
            mem.recentLocalCloses.push({
              symbol,
              closedAt: Date.now(),
              closeSide: b.closeSide,
              strategy: b.strategy,
              bracketType: hit,
              posId: b.posId,
              qty: b.qty,
              entryPrice: b.entryPrice,
              stopLoss: b.stopLoss,
              takeProfit: b.takeProfit,
              leverage: b.leverage,
              markPx: Number(markPx),
            });
            delete mem.localBrackets[symbol];
          } catch (e) {
            log?.warn?.("binance_demo_futures_local_bracket_close_failed", { symbol, hit, error: String(e?.message || e) });
          }
        }
        } // end else (price sanity ok)
      }
    },
    async closePosition({ id }) {
      if (!apiKey || !apiSecret) return { ok: false, error: "binance_demo_futures_missing_keys" };
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
            entryPrice: Number(p.entryPrice || 0),
            leverage: Number(p.leverage || 0),
          }));
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      const sid = String(id || "");
      const symFromId = sid.startsWith("fut_") ? sid.slice(4) : sid;
      const p = positions.find((x) => x.symbol === symFromId || x.symbol === sid);
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
      let strat = "MANUAL_CLOSE";
      let openLeg = null;
      for (let i = mem.trades.length - 1; i >= 0; i--) {
        const tr = mem.trades[i];
        if (tr.type === "OPEN" && String(tr.symbol) === p.symbol) {
          openLeg = tr;
          strat = tr.strategy || "AUTO";
          break;
        }
      }
      const lev =
        Number(openLeg?.meta?.leverage) > 0
          ? Number(openLeg.meta.leverage)
          : Number(p.leverage) > 0
            ? Number(p.leverage)
            : undefined;
      mem.recentLocalCloses.push({
        symbol: p.symbol,
        closedAt: Date.now(),
        closeSide,
        strategy: strat,
        bracketType: "MANUAL_CLOSE",
        posId: sid,
        qty: p.qty,
        entryPrice: Number(p.entryPrice) || undefined,
        stopLoss: openLeg?.stopLoss != null ? Number(openLeg.stopLoss) : undefined,
        takeProfit: openLeg?.takeProfit != null ? Number(openLeg.takeProfit) : undefined,
        leverage: lev,
      });
      delete mem.localBrackets[p.symbol];
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
      return { udf: { ok: true, syncMode: "rest", error: null } };
    },
  };
}

