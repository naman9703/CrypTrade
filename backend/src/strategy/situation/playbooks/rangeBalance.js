import { SITUATIONS } from "../situationConstants.js";
import {
  scanClassicalPdlReclaim,
  scanClassicalPdhReclaim,
  scanSessionExtremeFade,
  scanLhFadeShort,
  scanDisplacementShort,
  scanRetestShort,
} from "../setupScanners.js";

export function scanRangeBalance(candles, idx, pre, dayState, situation, opts = {}, enabled = []) {
  const out = [];
  const allow = new Set(
    enabled.length
      ? enabled
      : ["lh_fade_short", "displacement_short", "retest_short", "session_extreme_fade", "classical_pdl_reclaim", "classical_pdh_reclaim"],
  );

  if (situation === SITUATIONS.RANGE_ABOVE_PDL) {
    if (allow.has("lh_fade_short")) {
      const s = scanLhFadeShort(candles, idx, pre, dayState, opts);
      if (s) out.push({ ...s, playbook: "rangeBalance", situation });
    }
    if (allow.has("displacement_short")) {
      const s = scanDisplacementShort(candles, idx, pre, dayState, opts);
      if (s) out.push({ ...s, playbook: "rangeBalance", situation });
    }
    if (allow.has("classical_pdl_reclaim")) {
      const s = scanClassicalPdlReclaim(candles, idx, pre, dayState, opts);
      if (s) out.push({ ...s, playbook: "rangeBalance", situation });
    }
  }

  if (situation === SITUATIONS.RANGE_BELOW_PDH) {
    if (allow.has("retest_short")) {
      const s = scanRetestShort(candles, idx, pre, dayState, opts);
      if (s) out.push({ ...s, playbook: "rangeBalance", situation });
    }
    if (allow.has("classical_pdh_reclaim")) {
      const s = scanClassicalPdhReclaim(candles, idx, pre, dayState, opts);
      if (s) out.push({ ...s, playbook: "rangeBalance", situation });
    }
  }

  if (allow.has("session_extreme_fade")) {
    const s = scanSessionExtremeFade(candles, idx, pre, dayState, opts);
    if (s) out.push({ ...s, playbook: "rangeBalance", situation });
  }

  return out;
}
