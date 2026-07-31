export type LiqCascadeFeedRow = {
  ok: boolean;
  label: string;
  required?: boolean;
  source?: string | null;
  error?: string | null;
  connected?: boolean;
  running?: boolean;
  lastMessageAt?: number | null;
  lastError?: string | null;
  recentTickCount?: number;
  messageCount?: number;
  window4hUsd?: number | null;
  healthReason?: string | null;
  usdt?: number | null;
  change4hPct?: number | null;
  fetchedAt?: number | null;
  pending?: boolean;
  enabled?: boolean;
  botRunning?: boolean;
};

export type LiqCascadeFeedStatus = {
  symbol: string;
  allOk: boolean;
  updatedAt: number;
  feeds: {
    klines: LiqCascadeFeedRow;
    liquidations: LiqCascadeFeedRow;
    openInterest: LiqCascadeFeedRow;
    tickEngine: LiqCascadeFeedRow;
  };
};

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function FeedDot({ ok, required = true }: { ok: boolean; required?: boolean }) {
  const cls = !required
    ? "bg-slate-400"
    : ok
      ? "bg-emerald-500"
      : "bg-rose-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

function feedTitle(key: string, row: LiqCascadeFeedRow, symbol?: string): string {
  if (key === "klines") {
    return row.ok
      ? `Live OHLC klines (${row.source ?? "Binance"}) — chart + bar-close signals`
      : `Klines unavailable${row.error ? `: ${row.error}` : ""}. Set PAPER_MARKET_FEED=BINANCE_FUTURES`;
  }
  if (key === "liquidations") {
    if (row.ok) {
      return `Binance forceOrder stream connected · last msg ${fmtAge(row.lastMessageAt)} · ${row.recentTickCount ?? 0} ${symbol ?? ""} ticks (15m) · ${row.messageCount ?? 0} total msgs · 4h $${Math.round(Number(row.window4hUsd ?? 0)).toLocaleString()}`;
    }
    if (row.running && row.connected === false) {
      return `Connecting to liquidation stream${row.lastError ? `: ${row.lastError}` : "…"}`;
    }
    if (row.running && row.connected && row.healthReason === "stale") {
      return `Stream connected but quiet (${fmtAge(row.lastMessageAt)}). Waiting for forceOrder events…`;
    }
    if (row.healthReason === "not_running") {
      return `Liquidation stream not started — restart backend or select LIQ_CASCADE (auto-starts on status poll)`;
    }
    if (row.running && row.connected && !row.ok) {
      return `Stream connected but no recent messages (${fmtAge(row.lastMessageAt)}). Waiting for forceOrder events…`;
    }
    return `Liquidation stream unavailable${row.lastError ? `: ${row.lastError}` : ""}. Needs /market/ws/!forceOrder@arr`;
  }
  if (key === "openInterest") {
    if (row.ok) {
      return `Open interest live · ${row.usdt != null ? `$${(Number(row.usdt) / 1e9).toFixed(2)}B` : "—"} · 4h Δ ${row.change4hPct != null ? `${Number(row.change4hPct).toFixed(2)}%` : "—"}`;
    }
    if (row.pending) return "Fetching open interest from Binance…";
    return "Open interest unavailable — check backend network / Binance fapi";
  }
  if (key === "tickEngine") {
    if (!row.required) return "Live tick executor off — bar-close path only";
    return row.ok
      ? "Tick executor running — bot started + liquidation WS active"
      : "Tick executor not active — start bot with live-tick preset";
  }
  return row.label;
}

function feedStatusHint(key: string, row: LiqCascadeFeedRow): string {
  if (row.ok) return "OK";
  if (key === "openInterest" && row.pending) return "loading…";
  if (key === "liquidations") {
    if (row.healthReason === "connecting" || (row.running && !row.connected)) return "connecting…";
    if (row.healthReason === "starting" || row.healthReason === "not_running") return "starting…";
    if (row.healthReason === "connected" || row.healthReason === "stream_active") return "live";
    if (row.healthReason === "stale") return "quiet";
    if (row.lastError) return "error";
  }
  if (row.running && !row.connected) return "connecting…";
  return "missing";
}

export function LiqCascadeFeedStatusPanel({
  status,
  compact = false,
}: {
  status: LiqCascadeFeedStatus | null | undefined;
  compact?: boolean;
}) {
  if (!status?.feeds) {
    return (
      <div className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
        LIQ_CASCADE feed status pending…
      </div>
    );
  }

  const rows: { key: keyof LiqCascadeFeedStatus["feeds"]; row: LiqCascadeFeedRow }[] = [
    { key: "klines", row: status.feeds.klines },
    { key: "liquidations", row: status.feeds.liquidations },
    { key: "openInterest", row: status.feeds.openInterest },
    { key: "tickEngine", row: status.feeds.tickEngine },
  ];

  const visible = compact ? rows.filter((r) => r.row.required !== false) : rows;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 ${
        status.allOk
          ? "border-emerald-400/60 bg-emerald-50/80 dark:border-emerald-700/50 dark:bg-emerald-950/25"
          : "border-rose-400/60 bg-rose-50/80 dark:border-rose-700/50 dark:bg-rose-950/25"
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span
          className={`text-[11px] font-semibold uppercase tracking-wide ${
            status.allOk ? "text-emerald-800 dark:text-emerald-200" : "text-rose-800 dark:text-rose-200"
          }`}
        >
          Data feeds · {status.symbol}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            status.allOk
              ? "bg-emerald-600 text-white"
              : "bg-rose-600 text-white"
          }`}
        >
          {status.allOk ? "READY" : "NOT READY"}
        </span>
      </div>
      <div className={`flex ${compact ? "flex-wrap gap-x-3 gap-y-1" : "flex-col gap-1.5"}`}>
        {visible.map(({ key, row }) => (
          <div
            key={key}
            className={`inline-flex items-center gap-1.5 text-[11px] ${
              row.required === false ? "text-slate-500 dark:text-slate-400" : "text-slate-800 dark:text-slate-200"
            }`}
            title={feedTitle(key, row, status.symbol)}
          >
            <FeedDot ok={row.ok} required={row.required !== false} />
            <span className="font-medium">{row.label}</span>
            <span className="text-slate-500 dark:text-slate-400">
              {row.required === false ? "(optional)" : feedStatusHint(key, row)}
            </span>
          </div>
        ))}
      </div>
      {!compact && !status.allOk && status.feeds.liquidations.ok === false ? (
        <p className="mt-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Liquidations WS: {status.feeds.liquidations.healthReason ?? "unknown"}
          {status.feeds.liquidations.lastError ? ` — ${status.feeds.liquidations.lastError}` : ""}
          {status.feeds.liquidations.streamUrl ? ` · ${status.feeds.liquidations.streamUrl}` : ""}
        </p>
      ) : null}
      {!compact && (
        <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
          Green = live data flowing. Red = required feed missing — strategy will not fire reliably.
        </p>
      )}
    </div>
  );
}

export function LiqCascadeFeedHeaderStrip({
  status,
}: {
  status: LiqCascadeFeedStatus | null | undefined;
}) {
  if (!status?.feeds) return null;
  const f = status.feeds;
  const items = [
    { label: "Kline", ok: f.klines.ok, title: feedTitle("klines", f.klines, status.symbol) },
    { label: "Liq", ok: f.liquidations.ok, title: feedTitle("liquidations", f.liquidations, status.symbol) },
    { label: "OI", ok: f.openInterest.ok, title: feedTitle("openInterest", f.openInterest, status.symbol) },
  ];
  if (f.tickEngine.required) {
    items.push({ label: "Tick", ok: f.tickEngine.ok, title: feedTitle("tickEngine", f.tickEngine, status.symbol) });
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-slate-700 dark:text-slate-300"
      title={status.allOk ? "All LIQ_CASCADE feeds ready" : "One or more LIQ_CASCADE feeds missing"}
    >
      <FeedDot ok={status.allOk} />
      <span className="font-medium">LIQ</span>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-0.5" title={it.title}>
          <FeedDot ok={it.ok} />
          {it.label}
        </span>
      ))}
    </span>
  );
}
