import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import WsModule from "ws";
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
  refineCloseReasonFromExitFill,
  trailCloseFieldsFromMemory,
} from "../../lib/binanceUsdmCloseReasonHint.js";
import { TRAIL_TIER_SCHEMA_VERSION } from "../../lib/supertrendTrailingSl.js";
import { binanceUsdmMarketCombinedBaseFromWsBase, routeBinanceUsdmWsBase } from "../../lib/binanceUsdmWsRoute.js";
import {
  fetchUsdMOrderCommissionDetails,
  fetchUsdMOrderCommissionDetailsWithRetry,
  fetchUsdMTradeByTradeId,
  synthesizeOpenLegUsdMFromIncomeClose,
} from "../../lib/binanceUsdMUserTradeCommission.js";
import {
  binanceRecvWindowMs,
  createBinanceServerTimeSkew,
  isBinanceRecvWindowOrTimestampError,
} from "../../lib/binanceSignedHttp.js";
import { createUsdMUserDataStream } from "../../lib/binanceUsdMUserDataStream.js";

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

export function createBinanceLiveFuturesUsdMExchange({ log, apiKey: apiKeyOverride, apiSecret: apiSecretOverride } = {}) {
  // Prefer BINANCE_LIVE_FUTURES_*; else same BINANCE_LIVE_* as spot.
  const apiKey =
    (apiKeyOverride ?? process.env.BINANCE_LIVE_FUTURES_API_KEY ?? process.env.BINANCE_LIVE_API_KEY) || "";
  const apiSecret =
    (apiSecretOverride ?? process.env.BINANCE_LIVE_FUTURES_API_SECRET ?? process.env.BINANCE_LIVE_API_SECRET) || "";
  const baseURL = process.env.BINANCE_LIVE_FUTURES_REST_BASE || "https://fapi.binance.com";
  const defaultLeverage = Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5)));

  const http = axios.create({
    baseURL,
    timeout: 10_000,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  const timeSkew = createBinanceServerTimeSkew({ log, tag: "binance_live_futures_usdm" });
  async function fetchServerTimeMs() {
    const { data } = await http.request({ method: "GET", url: "/fapi/v1/time", headers: {} });
    return Number(data?.serverTime);
  }

  /** Per-symbol SL/TP from open orders (2s TTL). Scoped GETs avoid missing older SL legs in unpaged “all symbols” responses. */
  const slTpOpenOrdersCacheBySym = new Map();

  async function signed(method, path, params = {}) {
    await timeSkew.ensureFresh(fetchServerTimeMs);
    const recvWindow = binanceRecvWindowMs();
    const buildUrl = () => {
      const ts = timeSkew.timestampMs();
      const qp = new URLSearchParams({ ...params, timestamp: String(ts), recvWindow: String(recvWindow) });
      const sig = hmacSha256(apiSecret, qp.toString());
      qp.set("signature", sig);
      return `${path}?${qp.toString()}`;
    };
    let url = buildUrl();
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
      if (isBinanceRecvWindowOrTimestampError(err)) {
        timeSkew.invalidateSyncClock();
        await timeSkew.ensureFresh(fetchServerTimeMs, true);
        url = buildUrl();
        const { data } = await http.request({ method, url });
        return data;
      }
      throw err;
    }
  }

  async function publicGet(path, params = {}) {
    const qp = new URLSearchParams({ ...params });
    const url = qp.toString() ? `${path}?${qp.toString()}` : path;
    const { data } = await http.request({ method: "GET", url, headers: {} });
    return data;
  }

  /**
   * `getAccount()` + `getPositions()` both read `/fapi/v2/account`. The bot calls them back-to-back each
   * refresh — without coalescing, REST lags roughly one extra RTT behind kline OHLC (WS ~1s ticks).
   * Set `BINANCE_USDM_ACCOUNT_SNAPSHOT_COALESCE_MS=0` to disable (two GETs per refresh).
   */
  let _acctSnapCoalesce = { at: 0, data: null };
  const ACCT_SNAP_COALESCE_MS = Math.max(
    0,
    Math.min(5000, Number(process.env.BINANCE_USDM_ACCOUNT_SNAPSHOT_COALESCE_MS ?? 700)),
  );

  const UDS_ENABLED = String(process.env.BINANCE_USDM_USER_DATA_STREAM ?? "1").toLowerCase() !== "0";
  const userWsBase =
    String(process.env.BINANCE_LIVE_FUTURES_USER_WS_BASE || "").trim() || "wss://fstream.binance.com/ws";
  const UDS_FRESH_MS = Math.max(2000, Math.min(120_000, Number(process.env.BINANCE_USDM_USER_STREAM_FRESH_MS ?? 8000)));

  const usdMUserStream =
    UDS_ENABLED && apiKey
      ? createUsdMUserDataStream({
          log,
          tag: "binance_live_futures_usdm",
          http,
          apiKey,
          userWsBase,
          WebSocket: WsModule,
        })
      : null;

  let _udsStartInFlight = false;
  function ensureUsdMUserStream() {
    if (!usdMUserStream || _udsStartInFlight) return;
    _udsStartInFlight = true;
    usdMUserStream
      .start()
      .catch((e) => log?.warn?.("binance_live_futures_usdm_uds_start_failed", { error: String(e?.message || e) }))
      .finally(() => {
        _udsStartInFlight = false;
      });
  }

  async function getAccountSnapshotCoalesced() {
    const now = Date.now();
    ensureUsdMUserStream();
    if (usdMUserStream?.connected && usdMUserStream.isFresh(now, UDS_FRESH_MS) && usdMUserStream.getMergedAccount()) {
      const snap = usdMUserStream.getMergedAccount();
      _acctSnapCoalesce = { at: now, data: snap };
      return snap;
    }
    if (
      ACCT_SNAP_COALESCE_MS > 0 &&
      _acctSnapCoalesce.data != null &&
      now - _acctSnapCoalesce.at < ACCT_SNAP_COALESCE_MS
    ) {
      return _acctSnapCoalesce.data;
    }
    const data = await signed("GET", "/fapi/v2/account");
    usdMUserStream?.ingestRestSnapshot(data);
    _acctSnapCoalesce = { at: Date.now(), data };
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
  /**
   * When true, REALIZED_PNL that doesn’t match `recentLocalCloses` is omitted from trade rows (Binance-first
   * history off). Default false: materialize unmatched REALIZED_PNL as CLOSE rows so round-trip fees/PnL match the exchange.
   * Set `BINANCE_LIVE_INCOME_STRATEGY_ONLY=1` for the old “strategy-first” view.
   * Legacy: explicit `BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED=0` still implies strategy-only; `=1` implies full ledger.
   */
  const rawIncomeIncludeUnmatched = process.env.BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED;
  const legacyIncomeStrategyOnly =
    rawIncomeIncludeUnmatched != null &&
    String(rawIncomeIncludeUnmatched).trim() !== "" &&
    String(rawIncomeIncludeUnmatched) !== "1";
  const strategyOnlyIncomeLedger =
    String(process.env.BINANCE_LIVE_INCOME_STRATEGY_ONLY || "0") === "1" || legacyIncomeStrategyOnly;
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
    /** Funding income ledger: `[{ tranId, symbol, time, amt }]`. Late rows get retroactively
     *  attributed to their owning round-trip CLOSE. Bounded for memory. */
    fundingRows: [],
    seenFundingIds: new Set(),
    /** @type {number | null} */
    fundingCursorMs: null,
    lastFundingPollAt: 0,
    /** CLOSE `orderId`s for which we already inserted a synthetic OPEN from `userTrades`. */
    syntheticOpenCloseOrderIds: new Set(),
    /** Set when a position goes flat — next income poll runs immediately (see `syncRealizedIncomeFromExchange`). */
    forceNextIncomeSync: false,
  };

  const trailSymLock = new Set();

  // ─── Mark-price WebSocket (replaces per-tick REST `premiumIndex` polling) ───
  // Subscribes to `<sym>@markPrice@1s` for every symbol we trail. Sub-second push
  // avoids the REST round-trip cost (~150–300 ms) that was causing trailing logic
  // to compare against stale mark values and miss tier activations. REST stays as
  // a fallback when the cache is empty or stale (>5 s).
  const _markPxCache = new Map();
  let _markPxWs = null;
  let _markPxWsReconnectTimer = null;
  let _markPxWsSymbols = [];
  let _markPxWsReconnectAttempt = 0;
  const MARKPX_WS_RECONNECT_MIN_MS = Math.max(
    500,
    Number(process.env.BINANCE_LIVE_MARKPX_WS_RECONNECT_MIN_MS ?? 1500),
  );
  const MARKPX_WS_RECONNECT_MAX_MS = Math.max(
    MARKPX_WS_RECONNECT_MIN_MS,
    Number(process.env.BINANCE_LIVE_MARKPX_WS_RECONNECT_MAX_MS ?? 30_000),
  );
  const MARKPX_CACHE_STALENESS_MS = Math.max(
    1000,
    Number(process.env.BINANCE_LIVE_MARKPX_MAX_AGE_MS ?? 5000),
  );

  function _connectMarkPxWs() {
    if (_markPxWs) {
      try {
        _markPxWs.removeAllListeners?.();
        _markPxWs.terminate?.();
      } catch {
        /* ignore */
      }
      _markPxWs = null;
    }
    const syms = _markPxWsSymbols;
    if (!syms.length) return;

    const wsBaseUrl =
      process.env.BINANCE_LIVE_FUTURES_WS_BASE ||
      process.env.BINANCE_FUTURES_WS_BASE ||
      "wss://fstream.binance.com/market/ws";
    const baseRouted = routeBinanceUsdmWsBase(wsBaseUrl.replace(/\/$/, ""), "market");
    const streams = syms.map((s) => `${s.toLowerCase()}@markPrice@1s`);
    const url =
      streams.length === 1
        ? `${baseRouted}/${streams[0]}`
        : `${binanceUsdmMarketCombinedBaseFromWsBase(baseRouted)}?streams=${streams.join("/")}`;

    let ws;
    try {
      ws = new WsModule(url);
    } catch (e) {
      log?.warn?.("binance_live_futures_markpx_ws_construct_failed", {
        error: String(e?.message || e),
      });
      return;
    }
    _markPxWs = ws;
    ws.on?.("open", () => {
      _markPxWsReconnectAttempt = 0;
      log?.info?.("binance_live_futures_markpx_ws_open", {
        count: syms.length,
        symbols: syms.slice(0, 8),
      });
    });
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
      } catch {
        /* ignore */
      }
    });
    ws.on?.("error", (err) => {
      log?.warn?.("binance_live_futures_markpx_ws_error", {
        error: String(err?.message || err),
      });
    });
    ws.on?.("close", () => {
      _markPxWs = null;
      if (_markPxWsReconnectTimer) clearTimeout(_markPxWsReconnectTimer);
      const exp = Math.min(
        MARKPX_WS_RECONNECT_MAX_MS,
        MARKPX_WS_RECONNECT_MIN_MS * Math.pow(2, Math.min(8, _markPxWsReconnectAttempt)),
      );
      const jitter = Math.floor(Math.random() * 400);
      _markPxWsReconnectAttempt += 1;
      _markPxWsReconnectTimer = setTimeout(() => {
        _markPxWsReconnectTimer = null;
        _connectMarkPxWs();
      }, exp + jitter);
    });
  }

  function _ensureMarkPxWs(symbols) {
    const sorted = [...new Set((symbols || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))].sort();
    const prev = [..._markPxWsSymbols].sort();
    if (sorted.length === 0) return;
    if (sorted.join(",") === prev.join(",") && _markPxWs?.readyState === 1) return;
    _markPxWsSymbols = sorted;
    _connectMarkPxWs();
  }

  function _getMarkPxFromCache(symU, maxAgeMs = MARKPX_CACHE_STALENESS_MS) {
    const entry = _markPxCache.get(String(symU || "").toUpperCase());
    if (!entry) return null;
    if (Date.now() - entry.at > maxAgeMs) return null;
    return entry.px;
  }

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
      if (raw.fundingCursorMs != null) mem.fundingCursorMs = Number(raw.fundingCursorMs);
      for (const id of (raw.seenFundingIds || []).slice(-8000)) mem.seenFundingIds.add(String(id));
      if (Array.isArray(raw.fundingRows)) {
        mem.fundingRows = raw.fundingRows
          .filter((r) => r && r.symbol && Number.isFinite(Number(r.amt)) && Number.isFinite(Number(r.time)))
          .slice(-5000);
      }
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
        incomeType: "FUNDING_FEE",
        startTime: String(start),
        limit: "1000",
      });
    } catch (e) {
      log?.warn?.("binance_live_futures_funding_poll_failed", { error: String(e?.message || e) });
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
    /** Cheap OPEN lookup per symbol — scan back from CLOSE i until we hit an OPEN on same symbol. */
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
      // Negative income = trader PAID funding → add to fee (cost). Positive income = trader RECEIVED
      // funding → fee goes down. Store signed funding on meta so UI can display breakdown.
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
   * OPEN leg for the position being closed: **strictly before** this close's income time.
   * `findLastOpenRefForSym` alone is unsafe when a newer same-symbol OPEN exists (late income sync
   * or overlapping cycles) — it would pair the wrong entry with Binance REALIZED_PNL.
   *
   * @param {string} symU
   * @param {number} closeEventMs
   * @param {string} closeSide  reduce-only close side (BUY closes a short, SELL closes a long)
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
   * generic `EXCHANGE_REALIZED` / `MANUAL_CLOSE` / `STOP_LOSS_DEFAULT` labels to `STOP_LOSS` /
   * `TAKE_PROFIT` / `TRAILED_SUPERTREND_Tnn` when the real fill landed within {@link CLOSE_REASON_FILL_BAND}
   * of SL/TP. Never downgrades an already-specific reason.
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

  /**
   * Insert a synthetic OPEN from `userTrades` when income created a CLOSE but no OPEN row exists
   * (restart / external entry / eviction).
   */
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
   *
   * @param {{
   *   sym: string;
   *   tid: string;
   *   tradeId: string;
   *   tradeDetail: { orderId: string|null; price: number; qty: number; commissionUsdt: number; side: string; } | null;
   *   closeOrderId: string;
   *   pnl: number;
   *   eventMs: number;
   *   tsIso: string;
   *   rawRow: any;
   *   lcHint: any | null;
   * }} p
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
      /** Accumulate per-fill shard into existing row. */
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

    /** First fill for this orderId → create a new CLOSE row. Prefer local close hint for trail state
     * / bracket / strategy metadata, but per-fill figures come from `tradeDetail`. */
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
    let openRef =
      cs0 !== "—" ? findOpenRefForSymBeforeClose(sym, eventMs, cs0) || lo : lo;
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

    let reasonInit = lcHint ? closeReasonFromLocalCloseHint(lcHint) : "EXCHANGE_REALIZED";
    if (!lcHint) {
      // `exchangeNativeClose` flag mirrors reconciler semantics for consistent downstream filtering.
      reasonInit = "EXCHANGE_REALIZED";
    }

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
      log?.warn?.("binance_live_futures_funding_sync_failed", { error: String(e?.message || e) }),
    );
    const bypassIncomeThrottle = mem.forceNextIncomeSync === true;
    if (bypassIncomeThrottle) mem.forceNextIncomeSync = false;
    const now = Date.now();
    const incomePollMinMs = Math.max(
      800,
      Math.min(10_000, Number(process.env.BINANCE_INCOME_POLL_MIN_MS ?? 1500)),
    );
    if (!bypassIncomeThrottle && now - mem.lastIncomePollAt < incomePollMinMs) return;
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

      /**
       * Discover the canonical `closeOrderId` behind this income shard via `tradeId` — Binance splits one
       * reduce-only close into many REALIZED_PNL rows (one per fill), each with its own tranId but the
       * SAME underlying orderId. Without this lookup, every shard produced a duplicate CLOSE history row
       * with the full OPEN leg qty re-applied, which massively inflated displayed fees (fallback
       * computed as qty × exitPx × rate per shard) and decoupled Net PnL from Binance's true total.
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
       * PRIMARY AGGREGATION PATH: when we know the `closeOrderId`, merge every fill for that order into
       * a single CLOSE row with true qty / avg fill price / real commission — regardless of whether a
       * local close hint exists. This collapses the 7-shards-per-close pattern that caused bogus
       * duplicate rows and the corresponding fee inflation (e.g. 7 × $1.03 ≈ $7.20 of fake fee).
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
          /** Exit avg fill may have just been populated — upgrade generic reasons (`EXCHANGE_REALIZED`
           * / `MANUAL_CLOSE` / `STOP_LOSS_DEFAULT`) to `STOP_LOSS` / `TAKE_PROFIT` when fill lands
           * within the bracket band. Never downgrades already-specific labels. */
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
      } else if (!strategyOnlyIncomeLedger) {
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

  /** OPEN rows sometimes miss the async userTrades patch; retry periodically so UI fees match Binance. */
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
          // Only overwrite if we haven't already applied a `userTrades`-sourced entry:
          // avoids flapping between runs.
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

  return {
    name: "binance_live_futures_usdm",
    supportsAutoTrading: true,
    storeInfo: { baseURL, note: "USD-M Futures (mainnet — real funds)" },
    async getAccount() {
      if (!apiKey || !apiSecret) throw new Error("binance_live_futures_missing_keys");
      const a = await getAccountSnapshotCoalesced();
      const equity = Number(a?.totalWalletBalance || 0);
      const free = Number(a?.availableBalance || 0);
      return { equity, freeBalance: free, dailyStartEquity: null, dailyPnlPct: 0, leverage: defaultLeverage };
    },
    async getPositions() {
      try {
        const a = await getAccountSnapshotCoalesced();
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
          const posSideRaw = String(p?.positionSide ?? "BOTH").trim().toUpperCase();
          const posSideKey =
            posSideRaw === "LONG" || posSideRaw === "SHORT" ? posSideRaw : "BOTH";
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
          const markPx = Number(p?.markPrice);
          const row = {
            id: posSideKey !== "BOTH" ? `fut_${symU}_${posSideKey}` : `fut_${symU}`,
            symbol: sym,
            side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
            qty: Math.abs(Number(p.positionAmt)),
            entryPrice: Number(p.entryPrice || 0),
            unrealizedPnl: Number(p.unrealizedProfit || 0),
            ...(Number.isFinite(markPx) && markPx > 0 ? { markPrice: markPx } : {}),
            ...(posSideKey !== "BOTH" ? { positionSide: posSideKey } : {}),
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
        log?.warn?.("binance_live_futures_positions_failed", { error: String(e?.message || e) });
        // Re-throw so the hybrid wrapper / caller can fall back to the last-good cache instead of treating
        // a transient REST failure as "no positions". Returning [] used to clobber `lastFutPos` on every blip.
        throw e instanceof Error ? e : new Error(String(e?.message || e));
      }
    },
    async getTrades(opts = {}) {
      if (opts?.forceReconcile === true) mem.forceNextIncomeSync = true;
      await refreshUsdMPositionSnapshotAndReconcile();
      await syncRealizedIncomeFromExchange();
      await backfillMissingOpenCommissionsUsdM();
      let rows = mem.trades.slice(-MAX_MEM_TRADES);
      if (strategyOnlyIncomeLedger) {
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
          ...(out?.type ? { entryBinanceOrderType: String(out.type) } : {}),
          ...(out?.timeInForce ? { entryTimeInForce: String(out.timeInForce) } : {}),
          ...(clientOid ? { clientOrderId: clientOid } : {}),
        },
      });
      if (mem.trades.length > MAX_MEM_TRADES) mem.trades = mem.trades.slice(-MAX_MEM_TRADES);

      /** Don’t await userTrades before SL/TP — extra REST hop would delay bracket protection. */
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
                // `avgFillPriceFromUsdMNewOrder` uses the POST response `avgPrice`, which is often
                // "0.00" before fills settle. `userTrades` is the authoritative qty-weighted mean.
                // Updating `price` here feeds every downstream derivative — margin column
                // (entry × qty / lev), PnL basis, restart trail reconstruction.
                tr.price = Number(det.avgPrice);
                patchMeta.entryAvgFillPrice = Number(det.avgPrice);
                patchMeta.entryPriceSource = "fapi_userTrades";
                if (
                  Number.isFinite(Number(det.filledQty)) &&
                  Number(det.filledQty) > 0 &&
                  Math.abs(Number(det.filledQty) - Number(tr.qty || 0)) > 1e-8
                ) {
                  // Partial fill: authoritative filled qty from userTrades.
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
        // Always use exchange mark price for trailing decisions.
        // The bot passes candle close as `price`; that can differ from mark and causes missed tier advances
        // (UI shows mark crossing activation but server compares against close).
        //
        // Prefer the `@markPrice@1s` WS cache (push, sub-second). Fall back to REST
        // `premiumIndex` only when the cache is empty or stale — keeps trailing
        // decisions current without bombarding fapi on every trail symbol per tick.
        const cached = _getMarkPxFromCache(u);
        if (cached != null) return cached;
        try {
          const d = await publicGet("/fapi/v1/premiumIndex", { symbol: u });
          const m = Number(d?.markPrice);
          if (Number.isFinite(m) && m > 0) {
            _markPxCache.set(u, { px: m, at: Date.now() });
            return m;
          }
          return NaN;
        } catch {
          return NaN;
        }
      }

      // Keep the mark-price WS subscribed to every symbol we'll read mark price for
      // this tick (trailing + local-bracket + primary chart). Cheap if unchanged.
      {
        const wsSubs = [
          ...new Set([
            primarySymU,
            ...Object.keys(mem.trailingBySymbol).map((k) => String(k || "").toUpperCase()),
            ...Object.keys(mem.localBrackets).map((k) => String(k || "").toUpperCase()),
          ]),
        ].filter(Boolean);
        _ensureMarkPxWs(wsSubs);
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
            const bracketCloseOut = await signed("POST", "/fapi/v1/order", {
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
              closeOrderId:
                bracketCloseOut?.orderId != null ? String(bracketCloseOut.orderId) : undefined,
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
          .map((p) => {
            const psRaw = String(p?.positionSide ?? "BOTH").trim().toUpperCase();
            const positionSide = psRaw === "LONG" || psRaw === "SHORT" ? psRaw : "BOTH";
            return {
              symbol: p.symbol,
              side: Number(p.positionAmt) > 0 ? "BUY" : "SELL",
              qty: Math.abs(Number(p.positionAmt)),
              entryPrice: Number(p.entryPrice || 0),
              leverage: Number(p.leverage || 0),
              positionSide,
            };
          });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      const sid = String(id || "");
      let wantSym = sid;
      let hedgeSide = null;
      if (sid.startsWith("fut_")) {
        const rest = sid.slice(4);
        if (rest.endsWith("_LONG")) {
          wantSym = rest.slice(0, -5);
          hedgeSide = "LONG";
        } else if (rest.endsWith("_SHORT")) {
          wantSym = rest.slice(0, -6);
          hedgeSide = "SHORT";
        } else {
          wantSym = rest;
        }
      }
      const symU = String(wantSym || "").toUpperCase();
      const p = positions.find((x) => {
        if (String(x.symbol || "").toUpperCase() !== symU) return false;
        if (!hedgeSide) return true;
        return x.positionSide === hedgeSide;
      });
      if (!p) return { ok: false, error: "not_found" };
      const m = await getOrLoadSymbolMeta(p.symbol);
      const qtyStr = formatToStep(p.qty, m);
      if (!qtyStr) return { ok: false, error: "invalid_qty" };
      const closeSide = p.side === "BUY" ? "SELL" : "BUY";
      /** Same as `placeOrder`: dual-side accounts require `positionSide` on reduce-only closes (-2022 if omitted). */
      const hedgeCloseExtras = await hedgePositionSideExtras(p.side === "BUY");
      let manualCloseOut;
      try {
        manualCloseOut = await signed("POST", "/fapi/v1/order", {
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
        closeOrderId:
          manualCloseOut?.orderId != null ? String(manualCloseOut.orderId) : undefined,
      });
      mem.forceNextIncomeSync = true;
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
      usdMUserStream?.stop();
    },
    dispose() {
      usdMUserStream?.stop();
    },
    subscribeAccountPush(cb) {
      return usdMUserStream?.subscribeAccountPush?.(cb) ?? (() => {});
    },
    getStatus() {
      const udsOk = Boolean(usdMUserStream?.connected);
      return {
        udf: { ok: true, syncMode: udsOk ? "websocket" : "rest", error: null },
        usdmUserStream: { ok: udsOk, connected: udsOk },
      };
    },
  };
}

