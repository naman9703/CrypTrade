import { SITUATIONS } from "../situationConstants.js";
import {
  scanLhFadeLong,
  scanRetestLong,
  scanDisplacementLong,
  scanFailLong,
  scanExhaustionShort,
} from "../setupScanners.js";

const TRIGGERS = [
  "lh_fade_long",
  "retest_long",
  "displacement_long",
  "fail_long",
  "exhaustion_short",
];

export function scanBreakoutBull(candles, idx, pre, dayState, opts = {}, enabled = TRIGGERS) {
  const scans = {
    lh_fade_long: scanLhFadeLong,
    retest_long: scanRetestLong,
    displacement_long: scanDisplacementLong,
    fail_long: scanFailLong,
    exhaustion_short: scanExhaustionShort,
  };
  const out = [];
  for (const t of enabled) {
    if (!scans[t]) continue;
    const setup = scans[t](candles, idx, pre, dayState, opts);
    if (setup) out.push({ ...setup, playbook: "breakoutBull", situation: SITUATIONS.BREAKOUT_BULL });
  }
  return out;
}
