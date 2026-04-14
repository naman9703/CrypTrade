import type { OhlcBar } from "./chartOhlc";

/** `open` = no opposite signal yet (includes chronologically latest); boolean = indicator “efficiency”; null = missing bar price. */
export type SupertrendSignalVerdict = "open" | boolean | null;

export type SupertrendSignalHistLike = {
  ts: number;
  side: "BUY" | "SELL";
  /** When set (from server), use this instead of OHLC lookup for bar close price. */
  signalBarClose?: number | null;
};

/**
 * Position price = bar close at signal time (UTC bar second = floor(ts/1000)).
 *
 * - **BUY** row: Open until the **next** SELL (in time). Then True if buy price &lt; that sell price, else False.
 * - **SELL** row: Open until the **next** BUY. Then True if sell price &gt; that buy price, else False.
 *
 * The latest signal in time is always Open (no opposite after it yet). Earlier same-side signals in a run each
 * resolve against the **first** opposite that appears after that row.
 */
export function computeSupertrendSignalVerdicts(
  rowsOldestFirst: SupertrendSignalHistLike[],
  ohlc: OhlcBar[],
): SupertrendSignalVerdict[] {
  const closeBySec = new Map<number, number>();
  for (const b of ohlc) {
    const t = Number(b.time);
    const c = Number(b.close);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) closeBySec.set(t, c);
  }

  function closeAtSignalTs(row: SupertrendSignalHistLike): number | null {
    const fromRow =
      row.signalBarClose != null &&
      Number.isFinite(Number(row.signalBarClose)) &&
      Number(row.signalBarClose) > 0
        ? Number(row.signalBarClose)
        : null;
    if (fromRow != null) return fromRow;
    const sec = Math.floor(Number(row.ts) / 1000);
    const c = closeBySec.get(sec);
    return c != null && Number.isFinite(c) && c > 0 ? c : null;
  }

  const n = rowsOldestFirst.length;
  const out: SupertrendSignalVerdict[] = Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const row = rowsOldestFirst[i]!;
    const p = closeAtSignalTs(row);

    if (row.side === "BUY") {
      let j = i + 1;
      while (j < n && rowsOldestFirst[j]!.side !== "SELL") j++;
      if (j >= n) {
        out[i] = "open";
        continue;
      }
      const sp = closeAtSignalTs(rowsOldestFirst[j]!);
      if (p == null || sp == null) out[i] = null;
      else out[i] = p < sp;
    } else {
      let j = i + 1;
      while (j < n && rowsOldestFirst[j]!.side !== "BUY") j++;
      if (j >= n) {
        out[i] = "open";
        continue;
      }
      const bp = closeAtSignalTs(rowsOldestFirst[j]!);
      if (p == null || bp == null) out[i] = null;
      else out[i] = p > bp;
    }
  }

  return out;
}

export function formatSupertrendSignalVerdict(v: SupertrendSignalVerdict): string {
  if (v === "open") return "Open";
  if (v === true) return "True";
  if (v === false) return "False";
  return "—";
}

/** Map server flip snapshot to verdict using same ordering as `computeSupertrendSignalVerdicts`. */
export function verdictForHistorySnap(
  snap: { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
  rowsOldestFirst: SupertrendSignalHistLike[],
  verdicts: SupertrendSignalVerdict[],
): SupertrendSignalVerdict | null {
  if (!snap || snap.ts == null) return null;
  const ts = Number(snap.ts);
  if (!Number.isFinite(ts)) return null;
  const side = snap.buySignal ? ("BUY" as const) : snap.sellSignal ? ("SELL" as const) : null;
  if (!side) return null;
  const sec = Math.floor(ts / 1000);
  for (let i = rowsOldestFirst.length - 1; i >= 0; i--) {
    const h = rowsOldestFirst[i]!;
    if (h.side !== side) continue;
    if (Math.floor(Number(h.ts) / 1000) !== sec) continue;
    return verdicts[i] ?? null;
  }
  return null;
}
