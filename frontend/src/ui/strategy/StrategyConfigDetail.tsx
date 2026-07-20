import type { StrategyConfigSection } from "../../lib/strategyVersionFullConfig";

type Props = {
  sections: StrategyConfigSection[];
};

export function StrategyConfigDetail({ sections }: Props) {
  if (!sections.length) {
    return <p className="text-[11px] text-slate-500">No configuration saved yet.</p>;
  }
  return (
    <div className="space-y-3">
      {sections.map((sec) => (
        <div
          key={sec.title}
          className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{sec.title}</h4>
          <div className="space-y-0.5">
            {sec.rows.map((row) => (
              <div key={`${sec.title}-${row.label}`} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-slate-500">{row.label}</span>
                <span
                  className={
                    row.enabled === true
                      ? "rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : row.enabled === false
                        ? "font-mono text-slate-500"
                        : "max-w-[55%] truncate text-right font-mono text-slate-800 dark:text-slate-200"
                  }
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
