import { useEffect, useMemo, useRef, useState } from "react";
import { deferTask } from "../lib/deferTask";
import {
  loadPortfolioPnlRangeForMode,
  tradingUiPersistPortfolioPnlRange,
} from "../lib/tradingUiPersistence";
import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { isIncomeLedgerClose } from "../lib/tradeClassification";
import { clampTradeCloseFeeRate, estimatedCloseFeeUsdt } from "../lib/tradeCloseFee";
import {
  buildTrailLockPrices,
  DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
  extrapolateTrailTierLockPx,
  tierLabelForTrailIndex,
} from "../lib/trailingFeeLadder";
import { AiTradeMotionVisual } from "./AiTradeMotionVisual";
import { initialMarginUsd } from "../lib/futuresLiquidation";

function IconTableFullscreen({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4.5 3A1.5 1.5 0 003 4.5v3a.5.5 0 001 0V5.207l2.147 2.146a.5.5 0 10.708-.708L4.707 4.5H7.5a.5.5 0 000-1h-3zM12.5 3H16A1.5 1.5 0 0117.5 4.5v3a.5.5 0 01-1 0V5.207l-2.146 2.146a.5.5 0 01-.708-.708L15.293 4.5H12.5a.5.5 0 010-1zM3 12.5a.5.5 0 01.5-.5h3a.5.5 0 010 1H4.707l2.147 2.147a.5.5 0 01-.708.708L3.5 13.793V16.5a.5.5 0 01-1 0v-3A1.5 1.5 0 013 12.5zm14 0A1.5 1.5 0 0116 14h-3a.5.5 0 010-1h2.793l-2.147 2.147a.5.5 0 10.708.708L16.5 13.793V16.5a.5.5 0 001 0v-3a1.5 1.5 0 00-1.5-1.5z" />
    </svg>
  );
}

function isLedgerClose(t: any): boolean {
  return isIncomeLedgerClose(t);
}

function tradeTsMs(t: any): number {
  // Prefer bar *close* time for Supertrend OPEN rows so portfolio time matches the bar-close order window
  // (signalBarTs is candle *open*; fills happen after close + network/exchange delay).
  if (t?.type === "OPEN") {
    const sbClose = Number(
      t?.meta?.signalBarCloseTs ?? t?.meta?.signalBarCloseTsMs ?? t?.meta?.signalBarCloseTsSec,
    );
    if (Number.isFinite(sbClose) && sbClose > 0) {
      const msClose = sbClose > 1e12 ? sbClose : sbClose > 1e9 ? sbClose * 1000 : sbClose;
      if (Number.isFinite(msClose) && msClose > 0) return msClose;
    }
    const sb = Number(t?.meta?.signalBarTs ?? t?.meta?.signalBarTsMs ?? t?.meta?.signalBarTsSec);
    if (Number.isFinite(sb) && sb > 0) {
      const ms = sb > 1e12 ? sb : sb > 1e9 ? sb * 1000 : sb; // ms vs sec (defensive)
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  const ts = t?.ts;
  if (ts == null) return 0;
  const ms = new Date(String(ts)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtTimestampFull(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleString();
}

/** Tooltip: planned T0,T1,… lock prices (matches chart / server ladder). */
function futuresTrailLadderSummaryTitle(p: any, bot: any): string | undefined {
  if (String(p?.venue) !== "FUTURES" || bot?.trailingStopLossAuto !== true) return undefined;
  const entry = Number(p.entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) return undefined;
  const side = String(p?.side || "").toUpperCase();
  const isLong =
    side === "BUY" || side === "LONG" || (Number.isFinite(Number(p?.qty)) && Number(p.qty) > 0);
  const feeR = clampTradeCloseFeeRate();
  const openR = Number.isFinite(Number(bot?.trailOpenFeeRate)) && Number(bot.trailOpenFeeRate) > 0 ? Number(bot.trailOpenFeeRate) : feeR;
  const closeR = Number.isFinite(Number(bot?.trailCloseFeeRate)) && Number(bot.trailCloseFeeRate) > 0 ? Number(bot.trailCloseFeeRate) : feeR;
  const mult =
    Number.isFinite(Number(bot?.trailFeeBeMultiplier)) && Number(bot.trailFeeBeMultiplier) >= 1
      ? Number(bot.trailFeeBeMultiplier)
      : DEFAULT_TRAIL_FEE_BE_MULTIPLIER;
  const extras = Array.isArray(bot?.trailingStopExtraScalpingPcts)
    ? (bot.trailingStopExtraScalpingPcts as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  const levels = buildTrailLockPrices(entry, isLong, feeR, extras, {
    openFeeRate: openR,
    closeFeeRate: closeR,
    feeBeMultiplier: mult,
  });
  if (!levels.length) return undefined;
  const parts: string[] = [];
  const nShow = Math.min(levels.length + 2, 8);
  for (let j = 0; j < nShow; j++) {
    const px = extrapolateTrailTierLockPx(levels, j, isLong, entry);
    if (px == null || !Number.isFinite(px)) continue;
    const tl = tierLabelForTrailIndex(levels, j);
    parts.push(`${tl} @ ${px.toLocaleString("en-US", { maximumFractionDigits: 8 })}`);
  }
  return `Trail lock ladder: ${parts.join(" · ")}`;
}

/** Value for `<input type="datetime-local" />` in local timezone. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocalMs(s: string): number | null {
  const t = new Date(String(s).trim()).getTime();
  return Number.isFinite(t) ? t : null;
}

type HistoryRangeFilter =
  | { kind: "all" }
  | { kind: "range"; startMs: number; endMs: number }
  | { kind: "from_present"; startMs: number }
  | { kind: "invalid" };

function historyFilterHasWindow(f: HistoryRangeFilter): f is
  | { kind: "range"; startMs: number; endMs: number }
  | { kind: "from_present"; startMs: number } {
  return f.kind === "range" || f.kind === "from_present";
}

function buildHistoryRangeFilter(mode: "all" | "custom", startStr: string, endStr: string): HistoryRangeFilter {
  if (mode === "all") return { kind: "all" };
  const startMs = parseDatetimeLocalMs(startStr);
  if (startMs == null) return { kind: "invalid" };
  const endTrim = String(endStr ?? "").trim();
  if (endTrim === "") {
    return { kind: "from_present", startMs };
  }
  const endMs = parseDatetimeLocalMs(endStr);
  if (endMs == null || startMs > endMs) return { kind: "invalid" };
  return { kind: "range", startMs, endMs };
}

function tradeMatchesHistoryTime(t: any, f: HistoryRangeFilter): boolean {
  if (f.kind === "all" || f.kind === "invalid") return true;
  const ms = tradeTsMs(t);
  if (ms <= 0) return false;
  if (f.kind === "from_present") return ms >= f.startMs;
  return ms >= f.startMs && ms <= f.endMs;
}

/** Per-trade fees in USD where the app models them; ledger / some venues omit breakdown. */
function tradeFeeUsd(t: any): number | null {
  if (t?.fee != null && Number.isFinite(Number(t.fee))) return Number(t.fee);
  const m = t?.meta || {};
  if (m.totalFee != null && Number.isFinite(Number(m.totalFee))) return Number(m.totalFee);
  const entry = Number(m.entryFee);
  const ex = Number(m.exitFee);
  if (Number.isFinite(entry) && Number.isFinite(ex)) return entry + ex;
  const openF = Number(m.openFee);
  const exitF = Number(m.exitFee);
  if (Number.isFinite(openF) && Number.isFinite(exitF)) return openF + exitF;
  if (t?.type === "OPEN") {
    if (Number.isFinite(entry) && entry !== 0) return entry;
    if (Number.isFinite(openF)) return openF;
    if (Number.isFinite(Number(m.fee))) return Number(m.fee);
    if (Number.isFinite(Number(m.spotEntryFeeUsd))) return Number(m.spotEntryFeeUsd);
  }
  if (t?.type === "CLOSE" && Number.isFinite(Number(m.fee)) && !Number.isFinite(openF)) {
    return Number(m.fee);
  }
  if (t?.type === "CLOSE") {
    const se = Number(m.spotEntryFeeUsd);
    const sx = Number(m.spotExitFeeUsd);
    if (Number.isFinite(se) || Number.isFinite(sx)) {
      let s = 0;
      if (Number.isFinite(se)) s += se;
      if (Number.isFinite(sx)) s += sx;
      if (s > 0) return s;
    }
  }
  if (isLedgerClose(t)) return null;
  return null;
}

/**
 * Exchange-scoped id for collapsing duplicate trade rows (same venue order / income tran) in history.
 * OPEN/CLOSE only; other row kinds return null (handled separately in merge).
 */
function tradeHistoryMergeOrderKey(t: any): string | null {
  const ty = String(t?.type ?? "");
  if (ty !== "OPEN" && ty !== "CLOSE") return null;

  const m = t?.meta || {};

  if (ty === "CLOSE" && isLedgerClose(t)) {
    const tid =
      m.tranId ?? (Array.isArray(m.tranIds) && m.tranIds.length ? String(m.tranIds[0]) : null);
    if (tid != null && String(tid).trim() !== "") return `income:${String(tid).trim()}`;
  }

  const topOid = t?.exitOrderId ?? t?.orderId ?? t?.entryOrderId;
  const metaOid = m.orderId ?? m.entryOrderId ?? m.exitOrderId ?? m.closeOrderId;
  for (const cand of [topOid, metaOid]) {
    if (cand != null && String(cand).trim() !== "") return String(cand).trim();
  }

  const id = String(t?.id ?? "").trim();
  const dm = /^(?:demo_|live_|bn_|test_|paper_)(\d+)$/i.exec(id);
  if (dm) return dm[1];
  if (id.startsWith("finc_")) return `income:${id.slice(5)}`;

  return null;
}

function mergeTradeHistoryGroup(group: any[]): any {
  if (group.length === 1) return group[0];
  const sorted = [...group].sort((a, b) => tradeTsMs(a) - tradeTsMs(b));
  const primary = sorted[sorted.length - 1];
  const out: any = { ...primary, meta: { ...(primary.meta || {}) } };

  const tranIds = new Set<string>();
  const addTran = (x: unknown) => {
    if (x == null || String(x) === "") return;
    tranIds.add(String(x));
  };
  addTran(out.meta.tranId);
  if (Array.isArray(out.meta.tranIds)) for (const x of out.meta.tranIds) addTran(x);

  for (const r of sorted) {
    if (r === primary) continue;
    const m = r.meta || {};
    addTran(m.tranId);
    if (Array.isArray(m.tranIds)) for (const x of m.tranIds) addTran(x);

    const q = numFinite(r.qty);
    if ((out.qty == null || !Number.isFinite(Number(out.qty))) && q != null) out.qty = q;
    const px = numFinite(r.price ?? r.exitPrice ?? m.exitPrice ?? m.closePrice);
    if ((out.price == null || !Number.isFinite(Number(out.price))) && px != null) out.price = px;
    const e = numFinite(r.entryPrice ?? m.entryPrice);
    if ((out.entryPrice == null || !Number.isFinite(Number(out.entryPrice))) && e != null) out.entryPrice = e;
    if (out.pnl == null && r.pnl != null && Number.isFinite(Number(r.pnl))) out.pnl = Number(r.pnl);
    if (out.grossPnl == null && r.grossPnl != null && Number.isFinite(Number(r.grossPnl))) out.grossPnl = Number(r.grossPnl);
    if (tradeFeeUsd(out) == null && tradeFeeUsd(r) != null && r.fee != null && Number.isFinite(Number(r.fee))) out.fee = Number(r.fee);
    for (const field of ["stopLoss", "takeProfit", "leverage", "strategy", "reason"] as const) {
      if (out[field] == null && r[field] != null) (out as any)[field] = r[field];
    }
    for (const [k, v] of Object.entries(m)) {
      if (v == null) continue;
      if (out.meta[k] == null || out.meta[k] === "") out.meta[k] = v;
    }
  }
  if (tranIds.size > 0) {
    const arr = [...tranIds];
    out.meta.tranIds = arr;
    out.meta.tranId = arr[arr.length - 1];
  }
  return out;
}

/**
 * Legacy Supertrend futures path broadcast a synthetic CLOSE (`fut_close_*`) before exchange income
 * landed — wrong price/pnl and duplicate rows. Drop these; truth is the exchange-backed CLOSE.
 */
function isSyntheticSupertrendFuturesCloseRow(t: any): boolean {
  if (String(t?.type ?? "").toUpperCase() !== "CLOSE") return false;
  const id = String(t?.id ?? "");
  return id.startsWith("fut_close_");
}

/** Merge rows that share the same logical exchange order (or income tran) and the same OPEN/CLOSE type. */
function mergeTradesByOrderIdAndType(rows: any[]): any[] {
  if (!rows.length) return rows;
  const rowsIn = (rows || []).filter((t) => !isSyntheticSupertrendFuturesCloseRow(t));
  const passthrough: any[] = [];
  const buckets = new Map<string, any[]>();
  for (const t of rowsIn) {
    const ty = String(t?.type ?? "");
    if (ty !== "OPEN" && ty !== "CLOSE") {
      passthrough.push(t);
      continue;
    }
    const oid = tradeHistoryMergeOrderKey(t);
    const key = oid != null ? `${ty}|${oid}` : `${ty}|id:${String(t?.id ?? "")}`;
    const g = buckets.get(key);
    if (g) g.push(t);
    else buckets.set(key, [t]);
  }
  const merged = [...buckets.values()].map(mergeTradeHistoryGroup);
  const out = [...passthrough, ...merged];
  out.sort((a, b) => tradeTsMs(b) - tradeTsMs(a));
  return out;
}

/** Fee for display: same as tradeFeeUsd, else modeled close fee from qty×price×0.0004 when possible. */
function tradeFeeUsdForCloseRow(t: any, displayQty: number | undefined, displayPrice: number | undefined): number | null {
  const direct = tradeFeeUsd(t);
  if (direct != null) return direct;
  if (t?.type !== "CLOSE") return null;
  return estimatedCloseFeeUsdt(displayQty, displayPrice);
}

/**
 * When CLOSE has no stored `pnl` / `grossPnl`, infer futures-style gross from entry vs exit and close side.
 * (Some ledger shards or older rows omit net; price + open leg still allow a display gross.)
 */
function inferCloseGrossFromPrices(t: any, openRef: any | undefined, displayQty?: number, displayPrice?: number): number | null {
  if (t?.type !== "CLOSE") return null;
  const px =
    displayPrice ??
    numFinite(t?.price ?? t?.exitPrice ?? t?.meta?.exitPrice ?? t?.meta?.closePrice ?? t?.meta?.markPx);
  const qty =
    displayQty ??
    numFinite(t?.qty) ??
    numFinite(openRef?.qty ?? t?.meta?.qty ?? openRef?.meta?.qty);
  const entry = numFinite(
    t?.entryPrice ?? t?.meta?.entryPrice ?? openRef?.entryPrice ?? openRef?.price ?? openRef?.meta?.entryPx,
  );
  if (entry == null || entry <= 0 || px == null || px <= 0 || qty == null || qty <= 0) return null;

  let closeSide = String(t?.side ?? t?.meta?.closeSide ?? "").toUpperCase();
  if (closeSide !== "BUY" && closeSide !== "SELL") {
    const openSide = String(openRef?.side ?? "").toUpperCase();
    if (openSide === "BUY") closeSide = "SELL";
    else if (openSide === "SELL") closeSide = "BUY";
  }
  if (closeSide === "SELL") return (px - entry) * qty;
  if (closeSide === "BUY") return (entry - px) * qty;
  return null;
}

function tradeGrossPnlClose(t: any, displayQty?: number, displayPrice?: number, openRef?: any): number | null {
  if (t?.type !== "CLOSE") return null;
  const m = t?.meta || {};
  if (t?.grossPnl != null && Number.isFinite(Number(t.grossPnl))) return Number(t.grossPnl);
  if (m.grossPnl != null && Number.isFinite(Number(m.grossPnl))) return Number(m.grossPnl);
  const net = Number(t?.pnl ?? m.pnl ?? m.realizedPnl ?? m.realized_pnl);
  if (Number.isFinite(net)) {
    const fee = tradeFeeUsdForCloseRow(t, displayQty, displayPrice);
    if (fee != null && fee > 0) return net + fee;
    return net;
  }
  return inferCloseGrossFromPrices(t, openRef, displayQty, displayPrice);
}

function tradeNetPnlClose(t: any): number | null {
  if (t?.type !== "CLOSE") return null;
  const m = t?.meta || {};
  const net = Number(t?.pnl ?? m.pnl ?? m.realizedPnl ?? m.realized_pnl);
  return Number.isFinite(net) ? net : null;
}

/** Net for a close = gross − fees (fees 0 when unknown); falls back to stored net PnL. */
function closeTradeNetUsd(t: any, openRef: any | undefined): number {
  const { price, qty } = tradeHistoryDisplayFields(t, openRef);
  const g = tradeGrossPnlClose(t, qty, price, openRef);
  const f = tradeFeeUsdForCloseRow(t, qty, price);
  if (g != null && Number.isFinite(g)) {
    const feePart = f != null && Number.isFinite(f) ? f : 0;
    return g - feePart;
  }
  return tradeNetPnlClose(t) ?? 0;
}

function fmtUsd(x: number | null, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return Number(x).toFixed(digits);
}

/** Positions / trade history: at least this many digit characters in integer + fraction (decimal point not counted). */
const MIN_INSTRUMENT_PRICE_DIGITS = 5;
const MAX_INSTRUMENT_FRAC_DIGITS = 18;

function countNumericDigits(s: string): number {
  return (s.match(/\d/g) || []).length;
}

/** Smallest k ≥ minFrac where `toFixed(k)` matches `toFixed(k+1)` numerically (avoids 1.19999… tails). */
function stableFracDigits(v: number, minFrac: number, maxFrac: number): number {
  let chosen = minFrac;
  for (let k = minFrac; k <= maxFrac; k++) {
    const a = Number.parseFloat(v.toFixed(k));
    const b = k < maxFrac ? Number.parseFloat(v.toFixed(k + 1)) : a;
    chosen = k;
    if (Math.abs(a - b) < 1e-14 || k === maxFrac) break;
  }
  return Math.max(minFrac, chosen);
}

function fmtInstrumentPx(x: unknown): string {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v === 0) return `${sign}0.${"0".repeat(MIN_INSTRUMENT_PRICE_DIGITS - 1)}`;

  const intPart = Math.trunc(v);
  const intStr = intPart === 0 ? "0" : String(intPart);
  const dInt = intStr.length;

  const minFrac = Math.max(0, MIN_INSTRUMENT_PRICE_DIGITS - dInt);
  const fracDigits = Math.min(MAX_INSTRUMENT_FRAC_DIGITS, stableFracDigits(v, minFrac, MAX_INSTRUMENT_FRAC_DIGITS));

  const s = v.toFixed(fracDigits);
  const [iPart, fRaw = ""] = s.split(".");
  let fp = fRaw;
  let total = countNumericDigits(iPart) + countNumericDigits(fp);
  while (total < MIN_INSTRUMENT_PRICE_DIGITS && fp.length < MAX_INSTRUMENT_FRAC_DIGITS) {
    fp += "0";
    total++;
  }
  if (!fp.length && dInt < MIN_INSTRUMENT_PRICE_DIGITS) {
    fp = "0".repeat(MIN_INSTRUMENT_PRICE_DIGITS - dInt);
  }
  return fp.length > 0 ? `${sign}${iPart}.${fp}` : `${sign}${iPart}`;
}

function numFinite(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/** Long from venue side or signed qty (futures). */
function positionIsLong(sideRaw: unknown, qtyRaw?: unknown): boolean {
  const s = String(sideRaw ?? "").toUpperCase();
  if (s === "BUY" || s === "LONG") return true;
  if (s === "SELL" || s === "SHORT") return false;
  const q = Number(qtyRaw);
  if (Number.isFinite(q) && q !== 0) return q > 0;
  return true;
}

/**
 * True when current SL is at least at ~round-trip taker fee breakeven vs entry (aligned with server `feeCoverageLockPx`).
 */
function stopLossAtRoundTripFeeBreakevenOrBetter(entry: number, stopLoss: number, isLong: boolean): boolean {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) return false;
  const feeR = clampTradeCloseFeeRate();
  const roundTrip = 2 * feeR;
  const eps = entry * 1e-10;
  if (isLong) {
    const be = entry * (1 + roundTrip);
    return stopLoss >= be - eps;
  }
  const be = entry * (1 - roundTrip);
  return stopLoss <= be + eps;
}

/** Futures + trailing on + at least one trail SL update on the server (`trailStep` ≥ 1). */
function positionRowTrailedStrict(p: any, trailingStopLossAuto: boolean): boolean {
  if (!trailingStopLossAuto) return false;
  if (String(p?.venue || "").toUpperCase() !== "FUTURES") return false;
  const step = Number(p?.meta?.trailStep);
  const trailArm = p?.meta?.autoTradeTrailing === true;
  return trailArm && Number.isFinite(step) && step >= 1;
}

/** Green row lead: trailing auto on + futures + SL locked at/above round-trip fee BE, or discrete trail advanced (trailStep ≥ 1). */
function positionRowTrailingBreakevenIndicator(p: any, trailingStopLossAuto: boolean): boolean {
  if (!trailingStopLossAuto) return false;
  if (String(p?.venue || "").toUpperCase() !== "FUTURES") return false;
  const entry = numFinite(p?.entryPrice);
  const sl = numFinite(p?.stopLoss);
  if (entry == null || sl == null) return false;
  const isLong = positionIsLong(p?.side, p?.qty ?? p?.positionAmt);
  const step = Number(p?.meta?.trailStep);
  const trailArm = p?.meta?.autoTradeTrailing === true;
  if (trailArm && Number.isFinite(step) && step >= 1) return true;
  if (!trailArm) return false;
  return stopLossAtRoundTripFeeBreakevenOrBetter(entry, sl, isLong);
}

function positionRowBreakevenStopIndicator(p: any, trailingStopLossAuto: boolean): boolean {
  if (positionRowTrailingBreakevenIndicator(p, trailingStopLossAuto)) return true;
  const entry = numFinite(p?.entryPrice);
  const sl = numFinite(p?.stopLoss);
  if (entry == null || sl == null) return false;
  const isLong = positionIsLong(p?.side, p?.qty ?? p?.positionAmt);
  return stopLossAtRoundTripFeeBreakevenOrBetter(entry, sl, isLong);
}

function findLivePositionForTradeId(positions: any[], tradeId: unknown): any | null {
  const tid = String(tradeId ?? "").trim();
  if (!tid || !Array.isArray(positions)) return null;
  for (const p of positions) {
    const pid = String(p?.id ?? "").trim();
    if (!pid) continue;
    if (pid === tid) return p;
    const parts = pid.split("_");
    if (parts.length >= 2 && parts.slice(1).join("_") === tid) return p;
    if (tid.includes("_")) {
      const tParts = tid.split("_");
      if (tParts.length >= 2 && tParts.slice(1).join("_") === pid) return p;
    }
  }
  return null;
}

function openTradeRowBreakevenStopIndicator(t: any, positions: any[], trailingStopLossAuto: boolean): boolean {
  if (String(t?.type ?? "") !== "OPEN") return false;
  const live = findLivePositionForTradeId(positions, t?.id);
  if (live) return positionRowBreakevenStopIndicator(live, trailingStopLossAuto);
  const entry = numFinite(t?.price ?? t?.entryPrice ?? t?.meta?.entryPrice);
  const sl = numFinite(t?.stopLoss ?? t?.meta?.stopLoss);
  if (entry == null || sl == null) return false;
  const isLong = positionIsLong(t?.side, t?.qty);
  return stopLossAtRoundTripFeeBreakevenOrBetter(entry, sl, isLong);
}

function openTradeRowTrailedStrict(t: any, positions: any[], trailingStopLossAuto: boolean): boolean {
  if (String(t?.type ?? "") !== "OPEN") return false;
  const live = findLivePositionForTradeId(positions, t?.id);
  if (live) return positionRowTrailedStrict(live, trailingStopLossAuto);
  return false;
}

function closeTradeRowTrailedStrict(t: any): boolean {
  if (String(t?.type ?? "") !== "CLOSE") return false;
  const m = t?.meta || {};
  const trailStepClose = Number(m.trailStepAtClose);
  return (
    m.exitViaTrailedStop === true ||
    (Number.isFinite(trailStepClose) && trailStepClose > 0 && String(m.bracketType || "").toUpperCase() === "SL")
  );
}

function BreakevenStopLead() {
  return (
    <div
      className="mx-auto h-8 w-1 shrink-0 rounded-sm bg-emerald-500 shadow-sm dark:bg-emerald-400"
      title="Breakeven: trailing locked stop at/above round-trip fee level, or trail step advanced"
      aria-hidden
    />
  );
}

/** Same emerald bar as breakeven lead; title distinguishes “stop actually moved by trailing”. */
function TrailedStopLead() {
  return (
    <div
      className="mx-auto h-8 w-1 shrink-0 rounded-sm bg-emerald-400 shadow-sm ring-1 ring-emerald-300/60 dark:bg-emerald-300 dark:ring-emerald-500/40"
      title="Trailed: stop loss was tightened at least once by auto-trailing"
      aria-hidden
    />
  );
}

function positionInitialMarginUsd(p: any): string {
  if (String(p?.venue || "").toUpperCase() !== "FUTURES") return "—";
  const e = numFinite(p.entryPrice);
  const q = numFinite(p.qty);
  const L0 = numFinite(p.leverage);
  const L = L0 != null && L0 > 0 ? L0 : 1;
  if (e == null || q == null || e <= 0 || q <= 0) return "—";
  const m = initialMarginUsd(e, q, L);
  return m != null ? m.toFixed(2) : "—";
}

/** Initial margin USDT for futures row; null for spot or incomplete. */
function positionInitialMarginUsdNumber(p: any): number | null {
  if (String(p?.venue || "").toUpperCase() !== "FUTURES") return null;
  const e = numFinite(p.entryPrice);
  const qRaw = numFinite(p.qty);
  const q = qRaw != null ? Math.abs(qRaw) : 0;
  const L0 = numFinite(p.leverage);
  const L = L0 != null && L0 > 0 ? L0 : 1;
  if (e == null || !(q > 0) || e <= 0) return null;
  return initialMarginUsd(e, q, L);
}

/** Return on initial margin (futures) or vs entry notional (spot): uPnL / basis × 100. */
function positionUnrealizedPnlPct(p: any): number | null {
  const u = Number(p?.unrealizedPnl ?? p?.unRealizedProfit);
  if (!Number.isFinite(u)) return null;
  const ven = String(p?.venue || "").toUpperCase();
  if (ven === "FUTURES") {
    const m = positionInitialMarginUsdNumber(p);
    if (m == null || !(m > 0)) return null;
    return (u / m) * 100;
  }
  const e = numFinite(p.entryPrice);
  const qRaw = numFinite(p.qty);
  const q = qRaw != null ? Math.abs(qRaw) : 0;
  if (e == null || !(q > 0) || e <= 0) return null;
  const basis = e * q;
  if (!(basis > 0)) return null;
  return (u / basis) * 100;
}

function fmtPnlPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(2)}%`;
}

/** Initial margin at open (USDT) for futures-style rows with leverage. */
function tradeInitialMarginUsd(t: any, openRef: any | undefined, disp: { price?: number; qty?: number; lev?: number }): string {
  const n = tradeInitialMarginUsdNumber(t, openRef, disp);
  return n != null && Number.isFinite(n) ? n.toFixed(2) : "—";
}

function tradeInitialMarginUsdNumber(t: any, openRef: any | undefined, disp: { price?: number; qty?: number; lev?: number }): number | null {
  const lev = disp.lev;
  if (lev == null || !(lev > 0)) return null;
  if (t?.type === "OPEN") {
    const px = disp.price;
    const qty = disp.qty;
    if (px == null || qty == null || px <= 0 || qty <= 0) return null;
    return initialMarginUsd(px, qty, lev);
  }
  if (t?.type === "CLOSE") {
    const pxE = numFinite(openRef?.price ?? t?.meta?.entryPrice ?? t?.entryPrice);
    const qE = numFinite(openRef?.qty ?? disp.qty);
    if (pxE == null || qE == null || pxE <= 0 || qE <= 0) return null;
    return initialMarginUsd(pxE, qE, lev);
  }
  return null;
}

/** Match OPEN row to a live position for realtime uPnL% (symbol + venue when present). */
function positionRowMatchingOpenTrade(t: any, positions: readonly any[]): any | undefined {
  if (t?.type !== "OPEN") return undefined;
  const sym = String(t?.symbol ?? "").toUpperCase();
  if (!sym) return undefined;
  const wantVen = String(t?.venue ?? t?.meta?.venue ?? "").toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let symOnly: any;
  for (const p of rows) {
    if (String(p?.symbol ?? "").toUpperCase() !== sym) continue;
    if (wantVen && String(p?.venue ?? "").toUpperCase() !== wantVen) continue;
    return p;
  }
  for (const p of rows) {
    if (String(p?.symbol ?? "").toUpperCase() !== sym) continue;
    if (!symOnly) symOnly = p;
  }
  return symOnly;
}

/** Net PnL% on initial margin: CLOSE = realized net / margin at entry; OPEN = live uPnL% when a matching position row exists. */
function tradeHistoryPnlPct(
  t: any,
  openRef: any | undefined,
  positions: readonly any[],
  disp: { price?: number; qty?: number; lev?: number },
): number | null {
  const pos = positionRowMatchingOpenTrade(t, positions);
  if (t?.type === "OPEN" && pos) return positionUnrealizedPnlPct(pos);
  if (t?.type === "CLOSE") {
    const net = closeTradeNetUsd(t, openRef);
    if (!Number.isFinite(net)) return null;
    let m = tradeInitialMarginUsdNumber(t, openRef, disp);
    if (m == null || !(m > 0)) {
      const levOk = disp.lev != null && disp.lev > 0;
      if (!levOk) {
        const pxE = numFinite(openRef?.price ?? t?.meta?.entryPrice ?? t?.entryPrice);
        const qRaw = numFinite(openRef?.qty ?? disp.qty);
        const qE = qRaw != null ? Math.abs(qRaw) : 0;
        if (pxE != null && pxE > 0 && qE > 0) m = pxE * qE;
      }
    }
    if (m == null || !(m > 0)) return null;
    return (net / m) * 100;
  }
  return null;
}

/** CLOSE rows often omit fields; fill from matching OPEN (same id) and common aliases. */
function tradeHistoryDisplayFields(t: any, openRef: any | undefined) {
  const lev = numFinite(
    t?.meta?.leverage ?? t?.leverage ?? t?.meta?.futuresLeverage ?? openRef?.meta?.leverage ?? openRef?.leverage,
  );
  let price = numFinite(
    t?.price ??
      t?.exitPrice ??
      t?.meta?.exitPrice ??
      t?.meta?.closePrice ??
      t?.meta?.markPx ??
      openRef?.price,
  );
  let qty = numFinite(t?.qty);
  if (t?.type === "CLOSE" && (qty == null || qty === 0)) {
    const q2 = numFinite(openRef?.qty);
    if (q2 != null && q2 > 0) qty = q2;
  }
  const entryHint = numFinite(
    t?.entryPrice ?? t?.meta?.entryPrice ?? openRef?.price ?? openRef?.meta?.entryPx,
  );
  const pnlHint = numFinite(t?.pnl);
  // Exit price hint: linear unwind from entry when only PnL + qty known (spot-style; futures approx for display).
  if (
    (price == null || price <= 0) &&
    entryHint != null &&
    entryHint > 0 &&
    qty != null &&
    qty > 0 &&
    pnlHint != null &&
    t?.type === "CLOSE"
  ) {
    const sx = String(t?.side ?? "").toUpperCase();
    if (sx === "SELL" || sx === "BUY") {
      const dir = sx === "SELL" ? 1 : -1;
      const est = entryHint + (dir * pnlHint) / qty;
      if (Number.isFinite(est) && est > 0) price = est;
    }
  }
  const sl = numFinite(
    t?.stopLoss ??
      t?.meta?.stopLoss ??
      t?.meta?.sl ??
      openRef?.stopLoss ??
      openRef?.meta?.stopLoss,
  );
  const tp = numFinite(
    t?.takeProfit ??
      t?.meta?.takeProfit ??
      t?.meta?.tp ??
      openRef?.takeProfit ??
      openRef?.meta?.takeProfit,
  );
  return { lev, price, qty, sl, tp };
}

/**
 * Human-readable exit / close driver for the trade history table.
 * Uses `reason`, `meta.bracketType`, `meta.closeReason`, trailing hints, and Supertrend `source`.
 */
/** Reduce-only close order side from the opening leg (SELL closes long, BUY closes short). */
function closeOrderSideFromOpenLeg(open: any | undefined): string | null {
  const os = String(open?.side ?? "").toUpperCase();
  if (os === "BUY") return "SELL";
  if (os === "SELL") return "BUY";
  return null;
}

function shortenBinanceId(raw: string, maxLen = 16): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Open positions: Binance USD-M market entry `orderId` (from last OPEN trade for that symbol). */
function portfolioBinanceRefForPosition(p: any): { label: string; title: string } {
  const m = (p?.meta || {}) as Record<string, unknown>;
  const oid = m.binanceEntryOrderId ?? m.orderId ?? m.binanceOrderId;
  const s = oid != null ? String(oid).trim() : "";
  const cid = m.binanceClientOrderId ?? m.clientOrderId;
  if (!s) return { label: "—", title: "" };
  const title =
    cid != null && String(cid).trim() !== ""
      ? `Binance order id: ${s}\nClient order id: ${String(cid)}`
      : `Binance order id: ${s}`;
  return { label: shortenBinanceId(s, 18), title };
}

/** Trade history: OPEN = Binance order id; CLOSE = income tran id (REALIZED_PNL) when present. */
function portfolioBinanceRefForTradeRow(t: any): { label: string; title: string } {
  const m = (t?.meta || {}) as Record<string, unknown>;
  const typ = String(t?.type || "").toUpperCase();
  const orderId = m.orderId ?? m.binanceOrderId ?? m.exchangeOrderId;
  const tranId =
    m.tranId ??
    (Array.isArray(m.tranIds) && m.tranIds.length ? String(m.tranIds[m.tranIds.length - 1]) : null);
  const cid = m.clientOrderId;

  if (typ === "OPEN") {
    const o = orderId != null ? String(orderId).trim() : "";
    if (!o) return { label: "—", title: t?.id != null ? `App id: ${t.id}` : "" };
    const title =
      cid != null && String(cid).trim() !== ""
        ? `Binance order id: ${o}\nClient order id: ${String(cid)}`
        : `Binance order id: ${o}`;
    return { label: shortenBinanceId(o, 18), title };
  }
  if (typ === "CLOSE") {
    const tr = tranId != null ? String(tranId).trim() : "";
    const o = orderId != null ? String(orderId).trim() : "";
    if (tr) {
      const parts = [`Binance income tran id: ${tr}`];
      if (o) parts.unshift(`Order id: ${o}`);
      if (cid != null && String(cid).trim() !== "") parts.push(`Client order id: ${String(cid)}`);
      return { label: shortenBinanceId(tr, 18), title: parts.join("\n") };
    }
    if (o) {
      const title =
        cid != null && String(cid).trim() !== ""
          ? `Binance order id: ${o}\nClient order id: ${String(cid)}`
          : `Binance order id: ${o}`;
      return { label: shortenBinanceId(o, 18), title };
    }
  }
  return { label: "—", title: t?.id != null ? `App id: ${t.id}` : "" };
}

function tradeHistoryReasonLabel(t: any): string {
  if (t?.type === "OPEN") return "—";
  if (isLedgerClose(t)) {
    const m0 = t?.meta || {};
    const r0early = String(t?.reason || "").toUpperCase();
    const inferredExit = m0.exitInferredFromMark === true;
    if (
      !inferredExit &&
      r0early !== "STOP_LOSS" &&
      r0early !== "STOP_LOSS_DEFAULT" &&
      r0early !== "TAKE_PROFIT" &&
      r0early !== "EXCHANGE_REALIZED"
    ) {
      return "Ledger";
    }
  }

  const m = t?.meta || {};
  const trailStepRaw = Number(m.trailStepAtClose);
  const trailConf = Number(m.confirmedTrailStepAtClose);
  const trailStepClose = Math.max(
    Number.isFinite(trailStepRaw) ? trailStepRaw : 0,
    Number.isFinite(trailConf) ? trailConf : 0,
  );
  const trailTierClose: string | null =
    m.trailTierAtClose != null
      ? String(m.trailTierAtClose)
      : trailStepClose >= 1
        ? `T${Math.max(0, Math.floor(trailStepClose) - 1)}`
        : null;
  const trailedExit =
    m.exitViaTrailedStop === true ||
    (Number.isFinite(trailStepClose) && trailStepClose > 0 && String(m.bracketType || "").toUpperCase() === "SL");
  const trailMode = String(m.trailingMode || m.trailMode || "").toUpperCase();

  const r0 = String(t?.reason || "").toUpperCase().replace(/-/g, "_");
  /** e.g. TRAILED_STOP_LOSS_T0 / TRAILED_STOP_LOSS_T1 — extract tier label from reason itself. */
  if (r0.startsWith("TRAILED_STOP_LOSS_T")) {
    const tier = r0.replace("TRAILED_STOP_LOSS_", "");
    return `SL trail ${tier}`;
  }
  if (r0.startsWith("TRAILED_SUPERTREND_T")) {
    const tier = r0.replace("TRAILED_SUPERTREND_", "");
    return `SL trail ${tier}`;
  }
  if (r0 === "TRAILED_SUPERTREND") return trailTierClose ? `SL trail ${trailTierClose}` : "Trailed ST";
  if (r0 === "TRAILED_STOP_LOSS") return trailTierClose ? `SL trail ${trailTierClose}` : "Trailed SL";
  if (r0 === "STOP_LOSS_DEFAULT") {
    const tri = m.trailTierAtClose != null ? String(m.trailTierAtClose) : trailTierClose;
    if (
      m.exitViaTrailedStop === true ||
      (Number.isFinite(trailStepClose) && trailStepClose > 0) ||
      (tri != null && String(tri).trim() !== "")
    ) {
      if (tri != null && String(tri).trim() !== "") return `SL trail ${tri}`;
      return trailMode === "SUPERTREND" || trailMode === "" ? "Trailed ST" : "Trailed SL";
    }
    return "Default SL";
  }
  if (r0 === "IMMEDIATE_FLAT_AFTER_OPEN") return "Flat immediately (post-open)";
  if (r0 === "SUPERTREND_EXIT" || r0 === "SUPERTREND_FLIP") return "Signal";
  if (r0 === "STOP_LOSS" || r0 === "STOP") {
    if (trailedExit) {
      if (trailTierClose) return `SL trail ${trailTierClose}`;
      return trailMode === "SUPERTREND" ? "Trailed ST" : "Trailed SL";
    }
    return "SL";
  }
  if (r0 === "TAKE_PROFIT") return "TP";
  if (r0 === "MANUAL_CLOSE" || r0 === "MANUAL") return "Manual";

  if (m.supertrendSignalClose === true) return "Signal";

  const bracket = String(m.bracketType || "").toUpperCase();
  if (bracket === "SL") {
    if (trailedExit) {
      if (trailTierClose) return `SL trail ${trailTierClose}`;
      return trailMode === "SUPERTREND" ? "Trailed ST" : "Trailed SL";
    }
    if (trailMode === "FEE_LADDER") return "Trailed SL";
    return "SL";
  }
  if (bracket === "TP") return "TP";
  if (bracket === "MANUAL_CLOSE") {
    if (m.supertrend === true || String(t?.source || "").toUpperCase() === "SUPERTREND") return "Signal";
    return "Manual";
  }

  const cr = String(m.closeReason || "").toUpperCase();
  if (cr === "STOP" || cr === "STOP_LOSS") {
    if (trailedExit) {
      if (trailTierClose) return `SL trail ${trailTierClose}`;
      return "Trailed SL";
    }
    return "SL";
  }
  if (cr === "TAKE_PROFIT") return "TP";

  if (r0 === "MARKET_SELL") {
    if (m.supertrend === true) return "Signal";
    if (m.manualClose === true) return "Manual";
    return "Market";
  }
  if (r0 === "EXECUTION_REPORT") return "Exchange";
  if (r0 === "EXCHANGE_REALIZED") return "Exchange";
  if (r0 === "OCO_DONE") return "OCO";

  if (String(t?.source || "").toUpperCase() === "SUPERTREND" && t?.type === "CLOSE") return "Signal";

  const fallback = [t.reason, m.closeReason, m.bracketType].find((x) => x != null && String(x).trim() !== "");
  if (fallback) return String(fallback).replace(/_/g, " ");
  return "—";
}

/** When OPEN id ≠ CLOSE id (e.g. fut_BTCUSDT vs finc_*), pick latest OPEN for same symbol before close time. */
function resolveOpenRefForClose(t: any, allTrades: any[], byId: Map<string, any>): any | undefined {
  if (t?.type !== "CLOSE") return undefined;
  const id = String(t?.id ?? "");
  const direct = id ? byId.get(id) : undefined;
  if (direct) return direct;
  const sym = String(t?.symbol ?? "").toUpperCase();
  if (!sym) return undefined;
  const closeMs = tradeTsMs(t);
  let best: any;
  let bestTs = -1;
  for (const row of allTrades) {
    if (row?.type !== "OPEN") continue;
    if (String(row?.symbol ?? "").toUpperCase() !== sym) continue;
    const oms = tradeTsMs(row);
    if (!Number.isFinite(oms) || oms > closeMs) continue;
    if (oms >= bestTs) {
      bestTs = oms;
      best = row;
    }
  }
  return best;
}

type TradeHistorySort =
  | "RECENT"
  | "OLDEST"
  | "PNL_HIGH"
  | "PNL_LOW"
  | "GROSS_HIGH"
  | "GROSS_LOW"
  | "SYMBOL_AZ"
  | "SYMBOL_ZA";

/** Sort trade history rows; PnL / gross sorts rank closes first, then opens (by time desc). */
function sortTradeHistoryRows(
  rows: any[],
  sort: TradeHistorySort,
  allTrades: any[],
  openTradeById: Map<string, any>,
): any[] {
  const out = [...rows];
  const symKey = (t: any) => String(t?.symbol ?? "").toUpperCase();
  const ts = (t: any) => tradeTsMs(t);
  const closeNet = (t: any) => {
    if (t?.type !== "CLOSE") return null;
    const ref = resolveOpenRefForClose(t, allTrades, openTradeById);
    return closeTradeNetUsd(t, ref);
  };
  const closeGross = (t: any) => {
    if (t?.type !== "CLOSE") return null;
    const ref = resolveOpenRefForClose(t, allTrades, openTradeById);
    const { price, qty } = tradeHistoryDisplayFields(t, ref);
    return tradeGrossPnlClose(t, qty, price, ref);
  };

  out.sort((a, b) => {
    switch (sort) {
      case "RECENT":
        return ts(b) - ts(a);
      case "OLDEST":
        return ts(a) - ts(b);
      case "SYMBOL_AZ": {
        const c = symKey(a).localeCompare(symKey(b));
        if (c !== 0) return c;
        return ts(b) - ts(a);
      }
      case "SYMBOL_ZA": {
        const c = symKey(b).localeCompare(symKey(a));
        if (c !== 0) return c;
        return ts(b) - ts(a);
      }
      case "PNL_HIGH":
      case "PNL_LOW": {
        const openA = a?.type !== "CLOSE";
        const openB = b?.type !== "CLOSE";
        if (openA && openB) return ts(b) - ts(a);
        if (openA) return 1;
        if (openB) return -1;
        const na = closeNet(a) ?? 0;
        const nb = closeNet(b) ?? 0;
        const d = sort === "PNL_HIGH" ? nb - na : na - nb;
        if (d !== 0) return d;
        return ts(b) - ts(a);
      }
      case "GROSS_HIGH":
      case "GROSS_LOW": {
        const openA = a?.type !== "CLOSE";
        const openB = b?.type !== "CLOSE";
        if (openA && openB) return ts(b) - ts(a);
        if (openA) return 1;
        if (openB) return -1;
        const ga = closeGross(a);
        const gb = closeGross(b);
        const va = ga != null && Number.isFinite(ga) ? ga : 0;
        const vb = gb != null && Number.isFinite(gb) ? gb : 0;
        const d = sort === "GROSS_HIGH" ? vb - va : va - vb;
        if (d !== 0) return d;
        return ts(b) - ts(a);
      }
      default:
        return ts(b) - ts(a);
    }
  });
  return out;
}

export function PortfolioPanel() {
  const trades = useAppStore((s) => s.trades);
  const account = useAppStore((s) => s.account);
  const bot = useAppStore((s) => s.bot);
  const trailingStopLossAuto = bot?.trailingStopLossAuto === true;
  const positions = useAppStore((s) => s.positions) || [];
  const pushLog = useAppStore((s) => s.pushLog);
  const mode = useAppStore((s) => s.mode);
  const authUiUserTag = useAppStore((s) => s.authUiUserTag ?? null);
  const exchName = useAppStore((s) => s.bot?.exchange?.name) as string | undefined;

  const strictAccountMissing =
    (mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET") && account === null;
  /** Server merges persisted audit + exchange; show rows even while account snapshot is loading. */
  const portfolioTrades = useMemo(() => {
    const raw = trades || [];
    return mergeTradesByOrderIdAndType(raw);
  }, [trades]);

  const [tradeHistoryView, setTradeHistoryView] = useState<"ALL" | "OPEN_ONLY" | "CLOSED_ONLY">("ALL");
  const [tradeHistorySort, setTradeHistorySort] = useState<TradeHistorySort>("RECENT");
  const [tradeRefreshing, setTradeRefreshing] = useState(false);
  // Default "Strategy" (APP): futures demo emits many unmatched income shards; hide unless debugging.
  const [closeSourceFilter, setCloseSourceFilter] = useState<"ALL" | "APP" | "LEDGER">("APP");
  /** Drives net realised PnL, winrate, fee rollup, and trade history timestamps. */
  const [pnlHistoryRange, setPnlHistoryRange] = useState<"all" | "custom">("all");
  const [customRangeStart, setCustomRangeStart] = useState("");
  const [customRangeEnd, setCustomRangeEnd] = useState("");
  const skipPortfolioPnlPersist = useRef(true);

  useEffect(() => {
    skipPortfolioPnlPersist.current = true;
    const pr = loadPortfolioPnlRangeForMode(mode, authUiUserTag);
    setPnlHistoryRange(pr?.pnlHistoryRange === "custom" ? "custom" : "all");
    setCustomRangeStart(pr?.customRangeStart ?? "");
    setCustomRangeEnd(pr?.customRangeEnd ?? "");
    queueMicrotask(() => {
      skipPortfolioPnlPersist.current = false;
    });
  }, [mode, authUiUserTag]);

  useEffect(() => {
    if (skipPortfolioPnlPersist.current) return;
    tradingUiPersistPortfolioPnlRange(
      mode,
      { pnlHistoryRange, customRangeStart, customRangeEnd },
      authUiUserTag,
    );
  }, [mode, authUiUserTag, pnlHistoryRange, customRangeStart, customRangeEnd]);

  useEffect(() => {
    if (pnlHistoryRange !== "custom") return;
    if (customRangeStart.trim() !== "" || customRangeEnd.trim() !== "") return;
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    setCustomRangeStart(toDatetimeLocalValue(start));
    setCustomRangeEnd("");
  }, [pnlHistoryRange, customRangeStart, customRangeEnd]);

  const historyRangeFilter = useMemo(
    () => buildHistoryRangeFilter(pnlHistoryRange, customRangeStart, customRangeEnd),
    [pnlHistoryRange, customRangeStart, customRangeEnd],
  );

  const closeTrades = (portfolioTrades || []).filter((t: any) => t?.type === "CLOSE");
  const closeTradesApp = closeTrades.filter((t: any) => !isLedgerClose(t));
  const closeTradesLedger = closeTrades.filter((t: any) => isLedgerClose(t));

  const closeTradesAppInRange = useMemo(
    () => closeTradesApp.filter((t) => tradeMatchesHistoryTime(t, historyRangeFilter)),
    [closeTradesApp, historyRangeFilter],
  );
  const closeTradesLedgerInRange = useMemo(
    () => closeTradesLedger.filter((t) => tradeMatchesHistoryTime(t, historyRangeFilter)),
    [closeTradesLedger, historyRangeFilter],
  );

  const openTradeById = useMemo(() => {
    const m = new Map<string, any>();
    for (const row of portfolioTrades || []) {
      if (row?.type !== "OPEN") continue;
      const id = String(row?.id ?? "");
      if (id) m.set(id, row);
    }
    return m;
  }, [portfolioTrades]);

  /** Net realised PnL = Σ gross − Σ fees per bucket (same as per-row gross − fee when fees are modeled). */
  const { wins, losses, netRealizedPnlStrategy, netRealizedPnlLedger } = useMemo(() => {
    let w = 0;
    let l = 0;
    let stratGross = 0;
    let stratFees = 0;
    const rows = portfolioTrades || [];
    for (const t of closeTradesAppInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      const { price, qty } = tradeHistoryDisplayFields(t, openRef);
      const g = tradeGrossPnlClose(t, qty, price, openRef);
      const fee = tradeFeeUsdForCloseRow(t, qty, price);
      if (g != null && Number.isFinite(g)) stratGross += g;
      if (fee != null && Number.isFinite(fee) && fee > 0) stratFees += fee;
      const netRow = closeTradeNetUsd(t, openRef);
      if (netRow > 0) w += 1;
      else if (netRow < 0) l += 1;
    }
    let ledGross = 0;
    let ledFees = 0;
    for (const t of closeTradesLedgerInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      const { price, qty } = tradeHistoryDisplayFields(t, openRef);
      const g = tradeGrossPnlClose(t, qty, price, openRef);
      const fee = tradeFeeUsdForCloseRow(t, qty, price);
      if (g != null && Number.isFinite(g)) ledGross += g;
      if (fee != null && Number.isFinite(fee) && fee > 0) ledFees += fee;
    }
    return {
      wins: w,
      losses: l,
      netRealizedPnlStrategy: stratGross - stratFees,
      netRealizedPnlLedger: ledGross - ledFees,
    };
  }, [closeTradesAppInRange, closeTradesLedgerInRange, portfolioTrades, openTradeById]);

  const netRealizedPnlAll = netRealizedPnlStrategy + netRealizedPnlLedger;
  /**
   * Mode-specific headline: Binance-backed modes show strategy / bracket-attributed net only (same
   * read as live). Paper / non-exchange session uses all CLOSE rows in range (typically no income ledger).
   */
  const netRealizedHeadline =
    mode === "PAPER" ? netRealizedPnlAll : netRealizedPnlStrategy;

  const { strategyFeeTotal, strategyClosesWithFee } = useMemo(() => {
    const rowList = portfolioTrades || [];
    let total = 0;
    let withFee = 0;
    for (const t of closeTradesAppInRange) {
      const openRef = resolveOpenRefForClose(t, rowList, openTradeById);
      const { price, qty } = tradeHistoryDisplayFields(t, openRef);
      const f = tradeFeeUsdForCloseRow(t, qty, price);
      if (f != null) {
        total += f;
        withFee += 1;
      }
    }
    return { strategyFeeTotal: total, strategyClosesWithFee: withFee };
  }, [closeTradesAppInRange, portfolioTrades, openTradeById]);
  const winrate = wins + losses > 0 ? wins / (wins + losses) : null;

  const last10Min = useMemo(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    let appN = 0;
    let appPnl = 0;
    let ledN = 0;
    let ledPnl = 0;
    const rows = portfolioTrades || [];
    for (const t of rows) {
      if (t?.type !== "CLOSE") continue;
      if (tradeTsMs(t) < cutoff) continue;
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      const p = closeTradeNetUsd(t, openRef);
      if (isLedgerClose(t)) {
        ledN += 1;
        ledPnl += p;
      } else {
        appN += 1;
        appPnl += p;
      }
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [portfolioTrades, openTradeById]);

  /** When a custom range is active, show per-bucket net/count (strategy vs ledger) inside that window. */
  const customRangeCloseRollup = useMemo(() => {
    if (!historyFilterHasWindow(historyRangeFilter)) {
      return { appN: 0, appPnl: 0, ledN: 0, ledPnl: 0 };
    }
    let appN = 0;
    let appPnl = 0;
    let ledN = 0;
    let ledPnl = 0;
    const rows = portfolioTrades || [];
    for (const t of closeTradesAppInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      appN += 1;
      appPnl += closeTradeNetUsd(t, openRef);
    }
    for (const t of closeTradesLedgerInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      ledN += 1;
      ledPnl += closeTradeNetUsd(t, openRef);
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [
    historyRangeFilter,
    closeTradesAppInRange,
    closeTradesLedgerInRange,
    portfolioTrades,
    openTradeById,
  ]);

  const openPositionIdTokens = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions) {
      const pid = String(p?.id ?? "");
      if (!pid) continue;
      set.add(pid);
      // Binance adapters sometimes use ids like `bn_<orderId>` / `demo_<orderId>`,
      // while older OPEN trade rows might store only `<orderId>`.
      const parts = pid.split("_");
      if (parts.length >= 2) set.add(parts.slice(1).join("_"));
    }
    return set;
  }, [positions]);

  const openTrades = useMemo(() => {
    const rows = (portfolioTrades || []).filter((t: any) => t?.type === "OPEN");
    return rows.filter((t: any) => openPositionIdTokens.has(String(t?.id ?? "")));
  }, [portfolioTrades, openPositionIdTokens]);

  const closedTrades = useMemo(() => {
    return (portfolioTrades || []).filter((t: any) => t?.type === "CLOSE");
  }, [portfolioTrades]);

  const displayedTrades = useMemo(() => {
    const rows = portfolioTrades || [];
    const keepClose = (t: any) => {
      if (t?.type !== "CLOSE") return false;
      const led = isLedgerClose(t);
      if (closeSourceFilter === "APP" && led) return false;
      if (closeSourceFilter === "LEDGER" && !led) return false;
      return true;
    };
    let out: any[];
    if (tradeHistoryView === "OPEN_ONLY") out = openTrades;
    else if (tradeHistoryView === "CLOSED_ONLY") out = closedTrades.filter(keepClose);
    else if (closeSourceFilter === "ALL") out = rows;
    else out = rows.filter((t: any) => (t?.type === "OPEN" ? true : keepClose(t)));
    const filtered = out.filter((t) => tradeMatchesHistoryTime(t, historyRangeFilter));
    return sortTradeHistoryRows(filtered, tradeHistorySort, rows, openTradeById);
  }, [
    tradeHistoryView,
    openTrades,
    closedTrades,
    portfolioTrades,
    closeSourceFilter,
    historyRangeFilter,
    tradeHistorySort,
    openTradeById,
  ]);

  /** Legacy standalone local futures (former BINANCE_DEMO_FUTURES without keys); hybrid demo uses name "hybrid". */
  const isPaperFuturesLocal = exchName === "binance_demo_futures";

  const hasFuturesPositions = (positions || []).some((p: any) => p?.venue === "FUTURES");
  const isFuturesVenue =
    exchName === "binance_demo_futures" ||
    exchName === "binance_demo_futures_usdm" ||
    exchName === "binance_live_futures_usdm" ||
    exchName === "binance_futures_testnet_usdm" ||
    (exchName === "hybrid" && hasFuturesPositions);

  /** Realized-PnL income stream on demo USD-M muddies "winrate" on CLOSE rows. */
  const showFuturesIncomeLedgerNote =
    exchName === "binance_demo_futures_usdm" ||
    exchName === "binance_live_futures_usdm" ||
    (mode === "BINANCE_DEMO_API" && exchName === "hybrid") ||
    (mode === "BINANCE_LIVE" && exchName === "hybrid");

  const canManualClosePosition =
    mode === "PAPER" ||
    mode === "BINANCE_DEMO_API" ||
    mode === "BINANCE_TESTNET" ||
    mode === "BINANCE_LIVE";

  const subtitle = strictAccountMissing
    ? "Waiting for Binance account data — verify API keys, IP whitelist, and permissions on the server."
    : mode === "BINANCE_DEMO_API" || exchName === "binance_demo_spot"
      ? "Binance Demo Trading account"
      : mode === "BINANCE_LIVE" || exchName === "binance_live_spot"
        ? "Binance mainnet — real funds (spot api.binance.com + USD-M fapi when futures leg active)."
        : mode === "BINANCE_TESTNET"
        ? "Binance testnet (spot testnet + futures USD-M when keys allow each leg)."
        : exchName === "binance_testnet_spot"
          ? "Binance Spot Testnet account"
        : exchName === "binance_demo"
          ? "Simulated account · legacy store (persisted locally)"
          : isPaperFuturesLocal
            ? "Simulated futures · local files only (not Binance). Use TRADING_MODE=BINANCE_DEMO_API with demo API keys for real demo-fapi."
            : exchName === "binance_demo_futures_usdm"
              ? "Binance Demo Futures (USD-M): positions and wallet from demo-fapi.binance.com."
              : exchName === "binance_live_futures_usdm"
                ? "Binance USD-M Futures (mainnet): positions from fapi.binance.com."
              : exchName === "binance_futures_testnet_usdm"
                ? "Binance Futures Testnet: positions from the futures account API."
                : isFuturesVenue
                  ? "Futures tools active; check exchange name in bot status for live vs local sim."
                  : "Paper account · persisted locally";

  const totalUnrealizedPnl = useMemo(() => {
    if (!positions?.length) return null;
    let sum = 0;
    let hasAny = false;
    for (const p of positions) {
      const u = Number(p?.unrealizedPnl ?? NaN);
      if (Number.isFinite(u)) { sum += u; hasAny = true; }
    }
    return hasAny ? sum : null;
  }, [positions]);

  const equityDisplay = useMemo(() => {
    if (strictAccountMissing) return null;
    const venues = (account as any)?.venues;
    if (venues?.spot || venues?.futures) {
      const mm = String((bot as any)?.marketMode || "AUTO").toUpperCase();
      const sRaw = venues?.spot?.equity;
      const fRaw = venues?.futures?.equity;
      const s = sRaw != null && Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;
      const f = fRaw != null && Number.isFinite(Number(fRaw)) ? Number(fRaw) : null;
      if (mm === "FUTURES" && f != null) return f;
      if (mm === "SPOT" && s != null) return s;
      if (s != null && f != null) return s + f;
      if (s != null) return s;
      if (f != null) return f;
    }
    if ((account as any)?.equityWithUnrealized != null) return Number((account as any).equityWithUnrealized);
    if ((account as any)?.equity != null) return Number((account as any).equity);
    return null;
  }, [account, bot, strictAccountMissing]);

  /** Keep a fixed equity sub-grid so hybrid venue lines don't mount/unmount when API omits `dailyPnlPctByVenue` briefly. */
  const showHybridVenueDailyRow =
    exchName === "hybrid" ||
    mode === "BINANCE_DEMO_API" ||
    mode === "BINANCE_TESTNET" ||
    mode === "BINANCE_LIVE";

  const byVenue = (account as any)?.dailyPnlPctByVenue as { spot?: number; futures?: number } | null | undefined;
  const pct = (x: number | null | undefined) =>
    x != null && Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(2)}%` : "—";

  const [portfolioFullscreen, setPortfolioFullscreen] = useState<null | "positions" | "tradeHistory">(null);

  useEffect(() => {
    if (!portfolioFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPortfolioFullscreen(null);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.style.overflow = prev;
    };
  }, [portfolioFullscreen]);

  return (
    <>
      {portfolioFullscreen ? (
        <div
          className="fixed inset-0 z-[199] bg-slate-950/60 dark:bg-black/70"
          aria-hidden
          onClick={() => setPortfolioFullscreen(null)}
        />
      ) : null}
      <div className="p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold">Portfolio</div>
        <div className="text-xs text-slate-600 dark:text-slate-400">{subtitle}</div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div
          className={`rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs tabular-nums${showHybridVenueDailyRow ? " min-h-[9.5rem]" : ""}`}
        >
          <div className="text-slate-600 dark:text-slate-400">Equity</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {equityDisplay != null && Number.isFinite(Number(equityDisplay)) ? `$${Number(equityDisplay).toFixed(2)}` : "—"}
          </div>
          {account?.accountError ? (
            <div className="mt-1 space-y-1 text-[11px] text-rose-300">
              <div>Account error: {String(account.accountError)}</div>
              {/451|restricted location/i.test(String(account.accountError)) ? (
                <div className="text-amber-200/90">
                  Binance is blocking this host (HTTP 451). Demo API keys will not load balance here — use{" "}
                  <span className="font-semibold">TRADING_MODE=PAPER</span> for local equity, or deploy where Binance allows your IP.
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            Daily PnL (worst leg):{" "}
            {account?.dailyPnlPct != null && Number.isFinite(Number(account.dailyPnlPct)) ? (
              <span className={Number(account.dailyPnlPct) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {(Number(account.dailyPnlPct) * 100).toFixed(2)}%
              </span>
            ) : (
              "—"
            )}
          </div>
          {showHybridVenueDailyRow ? (
            <div className="mt-1 min-h-[2.75rem] text-[11px] leading-snug text-slate-600 dark:text-slate-500">
              Spot day:{" "}
              <span
                className={
                  byVenue?.spot != null && Number.isFinite(Number(byVenue.spot))
                    ? Number(byVenue.spot) < 0
                      ? "text-rose-400"
                      : "text-emerald-400"
                    : "text-slate-600 dark:text-slate-400"
                }
              >
                {pct(byVenue?.spot)}
              </span>
              {" · "}
              Futures day:{" "}
              <span
                className={
                  byVenue?.futures != null && Number.isFinite(Number(byVenue.futures))
                    ? Number(byVenue.futures) < 0
                      ? "text-rose-400"
                      : "text-emerald-400"
                    : "text-slate-600 dark:text-slate-400"
                }
              >
                {pct(byVenue?.futures)}
              </span>
            </div>
          ) : null}
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            Unrealized:{" "}
            <span className={(totalUnrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
              {totalUnrealizedPnl != null ? `${totalUnrealizedPnl.toFixed(2)}` : "—"}
            </span>
          </div>
          {showHybridVenueDailyRow || account?.venues?.spot || account?.venues?.futures ? (
            <div className="mt-2 min-h-[4.5rem] rounded-md border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-slate-950/30 p-2 text-[11px] text-slate-700 dark:text-slate-300">
              <div className="text-slate-600 dark:text-slate-400">Breakdown</div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <div>
                  Spot:{" "}
                  <span className="text-slate-900 dark:text-slate-100">
                    {account?.venues?.spot?.equity != null ? `$${Number(account.venues.spot.equity).toFixed(2)}` : "—"}
                  </span>
                </div>
                <div>
                  Futures:{" "}
                  <span className="text-slate-900 dark:text-slate-100">
                    {account?.venues?.futures?.equity != null ? `$${Number(account.venues.futures.equity).toFixed(2)}` : "—"}
                  </span>
                </div>
              </div>
              <div className="mt-1 text-slate-600 dark:text-slate-500">
                {mode === "BINANCE_TESTNET"
                  ? "Spot: testnet.binance.vision · Futures: testnet.binancefuture.com (when connected)."
                  : mode === "BINANCE_LIVE"
                    ? "Spot: api.binance.com · Futures: fapi.binance.com (when connected). Real funds."
                    : "Spot wallet: demo-api.binance.com · Futures wallet: demo-fapi.binance.com (when connected)."}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="text-slate-600 dark:text-slate-400">Net realised PnL</div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                  pnlHistoryRange === "all"
                    ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200"
                    : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900"
                }`}
                onClick={() => setPnlHistoryRange("all")}
              >
                All time
              </button>
              <button
                type="button"
                className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                  pnlHistoryRange === "custom"
                    ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200"
                    : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900"
                }`}
                onClick={() => setPnlHistoryRange("custom")}
              >
                Custom range
              </button>
            </div>
          </div>
          {pnlHistoryRange === "custom" ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="block text-[10px] font-medium text-slate-600 dark:text-slate-400">
                From (local)
                <input
                  type="datetime-local"
                  value={customRangeStart}
                  onChange={(e) => setCustomRangeStart(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="block text-[10px] font-medium text-slate-600 dark:text-slate-400">
                To (local, optional)
                <input
                  type="datetime-local"
                  value={customRangeEnd}
                  onChange={(e) => setCustomRangeEnd(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                />
                <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-500">
                  Leave empty to include everything from “From” through now.
                </span>
                <button
                  type="button"
                  className="mt-1 text-left text-[10px] font-semibold text-emerald-700/90 hover:underline dark:text-emerald-400/90"
                  onClick={() => setCustomRangeEnd("")}
                >
                  Clear “To” → use present
                </button>
              </label>
            </div>
          ) : null}
          {historyRangeFilter.kind === "invalid" && pnlHistoryRange === "custom" ? (
            <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
              Set a valid start (local time). If “To” is set, it must be ≥ start; leave “To” empty to use the present.
            </div>
          ) : null}
          {historyRangeFilter.kind === "range" ? (
            <div className="mt-1 text-[10px] text-slate-600 dark:text-slate-500">
              Filter: trade row <span className="font-mono">ts</span> in [{new Date(historyRangeFilter.startMs).toLocaleString()} –{" "}
              {new Date(historyRangeFilter.endMs).toLocaleString()}] (local browser time).
            </div>
          ) : historyRangeFilter.kind === "from_present" ? (
            <div className="mt-1 text-[10px] text-slate-600 dark:text-slate-500">
              Filter: trade row <span className="font-mono">ts</span> from {new Date(historyRangeFilter.startMs).toLocaleString()} through{" "}
              <span className="font-semibold text-slate-700 dark:text-slate-300">now</span> (local browser time).
            </div>
          ) : null}
          <div
            className={`mt-1 text-lg font-semibold ${netRealizedHeadline >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {Number.isFinite(netRealizedHeadline) ? `$${netRealizedHeadline.toFixed(2)}` : "—"}
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            {mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET" || mode === "BINANCE_DEMO_API" ? (
              <>
                <span className="font-semibold text-slate-700 dark:text-slate-300">Headline</span> = strategy /
                bracket-attributed net in this range. Unmatched <span className="font-mono">REALIZED_PNL</span> ledger
                totals stay in the breakdown only.
                {mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET" ? (
                  <>
                    {" "}
                    Live list omits unmatched income rows unless{" "}
                    <span className="font-mono">BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED=1</span>.
                  </>
                ) : null}
              </>
            ) : (
              <>
                Net of modeled per-trade fees where available; strategy rows use stored CLOSE{" "}
                <span className="font-mono">pnl</span> (paper sims are after fees). Exchange ledger rows are usually net of
                fees in the income amount.
              </>
            )}
          </div>
          {(mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET" || mode === "BINANCE_DEMO_API") &&
          Number.isFinite(netRealizedPnlAll) &&
          closeTradesLedgerInRange.length > 0 ? (
            <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
              Strategy + ledger (same range, not in headline):{" "}
              <span className={netRealizedPnlAll >= 0 ? "text-emerald-400" : "text-rose-400"}>
                ${netRealizedPnlAll.toFixed(2)}
              </span>
            </div>
          ) : null}
          {(closeTradesApp.length > 0 || closeTradesLedger.length > 0) && (
            <div className="mt-2 space-y-0.5 border-t border-slate-200 dark:border-slate-800 pt-2 text-[11px] text-slate-600 dark:text-slate-500">
              <div>
                Strategy / bracket-attributed (net):{" "}
                <span className={netRealizedPnlStrategy >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  ${netRealizedPnlStrategy.toFixed(2)}
                </span>{" "}
                <span className="text-slate-600">({closeTradesAppInRange.length} CLOSE)</span>
              </div>
              {strategyClosesWithFee > 0 ? (
                <div>
                  Total fees (strategy-attributed):{" "}
                  <span className="text-slate-700 dark:text-slate-300">${strategyFeeTotal.toFixed(2)}</span>
                  {strategyClosesWithFee < closeTradesAppInRange.length ? (
                    <span className="text-slate-600">
                      {" "}
                      ({strategyClosesWithFee}/{closeTradesAppInRange.length} closes with fee data)
                    </span>
                  ) : null}
                </div>
              ) : closeTradesAppInRange.length > 0 ? (
                <div className="text-slate-600">Total fees (strategy): no per-trade fee breakdown in current history.</div>
              ) : null}
              {closeTradesLedger.length > 0 ? (
                <div>
                  Unmatched income ledger:{" "}
                  <span className={netRealizedPnlLedger >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    ${netRealizedPnlLedger.toFixed(2)}
                  </span>{" "}
                  <span className="text-slate-600">({closeTradesLedgerInRange.length} CLOSE)</span>
                </div>
              ) : null}
            </div>
          )}
          <div className="mt-2 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
            {historyFilterHasWindow(historyRangeFilter) ? (
              <>
                <span className="font-medium text-slate-600 dark:text-slate-400">In selected range (net):</span> strategy{" "}
                <span className="text-slate-700 dark:text-slate-300">{customRangeCloseRollup.appN}</span> closes ·{" "}
                <span className={customRangeCloseRollup.appPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  ${customRangeCloseRollup.appPnl.toFixed(2)}
                </span>
                {closeTradesLedger.length > 0 || customRangeCloseRollup.ledN > 0 ? (
                  <>
                    {" "}
                    · ledger <span className="text-slate-700 dark:text-slate-300">{customRangeCloseRollup.ledN}</span> ·{" "}
                    <span className={customRangeCloseRollup.ledPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      ${customRangeCloseRollup.ledPnl.toFixed(2)}
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <span className="font-medium text-slate-600 dark:text-slate-400">Last 10 min (net):</span> strategy{" "}
                <span className="text-slate-700 dark:text-slate-300">{last10Min.appN}</span> closes ·{" "}
                <span className={last10Min.appPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>${last10Min.appPnl.toFixed(2)}</span>
                {closeTradesLedger.length > 0 || last10Min.ledN > 0 ? (
                  <>
                    {" "}
                    · ledger <span className="text-slate-700 dark:text-slate-300">{last10Min.ledN}</span> ·{" "}
                    <span className={last10Min.ledPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      ${last10Min.ledPnl.toFixed(2)}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </div>
          {showFuturesIncomeLedgerNote ? (
            <div className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              Futures history may include income ledger rows; realized PnL is not one row per round-trip — use strategy
              PnL / filters above.
            </div>
          ) : null}
        </div>

        <div className="flex min-h-[11rem] items-center justify-center overflow-hidden">
          <AiTradeMotionVisual />
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-600 dark:text-slate-400">Winrate</div>
          <div
            className={`mt-1 text-lg font-semibold ${winrate == null ? "text-slate-900 dark:text-slate-100" : winrate >= 0.5 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {winrate == null ? "—" : `${(winrate * 100).toFixed(1)}%`}
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            Wins: <span className="text-slate-700 dark:text-slate-300">{wins}</span> · Losses: <span className="text-slate-700 dark:text-slate-300">{losses}</span>
            <span className="text-slate-600"> (strategy only)</span>
          </div>
          {pnlHistoryRange === "custom" && historyFilterHasWindow(historyRangeFilter) ? (
            <div className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              Same time filter as <span className="font-medium text-slate-600 dark:text-slate-400">Net realised PnL</span> (row{" "}
              <span className="font-mono">ts</span>).
            </div>
          ) : pnlHistoryRange === "custom" && historyRangeFilter.kind === "invalid" ? (
            <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">Win rate follows all-time closes until the range is valid.</div>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-600 dark:text-slate-400">Open positions</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{positions.length}</div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            {mode === "PAPER" || exchName === "binance_demo"
              ? "SL/TP enforced (simulated)"
              : isPaperFuturesLocal
                ? "Rows are local simulated positions, not Binance open positions"
                : isFuturesVenue
                  ? mode === "BINANCE_LIVE"
                    ? "SL/TP via Binance futures (mainnet)"
                    : "SL/TP enforced locally (exchange brackets not supported on demo)"
                  : "SL/TP enforced (OCO)"}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-600 dark:text-slate-400">Recent events</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{portfolioTrades.length}</div>
          {mode === "PAPER" && (
            <div className="mt-2">
              <button
                className="w-full rounded-md border border-rose-700/40 bg-rose-950/40 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-950/70"
                onClick={() => {
                  deferTask(() => {
                    void (async () => {
                      const ok = window.confirm("Reset simulated account? This deletes snapshot + trades.csv.");
                      if (!ok) return;
                      try {
                        await api.paperReset();
                        pushLog({ level: "warn", msg: "Paper account reset" });
                      } catch {
                        pushLog({ level: "error", msg: "Paper reset failed" });
                      }
                    })();
                  });
                }}
              >
                Reset simulated account
              </button>
            </div>
          )}
        </div>
      </div>

      {bot?.lastTradeBlock ? (
        <div className="mt-3 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-xs">
          <div className="font-semibold text-amber-100/90">Last trade gate</div>
          <div className="mt-1 font-mono text-[11px] text-amber-200/85">
            {String((bot.lastTradeBlock as any).reason || "—")}
            {(bot.lastTradeBlock as any).symbol ? ` · ${(bot.lastTradeBlock as any).symbol}` : ""}
          </div>
          {(bot.lastTradeBlock as any).detail != null && String((bot.lastTradeBlock as any).detail) !== "" ? (
            <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">{(bot.lastTradeBlock as any).detail}</div>
          ) : null}
          <div className="mt-1 text-[10px] text-slate-600 dark:text-slate-500">{(bot.lastTradeBlock as any).ts || ""}</div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div
          className={`rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 ${
            portfolioFullscreen === "positions"
              ? "fixed left-2 top-2 z-[200] flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col shadow-2xl ring-1 ring-slate-300/70 dark:ring-slate-600"
              : ""
          }`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 px-3 py-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">Positions</span>
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              title={portfolioFullscreen === "positions" ? "Close" : "Fullscreen table"}
              aria-label={portfolioFullscreen === "positions" ? "Close fullscreen" : "Open positions table fullscreen"}
              onClick={(e) => {
                e.stopPropagation();
                setPortfolioFullscreen((s) => (s === "positions" ? null : "positions"));
              }}
            >
              {portfolioFullscreen === "positions" ? (
                <span className="text-xl leading-none">×</span>
              ) : (
                <IconTableFullscreen className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <div
            className={
              portfolioFullscreen === "positions" ? "min-h-0 flex-1 overflow-auto" : "max-h-[260px] overflow-auto"
            }
          >
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                <tr className="text-left text-slate-600 dark:text-slate-400">
                  <th className="w-3 min-w-[12px] max-w-[14px] border-0 p-0" aria-hidden />
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th
                    className="max-w-[5.5rem] px-3 py-2"
                    title="Binance USD-M market entry order id (from the bot OPEN fill for this symbol)"
                  >
                    Binance ID
                  </th>
                  <th className="px-3 py-2">Venue</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Margin</th>
                  <th className="px-3 py-2">SL</th>
                  <th className="px-3 py-2">TP</th>
                  <th className="px-3 py-2" title="Unrealized P&L as % of initial margin (futures) or entry notional (spot)">
                    uPnL%
                  </th>
                  <th className="px-3 py-2">uPnL</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={15}>
                      No open positions
                    </td>
                  </tr>
                ) : (
                  positions.flatMap((p: any) => {
                    const upnlPct = positionUnrealizedPnlPct(p);
                    const binRefPos = portfolioBinanceRefForPosition(p);
                    const trailSlSt = (p.meta as Record<string, unknown> | undefined)?.trailSlConfirm as
                      | { status?: string }
                      | undefined;
                    const trailSlPending = trailSlSt?.status === "REQUESTED";
                    const mainRow = (
                    <tr key={p.id} className="border-t border-slate-200 dark:border-slate-900">
                      <td className="w-3 min-w-[12px] max-w-[14px] border-0 px-0 py-2 align-middle">
                        {positionRowTrailedStrict(p, trailingStopLossAuto) ? (
                          <TrailedStopLead />
                        ) : positionRowBreakevenStopIndicator(p, trailingStopLossAuto) ? (
                          <BreakevenStopLead />
                        ) : null}
                      </td>
                      <td
                        className="px-3 py-2 text-[10px] tabular-nums text-slate-500 dark:text-slate-400"
                        title={fmtTimestampFull(Number(p.openedAt ? new Date(String(p.openedAt)).getTime() : p.updateTime || 0))}
                      >
                        {fmtTimestamp(Number(p.openedAt ? new Date(String(p.openedAt)).getTime() : p.updateTime || 0))}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{p.symbol}</td>
                      <td
                        className="max-w-[5.5rem] px-3 py-2 font-mono text-[10px] text-slate-600 dark:text-slate-400"
                        title={binRefPos.title || undefined}
                      >
                        {binRefPos.label}
                      </td>
                      <td className="px-3 py-2 text-[10px] uppercase text-slate-600 dark:text-slate-500">
                        {p.venue === "FUTURES" ? "Fut" : "Spot"}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{p.side}</td>
                      <td className="px-3 py-2 text-amber-300/80">
                        {p.leverage != null && Number(p.leverage) > 0 ? `${Number(p.leverage)}x` : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{fmtInstrumentPx(p.entryPrice)}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{Number(p.qty).toFixed(6)}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300" title="Initial margin ≈ notional / leverage (USD-M)">
                        {positionInitialMarginUsd(p)}
                      </td>
                      <td
                        className="px-3 py-2 text-slate-700 dark:text-slate-300"
                        title={p.venue === "FUTURES" ? futuresTrailLadderSummaryTitle(p, bot) : undefined}
                      >
                        {p.stopLoss != null ? fmtInstrumentPx(p.stopLoss) : "—"}
                        {(() => {
                          const tier =
                            p.trailTierLabel != null
                              ? String(p.trailTierLabel)
                              : (() => {
                                  const step = Number((p.meta as Record<string, unknown> | undefined)?.trailStep);
                                  return Number.isFinite(step) && step >= 1 ? `T${Math.max(0, Math.floor(step) - 1)}` : null;
                                })();
                          return tier ? (
                            <span
                              className="ml-1 rounded bg-emerald-600/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-500 dark:text-emerald-400"
                              title={`SL trail ${tier} — stop tightened by auto-trailing`}
                            >
                              {tier}
                            </span>
                          ) : null;
                        })()}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                        {p.takeProfit != null ? fmtInstrumentPx(p.takeProfit) : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 tabular-nums ${
                          upnlPct != null && upnlPct >= 0
                            ? "text-emerald-400"
                            : upnlPct != null
                              ? "text-rose-400"
                              : "text-slate-600 dark:text-slate-400"
                        }`}
                        title="Versus initial margin (futures) or entry notional (spot)"
                      >
                        {fmtPnlPct(upnlPct)}
                      </td>
                      <td className={`px-3 py-2 ${Number(p.unrealizedPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {p.unrealizedPnl != null ? Number(p.unrealizedPnl).toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {(() => {
                          const positionSourceHint =
                            p.syncSource === "fapi_v2_account" ? (
                              <span className="text-[11px] text-slate-600 dark:text-slate-500" title="Position size from GET /fapi/v2/account">
                                Exchange
                              </span>
                            ) : p.syncSource === "paper_local" ? (
                              <span
                                className="text-[11px] text-amber-200/80"
                                title="Local simulated futures (data/binance-demo-futures). Not an open position on Binance."
                              >
                                Local sim
                              </span>
                            ) : p.venue === "FUTURES" ? (
                              <span className="text-[11px] text-slate-600 dark:text-slate-500" title={String(p.syncSource || "futures")}>
                                Futures
                              </span>
                            ) : mode === "PAPER" || exchName === "binance_demo" ? null : (
                              <span className="text-[11px] text-slate-600 dark:text-slate-500">OCO-managed</span>
                            );
                          return (
                            <div className="flex items-center justify-end gap-2">
                              {canManualClosePosition ? (
                                <button
                                  type="button"
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rose-800/55 bg-rose-950/35 text-lg font-light leading-none text-rose-100 hover:bg-rose-950/55"
                                  title="Close position (paper: last candle; futures: market reduce-only)"
                                  aria-label="Close position"
                                  onClick={() => {
                                    const id = p.id;
                                    deferTask(() => {
                                      void (async () => {
                                        try {
                                          await api.closeTrade(id);
                                          try {
                                            await api.tradeRefresh();
                                          } catch {
                                            /* WS may have updated; ignore */
                                          }
                                          pushLog({ level: "info", msg: "Position closed", id });
                                        } catch (e: unknown) {
                                          pushLog({
                                            level: "error",
                                            msg: `Close failed: ${e instanceof Error ? e.message : String(e)}`,
                                            id,
                                          });
                                        }
                                      })();
                                    });
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                              {positionSourceHint}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                    );
                    if (!trailSlPending) return [mainRow];
                    return [
                      <tr key={`${p.id}-trail-pending`} className="border-0 bg-amber-500/[0.07] dark:bg-amber-950/25">
                        <td colSpan={15} className="px-3 py-1">
                          <div className="flex items-center gap-2 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                            <span
                              className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-600 border-t-transparent dark:border-amber-400"
                              aria-hidden
                            />
                            Confirming SL trail on the exchange…
                          </div>
                        </td>
                      </tr>,
                      mainRow,
                    ];
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div
          className={`rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 ${
            portfolioFullscreen === "tradeHistory"
              ? "fixed left-2 top-2 z-[200] flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col shadow-2xl ring-1 ring-slate-300/70 dark:ring-slate-600"
              : ""
          }`}
        >
          <div className="shrink-0 border-b border-slate-200 dark:border-slate-800 px-3 py-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">Trade history</span>
                  <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    title={portfolioFullscreen === "tradeHistory" ? "Close" : "Fullscreen table"}
                    aria-label={
                      portfolioFullscreen === "tradeHistory" ? "Close fullscreen" : "Open trade history fullscreen"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      setPortfolioFullscreen((s) => (s === "tradeHistory" ? null : "tradeHistory"));
                    }}
                  >
                    {portfolioFullscreen === "tradeHistory" ? (
                      <span className="text-lg leading-none">×</span>
                    ) : (
                      <IconTableFullscreen className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={tradeRefreshing}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 disabled:opacity-40"
                    title="Reload trade history from the server (POST /api/trade/refresh — merges exchange + saved trades)"
                    aria-label="Refresh trade history from server"
                    onClick={() => {
                      setTradeRefreshing(true);
                      deferTask(() => {
                        void (async () => {
                          try {
                            const r = await api.tradeRefresh();
                            pushLog({
                              level: "info",
                              msg: `Trade history refreshed (${Number(r?.count ?? 0)} rows)`,
                            });
                          } catch (e: unknown) {
                            pushLog({ level: "error", msg: `Refresh failed: ${e instanceof Error ? e.message : String(e)}` });
                          } finally {
                            setTradeRefreshing(false);
                          }
                        })();
                      });
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`h-3.5 w-3.5${tradeRefreshing ? " animate-spin" : ""}`}
                    >
                      <path
                        fillRule="evenodd"
                        d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311V15a.75.75 0 01-1.5 0v-3.5a.75.75 0 01.75-.75H8.5a.75.75 0 010 1.5H7.058l.166.174a4 4 0 006.703-1.8.75.75 0 011.385.575zM4.688 8.576a5.5 5.5 0 019.201-2.466l.312.311V5a.75.75 0 011.5 0v3.5a.75.75 0 01-.75.75H11.5a.75.75 0 010-1.5h1.442l-.166-.174a4 4 0 00-6.703 1.8.75.75 0 01-1.385-.575z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
                {historyRangeFilter.kind === "range" ? (
                  <div className="mt-0.5 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                    Time filter:{" "}
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {new Date(historyRangeFilter.startMs).toLocaleString()}
                    </span>{" "}
                    –{" "}
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {new Date(historyRangeFilter.endMs).toLocaleString()}
                    </span>
                  </div>
                ) : historyRangeFilter.kind === "from_present" ? (
                  <div className="mt-0.5 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                    Time filter:{" "}
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {new Date(historyRangeFilter.startMs).toLocaleString()}
                    </span>{" "}
                    – <span className="font-semibold text-slate-700 dark:text-slate-300">present</span>
                  </div>
                ) : pnlHistoryRange === "custom" && historyRangeFilter.kind === "invalid" ? (
                  <div className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-300">Invalid range — showing all rows.</div>
                ) : null}
                {isFuturesVenue ? (
                  <div
                    className="mt-1.5 rounded-md border border-amber-500/50 bg-amber-100/90 px-2 py-1.5 text-[10px] leading-snug text-amber-950 dark:border-amber-400/35 dark:bg-amber-950/50 dark:text-amber-50"
                    role="note"
                  >
                    <span className="font-semibold">USD-M realized row: </span>
                    Gross / Net / PnL% on closes use Binance{" "}
                    <span className="font-mono">REALIZED_PNL</span> (Binance ID = income tran id) plus a modeled close
                    fee when commission is not on the row. OPEN PnL% is live unrealized vs margin, not the closed trade.
                    Refresh after a signal exit if rows look stale.
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "ALL" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("ALL")}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("OPEN_ONLY")}
                >
                  Open
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "CLOSED_ONLY" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("CLOSED_ONLY")}
                >
                  Closed
                </button>
                <span className="mx-1 hidden text-slate-600 sm:inline">|</span>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-600"
                      : closeSourceFilter === "ALL"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("ALL")}
                >
                  Src all
                </button>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-600"
                      : closeSourceFilter === "APP"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("APP")}
                  title="Strategy / app closes only"
                >
                  Strategy
                </button>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-600"
                      : closeSourceFilter === "LEDGER"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("LEDGER")}
                  title="Futures income ledger REALIZED_PNL rows"
                >
                  Ledger
                </button>
                <span className="mx-1 hidden text-slate-600 sm:inline">|</span>
                <label className="flex min-w-0 max-w-full items-center gap-1.5 sm:max-w-[14rem]">
                  <span className="shrink-0 text-[10px] font-medium text-slate-600 dark:text-slate-400">Sort</span>
                  <select
                    className="min-w-0 flex-1 cursor-pointer truncate rounded-md border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-800 shadow-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 sm:flex-none sm:text-[11px]"
                    value={tradeHistorySort}
                    onChange={(e) => setTradeHistorySort(e.target.value as TradeHistorySort)}
                    title="Order rows in the table below"
                  >
                    <option value="RECENT">Recent first</option>
                    <option value="OLDEST">Oldest first</option>
                    <option value="PNL_HIGH">Net PnL · high → low</option>
                    <option value="PNL_LOW">Net PnL · low → high</option>
                    <option value="GROSS_HIGH">Gross · high → low</option>
                    <option value="GROSS_LOW">Gross · low → high</option>
                    <option value="SYMBOL_AZ">Symbol A–Z</option>
                    <option value="SYMBOL_ZA">Symbol Z–A</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
          <div
            className={
              portfolioFullscreen === "tradeHistory" ? "min-h-0 flex-1 overflow-auto" : "max-h-[260px] overflow-auto"
            }
          >
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                <tr className="text-left text-slate-600 dark:text-slate-400">
                  <th className="w-3 min-w-[12px] max-w-[14px] border-0 p-0" aria-hidden />
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th
                    className="max-w-[5.5rem] px-3 py-2"
                    title="Binance: order id on OPEN (market entry); income tran id on CLOSE (REALIZED_PNL)"
                  >
                    Binance ID
                  </th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Margin</th>
                  <th className="px-3 py-2">SL/TP</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Src</th>
                  <th className="px-3 py-2">Gross</th>
                  <th className="px-3 py-2">Fee</th>
                  <th className="px-3 py-2">Net</th>
                  <th className="px-3 py-2" title="OPEN: live uPnL% vs margin when position matches. CLOSE: net / initial margin at entry (futures).">
                    PnL%
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedTrades.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={17}>
                      No trades yet
                    </td>
                  </tr>
                ) : (
                  displayedTrades.map((t: any, idx) => {
                    const openRef =
                      t?.type === "CLOSE"
                        ? resolveOpenRefForClose(t, portfolioTrades || [], openTradeById)
                        : undefined;
                    const { lev, price, qty, sl, tp } = tradeHistoryDisplayFields(t, openRef);
                    const fee = tradeFeeUsdForCloseRow(t, qty, price);
                    const gross = t?.type === "CLOSE" ? tradeGrossPnlClose(t, qty, price, openRef) : null;
                    const net = t?.type === "CLOSE"
                      ? (tradeNetPnlClose(t) ?? (gross != null ? gross - (fee ?? 0) : null))
                      : null;
                    const sideDisp =
                      t?.type === "CLOSE"
                        ? (t?.meta?.closeSide != null
                            ? String(t.meta.closeSide)
                            : closeOrderSideFromOpenLeg(openRef) ?? (t.side != null ? String(t.side) : null) ?? "n/a")
                        : (t.side != null ? String(t.side) : "n/a");
                    const slTpDisp = `${sl != null && Number.isFinite(sl) ? fmtInstrumentPx(sl) : "n/a"} / ${tp != null && Number.isFinite(tp) ? fmtInstrumentPx(tp) : "n/a"}`;
                    const marginDisp = tradeInitialMarginUsd(t, openRef, { price, qty, lev });
                    const pnlPct = tradeHistoryPnlPct(t, openRef, positions, { price, qty, lev });
                    const reasonDisp = tradeHistoryReasonLabel(t);
                    const binRefTrade = portfolioBinanceRefForTradeRow(t);
                    const reasonTitle = [t.reason, t?.meta?.closeReason, t?.meta?.bracketType]
                      .filter((x) => x != null && String(x).trim() !== "")
                      .join(" · ");
                    const trailLead = openTradeRowTrailedStrict(t, positions, trailingStopLossAuto);
                    const beLead = !trailLead && openTradeRowBreakevenStopIndicator(t, positions, trailingStopLossAuto);
                    const closeTrailLead = t?.type === "CLOSE" && closeTradeRowTrailedStrict(t);
                    return (
                      <tr
                        key={`${t?.type}-${String(t?.id ?? "")}-${tradeTsMs(t)}-${idx}`}
                        className="border-t border-slate-200 dark:border-slate-900"
                      >
                        <td className="w-3 min-w-[12px] max-w-[14px] border-0 px-0 py-2 align-middle">
                          {trailLead || closeTrailLead ? (
                            <TrailedStopLead />
                          ) : beLead ? (
                            <BreakevenStopLead />
                          ) : null}
                        </td>
                        <td
                          className="px-3 py-2 text-[10px] tabular-nums text-slate-500 dark:text-slate-400"
                          title={fmtTimestampFull(tradeTsMs(t))}
                        >
                          {fmtTimestamp(tradeTsMs(t))}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{t.type ?? t.reason ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{t.symbol ?? "n/a"}</td>
                        <td
                          className="max-w-[5.5rem] px-3 py-2 font-mono text-[10px] text-slate-600 dark:text-slate-400"
                          title={binRefTrade.title || undefined}
                        >
                          {binRefTrade.label}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{sideDisp}</td>
                        <td className="px-3 py-2 text-amber-300/80">
                          {lev != null && lev > 0 ? `${lev}x` : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {price != null && price > 0 ? fmtInstrumentPx(price) : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {qty != null && qty > 0 ? qty.toFixed(6) : "n/a"}
                        </td>
                        <td
                          className="px-3 py-2 text-slate-700 dark:text-slate-300"
                          title="Initial margin ≈ entry×qty / leverage when leverage is known (futures)"
                        >
                          {marginDisp}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-slate-600 dark:text-slate-400">{slTpDisp}</td>
                        <td
                          className="max-w-[7rem] px-3 py-2 text-[10px] text-slate-700 dark:text-slate-300"
                          title={reasonTitle || undefined}
                        >
                          {reasonDisp}
                        </td>
                        <td className="px-3 py-2 text-[10px] uppercase text-slate-600 dark:text-slate-500">
                          {t.type === "CLOSE" ? (isLedgerClose(t) ? "ledger" : "strat") : t.type === "OPEN" ? "strat" : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 ${gross != null && gross >= 0 ? "text-emerald-400" : gross != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
                        >
                          {gross != null ? fmtUsd(gross) : t?.type === "CLOSE" ? "n/a" : "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {fee != null ? fmtUsd(fee, 4) : "n/a"}
                        </td>
                        <td
                          className={`px-3 py-2 ${net != null && net >= 0 ? "text-emerald-400" : net != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
                        >
                          {net != null ? fmtUsd(net) : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 tabular-nums ${
                            pnlPct != null && pnlPct >= 0 ? "text-emerald-400" : pnlPct != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"
                          }`}
                        >
                          {fmtPnlPct(pnlPct)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

