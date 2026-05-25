/**
 * Short-lived guard so high-frequency WS `state` frames cannot revert a checkbox
 * the user just toggled via `/api/bot/config` before the HTTP response lands.
 */
const IN_FLIGHT_MS = 4000;
const inFlight = new Map<string, { value: unknown; until: number }>();

export function noteBotConfigPatchInFlight(patch: Record<string, unknown>) {
  const until = Date.now() + IN_FLIGHT_MS;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === "uiChartFocusSymbol") continue;
    inFlight.set(key, { value, until });
  }
}

export function clearBotConfigPatchInFlight(patch: Record<string, unknown>) {
  for (const key of Object.keys(patch)) {
    if (key === "uiChartFocusSymbol") continue;
    inFlight.delete(key);
  }
}

function patchValueAcked(serverVal: unknown, patchVal: unknown): boolean {
  if (typeof patchVal === "boolean") return serverVal === patchVal;
  if (patchVal === null) return serverVal == null;
  return JSON.stringify(serverVal) === JSON.stringify(patchVal);
}

/**
 * Drop in-flight guards only for keys the HTTP response already reflects.
 * Prevents a trailing WS frame from reverting a checkbox before the server echoes the new value.
 */
export function clearBotConfigPatchInFlightWhenAcked(
  patch: Record<string, unknown>,
  serverBot: Record<string, unknown>,
) {
  for (const key of Object.keys(patch)) {
    if (key === "uiChartFocusSymbol") continue;
    if (!inFlight.has(key)) continue;
    if (patchValueAcked(serverBot[key], patch[key])) {
      inFlight.delete(key);
    }
  }
}

/** Overlay in-flight patch values onto merged bot snapshot (WS / hello). */
export function applyBotConfigPatchInFlight(bot: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const out = { ...bot };
  for (const [key, entry] of inFlight) {
    if (now > entry.until) {
      inFlight.delete(key);
      continue;
    }
    out[key] = entry.value;
  }
  return out;
}
