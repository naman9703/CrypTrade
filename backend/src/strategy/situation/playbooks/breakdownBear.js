import { SITUATIONS } from "../situationConstants.js";
import {
  scanLhFadeShort,
  scanRetestShort,
  scanDisplacementShort,
  scanFailShort,
  scanExhaustionLong,
} from "../setupScanners.js";

const TRIGGERS = [
  "lh_fade_short",
  "retest_short",
  "displacement_short",
  "fail_short",
  "exhaustion_long",
];

export function scanBreakdownBear(candles, idx, pre, dayState, opts = {}, enabled = TRIGGERS) {
  const scans = {
    lh_fade_short: scanLhFadeShort,
    retest_short: scanRetestShort,
    displacement_short: scanDisplacementShort,
    fail_short: scanFailShort,
    exhaustion_long: scanExhaustionLong,
  };
  const out = [];
  for (const t of enabled) {
    if (!scans[t]) continue;
    const setup = scans[t](candles, idx, pre, dayState, opts);
    if (setup) out.push({ ...setup, playbook: "breakdownBear", situation: SITUATIONS.BREAKDOWN_BEAR });
  }
  return out;
}
