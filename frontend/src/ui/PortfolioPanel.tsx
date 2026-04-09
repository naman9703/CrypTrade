import { useMemo, useState } from "react";
import { deferTask } from "../lib/deferTask";
import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { isIncomeLedgerClose } from "../lib/tradeClassification";
import { estimatedCloseFeeUsdt } from "../lib/tradeCloseFee";
import { AiTradeMotionVisual } from "./AiTradeMotionVisual";

function isLedgerClose(t: any): boolean {
  return isIncomeLedgerClose(t);
}

function tradeTsMs(t: any): number {
  const ts = t?.ts;
  if (ts == null) return 0;
  const ms = new Date(String(ts)).getTime();
  return Number.isFinite(ms) ? ms : 0;
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

/** Fee for display: same as tradeFeeUsd, else modeled close fee from qty×price×0.0004 when possible. */
function tradeFeeUsdForCloseRow(t: any, displayQty: number | undefined, displayPrice: number | undefined): number | null {
  const direct = tradeFeeUsd(t);
  if (direct != null) return direct;
  if (t?.type !== "CLOSE" || isLedgerClose(t)) return null;
  return estimatedCloseFeeUsdt(displayQty, displayPrice);
}

function tradeGrossPnlClose(t: any, displayQty?: number, displayPrice?: number): number | null {
  if (t?.type !== "CLOSE") return null;
  if (t?.grossPnl != null && Number.isFinite(Number(t.grossPnl))) return Number(t.grossPnl);
  const net = Number(t?.pnl);
  if (!Number.isFinite(net)) return null;
  const fee = tradeFeeUsdForCloseRow(t, displayQty, displayPrice);
  if (fee != null && fee > 0) return net + fee;
  return net;
}

function tradeNetPnlClose(t: any): number | null {
  if (t?.type !== "CLOSE") return null;
  const net = Number(t?.pnl);
  return Number.isFinite(net) ? net : null;
}

function fmtUsd(x: number | null, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return Number(x).toFixed(digits);
}

function numFinite(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
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

export function PortfolioPanel() {
  const trades = useAppStore((s) => s.trades);
  const account = useAppStore((s) => s.account);
  const bot = useAppStore((s) => s.bot);
  const positions = useAppStore((s) => s.positions) || [];
  const pushLog = useAppStore((s) => s.pushLog);
  const mode = useAppStore((s) => s.mode);
  const exchName = useAppStore((s) => s.bot?.exchange?.name) as string | undefined;

  const strictAccountMissing =
    (mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET") && account === null;
  /** Testnet/mainnet: do not show local/audit trade rows until Binance account snapshot loads. */
  const portfolioTrades = strictAccountMissing ? [] : trades || [];

  const [tradeHistoryView, setTradeHistoryView] = useState<"ALL" | "OPEN_ONLY" | "CLOSED_ONLY">("ALL");
  // Default "Strategy" (APP): futures demo emits many unmatched income shards; hide unless debugging.
  const [closeSourceFilter, setCloseSourceFilter] = useState<"ALL" | "APP" | "LEDGER">("APP");

  const closeTrades = (portfolioTrades || []).filter((t: any) => t?.type === "CLOSE");
  const closeTradesApp = closeTrades.filter((t: any) => !isLedgerClose(t));
  const closeTradesLedger = closeTrades.filter((t: any) => isLedgerClose(t));

  const openTradeById = useMemo(() => {
    const m = new Map<string, any>();
    for (const row of portfolioTrades || []) {
      if (row?.type !== "OPEN") continue;
      const id = String(row?.id ?? "");
      if (id) m.set(id, row);
    }
    return m;
  }, [portfolioTrades]);

  const wins = closeTradesApp.reduce((a: number, t: any) => a + ((tradeNetPnlClose(t) ?? 0) > 0 ? 1 : 0), 0);
  const losses = closeTradesApp.reduce((a: number, t: any) => a + ((tradeNetPnlClose(t) ?? 0) < 0 ? 1 : 0), 0);
  const netRealizedPnlStrategy = closeTradesApp.reduce((a: number, t: any) => a + (tradeNetPnlClose(t) ?? 0), 0);
  const netRealizedPnlLedger = closeTradesLedger.reduce((a: number, t: any) => a + (tradeNetPnlClose(t) ?? 0), 0);
  const netRealizedPnlAll = netRealizedPnlStrategy + netRealizedPnlLedger;
  /** Live/testnet: headline matches “app session” (demo-style); optional ledger stays in breakdown or enable BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED=1 on server. */
  const netRealizedHeadline =
    mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET"
      ? netRealizedPnlStrategy
      : netRealizedPnlAll;

  const { strategyFeeTotal, strategyClosesWithFee } = useMemo(() => {
    const rowList = portfolioTrades || [];
    let total = 0;
    let withFee = 0;
    for (const t of rowList) {
      if (t?.type !== "CLOSE" || isLedgerClose(t)) continue;
      const openRef = resolveOpenRefForClose(t, rowList, openTradeById);
      const { price, qty } = tradeHistoryDisplayFields(t, openRef);
      const f = tradeFeeUsdForCloseRow(t, qty, price);
      if (f != null) {
        total += f;
        withFee += 1;
      }
    }
    return { strategyFeeTotal: total, strategyClosesWithFee: withFee };
  }, [portfolioTrades, openTradeById]);
  const winrate = wins + losses > 0 ? wins / (wins + losses) : null;

  const last10Min = useMemo(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    let appN = 0;
    let appPnl = 0;
    let ledN = 0;
    let ledPnl = 0;
    for (const t of portfolioTrades || []) {
      if (t?.type !== "CLOSE") continue;
      if (tradeTsMs(t) < cutoff) continue;
      const p = tradeNetPnlClose(t) ?? 0;
      if (isLedgerClose(t)) {
        ledN += 1;
        ledPnl += p;
      } else {
        appN += 1;
        appPnl += p;
      }
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [portfolioTrades]);

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
    if (tradeHistoryView === "OPEN_ONLY") return openTrades;
    if (tradeHistoryView === "CLOSED_ONLY") return closedTrades.filter(keepClose);
    if (closeSourceFilter === "ALL") return rows;
    return rows.filter((t: any) => (t?.type === "OPEN" ? true : keepClose(t)));
  }, [tradeHistoryView, openTrades, closedTrades, portfolioTrades, closeSourceFilter]);

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

  return (
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
          <div className="text-slate-600 dark:text-slate-400">Net realised PnL</div>
          <div
            className={`mt-1 text-lg font-semibold ${netRealizedHeadline >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {Number.isFinite(netRealizedHeadline) ? `$${netRealizedHeadline.toFixed(2)}` : "—"}
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            {mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET" ? (
              <>
                Strategy / bracket-attributed closes only (demo-style). Unmatched Binance{" "}
                <span className="font-mono">REALIZED_PNL</span> shards are excluded unless{" "}
                <span className="font-mono">BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED=1</span>.
              </>
            ) : (
              <>
                Net of modeled per-trade fees where available; strategy rows use stored CLOSE{" "}
                <span className="font-mono">pnl</span> (paper sims are after fees). Exchange ledger rows are usually net of
                fees in the income amount.
              </>
            )}
          </div>
          {(mode === "BINANCE_LIVE" || mode === "BINANCE_TESTNET") &&
          Number.isFinite(netRealizedPnlAll) &&
          closeTradesLedger.length > 0 ? (
            <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
              Incl. unmatched ledger (below):{" "}
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
                <span className="text-slate-600">({closeTradesApp.length} CLOSE)</span>
              </div>
              {strategyClosesWithFee > 0 ? (
                <div>
                  Total fees (strategy-attributed):{" "}
                  <span className="text-slate-700 dark:text-slate-300">${strategyFeeTotal.toFixed(2)}</span>
                  {strategyClosesWithFee < closeTradesApp.length ? (
                    <span className="text-slate-600"> ({strategyClosesWithFee}/{closeTradesApp.length} closes with fee data)</span>
                  ) : null}
                </div>
              ) : closeTradesApp.length > 0 ? (
                <div className="text-slate-600">Total fees (strategy): no per-trade fee breakdown in current history.</div>
              ) : null}
              {closeTradesLedger.length > 0 ? (
                <div>
                  Unmatched income ledger:{" "}
                  <span className={netRealizedPnlLedger >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    ${netRealizedPnlLedger.toFixed(2)}
                  </span>{" "}
                  <span className="text-slate-600">({closeTradesLedger.length} CLOSE)</span>
                </div>
              ) : null}
            </div>
          )}
          <div className="mt-2 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
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
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
          <div className="border-b border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200">Positions</div>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                <tr className="text-left text-slate-600 dark:text-slate-400">
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Venue</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">SL</th>
                  <th className="px-3 py-2">TP</th>
                  <th className="px-3 py-2">uPnL</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={10}>
                      No open positions
                    </td>
                  </tr>
                ) : (
                  positions.map((p: any) => (
                    <tr key={p.id} className="border-t border-slate-200 dark:border-slate-900">
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{p.symbol}</td>
                      <td className="px-3 py-2 text-[10px] uppercase text-slate-600 dark:text-slate-500">
                        {p.venue === "FUTURES" ? "Fut" : "Spot"}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{p.side}</td>
                      <td className="px-3 py-2 text-amber-300/80">
                        {p.leverage != null && Number(p.leverage) > 0 ? `${Number(p.leverage)}x` : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{Number(p.entryPrice).toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{Number(p.qty).toFixed(6)}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{p.stopLoss != null ? Number(p.stopLoss).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                        {p.takeProfit != null ? Number(p.takeProfit).toFixed(2) : "—"}
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
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
          <div className="border-b border-slate-200 dark:border-slate-800 px-3 py-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Trade history</div>
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
              </div>
            </div>
          </div>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                <tr className="text-left text-slate-600 dark:text-slate-400">
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">SL/TP</th>
                  <th className="px-3 py-2">Src</th>
                  <th className="px-3 py-2">Gross</th>
                  <th className="px-3 py-2">Fee</th>
                  <th className="px-3 py-2">Net</th>
                </tr>
              </thead>
              <tbody>
                {displayedTrades.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={11}>
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
                    const gross = t?.type === "CLOSE" ? tradeGrossPnlClose(t, qty, price) : null;
                    const net = t?.type === "CLOSE" ? tradeNetPnlClose(t) : null;
                    const sideDisp =
                      t.side ?? (t?.type === "CLOSE" && t?.meta?.closeSide != null ? String(t.meta.closeSide) : null) ?? "n/a";
                    const slTpDisp = `${sl != null ? sl.toFixed(2) : "n/a"} / ${tp != null ? tp.toFixed(2) : "n/a"}`;
                    return (
                      <tr key={idx} className="border-t border-slate-200 dark:border-slate-900">
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{t.type ?? t.reason ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{t.symbol ?? "n/a"}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{sideDisp}</td>
                        <td className="px-3 py-2 text-amber-300/80">
                          {lev != null && lev > 0 ? `${lev}x` : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {price != null && price > 0 ? price.toFixed(2) : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {qty != null && qty > 0 ? qty.toFixed(6) : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-slate-600 dark:text-slate-400">{slTpDisp}</td>
                        <td className="px-3 py-2 text-[10px] uppercase text-slate-600 dark:text-slate-500">
                          {t.type === "CLOSE" ? (isLedgerClose(t) ? "ledger" : "strat") : t.type === "OPEN" ? "strat" : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 ${gross != null && gross >= 0 ? "text-emerald-400" : gross != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
                        >
                          {gross != null ? fmtUsd(gross) : "n/a"}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {fee != null ? fmtUsd(fee, 4) : "n/a"}
                        </td>
                        <td
                          className={`px-3 py-2 ${net != null && net >= 0 ? "text-emerald-400" : net != null ? "text-rose-400" : "text-slate-600 dark:text-slate-400"}`}
                        >
                          {net != null ? fmtUsd(net) : "—"}
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
  );
}

