import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import WsModule from "ws";
import { resolveDefaultDemoFuturesIncomeSyncPath } from "../../lib/tradingModePersistence.js";
import { tradeCloseFeeUsdtFromNotional } from "../../lib/tradeCloseFee.js";
import { refineUsdMTriggersVsMark, usdmBracketPriceStrings } from "../../lib/binanceFuturesBracketPrices.js";
import { placeUsdMSlTpAfterMarketEntry, futuresOrderIs4120 } from "../../lib/binanceFuturesSlTpBracket.js";
import { applyTrailingStopBinanceMemory } from "../../lib/trailingStopLoss.js";
import {
  closeReasonFromLocalCloseHint,
  positionSideAtOpenFromCloseSide,
  refineCloseReasonFromExitFill,
  trailCloseFieldsFromMemory,
} from "../../lib/binanceUsdmCloseReasonHint.js";
import { TRAIL_TIER_SCHEMA_VERSION } from "../../lib/supertrendTrailingSl.js";
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
  fetchUsdMOrderCommissionDetails,
  fetchUsdMOrderCommissionDetailsWithRetry,
  fetchUsdMTradeByTradeId,
  synthesizeOpenLegUsdMFromIncomeClose,
} from "../../lib/binanceUsdMUserTradeCommission.js";

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
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
      log?.warn?.("binance_demo_futures_open_orders_failed", { error: String(e?.message || e) });
    }
    slTpOpenOrdersCacheBySym.set(sym, { at: now, sl, tp });
    return { sl, tp };
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
    /** Last SL/TP we placed when exchange brackets succeeded (open-order parsing can still miss fields). */
    placedBracketTargets: {},
    /** Recent local bracket closes — income sync uses these to attribute PnL to strategy, not ledger */
    recentLocalCloses: [],
    /** Per-symbol trailing SL state when `meta.autoTradeTrailing` on open */
    trailingBySymbol: {},
    prevFuturesQtyBySymbol: {},
    /** Last positions snapshot from /fapi/v2/account — used to reconstruct trailing state on restart. */
    lastPositionSnapshot: [],
    /** Funding income ledger (same shape as live). Attributed to CLOSE rows in
     *  `applyFundingToCloseRows` — idempotent re-runs handle late-arriving rows. */
    fundingRows: [],
    seenFundingIds: new Set(),
    /** @type {number | null} */
    fundingCursorMs: null,
    lastFundingPollAt: 0,
    syntheticOpenCloseOrderIds: new Set(),
    forceNextIncomeSync: false,
  };

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

  async function futuresPositionQtyAbs(symU) {
    if (!apiKey || !apiSecret) return NaN;
    const u = String(symU || "").toUpperCase();
    try {
      const a = await signed("GET", "/fapi/v2/account");
      const ps = Array.isArray(a?.positions) ? a.positions : [];
      const p = ps.find((x) => String(x.symbol || "").toUpperCase() === u);
      if (!p) return 0;
      return Math.abs(Number(p.positionAmt || 0));
    } catch {
      return NaN;
    }
  }

  const MAX_MEM_TRADES = 800;

  function loadIncomeSyncFromDisk() {
    try {
      if (!fs.existsSync(incomeSyncPath)) return;
      const raw = JSON.parse(fs.readFileSync(incomeSyncPath, "utf8"));
      if (raw.incomeCursorMs != null) mem.incomeCursorMs = Number(raw.incomeCursorMs);
      for (const id of (raw.seenTranIds || []).slice(-8000)) mem.seenIncomeIds.add(String(id));
      if (raw.fundingCursorMs != null) mem.fundingCursorMs = Number(raw.fundingCursorMs);
      for (const id of (raw.seenFundingIds || []).slice(-8000)) mem.seenFundingIds.add(String(id));
      if (Array.isArray(raw.fundingRows)) {
        mem.fundingRows = raw.fundingRows
          .filter((r) => r && r.symbol && Number.isFinite(Number(r.amt)) && Number.isFinite(Number(r.time)))
          .slice(-5000);
      }
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
            fundingCursorMs: mem.fundingCursorMs,
            seenFundingIds: [...mem.seenFundingIds].slice(-8000),
            fundingRows: mem.fundingRows.slice(-5000),
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

  async function refreshUsdMPositionSnapshotAndReconcile() {
    if (!apiKey || !apiSecret) return;
    try {
      const a = await signed("GET", "/fapi/v2/account");
      const ps = Array.isArray(a?.positions) ? a.positions : [];
      mem.lastPositionSnapshot = ps;
      await reconcileUsdMExternalClosesFromPositions(
        { mem, publicGet, clearMemBracketTrailForSymbol, log },
        ps,
      );
    } catch (e) {
      log?.warn?.("binance_demo_futures_position_reconcile_failed", { error: String(e?.message || e) });
    }
  }

  /** Pull new FUNDING income rows and persist them in `mem.fundingRows`. Actual attribution
   *  to CLOSE rows is done by `applyFundingToCloseRows` — keeps this function idempotent. */
  async function syncFundingIncomeFromExchange() {
    if (!apiKey || !apiSecret) return;
    const now = Date.now();
    const fundingPollMinMs = Math.max(
      2000,
      Math.min(60_000, Number(process.env.BINANCE_FUNDING_POLL_MIN_MS ?? 5000)),
    );
    if (now - mem.lastFundingPollAt < fundingPollMinMs) return;
    mem.lastFundingPollAt = now;
    const start =
      mem.fundingCursorMs != null
        ? Math.max(0, mem.fundingCursorMs - 180_000)
        : Math.max(0, Date.now() - bootIncomeLookbackMs);
    let rows;
    try {
      rows = await signed("GET", "/fapi/v1/income", {
        incomeType: "FUNDING",
        startTime: String(start),
        limit: "1000",
      });
    } catch (e) {
      log?.warn?.("binance_demo_futures_funding_poll_failed", { error: String(e?.message || e) });
      return;
    }
    if (!Array.isArray(rows)) return;
    if (!rows.length) {
      if (mem.fundingCursorMs == null) {
        mem.fundingCursorMs = Date.now();
        saveIncomeSyncToDisk();
      }
      return;
    }
    let maxT = mem.fundingCursorMs != null ? mem.fundingCursorMs : start;
    let added = 0;
    for (const row of rows) {
      const tid =
        row.tranId != null
          ? String(row.tranId)
          : `f_${row.time || 0}_${row.symbol || ""}_${row.income || ""}`;
      if (mem.seenFundingIds.has(tid)) continue;
      mem.seenFundingIds.add(tid);
      const amt = Number(row.income || 0);
      const sym = String(row.symbol || "").toUpperCase();
      const t = Number(row.time || 0);
      if (!Number.isFinite(amt) || amt === 0 || !sym || !t) continue;
      mem.fundingRows.push({ tranId: tid, symbol: sym, time: t, amt });
      added += 1;
      if (t > maxT) maxT = t;
    }
    mem.fundingCursorMs = maxT + 1;
    if (mem.fundingRows.length > 5000) mem.fundingRows = mem.fundingRows.slice(-5000);
    if (mem.seenFundingIds.size > 20_000) {
      mem.seenFundingIds = new Set([...mem.seenFundingIds].slice(-10_000));
    }
    if (added > 0) saveIncomeSyncToDisk();
  }

  /** Attach every funding row whose time lies between an OPEN and its matching CLOSE on the same
   *  symbol to that CLOSE row's fee. Idempotent: rows already attributed are skipped via
   *  `meta.fundingTranIds`. Handles late-arriving funding rows for already-closed round-trips.
   */
  function applyFundingToCloseRows() {
    if (!mem.fundingRows.length || !mem.trades.length) return;
    for (let i = 0; i < mem.trades.length; i++) {
      const cr = mem.trades[i];
      if (cr?.type !== "CLOSE") continue;
      const sym = String(cr.symbol || "").toUpperCase();
      if (!sym) continue;
      const closeTs = Date.parse(cr.ts) || 0;
      if (!closeTs) continue;
      let openTs = 0;
      for (let j = i - 1; j >= 0; j--) {
        const tr2 = mem.trades[j];
        if (tr2?.type === "CLOSE" && String(tr2.symbol || "").toUpperCase() === sym) break;
        if (tr2?.type === "OPEN" && String(tr2.symbol || "").toUpperCase() === sym) {
          openTs = Date.parse(tr2.ts) || 0;
          break;
        }
      }
      if (!openTs || openTs >= closeTs) continue;
      const seen = new Set(
        Array.isArray(cr.meta?.fundingTranIds) ? cr.meta.fundingTranIds.map(String) : [],
      );
      let newSumIncome = 0;
      const newIds = [];
      for (const fr of mem.fundingRows) {
        if (fr.symbol !== sym) continue;
        if (fr.time < openTs || fr.time > closeTs) continue;
        if (seen.has(String(fr.tranId))) continue;
        newSumIncome += fr.amt;
        newIds.push(String(fr.tranId));
      }
      if (!newIds.length) continue;
      const prevFunding = Number(cr.meta?.fundingFeeUsd || 0);
      cr.meta = {
        ...(cr.meta || {}),
        fundingFeeUsd: prevFunding + newSumIncome,
        fundingTranIds: [
          ...(Array.isArray(cr.meta?.fundingTranIds) ? cr.meta.fundingTranIds : []),
          ...newIds,
        ],
      };
      cr.fee = Number(cr.fee || 0) + -newSumIncome;
    }
  }

  /** Latest OPEN row for symbol — used as context for `refineCloseReasonFromExitFill`. */
  function findLastOpenRefForSym(symU) {
    for (let j = mem.trades.length - 1; j >= 0; j--) {
      const tr = mem.trades[j];
      if (tr?.type === "OPEN" && String(tr.symbol || "").toUpperCase() === symU) return tr;
    }
    return null;
  }

  /**
   * OPEN leg strictly before this close's income time (see live adapter — avoids wrong entry on late sync).
   */
  function findOpenRefForSymBeforeClose(symU, closeEventMs, closeSide) {
    const cs = String(closeSide || "").toUpperCase();
    const expOpen = cs === "BUY" ? "SELL" : cs === "SELL" ? "BUY" : "";
    const tClose = Number(closeEventMs);
    if (!Number.isFinite(tClose) || tClose <= 0) return null;
    let best = null;
    let bestMs = -1;
    for (let j = mem.trades.length - 1; j >= 0; j--) {
      const tr = mem.trades[j];
      if (tr?.type !== "OPEN" || String(tr.symbol || "").toUpperCase() !== symU) continue;
      if (expOpen && String(tr.side || "").toUpperCase() !== expOpen) continue;
      const openMs = Date.parse(tr.ts || "");
      if (!Number.isFinite(openMs) || !(openMs < tClose)) continue;
      if (openMs >= bestMs) {
        bestMs = openMs;
        best = tr;
      }
    }
    return best;
  }

  /**
   * Run reason re-inference on a CLOSE row once its `exitAvgFillPrice` is authoritative. Upgrades
   * generic `EXCHANGE_REALIZED` / `MANUAL_CLOSE` / `STOP_LOSS_DEFAULT` to `STOP_LOSS` / `TAKE_PROFIT`
   * / `TRAILED_SUPERTREND_Tnn` when the real fill lands within the bracket band. Never downgrades.
   */
  function refineClosedRowReason(cr) {
    if (!cr || cr.type !== "CLOSE") return;
    const symU = String(cr.symbol || "").toUpperCase();
    const closeMs = Date.parse(cr.ts || "");
    const openRef =
      Number.isFinite(closeMs) && closeMs > 0
        ? findOpenRefForSymBeforeClose(symU, closeMs, cr.side) || findLastOpenRefForSym(symU)
        : findLastOpenRefForSym(symU);
    const refined = refineCloseReasonFromExitFill({
      existingReason: cr.reason,
      exitAvgFillPrice: cr.meta?.exitAvgFillPrice ?? cr.meta?.exitPrice ?? cr.price,
      stopLoss: cr.stopLoss ?? cr.meta?.stopLoss ?? openRef?.stopLoss,
      takeProfit: cr.takeProfit ?? cr.meta?.takeProfit ?? openRef?.takeProfit,
      positionSideAtOpen: cr.meta?.positionSideAtOpen ?? openRef?.side,
      trailStepAtClose: cr.meta?.trailStepAtClose,
      confirmedTrailStepAtClose: cr.meta?.confirmedTrailStepAtClose,
      trailStepLabelStyleAtClose: cr.meta?.trailStepLabelStyleAtClose,
      trailingMode: cr.meta?.trailingMode,
      exitViaTrailedStop: cr.meta?.exitViaTrailedStop === true,
    });
    if (refined && refined !== cr.reason) {
      cr.reason = refined;
      cr.meta = { ...(cr.meta || {}), closeReason: refined };
    }
  }

  function hasSyntheticOpenForClose(closeOrderId) {
    const c = String(closeOrderId || "");
    if (!c) return false;
    return mem.trades.some(
      (tr) => tr?.type === "OPEN" && String(tr?.meta?.incomeCloseOrderId || "") === c,
    );
  }

  function openRefMatchesRoundTrip(openRef, symU, closeSide, eventMs, targetQty) {
    if (!openRef || openRef.type !== "OPEN") return false;
    if (String(openRef.symbol || "").toUpperCase() !== symU) return false;
    const cs = String(closeSide || "").toUpperCase();
    const exp = cs === "SELL" ? "BUY" : cs === "BUY" ? "SELL" : "";
    if (!exp || String(openRef.side || "").toUpperCase() !== exp) return false;
    const openMs = Date.parse(openRef.ts || "");
    if (!Number.isFinite(openMs) || openMs >= eventMs) return false;
    const qo = Number(openRef.qty);
    const qt = Number(targetQty);
    if (Number.isFinite(qo) && Number.isFinite(qt) && qt > 0) {
      if (Math.abs(qo - qt) / qt > 0.08) return false;
    }
    return true;
  }

  async function maybeInsertSyntheticOpenForIncomeClose(args) {
    const { sym, closeOrderId, closeSide, eventMs, targetQty, lcHint, priorOpenRef } = args;
    const symU = String(sym || "").toUpperCase();
    const coid = String(closeOrderId || "");
    if (!coid || !apiKey || !apiSecret) return;

    if (hasSyntheticOpenForClose(coid)) return;
    if (lcHint?.posId != null && priorOpenRef && String(priorOpenRef.id) === String(lcHint.posId)) return;
    if (openRefMatchesRoundTrip(priorOpenRef, symU, closeSide, eventMs, targetQty)) return;

    const tq = Number(targetQty);
    if (!Number.isFinite(tq) || tq <= 0) return;

    const syn = await synthesizeOpenLegUsdMFromIncomeClose({
      signed,
      publicGet,
      symbol: symU,
      closeOrderId: coid,
      closeEventMs: eventMs,
      closeSide,
      closeQty: tq,
      log,
    });
    if (!syn) return;

    const dupOid = String(syn.meta?.orderId || "");
    if (
      dupOid &&
      mem.trades.some(
        (tr) =>
          tr?.type === "OPEN" &&
          String(tr?.symbol || "").toUpperCase() === symU &&
          String(tr?.meta?.orderId || "") === dupOid,
      )
    ) {
      return;
    }

    mem.syntheticOpenCloseOrderIds.add(coid);
    mem.trades.push(syn);
    if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);
  }

  /**
   * Aggregate one REALIZED_PNL fill into a single CLOSE row keyed by `closeOrderId`. Accumulates
   * `pnl`, per-fill `qty`, fee, and recomputes the qty-weighted `price` so one reduce order's many
   * fills show as ONE history row with true totals (matches Binance's PnL/commission for that order).
   */
  async function aggregateIncomeFillByOrderId(p) {
    const { sym, tid, tradeId, tradeDetail, closeOrderId, pnl, eventMs, tsIso, rawRow, lcHint } = p;

    let mergeInto = null;
    for (let i = mem.trades.length - 1; i >= 0; i--) {
      const tr = mem.trades[i];
      if (
        tr?.type === "CLOSE" &&
        String(tr?.symbol || "").toUpperCase() === sym &&
        String(tr?.meta?.closeOrderId || "") === closeOrderId
      ) {
        mergeInto = tr;
        break;
      }
    }

    const fillQty = Number(tradeDetail?.qty);
    const fillPx = Number(tradeDetail?.price);
    const fillFee = Number(tradeDetail?.commissionUsdt);
    const hasFill = Number.isFinite(fillQty) && fillQty > 0 && Number.isFinite(fillPx) && fillPx > 0;

    if (mergeInto) {
      mergeInto.pnl = Number(mergeInto.pnl || 0) + pnl;
      if (hasFill) {
        const prevAcc = Number(mergeInto.meta?.fillQtyAcc || 0);
        const prevPx = Number(mergeInto.price || 0);
        const prevNotional = Number.isFinite(prevPx) && Number.isFinite(prevAcc) ? prevPx * prevAcc : 0;
        const newAcc = prevAcc + fillQty;
        const newNotional = prevNotional + fillQty * fillPx;
        const newAvg = newAcc > 0 ? newNotional / newAcc : mergeInto.price;
        mergeInto.qty = newAcc;
        mergeInto.price = newAvg;
        mergeInto.meta = {
          ...(mergeInto.meta || {}),
          fillQtyAcc: newAcc,
          exitPrice: newAvg,
          exitAvgFillPrice: newAvg,
          exitPriceSource: "fapi_userTrades",
        };
      }
      if (Number.isFinite(fillFee) && fillFee > 0) {
        mergeInto.fee = Number(mergeInto.fee || 0) + fillFee;
        mergeInto.meta = {
          ...(mergeInto.meta || {}),
          exitFee: Number(mergeInto.fee),
          commissionSourceClose: "fapi_userTrades",
        };
      }
      const tranIds = Array.isArray(mergeInto.meta?.tranIds) ? [...mergeInto.meta.tranIds] : [];
      if (!tranIds.includes(tid)) tranIds.push(tid);
      const tradeIds = Array.isArray(mergeInto.meta?.tradeIds) ? [...mergeInto.meta.tradeIds] : [];
      if (tradeId && !tradeIds.includes(tradeId)) tradeIds.push(tradeId);
      mergeInto.meta = {
        ...(mergeInto.meta || {}),
        tranIds,
        tranId: tranIds[tranIds.length - 1],
        tradeIds,
        closeOrderId,
        _incomeEventMs: Math.max(Number(mergeInto.meta?._incomeEventMs || 0), eventMs),
      };
      refineClosedRowReason(mergeInto);
      const tqMerge = Number(mergeInto.meta?.fillQtyAcc || mergeInto.qty || tradeDetail?.qty || 0);
      await maybeInsertSyntheticOpenForIncomeClose({
        sym,
        closeOrderId,
        closeSide: mergeInto.side,
        eventMs,
        targetQty: tqMerge,
        lcHint,
        priorOpenRef:
          findOpenRefForSymBeforeClose(sym, eventMs, mergeInto.side) || findLastOpenRefForSym(sym),
      });
      return;
    }

    const lo = findLastOpenRefForSym(sym);
    const closeSideGuess = String(tradeDetail?.side || lcHint?.closeSide || "").toUpperCase();
    const cs0 =
      closeSideGuess === "BUY" || closeSideGuess === "SELL"
        ? closeSideGuess
        : lo?.side === "BUY"
          ? "SELL"
          : lo?.side === "SELL"
            ? "BUY"
            : "—";
    let openRef = cs0 !== "—" ? findOpenRefForSymBeforeClose(sym, eventMs, cs0) || lo : lo;
    const closeSide =
      tradeDetail?.side ||
      lcHint?.closeSide ||
      (openRef?.side === "BUY" ? "SELL" : openRef?.side === "SELL" ? "BUY" : "—");

    let targetQty = hasFill ? fillQty : lcHint?.qty != null ? Number(lcHint.qty) : Number(openRef?.qty || 0);
    if (closeOrderId && apiKey && apiSecret) {
      try {
        const od = await fetchUsdMOrderCommissionDetails({
          signed,
          publicGet,
          symbol: sym,
          orderId: closeOrderId,
          log,
        });
        if (od?.filledQty && Number(od.filledQty) > 0) targetQty = Number(od.filledQty);
      } catch {
        /* ignore */
      }
    }

    await maybeInsertSyntheticOpenForIncomeClose({
      sym,
      closeOrderId,
      closeSide,
      eventMs,
      targetQty,
      lcHint,
      priorOpenRef: openRef,
    });

    openRef =
      findOpenRefForSymBeforeClose(sym, eventMs, closeSide) || findLastOpenRefForSym(sym);

    const entryPxRef =
      lcHint?.entryPrice != null
        ? Number(lcHint.entryPrice)
        : openRef?.price != null
          ? Number(openRef.price)
          : openRef?.entryPrice != null
            ? Number(openRef.entryPrice)
            : undefined;
    const slRef = lcHint?.stopLoss ?? openRef?.stopLoss;
    const tpRef = lcHint?.takeProfit ?? openRef?.takeProfit;
    const levRef = lcHint?.leverage ?? openRef?.meta?.leverage ?? openRef?.leverage;

    const reasonInit = lcHint ? closeReasonFromLocalCloseHint(lcHint) : "EXCHANGE_REALIZED";

    const row = {
      type: "CLOSE",
      id: `finc_${tid}`,
      ts: tsIso,
      symbol: sym,
      side: closeSide,
      qty: hasFill ? fillQty : lcHint?.qty != null ? Number(lcHint.qty) : openRef?.qty,
      price: hasFill ? fillPx : undefined,
      entryPrice: Number.isFinite(Number(entryPxRef)) ? Number(entryPxRef) : undefined,
      stopLoss: slRef != null ? Number(slRef) : undefined,
      takeProfit: tpRef != null ? Number(tpRef) : undefined,
      leverage: levRef != null ? Number(levRef) : undefined,
      pnl,
      fee: Number.isFinite(fillFee) && fillFee > 0 ? fillFee : undefined,
      strategy: lcHint?.strategy || openRef?.strategy || "AUTO",
      reason: reasonInit,
      ledgerEvent: !lcHint,
      meta: {
        source: "fapi_income",
        incomeType: rawRow?.incomeType || "REALIZED_PNL",
        tranId: tid,
        tranIds: [tid],
        tradeIds: tradeId ? [tradeId] : [],
        closeOrderId,
        closeReason: reasonInit,
        _incomeEventMs: eventMs,
        ...(hasFill
          ? {
              fillQtyAcc: fillQty,
              exitPrice: fillPx,
              exitAvgFillPrice: fillPx,
              exitPriceSource: "fapi_userTrades",
            }
          : {}),
        ...(Number.isFinite(fillFee) && fillFee > 0
          ? { exitFee: fillFee, commissionSourceClose: "fapi_userTrades" }
          : {}),
        ...(lcHint?.bracketType ? { bracketType: lcHint.bracketType } : {}),
        ...(lcHint?.trailingMode != null ? { trailingMode: String(lcHint.trailingMode) } : {}),
        ...(lcHint?.exitViaTrailedStop === true ? { exitViaTrailedStop: true } : {}),
        ...(lcHint?.trailStepAtClose != null ? { trailStepAtClose: lcHint.trailStepAtClose } : {}),
        ...(lcHint?.confirmedTrailStepAtClose != null
          ? { confirmedTrailStepAtClose: Number(lcHint.confirmedTrailStepAtClose) }
          : {}),
        ...(lcHint?.trailTierAtClose != null
          ? { trailTierAtClose: String(lcHint.trailTierAtClose) }
          : {}),
        ...(lcHint?.trailStepLabelStyleAtClose != null
          ? { trailStepLabelStyleAtClose: String(lcHint.trailStepLabelStyleAtClose) }
          : {}),
        ...(lcHint?.positionSideAtOpen != null && String(lcHint.positionSideAtOpen).trim() !== ""
          ? { positionSideAtOpen: String(lcHint.positionSideAtOpen).trim() }
          : openRef?.side
            ? { positionSideAtOpen: String(openRef.side).toUpperCase() }
            : {}),
        ...(lcHint?.posId != null && String(lcHint.posId).trim() !== ""
          ? { openRefId: String(lcHint.posId).trim() }
          : openRef?.id
            ? { openRefId: String(openRef.id) }
            : {}),
        ...(lcHint
          ? {
              localEnforcement: true,
              localCloseKey: `${sym}_${lcHint.closedAt}`,
            }
          : {}),
        supertrendSignalClose:
          lcHint?.strategyCloseReason === "SUPERTREND_EXIT" || lcHint?.strategyCloseReason === "SUPERTREND_FLIP",
      },
    };
    mem.trades.push(row);
    if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);
    refineClosedRowReason(row);
  }

  async function syncRealizedIncomeFromExchange() {
    if (!apiKey || !apiSecret) return;
    await refreshUsdMPositionSnapshotAndReconcile();
    // Fire-and-forget funding pull — does not block close-row generation.
    syncFundingIncomeFromExchange().catch((e) =>
      log?.warn?.("binance_demo_futures_funding_sync_failed", { error: String(e?.message || e) }),
    );
    const bypassIncomeThrottle = mem.forceNextIncomeSync === true;
    if (bypassIncomeThrottle) mem.forceNextIncomeSync = false;
    const now = Date.now();
    if (!bypassIncomeThrottle && now - mem.lastIncomePollAt < 2500) return;
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

      /**
       * Discover the canonical `closeOrderId` behind this income shard via `tradeId` — one reduce
       * order often produces many REALIZED_PNL tranIds (one per fill) that share a single orderId.
       * Without this lookup, every shard became a duplicate CLOSE history row with full OPEN qty
       * re-applied, massively inflating displayed fees and decoupling Net PnL from Binance's true
       * total (the main bug in the user's Sheet6 CSV).
       */
      const rowTradeId = row.tradeId != null ? String(row.tradeId).trim() : "";
      let tradeDetail = null;
      if (rowTradeId && apiKey && apiSecret) {
        try {
          tradeDetail = await fetchUsdMTradeByTradeId({
            signed,
            publicGet,
            symbol: sym,
            tradeId: rowTradeId,
            log,
          });
        } catch {
          /* best-effort; fall through to legacy paths below */
        }
      }
      const closeOrderId = tradeDetail?.orderId ? String(tradeDetail.orderId) : null;

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
      const lcHint = localMatch >= 0 ? mem.recentLocalCloses[localMatch] : null;

      /**
       * PRIMARY AGGREGATION PATH: when we know the `closeOrderId`, merge every fill for that order
       * into a single CLOSE row with true qty / avg fill price / real commission. This collapses the
       * many-shards-per-close pattern that caused fee inflation and duplicate history rows.
       */
      if (closeOrderId) {
        await aggregateIncomeFillByOrderId({
          sym,
          tid,
          tradeId: rowTradeId,
          tradeDetail,
          closeOrderId,
          pnl,
          eventMs,
          tsIso,
          rawRow: row,
          lcHint,
        });
        if (t) maxT = Math.max(maxT, t);
        continue;
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
            if (lc.posId != null && String(lc.posId).trim() !== "" && mergeInto.meta.openRefId == null) {
              mergeInto.meta.openRefId = String(lc.posId).trim();
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
          // Keep CLOSE id unique (e.g. finc_<tranId>). OPEN `id` is fut_<sym> for positions; persisted merge uses meta.orderId.
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
          let exitFeeMerge = null;
          let exitDetail = null;
          if (lc.closeOrderId) {
            exitDetail = await fetchUsdMOrderCommissionDetailsWithRetry({
              signed,
              publicGet,
              symbol: sym,
              orderId: lc.closeOrderId,
              log,
            });
            exitFeeMerge = exitDetail?.usdt ?? null;
          }
          /** Prefer the TRUE avg fill from `userTrades` over `lc.markPx` (which is mark price at trigger time). */
          if (exitDetail?.avgPrice != null && Number.isFinite(Number(exitDetail.avgPrice)) && Number(exitDetail.avgPrice) > 0) {
            const avg = Number(exitDetail.avgPrice);
            mergeInto.price = avg;
            mergeInto.meta = {
              ...(mergeInto.meta || {}),
              exitPrice: avg,
              exitAvgFillPrice: avg,
              exitPriceSource: "fapi_userTrades",
            };
          }
          if (exitFeeMerge != null) {
            mergeInto.fee = exitFeeMerge;
            mergeInto.meta = {
              ...(mergeInto.meta || {}),
              exitFee: exitFeeMerge,
              commissionSourceClose: "fapi_userTrades",
              ...(exitDetail?.allMaker === true
                ? { exitAllMaker: true }
                : exitDetail?.allMaker === false
                  ? { exitAllMaker: false }
                  : {}),
            };
          } else {
            const feePx =
              mergeInto.price ??
              mergeInto.meta?.exitPrice ??
              (lc.markPx != null ? Number(lc.markPx) : NaN);
            const f = tradeCloseFeeUsdtFromNotional(mergeInto.qty, feePx);
            if (f != null) mergeInto.fee = f;
          }
          refineClosedRowReason(mergeInto);
        } else {
          const closeQtyN = lc.qty != null ? Number(lc.qty) : NaN;
          const closePxN =
            lc.markPx != null && Number.isFinite(Number(lc.markPx)) ? Number(lc.markPx) : NaN;
          const reasonNorm = closeReasonFromLocalCloseHint(lc);
          let exitFeeNew = null;
          let exitDetailNew = null;
          if (lc.closeOrderId) {
            exitDetailNew = await fetchUsdMOrderCommissionDetailsWithRetry({
              signed,
              publicGet,
              symbol: sym,
              orderId: lc.closeOrderId,
              log,
            });
            exitFeeNew = exitDetailNew?.usdt ?? null;
          }
          const feeFallback = tradeCloseFeeUsdtFromNotional(closeQtyN, closePxN);
          /** Exit price priority: real fill avg (userTrades) > mark at trigger. `lc.markPx` is the old fallback. */
          const exitAvg =
            exitDetailNew?.avgPrice != null &&
            Number.isFinite(Number(exitDetailNew.avgPrice)) &&
            Number(exitDetailNew.avgPrice) > 0
              ? Number(exitDetailNew.avgPrice)
              : null;
          const exitPxForRow =
            exitAvg != null
              ? exitAvg
              : lc.markPx != null && Number.isFinite(Number(lc.markPx))
                ? Number(lc.markPx)
                : undefined;
          const exitPxSource = exitAvg != null ? "fapi_userTrades" : exitPxForRow != null ? "markPx" : undefined;
          mem.trades.push({
            type: "CLOSE",
            id: `finc_${tid}`,
            ts: tsIso,
            symbol: sym,
            side: lc.closeSide || "—",
            qty: lc.qty != null ? Number(lc.qty) : undefined,
            price: exitPxForRow,
            entryPrice: lc.entryPrice != null ? Number(lc.entryPrice) : undefined,
            stopLoss: lc.stopLoss != null ? Number(lc.stopLoss) : undefined,
            takeProfit: lc.takeProfit != null ? Number(lc.takeProfit) : undefined,
            leverage: lc.leverage != null ? Number(lc.leverage) : undefined,
            pnl,
            fee: (exitFeeNew ?? feeFallback) ?? undefined,
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
              exitPrice: exitPxForRow,
              ...(exitAvg != null ? { exitAvgFillPrice: exitAvg } : {}),
              ...(exitPxSource ? { exitPriceSource: exitPxSource } : {}),
              exitViaTrailedStop: lc.exitViaTrailedStop === true,
              trailStepAtClose: lc.trailStepAtClose,
              trailTierAtClose: lc.trailTierAtClose != null ? String(lc.trailTierAtClose) : undefined,
              supertrendSignalClose:
                lc.strategyCloseReason === "SUPERTREND_EXIT" || lc.strategyCloseReason === "SUPERTREND_FLIP",
              ...(exitFeeNew != null
                ? {
                    exitFee: exitFeeNew,
                    commissionSourceClose: "fapi_userTrades",
                    ...(exitDetailNew?.allMaker === true
                      ? { exitAllMaker: true }
                      : exitDetailNew?.allMaker === false
                        ? { exitAllMaker: false }
                        : {}),
                  }
                : {}),
              ...(lc.positionSideAtOpen != null && String(lc.positionSideAtOpen).trim() !== ""
                ? { positionSideAtOpen: String(lc.positionSideAtOpen).trim() }
                : {}),
              ...(lc.posId != null && String(lc.posId).trim() !== ""
                ? { openRefId: String(lc.posId).trim() }
                : {}),
            },
          });
          refineClosedRowReason(mem.trades[mem.trades.length - 1]);
        }
      } else {
        // No recentLocalCloses hint matched — try to fill fields from the most recent OPEN trade
        // for this symbol so the history row isn't completely blank.
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
        refineClosedRowReason(mem.trades[mem.trades.length - 1]);
      }
      if (t) maxT = Math.max(maxT, t);
    }
    mem.incomeCursorMs = maxT + 1;
    saveIncomeSyncToDisk();
    if (mem.seenIncomeIds.size > 20_000) {
      mem.seenIncomeIds = new Set([...mem.seenIncomeIds].slice(-10_000));
    }
    // Attribute any funding rows that now have a matching CLOSE window. Runs after
    // REALIZED_PNL because that's when new CLOSE rows land in `mem.trades`.
    applyFundingToCloseRows();
    if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);
  }

  let lastOpenCommissionBackfillAt = 0;

  /** OPEN rows sometimes miss the async userTrades patch (race, REST hiccup). Retry periodically
   *  so UI fees, entry fill price, and margin (entry × qty / lev) line up with Binance.
   */
  async function backfillMissingOpenCommissionsUsdM() {
    if (!apiKey || !apiSecret) return;
    const now = Date.now();
    if (now - lastOpenCommissionBackfillAt < 2800) return;
    lastOpenCommissionBackfillAt = now;
    const candidates = [];
    for (let i = mem.trades.length - 1; i >= 0 && candidates.length < 14; i--) {
      const tr = mem.trades[i];
      if (tr?.type !== "OPEN") continue;
      const oid = tr?.meta?.orderId;
      if (oid == null || String(oid).trim() === "") continue;
      if (tr.meta?.commissionSource === "fapi_userTrades" && Number(tr.fee) > 0) continue;
      candidates.push(tr);
    }
    for (const tr of candidates.slice(0, 8)) {
      const sym = String(tr.symbol || "").toUpperCase();
      try {
        const det = await fetchUsdMOrderCommissionDetailsWithRetry({
          signed,
          publicGet,
          symbol: sym,
          orderId: tr.meta.orderId,
          log,
        });
        if (det == null) continue;
        const hasCommission = det.usdt > 0;
        const hasFill =
          det.avgPrice != null && Number.isFinite(Number(det.avgPrice)) && Number(det.avgPrice) > 0;
        if (!hasCommission && !hasFill) continue;
        const patchMeta = {};
        if (hasCommission) {
          tr.fee = det.usdt;
          patchMeta.openFee = det.usdt;
          patchMeta.commissionSource = "fapi_userTrades";
          if (det.allMaker === true) patchMeta.entryAllMaker = true;
          else if (det.allMaker === false) patchMeta.entryAllMaker = false;
        }
        if (hasFill && tr.meta?.entryPriceSource !== "fapi_userTrades") {
          tr.price = Number(det.avgPrice);
          patchMeta.entryAvgFillPrice = Number(det.avgPrice);
          patchMeta.entryPriceSource = "fapi_userTrades";
          if (
            Number.isFinite(Number(det.filledQty)) &&
            Number(det.filledQty) > 0 &&
            Math.abs(Number(det.filledQty) - Number(tr.qty || 0)) > 1e-8
          ) {
            tr.qty = Number(det.filledQty);
            patchMeta.entryFilledQty = Number(det.filledQty);
          }
        }
        tr.meta = { ...(tr.meta || {}), ...patchMeta };
      } catch {
        /* ignore */
      }
    }
  }

  // ─── Real-time trailing state (factory scope) ───────────────────────────────
  /** Last trailing config + callbacks provided by markToMarket; reused by real-time poll. */
  let _cachedTrailingConfig = null;
  /** Timer handle for the real-time trailing poll loop. */
  let _realtimeTrailingTimer = null;
  /** Per-symbol lock to prevent concurrent SL replacements for the same symbol. */
  const _trailSymLock = new Set();

  // ─── Mark-price WebSocket stream (replaces REST premiumIndex polling) ───────
  const _markPxCache = new Map();
  let _markPxWs = null;
  let _markPxWsReconnectTimer = null;
  let _markPxWsSymbols = [];

  function _connectMarkPxWs() {
    if (_markPxWs) {
      try { _markPxWs.removeAllListeners?.(); _markPxWs.terminate?.(); } catch { /* */ }
      _markPxWs = null;
    }
    const syms = _markPxWsSymbols;
    if (!syms.length) return;

    /** Binance USD-M testnet / demo-fapi public streams (see derivatives general-info). Not mainnet fstream. */
    const wsBaseUrl =
      process.env.BINANCE_DEMO_FUTURES_WS_BASE ||
      process.env.BINANCE_FUTURES_TESTNET_WS_BASE ||
      "wss://fstream.binancefuture.com/ws";
    const streams = syms.map((s) => `${s.toLowerCase()}@markPrice@1s`);
    const url = streams.length === 1
      ? `${wsBaseUrl.replace(/\/$/, "")}/${streams[0]}`
      : `${wsBaseUrl.replace(/\/ws\/?$/, "/stream")}?streams=${streams.join("/")}`;

    let ws;
    try {
      ws = new WsModule(url);
    } catch {
      return;
    }
    _markPxWs = ws;
    ws.on?.("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const d = msg?.data ?? msg;
        if (d?.e === "markPriceUpdate") {
          const m = Number(d.p);
          if (Number.isFinite(m) && m > 0) {
            _markPxCache.set(String(d.s).toUpperCase(), { px: m, at: Date.now() });
          }
        }
      } catch { /* */ }
    });
    ws.on?.("error", () => { /* reconnect handles it */ });
    ws.on?.("close", () => {
      _markPxWs = null;
      if (_markPxWsReconnectTimer) clearTimeout(_markPxWsReconnectTimer);
      _markPxWsReconnectTimer = setTimeout(() => {
        _markPxWsReconnectTimer = null;
        _connectMarkPxWs();
      }, 2000);
    });
  }

  function _ensureMarkPxWs(symbols) {
    const sorted = [...new Set(symbols.map((s) => String(s).toUpperCase()))].sort();
    const prev = [..._markPxWsSymbols].sort();
    if (sorted.join(",") === prev.join(",") && _markPxWs?.readyState === 1) return;
    _markPxWsSymbols = sorted;
    _connectMarkPxWs();
  }

  function _getMarkPxFromCache(symU, maxAgeMs = 5000) {
    const entry = _markPxCache.get(symU);
    if (!entry) return null;
    if (Date.now() - entry.at > maxAgeMs) return null;
    return entry.px;
  }

  /** Qty from last position snapshot — no extra API call. Returns 0 if flat, NaN if snapshot unavailable. */
  function qtyAbsFromSnapshot(symU) {
    if (!Array.isArray(mem.lastPositionSnapshot) || !mem.lastPositionSnapshot.length) return NaN;
    const p = mem.lastPositionSnapshot.find((r) => String(r?.symbol || "").toUpperCase() === symU);
    if (!p) return 0;
    return Math.abs(Number(p.positionAmt || 0));
  }

  /**
   * Core trailing evaluation for a single symbol (delegates to shared USD-M verify-first flow).
   */
  async function evalTrailingForSymbol(s, markPx, trailingStopLoss, onTrailingSlAdvance, notifyActivity, primaryChartSymU = null) {
    const replaceCtxBase = {
      mem,
      signed,
      publicGet,
      getOrLoadSymbolMeta,
      defaultLeverage,
      log,
      logPrefix: "binance_demo_futures",
      normalizeAlgoOrdersPayload,
      clearSlTpOpenOrdersCache: (symU) => {
        slTpOpenOrdersCacheBySym.delete(String(symU || "").toUpperCase());
      },
    };
    await evalTrailingForSymbolUsdM({
      s,
      markPx,
      trailingStopLoss,
      onTrailingSlAdvance,
      notifyActivity,
      primaryChartSymU,
      mem,
      applyTrailingStopBinanceMemory,
      getOrLoadSymbolMeta,
      signed,
      publicGet,
      defaultLeverage,
      trailSymLock: _trailSymLock,
      stopTakeFromExchangeOpenOrders,
      replaceCtxBase,
      log,
      replaceSlOnExchange: (symU, newSlPx, markPxHint, prevSl) =>
        replaceExchangeSlOrder(symU, newSlPx, markPxHint, prevSl),
    });
  }

  /** Real-time poll: use mark-price WS cache, fall back to REST only on miss. */
  async function _runRealtimePoll() {
    if (!_cachedTrailingConfig?.trailingStopLoss?.enabled) return;
    const { trailingStopLoss, onTrailingSlAdvance, notifyActivity, primaryChartSymU: pollPrimary } = _cachedTrailingConfig;
    const symKeys = [...new Set(Object.keys(mem.trailingBySymbol).map((k) => String(k || "").toUpperCase()))];
    if (!symKeys.length) return;

    // Ensure mark-price WS stream covers all trailing symbols
    _ensureMarkPxWs(symKeys);

    // Resolve mark prices: WS cache first (sub-second), REST fallback for cache misses
    const markEntries = await Promise.allSettled(
      symKeys.map(async (s) => {
        const cached = _getMarkPxFromCache(s);
        if (cached != null) return { s, markPx: cached };
        try {
          const d = await publicGet("/fapi/v1/premiumIndex", { symbol: s });
          const m = Number(d?.markPrice);
          return { s, markPx: Number.isFinite(m) && m > 0 ? m : null };
        } catch {
          return { s, markPx: null };
        }
      }),
    );

    // Evaluate trailing for all symbols in parallel, using snapshot for qty check
    await Promise.all(
      markEntries.map((r) => {
        if (r.status !== "fulfilled" || !r.value?.markPx) return;
        const { s, markPx } = r.value;
        if (!mem.trailingBySymbol[s]) return;
        const qty = qtyAbsFromSnapshot(s);
        if (Number.isNaN(qty)) return;
        if (qty < 1e-8) {
          if (qty === 0) clearMemBracketTrailForSymbol(s);
          return;
        }
        return evalTrailingForSymbol(s, markPx, trailingStopLoss, onTrailingSlAdvance, notifyActivity, pollPrimary);
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Cancel open STOP (SL) orders on this symbol for the close-out side only.
   * Used when Binance rejects a new closePosition SL with -4130 / -4135 (only one allowed).
   * Does not cancel TAKE_PROFIT orders.
   */
  async function cancelAllStopLossOrdersForDirection(symU, closeSide) {
    const sideU = String(closeSide || "").toUpperCase();
    const [openClassic, algoRaw] = await Promise.all([
      signed("GET", "/fapi/v1/openOrders", { symbol: symU }).catch(() => []),
      signed("GET", "/fapi/v1/openAlgoOrders", { symbol: symU }).catch(() => null),
    ]);
    const classicOrders = Array.isArray(openClassic) ? openClassic : [];
    const algoList = normalizeAlgoOrdersPayload(algoRaw);
    let n = 0;
    for (const o of classicOrders) {
      const typ = String(o.origType || o.type || "").toUpperCase();
      const side = String(o.side || "").toUpperCase();
      const isSl = typ.includes("STOP") && !typ.includes("TAKE_PROFIT");
      if (!isSl || side !== sideU) continue;
      await signed("DELETE", "/fapi/v1/order", { symbol: symU, orderId: String(o.orderId) }).catch(() => null);
      n += 1;
    }
    for (const ao of algoList) {
      if (String(ao.symbol || "").toUpperCase() !== symU) continue;
      const typ = String(ao.orderType || ao.origType || ao.type || "").toUpperCase();
      const side = String(ao.side || "").toUpperCase();
      const isSl = typ.includes("STOP") && !typ.includes("TAKE_PROFIT");
      if (!isSl || side !== sideU) continue;
      const algoId = ao.algoId ?? ao.orderId;
      if (!algoId) continue;
      await signed("DELETE", "/fapi/v1/algoOrder", { symbol: symU, algoId: String(algoId) }).catch(() => null);
      n += 1;
    }
    if (n > 0) log?.info?.("binance_demo_futures_trail_sl_cancelled_conflicting", { symbol: symU, side: sideU, count: n });
  }

  /**
   * Replace the STOP (SL) order on the exchange with a new price after a trailing advance.
   *
   * Strategy (cancel-first for trailing):
   *   1. Cancel all existing SL orders for this symbol/direction (TP untouched).
   *   2. Place the new SL via algo endpoint (primary) with classic fallback.
   *   3. On -2021 ("would immediately trigger"): the mark has ALREADY crossed the trailing SL.
   *      → Install a local bracket so the next markToMarket tick closes the position via MARKET.
   */
  async function replaceExchangeSlOrder(symU, newSlPx, markPxHint, previousExchangeSlPx = null) {
    const tgt = mem.placedBracketTargets[symU];
    if (!tgt || !Number.isFinite(newSlPx) || newSlPx <= 0) return { ok: false, code: null, msg: "missing_target" };
    if (!tgt.closeSide) return { ok: false, code: null, msg: "missing_close_side" };
    const isLong = tgt.closeSide === "SELL";

    function resolveQtyStr() {
      const q0 = Number(tgt.qty ?? 0);
      if (Number.isFinite(q0) && q0 > 0) return String(q0);
      if (Array.isArray(mem.lastPositionSnapshot)) {
        const p = mem.lastPositionSnapshot.find((r) => String(r?.symbol || "").toUpperCase() === symU);
        const qa = Math.abs(Number(p?.positionAmt || 0));
        if (Number.isFinite(qa) && qa > 0) return String(qa);
      }
      return null;
    }

    const hedgeExtrasR = tgt.hedgeExtras || {};
    const isHedge = Boolean(hedgeExtrasR.positionSide);

    /**
     * Place STOP_MARKET SL after caller cancelled prior SLs. Used for new trail price and rollback path.
     * @returns {{ placed: boolean, immediate2021: boolean, lastCode: number | null, lastMsg: string | null }}
     */
    async function executePlaceAttempts(slPxTarget) {
      const mloc = await getOrLoadSymbolMeta(symU).catch(() => null);
      const { stopStr: st0, slLimitStr: limStr } = usdmBracketPriceStrings({
        isLong,
        stopPx: slPxTarget,
        tpPx: Number(tgt.takeProfit) || slPxTarget * (isLong ? 2 : 0.5),
        meta: mloc,
        closeSide: tgt.closeSide,
      });
      const st = st0;
      if (!st || !limStr) return { placed: false, immediate2021: false, lastCode: null, lastMsg: "bad_stop_str" };
      let placedInner = false;
      let lastCodeInner = null;
      let lastMsgInner = null;
      const attemptsInner = [
        { endpoint: "algo", mode: "closePosition" },
        { endpoint: "algo", mode: "reduceOnly" },
        { endpoint: "classic", mode: "closePosition" },
        { endpoint: "classic", mode: "reduceOnly" },
      ];
      for (const { endpoint, mode } of attemptsInner) {
        if (placedInner) break;
        try {
          if (mode === "reduceOnly") {
            if (isHedge) continue;
            const qStr = resolveQtyStr();
            if (!qStr) continue;
            if (endpoint === "algo") {
              await signed("POST", "/fapi/v1/algoOrder", {
                algoType: "CONDITIONAL",
                symbol: symU,
                side: tgt.closeSide,
                type: "STOP_MARKET",
                triggerPrice: st,
                workingType: "MARK_PRICE",
                reduceOnly: "true",
                quantity: qStr,
                newClientAlgoId: `trail_sl_ro_${Date.now()}`,
                ...hedgeExtrasR,
              });
            } else {
              await signed("POST", "/fapi/v1/order", {
                symbol: symU,
                side: tgt.closeSide,
                type: "STOP_MARKET",
                stopPrice: st,
                workingType: "MARK_PRICE",
                reduceOnly: "true",
                quantity: qStr,
                newClientOrderId: `trail_sl_ro_${Date.now()}`,
                ...hedgeExtrasR,
              });
            }
          } else if (endpoint === "algo") {
            await signed("POST", "/fapi/v1/algoOrder", {
              algoType: "CONDITIONAL",
              symbol: symU,
              side: tgt.closeSide,
              type: "STOP_MARKET",
              triggerPrice: st,
              workingType: "MARK_PRICE",
              closePosition: "true",
              newClientAlgoId: `trail_sl_${Date.now()}`,
              ...hedgeExtrasR,
            });
          } else {
            await signed("POST", "/fapi/v1/order", {
              symbol: symU,
              side: tgt.closeSide,
              type: "STOP_MARKET",
              stopPrice: st,
              workingType: "MARK_PRICE",
              closePosition: "true",
              newClientOrderId: `trail_sl_${Date.now()}`,
              ...hedgeExtrasR,
            });
          }
          placedInner = true;
        } catch (e) {
          lastCodeInner = e?.cause?.response?.data?.code ?? e?.response?.data?.code ?? null;
          lastMsgInner = e?.cause?.response?.data?.msg ?? e?.response?.data?.msg ?? e?.message ?? null;
          if (lastCodeInner === -2021) {
            log?.info?.("binance_demo_futures_trail_sl_immediate_trigger", {
              symbol: symU,
              newSlPx: slPxTarget,
              msg: "Mark crossed SL — installing local bracket for immediate close",
            });
            const qStr = resolveQtyStr();
            const positionSideField = hedgeExtrasR.positionSide || undefined;
            mem.localBrackets[symU] = {
              stopLoss: slPxTarget,
              takeProfit: Number(tgt.takeProfit) || (isLong ? slPxTarget * 10 : slPxTarget * 0.01),
              isLong,
              closeSide: tgt.closeSide,
              qty: qStr || tgt.qty || "0",
              positionSide: positionSideField,
              entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
              leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
              strategy: "trailing_sl_breach",
              _installedAt: Date.now(),
            };
            mem.placedBracketTargets[symU] = { ...tgt, stopLoss: slPxTarget };
            return { placed: false, immediate2021: true, lastCode: lastCodeInner, lastMsg: lastMsgInner };
          }
        }
      }
      return { placed: placedInner, immediate2021: false, lastCode: lastCodeInner, lastMsg: lastMsgInner };
    }

    try {
      // ── Pre-check: would the new SL immediately trigger? ──
      // If so, do NOT cancel the existing exchange SL — it's already protecting the position.
      // Placing a STOP_MARKET that's already breached returns -2021 and we'd be left unprotected
      // (or with a local bracket that closes immediately at a loss).
      let markForCheck = Number(markPxHint);
      if (!Number.isFinite(markForCheck) || markForCheck <= 0) {
        try {
          const cached = _getMarkPxFromCache(symU);
          if (cached != null) markForCheck = cached;
          else {
            const d = await publicGet("/fapi/v1/premiumIndex", { symbol: symU });
            markForCheck = Number(d?.markPrice);
          }
        } catch { /* use hint */ }
      }
      if (Number.isFinite(markForCheck) && markForCheck > 0) {
        const wouldTrigger = isLong
          ? markForCheck <= newSlPx
          : markForCheck >= newSlPx;
        if (wouldTrigger) {
          log?.warn?.("binance_demo_futures_trail_sl_skip_would_trigger", {
            symbol: symU,
            newSlPx,
            markPx: markForCheck,
            msg: "Skipping SL replace — new trailing SL would immediately trigger; keeping existing exchange SL",
          });
          return { ok: false, code: -2021, msg: "skip_would_trigger_precheck" };
        }
      }

      // ── Step 1: Cancel all existing SL orders for this direction (TP untouched) ──
      await cancelAllStopLossOrdersForDirection(symU, tgt.closeSide);
      slTpOpenOrdersCacheBySym.delete(symU);

      // ── Step 2: Place new SL (shared attempt path also used for rollback) ──
      const prNew = await executePlaceAttempts(newSlPx);
      if (prNew.immediate2021) {
        return { ok: true, localBracketInstalled: true };
      }
      if (prNew.placed) {
        mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: newSlPx };
        log?.info?.("binance_demo_futures_trail_sl_replaced", { symbol: symU, newSl: newSlPx });
        return { ok: true };
      }

      const prevBk = Number(previousExchangeSlPx);
      const prevOk =
        Number.isFinite(prevBk) &&
        prevBk > 0 &&
        Math.abs(prevBk - newSlPx) / Math.max(newSlPx, 1e-12) > 1e-10;
      if (prevOk && Number.isFinite(markForCheck) && markForCheck > 0) {
        const rbTrig = isLong ? markForCheck <= prevBk : markForCheck >= prevBk;
        if (!rbTrig) {
          const prRb = await executePlaceAttempts(prevBk);
          if (prRb.immediate2021) {
            return { ok: true, localBracketInstalled: true };
          }
          if (prRb.placed) {
            mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: prevBk };
            log?.warn?.("binance_demo_futures_trail_sl_rollback_previous_restored", {
              symbol: symU,
              rollbackSl: prevBk,
              failedNewSl: newSlPx,
              lastCode: prNew.lastCode,
              lastMsg: prNew.lastMsg,
            });
            return {
              ok: false,
              code: prNew.lastCode,
              msg: "trail_new_failed_restored_previous_sl",
              rolledBack: true,
              rollbackSl: prevBk,
              localBracketInstalled: false,
            };
          }
        }
      }

      const safetySl = prevOk && Number.isFinite(prevBk) && prevBk > 0 ? prevBk : newSlPx;
      log?.warn?.("binance_demo_futures_trail_sl_place_failed_safety_bracket", {
        symbol: symU,
        newSlPx,
        safetySl,
        code: prNew.lastCode,
        msg: prNew.lastMsg,
      });
      const qStr = resolveQtyStr();
      const positionSideField = hedgeExtrasR.positionSide || undefined;
      mem.localBrackets[symU] = {
        stopLoss: safetySl,
        takeProfit: Number(tgt.takeProfit) || (isLong ? safetySl * 10 : safetySl * 0.01),
        isLong,
        closeSide: tgt.closeSide,
        qty: qStr || tgt.qty || "0",
        positionSide: positionSideField,
        entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
        leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
        strategy: "trailing_sl_safety",
        _installedAt: Date.now(),
      };
      mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: safetySl };
      return { ok: false, code: prNew.lastCode, msg: prNew.lastMsg || "not_placed", localBracketInstalled: true };
    } catch (e) {
      const code = e?.cause?.response?.data?.code ?? e?.response?.data?.code ?? null;
      const msg = e?.cause?.response?.data?.msg ?? e?.response?.data?.msg ?? e?.message ?? null;
      log?.warn?.("binance_demo_futures_trail_replace_sl_failed", {
        symbol: symU,
        newSlPx,
        code,
        msg,
        error: String(e?.message || e),
      });
      // If the cancel already ran, position may be unprotected. Install local bracket as safety.
      if (!mem.localBrackets[symU]) {
        const qStr = resolveQtyStr();
        const positionSideField = (tgt.hedgeExtras || {}).positionSide || undefined;
        mem.localBrackets[symU] = {
          stopLoss: newSlPx,
          takeProfit: Number(tgt.takeProfit) || (isLong ? newSlPx * 10 : newSlPx * 0.01),
          isLong,
          closeSide: tgt.closeSide,
          qty: qStr || tgt.qty || "0",
          positionSide: positionSideField,
          entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
          leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
          strategy: "trailing_sl_safety",
          _installedAt: Date.now(),
        };
        mem.placedBracketTargets[symU] = { ...tgt, stopLoss: newSlPx };
      }
      return { ok: false, code, msg, localBracketInstalled: true };
    }
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
          /** Bot trailing target (`placedBracketTargets`) is the configured/engine SL; exchange `oo.sl` can lag or differ mid-replace. */
          const pbSl =
            pb?.stopLoss != null && Number.isFinite(Number(pb.stopLoss)) && Number(pb.stopLoss) > 0
              ? Number(pb.stopLoss)
              : null;
          let stopLossOut = null;
          let takeProfitOut = null;
          if (trail && pbSl != null) {
            stopLossOut = pbSl;
            const pbTp =
              pb?.takeProfit != null && Number.isFinite(Number(pb.takeProfit)) && Number(pb.takeProfit) > 0
                ? Number(pb.takeProfit)
                : null;
            takeProfitOut = pbTp ?? oo.tp ?? lb?.takeProfit ?? openSlTp.tp ?? null;
          } else {
            stopLossOut = oo.sl ?? lb?.stopLoss ?? pb?.stopLoss ?? openSlTp.sl ?? null;
            takeProfitOut = oo.tp ?? lb?.takeProfit ?? pb?.takeProfit ?? openSlTp.tp ?? null;
          }
          const row = {
            id: `fut_${sym}`,
            symbol: sym,
            side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
            qty: Math.abs(Number(p.positionAmt)),
            entryPrice: Number(p.entryPrice || 0),
            unrealizedPnl: Number(p.unrealizedProfit || 0),
            stopLoss: stopLossOut,
            takeProfit: takeProfitOut,
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
          if (trail) {
            row.meta = {
              ...entryMeta,
              autoTradeTrailing: true,
              trailStep: Number(trail.trailStep) || 0,
              confirmedTrailStep: Math.max(0, Math.floor(Number(trail.confirmedTrailStep) || 0)),
              extremePx: trail.extremePx,
              trailTierLabel: trail.trailTierLabel ?? null,
              ...(trail.entryPrice != null ? { entryPrice: trail.entryPrice } : {}),
              ...(trail.trailLadderSnapshotV1 ? { trailLadderSnapshotV1: { ...trail.trailLadderSnapshotV1 } } : {}),
              ...(pbSl != null ? { slDisplaySource: "bot_trailing_target" } : { slDisplaySource: "exchange_or_fallback" }),
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
        log?.warn?.("binance_demo_futures_positions_failed", { error: String(e?.message || e) });
        return [];
      }
    },
    async getTrades(opts = {}) {
      if (opts?.forceReconcile === true) mem.forceNextIncomeSync = true;
      await refreshUsdMPositionSnapshotAndReconcile();
      await syncRealizedIncomeFromExchange();
      await backfillMissingOpenCommissionsUsdM();
      // Do not truncate here — hybrid / ingestClosedTrades rely on a monotonically growing tail length.
      return mem.trades.slice(-MAX_MEM_TRADES);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      if (!apiKey || !apiSecret) throw new Error("binance_demo_futures_missing_keys");
      const isLong = side === "BUY";
      if (side !== "BUY" && side !== "SELL") throw new Error("bad_side");

      const symNorm = String(symbol || "").toUpperCase();
      const m = await getOrLoadSymbolMeta(symNorm);
      let qtyStr = formatToStep(qty, m);
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
          const qtyStr2 = formatToStep(qty2, m);
          if (!qtyStr2 || Number(qtyStr2) <= 0) throw e;
          if (m.minNotional && Number(qtyStr2) * pxUse + 1e-8 < Number(m.minNotional)) throw e;
          log?.warn?.("binance_demo_futures_downsize_max_position", {
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
        log?.info?.("binance_demo_futures_sltp_refined_vs_mark", {
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
          logPrefix: "binance_demo_futures",
        });
        bracketsPlaced = true;
        mem.placedBracketTargets[symNorm] = { stopLoss: stopPx, takeProfit: tpPx };
      } catch (e) {
        const is4120 = futuresOrderIs4120(e);
        if (is4120) {
          log?.warn?.("binance_demo_futures_brackets_unsupported_using_local", {
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
          log?.warn?.("binance_demo_futures_bracket_failed_flatten", { symbol: symNorm, error: String(e?.message || e) });
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
          ...(out?.type ? { entryBinanceOrderType: String(out.type) } : {}),
          ...(out?.timeInForce ? { entryTimeInForce: String(out.timeInForce) } : {}),
          ...(clientOid ? { clientOrderId: clientOid } : {}),
        },
      });
      if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);

      /** Don't await userTrades before SL/TP — extra REST hop would delay bracket protection.
       *  `avgFillPriceFromUsdMNewOrder` uses the POST response `avgPrice`, which is often "0.00"
       *  before fills settle. `userTrades` is the authoritative qty-weighted mean. Updating
       *  `price` here feeds every downstream derivative — margin (entry × qty / lev), PnL basis,
       *  restart trail reconstruction. */
      void (async () => {
        try {
          const det = await fetchUsdMOrderCommissionDetailsWithRetry({
            signed,
            publicGet,
            symbol: symNorm,
            orderId,
            log,
          });
          if (det == null) return;
          const hasCommission = det.usdt > 0;
          const hasFill =
            det.avgPrice != null && Number.isFinite(Number(det.avgPrice)) && Number(det.avgPrice) > 0;
          if (!hasCommission && !hasFill) return;
          for (let i = mem.trades.length - 1; i >= 0; i--) {
            const tr = mem.trades[i];
            if (tr?.type === "OPEN" && String(tr.id) === String(posId)) {
              const prevMeta = tr.meta || {};
              const patchMeta = {};
              if (hasCommission) {
                tr.fee = det.usdt;
                patchMeta.openFee = det.usdt;
                patchMeta.commissionSource = "fapi_userTrades";
                if (det.allMaker === true) patchMeta.entryAllMaker = true;
                else if (det.allMaker === false) patchMeta.entryAllMaker = false;
              }
              if (hasFill) {
                tr.price = Number(det.avgPrice);
                patchMeta.entryAvgFillPrice = Number(det.avgPrice);
                patchMeta.entryPriceSource = "fapi_userTrades";
                if (
                  Number.isFinite(Number(det.filledQty)) &&
                  Number(det.filledQty) > 0 &&
                  Math.abs(Number(det.filledQty) - Number(tr.qty || 0)) > 1e-8
                ) {
                  tr.qty = Number(det.filledQty);
                  patchMeta.entryFilledQty = Number(det.filledQty);
                }
              }
              tr.meta = { ...prevMeta, ...patchMeta };
              break;
            }
          }
        } catch {
          /* ignore */
        }
      })();

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
      // Expand placedBracketTargets to include details needed for SL order replacement during trailing.
      if (bracketsPlaced && mem.placedBracketTargets[symNorm]) {
        mem.placedBracketTargets[symNorm] = {
          ...mem.placedBracketTargets[symNorm],
          closeSide,
          hedgeExtras: { ...hedgeExtras },
          qty: executedQty,
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
        log?.warn?.("binance_demo_futures_post_open_verify_flat", {
          symbol: symNorm,
          posId,
          absAmt: posCheck.absAmt,
        });
        throw new Error(
          `binance_demo_futures_post_open_flat:${symNorm} — market reported a fill but /fapi/v2/account shows no open position (e.g. SL/TP triggered instantly, or exchange lag). Check Binance order history.`,
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
          log?.warn?.("binance_demo_futures_post_open_immediate_flat", {
            symbol: symNorm,
            posId,
            stableMs,
            exitPx: immediateCloseTrade.price,
          });
        }
      }

      return {
        id: posId,
        /** Exchange entry order id — unique per open; `id` stays `fut_<SYM>` for position linking. */
        binanceOrderId: orderId,
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
      await backfillMissingOpenCommissionsUsdM();

      const primarySymU = String(symbol || "").toUpperCase();

      async function markPxForSymbol(sym) {
        const u = String(sym || "").toUpperCase();
        // Prefer mark-price WS cache when available (sub-second), otherwise use premiumIndex REST.
        // Do not use the bot-provided candle close as "mark" — that causes missed trailing activations.
        const cached = _getMarkPxFromCache(u);
        if (cached != null && Number.isFinite(cached) && cached > 0) return cached;
        try {
          const d = await publicGet("/fapi/v1/premiumIndex", { symbol: u });
          const m = Number(d?.markPrice);
          return Number.isFinite(m) && m > 0 ? m : NaN;
        } catch {
          return NaN;
        }
      }

      const stBySym =
        trailingStopLoss?.supertrendBySymbol && typeof trailingStopLoss.supertrendBySymbol === "object"
          ? trailingStopLoss.supertrendBySymbol
          : null;
      const trailMode = String(trailingStopLoss?.mode || "SUPERTREND").toUpperCase();

      if (trailingStopLoss?.enabled) {
        // Reconstruct trailingBySymbol for open positions that lost in-memory state on bot restart.
        // This ensures trailing evaluation runs for all open positions, not only newly placed ones.
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
            log?.info?.("binance_demo_futures_trail_state_reconstructed", { symbol: symU, entryPx, isLong: posIsLong });
            // Seed placedBracketTargets from exchange open orders so applyTrailingStopBinanceMemory
            // has a valid prevSl to work with on the first tick after restart.
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
                  log?.info?.("binance_demo_futures_trail_bracket_seeded", { symbol: symU, sl: oo.sl, tp: oo.tp });
                }
              } catch {
                // ignore — will retry next tick
              }
            }
          }
        }

        // Cache config for real-time poll (always refresh on each candle tick)
        _cachedTrailingConfig = {
          trailingStopLoss,
          onTrailingSlAdvance,
          notifyActivity,
          primaryChartSymU: primarySymU,
        };

        const trailSyms = [...new Set(Object.keys(mem.trailingBySymbol).map((k) => String(k || "").toUpperCase()))];

        // Fetch all mark prices in parallel (all symbols use mark price: WS cache or premiumIndex)
        const markPxResults = await Promise.allSettled(trailSyms.map((s) => markPxForSymbol(s)));
        const markPxBySymbol = new Map();
        trailSyms.forEach((s, i) => {
          const r = markPxResults[i];
          if (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0) markPxBySymbol.set(s, r.value);
        });

        // Determine active symbols using snapshot qty (no per-symbol API call)
        const activeTrailSyms = trailSyms.filter((s) => {
          if (!mem.trailingBySymbol[s] || !markPxBySymbol.has(s)) return false;
          const qty = qtyAbsFromSnapshot(s);
          if (Number.isNaN(qty)) return false; // snapshot not ready — skip, not clear
          if (qty < 1e-8) { clearMemBracketTrailForSymbol(s); return false; }
          return true;
        });

        // Evaluate trailing for all active symbols in parallel
        await Promise.all(
          activeTrailSyms.map((s) =>
            evalTrailingForSymbol(s, markPxBySymbol.get(s), trailingStopLoss, onTrailingSlAdvance, notifyActivity, primarySymU),
          ),
        );
      }

      // Local SL/TP enforcement for positions where exchange brackets failed (-4120)
      for (const lbSym of Object.keys(mem.localBrackets)) {
        const markPx = await markPxForSymbol(lbSym);
        if (!Number.isFinite(markPx) || markPx <= 0) continue;
        const b = mem.localBrackets[lbSym];
        if (!b) continue;
        // Trailing safety brackets get a cooldown — they are fallbacks from failed SL placement,
        // not intentional local-only brackets. Enforcing them instantly can close a position
        // that still has a valid exchange SL or where the mark is just momentarily at the edge.
        if (
          (b.strategy === "trailing_sl_safety" || b.strategy === "trailing_sl_breach") &&
          b._installedAt != null &&
          Date.now() - b._installedAt < 10_000
        ) {
          continue;
        }
        const bracketLo = Math.min(b.stopLoss, b.takeProfit) * 0.90;
        const bracketHi = Math.max(b.stopLoss, b.takeProfit) * 1.10;
        if (markPx < bracketLo || markPx > bracketHi) {
          continue;
        }
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
          log?.info?.("binance_demo_futures_local_bracket_hit", {
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
          mem.forceNextIncomeSync = true;
          delete mem.localBrackets[lbSym];
          delete mem.placedBracketTargets[lbSym];
          delete mem.trailingBySymbol[symU];
        } catch (e) {
          log?.warn?.("binance_demo_futures_local_bracket_close_failed", {
            symbol: lbSym,
            hit,
            error: String(e?.message || e),
          });
        }
      }
    },
    async closePosition({ id, notifyActivity, reason: userCloseReason } = {}) {
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
      mem.forceNextIncomeSync = true;
      delete mem.localBrackets[p.symbol];
      delete mem.placedBracketTargets[p.symbol];
      delete mem.trailingBySymbol[String(p.symbol || "").toUpperCase()];
      notifyActivity?.({
        level: "info",
        msg: isSignal
          ? `Signal close · ${p.symbol} · reduce-only market order sent (USD-M demo)`
          : `Manual close · ${p.symbol} · reduce-only market order sent (USD-M demo)`,
        category: "risk",
        reason: isSignal ? "supertrend_exit" : "manual_close",
        symbol: p.symbol,
        detail: { positionId: sid, venue: "FUTURES", exchange: "binance_demo_futures_usdm", userCloseReason },
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
    /**
     * Start a real-time trailing poll that runs every `intervalMs` ms independently of candle ticks.
     * Uses the last cached trailing config; refreshed on every `markToMarket` call.
     * @param {number} [intervalMs=3000]
     */
    startRealtimeTrailingPoll(intervalMs = 3000) {
      // Stop any existing loop first
      if (_realtimeTrailingTimer != null) {
        clearTimeout(_realtimeTrailingTimer);
        _realtimeTrailingTimer = null;
      }
      const ms = Math.max(1000, Number(intervalMs) || 3000);
      const loop = async () => {
        try {
          await _runRealtimePoll();
        } catch {
          // ignore — loop must survive errors
        }
        _realtimeTrailingTimer = setTimeout(loop, ms);
      };
      _realtimeTrailingTimer = setTimeout(loop, ms);
      log?.info?.("binance_demo_futures_realtime_trail_started", { intervalMs: ms });
    },
    /** Stop the real-time trailing poll and mark-price WS (called on bot shutdown). */
    stopRealtimeTrailingPoll() {
      if (_realtimeTrailingTimer != null) {
        clearTimeout(_realtimeTrailingTimer);
        _realtimeTrailingTimer = null;
      }
      if (_markPxWsReconnectTimer) { clearTimeout(_markPxWsReconnectTimer); _markPxWsReconnectTimer = null; }
      if (_markPxWs) {
        try { _markPxWs.removeAllListeners?.(); _markPxWs.terminate?.(); } catch { /* */ }
        _markPxWs = null;
      }
      _markPxCache.clear();
      log?.info?.("binance_demo_futures_realtime_trail_stopped");
    },
    /** Refresh the trailing config used by the real-time poll. Called once per candle tick. */
    updateRealtimeTrailingConfig({ trailingStopLoss, onTrailingSlAdvance, notifyActivity, primaryChartSymU } = {}) {
      if (trailingStopLoss?.enabled) {
        const prev = _cachedTrailingConfig;
        const prim = String(primaryChartSymU ?? prev?.primaryChartSymU ?? "").toUpperCase() || undefined;
        _cachedTrailingConfig = {
          trailingStopLoss,
          onTrailingSlAdvance,
          notifyActivity,
          ...(prim ? { primaryChartSymU: prim } : {}),
        };
      } else {
        _cachedTrailingConfig = null;
      }
    },
    /**
     * Run a single poll cycle immediately (used for restart catch-up to apply farthest crossed tier at once).
     * Optionally overrides _cachedTrailingConfig for this one run.
     */
    async runRealtimePollOnce({ trailingStopLoss, onTrailingSlAdvance, notifyActivity, primaryChartSymU } = {}) {
      if (trailingStopLoss?.enabled) {
        const prev = _cachedTrailingConfig;
        const prim = String(primaryChartSymU ?? prev?.primaryChartSymU ?? "").toUpperCase() || undefined;
        _cachedTrailingConfig = {
          trailingStopLoss,
          onTrailingSlAdvance,
          notifyActivity,
          ...(prim ? { primaryChartSymU: prim } : {}),
        };
      }
      await _runRealtimePoll();
    },
    async close() {
      // Stop real-time trailing poll on exchange close
      if (_realtimeTrailingTimer != null) {
        clearTimeout(_realtimeTrailingTimer);
        _realtimeTrailingTimer = null;
      }
    },
    getStatus() {
      return { udf: { ok: true, syncMode: "rest", error: null } };
    },
    /**
     * Recover extremePx for open trailing positions by scanning historical candles since entry.
     * Mirrors the same method in paperFutures — call once per symbol before the first markToMarket
     * after startup so that any price excursion during bot downtime is captured.
     * @param {Record<string, Array<{time?: number; high?: number; low?: number; close?: number}>>} candlesBySymbol
     */
    recoverTrailingExtremeFromCandles(candlesBySymbol = {}) {
      for (const [symU, tr] of Object.entries(mem.trailingBySymbol)) {
        const bars = candlesBySymbol[symU];
        if (!Array.isArray(bars) || !bars.length) continue;
        const isLong = Boolean(tr.isLong);
        let candleExtreme;
        if (isLong) {
          candleExtreme = bars.reduce((mx, b) => Math.max(mx, Number(b.high) || Number(b.close) || 0), 0);
        } else {
          candleExtreme = bars.reduce((mn, b) => Math.min(mn, Number(b.low) || Number(b.close) || Infinity), Infinity);
        }
        if (!Number.isFinite(candleExtreme) || candleExtreme <= 0 || candleExtreme === Infinity) continue;
        const currentExtreme = Number.isFinite(Number(tr.extremePx)) ? Number(tr.extremePx) : Number(tr.entryPrice ?? 0);
        if (isLong) {
          const merged = Math.max(currentExtreme, candleExtreme);
          if (merged > currentExtreme) {
            tr.extremePx = merged;
            log?.debug?.("trail_extreme_recovered_demo", {
              symbol: symU,
              side: "LONG",
              extremePx: merged,
              prevExtreme: currentExtreme,
            });
          }
        } else {
          const merged = Math.min(currentExtreme, candleExtreme);
          if (merged < currentExtreme) {
            tr.extremePx = merged;
            log?.debug?.("trail_extreme_recovered_demo", {
              symbol: symU,
              side: "SHORT",
              extremePx: merged,
              prevExtreme: currentExtreme,
            });
          }
        }
      }
    },
  };
}

