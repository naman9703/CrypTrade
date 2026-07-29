/**
 * Displacement leg search without requiring BOS — for H1-aligned LTF entry.
 */

import { passesDisplacementAt } from "./displacement.js";

/**
 * First displacement candle in [fromIdx, toIdx] in trade direction.
 * @returns {{ ok: boolean, dispIdx: number }}
 */
export function findDisplacementLegInRange(candles, fromIdx, toIdx, side, opts = {}, pre = null) {
  const lo = Math.max(0, Math.floor(fromIdx));
  const hi = Math.min(candles.length - 1, Math.floor(toIdx));
  for (let m = lo; m <= hi; m++) {
    if (passesDisplacementAt(candles, m, side, opts, pre)) {
      return { ok: true, dispIdx: m };
    }
  }
  return { ok: false, dispIdx: -1 };
}
