/**
 * ICT PD-array inducement — price runs beyond a candidate OB/FVG (grabs early
 * stops) before returning into the zone for entry. Opt-in gate for never-green
 * "first reactive zone" losers.
 */

/**
 * @param {object[]} candles
 * @param {{ top: number, bottom: number }} zone
 * @param {'BUY'|'SELL'} side
 * @param {number} formedIdx bar the array completed / OB printed
 * @param {number} entryIdx candidate entry bar (exclusive of pierce scan end)
 * @returns {boolean}
 */
export function pdArrayWasInduced(candles, zone, side, formedIdx, entryIdx) {
  if (!zone || !candles?.length) return false;
  const from = Math.max(0, Math.floor(formedIdx));
  const to = Math.min(candles.length - 1, Math.floor(entryIdx));
  if (!(to > from)) return false;

  const lo = Math.min(Number(zone.bottom), Number(zone.top));
  const hi = Math.max(Number(zone.bottom), Number(zone.top));
  if (!(lo > 0) || !(hi > 0) || !(hi >= lo)) return false;

  for (let j = from + 1; j < to; j++) {
    const b = candles[j];
    if (!b) continue;
    // Pierce beyond the array's protective edge (liquidity grab of the zone).
    if (side === "BUY" && Number(b.low) < lo) return true;
    if (side === "SELL" && Number(b.high) > hi) return true;
  }
  return false;
}

/**
 * Resolve formed index for FVG or OB meta objects used by SMC orchestrator.
 * @param {object|null} fvg
 * @param {object|null} ob
 * @param {'fvg'|'ob'|'fvg_mid'|string} entryZone
 */
export function resolvePdFormedIdx(fvg, ob, entryZone) {
  if (entryZone === "ob" && ob) {
    return Number(ob.obIdx ?? ob.displacementIdx ?? -1);
  }
  if ((entryZone === "fvg" || entryZone === "fvg_mid") && fvg) {
    return Number(fvg.formedIdx ?? -1);
  }
  if (fvg?.formedIdx != null) return Number(fvg.formedIdx);
  if (ob?.obIdx != null) return Number(ob.obIdx);
  return -1;
}

/**
 * Active zone object for the chosen entryZone label.
 */
export function resolveActivePdZone(fvg, ob, entryZone) {
  if (entryZone === "ob") return ob;
  if (entryZone === "fvg" || entryZone === "fvg_mid") return fvg;
  return fvg || ob || null;
}
