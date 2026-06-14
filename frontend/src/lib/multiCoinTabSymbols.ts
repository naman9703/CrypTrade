function normSymbols(raw: unknown, max = 12): string[] {
  return [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .map((x) => String(x || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, max);
}

/**
 * Symbols for multi-coin chart tabs + realtime signal row.
 * Chart/watch uses pins and custom lists even when Pick control is Auto (pins only gate autotrade).
 */
export function computeMultiCoinTabSymbols(bot: Record<string, unknown> | null | undefined): string[] {
  const multi = String(bot?.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
  const customBase = String(bot?.universeCoinBase || "ALL").toUpperCase() === "CUSTOM";

  const customSyms = normSymbols(bot?.universeCustomSymbols, 10);
  /** Custom base is authoritative for chart tabs — pins only gate autotrade, they must not hide other custom picks (e.g. XAUT). */
  if (customBase && customSyms.length) return customSyms;

  const pins = normSymbols(bot?.universePinnedSymbols, 10);
  if (pins.length) return pins;

  const serverTabs = normSymbols(bot?.multiCoinSignalTabSymbols, 12);
  if (serverTabs.length) return serverTabs;

  if (!multi) return [];

  const sel = Array.isArray(bot?.universe?.selected) ? bot.universe.selected : [];
  const ranked = Array.isArray(bot?.universe?.ranked)
    ? (bot.universe.ranked as { symbol?: string }[]).map((r) => r?.symbol).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const s of sel) {
    const u = String(s || "").trim().toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    merged.push(u);
  }
  for (const s of ranked) {
    const u = String(s || "").trim().toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    merged.push(u);
  }
  return merged.length ? merged.slice(0, 12) : [];
}

/** Primary symbol, or multi-watch list; always at least primary when set. */
export function computeRegimeStripSymbols(bot: Record<string, unknown> | null | undefined): string[] {
  const primary = String(bot?.symbol || "").trim().toUpperCase();
  const multi = computeMultiCoinTabSymbols(bot);
  if (multi.length) return multi;
  return primary ? [primary] : [];
}
