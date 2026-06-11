import { SITUATIONS } from "../situationConstants.js";
import {
  scanSqueezeBreak,
  scanDisplacementShort,
  scanDisplacementLong,
  scanLhFadeLong,
} from "../setupScanners.js";

export function scanSqueezePlaybook(candles, idx, pre, dayState, opts = {}, enabled = []) {
  const allow = new Set(
    enabled.length ? enabled : ["lh_fade_long", "squeeze_break", "displacement_short", "displacement_long"],
  );
  const out = [];
  if (allow.has("lh_fade_long")) {
    const s = scanLhFadeLong(candles, idx, pre, dayState, opts);
    if (s) out.push({ ...s, playbook: "squeezeBreak", situation: SITUATIONS.SQUEEZE });
  }
  if (allow.has("squeeze_break")) {
    const s = scanSqueezeBreak(candles, idx, pre, dayState, opts);
    if (s) out.push({ ...s, playbook: "squeezeBreak", situation: SITUATIONS.SQUEEZE });
  }
  if (allow.has("displacement_short")) {
    const s = scanDisplacementShort(candles, idx, pre, dayState, opts);
    if (s) out.push({ ...s, playbook: "squeezeBreak", situation: SITUATIONS.SQUEEZE });
  }
  if (allow.has("displacement_long")) {
    const s = scanDisplacementLong(candles, idx, pre, dayState, opts);
    if (s) out.push({ ...s, playbook: "squeezeBreak", situation: SITUATIONS.SQUEEZE });
  }
  return out;
}
