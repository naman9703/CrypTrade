/** Resolve instance id stamped on a WS/audit trade row. */
export function tradeRowInstanceId(t: unknown): string {
  if (!t || typeof t !== "object") return "";
  const row = t as Record<string, unknown>;
  if (typeof row.instanceId === "string" && row.instanceId.trim()) return row.instanceId.trim();
  const meta = row.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const iid = (meta as Record<string, unknown>).instanceId;
    if (typeof iid === "string" && iid.trim()) return iid.trim();
  }
  return "";
}

/**
 * Instance-view filter for portfolio trades.
 * Tagged rows must match; untagged legacy rows only show on the active instance for the mode.
 */
export function tradeBelongsToInstance(
  t: unknown,
  instanceId: string,
  isActiveForMode: boolean,
): boolean {
  if (!instanceId) return true;
  const iid = tradeRowInstanceId(t);
  if (iid) return iid === instanceId;
  return isActiveForMode;
}

export function positionRowInstanceId(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const row = p as Record<string, unknown>;
  if (typeof row.instanceId === "string" && row.instanceId.trim()) return row.instanceId.trim();
  const meta = row.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const iid = (meta as Record<string, unknown>).instanceId;
    if (typeof iid === "string" && iid.trim()) return iid.trim();
  }
  return "";
}

function findLivePositionForTradeId(positions: unknown[], tradeId: unknown): boolean {
  const tid = String(tradeId ?? "").trim();
  if (!tid || !Array.isArray(positions)) return false;
  for (const p of positions) {
    if (!p || typeof p !== "object") continue;
    const pid = String((p as { id?: unknown }).id ?? "").trim();
    if (!pid) continue;
    if (pid === tid) return true;
    const parts = pid.split("_");
    if (parts.length >= 2 && parts.slice(1).join("_") === tid) return true;
    if (tid.includes("_")) {
      const tParts = tid.split("_");
      if (tParts.length >= 2 && tParts.slice(1).join("_") === pid) return true;
    }
  }
  return false;
}

function tradeRowStatus(t: unknown): string {
  if (!t || typeof t !== "object") return "";
  const row = t as Record<string, unknown>;
  const st = String(row.status ?? "").toUpperCase();
  if (st === "OPEN" || st === "CLOSED") return st;
  return String(row.type ?? "").toUpperCase();
}

/** Filter venue positions to those owned by this instance (or legacy orphans on the active instance). */
export function filterPositionsForInstance(
  positions: unknown[],
  trades: unknown[],
  instanceId: string,
  isActiveForMode: boolean,
): unknown[] {
  const rows = Array.isArray(positions) ? positions : [];
  if (!instanceId) return rows;
  const tradesAll = Array.isArray(trades) ? trades : [];
  const openForInst = tradesAll.filter(
    (t) => tradeRowStatus(t) === "OPEN" && tradeBelongsToInstance(t, instanceId, isActiveForMode),
  );
  return rows.filter((p) => {
    const tagged = positionRowInstanceId(p);
    if (tagged) return tagged === instanceId;
    for (const t of openForInst) {
      if (findLivePositionForTradeId([p], (t as { id?: unknown })?.id)) return true;
    }
    const claimedElsewhere = tradesAll.some((t) => {
      if (tradeRowStatus(t) !== "OPEN") return false;
      if (!findLivePositionForTradeId([p], (t as { id?: unknown })?.id)) return false;
      return !tradeBelongsToInstance(t, instanceId, false);
    });
    if (claimedElsewhere) return false;
    return isActiveForMode;
  });
}
