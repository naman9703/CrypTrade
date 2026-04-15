import { useEffect, useRef, useState } from "react";
import { useAuthActions } from "../authContext";
import { useAppStore, type LogPayload } from "../ws/store";

type ToastTone = "success" | "failure";

type ToastRow = {
  id: string;
  createdAt: number;
  expiresAt: number;
  hovering: boolean;
  remainingMs: number | null;
  entering: boolean;
  tone: ToastTone;
  log: LogPayload & Record<string, unknown>;
};

const AUTO_DISMISS_MS = 5000;
/** Max activity popups visible at once (newest kept). */
const MAX_VISIBLE_TOASTS = 5;
/** Cap how many brand-new log lines we enqueue in one WS tick (burst guard). */
const MAX_NEW_TOASTS_PER_TICK = 12;

function logId(l: { ts?: unknown; msg?: unknown; reason?: unknown; symbol?: unknown; category?: unknown }): string {
  const ts = typeof l.ts === "string" ? l.ts : "";
  const msg = String(l.msg ?? "");
  const reason = String(l.reason ?? "");
  const sym = String(l.symbol ?? "");
  const cat = String(l.category ?? "");
  return `${ts}|${cat}|${reason}|${sym}|${msg}`;
}

function toneFromLog(l: LogPayload): ToastTone {
  return l.level === "warn" || l.level === "error" ? "failure" : "success";
}

function prettyReason(r: unknown): string {
  const s = String(r ?? "").trim();
  if (!s) return "";
  return s.replace(/_/g, " ");
}

function fmtPx(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  // Keep compact but precise enough for small coins.
  const abs = Math.abs(n);
  const frac = abs < 1 ? 6 : abs < 100 ? 4 : 2;
  return n.toFixed(frac);
}

function pickSymbol(l: Record<string, unknown>): string | null {
  const sym = l.symbol != null ? String(l.symbol).trim() : "";
  return sym ? sym.toUpperCase() : null;
}

function pickCategory(l: Record<string, unknown>): string | null {
  const c = l.category != null ? String(l.category).trim() : "";
  return c ? c : null;
}

function pickReason(l: Record<string, unknown>): string | null {
  const r = l.reason != null ? String(l.reason).trim() : "";
  return r ? r : null;
}

/** Stable across repeated WS / jsonl lines (timestamps differ). Suppresses duplicate toasts + replay after login. */
function toastStableDedupeKey(l: LogPayload & Record<string, unknown>): string {
  const cat = String(l.category ?? "").trim().toLowerCase();
  const d =
    l.detail && typeof l.detail === "object" && !Array.isArray(l.detail)
      ? (l.detail as Record<string, unknown>)
      : null;
  const sym = (pickSymbol(l) ?? "").toUpperCase();
  if (cat === "signal" && d && String(d.kind ?? "").toLowerCase() === "supertrend") {
    const ac = String(d.action ?? "").toUpperCase();
    const side = String(d.side ?? "").toUpperCase();
    const venue = String(d.venue ?? "").toUpperCase();
    if (ac === "PENDING") {
      const pdk = String(d.pendingDedupeKey ?? "").trim();
      return `sig:st:PEN:${sym}:${side}:${venue}:${pdk}`;
    }
  }
  const reason = String(l.reason ?? "").trim();
  const msg = String(l.msg ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `gen:${cat}:${reason}:${sym}:${msg}`;
}

type ToastViewModel = {
  title: string;
  headline: string;
  sublines: string[];
  chips: Array<{ k: string; v: string }>;
};

function buildToastViewModel(l: LogPayload & Record<string, unknown>): ToastViewModel {
  const cat = pickCategory(l);
  const sym = pickSymbol(l);
  const reason = pickReason(l);
  const detail = (l.detail && typeof l.detail === "object" && !Array.isArray(l.detail) ? (l.detail as Record<string, unknown>) : null) ?? null;

  // Common chips
  const chips: ToastViewModel["chips"] = [];
  if (reason) chips.push({ k: "Reason", v: prettyReason(reason) });
  if (cat) chips.push({ k: "Category", v: cat });
  if (sym) chips.push({ k: "Symbol", v: sym });

  // TRAILING SL ADVANCE (most important actionable)
  if (reason === "trailing_sl_advance" && detail) {
    const prev = detail.prevStopLoss;
    const next = detail.newStopLoss;
    const step = detail.trailStep;
    const maxS = detail.maxTrailSteps;
    const st = detail.supertrendPx;
    const mode = detail.trailingMode ?? detail.kind;
    const head = `SL ${fmtPx(prev)} → ${fmtPx(next)}`;
    const sub: string[] = [];
    if (step != null || maxS != null) sub.push(`Step ${String(step ?? "—")}/${String(maxS ?? "—")}`);
    if (st != null) sub.push(`ST ${fmtPx(st)}`);
    if (mode != null) sub.push(`Mode ${String(mode)}`);
    return {
      title: sym ? `${sym} · Trailing` : "Trailing",
      headline: head,
      sublines: sub,
      chips,
    };
  }

  // TRAILING NOOP (action attempted)
  if (reason === "trailing_sl_noop" && detail) {
    const prev = detail.prevStopLoss;
    const merged = detail.proposedMerged;
    const rounded = detail.proposedRounded;
    const head = `No SL move (still ${fmtPx(prev)})`;
    const sub: string[] = [];
    if (merged != null) sub.push(`Proposed ${fmtPx(merged)}${rounded != null ? ` → rounded ${fmtPx(rounded)}` : ""}`);
    if (detail.tickSize != null) sub.push(`Tick ${String(detail.tickSize)}`);
    if (detail.minSlDistanceFracUsed != null) sub.push(`MinDist ${(Number(detail.minSlDistanceFracUsed) * 100).toFixed(3)}%`);
    return {
      title: sym ? `${sym} · Trailing` : "Trailing",
      headline: head,
      sublines: sub,
      chips,
    };
  }

  // MODE SWITCH
  if (cat === "trading_mode" && reason && String(reason).startsWith("mode_changed")) {
    const mode = detail?.mode != null ? String(detail.mode) : undefined;
    return {
      title: "Trading mode",
      headline: mode ? `Mode: ${mode}` : "Mode changed",
      sublines: [],
      chips,
    };
  }

  // FEED
  if (cat === "feed") {
    return {
      title: "Feed",
      headline: String(l.msg ?? "Feed update"),
      sublines: [],
      chips,
    };
  }

  // EXCHANGE / ACCOUNT
  if (cat === "exchange") {
    return {
      title: "Exchange",
      headline: String(l.msg ?? "Exchange event"),
      sublines: [],
      chips,
    };
  }

  // AI
  if (cat === "ai") {
    return {
      title: "AI",
      headline: String(l.msg ?? "AI event"),
      sublines: [],
      chips,
    };
  }

  // FALLBACK
  const titleParts = [cat ? cat.toUpperCase() : "", sym ?? ""].filter(Boolean);
  return {
    title: titleParts.length ? titleParts.join(" · ") : "Activity",
    headline: String(l.msg ?? "—"),
    sublines: [],
    chips,
  };
}

export function ActivityToasts() {
  const auth = useAuthActions();
  const authUiUserTag = useAppStore((s) => s.authUiUserTag ?? null);
  const activityLogBulkGeneration = useAppStore((s) => s.activityLogBulkGeneration ?? 0);
  const pendingStAction = useAppStore((s) => s.bot?.pendingSupertrendAction as Record<string, unknown> | null | undefined);
  /** UI auth off → always show; UI auth on → only after `/api/auth/me` authenticated (tag set). */
  const activityToastsAllowed = !auth?.gated || authUiUserTag != null;

  const logs = useAppStore((s) => s.logs);
  const seenRef = useRef(new Set<string>());
  /** Dedupe keys for which we must not toast again (hydrated history + shown lines) until reconnect or pending clears. */
  const blockedToastDedupeKeysRef = useRef(new Set<string>());
  /** After login / first allow: mark existing `logs` as seen without showing (real-time only, no replay pool). */
  const sessionLogsHydratedRef = useRef(false);
  /** Skip treating first `bulkGen===0` mount as a server snapshot bump; react only to hello increments. */
  const lastBulkReactedRef = useRef(-1);
  const prevPendingKeyRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<ToastRow[]>([]);

  useEffect(() => {
    if (!activityToastsAllowed) {
      setToasts([]);
      seenRef.current.clear();
      blockedToastDedupeKeysRef.current.clear();
      sessionLogsHydratedRef.current = false;
      lastBulkReactedRef.current = -1;
      prevPendingKeyRef.current = null;
    }
  }, [activityToastsAllowed]);

  /** When queued Supertrend is cleared (start / cancel), allow a future PENDING toast for a new bar. */
  useEffect(() => {
    const pk = pendingStAction
      ? `${String(pendingStAction.symbol ?? "")}|${String(pendingStAction.side ?? "")}|${String(pendingStAction.venue ?? "")}`
      : null;
    if (prevPendingKeyRef.current && !pk) {
      for (const k of [...blockedToastDedupeKeysRef.current]) {
        if (k.startsWith("sig:st:PEN:")) blockedToastDedupeKeysRef.current.delete(k);
      }
    }
    prevPendingKeyRef.current = pk;
  }, [pendingStAction]);

  /** WS `hello` replaces the whole activity log — ids may not match client-side `logId` pre-hello, so re-hydrate silently. */
  useEffect(() => {
    if (!activityToastsAllowed) return;
    if (activityLogBulkGeneration === 0) {
      lastBulkReactedRef.current = activityLogBulkGeneration;
      return;
    }
    if (lastBulkReactedRef.current === activityLogBulkGeneration) return;
    lastBulkReactedRef.current = activityLogBulkGeneration;
    seenRef.current.clear();
    blockedToastDedupeKeysRef.current.clear();
    sessionLogsHydratedRef.current = false;
  }, [activityLogBulkGeneration, activityToastsAllowed]);

  useEffect(() => {
    if (!activityToastsAllowed) return;
    if (!Array.isArray(logs) || logs.length === 0) return;

    if (!sessionLogsHydratedRef.current) {
      for (const raw of logs) {
        if (!raw || typeof raw !== "object") continue;
        const l = raw as LogPayload & Record<string, unknown>;
        const id = logId(l);
        if (id) seenRef.current.add(id);
        blockedToastDedupeKeysRef.current.add(toastStableDedupeKey(l));
      }
      sessionLogsHydratedRef.current = true;
      return;
    }

    // `logs` is newest-first. Walk from the front until we hit an id already seen (older tail).
    const now = Date.now();
    const adds: ToastRow[] = [];
    for (const raw of logs) {
      if (!raw || typeof raw !== "object") continue;
      const id = logId(raw as LogPayload & Record<string, unknown>);
      if (!id) continue;
      if (seenRef.current.has(id)) break;
      const l = raw as LogPayload & Record<string, unknown>;
      const dk = toastStableDedupeKey(l);
      if (blockedToastDedupeKeysRef.current.has(dk)) {
        seenRef.current.add(id);
        continue;
      }
      seenRef.current.add(id);
      blockedToastDedupeKeysRef.current.add(dk);
      adds.push({
        id,
        createdAt: now,
        expiresAt: now + AUTO_DISMISS_MS,
        hovering: false,
        remainingMs: null,
        entering: true,
        tone: toneFromLog(l),
        log: l,
      });
      if (adds.length >= MAX_NEW_TOASTS_PER_TICK) break;
    }
    if (!adds.length) return;

    setToasts((prev) => {
      const merged = [...adds.reverse(), ...prev];
      return merged.slice(0, MAX_VISIBLE_TOASTS);
    });

    window.setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.entering ? { ...t, entering: false } : t)));
    }, 20);
  }, [logs, activityToastsAllowed]);

  useEffect(() => {
    if (!toasts.length) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) =>
        prev.filter((t) => {
          if (t.hovering || t.expiresAt > now) return true;
          blockedToastDedupeKeysRef.current.add(toastStableDedupeKey(t.log));
          return false;
        }),
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [toasts.length]);

  const close = (id: string) =>
    setToasts((prev) => {
      const row = prev.find((t) => t.id === id);
      if (row) blockedToastDedupeKeysRef.current.add(toastStableDedupeKey(row.log));
      return prev.filter((t) => t.id !== id);
    });

  const setHover = (id: string, on: boolean) => {
    setToasts((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (on) {
          const remaining = Math.max(0, t.expiresAt - Date.now());
          return { ...t, hovering: true, remainingMs: remaining };
        }
        const remaining = t.remainingMs ?? AUTO_DISMISS_MS;
        return { ...t, hovering: false, remainingMs: null, expiresAt: Date.now() + remaining };
      }),
    );
  };

  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-20 z-50 flex w-[min(92vw,420px)] flex-col gap-2">
      {toasts.map((t) => {
        const bg =
          t.tone === "success"
            ? "bg-emerald-700"
            : "bg-rose-700";
        const border =
          t.tone === "success"
            ? "border-emerald-500/70"
            : "border-rose-500/70";
        const vm = buildToastViewModel(t.log);
        return (
          <div
            key={t.id}
            className={`pointer-events-auto overflow-hidden rounded-lg border ${border} ${bg} text-white shadow-xl transition-all duration-300 ease-out ${
              t.entering ? "translate-x-6 opacity-0" : t.hovering ? "translate-x-0 opacity-100" : "translate-x-0 opacity-80"
            }`}
            onMouseEnter={() => setHover(t.id, true)}
            onMouseLeave={() => setHover(t.id, false)}
          >
            <div className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-white/95">
                      {vm.title}
                    </div>
                    <div className="mt-0.5 text-sm font-medium leading-snug text-white">
                      {vm.headline}
                    </div>
                    {vm.sublines.length ? (
                      <div className="mt-0.5 space-y-0.5 text-[11px] leading-snug text-white/90">
                        {vm.sublines.map((s, i) => (
                          <div key={i} className="truncate">
                            {s}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md px-2 py-1 text-white/90 hover:bg-white/10"
                    aria-label="Close notification"
                    onClick={() => close(t.id)}
                  >
                    ×
                  </button>
                </div>

                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-white/90">
                  {vm.chips.map((c) => (
                    <span key={`${c.k}:${c.v}`} className="rounded bg-white/15 px-1.5 py-0.5">
                      {c.k}: <span className="font-semibold">{c.v}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

