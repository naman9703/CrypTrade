/**
 * Monthly returns heatmap — rows = year, columns = month. Colour intensity
 * scales with the cell PnL relative to the run's max absolute monthly PnL.
 */
type Props = {
  monthly: Record<string, number>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function MonthlyHeatmapTable({ monthly }: Props) {
  const entries = Object.entries(monthly ?? {});
  if (!entries.length) return <div className="py-8 text-center text-sm text-slate-500">No monthly data</div>;
  const byYear = new Map<number, Map<number, number>>();
  let maxAbs = 0;
  for (const [k, v] of entries) {
    const [yStr, mStr] = k.split("-");
    const y = Number(yStr);
    const m = Number(mStr) - 1;
    if (!Number.isFinite(y) || !Number.isFinite(m)) continue;
    const yMap = byYear.get(y) ?? new Map<number, number>();
    yMap.set(m, Number(v));
    byYear.set(y, yMap);
    if (Math.abs(Number(v)) > maxAbs) maxAbs = Math.abs(Number(v));
  }
  const years = [...byYear.keys()].sort();

  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-1 text-center font-mono">
                {m}
              </th>
            ))}
            <th className="px-2 py-1 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const row = byYear.get(y)!;
            let total = 0;
            return (
              <tr key={y}>
                <td className="px-2 py-1 font-mono">{y}</td>
                {MONTHS.map((m, i) => {
                  const v = row.get(i);
                  if (v != null) total += v;
                  return (
                    <td key={m} className="px-1 py-1 text-center">
                      {v != null ? <Cell value={v} maxAbs={maxAbs} /> : <span className="text-slate-400">·</span>}
                    </td>
                  );
                })}
                <td className={`px-2 py-1 text-right font-mono ${total >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {total.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ value, maxAbs }: { value: number; maxAbs: number }) {
  const pct = maxAbs > 0 ? Math.min(1, Math.abs(value) / maxAbs) : 0;
  const bg =
    value > 0
      ? `rgba(16, 185, 129, ${0.2 + pct * 0.6})`
      : value < 0
        ? `rgba(244, 63, 94, ${0.2 + pct * 0.6})`
        : "transparent";
  return (
    <div className="rounded px-1.5 py-0.5 font-mono" style={{ background: bg }}>
      {value.toFixed(1)}
    </div>
  );
}
