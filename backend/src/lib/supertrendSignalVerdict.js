/**
 * Same flip-resolution rules as `frontend/src/lib/supertrendSignalVerdict.ts` (indicator efficiency vs next opposite).
 * @param {Array<{ ts: number, side: 'BUY'|'SELL' }>} rowsOldestFirst
 * @param {Map<number, number>} closeBySec — bar open time in **seconds** (UTC) → close price
 * @returns {(boolean|"open"|null)[]}
 */
export function computeSupertrendSignalVerdictsBackend(rowsOldestFirst, closeBySec) {
  const rows = Array.isArray(rowsOldestFirst) ? rowsOldestFirst : [];
  const n = rows.length;
  const out = Array(n).fill(null);

  function closeAtSignalTs(ts) {
    const sec = Math.floor(Number(ts) / 1000);
    const c = closeBySec.get(sec);
    return c != null && Number.isFinite(c) && c > 0 ? c : null;
  }

  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const p = closeAtSignalTs(row.ts);

    if (row.side === "BUY") {
      let j = i + 1;
      while (j < n && rows[j].side !== "SELL") j++;
      if (j >= n) {
        out[i] = "open";
        continue;
      }
      const sp = closeAtSignalTs(rows[j].ts);
      if (p == null || sp == null) out[i] = null;
      else out[i] = p < sp;
    } else {
      let j = i + 1;
      while (j < n && rows[j].side !== "BUY") j++;
      if (j >= n) {
        out[i] = "open";
        continue;
      }
      const bp = closeAtSignalTs(rows[j].ts);
      if (p == null || bp == null) out[i] = null;
      else out[i] = p > bp;
    }
  }
  return out;
}

/** Build close-by-second map from Binance kline rows (ts = open time ms). */
export function closeBySecFromKlines(klines) {
  const m = new Map();
  for (const k of klines || []) {
    const ts = Number(k.ts);
    const c = Number(k.close);
    if (!Number.isFinite(ts) || !Number.isFinite(c) || c <= 0) continue;
    m.set(Math.floor(ts / 1000), c);
  }
  return m;
}
