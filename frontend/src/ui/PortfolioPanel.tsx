import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { deferTask } from "../lib/deferTask";
import {
  loadPortfolioPnlRangeForMode,
  tradingUiPersistPortfolioPnlRange,
} from "../lib/tradingUiPersistence";
import { tradingModeToApiModeSlug } from "../lib/tradingModeSlug";
import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { isIncomeLedgerClose } from "../lib/tradeClassification";
import {
  clampTradeCloseFeeRate,
  estimatedCloseFeeUsdt,
  estimatedOpenFeeUsdt,
  TRADE_CLOSE_FEE_RATE,
} from "../lib/tradeCloseFee";
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

/** OPEN leg lies in the same time filter as the CLOSE row — required for attributed window PnL. */
function roundTripOpenLegInHistoryWindow(openRow: any | undefined, f: HistoryRangeFilter): boolean {
  if (!openRow) return false;
  return tradeMatchesHistoryTime(openRow, f);
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

function clampHistFeeFrac(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(0.01, Math.max(0, x));
}

type HistLiq = "MAKER" | "TAKER";

function inferOpenLegLiquidityForHistory(openRow: any): HistLiq {
  const m = openRow?.meta ?? {};
  if (m.entryAllMaker === true || m.entryLiquidity === "MAKER") return "MAKER";
  if (m.entryAllMaker === false || m.entryLiquidity === "TAKER") return "TAKER";
  if (m.entryMaker === true) return "MAKER";
  if (m.entryMaker === false) return "TAKER";
  const ot = String(m.orderType ?? m.origType ?? "").toUpperCase();
  if (ot.includes("MARKET")) return "TAKER";
  if (ot.includes("LIMIT")) {
    if (ot.includes("IOC") || ot.includes("FOK")) return "TAKER";
    return "MAKER";
  }
  return "TAKER";
}

function inferCloseLegLiquidityForHistory(closeRow: any): HistLiq {
  const m = closeRow?.meta ?? {};
  if (m.exitAllMaker === true || m.exitLiquidity === "MAKER") return "MAKER";
  if (m.exitAllMaker === false || m.exitLiquidity === "TAKER") return "TAKER";
  if (m.exitMaker === true) return "MAKER";
  if (m.exitMaker === false) return "TAKER";
  const ot = String(m.orderType ?? m.origType ?? "").toUpperCase();
  if (ot.includes("MARKET")) return "TAKER";
  if (ot.includes("LIMIT")) {
    if (ot.includes("IOC") || ot.includes("FOK")) return "TAKER";
    return "MAKER";
  }
  return "TAKER";
}

/** Modeled open-leg fee rate from bot “trade history” maker/taker table (fallback: trail open fee). */
function tradeHistoryOpenFeeRateForRow(bot: any, openRow: any): number {
  const feeR = clampTradeCloseFeeRate();
  const trailO =
    Number.isFinite(Number(bot?.trailOpenFeeRate)) && Number(bot.trailOpenFeeRate) > 0
      ? Number(bot.trailOpenFeeRate)
      : feeR;
  const mk = clampHistFeeFrac(Number(bot?.tradeHistoryMakerOpenFeeRate ?? 0.0002));
  const tk = clampHistFeeFrac(Number(bot?.tradeHistoryTakerOpenFeeRate ?? 0.0005));
  const mkU = mk > 0 ? mk : trailO;
  const tkU = tk > 0 ? tk : trailO;
  return inferOpenLegLiquidityForHistory(openRow) === "MAKER" ? mkU : tkU;
}

/** Modeled close-leg fee rate from bot table (fallback: trail close fee). */
function tradeHistoryCloseFeeRateForRow(bot: any, closeRow: any): number {
  const feeR = clampTradeCloseFeeRate();
  const trailC =
    Number.isFinite(Number(bot?.trailCloseFeeRate)) && Number(bot.trailCloseFeeRate) > 0
      ? Number(bot.trailCloseFeeRate)
      : feeR;
  const mk = clampHistFeeFrac(Number(bot?.tradeHistoryMakerCloseFeeRate ?? 0.0002));
  const tk = clampHistFeeFrac(Number(bot?.tradeHistoryTakerCloseFeeRate ?? 0.0005));
  const mkU = mk > 0 ? mk : trailC;
  const tkU = tk > 0 ? tk : trailC;
  return inferCloseLegLiquidityForHistory(closeRow) === "MAKER" ? mkU : tkU;
}

/** Fee for display: same as tradeFeeUsd, else modeled close fee from qty×price×custom taker/maker rate when possible. */
function tradeFeeUsdForCloseRow(
  t: any,
  displayQty: number | undefined,
  displayPrice: number | undefined,
  bot?: any,
): number | null {
  const direct = tradeFeeUsd(t);
  if (direct != null) return direct;
  if (t?.type !== "CLOSE") return null;
  const r = bot ? tradeHistoryCloseFeeRateForRow(bot, t) : TRADE_CLOSE_FEE_RATE;
  return estimatedCloseFeeUsdt(displayQty, displayPrice, r);
}

/**
 * Round-trip commissions for a CLOSE (open leg + close leg), aligned with Binance “two fee rows” per round-trip.
 * Prefers `meta.totalFee`, then `meta.openFee`+`meta.exitFee` on the close row, else sum of fees on matched OPEN + CLOSE.
 */
function tradeRoundTripFeeUsdForCloseRow(
  t: any,
  openRef: any | undefined,
  displayQty?: number,
  displayPrice?: number,
  bot?: any,
): number | null {
  if (String(t?.type ?? "").toUpperCase() !== "CLOSE") {
    return tradeFeeUsd(t);
  }
  const m = t?.meta || {};
  if (m.totalFee != null && Number.isFinite(Number(m.totalFee)) && Number(m.totalFee) >= 0) {
    return Number(m.totalFee);
  }
  const op = Number(m.openFee);
  const ex = Number(m.exitFee);
  if (Number.isFinite(op) && Number.isFinite(ex) && op >= 0 && ex >= 0) {
    return op + ex;
  }
  const closeFee = tradeFeeUsdForCloseRow(t, displayQty, displayPrice, bot);
  let openFee = openRef ? tradeFeeUsd(openRef) : null;
  if (openFee == null && openRef && bot) {
    const q = numFinite(openRef.qty ?? displayQty);
    const px = numFinite(openRef.price ?? openRef.meta?.entryPx ?? displayPrice ?? t?.entryPrice);
    openFee = estimatedOpenFeeUsdt(q, px, tradeHistoryOpenFeeRateForRow(bot, openRef));
  }
  if (closeFee != null && openFee != null) return closeFee + openFee;
  if (closeFee != null) return closeFee;
  if (openFee != null) return openFee;
  return null;
}

/**
 * When the exchange never patched OPEN `fee` / `meta.openFee`, infer the same per-leg fee **rate** as the
 * paired CLOSE (exit commission ÷ close notional) so OPEN matches Binance tier even if `trailOpenFeeRate` is stale/low.
 */
function inferPerLegFeeRateFromPairedClose(closeRow: any): number | null {
  if (String(closeRow?.type ?? "").toUpperCase() !== "CLOSE") return null;
  const m = closeRow.meta || {};
  let feeUsd: number | null = null;
  if (Number.isFinite(Number(m.exitFee)) && Number(m.exitFee) >= 0) feeUsd = Number(m.exitFee);
  else if (closeRow?.fee != null && Number.isFinite(Number(closeRow.fee)) && Number(closeRow.fee) >= 0) {
    feeUsd = Number(closeRow.fee);
  } else {
    const tf = tradeFeeUsd(closeRow);
    if (tf != null && tf >= 0) feeUsd = tf;
  }
  const q = numFinite(closeRow?.qty);
  const px = numFinite(
    closeRow?.price ?? m.exitPrice ?? m.closePrice ?? m.markPx ?? closeRow?.entryPrice,
  );
  if (feeUsd == null || q == null || px == null || q <= 0 || px <= 0) return null;
  const r = feeUsd / (q * px);
  if (!Number.isFinite(r) || r <= 0 || r > 0.02) return null;
  return r;
}

/** Opening commission: stored `meta.openFee`, row `fee`, else qty×fill×rate (exchange infer from paired CLOSE, else bot `trailOpenFeeRate`). */
function tradeOpenLegFeeUsd(
  openRow: any,
  qty: number | undefined,
  fillPx: number | undefined,
  openFeeRate: number,
  pairedCloseRow?: any,
): number | null {
  if (!openRow) return null;
  const m = openRow.meta || {};
  if (Number.isFinite(Number(m.openFee)) && Number(m.openFee) >= 0) return Number(m.openFee);
  const td = tradeFeeUsd(openRow);
  if (td != null && td >= 0) return td;
  const inferred = pairedCloseRow != null ? inferPerLegFeeRateFromPairedClose(pairedCloseRow) : null;
  const rate = inferred != null && inferred > 0 ? inferred : openFeeRate;
  return estimatedOpenFeeUsdt(qty, fillPx, rate);
}

/** Closing commission only: `meta.exitFee`, else total−open when `meta.totalFee` + matched OPEN, else modeled close fee. */
function tradeCloseLegFeeUsd(
  closeRow: any,
  openRef: any | undefined,
  qty: number | undefined,
  exitPx: number | undefined,
  openFeeRate: number,
  closeFeeRate: number,
): number | null {
  const m = closeRow?.meta || {};
  if (Number.isFinite(Number(m.exitFee)) && Number(m.exitFee) >= 0) return Number(m.exitFee);
  const total = Number.isFinite(Number(m.totalFee)) && Number(m.totalFee) >= 0 ? Number(m.totalFee) : null;
  if (total != null && openRef) {
    const qo = numFinite(openRef.qty ?? qty);
    const eo = numFinite(openRef.price ?? openRef.meta?.entryPx ?? closeRow?.entryPrice);
    const openPart = tradeOpenLegFeeUsd(openRef, qo, eo, openFeeRate, closeRow);
    if (openPart != null && total + 1e-9 >= openPart) return Math.round((total - openPart) * 1e6) / 1e6;
  }
  const tf = tradeFeeUsd(closeRow);
  if (
    tf != null &&
    tf >= 0 &&
    total == null &&
    !(Number.isFinite(Number(m.openFee)) && Number.isFinite(Number(m.exitFee)))
  )
    return tf;
  return estimatedCloseFeeUsdt(qty, exitPx, closeFeeRate);
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

function tradeGrossPnlClose(
  t: any,
  displayQty?: number,
  displayPrice?: number,
  openRef?: any,
  bot?: any,
): number | null {
  if (t?.type !== "CLOSE") return null;
  const m = t?.meta || {};
  if (t?.grossPnl != null && Number.isFinite(Number(t.grossPnl))) return Number(t.grossPnl);
  if (m.grossPnl != null && Number.isFinite(Number(m.grossPnl))) return Number(m.grossPnl);
  /**
   * Binance `fapi_income` CLOSE rows: `pnl` is exchange REALIZED_PNL (authoritative for Net).
   * `pnl + roundTripFee` is **not** “price gross” — it mislabels when entry was paired to the wrong OPEN
   * (same symbol, newer cycle) or when funding is folded into fee columns. Prefer entry vs exit × qty.
   */
  if (!closeStoredPnlIsPackedWalletNet(t)) {
    const inferred = inferCloseGrossFromPrices(t, openRef, displayQty, displayPrice);
    if (inferred != null && Number.isFinite(inferred)) return inferred;
  }
  const net = Number(t?.pnl ?? m.pnl ?? m.realizedPnl ?? m.realized_pnl);
  if (Number.isFinite(net)) {
    const fee =
      tradeRoundTripFeeUsdForCloseRow(t, openRef, displayQty, displayPrice, bot) ??
      tradeFeeUsdForCloseRow(t, displayQty, displayPrice, bot);
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

/**
 * Binance `/fapi/v1/income` REALIZED_PNL rows carry **price** PnL only; commissions are separate (and we show OPEN fee +
 * CLOSE exit fee in columns). Paper/synthetic packed rows store **wallet net after fees** on `pnl` with `totalFee` etc.
 * Only the latter should use the legacy OPEN+CLOSE split adjustment (`pnl + openFee` when both legs visible).
 */
function closeStoredPnlIsPackedWalletNet(closeRow: any): boolean {
  const m = closeRow?.meta || {};
  if (Number.isFinite(Number(m.walletNetUsd))) return true;
  if (Number.isFinite(Number(m.totalFee)) && Number(m.totalFee) >= 0) return true;
  if (m.source === "fapi_income") return false;
  if (m.syntheticImmediateClose === true) return false;
  return true;
}

/** CLOSE row Net column: reconciles Binance income shards vs split OPEN/CLOSE fee rows without double-counting open fee. */
function closeDisplayedNetFromStored(
  closeRow: any,
  storedCloseNet: number,
  openRef: any | undefined,
  openFeeAmt: number | null,
  openInView: boolean,
  exitFeeUsd: number | null,
): number {
  if (!closeStoredPnlIsPackedWalletNet(closeRow)) {
    const ex = exitFeeUsd != null && Number.isFinite(exitFeeUsd) ? exitFeeUsd : 0;
    return storedCloseNet - ex;
  }
  if (openRef && openFeeAmt != null && openInView) return storedCloseNet + openFeeAmt;
  return storedCloseNet;
}

/** Net for a close = gross − fees (fees 0 when unknown); falls back to stored net PnL. */
function closeTradeNetUsd(t: any, openRef: any | undefined, bot?: any): number {
  const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
  const g = tradeGrossPnlClose(t, qty, price, openRef, bot);
  const f = tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot);
  if (g != null && Number.isFinite(g)) {
    const feePart = f != null && Number.isFinite(f) ? f : 0;
    return g - feePart;
  }
  return tradeNetPnlClose(t) ?? 0;
}

/**
 * Round-trip “Trip” net = total gross − total fee as shown in Gross/Fee columns (close gross + OPEN/CLOSE fees).
 * Falls back to {@link closeTradeNetUsd} when display gross or fees are incomplete.
 */
function tradeHistoryRoundTripNetUsd(c: any, o: any | undefined, bot?: any): number {
  const openInViewRt = Boolean(o);
  const dispO = o ? tradeHistoryDisplayFields(o, undefined, bot) : null;
  const dispC = tradeHistoryDisplayFields(c, o, bot);
  const entryPxMerge =
    numFinite(c?.entryPrice ?? c?.meta?.entryPrice ?? o?.entryPrice ?? o?.price ?? o?.meta?.entryPx) ?? null;
  let openFee: number | null = null;
  let netC: number | null = null;
  let feeC: number | null = null;
  const openRo = o ? tradeHistoryOpenFeeRateForRow(bot, o) : tradeHistoryOpenFeeRateForRow(bot, c);
  const closeR = tradeHistoryCloseFeeRateForRow(bot, c);
  const priceC = dispC.price;
  const qtyC = dispC.qty;
  if (o) {
    const qtyO = dispO!.qty;
    const priceO = dispO!.price;
    const entryPxO = numFinite(o.entryPrice ?? o.meta?.entryPrice ?? o.price ?? o.meta?.entryPx) ?? null;
    openFee = tradeOpenLegFeeUsd(o, qtyO, priceO ?? entryPxO, openRo, c);
  }
  feeC = tradeCloseLegFeeUsd(c, o, qtyC, priceC, openRo, closeR);
  const storedCloseNet = tradeNetPnlClose(c);
  const openFeeAmt =
    o != null
      ? tradeOpenLegFeeUsd(
          o,
          numFinite(o.qty ?? qtyC),
          numFinite(o.price ?? o.meta?.entryPx ?? entryPxMerge),
          tradeHistoryOpenFeeRateForRow(bot, o),
          c,
        )
      : null;
  if (storedCloseNet != null && Number.isFinite(storedCloseNet)) {
    netC = closeDisplayedNetFromStored(c, storedCloseNet, o, openFeeAmt, openInViewRt, feeC);
  } else {
    const g0 = tradeGrossPnlClose(c, qtyC, priceC, o, bot);
    netC = g0 != null && feeC != null ? g0 - feeC : tradeNetPnlClose(c);
  }
  const grossC =
    netC != null && feeC != null ? netC + feeC : tradeGrossPnlClose(c, qtyC, priceC, o, bot);
  const feeTotalRt =
    openFee != null && feeC != null ? openFee + feeC : tradeRoundTripFeeUsdForCloseRow(c, o, qtyC, priceC, bot);
  const tripNetFromDisplay =
    grossC != null &&
    feeTotalRt != null &&
    Number.isFinite(grossC) &&
    Number.isFinite(feeTotalRt)
      ? grossC - feeTotalRt
      : null;
  return tripNetFromDisplay ?? closeTradeNetUsd(c, o, bot);
}

function fmtUsd(x: number | null, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return Number(x).toFixed(digits);
}

/**
 * When formatted entry/exit match at table precision, fills can still differ by a tick — large qty ⇒ ~USDT move.
 * (Low-price perps: Binance REALIZED_PNL can be ~$1 while Entry/Exit both show 0.2506.)
 */
function tradeHistoryEntryExitMicroMoveTitle(
  entryPx: number | null,
  exitPx: number | null,
  qty: number | null,
): string | undefined {
  if (entryPx == null || exitPx == null || !Number.isFinite(entryPx) || !Number.isFinite(exitPx) || entryPx <= 0 || exitPx <= 0) {
    return undefined;
  }
  if (fmtInstrumentPx(entryPx) !== fmtInstrumentPx(exitPx)) return undefined;
  const d = Math.abs(exitPx - entryPx);
  if (d < 1e-12) return undefined;
  const q = qty != null && Number.isFinite(qty) && qty > 0 ? qty : 0;
  const moveUsd = d * q;
  if (!(moveUsd > 1e-8)) return undefined;
  return [
    "Displayed entry/exit use limited precision — raw average fills can differ slightly.",
    `Raw entry: ${String(entryPx)}`,
    `Raw exit:  ${String(exitPx)}`,
    `|Δ|×qty ≈ ${moveUsd.toFixed(4)} USDT (same order as gross price PnL from Binance REALIZED_PNL).`,
  ].join("\n");
}

/** Tooltip for CLOSE Net when Binance income-backed — avoids confusion vs exchange “PnL” UIs. */
function tradeHistoryCloseNetColumnTitle(t: any): string | undefined {
  if (String(t?.type ?? "").toUpperCase() !== "CLOSE") return undefined;
  const m = t?.meta || {};
  if (String(m.source ?? "") !== "fapi_income") return undefined;
  return [
    "Binance REALIZED_PNL (≈ Gross here) excludes commissions; COMMISSION income rows are separate.",
    "Net column ≈ REALIZED_PNL − exit Fee shown — can be ~$0 when price PnL and exit commission are similar.",
    "Open-leg commission hit the wallet when the position opened (see the OPEN row). Binance ROI% often uses gross / margin, not this net cell.",
  ].join("\n");
}

/** Fee cell hover — shows funding/commission split when the backend attributed any FUNDING
 *  income to this CLOSE. Funding is absorbed into fee as `fee += -fundingIncome`, so a
 *  negative `fundingFeeUsd` means the trader paid funding (cost added to fee).
 */
function tradeHistoryFeeCellTitle(t: any, feeDisp: number | null): string | undefined {
  const rowTyp = String(t?.type ?? "").toUpperCase();
  if (rowTyp !== "CLOSE") return undefined;
  const m = t?.meta || {};
  const funding = Number(m.fundingFeeUsd);
  if (!Number.isFinite(funding) || funding === 0) return undefined;
  const fee = feeDisp != null && Number.isFinite(feeDisp) ? feeDisp : null;
  const commission = fee != null ? fee - -funding : null;
  const fmt = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(6)} USDT`;
  const lines = [
    funding < 0
      ? `Funding paid: ${fmt(-funding)} (added to Fee)`
      : `Funding received: ${fmt(funding)} (subtracted from Fee)`,
  ];
  if (commission != null) lines.unshift(`Commission: ${fmt(commission)}`);
  return lines.join("\n");
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
  const p = Number(m.trailStepAtClose);
  const c = Number(m.confirmedTrailStepAtClose);
  const step = Math.max(Number.isFinite(p) ? p : 0, Number.isFinite(c) ? c : 0);
  return (
    m.exitViaTrailedStop === true ||
    (step > 0 && String(m.bracketType || "").toUpperCase() === "SL")
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

/** P&L if stop fills at the current SL price (gross, before exit fees). Negative ⇒ max loss locked; positive ⇒ min profit locked. */
function lockedPnlUsdAtCurrentStop(p: any): number | null {
  if (String(p?.venue || "").toUpperCase() !== "FUTURES") return null;
  const e = numFinite(p.entryPrice);
  const sl = numFinite(p.stopLoss);
  const qRaw = numFinite(p.qty);
  const q = qRaw != null ? Math.abs(qRaw) : 0;
  if (e == null || sl == null || !(q > 0) || e <= 0) return null;
  const isLong = positionIsLong(p?.side, p?.qty ?? p?.positionAmt);
  if (isLong) return (sl - e) * q;
  return (e - sl) * q;
}

function fmtPnlPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(2)}%`;
}

function tradeRowStatus(t: any): "OPEN" | "CLOSED" {
  const st = String(t?.status ?? "").toUpperCase();
  if (st === "CLOSED") return "CLOSED";
  return String(t?.type ?? "").toUpperCase() === "CLOSE" ? "CLOSED" : "OPEN";
}

/** Entry slippage % (adverse = positive). Uses stored bps or signal vs fill. */
function positionEntrySlipPct(p: any): number | null {
  const meta = (p?.meta ?? {}) as Record<string, unknown>;
  const bps = numFinite(meta.adverseBps);
  if (bps != null) return bps / 100;
  const signalPx = numFinite(meta.signalBarClose ?? meta.signalBarCloseForEntry);
  const fillPx = numFinite(p?.entryPrice ?? p?.price);
  if (signalPx == null || fillPx == null || signalPx <= 0) return null;
  const isLong = positionIsLong(p?.side, p?.qty ?? p?.positionAmt);
  return isLong ? ((fillPx - signalPx) / signalPx) * 100 : ((signalPx - fillPx) / signalPx) * 100;
}

function fmtSlipPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;
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
  bot?: any,
): number | null {
  const pos = positionRowMatchingOpenTrade(t, positions);
  if (t?.type === "OPEN" && pos) return positionUnrealizedPnlPct(pos);
  if (t?.type === "CLOSE") {
    const stored = tradeNetPnlClose(t);
    let net: number | null = null;
    if (stored != null && Number.isFinite(stored)) {
      const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
      const openR = tradeHistoryOpenFeeRateForRow(bot, openRef ?? t);
      const closeR = tradeHistoryCloseFeeRateForRow(bot, t);
      const exitFee = tradeCloseLegFeeUsd(t, openRef, qty, price, openR, closeR);
      const openFeeAmt =
        openRef != null
          ? tradeOpenLegFeeUsd(
              openRef,
              numFinite(openRef.qty ?? qty),
              numFinite(openRef.price ?? openRef.meta?.entryPx ?? price),
              tradeHistoryOpenFeeRateForRow(bot, openRef),
              t,
            )
          : null;
      net = closeDisplayedNetFromStored(t, stored, openRef, openFeeAmt, Boolean(openRef), exitFee);
    }
    if (net == null || !Number.isFinite(net)) net = closeTradeNetUsd(t, openRef, bot);
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

/** Align with backend `CLOSE_REASON_FILL_BAND` — exit vs bracket SL tolerance. */
const CLOSE_SL_TRAIL_DISPLAY_BAND = 0.0035;

function isTrailedCloseRowForSlDisplay(t: any): boolean {
  if (String(t?.type ?? "").toUpperCase() !== "CLOSE") return false;
  const m = t?.meta || {};
  const r = String(t?.reason || "").toUpperCase();
  if (m.exitViaTrailedStop === true) return true;
  if (m.trailTierAtClose != null && String(m.trailTierAtClose).trim() !== "") return true;
  if (r.includes("TRAILED_SUPERTREND") || r.includes("TRAILED_STOP_LOSS")) return true;
  return false;
}

/**
 * OPEN rows use initial Supertrend SL on `fut_<SYM>` legs; CLOSE merges often copy that into `stopLoss`.
 * Trailed exits still show the correct reason/tier, but SL was the default bracket — prefer explicit
 * `meta.slAtClose` when present, else exit fill when it is far from the stored (initial) SL.
 */
function closeRowDisplayStopLossPx(t: any, openRef: any | undefined, slResolved: number | null | undefined): number | undefined {
  const m = t?.meta || {};
  const explicit =
    numFinite(m.slAtClose) ?? numFinite(m.effectiveStopLoss) ?? numFinite(m.trailStopAtClose);
  if (explicit != null) return explicit;

  if (!isTrailedCloseRowForSlDisplay(t)) {
    return slResolved ?? undefined;
  }

  const exitPx = numFinite(t?.price ?? m.exitAvgFillPrice ?? m.exitPrice ?? m.closePrice);
  if (exitPx == null || !(exitPx > 0)) return slResolved ?? undefined;

  const sl0 = slResolved;
  if (sl0 == null || !(sl0 > 0)) return exitPx;

  const band = Math.abs(exitPx - sl0) / sl0;
  if (band > CLOSE_SL_TRAIL_DISPLAY_BAND) return exitPx;
  return sl0;
}

/** CLOSE rows often omit fields; fill from matching OPEN (same id) and common aliases. */
function tradeHistoryDisplayFields(t: any, openRef: any | undefined, bot?: any) {
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
  const mClose = t?.meta || {};
  const grossHint = numFinite(t?.grossPnl ?? mClose.grossPnl);
  /** Infer exit from price move: use gross when possible — net PnL wrongly implied profitable “default SL” exits. */
  let moveUsdForPx: number | undefined = pnlHint;
  if (t?.type === "CLOSE" && pnlHint != null) {
    if (grossHint != null) moveUsdForPx = grossHint;
    else {
      const feeRt =
        tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot) ??
        tradeFeeUsdForCloseRow(t, qty, price, bot);
      if (feeRt != null && feeRt > 0) moveUsdForPx = pnlHint + feeRt;
    }
  }
  // Exit price hint: linear unwind from entry when only PnL + qty known (spot-style; futures approx for display).
  if (
    (price == null || price <= 0) &&
    entryHint != null &&
    entryHint > 0 &&
    qty != null &&
    qty > 0 &&
    moveUsdForPx != null &&
    t?.type === "CLOSE"
  ) {
    const sx = String(t?.side ?? "").toUpperCase();
    if (sx === "SELL" || sx === "BUY") {
      const dir = sx === "SELL" ? 1 : -1;
      const est = entryHint + (dir * moveUsdForPx) / qty;
      if (Number.isFinite(est) && est > 0) price = est;
    }
  }
  let sl = numFinite(
    t?.stopLoss ??
      t?.meta?.stopLoss ??
      t?.meta?.sl ??
      openRef?.stopLoss ??
      openRef?.meta?.stopLoss,
  );
  if (String(t?.type ?? "").toUpperCase() === "CLOSE") {
    const slAdj = closeRowDisplayStopLossPx(t, openRef, sl ?? null);
    if (slAdj != null) sl = slAdj;
  }
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

/** One-way position side at open (BUY=long, SELL=short) from reduce-only close order side. */
function openPositionSideFromCloseSide(closeSide: string | null | undefined): "BUY" | "SELL" | null {
  const c = String(closeSide || "").toUpperCase();
  if (c === "BUY") return "SELL";
  if (c === "SELL") return "BUY";
  return null;
}

function resolveCloseSideForConsistency(t: any, openRef: any | undefined): "BUY" | "SELL" | null {
  const m = t?.meta || {};
  const cs = String(m.closeSide ?? "").toUpperCase();
  if (cs === "BUY" || cs === "SELL") return cs;
  const fromOpen = closeOrderSideFromOpenLeg(openRef);
  if (fromOpen === "BUY" || fromOpen === "SELL") return fromOpen;
  const row = String(t?.side ?? "").toUpperCase();
  if (row === "BUY" || row === "SELL") return row;
  return null;
}

function resolveOpenPositionSideForConsistency(t: any, openRef: any | undefined): "BUY" | "SELL" | null {
  const os0 = String(openRef?.side ?? "").toUpperCase();
  if (os0 === "BUY" || os0 === "SELL") return os0;
  const m = t?.meta || {};
  const ps = String(m.positionSideAtOpen ?? m.positionSideAtClose ?? "").toUpperCase();
  if (ps === "LONG") return "BUY";
  if (ps === "SHORT") return "SELL";
  if (ps === "BUY" || ps === "SELL") return ps;
  return null;
}

/**
 * Detects OPEN↔CLOSE linkage mismatches (wrong OPEN for symbol, or stored gross vs price–qty move).
 * Shown as ⚠ on the symbol cell and in tooltips.
 */
function tradeCloseConsistencyWarnings(t: any, openRef: any | undefined, bot?: any): string[] {
  if (String(t?.type ?? "").toUpperCase() !== "CLOSE") return [];
  const warnings: string[] = [];
  const closeSide = resolveCloseSideForConsistency(t, openRef);
  const inferredOpen = openPositionSideFromCloseSide(closeSide);
  const openFromRef = resolveOpenPositionSideForConsistency(t, openRef);

  if (closeSide && inferredOpen && openFromRef && inferredOpen !== openFromRef) {
    if (openRef) {
      warnings.push(
        `Close order is ${closeSide} (implies ${inferredOpen === "BUY" ? "long" : "short"} at open) but matched OPEN leg is ${openFromRef === "BUY" ? "BUY (long)" : "SELL (short)"} — possible wrong OPEN for this CLOSE.`,
      );
    } else {
      warnings.push(
        `Close order is ${closeSide} (implies ${inferredOpen === "BUY" ? "long" : "short"}) but meta.positionSideAtOpen is ${openFromRef === "BUY" ? "BUY" : "SELL"} — inconsistent hints.`,
      );
    }
  }

  if (!openRef && String(t?.symbol ?? "").trim() !== "") {
    warnings.push(
      `No OPEN trade found before this CLOSE for this symbol — entry and leg checks are approximate.`,
    );
  }

  const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
  const implied = inferCloseGrossFromPrices(t, openRef, qty, price);
  const m = t?.meta || {};
  let stored: number | null = null;
  if (t?.grossPnl != null && Number.isFinite(Number(t.grossPnl))) stored = Number(t.grossPnl);
  else if (m.grossPnl != null && Number.isFinite(Number(m.grossPnl))) stored = Number(m.grossPnl);
  else {
    const net = Number(t?.pnl ?? m.pnl ?? m.realizedPnl);
    if (Number.isFinite(net)) {
      const fee =
        tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot) ??
        tradeFeeUsdForCloseRow(t, qty, price, bot);
      stored = fee != null && fee > 0 ? net + fee : net;
    }
  }
  if (implied != null && stored != null && Number.isFinite(implied) && Number.isFinite(stored)) {
    const a = Math.abs(implied);
    const b = Math.abs(stored);
    if (a > 1e-7 && b > 1e-7) {
      if (Math.sign(implied) !== Math.sign(stored)) {
        warnings.push(
          `Stored gross (${stored.toFixed(4)} USDT) vs entry/exit/qty move (${implied.toFixed(4)} USDT) have opposite signs — OPEN row may not belong to this CLOSE.`,
        );
      } else {
        const denom = Math.max(a, b);
        if (denom > 0 && Math.abs(implied - stored) / denom > 0.5) {
          warnings.push(
            `Stored gross vs price-implied gross differ by >50% — verify qty, fill price, and OPEN link.`,
          );
        }
      }
    }
  }

  const eClose = numFinite(t?.entryPrice ?? m.entryPrice);
  const eOpen = numFinite(openRef?.price ?? openRef?.entryPrice ?? openRef?.meta?.entryPx);
  if (eClose != null && eOpen != null && eOpen > 0 && openRef) {
    const rel = Math.abs(eClose - eOpen) / eOpen;
    if (rel > 0.015) {
      warnings.push(
        `CLOSE entry (${eClose}) vs matched OPEN entry (${eOpen}) differ by ${(rel * 100).toFixed(2)}% — possible wrong round-trip.`,
      );
    }
  }

  return warnings;
}

/** OPEN leg with no later CLOSE in history while the snapshot shows flat — ledger / merge gap. */
function tradeOpenMissingCloseWarnings(
  openRow: any,
  allTrades: any[],
  positions: any[] | undefined,
  isFuturesVenue: boolean,
): string[] {
  if (!isFuturesVenue || String(openRow?.type ?? "").toUpperCase() !== "OPEN") return [];
  const warnings: string[] = [];
  const symU = String(openRow?.symbol ?? "").toUpperCase().trim();
  if (!symU) return warnings;
  const openMs = tradeTsMs(openRow);
  let hasLaterClose = false;
  if (Number.isFinite(openMs)) {
    for (const x of allTrades) {
      if (String(x?.type ?? "").toUpperCase() !== "CLOSE") continue;
      if (String(x?.symbol ?? "").toUpperCase() !== symU) continue;
      const cm = tradeTsMs(x);
      if (Number.isFinite(cm) && cm >= openMs - 750) {
        hasLaterClose = true;
        break;
      }
    }
  }
  let posOpen = false;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      if (String(p?.venue ?? "").toUpperCase() !== "FUTURES") continue;
      const psym = String(p?.symbol ?? p?.sym ?? "").toUpperCase().trim();
      if (!psym || psym !== symU) continue;
      const q = Number(p?.qty ?? p?.positionAmt ?? p?.positionQty ?? p?.contracts ?? p?.amt ?? 0);
      if (Math.abs(q) > 1e-10) {
        posOpen = true;
        break;
      }
    }
  }
  if (!hasLaterClose && !posOpen) {
    warnings.push(
      "No CLOSE row appears after this OPEN while the snapshot shows no open futures position — fees and realized PnL may be incomplete until ledger sync catches up.",
    );
  }
  return warnings;
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
      ? `Order #: ${s}\nClient order id: ${String(cid)}`
      : `Order #: ${s}`;
  return { label: shortenBinanceId(s, 18), title };
}

/** Exchange execution style for this row (USD-M); unknown leaves "—". */
function tradeHistoryExchangeOrderKindLabel(t: any): string {
  const m = (t?.meta ?? {}) as Record<string, unknown>;
  const leg = String(t?.type ?? "").toUpperCase();
  if (leg === "OPEN") {
    const style = String(m.entryOrderStyle ?? "").toUpperCase();
    if (style === "LIMIT_IOC") return "Limit IOC";
    if (style === "MARKET") return "Market";
    const bt = String(m.entryBinanceOrderType ?? m.orderType ?? "").toUpperCase();
    const tif = String(m.entryTimeInForce ?? "").toUpperCase();
    if (bt === "MARKET") return "Market";
    if (bt === "LIMIT") {
      if (tif === "IOC") return "Limit IOC";
      if (tif === "FOK") return "Limit FOK";
      if (tif === "GTC") return "Limit GTC";
      return "Limit";
    }
    return "—";
  }
  if (leg === "CLOSE") {
    const bt = String(m.closeBinanceOrderType ?? m.exitOrderType ?? m.orderType ?? "").toUpperCase();
    const tif = String(m.closeTimeInForce ?? "").toUpperCase();
    if (bt === "MARKET") return "Market";
    if (bt === "LIMIT") {
      if (tif === "IOC") return "Limit IOC";
      if (tif === "FOK") return "Limit FOK";
      if (tif === "GTC") return "Limit GTC";
      return "Limit";
    }
    return "—";
  }
  return "—";
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
        ? `Order #: ${o}\nClient order id: ${String(cid)}`
        : `Order #: ${o}`;
    return { label: shortenBinanceId(o, 18), title };
  }
  if (typ === "CLOSE") {
    const tr = tranId != null ? String(tranId).trim() : "";
    const o = orderId != null ? String(orderId).trim() : "";
    if (tr) {
      const parts = [`Income tran id: ${tr}`];
      if (o) parts.unshift(`Order id: ${o}`);
      if (cid != null && String(cid).trim() !== "") parts.push(`Client order id: ${String(cid)}`);
      return { label: shortenBinanceId(tr, 18), title: parts.join("\n") };
    }
    if (o) {
      const title =
        cid != null && String(cid).trim() !== ""
          ? `Order #: ${o}\nClient order id: ${String(cid)}`
          : `Order #: ${o}`;
      return { label: shortenBinanceId(o, 18), title };
    }
  }
  return { label: "—", title: t?.id != null ? `App id: ${t.id}` : "" };
}

/** Same rule as backend `trailTierStepForCloseAudit` — UI tier text tracks exchange-acked trail only. */
function trailTierStepForCloseAudit(pendingRaw: unknown, confirmedRaw: unknown): number {
  const pending = Math.max(0, Math.floor(Number(pendingRaw) || 0));
  const confirmed = Math.max(0, Math.floor(Number(confirmedRaw) || 0));
  if (confirmed > 0) return Math.min(pending || confirmed, confirmed);
  return 0;
}

function trailTierLabelForAuditStep(step: number, labelStyle: string): string | null {
  const s = Math.floor(Number(step) || 0);
  if (s < 1) return null;
  const ls = String(labelStyle || "classic");
  if (ls === "tiered_st_fee_entry") {
    if (s === 1) return "T01";
    if (s === 2) return "T02";
    return `T${s - 2}`;
  }
  return `T${s - 1}`;
}

/** CLOSE rows: raw audit fields for tooltips (reason vs trail vs income id). */
function tradeCloseAuditTooltipTitle(t: any): string {
  if (String(t?.type || "").toUpperCase() !== "CLOSE") return "";
  const m = (t?.meta || {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (t?.reason != null && String(t.reason).trim() !== "") lines.push(`reason: ${String(t.reason)}`);
  if (m.closeReason != null && String(m.closeReason).trim() !== "")
    lines.push(`meta.closeReason: ${String(m.closeReason)}`);
  if (m.bracketType != null && String(m.bracketType).trim() !== "")
    lines.push(`bracketType: ${String(m.bracketType)}`);
  if (m.source != null && String(m.source).trim() !== "") lines.push(`meta.source: ${String(m.source)}`);
  if (m.closeSide != null && String(m.closeSide).trim() !== "") lines.push(`closeSide: ${String(m.closeSide)}`);
  if (m.positionSideAtOpen != null && String(m.positionSideAtOpen).trim() !== "")
    lines.push(`positionSideAtOpen: ${String(m.positionSideAtOpen)}`);
  if (m.openRefId != null && String(m.openRefId).trim() !== "")
    lines.push(`openRefId (OPEN leg): ${String(m.openRefId)}`);
  if (m.openPositionId != null && String(m.openPositionId).trim() !== "")
    lines.push(`openPositionId: ${String(m.openPositionId)}`);
  if (m.trailStepAtClose != null && String(m.trailStepAtClose) !== "")
    lines.push(`trailStepAtClose (pending): ${String(m.trailStepAtClose)}`);
  if (m.confirmedTrailStepAtClose != null && String(m.confirmedTrailStepAtClose) !== "")
    lines.push(`confirmedTrailStepAtClose: ${String(m.confirmedTrailStepAtClose)}`);
  if (m.exitViaTrailedStop != null) lines.push(`exitViaTrailedStop: ${String(m.exitViaTrailedStop)}`);
  if (m.trailTierAtClose != null && String(m.trailTierAtClose).trim() !== "")
    lines.push(`trailTierAtClose (stored): ${String(m.trailTierAtClose)}`);
  if (m.trailingMode != null && String(m.trailingMode).trim() !== "")
    lines.push(`trailingMode: ${String(m.trailingMode)}`);
  const tid =
    m.tranId ?? (Array.isArray(m.tranIds) && m.tranIds.length ? m.tranIds[m.tranIds.length - 1] : null);
  if (tid != null && String(tid).trim() !== "") lines.push(`income tranId: ${String(tid)}`);
  const audit = trailTierStepForCloseAudit(m.trailStepAtClose, m.confirmedTrailStepAtClose);
  lines.push(`tierStepAudit (for label): ${audit}`);
  return lines.join("\n");
}

function tradeHistoryRowKey(t: any, idx: number): string {
  return `${String(t?.type ?? "")}|${String(t?.id ?? "")}|${tradeTsMs(t)}|${idx}`;
}

/** Stacked OPEN (O) / CLOSE (C) lines inside one table cell — round-trip view. */
function TradeHistoryRtCell({
  openLine,
  closeLine,
  mono,
}: {
  openLine: ReactNode;
  closeLine: string;
  mono?: boolean;
}) {
  const inner = mono ? "font-mono text-slate-600 dark:text-slate-400" : "text-slate-700 dark:text-slate-300";
  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <div className="text-[9px]">
        <span className="mr-1 font-semibold text-slate-500 dark:text-slate-500">O</span>
        <span className={inner}>{openLine}</span>
      </div>
      <div className="text-[9px]">
        <span className="mr-1 font-semibold text-slate-500 dark:text-slate-500">C</span>
        <span className={mono ? inner : "text-slate-700 dark:text-slate-300"}>{closeLine}</span>
      </div>
    </div>
  );
}

function tradeHistoryRoundTripRowKey(closeRow: any, openRow: any | undefined, idx: number): string {
  return `RT|${String(closeRow?.id ?? "")}|${String(openRow?.id ?? "")}|${tradeTsMs(closeRow)}|${idx}`;
}

/** Expanded accordion panel under a trade history row (audit, leg check, raw fields). */
function TradeHistoryExpandedDetails({
  t,
  openRef,
  qty,
  price,
  gross,
  legWarnings,
  binRefTitle,
}: {
  t: any;
  openRef: any | undefined;
  qty: number | undefined;
  price: number | undefined;
  gross: number | null;
  legWarnings: string[];
  binRefTitle: string;
}) {
  const isClose = String(t?.type ?? "").toUpperCase() === "CLOSE";
  const audit = isClose ? tradeCloseAuditTooltipTitle(t) : "";
  const implied = isClose ? inferCloseGrossFromPrices(t, openRef, qty, price) : null;
  const m = t?.meta || {};
  return (
    <div className="space-y-3 border-t border-slate-200 bg-slate-50/95 px-4 py-3 text-left dark:border-slate-800 dark:bg-slate-950/90">
      {legWarnings.length > 0 ? (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
            Leg check
          </div>
          <ul className="list-disc space-y-1.5 pl-4 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
            {legWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {isClose && audit ? (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Close audit
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white/80 p-2 font-mono text-[10px] text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
            {audit}
          </pre>
        </div>
      ) : null}
      {isClose && implied != null && Number.isFinite(implied) && gross != null && Number.isFinite(gross) ? (
        <div className="text-[11px] text-slate-700 dark:text-slate-300">
          <span className="font-semibold text-slate-600 dark:text-slate-400">Gross vs entry/exit/qty: </span>
          implied {implied.toFixed(4)} USDT · stored {gross.toFixed(4)} USDT
          {Math.abs(implied - gross) > 0.01 && Math.max(Math.abs(implied), Math.abs(gross)) > 0
            ? ` · Δ ${(implied - gross).toFixed(4)}`
            : null}
        </div>
      ) : null}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
          Record
        </div>
        <dl className="grid max-w-2xl grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-[11px] text-slate-700 dark:text-slate-300">
          <dt className="text-slate-500 dark:text-slate-500">App id</dt>
          <dd className="break-all font-mono">{t?.id != null ? String(t.id) : "—"}</dd>
          <dt className="text-slate-500 dark:text-slate-500">Order / income</dt>
          <dd className="break-all font-mono" title={binRefTitle || undefined}>
            {binRefTitle || "—"}
          </dd>
          {t?.reason != null && String(t.reason).trim() !== "" ? (
            <>
              <dt className="text-slate-500 dark:text-slate-500">reason</dt>
              <dd className="break-all font-mono">{String(t.reason)}</dd>
            </>
          ) : null}
          {m.closeReason != null && String(m.closeReason).trim() !== "" ? (
            <>
              <dt className="text-slate-500 dark:text-slate-500">meta.closeReason</dt>
              <dd className="break-all font-mono">{String(m.closeReason)}</dd>
            </>
          ) : null}
          {m.bracketType != null && String(m.bracketType).trim() !== "" ? (
            <>
              <dt className="text-slate-500 dark:text-slate-500">bracketType</dt>
              <dd>{String(m.bracketType)}</dd>
            </>
          ) : null}
          {t?.strategy != null && String(t.strategy).trim() !== "" ? (
            <>
              <dt className="text-slate-500 dark:text-slate-500">strategy</dt>
              <dd>{String(t.strategy)}</dd>
            </>
          ) : null}
          {m.openRefId != null && String(m.openRefId).trim() !== "" ? (
            <>
              <dt className="text-slate-500 dark:text-slate-500">openRefId</dt>
              <dd className="break-all font-mono">{String(m.openRefId)}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <p className="text-[10px] text-slate-500 dark:text-slate-500">
        Click the row again to collapse. Net / gross from the server are authoritative when they disagree with implied
        math from displayed fields.
      </p>
    </div>
  );
}

/** Round-trip rows: OPEN + CLOSE stacked per column; Net shows trip total (sorted by close time — parent list). */
function TradeHistoryRoundTripRows({
  pairs,
  portfolioTrades,
  bot,
  positions,
  trailingStopLossAuto,
  isFuturesVenue,
  tradeHistoryExpandedKey,
  setTradeHistoryExpandedKey,
  historyRangeFilter,
}: {
  pairs: { close: any; open: any | undefined }[];
  portfolioTrades: any[];
  bot: any;
  positions: readonly any[];
  trailingStopLossAuto: boolean;
  isFuturesVenue: boolean;
  tradeHistoryExpandedKey: string | null;
  setTradeHistoryExpandedKey: Dispatch<SetStateAction<string | null>>;
  historyRangeFilter: HistoryRangeFilter;
}) {
  const rows = portfolioTrades || [];
  return (
    <>
      {pairs.map(({ close: c, open: o }, idx) => {
        const openInViewRt = Boolean(o);
        const dispO = o ? tradeHistoryDisplayFields(o, undefined, bot) : null;
        const dispC = tradeHistoryDisplayFields(c, o, bot);
        const entryPxMerge =
          numFinite(
            c?.entryPrice ?? c?.meta?.entryPrice ?? o?.entryPrice ?? o?.price ?? o?.meta?.entryPx,
          ) ?? null;
        let openFee: number | null = null;
        let openNet: number | null = null;
        let grossC: number | null = null;
        let netC: number | null = null;
        let feeC: number | null = null;
        const openRo = o ? tradeHistoryOpenFeeRateForRow(bot, o) : tradeHistoryOpenFeeRateForRow(bot, c);
        const closeR = tradeHistoryCloseFeeRateForRow(bot, c);
        const priceC = dispC.price;
        const qtyC = dispC.qty;
        const levC = dispC.lev;
        const slC = dispC.sl;
        const tpC = dispC.tp;
        if (o) {
          const qtyO = dispO!.qty;
          const priceO = dispO!.price;
          const entryPxO = numFinite(o.entryPrice ?? o.meta?.entryPrice ?? o.price ?? o.meta?.entryPx) ?? null;
          openFee = tradeOpenLegFeeUsd(o, qtyO, priceO ?? entryPxO, openRo, c);
          openNet = openFee != null ? -openFee : null;
        }
        feeC = tradeCloseLegFeeUsd(c, o, qtyC, priceC, openRo, closeR);
        const storedCloseNet = tradeNetPnlClose(c);
        const openFeeAmt =
          o != null
            ? tradeOpenLegFeeUsd(
                o,
                numFinite(o.qty ?? qtyC),
                numFinite(o.price ?? o.meta?.entryPx ?? entryPxMerge),
                tradeHistoryOpenFeeRateForRow(bot, o),
                c,
              )
            : null;
        if (storedCloseNet != null && Number.isFinite(storedCloseNet)) {
          netC = closeDisplayedNetFromStored(c, storedCloseNet, o, openFeeAmt, openInViewRt, feeC);
        } else {
          const g0 = tradeGrossPnlClose(c, qtyC, priceC, o, bot);
          netC = g0 != null && feeC != null ? g0 - feeC : tradeNetPnlClose(c);
        }
        grossC =
          netC != null && feeC != null ? netC + feeC : tradeGrossPnlClose(c, qtyC, priceC, o, bot);
        const tripNet = tradeHistoryRoundTripNetUsd(c, o, bot);
        const entryPxO = o ? numFinite(o.entryPrice ?? o.meta?.entryPrice ?? o.price ?? o.meta?.entryPx) ?? null : null;
        const exitTxtO =
          o && dispO!.price != null && dispO!.price > 0 ? fmtInstrumentPx(dispO!.price) : o ? "n/a" : "—";
        const exitTxtC = priceC != null && priceC > 0 ? fmtInstrumentPx(priceC) : "n/a";
        const qtyTxtO = o && dispO!.qty != null && dispO!.qty > 0 ? dispO!.qty.toFixed(6) : "—";
        const qtyTxtC = qtyC != null && qtyC > 0 ? qtyC.toFixed(6) : "n/a";
        const levTxtO = o && dispO!.lev != null && dispO!.lev > 0 ? `${dispO!.lev}x` : "—";
        const levTxtC = levC != null && levC > 0 ? `${levC}x` : "n/a";
        const marginTxtO = o
          ? tradeInitialMarginUsd(o, undefined, {
              price: dispO!.price,
              qty: dispO!.qty,
              lev: dispO!.lev,
            })
          : "—";
        const marginTxtC = tradeInitialMarginUsd(c, o, { price: priceC, qty: qtyC, lev: levC });
        const slTpO = o
          ? `${dispO!.sl != null && Number.isFinite(dispO!.sl) ? fmtInstrumentPx(dispO!.sl) : "n/a"} / ${dispO!.tp != null && Number.isFinite(dispO!.tp) ? fmtInstrumentPx(dispO!.tp) : "n/a"}`
          : "—";
        const slTpC = `${slC != null && Number.isFinite(slC) ? fmtInstrumentPx(slC) : "n/a"} / ${tpC != null && Number.isFinite(tpC) ? fmtInstrumentPx(tpC) : "n/a"}`;
        const sideDispO = o ? (o.side != null ? String(o.side) : "n/a") : "—";
        const sideDispC =
          c?.meta?.closeSide != null
            ? String(c.meta.closeSide)
            : closeOrderSideFromOpenLeg(o) ?? (c.side != null ? String(c.side) : null) ?? "n/a";
        const pnlPctO = o
          ? tradeHistoryPnlPct(o, undefined, positions, { price: dispO!.price, qty: dispO!.qty, lev: dispO!.lev }, bot)
          : null;
        const pnlPctC = tradeHistoryPnlPct(c, o, positions, { price: priceC, qty: qtyC, lev: levC }, bot);
        const tripMarginN = tradeInitialMarginUsdNumber(c, o, { price: priceC, qty: qtyC, lev: levC });
        const tripPct =
          tripMarginN != null &&
          tripMarginN > 0 &&
          Number.isFinite(tripNet)
            ? (tripNet / tripMarginN) * 100
            : tradeHistoryPnlPct(c, o, positions, { price: priceC, qty: qtyC, lev: levC }, bot);
        const binRefO = o ? portfolioBinanceRefForTradeRow(o) : { label: "—", title: "" };
        const binRefC = portfolioBinanceRefForTradeRow(c);
        const trailLeadRt = Boolean(o && openTradeRowTrailedStrict(o, positions, trailingStopLossAuto));
        const beLeadRt = Boolean(
          o && !trailLeadRt && openTradeRowBreakevenStopIndicator(o, positions, trailingStopLossAuto),
        );
        const closeTrailRt = closeTradeRowTrailedStrict(c);
        const rowKeyRt = tradeHistoryRoundTripRowKey(c, o, idx);
        const expandedRt = tradeHistoryExpandedKey === rowKeyRt;
        const toggleRt = () => setTradeHistoryExpandedKey((k) => (k === rowKeyRt ? null : rowKeyRt));
        const entryFmtO = entryPxO != null && entryPxO > 0 ? fmtInstrumentPx(entryPxO) : o ? "n/a" : "—";
        const entryFmtC = entryPxMerge != null && entryPxMerge > 0 ? fmtInstrumentPx(entryPxMerge) : "n/a";
        const pendingRecRow = !roundTripOpenLegInHistoryWindow(o, historyRangeFilter);
        const tsTitle = `${pendingRecRow ? "OPEN leg outside selected time filter or missing — excluded from attributed window PnL.\n" : ""}${o ? `${fmtTimestampFull(tradeTsMs(o))}\n` : ""}${fmtTimestampFull(tradeTsMs(c))}`;
        const sym = c.symbol ?? "n/a";

        return (
          <Fragment key={rowKeyRt}>
            <tr
              role="button"
              tabIndex={0}
              aria-expanded={expandedRt}
              aria-label={`Round trip ${sym}: ${expandedRt ? "collapse" : "expand"} details`}
              onClick={toggleRt}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRt();
                }
              }}
              title={pendingRecRow ? "CLOSE in range; OPEN missing or outside range — counted in pending reconciliation, not headline PnL." : undefined}
              className={`border-t border-slate-200 dark:border-slate-900${
                expandedRt ? " bg-slate-100/60 dark:bg-slate-900/50" : ""
              } cursor-pointer hover:bg-slate-50/90 dark:hover:bg-slate-900/35${
                pendingRecRow ? " border-l-2 border-l-amber-500/70 dark:border-l-amber-500/50" : ""
              }`}
            >
              <td className="w-3 min-w-[12px] max-w-[14px] border-0 px-0 py-2 align-middle">
                {trailLeadRt || closeTrailRt ? <TrailedStopLead /> : beLeadRt ? <BreakevenStopLead /> : null}
              </td>
              <td className="px-3 py-2 text-[10px] tabular-nums text-slate-500 dark:text-slate-400" title={tsTitle}>
                <span className="inline-flex items-start gap-1.5">
                  <span className="mt-0.5 w-3 shrink-0 text-[9px] leading-none text-slate-500 dark:text-slate-500" aria-hidden>
                    {expandedRt ? "▼" : "▶"}
                  </span>
                  <TradeHistoryRtCell openLine={o ? fmtTimestamp(tradeTsMs(o)) : "—"} closeLine={fmtTimestamp(tradeTsMs(c))} />
                </span>
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell
                  openLine={
                    o ? (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        OPEN
                        {findLivePositionForTradeId(positions, o?.id) ? (
                          <span
                            className="inline-flex items-center gap-0.5 rounded bg-emerald-600/20 px-1 py-0.5 text-[8px] font-semibold uppercase text-emerald-600 dark:text-emerald-400"
                            title="Opening leg still matches a live position"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                            Live
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                  closeLine="CLOSE"
                />
              </td>
              <td className="px-3 py-2 text-[10px] text-slate-600 dark:text-slate-400">
                <TradeHistoryRtCell
                  mono
                  openLine={o ? tradeHistoryExchangeOrderKindLabel(o) : "—"}
                  closeLine={tradeHistoryExchangeOrderKindLabel(c)}
                />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{sym}</td>
              <td
                className="max-w-[5.5rem] px-3 py-2 font-mono text-[10px] text-slate-600 dark:text-slate-400"
                title={[binRefO.title, binRefC.title].filter(Boolean).join("\n---\n")}
              >
                <TradeHistoryRtCell mono openLine={binRefO.label} closeLine={binRefC.label} />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell openLine={sideDispO} closeLine={sideDispC} />
              </td>
              <td className="px-3 py-2 text-amber-300/80">
                <TradeHistoryRtCell openLine={levTxtO} closeLine={levTxtC} />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell openLine={entryFmtO} closeLine={entryFmtC} />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell openLine={exitTxtO} closeLine={exitTxtC} />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell mono openLine={qtyTxtO} closeLine={qtyTxtC} />
              </td>
              <td
                className="px-3 py-2 text-slate-700 dark:text-slate-300"
                title="Initial margin ≈ entry×qty / leverage when leverage is known (futures)"
              >
                <TradeHistoryRtCell openLine={marginTxtO} closeLine={marginTxtC} />
              </td>
              <td className="px-3 py-2 text-[10px] text-slate-600 dark:text-slate-400">
                <TradeHistoryRtCell openLine={slTpO} closeLine={slTpC} />
              </td>
              <td className="max-w-[7rem] px-3 py-2 text-[10px] text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell openLine={o ? tradeHistoryReasonLabel(o) : "—"} closeLine={tradeHistoryReasonLabel(c)} />
              </td>
              <td className="px-3 py-2 text-[10px] uppercase text-slate-600 dark:text-slate-500">
                <TradeHistoryRtCell
                  openLine={o ? "strat" : "—"}
                  closeLine={isLedgerClose(c) ? "ledger" : "strat"}
                />
              </td>
              <td
                className={`px-3 py-2 ${grossC != null && grossC >= 0 ? "text-emerald-400" : grossC != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
              >
                <TradeHistoryRtCell openLine="—" closeLine={grossC != null ? fmtUsd(grossC) : "n/a"} />
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                <TradeHistoryRtCell
                  openLine={openFee != null ? fmtUsd(openFee, 4) : "n/a"}
                  closeLine={feeC != null ? fmtUsd(feeC, 4) : "n/a"}
                />
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <TradeHistoryRtCell
                    openLine={openNet != null ? fmtUsd(openNet) : "—"}
                    closeLine={netC != null ? fmtUsd(netC) : "—"}
                  />
                  <div
                    className={`border-t border-slate-300/50 pt-0.5 text-[10px] font-semibold tabular-nums ${
                      tripNet >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    Trip {fmtUsd(tripNet)}
                  </div>
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <TradeHistoryRtCell openLine={fmtPnlPct(pnlPctO)} closeLine={fmtPnlPct(pnlPctC)} />
                  <div
                    className={`border-t border-slate-300/50 pt-0.5 text-[10px] font-semibold tabular-nums ${
                      tripPct != null && tripPct >= 0 ? "text-emerald-400" : tripPct != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"
                    }`}
                  >
                    Trip {fmtPnlPct(tripPct)}
                  </div>
                </div>
              </td>
            </tr>
            {expandedRt ? (
              <tr className="border-t border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-950/30">
                <td colSpan={19} className="p-0">
                  <div className="space-y-2 border-t border-slate-200 bg-slate-50/95 dark:border-slate-800 dark:bg-slate-950/90">
                    {o ? (
                      <TradeHistoryExpandedDetails
                        t={o}
                        openRef={undefined}
                        qty={dispO!.qty}
                        price={dispO!.price}
                        gross={null}
                        legWarnings={tradeOpenMissingCloseWarnings(o, rows, positions, isFuturesVenue)}
                        binRefTitle={binRefO.title}
                      />
                    ) : null}
                    <TradeHistoryExpandedDetails
                      t={c}
                      openRef={o}
                      qty={qtyC}
                      price={priceC}
                      gross={grossC}
                      legWarnings={tradeCloseConsistencyWarnings(c, o, bot)}
                      binRefTitle={binRefC.title}
                    />
                  </div>
                </td>
              </tr>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
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
  const pendingInt = Number.isFinite(trailStepRaw) ? Math.floor(trailStepRaw) : 0;
  const confInt = Number.isFinite(trailConf) ? Math.floor(trailConf) : 0;
  const trailEngagedStep = Math.max(pendingInt, confInt);
  const auditStep = trailTierStepForCloseAudit(pendingInt, confInt);
  const styleHint = String(m.trailStepLabelStyleAtClose || m.trailStepLabelStyle || "classic");
  const metaTierLabel = auditStep > 0 ? trailTierLabelForAuditStep(auditStep, styleHint) : null;
  const trailTierClose: string | null = metaTierLabel;
  const trailedExit =
    m.exitViaTrailedStop === true ||
    (trailEngagedStep > 0 && String(m.bracketType || "").toUpperCase() === "SL");
  const trailMode = String(m.trailingMode || m.trailMode || "").toUpperCase();

  const r0 = String(t?.reason || "").toUpperCase().replace(/-/g, "_");
  /** e.g. TRAILED_STOP_LOSS_T0 / TRAILED_STOP_LOSS_T1 — extract tier label from reason itself. */
  if (r0.startsWith("TRAILED_STOP_LOSS_T")) {
    if (metaTierLabel) return `SL trail ${metaTierLabel}`;
    const tier = r0.replace("TRAILED_STOP_LOSS_", "");
    return `SL trail ${tier}`;
  }
  if (r0.startsWith("TRAILED_SUPERTREND_T")) {
    if (metaTierLabel) return `SL trail ${metaTierLabel}`;
    const tier = r0.replace("TRAILED_SUPERTREND_", "");
    return `SL trail ${tier}`;
  }
  if (r0 === "TRAILED_SUPERTREND") return trailTierClose ? `SL trail ${trailTierClose}` : "Trailed ST";
  if (r0 === "TRAILED_STOP_LOSS") return trailTierClose ? `SL trail ${trailTierClose}` : "Trailed SL";
  if (r0 === "STOP_LOSS_DEFAULT") {
    const tri = trailTierClose;
    if (m.exitViaTrailedStop === true || trailEngagedStep > 0 || (tri != null && String(tri).trim() !== "")) {
      if (tri != null && String(tri).trim() !== "") return `SL trail ${tri}`;
      return trailMode === "SUPERTREND" || trailMode === "" ? "Trailed ST" : "Trailed SL";
    }
    /**
     * "Default SL" must only stick when the actual exit really is near the SL price.
     * When `userTrades` avg fill is available (`exitAvgFillPrice`), require |exit − SL| ≤ 0.25%.
     * Otherwise — especially when `exitInferredFromMark` — fall back to "Exchange" so rows like
     * "entry ≈ exit, reason Default SL" don't keep lying about why the trade ended.
     */
    const exitAvg = Number(m.exitAvgFillPrice ?? m.exitPrice ?? t?.price);
    const slN = Number(t?.stopLoss ?? m.stopLoss);
    if (Number.isFinite(exitAvg) && exitAvg > 0 && Number.isFinite(slN) && slN > 0) {
      const dist = Math.abs(exitAvg - slN) / slN;
      if (dist > 0.0025) return "Exchange";
    } else if (m.exitInferredFromMark === true) {
      return "Exchange";
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
    /** Same sanity as STOP_LOSS_DEFAULT — don't call it "SL" unless the fill really is near the stop. */
    const exitAvg = Number(m.exitAvgFillPrice ?? m.exitPrice ?? t?.price);
    const slN = Number(t?.stopLoss ?? m.stopLoss);
    if (Number.isFinite(exitAvg) && exitAvg > 0 && Number.isFinite(slN) && slN > 0) {
      const dist = Math.abs(exitAvg - slN) / slN;
      if (dist > 0.0025) return "Exchange";
    } else if (m.exitInferredFromMark === true) {
      return "Exchange";
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

  const m = t?.meta || {};
  const tryOpenId = (raw: unknown) => {
    const s = raw != null ? String(raw).trim() : "";
    if (!s) return undefined;
    const hit = byId.get(s);
    return hit?.type === "OPEN" ? hit : undefined;
  };
  const linked =
    tryOpenId(m.openRefId) ??
    tryOpenId(m.openPositionId) ??
    tryOpenId(m.posId);
  if (linked) return linked;

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

/** CLOSE leg that completes this OPEN (prefer explicit OPEN↔CLOSE resolution; else earliest CLOSE after OPEN per symbol). */
function findPairedCloseForOpen(openRow: any, allTrades: any[], openTradeById: Map<string, any>): any | undefined {
  if (!openRow || String(openRow?.type ?? "").toUpperCase() !== "OPEN") return undefined;
  const oid = openRow?.id != null ? String(openRow.id) : "";
  const sym = String(openRow?.symbol ?? "").toUpperCase();
  const openMs = tradeTsMs(openRow);
  if (sym && oid) {
    for (const row of allTrades) {
      if (String(row?.type ?? "").toUpperCase() !== "CLOSE") continue;
      if (String(row?.symbol ?? "").toUpperCase() !== sym) continue;
      const ref = resolveOpenRefForClose(row, allTrades, openTradeById);
      if (ref && String(ref.id) === oid) return row;
    }
  }
  if (!sym || !Number.isFinite(openMs)) return undefined;
  let best: any;
  let bestTs = Infinity;
  for (const row of allTrades) {
    if (String(row?.type ?? "").toUpperCase() !== "CLOSE") continue;
    if (String(row?.symbol ?? "").toUpperCase() !== sym) continue;
    const cm = tradeTsMs(row);
    if (!Number.isFinite(cm) || cm < openMs - 750) continue;
    if (cm < bestTs) {
      bestTs = cm;
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
  bot?: any,
): any[] {
  const out = [...rows];
  const symKey = (t: any) => String(t?.symbol ?? "").toUpperCase();
  const ts = (t: any) => tradeTsMs(t);
  const closeNet = (t: any) => {
    if (t?.type !== "CLOSE") return null;
    const ref = resolveOpenRefForClose(t, allTrades, openTradeById);
    return closeTradeNetUsd(t, ref, bot);
  };
  const closeGross = (t: any) => {
    if (t?.type !== "CLOSE") return null;
    const ref = resolveOpenRefForClose(t, allTrades, openTradeById);
    const { price, qty } = tradeHistoryDisplayFields(t, ref, bot);
    return tradeGrossPnlClose(t, qty, price, ref, bot);
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
  const botRaw = useAppStore((s) => s.bot);
  const bot = useDeferredValue(botRaw);
  const trailingStopLossAuto = bot?.trailingStopLossAuto === true;
  const positions = useAppStore((s) => s.positions) || [];
  const pushLog = useAppStore((s) => s.pushLog);
  const mode = useAppStore((s) => s.mode);
  const mainView = useAppStore((s) => s.mainView);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? []);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const runningByMode = useAppStore((s) => s.runningByMode ?? {});
  const authUiUserTag = useAppStore((s) => s.authUiUserTag ?? null);
  const exchName = useAppStore((s) => s.bot?.exchange?.name) as string | undefined;
  const selectedInstance =
    mainView === "instance" ? instances.find((i: any) => i.id === selectedInstanceId) ?? null : null;
  const modeUpper = String(mode || "PAPER").toUpperCase();
  const mainEngineOn = Boolean((runningByMode as Record<string, boolean>)[modeUpper]);
  const instanceRunning = String(selectedInstance?.status ?? "").toLowerCase() === "running";
  const effectiveInstanceOn = mainEngineOn && instanceRunning;
  const [instanceToggleBusy, setInstanceToggleBusy] = useState(false);

  const strictAccountMissing =
    (mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET") && account === null;
  /** Server merges persisted audit + exchange; show rows even while account snapshot is loading. */
  const portfolioTrades = useMemo(() => {
    const raw = trades || [];
    return mergeTradesByOrderIdAndType(raw);
  }, [trades]);

  const [tradeHistoryView, setTradeHistoryView] = useState<"ALL" | "OPEN_ONLY" | "CLOSED_ONLY">("ALL");
  /** One row per completed round-trip (OPEN+CLOSE), sorted by close time; not used in Open-only. */
  const [tradeHistoryRoundTrip, setTradeHistoryRoundTrip] = useState(false);
  const [tradeHistorySort, setTradeHistorySort] = useState<TradeHistorySort>("RECENT");
  /** Which trade history row is expanded (accordion details). */
  const [tradeHistoryExpandedKey, setTradeHistoryExpandedKey] = useState<string | null>(null);
  const [tradeRefreshing, setTradeRefreshing] = useState(false);
  // Default "Strategy" (APP): futures demo emits many unmatched income shards; hide unless debugging.
  const [closeSourceFilter, setCloseSourceFilter] = useState<"ALL" | "APP" | "LEDGER">("APP");
  /** Drives net realised PnL, winrate, fee rollup, and trade history timestamps. */
  const [pnlHistoryRange, setPnlHistoryRange] = useState<"all" | "custom">("all");
  const [customRangeStart, setCustomRangeStart] = useState("");
  const [customRangeEnd, setCustomRangeEnd] = useState("");
  const skipPortfolioPnlPersist = useRef(true);

  useEffect(() => {
    setTradeHistoryExpandedKey(null);
  }, [
    tradeHistoryView,
    tradeHistorySort,
    tradeHistoryRoundTrip,
    closeSourceFilter,
    pnlHistoryRange,
    customRangeStart,
    customRangeEnd,
  ]);

  useEffect(() => {
    if (tradeHistoryView === "OPEN_ONLY") setTradeHistoryRoundTrip(false);
  }, [tradeHistoryView]);

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

  async function onToggleSelectedInstance() {
    if (!selectedInstance?.id) return;
    if (!instanceRunning && !mainEngineOn) {
      pushLog({ level: "warn", msg: "Turn on the mode bot first, then enable this instance." });
      return;
    }
    setInstanceToggleBusy(true);
    try {
      if (instanceRunning) {
        await api.pauseInstance(selectedInstance.id);
      } else {
        await api.resumeInstance(selectedInstance.id);
      }
      await fetchInstancesForMode(modeSlug);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      pushLog({ level: "error", msg: `Failed to toggle instance: ${detail}` });
    } finally {
      setInstanceToggleBusy(false);
    }
  }

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
      const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
      const g = tradeGrossPnlClose(t, qty, price, openRef, bot);
      const fee = tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot);
      if (g != null && Number.isFinite(g)) stratGross += g;
      if (fee != null && Number.isFinite(fee) && fee > 0) stratFees += fee;
      const netRow = closeTradeNetUsd(t, openRef, bot);
      if (netRow > 0) w += 1;
      else if (netRow < 0) l += 1;
    }
    let ledGross = 0;
    let ledFees = 0;
    for (const t of closeTradesLedgerInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
      const g = tradeGrossPnlClose(t, qty, price, openRef, bot);
      const fee = tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot);
      if (g != null && Number.isFinite(g)) ledGross += g;
      if (fee != null && Number.isFinite(fee) && fee > 0) ledFees += fee;
    }
    return {
      wins: w,
      losses: l,
      netRealizedPnlStrategy: stratGross - stratFees,
      netRealizedPnlLedger: ledGross - ledFees,
    };
  }, [closeTradesAppInRange, closeTradesLedgerInRange, portfolioTrades, openTradeById, bot]);

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
      const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
      const openR = openRef ? tradeHistoryOpenFeeRateForRow(bot, openRef) : clampTradeCloseFeeRate();
      const closeR = tradeHistoryCloseFeeRateForRow(bot, t);
      const cf = tradeCloseLegFeeUsd(t, openRef, qty, price, openR, closeR);
      const of = openRef
        ? tradeOpenLegFeeUsd(
            openRef,
            numFinite(openRef.qty ?? qty),
            numFinite(openRef.price ?? openRef.meta?.entryPx ?? t?.entryPrice),
            openR,
            t,
          )
        : null;
      const rt =
        cf != null && of != null ? cf + of : tradeRoundTripFeeUsdForCloseRow(t, openRef, qty, price, bot);
      if (rt != null && rt > 0) {
        total += rt;
        withFee += 1;
      }
    }
    return { strategyFeeTotal: total, strategyClosesWithFee: withFee };
  }, [closeTradesAppInRange, portfolioTrades, openTradeById, bot]);
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
      const p = closeTradeNetUsd(t, openRef, bot);
      if (isLedgerClose(t)) {
        ledN += 1;
        ledPnl += p;
      } else {
        appN += 1;
        appPnl += p;
      }
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [portfolioTrades, openTradeById, bot]);

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
      appPnl += closeTradeNetUsd(t, openRef, bot);
    }
    for (const t of closeTradesLedgerInRange) {
      const openRef = resolveOpenRefForClose(t, rows, openTradeById);
      ledN += 1;
      ledPnl += closeTradeNetUsd(t, openRef, bot);
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [
    historyRangeFilter,
    closeTradesAppInRange,
    closeTradesLedgerInRange,
    portfolioTrades,
    openTradeById,
    bot,
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
    const rows = (portfolioTrades || []).filter((t: any) => tradeRowStatus(t) === "OPEN");
    return rows.filter((t: any) => openPositionIdTokens.has(String(t?.id ?? "")));
  }, [portfolioTrades, openPositionIdTokens]);

  const closedTrades = useMemo(() => {
    return (portfolioTrades || []).filter((t: any) => tradeRowStatus(t) === "CLOSED");
  }, [portfolioTrades]);

  const displayedTrades = useMemo(() => {
    const rows = portfolioTrades || [];
    const keepClose = (t: any) => {
      if (tradeRowStatus(t) !== "CLOSED") return false;
      const led = isLedgerClose(t);
      if (closeSourceFilter === "APP" && led) return false;
      if (closeSourceFilter === "LEDGER" && !led) return false;
      return true;
    };
    let out: any[];
    if (tradeHistoryView === "OPEN_ONLY") out = openTrades;
    else if (tradeHistoryView === "CLOSED_ONLY") out = closedTrades.filter(keepClose);
    else if (closeSourceFilter === "ALL") out = rows;
    else out = rows.filter((t: any) => (tradeRowStatus(t) === "OPEN" ? true : keepClose(t)));
    const filtered = out.filter((t) => tradeMatchesHistoryTime(t, historyRangeFilter));
    return sortTradeHistoryRows(filtered, tradeHistorySort, rows, openTradeById, bot);
  }, [
    tradeHistoryView,
    openTrades,
    closedTrades,
    portfolioTrades,
    closeSourceFilter,
    historyRangeFilter,
    tradeHistorySort,
    openTradeById,
    bot,
  ]);

  /** CLOSE rows only, merge filter + sort — paired with OPEN for round-trip table. */
  const tradeHistoryRoundTrips = useMemo(() => {
    if (!tradeHistoryRoundTrip || tradeHistoryView === "OPEN_ONLY") return null;
    const rows = portfolioTrades || [];
    const keepClose = (t: any) => {
      if (tradeRowStatus(t) !== "CLOSED") return false;
      const led = isLedgerClose(t);
      if (closeSourceFilter === "APP" && led) return false;
      if (closeSourceFilter === "LEDGER" && !led) return false;
      return true;
    };
    const closes = rows.filter(
      (t: any) => tradeRowStatus(t) === "CLOSED" && keepClose(t) && tradeMatchesHistoryTime(t, historyRangeFilter),
    );
    const sorted = sortTradeHistoryRows(closes, tradeHistorySort, rows, openTradeById, bot);
    return sorted.map((close) => ({
      close,
      open: resolveOpenRefForClose(close, rows, openTradeById) as any,
    }));
  }, [
    tradeHistoryRoundTrip,
    tradeHistoryView,
    portfolioTrades,
    closeSourceFilter,
    historyRangeFilter,
    tradeHistorySort,
    openTradeById,
    bot,
  ]);

  /**
   * Round-trip headline / window accounting: Σ trip net where both OPEN ts and CLOSE ts fall in the filter (attributed).
   * Pending = CLOSE in filter but OPEN missing or OPEN ts outside filter (still listed in the round-trip table; excluded from attributed).
   */
  const tradeHistoryRoundTripWindowBreakdown = useMemo(() => {
    if (!tradeHistoryRoundTrip || tradeHistoryView === "OPEN_ONLY") return null;
    let attributed = 0;
    let pending = 0;
    for (const { close, open } of tradeHistoryRoundTrips ?? []) {
      const n = tradeHistoryRoundTripNetUsd(close, open, bot);
      if (roundTripOpenLegInHistoryWindow(open, historyRangeFilter)) attributed += n;
      else pending += n;
    }
    return { attributed, pending, total: attributed + pending };
  }, [
    tradeHistoryRoundTrip,
    tradeHistoryView,
    tradeHistoryRoundTrips,
    historyRangeFilter,
    bot,
  ]);

  /** OPEN row ids currently visible — used to split CLOSE net only when the opening leg is on-screen. */
  const displayedOpenRowIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of displayedTrades) {
      if (String(r?.type ?? "").toUpperCase() === "OPEN" && r?.id != null) s.add(String(r.id));
    }
    return s;
  }, [displayedTrades]);

  /** Sum of Net column for visible OPEN + CLOSE rows (split OPEN fee vs CLOSE realized when both legs are visible). */
  const netSumDisplayedTradeHistoryRows = useMemo(() => {
    if (tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY") {
      return tradeHistoryRoundTripWindowBreakdown?.attributed ?? 0;
    }
    let s = 0;
    const rows = portfolioTrades || [];
    for (const t of displayedTrades) {
      const openRef = t?.type === "CLOSE" ? resolveOpenRefForClose(t, rows, openTradeById) : undefined;
      const { price, qty } = tradeHistoryDisplayFields(t, openRef, bot);
      const entryPx =
        numFinite(t?.entryPrice ?? t?.meta?.entryPrice ?? openRef?.price ?? openRef?.meta?.entryPx) ?? null;
      const openInView = openRef?.id != null && displayedOpenRowIds.has(String(openRef.id));

      if (String(t?.type ?? "").toUpperCase() === "OPEN") {
        const paired = findPairedCloseForOpen(t, rows, openTradeById);
        const orate = tradeHistoryOpenFeeRateForRow(bot, t);
        const of = tradeOpenLegFeeUsd(t, qty, price ?? entryPx, orate, paired);
        if (of != null) s -= of;
        continue;
      }
      if (String(t?.type ?? "").toUpperCase() === "CLOSE") {
        const sn = tradeNetPnlClose(t);
        const openR = tradeHistoryOpenFeeRateForRow(bot, openRef ?? t);
        const closeR = tradeHistoryCloseFeeRateForRow(bot, t);
        const openFeeAmt =
          openRef != null
            ? tradeOpenLegFeeUsd(
                openRef,
                numFinite(openRef.qty ?? qty),
                numFinite(openRef.price ?? openRef.meta?.entryPx ?? entryPx),
                tradeHistoryOpenFeeRateForRow(bot, openRef),
                t,
              )
            : null;
        const exitOnly = tradeCloseLegFeeUsd(t, openRef, qty, price, openR, closeR);
        if (sn != null && Number.isFinite(sn)) {
          if (!closeStoredPnlIsPackedWalletNet(t)) {
            const ex = exitOnly != null && Number.isFinite(exitOnly) ? exitOnly : 0;
            s += sn - ex;
          } else if (openRef && openFeeAmt != null && openInView) {
            s += sn + openFeeAmt;
          } else {
            s += sn;
          }
        }
      }
    }
    return s;
  }, [
    displayedTrades,
    displayedOpenRowIds,
    portfolioTrades,
    openTradeById,
    bot,
    tradeHistoryRoundTrip,
    tradeHistoryView,
    tradeHistoryRoundTripWindowBreakdown,
  ]);

  const headlineRealizedUsd =
    tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY"
      ? netSumDisplayedTradeHistoryRows
      : displayedTrades.length > 0
        ? netSumDisplayedTradeHistoryRows
        : mode === "PAPER"
          ? netRealizedPnlAll
          : netRealizedHeadline;

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
      // Strict market-mode: when configured for a specific venue, only show that venue's equity.
      // Never fall through to the other venue's number — that would show the wrong wallet.
      if (mm === "FUTURES" || mm === "FUTURES_USD_M") return f;
      if (mm === "SPOT") return s;
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
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Portfolio</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">{subtitle}</div>
        </div>
        {selectedInstance ? (
          <button
            type="button"
            disabled={instanceToggleBusy}
            title={
              mainEngineOn
                ? effectiveInstanceOn
                  ? "Turn this instance OFF"
                  : "Turn this instance ON"
                : "Mode bot is OFF. Turn it on first."
            }
            onClick={() => {
              void onToggleSelectedInstance();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
              effectiveInstanceOn
                ? "border-rose-400/70 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                : "border-emerald-400/70 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            }`}
          >
            {instanceToggleBusy ? "…" : effectiveInstanceOn ? "Instance ON ● (turn OFF)" : "Instance OFF ○ (turn ON)"}
          </button>
        ) : null}
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
                  <span className={(account as any)?.futuresAuthError ? "text-rose-400" : "text-slate-900 dark:text-slate-100"}>
                    {account?.venues?.futures?.equity != null ? `$${Number(account.venues.futures.equity).toFixed(2)}` : "—"}
                  </span>
                </div>
              </div>
              {(account as any)?.futuresAuthError ? (
                <div className="mt-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-300">
                  <span className="font-semibold">Futures auth failed.</span>{" "}
                  {mode === "BINANCE_DEMO_API"
                    ? "Demo futures (demo-fapi.binance.com) requires separate demo-futures API keys — your demo-spot keys won't work here. Set BINANCE_DEMO_FUTURES_API_KEY + BINANCE_DEMO_FUTURES_API_SECRET in backend/.env with keys from Binance's demo futures portal, or add them to this account."
                    : mode === "BINANCE_TESTNET"
                      ? "Futures testnet requires keys from testnet.binancefuture.com (different from spot testnet keys). Set BINANCE_FUTURES_API_KEY/SECRET in backend/.env."
                      : `Futures API error: ${String((account as any).futuresAuthError)}`}
                </div>
              ) : null}
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
            <div>
              <div className="text-slate-600 dark:text-slate-400">
                {tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY"
                  ? "Net realised PnL (round-trip)"
                  : "Net realised PnL"}
              </div>
              {tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY" ? (
                <div className="mt-0.5 max-w-md text-[10px] font-normal leading-snug text-slate-500 dark:text-slate-500">
                  Headline uses Σ trip net (gross − fees per row). With a time filter, only trips whose OPEN and CLOSE
                  timestamps both fall in the range count toward the headline; other closes stay in the table and roll into
                  pending reconciliation.
                </div>
              ) : null}
            </div>
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
            className={`mt-1 text-lg font-semibold ${headlineRealizedUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {Number.isFinite(headlineRealizedUsd) ? `$${headlineRealizedUsd.toFixed(2)}` : "—"}
          </div>
          {tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY" && tradeHistoryRoundTripWindowBreakdown ? (
            <div
              className={`mt-1 space-y-0.5 text-[11px] ${
                tradeHistoryRoundTripWindowBreakdown.pending !== 0
                  ? "text-amber-800 dark:text-amber-200"
                  : "text-slate-500 dark:text-slate-500"
              }`}
            >
              <div>
                Pending reconciliation:{" "}
                <span className="font-semibold tabular-nums">
                  ${tradeHistoryRoundTripWindowBreakdown.pending.toFixed(2)}
                </span>
                <span className="font-normal">
                  {" "}
                  (trip net from closes in the filter whose OPEN leg is missing or its timestamp is outside the filter —
                  e.g. exchange close arrived before the OPEN row is backfilled). Amber left border in the round-trip
                  table.
                </span>
              </div>
              {tradeHistoryRoundTripWindowBreakdown.pending === 0 ? (
                <div className="font-normal text-slate-500 dark:text-slate-500">
                  When pending is zero, the headline matches the sum of every Trip line in the table for this filter.
                </div>
              ) : (
                <div className="font-normal text-slate-500 dark:text-slate-500">
                  All closes in table (headline + pending):{" "}
                  <span className="font-semibold tabular-nums text-slate-600 dark:text-slate-400">
                    ${tradeHistoryRoundTripWindowBreakdown.total.toFixed(2)}
                  </span>
                  .
                </div>
              )}
            </div>
          ) : null}
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            {tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY" ? (
              <span className="text-[10px] leading-snug text-slate-500 dark:text-slate-500">
                Same trip economics as the round-trip table (per-row gross − OPEN and CLOSE fees). Flat list mode still
                uses row Net split rules above.
              </span>
            ) : mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET" || mode === "BINANCE_DEMO_API" ? (
              <>
                <span className="font-semibold text-slate-700 dark:text-slate-300">Headline</span> = sum of{" "}
                <span className="font-mono">Net</span> on visible trade rows (OPEN shows −open fee; CLOSE shows exchange net,
                or net + open fee when the OPEN row is visible). Matches realized when OPEN+CLOSE pairs are shown together.
                Unmatched <span className="font-mono">REALIZED_PNL</span> ledger totals stay in the breakdown only.
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
                    className="max-w-[6.5rem] px-3 py-2"
                    title="Binance USD-M market entry order number (from the bot OPEN fill for this symbol)"
                  >
                    Order #
                  </th>
                  <th className="px-3 py-2">Venue</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Entry</th>
                  <th
                    className="px-3 py-2"
                    title="Entry fill vs signal price (adverse slippage positive)"
                  >
                    Slip
                  </th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Margin</th>
                  <th className="px-3 py-2">SL</th>
                  <th className="px-3 py-2">TP</th>
                  <th
                    className="px-3 py-2 max-w-[5rem]"
                    title="P&L if price hits the current stop now (gross, before exit fees). Negative = max loss locked; positive = minimum profit if stopped out."
                  >
                    mPnL@SL
                  </th>
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
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={17}>
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
                      <td
                        className="px-3 py-2 text-slate-600 dark:text-slate-400 tabular-nums"
                        title="Fill vs signal at entry (LONG: fill above signal = adverse)"
                      >
                        {fmtSlipPct(positionEntrySlipPct(p))}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{Number(p.qty).toFixed(6)}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300" title="Initial margin ≈ notional / leverage (USD-M)">
                        {positionInitialMarginUsd(p)}
                      </td>
                      <td
                        className={`px-3 py-2 text-slate-700 dark:text-slate-300${
                          trailSlPending ? " bg-amber-500/12 ring-1 ring-inset ring-amber-500/30" : ""
                        }`}
                        title={(() => {
                          const parts: string[] = [];
                          if (p.venue === "FUTURES") {
                            const ladder = futuresTrailLadderSummaryTitle(p, bot);
                            if (ladder) parts.push(ladder);
                          }
                          const src = (p.meta as Record<string, unknown> | undefined)?.slDisplaySource;
                          if (src === "bot_trailing_target") {
                            parts.push("SL = configured trailing target (engine); exchange order can lag briefly.");
                          }
                          if (trailSlPending) parts.push("Stop replace in flight — confirming on exchange.");
                          return parts.length ? parts.join(" — ") : undefined;
                        })()}
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
                        className={`px-3 py-2 tabular-nums text-[11px] ${
                          (() => {
                            const m = lockedPnlUsdAtCurrentStop(p);
                            if (m == null) return "text-slate-600 dark:text-slate-400";
                            return m >= 0 ? "text-emerald-400" : "text-rose-400";
                          })()
                        }`}
                        title="Gross P&L if the current stop (incl. trail) fills at this price — before exit commission."
                      >
                        {(() => {
                          const m = lockedPnlUsdAtCurrentStop(p);
                          return m != null && Number.isFinite(m) ? fmtUsd(m, 2) : "—";
                        })()}
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
                        <td colSpan={16} className="px-3 py-1">
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
                    title="Force refresh trade history: POST /api/trade/refresh merges saved + exchange rows and, on USD-M futures, bypasses the income-ledger throttle so new closes reconcile immediately."
                    aria-label="Refresh trade history and force reconcile from exchange"
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
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  title={
                    tradeHistoryView === "OPEN_ONLY"
                      ? "Switch to All or Closed — round-trip pairs OPEN+CLOSE per symbol"
                      : "Merge each OPEN with its CLOSE into one row (sorted by close time)"
                  }
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-600"
                      : tradeHistoryRoundTrip
                        ? "border-violet-600/50 bg-violet-600/20 text-violet-100"
                        : "border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryRoundTrip((v) => !v)}
                >
                  Round trip
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
                  <th className="px-3 py-2" title="Whether this row is an opening fill or a closing fill.">
                    Leg
                  </th>
                  <th
                    className="px-3 py-2"
                    title="Execution style: market vs limit (and time-in-force when known)."
                  >
                    Style
                  </th>
                  <th className="px-3 py-2">Symbol</th>
                  <th
                    className="max-w-[6.5rem] px-3 py-2"
                    title="OPEN: exchange order number. CLOSE: income tran id (REALIZED_PNL) when present; otherwise order number."
                  >
                    Order #
                  </th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Entry</th>
                  <th
                    className="px-3 py-2"
                    title="CLOSE: exit price (avg fill or best available from trade / meta). OPEN: opening fill price."
                  >
                    Exit
                  </th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Margin</th>
                  <th className="px-3 py-2">SL/TP</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Src</th>
                  <th className="px-3 py-2">Gross</th>
                  <th
                    className="px-3 py-2"
                    title="OPEN: opening commission (stored or qty×price×open fee rate). CLOSE: closing commission only (stored, total−open, or modeled)."
                  >
                    Fee
                  </th>
                  <th className="px-3 py-2">Net</th>
                  <th className="px-3 py-2" title="OPEN: live uPnL% vs margin when position matches. CLOSE: net / initial margin at entry (futures).">
                    PnL%
                  </th>
                </tr>
              </thead>
              <tbody>
                {tradeHistoryRoundTrip && tradeHistoryView !== "OPEN_ONLY" ? (
                  !(tradeHistoryRoundTrips ?? []).length ? (
                    <tr>
                      <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={19}>
                        No closed trades in this filter
                      </td>
                    </tr>
                  ) : (
                    <TradeHistoryRoundTripRows
                      pairs={tradeHistoryRoundTrips!}
                      portfolioTrades={portfolioTrades || []}
                      bot={bot}
                      positions={positions}
                      trailingStopLossAuto={trailingStopLossAuto}
                      isFuturesVenue={isFuturesVenue}
                      tradeHistoryExpandedKey={tradeHistoryExpandedKey}
                      setTradeHistoryExpandedKey={setTradeHistoryExpandedKey}
                      historyRangeFilter={historyRangeFilter}
                    />
                  )
                ) : displayedTrades.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={19}>
                      No trades yet
                    </td>
                  </tr>
                ) : (
                  displayedTrades.map((t: any, idx) => {
                    const rowStatus = tradeRowStatus(t);
                    const openRef =
                      rowStatus === "CLOSED" && String(t?.type ?? "").toUpperCase() === "CLOSE"
                        ? resolveOpenRefForClose(t, portfolioTrades || [], openTradeById)
                        : undefined;
                    const { lev, price, qty, sl, tp } = tradeHistoryDisplayFields(t, openRef, bot);
                    const entryPx =
                      numFinite(
                        t?.entryPrice ?? t?.meta?.entryPrice ?? openRef?.entryPrice ?? openRef?.price ?? openRef?.meta?.entryPx,
                      ) ?? null;
                    const rowTyp = String(t?.type ?? "").toUpperCase();
                    const openInView =
                      rowStatus === "CLOSED" &&
                      String(t?.type ?? "").toUpperCase() === "CLOSE" &&
                      openRef?.id != null &&
                      displayedOpenRowIds.has(String(openRef.id));
                    const openR = openRef ? tradeHistoryOpenFeeRateForRow(bot, openRef) : tradeHistoryOpenFeeRateForRow(bot, t);
                    const closeR = tradeHistoryCloseFeeRateForRow(bot, t);

                    let fee: number | null = null;
                    let gross: number | null = null;
                    let net: number | null = null;
                    const pairedCloseForOpen =
                      rowStatus === "OPEN"
                        ? findPairedCloseForOpen(t, portfolioTrades || [], openTradeById)
                        : undefined;
                    const exitPx =
                      rowStatus === "CLOSED"
                        ? numFinite(t?.exitPrice ?? t?.meta?.exitPrice ?? (rowTyp === "CLOSE" ? price : undefined))
                        : null;
                    if (rowStatus === "OPEN") {
                      fee = tradeOpenLegFeeUsd(t, qty, price ?? entryPx, openR, pairedCloseForOpen);
                      gross = null;
                      net = fee != null ? -fee : null;
                    } else {
                      const closeQty = qty;
                      const closePx = exitPx ?? price;
                      fee = tradeCloseLegFeeUsd(t, openRef ?? t, closeQty, closePx, openR, closeR);
                      const storedCloseNet = tradeNetPnlClose(t);
                      const openFeeAmt = tradeOpenLegFeeUsd(
                        openRef ?? t,
                        numFinite((openRef ?? t)?.qty ?? closeQty),
                        numFinite((openRef ?? t)?.price ?? entryPx),
                        tradeHistoryOpenFeeRateForRow(bot, openRef ?? t),
                        t,
                      );
                      if (storedCloseNet != null && Number.isFinite(storedCloseNet)) {
                        net = closeDisplayedNetFromStored(
                          t,
                          storedCloseNet,
                          openRef ?? t,
                          openFeeAmt,
                          Boolean(openInView),
                          fee,
                        );
                      } else {
                        const g0 = tradeGrossPnlClose(t, closeQty, closePx, openRef ?? t, bot);
                        net = g0 != null && fee != null ? g0 - fee : tradeNetPnlClose(t);
                      }
                      gross =
                        numFinite(t?.meta?.grossPnl) ??
                        (net != null && fee != null ? net + fee : tradeGrossPnlClose(t, closeQty, closePx, openRef ?? t, bot));
                    }
                    const sideDisp =
                      t?.type === "CLOSE"
                        ? (t?.meta?.closeSide != null
                            ? String(t.meta.closeSide)
                            : closeOrderSideFromOpenLeg(openRef) ?? (t.side != null ? String(t.side) : null) ?? "n/a")
                        : (t.side != null ? String(t.side) : "n/a");
                    const slTpDisp = `${sl != null && Number.isFinite(sl) ? fmtInstrumentPx(sl) : "n/a"} / ${tp != null && Number.isFinite(tp) ? fmtInstrumentPx(tp) : "n/a"}`;
                    const marginDisp = tradeInitialMarginUsd(t, openRef, { price, qty, lev });
                    const pnlPct = tradeHistoryPnlPct(t, openRef, positions, { price, qty, lev }, bot);
                    const reasonDisp = tradeHistoryReasonLabel(t);
                    const binRefTrade = portfolioBinanceRefForTradeRow(t);
                    const legWarnings =
                      rowTyp === "CLOSE"
                        ? tradeCloseConsistencyWarnings(t, openRef, bot)
                        : rowTyp === "OPEN"
                          ? tradeOpenMissingCloseWarnings(t, portfolioTrades || [], positions, isFuturesVenue)
                          : [];
                    const trailLead = openTradeRowTrailedStrict(t, positions, trailingStopLossAuto);
                    const beLead = !trailLead && openTradeRowBreakevenStopIndicator(t, positions, trailingStopLossAuto);
                    const closeTrailLead = t?.type === "CLOSE" && closeTradeRowTrailedStrict(t);
                    const rowKey = tradeHistoryRowKey(t, idx);
                    const expanded = tradeHistoryExpandedKey === rowKey;
                    const toggleExpanded = () => {
                      setTradeHistoryExpandedKey((k) => (k === rowKey ? null : rowKey));
                    };
                    const entryExitMicroTitle =
                      rowTyp === "CLOSE" ? tradeHistoryEntryExitMicroMoveTitle(entryPx, price, qty) : undefined;
                    return (
                      <Fragment key={rowKey}>
                        <tr
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          aria-label={`${t?.type ?? "Trade"} leg ${t?.symbol ?? ""}: ${expanded ? "collapse" : "expand"} details`}
                          onClick={toggleExpanded}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleExpanded();
                            }
                          }}
                          className={`border-t border-slate-200 dark:border-slate-900${
                            expanded ? " bg-slate-100/60 dark:bg-slate-900/50" : ""
                          } cursor-pointer hover:bg-slate-50/90 dark:hover:bg-slate-900/35`}
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
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-3 shrink-0 text-[9px] leading-none text-slate-500 dark:text-slate-500" aria-hidden>
                                {expanded ? "▼" : "▶"}
                              </span>
                              {fmtTimestamp(tradeTsMs(t))}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                            {rowStatus === "OPEN" ? (
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                OPEN
                                {findLivePositionForTradeId(positions, t?.id) ? (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded bg-emerald-600/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400"
                                    title="Opening leg still matches a live position"
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                                    Live
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              "CLOSED"
                            )}
                          </td>
                          <td
                            className="px-3 py-2 text-[10px] text-slate-600 dark:text-slate-400"
                            title={tradeHistoryExchangeOrderKindLabel(t) === "—" ? "Order type not recorded for this row" : undefined}
                          >
                            {tradeHistoryExchangeOrderKindLabel(t)}
                          </td>
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
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-300" title={entryExitMicroTitle}>
                            {entryPx != null && entryPx > 0 ? fmtInstrumentPx(entryPx) : "n/a"}
                          </td>
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-300" title={entryExitMicroTitle}>
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
                          <td className="max-w-[7rem] px-3 py-2 text-[10px] text-slate-700 dark:text-slate-300">
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
                          <td
                            className="px-3 py-2 text-slate-700 dark:text-slate-300"
                            title={tradeHistoryFeeCellTitle(t, fee)}
                          >
                            {fee != null ? fmtUsd(fee, 4) : "n/a"}
                          </td>
                          <td
                            className={`px-3 py-2 ${net != null && net >= 0 ? "text-emerald-400" : net != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
                            title={tradeHistoryCloseNetColumnTitle(t)}
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
                        {expanded ? (
                          <tr className="border-t border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-950/30">
                            <td colSpan={19} className="p-0">
                              <TradeHistoryExpandedDetails
                                t={t}
                                openRef={openRef}
                                qty={qty}
                                price={price}
                                gross={gross}
                                legWarnings={legWarnings}
                                binRefTitle={binRefTrade.title}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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

