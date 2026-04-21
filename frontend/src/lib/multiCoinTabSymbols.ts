/** Symbols shown for multi-coin ST / regime UI (matches server `multiCoinSignalTabSymbols` when set). */
export function computeMultiCoinTabSymbols(bot: Record<string, unknown> | null | undefined): string[] {
  const multi = String(bot?.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
  if (!multi) return [];
  const serverTabs = Array.isArray(bot?.multiCoinSignalTabSymbols)
    ? [
        ...new Set(
          (bot.multiCoinSignalTabSymbols as string[])
            .map((x: string) => String(x || "").trim().toUpperCase())
            .filter(Boolean),
        ),
      ]
    : [];
  if (serverTabs.length) return serverTabs;
  const manual = String(bot?.universePinControl || "").toUpperCase() === "MANUAL";
  const pins = Array.isArray(bot?.universePinnedSymbols) ? bot.universePinnedSymbols : [];
  if (manual && pins.length) {
    return [...new Set(pins.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  }
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
