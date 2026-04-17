import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { resolveDefaultLiveFuturesIncomeSyncPath } from "../../lib/tradingModePersistence.js";
import { tradeCloseFeeUsdtFromNotional } from "../../lib/tradeCloseFee.js";
import { refineUsdMTriggersVsMark, usdmBracketPriceStrings } from "../../lib/binanceFuturesBracketPrices.js";
import { placeUsdMSlTpAfterMarketEntry, futuresOrderIs4120 } from "../../lib/binanceFuturesSlTpBracket.js";
import { applyTrailingStopBinanceMemory } from "../../lib/trailingStopLoss.js";
import {
  inferSlTpFromMark,
  pickBracketTargets,
  reconcileUsdMExternalClosesFromPositions,
} from "../../lib/binanceUsdmExternalCloseReconcile.js";
import { avgFillPriceFromUsdMNewOrder, slTpFromLastOpenTrade } from "../../lib/binanceUsdMOrderFill.js";
import {
  buildSyntheticImmediateAfterOpenCloseRow,
  postOpenStableProbeMs,
  verifyUsdMPositionAfterOpen,
} from "../../lib/binanceUsdmPositionVerify.js";
import { buildRiskSlTpTriggerActivity } from "../../lib/activityLog.js";
import {
  mergeSlTpSymbolMaps,
  normalizeAlgoOrdersPayload,
  slTpFromAlgoOrdersList,
  slTpFromOpenOrdersList,
} from "../../lib/binanceFuturesOpenOrdersSlTp.js";
import { evalTrailingForSymbolUsdM } from "../../lib/binanceUsdMTrailSlReplace.js";
import {
  closeReasonFromLocalCloseHint,
  positionSideAtOpenFromCloseSide,
  trailCloseFieldsFromMemory,
} from "../../lib/binanceUsdmCloseReasonHint.js";
import { TRAIL_TIER_SCHEMA_VERSION } from "../../lib/supertrendTrailingSl.js";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** Latest OPEN for symbol carrying Binance `orderId` on `meta` (USD-M market entry). */
function lastOpenBinanceEntryMetaForSymbol(trades, symU) {
  const U = String(symU || "").toUpperCase();
  if (!Array.isArray(trades)) return null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const tr = trades[i];
    if (tr?.type === "OPEN" && String(tr.symbol || "").toUpperCase() === U) {
      const m = tr.meta || {};
      const oid = m.orderId ?? m.binanceOrderId;
      if (oid != null && String(oid).trim() !== "" && String(oid) !== "undefined") {
        return {
          orderId: String(oid),
          clientOrderId:
            m.clientOrderId != null && String(m.clientOrderId).trim() !== "" ? String(m.clientOrderId) : null,
        };
      }
    }
  }
  return null;
}

/** Best-effort tier seed after restart from last OPEN row meta (if persisted). */
function trailingSeedFromLastOpenTrade(trades, symU) {
  const U = String(symU || "").toUpperCase();
  if (!Array.isArray(trades)) return { trailStep: 0, confirmedTrailStep: 0 };
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t?.type !== "OPEN" || String(t.symbol || "").toUpperCase() !== U) continue;
    const m = t.meta || {};
    const confirmed = Math.max(0, Math.floor(Number(m.confirmedTrailStep) || 0));
    const step = Math.max(0, Math.floor(Number(m.trailStep) || 0));
    return {
      trailStep: Math.max(step, confirmed),
      confirmedTrailStep: confirmed,
    };
  }
  return { trailStep: 0, confirmedTrailStep: 0 };
}

export function createBinanceLiveFuturesUsdMExchange({ log }) {
  // Prefer BINANCE_LIVE_FUTURES_*; else same BINANCE_LIVE_* as spot.
  const apiKey = process.env.BINANCE_LIVE_FUTURES_API_KEY || process.env.BINANCE_LIVE_API_KEY || "";
  const apiSecret = process.env.BINANCE_LIVE_FUTURES_API_SECRET || process.env.BINANCE_LIVE_API_SECRET || "";
  const baseURL = process.env.BINANCE_LIVE_FUTURES_REST_BASE || "https://fapi.binance.com";
  const defaultLeverage = Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5)));

  const http = axios.create({
    baseURL,
    timeout: 10_000,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  /** Per-symbol SL/TP from open orders (2s TTL). Scoped GETs avoid missing older SL legs in unpaged “all symbols” responses. */
  const slTpOpenOrdersCacheBySym = new Map();

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
      const msg = body?.msg || body?.message || e?.message || "binance_live_futures_request_failed";
      const code = body?.code;
      const err = new Error(`binance_live_futures_http_${method}_${path}:${status ?? "?"}:${code ?? "?"}:${msg}`);
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

  function isBinanceMaxPositionAtLevError(e) {
    const s = String(e?.message || e || "");
    return s.includes(":-2027:") || s.toLowerCase().includes("maximum allowable position");
  }

  async function maxPositionNotionalCapForLeverage(symbol, lev) {
    const u = String(symbol || "").toUpperCase();
    const L = Math.max(1, Math.min(125, Math.floor(Number(lev) || 1)));
    try {
      const raw = await signed("GET", "/fapi/v1/leverageBracket", { symbol: u });
      const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const row = rows.find((r) => String(r?.symbol || "").toUpperCase() === u) || rows[0];
      const br = Array.isArray(row?.brackets) ? row.brackets : [];
      if (!br.length) return null;
      let best = null;
      let bestD = 1e18;
      for (const b of br) {
        const il = Number(b?.initialLeverage);
        const cap = Number(b?.notionalCap);
        if (!Number.isFinite(il) || !Number.isFinite(cap) || cap <= 0) continue;
        const d = Math.abs(il - L);
        if (d < bestD) {
          bestD = d;
          best = cap;
        }
      }
      return best != null ? Number(best) : null;
    } catch {
      return null;
    }
  }

  async function currentPositionNotionalUsd(symbol) {
    const u = String(symbol || "").toUpperCase();
    try {
      const a = await signed("GET", "/fapi/v2/account");
      const ps = Array.isArray(a?.positions) ? a.positions : [];
      const p = ps.find((x) => String(x?.symbol || "").toUpperCase() === u);
      const amt = Math.abs(Number(p?.positionAmt || 0));
      if (!(amt > 1e-12)) return 0;
      let px = Number(p?.markPrice || 0);
      if (!Number.isFinite(px) || px <= 0) {
        const pi = await publicGet("/fapi/v1/premiumIndex", { symbol: u }).catch(() => null);
        px = Number(pi?.markPrice || 0);
      }
      if (!Number.isFinite(px) || px <= 0) return 0;
      return amt * px;
    } catch {
      return 0;
    }
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
    if (!s) throw new Error(`binance_live_futures_exchangeinfo_missing_symbol:${key}`);
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
    log?.info?.("binance_live_futures_symbol_meta", {
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

  /** Like `formatToStep` but rounds **up** to the next valid lot so manual $ notional is not floored to zero. */
  function formatToStepCeil(qty, meta) {
    const stepStr = meta?.qtyStepSize || meta?.stepSize;
    const q = Number(qty);
    const stepNum = Number(stepStr);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(stepNum) || stepNum <= 0) return null;
    const dec = filterFractionalDigits(stepStr);
    const scaleExp = Math.min(dec, 15);
    const scale = 10 ** scaleExp;
    const stepUnits = Math.round(stepNum * scale);
    if (stepUnits <= 0) return null;
    const qUnits = Math.ceil((q * scale) / stepUnits - 1e-9) * stepUnits;
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

  /** Floor to tick — max price willing to pay for BUY limit (never above cap). */
  function formatToTickFloor(px, meta) {
    const tickStr = meta?.tickSize;
    const p = Number(px);
    const tickNum = Number(tickStr);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(tickNum) || tickNum <= 0) return null;
    const dec = filterFractionalDigits(tickStr);
    const scaleExp = Math.min(dec, 15);
    const scale = 10 ** scaleExp;
    const tickUnits = Math.round(tickNum * scale);
    if (tickUnits <= 0) return null;
    const pUnits = Math.floor((p * scale) / tickUnits + 1e-12) * tickUnits;
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

  /** Ceil to tick — min price willing to accept for SELL limit (short entry). */
  function formatToTickCeil(px, meta) {
    const tickStr = meta?.tickSize;
    const p = Number(px);
    const tickNum = Number(tickStr);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(tickNum) || tickNum <= 0) return null;
    const dec = filterFractionalDigits(tickStr);
    const scaleExp = Math.min(dec, 15);
    const scale = 10 ** scaleExp;
    const tickUnits = Math.round(tickNum * scale);
    if (tickUnits <= 0) return null;
    const pUnits = Math.ceil((p * scale) / tickUnits - 1e-12) * tickUnits;
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
      log?.warn?.("binance_live_futures_set_leverage_failed", { symbol, leverage, error: String(e?.message || e) });
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
  async function stopTakeFromExchangeOpenOrders(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const now = Date.now();
    const hit = slTpOpenOrdersCacheBySym.get(sym);
    if (hit && now - hit.at < 2000) return { sl: hit.sl, tp: hit.tp };
    let sl = null;
    let tp = null;
    try {
      const [all, algoRaw] = await Promise.all([
        signed("GET", "/fapi/v1/openOrders", { symbol: sym }).catch(() => []),
        signed("GET", "/fapi/v1/openAlgoOrders", { symbol: sym, algoType: "CONDITIONAL" }).catch(() => []),
      ]);
      const parsed = slTpFromOpenOrdersList(Array.isArray(all) ? all : []);
      const parsedAlgo = slTpFromAlgoOrdersList(algoRaw);
      const merged = mergeSlTpSymbolMaps(parsed, parsedAlgo);
      const row = merged.get(sym) || { sl: null, tp: null };
      sl = row.sl;
      tp = row.tp;
    } catch (e) {
      log?.warn?.("binance_live_futures_open_orders_failed", { error: String(e?.message || e) });
    }
    slTpOpenOrdersCacheBySym.set(sym, { at: now, sl, tp });
    return { sl, tp };
  }

  const incomeSyncPath = resolveDefaultLiveFuturesIncomeSyncPath();
  /** When false (default), REALIZED_PNL rows that don’t match an app/session close are not added as trade rows — same “strategy-first” view as typical demo UX; income still updates matched closes. Set BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED=1 to debug / see full ledger in history. */
  const includeUnmatchedIncomeLedger =
    String(process.env.BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED || "0") === "1";
  const bootIncomeLookbackMs = Math.max(
    60_000,
    Math.min(24 * 3600 * 1000, Number(process.env.BINANCE_LIVE_FUT_INCOME_BOOT_LOOKBACK_MS || 600_000))
  ); // default 10 min — never pull full account history as “new” closes

  const mem = {
    trades: [],
    seenIncomeIds: new Set(),
    /** @type {number | null} */
    incomeCursorMs: null,
    lastIncomePollAt: 0,
    /** SL/TP targets when exchange-side brackets couldn't be placed (-4120 / exchange limitation) */
    localBrackets: {},
    /** Last SL/TP we placed when exchange brackets succeeded (open-order parsing can still miss fields). */
    placedBracketTargets: {},
    /** Recent local bracket closes — income sync uses these to attribute PnL to strategy, not ledger */
    recentLocalCloses: [],
    trailingBySymbol: {},
    /** Last `/fapi/v2/account` positions array (shallow-cloned rows) — trailing qty + restart reconstruction */
    lastPositionSnapshot: [],
    /** Last `/fapi/v2/account` position qty by symbol — detect exchange-native closes (SL/TP) for income + history sync */
    prevFuturesQtyBySymbol: {},
  };

  const trailSymLock = new Set();

  /** Qty from last position snapshot — no extra API call per symbol during trailing. */
  function qtyAbsFromSnapshot(symU) {
    if (!Array.isArray(mem.lastPositionSnapshot) || !mem.lastPositionSnapshot.length) return NaN;
    const p = mem.lastPositionSnapshot.find((r) => String(r?.symbol || "").toUpperCase() === symU);
    if (!p) return 0;
    return Math.abs(Number(p.positionAmt || 0));
  }

  /** Exchange-native SL/TP closes do not hit `localBrackets` — drop orphan trail/bracket memory. */
  function clearMemBracketTrailForSymbol(symU) {
    const u = String(symU || "").toUpperCase();
    delete mem.trailingBySymbol[u];
    for (const k of Object.keys(mem.localBrackets)) {
      if (String(k).toUpperCase() === u) delete mem.localBrackets[k];
    }
    for (const k of Object.keys(mem.placedBracketTargets)) {
      if (String(k).toUpperCase() === u) delete mem.placedBracketTargets[k];
    }
  }

  const MAX_MEM_TRADES = 800;

  function loadIncomeSyncFromDisk() {
    try {
      if (!fs.existsSync(incomeSyncPath)) return;
      const raw = JSON.parse(fs.readFileSync(incomeSyncPath, "utf8"));
      if (raw.incomeCursorMs != null) mem.incomeCursorMs = Number(raw.incomeCursorMs);
      for (const id of (raw.seenTranIds || []).slice(-8000)) mem.seenIncomeIds.add(String(id));
    } catch (e) {
      log?.warn?.("binance_live_futures_income_sync_load_failed", { error: String(e?.message || e) });
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
      log?.warn?.("binance_live_futures_income_sync_save_failed", { error: String(e?.message || e) });
    }
  }

  loadIncomeSyncFromDisk();

  async function refreshUsdMPositionSnapshotAndReconcile() {
    if (!apiKey || !apiSecret) return;
    try {
      const a = await signed("GET", "/fapi/v2/account");
      const ps = Array.isArray(a?.positions) ? a.positions : [];
      mem.lastPositionSnapshot = ps.map((p) => (p && typeof p === "object" ? { ...p } : p));
      await reconcileUsdMExternalClosesFromPositions(
        { mem, publicGet, clearMemBracketTrailForSymbol, log },
        ps,
      );
    } catch (e) {
      log?.warn?.("binance_live_futures_position_reconcile_failed", { error: String(e?.message || e) });
    }
  }

  async function syncRealizedIncomeFromExchange() {
    if (!apiKey || !apiSecret) return;
    await refreshUsdMPositionSnapshotAndReconcile();
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
      log?.warn?.("binance_live_futures_income_poll_failed", { error: String(e?.message || e) });
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
    // Expire local close hints (manual close + local SL/TP) — income can lag vs fills
    const LOCAL_CLOSE_TTL_MS = Math.max(
      120_000,
      Math.min(600_000, Number(process.env.BINANCE_LIVE_INCOME_MATCH_TTL_MS || 300_000))
    );
    const nowLc = Date.now();
    mem.recentLocalCloses = mem.recentLocalCloses.filter((c) => nowLc - c.closedAt < LOCAL_CLOSE_TTL_MS);

    /** Income rows more than this *before* our local close are older trades — do not bind to `recentLocalCloses`. */
    const INCOME_PRE_CLOSE_SKEW_MS = Math.max(
      30_000,
      Math.min(600_000, Number(process.env.BINANCE_LIVE_INCOME_PRE_CLOSE_SKEW_MS || 120_000))
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
          const reasonMissing =
            mergeInto.reason == null || String(mergeInto.reason).trim() === "";
          const oldReasonU = String(mergeInto.reason || "").trim().toUpperCase();
          const hinted = lc ? closeReasonFromLocalCloseHint(lc) : "";
          const staleReason =
            oldReasonU === "" ||
            oldReasonU === "STOP_LOSS_DEFAULT" ||
            (hinted.startsWith("TRAILED_") && !oldReasonU.startsWith("TRAILED_"));
          if (lc && (reasonMissing || staleReason) && hinted) {
            mergeInto.reason = hinted;
          }
          if (lc && mergeInto.meta && typeof mergeInto.meta === "object") {
            mergeInto.meta.exitViaTrailedStop = lc.exitViaTrailedStop === true;
            mergeInto.meta.trailStepAtClose = lc.trailStepAtClose;
            if (lc.confirmedTrailStepAtClose != null) {
              mergeInto.meta.confirmedTrailStepAtClose = Number(lc.confirmedTrailStepAtClose);
            }
            if (lc.trailTierAtClose != null) mergeInto.meta.trailTierAtClose = String(lc.trailTierAtClose);
            if (lc.trailStepLabelStyleAtClose != null) {
              mergeInto.meta.trailStepLabelStyleAtClose = String(lc.trailStepLabelStyleAtClose);
            }
            if (lc.trailingMode != null) mergeInto.meta.trailingMode = String(lc.trailingMode);
            if (lc.positionSideAtOpen != null && String(lc.positionSideAtOpen).trim() !== "") {
              mergeInto.meta.positionSideAtOpen = String(lc.positionSideAtOpen).trim();
            }
            mergeInto.meta.supertrendSignalClose =
              lc.strategyCloseReason === "SUPERTREND_EXIT" || lc.strategyCloseReason === "SUPERTREND_FLIP";
            if (mergeInto.reason != null && String(mergeInto.reason).trim() !== "") {
              mergeInto.meta.closeReason = String(mergeInto.reason);
            }
          }
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
          // Keep CLOSE id unique; fut_<sym> is shared across round-trips and collapses merged trade history.
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
          const reasonNorm = closeReasonFromLocalCloseHint(lc);
          mem.trades.push({
            type: "CLOSE",
            id: `finc_${tid}`,
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
            reason: reasonNorm,
            meta: {
              source: "fapi_income",
              incomeType: row.incomeType || "REALIZED_PNL",
              tranId: tid,
              tranIds: [tid],
              closeReason: reasonNorm,
              bracketType: lc.bracketType,
              trailingMode: lc.trailingMode != null ? String(lc.trailingMode) : undefined,
              localEnforcement: true,
              localCloseKey,
              _incomeEventMs: eventMs,
              leverage: lc.leverage != null ? Number(lc.leverage) : undefined,
              exitPrice: lc.markPx != null ? Number(lc.markPx) : undefined,
              exitViaTrailedStop: lc.exitViaTrailedStop === true,
              trailStepAtClose: lc.trailStepAtClose,
              trailTierAtClose: lc.trailTierAtClose != null ? String(lc.trailTierAtClose) : undefined,
              supertrendSignalClose:
                lc.strategyCloseReason === "SUPERTREND_EXIT" || lc.strategyCloseReason === "SUPERTREND_FLIP",
              ...(lc.positionSideAtOpen != null && String(lc.positionSideAtOpen).trim() !== ""
                ? { positionSideAtOpen: String(lc.positionSideAtOpen).trim() }
                : {}),
            },
          });
        }
      } else if (includeUnmatchedIncomeLedger) {
        let openRef = null;
        for (let j = mem.trades.length - 1; j >= 0; j--) {
          const tr = mem.trades[j];
          if (tr?.type === "OPEN" && String(tr.symbol || "").toUpperCase() === sym) {
            openRef = tr;
            break;
          }
        }
        const refLev = openRef?.meta?.leverage ?? openRef?.leverage;
        const refQty = openRef?.qty;
        const refEntry = openRef?.price ?? openRef?.entryPrice;
        const refSl = openRef?.stopLoss;
        const refTp = openRef?.takeProfit;
        const refSide = openRef?.side;
        const closeSide = refSide === "BUY" ? "SELL" : refSide === "SELL" ? "BUY" : "—";
        const feePx = refQty != null && Number.isFinite(Number(refEntry)) ? Number(refEntry) : NaN;
        const fee = tradeCloseFeeUsdtFromNotional(Number(refQty), feePx);
        let markPxLedger = NaN;
        if (typeof publicGet === "function") {
          try {
            const d = await publicGet("/fapi/v1/premiumIndex", { symbol: sym });
            markPxLedger = Number(d?.markPrice);
          } catch {
            /* ignore */
          }
        }
        const isLong = refSide === "BUY";
        let inferredBracket = null;
        let reasonLedger = "EXCHANGE_REALIZED";
        if (openRef && Number.isFinite(markPxLedger) && markPxLedger > 0) {
          inferredBracket = inferSlTpFromMark(isLong, markPxLedger, refSl, refTp);
          if (inferredBracket === "TP") reasonLedger = "TAKE_PROFIT";
          else if (inferredBracket === "SL") reasonLedger = "STOP_LOSS";
        }
        mem.trades.push({
          type: "CLOSE",
          id: `finc_${tid}`,
          ts: tsIso,
          symbol: sym,
          side: closeSide,
          qty: refQty != null ? Number(refQty) : undefined,
          price: Number.isFinite(markPxLedger) && markPxLedger > 0 ? markPxLedger : undefined,
          entryPrice: refEntry != null ? Number(refEntry) : undefined,
          stopLoss: refSl != null ? Number(refSl) : undefined,
          takeProfit: refTp != null ? Number(refTp) : undefined,
          leverage: refLev != null ? Number(refLev) : undefined,
          pnl,
          fee: fee ?? undefined,
          strategy: openRef?.strategy || "INCOME_LEDGER",
          reason: reasonLedger,
          ledgerEvent: true,
          meta: {
            source: "fapi_income",
            incomeType: row.incomeType || "REALIZED_PNL",
            tranId: tid,
            note: "realized_pnl_ledger_row",
            leverage: refLev != null ? Number(refLev) : undefined,
            openRefId: openRef?.id,
            closeReason: reasonLedger,
            ...(inferredBracket ? { bracketType: inferredBracket, exitInferredFromMark: true } : {}),
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
    name: "binance_live_futures_usdm",
    supportsAutoTrading: true,
    storeInfo: { baseURL, note: "USD-M Futures (mainnet — real funds)" },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_live_futures_missing_keys");
      const a = await signed("GET", "/fapi/v2/account");
      const equity = Number(a?.totalWalletBalance || 0);
      const free = Number(a?.availableBalance || 0);
      return { equity, freeBalance: free, dailyStartEquity: null, dailyPnlPct: 0, leverage: defaultLeverage };
    },
    async getPositions() {
      try {
        const a = await signed("GET", "/fapi/v2/account");
        const ps = Array.isArray(a?.positions) ? a.positions : [];
        await reconcileUsdMExternalClosesFromPositions({ mem, publicGet, clearMemBracketTrailForSymbol, log }, ps);
        const rows = ps
          .filter((p) => Math.abs(Number(p?.positionAmt || 0)) > 1e-8)
          .map((p) => {
            const sym = p.symbol;
            const lb = pickBracketTargets(mem.localBrackets, sym);
            const pb = pickBracketTargets(mem.placedBracketTargets, sym);
            const lev = Number(p.leverage || defaultLeverage);
            return { sym, lb, pb, lev, p };
          });
        const out = [];
        for (const { sym, lb, pb, lev, p } of rows) {
          const oo = await stopTakeFromExchangeOpenOrders(sym);
          const symU = String(sym || "").toUpperCase();
          const trail = pickBracketTargets(mem.trailingBySymbol, sym);
          const entryEx = lastOpenBinanceEntryMetaForSymbol(mem.trades, symU);
          const openSlTp = slTpFromLastOpenTrade(mem.trades, symU);
          const row = {
            id: `fut_${sym}`,
            symbol: sym,
            side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
            qty: Math.abs(Number(p.positionAmt)),
            entryPrice: Number(p.entryPrice || 0),
            unrealizedPnl: Number(p.unrealizedProfit || 0),
            stopLoss: oo.sl ?? lb?.stopLoss ?? pb?.stopLoss ?? openSlTp.sl ?? null,
            takeProfit: oo.tp ?? lb?.takeProfit ?? pb?.takeProfit ?? openSlTp.tp ?? null,
            leverage: Number.isFinite(lev) && lev > 0 ? lev : defaultLeverage,
            venue: "FUTURES",
            syncSource: "fapi_v2_account",
            updateTime: Number(p.updateTime) || null,
          };
          const entryMeta =
            entryEx != null
              ? {
                  binanceEntryOrderId: entryEx.orderId,
                  ...(entryEx.clientOrderId ? { binanceClientOrderId: entryEx.clientOrderId } : {}),
                }
              : {};
          if (trail && trail.entryPrice) {
            row.meta = {
              ...entryMeta,
              autoTradeTrailing: true,
              trailStep: Number(trail.trailStep) || 0,
              confirmedTrailStep: Math.max(0, Math.floor(Number(trail.confirmedTrailStep) || 0)),
              extremePx: trail.extremePx,
              trailTierLabel: trail.trailTierLabel ?? null,
              ...(trail.slTrailConfirm ? { trailSlConfirm: { ...trail.slTrailConfirm } } : {}),
            };
            row.trailTierLabel = trail.trailTierLabel ?? null;
          } else if (Object.keys(entryMeta).length) {
            row.meta = entryMeta;
          }
          out.push(row);
        }
        return out;
      } catch (e) {
        log?.warn?.("binance_live_futures_positions_failed", { error: String(e?.message || e) });
        return [];
      }
    },
    async getTrades() {
      await refreshUsdMPositionSnapshotAndReconcile();
      await syncRealizedIncomeFromExchange();
      let rows = mem.trades.slice(-MAX_MEM_TRADES);
      if (!includeUnmatchedIncomeLedger) {
        rows = rows.filter(
          (t) =>
            !(
              t?.ledgerEvent === true ||
              String(t?.strategy ?? "").toUpperCase() === "INCOME_LEDGER" ||
              t?.meta?.note === "realized_pnl_ledger_row"
            )
        );
      }
      return rows;
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) throw new Error("binance_live_futures_missing_keys");
      const isLong = side === "BUY";
      if (side !== "BUY" && side !== "SELL") throw new Error("bad_side");

      const symNorm = String(symbol || "").toUpperCase();
      const m = await getOrLoadSymbolMeta(symNorm);
      let qtyStr = formatToStep(qty, m);
      if (!qtyStr && meta?.manual === true) {
        qtyStr = formatToStepCeil(qty, m);
      }
      if (!qtyStr) {
        const step = m?.qtyStepSize || m?.stepSize || "?";
        const qn = Number(qty);
        const pxh = Number(price);
        const approxMin = Number.isFinite(qn) && Number.isFinite(pxh) && pxh > 0 ? (Number(step) || 0) * pxh : null;
        throw new Error(
          `invalid_qty: futures size ${qn} is below lot step ${step} for ${symNorm}` +
            (approxMin != null && Number.isFinite(approxMin)
              ? ` — need roughly ≥ ${approxMin.toFixed(2)} USDT notional at this price (increase Amount USD), or use a smaller-priced symbol`
              : " — increase Amount (USD)")
        );
      }

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

      const leverage = await ensureLeverage(symNorm, meta?.futuresLeverage || meta?.leverage || defaultLeverage);
      const hedgeExtras = await hedgePositionSideExtras(isLong);

      const entryStyle = String(meta?.entryOrderStyle || "MARKET").toUpperCase();

      let out;
      if (entryStyle === "LIMIT_IOC") {
        const limRaw = Number(meta?.entryLimitPrice);
        if (!Number.isFinite(limRaw) || limRaw <= 0) throw new Error("limit_ioc_requires_meta.entryLimitPrice");
        const priceStr = isLong ? formatToTickFloor(limRaw, m) : formatToTickCeil(limRaw, m);
        if (!priceStr) throw new Error("limit_ioc_bad_price_tick");
        out = await signed("POST", "/fapi/v1/order", {
          symbol: symNorm,
          side,
          type: "LIMIT",
          timeInForce: "IOC",
          quantity: qtyStr,
          price: priceStr,
          /** Default ACK can return executedQty 0 before fill is finalized; RESULT returns FILLED/EXPIRED with correct qty. */
          newOrderRespType: "RESULT",
          newClientOrderId: `ai_ioc_${Date.now()}`,
          ...hedgeExtras,
        });
        const exQ = Math.max(Number(out?.executedQty ?? 0), Number(out?.cumQty ?? 0));
        if (!Number.isFinite(exQ) || exQ <= 0) {
          throw new Error("limit_ioc_no_fill");
        }
      } else {
        try {
          out = await signed("POST", "/fapi/v1/order", {
            symbol: symNorm,
            side,
            type: "MARKET",
            quantity: qtyStr,
            newClientOrderId: `ai_${Date.now()}`,
            ...hedgeExtras,
          });
        } catch (e) {
          if (!isBinanceMaxPositionAtLevError(e)) throw e;
          const cap = await maxPositionNotionalCapForLeverage(symNorm, leverage);
          const curNotional = await currentPositionNotionalUsd(symNorm);
          let pxUse = Number.isFinite(markPx) && markPx > 0 ? markPx : null;
          if (!pxUse) {
            const pi = await publicGet("/fapi/v1/premiumIndex", { symbol: symNorm }).catch(() => null);
            const mp = Number(pi?.markPrice);
            if (Number.isFinite(mp) && mp > 0) pxUse = mp;
          }
          const desiredNotional = pxUse != null ? Number(qtyStr) * pxUse : null;
          const remaining = cap != null ? Math.max(0, cap - curNotional) : 0;
          if (!pxUse || !(remaining > 0)) throw e;
          const qty2 = remaining / pxUse;
          let qtyStr2 = formatToStep(qty2, m);
          if (!qtyStr2 && meta?.manual === true) qtyStr2 = formatToStepCeil(qty2, m);
          if (!qtyStr2 || Number(qtyStr2) <= 0) throw e;
          if (m.minNotional && Number(qtyStr2) * pxUse + 1e-8 < Number(m.minNotional)) throw e;
          log?.warn?.("binance_live_futures_downsize_max_position", {
            symbol: symNorm,
            leverage,
            capNotional: cap,
            currentNotional: curNotional,
            desiredNotional,
            remainingNotional: remaining,
            qtyRequested: Number(qtyStr),
            qtyUsed: Number(qtyStr2),
          });
          out = await signed("POST", "/fapi/v1/order", {
            symbol: symNorm,
            side,
            type: "MARKET",
            quantity: qtyStr2,
            newClientOrderId: `ai_cap_${Date.now()}`,
            ...hedgeExtras,
          });
          qtyStr = qtyStr2;
        }
      }

      const orderId = String(out?.orderId || Date.now());
      const filledPrice = avgFillPriceFromUsdMNewOrder(out, markPx);
      /** Match `getPositions()` id (`fut_${symbol}`) so UI open trades ↔ positions links for indicator/AI fills. */
      const posId = `fut_${symNorm}`;

      // Use executed qty for bracket legs (handles partial fills)
      const executedQty = formatToStep(Number(out?.executedQty || out?.origQty || qty), m) || qtyStr;

      const anchorPx = Number.isFinite(markPx) && markPx > 0 ? markPx : filledPrice;
      const r2 = reanchorSlTpToFill({ isLong, anchorPx, filledPx: filledPrice, stopPx, tpPx });
      stopPx = r2.stopPx;
      tpPx = r2.tpPx;

      const closeSide = isLong ? "SELL" : "BUY";
      let markRef = filledPrice;
      try {
        const pi = await publicGet("/fapi/v1/premiumIndex", { symbol: symNorm });
        const mp = Number(pi?.markPrice);
        if (Number.isFinite(mp) && mp > 0) markRef = mp;
      } catch {
        // use filledPrice
      }
      const refined = refineUsdMTriggersVsMark({ isLong, stopPx, tpPx, markPrice: markRef, meta: m });
      if (refined.adjusted) {
        log?.info?.("binance_live_futures_sltp_refined_vs_mark", {
          symbol: symNorm,
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
          symbol: symNorm,
          closeSide,
          stopStr,
          tpStr,
          slLimitStr,
          tpLimitStr,
          executedQty,
          hedgeExtras,
          log,
          logPrefix: "binance_live_futures",
        });
        bracketsPlaced = true;
        mem.placedBracketTargets[symNorm] = {
          stopLoss: stopPx,
          takeProfit: tpPx,
          closeSide,
          hedgeExtras: { ...hedgeExtras },
          qty: executedQty,
        };
      } catch (e) {
        const is4120 = futuresOrderIs4120(e);
        if (is4120) {
          log?.warn?.("binance_live_futures_brackets_unsupported_using_local", {
            symbol: symNorm,
            stopLoss: stopPx,
            takeProfit: tpPx,
          });
          mem.localBrackets[symNorm] = {
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
          log?.warn?.("binance_live_futures_bracket_failed_flatten", { symbol: symNorm, error: String(e?.message || e) });
          await signed("POST", "/fapi/v1/order", {
            symbol: symNorm,
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

      const clientOid = out?.clientOrderId != null && String(out.clientOrderId).trim() !== "" ? String(out.clientOrderId) : null;
      mem.trades.push({
        type: "OPEN",
        id: posId,
        ts: new Date().toISOString(),
        symbol: symNorm,
        side,
        qty: Number(qtyStr),
        price: filledPrice,
        stopLoss: stopPx,
        takeProfit: tpPx,
        leverage,
        strategy: strategy || "AUTO",
        meta: {
          ...(meta || {}),
          leverage,
          venue: "FUTURES",
          orderId,
          ...(clientOid ? { clientOrderId: clientOid } : {}),
        },
      });
      if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);

      if (meta?.autoTradeTrailing) {
        mem.trailingBySymbol[symNorm] = {
          entryPrice: filledPrice,
          isLong,
          trailStep: 0,
          confirmedTrailStep: 0,
          trailTierSchemaVersion: TRAIL_TIER_SCHEMA_VERSION,
          extremePx: filledPrice,
          leverage: Math.max(1, Math.min(100, Number(leverage) || 1)),
          _openedAt: Date.now(),
        };
      }

      const posCheck = await verifyUsdMPositionAfterOpen({ signed, symbol: symNorm });
      if (!posCheck.ok) {
        for (let i = mem.trades.length - 1; i >= 0; i--) {
          const t = mem.trades[i];
          if (t?.type === "OPEN" && String(t.id) === String(posId)) {
            mem.trades.splice(i, 1);
            break;
          }
        }
        for (const k of Object.keys(mem.trailingBySymbol || {})) {
          if (String(k).toUpperCase() === symNorm) delete mem.trailingBySymbol[k];
        }
        for (const k of Object.keys(mem.placedBracketTargets || {})) {
          if (String(k).toUpperCase() === symNorm) delete mem.placedBracketTargets[k];
        }
        for (const k of Object.keys(mem.localBrackets || {})) {
          if (String(k).toUpperCase() === symNorm) delete mem.localBrackets[k];
        }
        log?.warn?.("binance_live_futures_post_open_verify_flat", {
          symbol: symNorm,
          posId,
          absAmt: posCheck.absAmt,
        });
        throw new Error(
          `binance_live_futures_post_open_flat:${symNorm} — market reported a fill but /fapi/v2/account shows no open position (e.g. SL/TP triggered instantly, or exchange lag). Check Binance order history.`,
        );
      }

      let immediateCloseTrade = null;
      const stableMs = postOpenStableProbeMs();
      if (stableMs > 0) {
        await new Promise((r) => setTimeout(r, stableMs));
        const stableChk = await verifyUsdMPositionAfterOpen({ signed, symbol: symNorm, retries: 2, delayMs: 120 });
        if (!stableChk.ok) {
          const exitPx =
            Number.isFinite(markRef) && markRef > 0 ? markRef : Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : NaN;
          const qtyNum = Number(executedQty) || Number(qtyStr);
          immediateCloseTrade = buildSyntheticImmediateAfterOpenCloseRow({
            symbol: symNorm,
            symU: symNorm,
            posId,
            closeSide,
            qtyNum,
            filledPrice,
            exitPx,
            isLong,
            leverage,
            strategy,
          });
          mem.trades.push(immediateCloseTrade);
          if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);
          for (const k of Object.keys(mem.trailingBySymbol || {})) {
            if (String(k).toUpperCase() === symNorm) delete mem.trailingBySymbol[k];
          }
          for (const k of Object.keys(mem.placedBracketTargets || {})) {
            if (String(k).toUpperCase() === symNorm) delete mem.placedBracketTargets[k];
          }
          for (const k of Object.keys(mem.localBrackets || {})) {
            if (String(k).toUpperCase() === symNorm) delete mem.localBrackets[k];
          }
          log?.warn?.("binance_live_futures_post_open_immediate_flat", {
            symbol: symNorm,
            posId,
            stableMs,
            exitPx: immediateCloseTrade.price,
          });
        }
      }

      return {
        id: posId,
        filledPrice,
        leverage,
        venue: "FUTURES",
        stopLoss: stopPx,
        takeProfit: tpPx,
        raw: out,
        strategy,
        meta: meta || {},
        immediateCloseTrade,
      };
    },
    async markToMarket({ symbol, price, trailingStopLoss, onTrailingSlAdvance, notifyActivity } = {}) {
      await refreshUsdMPositionSnapshotAndReconcile();
      await syncRealizedIncomeFromExchange();

      const primarySymU = String(symbol || "").toUpperCase();

      async function markPxForSymbol(sym) {
        const u = String(sym || "").toUpperCase();
        // Always use exchange mark price for trailing decisions.
        // The bot passes candle close as `price`; that can differ from mark and causes missed tier advances
        // (UI shows mark crossing activation but server compares against close).
        try {
          const d = await publicGet("/fapi/v1/premiumIndex", { symbol: u });
          const m = Number(d?.markPrice);
          return Number.isFinite(m) && m > 0 ? m : NaN;
        } catch {
          return NaN;
        }
      }

      if (trailingStopLoss?.enabled) {
        if (Array.isArray(mem.lastPositionSnapshot)) {
          for (const p of mem.lastPositionSnapshot) {
            const qty = Number(p.positionAmt || 0);
            if (Math.abs(qty) < 1e-8) continue;
            const symU = String(p.symbol || "").toUpperCase();
            if (mem.trailingBySymbol[symU]) continue;
            const entryPx = Number(p.entryPrice || 0);
            if (!entryPx) continue;
            const posIsLong = qty > 0;
            const lev = Number(p.leverage || defaultLeverage);
            const seed = trailingSeedFromLastOpenTrade(mem.trades, symU);
            mem.trailingBySymbol[symU] = {
              entryPrice: entryPx,
              isLong: posIsLong,
              trailStep: seed.trailStep,
              confirmedTrailStep: seed.confirmedTrailStep,
              extremePx: entryPx,
              leverage: Math.max(1, Math.min(100, Number.isFinite(lev) && lev > 0 ? lev : defaultLeverage)),
              _reconstructed: true,
            };
            log?.info?.("binance_live_futures_trail_state_reconstructed", { symbol: symU, entryPx, isLong: posIsLong });
            if (!mem.placedBracketTargets[symU] && !mem.localBrackets[symU]) {
              try {
                const oo = await stopTakeFromExchangeOpenOrders(symU);
                if (oo.sl != null) {
                  const closeSideR = posIsLong ? "SELL" : "BUY";
                  const positionSideField = String(p.positionSide || "").toUpperCase();
                  const hedgeExtrasR =
                    positionSideField === "LONG" || positionSideField === "SHORT"
                      ? { positionSide: positionSideField }
                      : {};
                  mem.placedBracketTargets[symU] = {
                    stopLoss: oo.sl,
                    takeProfit: oo.tp ?? 0,
                    closeSide: closeSideR,
                    hedgeExtras: hedgeExtrasR,
                    qty: String(Math.abs(qty)),
                    _fromRestart: true,
                  };
                  log?.info?.("binance_live_futures_trail_bracket_seeded", { symbol: symU, sl: oo.sl, tp: oo.tp });
                }
              } catch {
                /* retry next tick */
              }
            }
          }
        }

        const trailSyms = [...new Set(Object.keys(mem.trailingBySymbol).map((k) => String(k || "").toUpperCase()))];

        const markPxResults = await Promise.allSettled(trailSyms.map((s) => markPxForSymbol(s)));
        const markPxBySymbol = new Map();
        trailSyms.forEach((s, i) => {
          const r = markPxResults[i];
          if (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0) markPxBySymbol.set(s, r.value);
        });

        const activeTrailSyms = trailSyms.filter((s) => {
          if (!mem.trailingBySymbol[s] || !markPxBySymbol.has(s)) return false;
          const qty = qtyAbsFromSnapshot(s);
          if (Number.isNaN(qty)) return false;
          if (qty < 1e-8) {
            clearMemBracketTrailForSymbol(s);
            return false;
          }
          return true;
        });

        const replaceCtxBase = {
          mem,
          signed,
          publicGet,
          getOrLoadSymbolMeta,
          defaultLeverage,
          log,
          logPrefix: "binance_live_futures",
          normalizeAlgoOrdersPayload,
          clearSlTpOpenOrdersCache: (symU) => {
            slTpOpenOrdersCacheBySym.delete(String(symU || "").toUpperCase());
          },
        };

        await Promise.all(
          activeTrailSyms.map((s) =>
            evalTrailingForSymbolUsdM({
              s,
              markPx: markPxBySymbol.get(s),
              trailingStopLoss,
              onTrailingSlAdvance,
              notifyActivity,
              primaryChartSymU: primarySymU,
              mem,
              applyTrailingStopBinanceMemory,
              getOrLoadSymbolMeta,
              signed,
              publicGet,
              defaultLeverage,
              trailSymLock,
              stopTakeFromExchangeOpenOrders,
              replaceCtxBase,
              log,
            }),
          ),
        );
      }

      for (const lbSym of Object.keys(mem.localBrackets)) {
        const markPx = await markPxForSymbol(lbSym);
        if (!Number.isFinite(markPx) || markPx <= 0) continue;
        const b = mem.localBrackets[lbSym];
        if (!b) continue;
        if (
          (b.strategy === "trailing_sl_safety" || b.strategy === "trailing_sl_breach") &&
          b._installedAt != null &&
          Date.now() - b._installedAt < 10_000
        ) {
          continue;
        }
        const bracketLo = Math.min(b.stopLoss, b.takeProfit) * 0.90;
        const bracketHi = Math.max(b.stopLoss, b.takeProfit) * 1.10;
        if (markPx < bracketLo || markPx > bracketHi) continue;
        let hit = null;
        if (b.isLong) {
          if (markPx <= b.stopLoss) hit = "SL";
          else if (markPx >= b.takeProfit) hit = "TP";
        } else {
          if (markPx >= b.stopLoss) hit = "SL";
          else if (markPx <= b.takeProfit) hit = "TP";
        }
        if (!hit) continue;
          try {
            await signed("POST", "/fapi/v1/order", {
            symbol: lbSym,
              side: b.closeSide,
              type: "MARKET",
              quantity: b.qty,
              reduceOnly: "true",
              newClientOrderId: `local_${hit.toLowerCase()}_${Date.now()}`,
              ...(b.positionSide ? { positionSide: b.positionSide } : {}),
            });
          log?.info?.("binance_live_futures_local_bracket_hit", {
            symbol: lbSym,
            hit,
            markPx,
            sl: b.stopLoss,
            tp: b.takeProfit,
          });
          notifyActivity?.(
            buildRiskSlTpTriggerActivity({
              hit,
              symbol: lbSym,
              markPx,
              stopLoss: b.stopLoss,
              takeProfit: b.takeProfit,
              mode: "usd_m_local_bracket",
              venue: "FUTURES",
            }),
          );
          const symU = String(lbSym || "").toUpperCase();
          const trailMeta = mem.trailingBySymbol[symU];
          const tf = trailCloseFieldsFromMemory(trailMeta, hit);
            mem.recentLocalCloses.push({
            symbol: lbSym,
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
            exitViaTrailedStop: tf.exitViaTrailedStop,
            trailStepAtClose: tf.trailStepAtClose,
            confirmedTrailStepAtClose: trailMeta ? Math.floor(Number(trailMeta.confirmedTrailStep) || 0) : 0,
            trailTierAtClose: tf.trailTierAtClose,
            trailStepLabelStyleAtClose: trailMeta?.trailStepLabelStyle,
            trailingMode: tf.trailingMode,
            positionSideAtOpen: positionSideAtOpenFromCloseSide(b.closeSide),
            });
          delete mem.localBrackets[lbSym];
          delete mem.placedBracketTargets[lbSym];
          delete mem.trailingBySymbol[symU];
          } catch (e) {
          log?.warn?.("binance_live_futures_local_bracket_close_failed", {
            symbol: lbSym,
            hit,
            error: String(e?.message || e),
          });
        }
      }
    },
    async closePosition({ id, notifyActivity, reason: userCloseReason } = {}) {
      if (!apiKey || !apiSecret) return { ok: false, error: "binance_live_futures_missing_keys" };
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
      /** Same as `placeOrder`: dual-side accounts require `positionSide` on reduce-only closes (-2022 if omitted). */
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
      const ur = String(userCloseReason || "").toUpperCase();
      const isSignal = ur === "SUPERTREND_EXIT" || ur === "SUPERTREND_FLIP";
      mem.recentLocalCloses.push({
        symbol: p.symbol,
        closedAt: Date.now(),
        closeSide,
        strategy: strat,
        bracketType: "MANUAL_CLOSE",
        strategyCloseReason: isSignal ? ur : "MANUAL_CLOSE",
        userCloseReason: userCloseReason || null,
        posId: sid,
        qty: p.qty,
        entryPrice: Number(p.entryPrice) || undefined,
        stopLoss: openLeg?.stopLoss != null ? Number(openLeg.stopLoss) : undefined,
        takeProfit: openLeg?.takeProfit != null ? Number(openLeg.takeProfit) : undefined,
        leverage: lev,
        positionSideAtOpen: p.side != null ? String(p.side) : undefined,
      });
      delete mem.localBrackets[p.symbol];
      delete mem.placedBracketTargets[p.symbol];
      delete mem.trailingBySymbol[String(p.symbol || "").toUpperCase()];
      notifyActivity?.({
        level: "info",
        msg: isSignal
          ? `Signal close · ${p.symbol} · reduce-only market order sent (USD-M live)`
          : `Manual close · ${p.symbol} · reduce-only market order sent (USD-M live)`,
        category: "risk",
        reason: isSignal ? "supertrend_exit" : "manual_close",
        symbol: p.symbol,
        detail: { positionId: sid, venue: "FUTURES", exchange: "binance_live_futures_usdm", userCloseReason },
      });
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

