import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { computeRegimeStripSymbols } from "../lib/multiCoinTabSymbols";
import { useAppStore } from "../ws/store";

const HISTORY_MAX = 14;

type Ltf = {
  type?: string;
  confidence?: number;
  raw?: { adx?: number; atrRatio?: number; emaSlope?: number; price?: number; ema?: number };
};

/** Bar-close inputs from server `computeMarketDecisionSnapshot` (ADX/RSI/EMA/ATR series). */
type ClassifierInputs = {
  price?: number;
  ema?: number;
  emaLength?: number;
  emaSlope?: number | null;
  adx?: number;
  adxPeriod?: number;
  rsi?: number;
  rsiPeriod?: number;
  atr?: number;
  atrPeriod?: number;
  atrPct?: number;
  rangeCompression?: number;
};

type WatchSnap = {
  ts?: number;
  updatedAt?: number;
  marketDecisionSnapshot?: {
    regime?: { ltf?: Ltf };
    metrics?: Record<string, unknown>;
    classifierInputs?: ClassifierInputs;
    entryTiming?: { metrics?: Record<string, number> };
  } | null;
};

function fmtFixed(n: number | null | undefined, digits: number): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const x = Number(n);
  if (x >= 1000) return x.toFixed(2);
  if (x >= 1) return x.toFixed(4);
  return x.toFixed(6);
}

function regimeShort(type: string | undefined): string {
  const t = String(type || "—").toUpperCase();
  if (t === "UPTREND") return "U";
  if (t === "DOWNTREND") return "D";
  if (t === "SIDEWAYS") return "S";
  if (t === "VOLATILE") return "V";
  if (t === "UNCLEAR") return "?";
  return t.length <= 3 ? t : t.slice(0, 3);
}

function regimeChipClass(type: string | undefined): string {
  const t = String(type || "").toUpperCase();
  if (t === "UPTREND") return "border-emerald-500/50 bg-emerald-500/15 text-emerald-800 dark:text-emerald-100";
  if (t === "DOWNTREND") return "border-rose-500/50 bg-rose-500/15 text-rose-900 dark:text-rose-100";
  if (t === "SIDEWAYS") return "border-amber-500/50 bg-amber-500/15 text-amber-950 dark:text-amber-100";
  if (t === "VOLATILE") return "border-orange-500/50 bg-orange-500/15 text-orange-950 dark:text-orange-100";
  if (t === "UNCLEAR") return "border-slate-400/50 bg-slate-400/15 text-slate-800 dark:text-slate-200";
  return "border-slate-300/80 bg-slate-200/40 text-slate-700 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-200";
}

function RegimeDot({ type }: { type: string }) {
  const t = String(type || "—").toUpperCase();
  const cls =
    t === "UPTREND"
      ? "bg-emerald-500"
      : t === "DOWNTREND"
        ? "bg-rose-500"
        : t === "SIDEWAYS"
          ? "bg-amber-400"
          : t === "VOLATILE"
            ? "bg-orange-500"
            : t === "UNCLEAR"
              ? "bg-slate-400"
              : "bg-slate-300 dark:bg-slate-600";
  return (
    <span
      className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", cls)}
      title={t}
      aria-hidden
    />
  );
}

/**
 * Continuous regime strip: on each bar-close snapshot, show LTF regime (ADX·ATR·EMA-classifier)
 * and a rolling time series of recent regime labels per symbol.
 */
export function RegimeEngineStrip() {
  const bot = useAppStore((s) => s.bot) as Record<string, unknown> | null | undefined;
  const symbols = useMemo(() => computeRegimeStripSymbols(bot), [bot]);

  const snaps = (bot?.multiSymbolWatchSignals || {}) as Record<string, WatchSnap>;
  const sigKey = useMemo(() => {
    if (!symbols.length) return "";
    return symbols
      .map((sym) => {
        const s = snaps[sym];
        const ts = s?.ts ?? "";
        const t = s?.marketDecisionSnapshot?.regime?.ltf?.type ?? "";
        return `${sym}:${ts}:${t}`;
      })
      .join("|");
  }, [symbols, snaps]);

  const [histBySym, setHistBySym] = useState<Record<string, Array<{ ts: number; type: string }>>>({});
  const prevKey = useRef<string>("");

  useEffect(() => {
    if (!sigKey || sigKey === prevKey.current) return;
    prevKey.current = sigKey;
    setHistBySym((prev) => {
      const next = { ...prev };
      for (const sym of symbols) {
        const s = snaps[sym];
        const ltf = s?.marketDecisionSnapshot?.regime?.ltf;
        const type = String(ltf?.type ?? "—");
        const ts = Number(s?.ts);
        if (!Number.isFinite(ts)) continue;
        const arr = next[sym] ? [...next[sym]] : [];
        const last = arr[arr.length - 1];
        if (last && last.ts === ts) {
          if (last.type !== type) {
            arr[arr.length - 1] = { ts, type };
          }
        } else {
          arr.push({ ts, type });
        }
        next[sym] = arr.slice(-HISTORY_MAX);
      }
      return next;
    });
  }, [sigKey, symbols, snaps]);

  if (!symbols.length) return null;

  return (
    <div
      className="border-b border-violet-200/80 bg-gradient-to-r from-violet-50/95 via-white/90 to-indigo-50/90 dark:border-violet-900/50 dark:from-violet-950/40 dark:via-slate-950/80 dark:to-indigo-950/40"
      role="region"
      aria-label="Continuous regime tracking"
    >
      <div className="mx-auto max-w-[1600px] px-4 py-2 sm:px-5">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[10px] leading-tight text-violet-900/90 dark:text-violet-200/90">
          <span className="inline-flex items-center gap-1 font-semibold tracking-wide text-violet-800 dark:text-violet-100">
            <span className="text-[11px]" aria-hidden>
              🟢
            </span>
            Continuous regime tracking
          </span>
          <span className="text-violet-700/85 dark:text-violet-300/80">
            Each closed bar: <code className="rounded bg-violet-100/80 px-1 font-mono text-[9px] dark:bg-violet-900/50">regime[t]</code>{" "}
            = classify(ADX, ATR, EMA, …) — values below are the same inputs used for classification (updates on bar-close snapshots).
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {symbols.map((sym) => {
            const s = snaps[sym];
            const mds = s?.marketDecisionSnapshot;
            const ltf = mds?.regime?.ltf;
            const ci = mds?.classifierInputs;
            const et = mds?.entryTiming?.metrics;
            const type = ltf?.type;
            const conf = ltf?.confidence;
            const adxV = ci?.adx ?? ltf?.raw?.adx;
            const atrR = ltf?.raw?.atrRatio;
            const hasSnap = s != null && Number.isFinite(Number(s.updatedAt));
            const series = histBySym[sym] ?? [];

            const adxP = ci?.adxPeriod ?? 14;
            const rsiP = ci?.rsiPeriod ?? 14;
            const atrP = ci?.atrPeriod ?? 14;
            const emaLen = ci?.emaLength ?? "—";
            const distEmaPct =
              et?.distToEmaPct != null && Number.isFinite(et.distToEmaPct)
                ? `${(Number(et.distToEmaPct) * 100).toFixed(2)}%`
                : null;

            return (
              <div
                key={sym}
                className="min-w-[11rem] flex-1 rounded-md border border-violet-200/70 bg-white/90 px-2 py-1.5 shadow-sm dark:border-violet-800/60 dark:bg-slate-900/70 sm:min-w-[13rem]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-violet-100/90 pb-1 dark:border-violet-900/50">
                  <span className="font-mono text-[11px] font-semibold text-slate-900 dark:text-slate-100">{sym}</span>
                  {hasSnap ? (
                    <span className="text-[9px] text-slate-500 dark:text-slate-400" title="Snapshot age">
                      {typeof s.updatedAt === "number" ? `${Math.max(0, Math.floor((Date.now() - s.updatedAt) / 1000))}s` : "—"}
                    </span>
                  ) : (
                    <span className="text-[9px] text-amber-600 dark:text-amber-400">waiting</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className={clsx(
                      "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                      regimeChipClass(type),
                    )}
                    title={
                      type && hasSnap
                        ? `${type}${conf != null ? ` · conf ${Math.round(Number(conf))}` : ""}${adxV != null ? ` · ADX ${Number(adxV).toFixed(1)}` : ""}${atrR != null ? ` · ATR/px ${(Number(atrR) * 100).toFixed(2)}%` : ""}`
                        : "No regime snapshot yet"
                    }
                  >
                    {hasSnap ? regimeShort(type) : "—"}
                  </span>
                  {conf != null && Number.isFinite(Number(conf)) ? (
                    <span className="text-[9px] tabular-nums text-slate-600 dark:text-slate-400">{Math.round(Number(conf))}%</span>
                  ) : null}
                </div>
                {hasSnap && ci ? (
                  <div
                    className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-violet-100/80 pt-1.5 font-mono text-[9px] leading-tight text-slate-700 dark:border-violet-900/40 dark:text-slate-300"
                    title="Series periods match regime classifier (Wilder-style ADX/ATR, RSI, EMA length from config)"
                  >
                    <span>
                      ADX({adxP}){" "}
                      <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtFixed(ci.adx, 1)}</span>
                    </span>
                    <span>
                      RSI({rsiP}) <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtFixed(ci.rsi, 1)}</span>
                    </span>
                    <span className="col-span-2 sm:col-span-1">
                      EMA({emaLen}) <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtPrice(ci.ema)}</span>
                    </span>
                    <span>
                      ATR({atrP}) <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtPrice(ci.atr)}</span>
                    </span>
                    <span>
                      %ATR{" "}
                      <span className="tabular-nums text-slate-900 dark:text-slate-100">
                        {ci.atrPct != null && Number.isFinite(ci.atrPct) ? `${(Number(ci.atrPct) * 100).toFixed(2)}%` : "—"}
                      </span>
                    </span>
                    <span>
                      Close <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtPrice(ci.price)}</span>
                    </span>
                    <span className="col-span-2">
                      Range<sub className="text-[8px]">10</sub>{" "}
                      <span className="tabular-nums text-slate-900 dark:text-slate-100">
                        {ci.rangeCompression != null && Number.isFinite(ci.rangeCompression)
                          ? `${(Number(ci.rangeCompression) * 100).toFixed(2)}%`
                          : "—"}
                      </span>
                      <span className="text-slate-500 dark:text-slate-500"> · chop window</span>
                    </span>
                    {ci.emaSlope != null && Number.isFinite(ci.emaSlope) ? (
                      <span className="col-span-2">
                        ΔEMA <span className="tabular-nums text-slate-900 dark:text-slate-100">{fmtFixed(ci.emaSlope, 6)}</span>
                        <span className="text-slate-500 dark:text-slate-500"> / bar</span>
                      </span>
                    ) : null}
                    {distEmaPct ? (
                      <span className="col-span-2">
                        |price−EMA|/price <span className="tabular-nums text-slate-900 dark:text-slate-100">{distEmaPct}</span>
                      </span>
                    ) : null}
                  </div>
                ) : hasSnap ? (
                  <p className="mt-1.5 text-[9px] text-slate-500 dark:text-slate-500">
                    Metrics available after backend with <code className="font-mono">classifierInputs</code> — restart server or wait for next bar.
                  </p>
                ) : null}
                <div className="mt-1.5 flex items-center gap-0.5" title="Recent regimes (oldest → newest)">
                  {series.length ? (
                    series.map((h, i) => <RegimeDot key={`${h.ts}-${i}`} type={h.type} />)
                  ) : (
                    <span className="text-[9px] text-slate-400 dark:text-slate-500">Series fills as bars close…</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
