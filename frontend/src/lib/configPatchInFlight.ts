/**
 * Guards so high-frequency WS `state` frames cannot revert fields the user just
 * changed via `/api/bot/config` (before HTTP ack, or from stale frames after ack).
 */
const IN_FLIGHT_MS = 4000;
/** After HTTP confirms a patch, WS multiplex ticks may still carry pre-patch bot fields. */
const WS_ACK_GUARD_MS = 12000;
/** Strategy Save reloads the engine but WS ticks can lag for minutes (e.g. during backtests). */
export const STRATEGY_SAVE_WS_GUARD_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map<string, { value: unknown; until: number }>();
const wsAckGuard = new Map<string, { value: unknown; until: number }>();

/** Expand paired gate flags + SMC profile side-effects so WS cannot revert preset patches. */
export function expandBotConfigPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  if (
    Object.prototype.hasOwnProperty.call(patch, "intradayGateSmcIct") ||
    Object.prototype.hasOwnProperty.call(patch, "intradaySmcIctMode")
  ) {
    const smcOn = patch.intradayGateSmcIct === true || patch.intradaySmcIctMode === true;
    out.intradayGateSmcIct = smcOn;
    out.intradaySmcIctMode = smcOn;
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "intradayGateInstitutionalSr") ||
    Object.prototype.hasOwnProperty.call(patch, "intradaySrAPlusMode")
  ) {
    const instOn = patch.intradayGateInstitutionalSr === true || patch.intradaySrAPlusMode === true;
    out.intradayGateInstitutionalSr = instOn;
    out.intradaySrAPlusMode = instOn;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "intradaySmcPickMode")) {
    const pm = String(patch.intradaySmcPickMode).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(patch, "intradaySmcOneTradePerDay")) {
      out.intradaySmcOneTradePerDay = pm !== "per_signal";
    }
  }
  return out;
}

export function noteBotConfigPatchInFlight(patch: Record<string, unknown>) {
  const expanded = expandBotConfigPatch(patch);
  const until = Date.now() + IN_FLIGHT_MS;
  for (const [key, value] of Object.entries(expanded)) {
    if (value === undefined || key === "uiChartFocusSymbol") continue;
    inFlight.set(key, { value, until });
  }
}

export function clearBotConfigPatchInFlight(patch: Record<string, unknown>) {
  const expanded = expandBotConfigPatch(patch);
  for (const key of Object.keys(expanded)) {
    if (key === "uiChartFocusSymbol") continue;
    inFlight.delete(key);
    wsAckGuard.delete(key);
  }
}

export function patchValueAcked(serverVal: unknown, patchVal: unknown): boolean {
  if (typeof patchVal === "boolean") return serverVal === patchVal;
  if (patchVal === null) return serverVal == null;
  if (typeof patchVal === "number" && typeof serverVal === "number") {
    return Math.abs(patchVal - serverVal) < 1e-12;
  }
  return JSON.stringify(serverVal) === JSON.stringify(patchVal);
}

/** Drop draft keys the server has already applied (immediate `api.botConfig` ack). */
export function pruneDraftBotPatchAcked(
  draft: Record<string, unknown>,
  patch: Record<string, unknown>,
  serverBot: Record<string, unknown>,
): Record<string, unknown> {
  const expanded = expandBotConfigPatch(patch);
  const next = { ...draft };
  for (const [key, patchVal] of Object.entries(expanded)) {
    if (key === "uiChartFocusSymbol" || patchVal === undefined) continue;
    if (patchValueAcked(serverBot[key], patchVal)) delete next[key];
  }
  return next;
}

/**
 * HTTP `/api/bot/config` echoed the patch — extend guards so trailing WS frames
 * cannot revert checkboxes (do not delete in-flight on ack).
 */
export function clearBotConfigPatchInFlightWhenAcked(
  patch: Record<string, unknown>,
  serverBot: Record<string, unknown>,
) {
  const expanded = expandBotConfigPatch(patch);
  const now = Date.now();
  const ackUntil = now + WS_ACK_GUARD_MS;
  const flightUntil = now + IN_FLIGHT_MS;
  for (const key of Object.keys(expanded)) {
    if (key === "uiChartFocusSymbol") continue;
    const patchVal = expanded[key];
    if (!patchValueAcked(serverBot[key], patchVal)) continue;
    wsAckGuard.set(key, { value: patchVal, until: ackUntil });
    inFlight.set(key, { value: patchVal, until: flightUntil });
  }
}

/**
 * After strategy Save, pin signal-brain fields so trailing WS `state` frames cannot revert
 * a fresh DB reload (backtests and long runs exceed the 12s `/api/bot/config` guard).
 */
export function noteStrategySaveWsAckGuard(savedBot: Record<string, unknown>) {
  const now = Date.now();
  const until = now + STRATEGY_SAVE_WS_GUARD_MS;
  for (const [key, value] of Object.entries(savedBot)) {
    if (key === "uiChartFocusSymbol") continue;
    wsAckGuard.set(key, { value, until });
  }
}

/** Overlay guards onto merged bot snapshot (WS / hello / HTTP hydrate). */
export function applyBotConfigPatchInFlight(bot: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const out = { ...bot };

  for (const [key, entry] of wsAckGuard) {
    if (now > entry.until) {
      wsAckGuard.delete(key);
      continue;
    }
    if (!patchValueAcked(out[key], entry.value)) {
      out[key] = entry.value;
    }
  }

  for (const [key, entry] of inFlight) {
    if (now > entry.until) {
      inFlight.delete(key);
      continue;
    }
    out[key] = entry.value;
  }
  return out;
}

/** Guard live bot from stale WS, then apply unsaved draft (draft wins on key overlap). */
export function composeViewBotFromLiveAndDraft(
  liveBot: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  return { ...applyBotConfigPatchInFlight(liveBot), ...draft };
}
