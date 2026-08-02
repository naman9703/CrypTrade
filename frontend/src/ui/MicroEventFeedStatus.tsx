export type MicroEventFeedRow = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type MicroEventFeedStatus = {
  symbol: string;
  watchSymbols: string[];
  ok: boolean;
  autotradeEligible: boolean;
  rows: MicroEventFeedRow[];
  updatedAt: number;
};

function FeedDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-500"}`}
      aria-hidden
    />
  );
}

export function MicroEventFeedStatusPanel({ status }: { status?: MicroEventFeedStatus | null }) {
  if (!status) {
    return (
      <div className="rounded border border-violet-300/40 bg-violet-50/30 p-2 text-[10px] text-slate-600 dark:border-violet-800/40 dark:bg-slate-950/30">
        Select <span className="font-semibold">MICRO_EVENT</span> and start the bot to load feed status.
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded border border-violet-300/40 bg-violet-50/30 p-2 dark:border-violet-800/40 dark:bg-slate-950/30">
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="font-semibold text-violet-950 dark:text-violet-100">Microstructure feeds</span>
        <FeedDot ok={status.ok} />
        <span className={status.autotradeEligible ? "text-emerald-700" : "text-amber-700"}>
          {status.autotradeEligible ? "Autotrade eligible" : "Feeds warming up"}
        </span>
        {status.watchSymbols?.length > 1 ? (
          <span className="text-slate-500">Watch: {status.watchSymbols.join(", ")}</span>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {status.rows.map((row) => (
          <li key={row.id} className="flex items-start gap-2 text-[10px] text-slate-700 dark:text-slate-300">
            <FeedDot ok={row.ok} />
            <span>
              <span className="font-semibold">{row.label}</span>
              <span className="ml-1 text-slate-500">— {row.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
