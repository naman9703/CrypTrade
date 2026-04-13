/**
 * When Binance closes a USD-M position via exchange SL/TP/algo (not our reduce-only local bracket
 * enforcement), `recentLocalCloses` is empty and REALIZED_PNL income won't match — no CLOSE row in
 * trade history and bracket/trail memory can go stale. This module compares successive position
 * snapshots and enqueues the same `recentLocalCloses` hints used for local closes, before trail
 * memory is cleared on the next mark-to-market pass.
 */

function pickBracketTargets(map, symU) {
  const U = String(symU || "").toUpperCase();
  if (!map || typeof map !== "object") return null;
  for (const k of Object.keys(map)) {
    if (String(k).toUpperCase() === U) return map[k];
  }
  return null;
}

function findLastOpenTrade(trades, symU) {
  const U = String(symU || "").toUpperCase();
  if (!Array.isArray(trades)) return null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t?.type === "OPEN" && String(t.symbol || "").toUpperCase() === U) return t;
  }
  return null;
}

function inferSlTpFromMark(isLong, markPx, sl, tp) {
  if (!Number.isFinite(markPx) || markPx <= 0) return "SL";
  const eps = Math.max(markPx * 2e-4, markPx * 1e-6);
  const S = Number(sl);
  const T = Number(tp);
  if (isLong) {
    const nearSl = Number.isFinite(S) && markPx <= S + eps;
    const nearTp = Number.isFinite(T) && markPx >= T - eps;
    if (nearTp && !nearSl) return "TP";
    if (nearSl && !nearTp) return "SL";
    if (nearSl && nearTp && Number.isFinite(S) && Number.isFinite(T)) {
      return Math.abs(markPx - S) <= Math.abs(T - markPx) ? "SL" : "TP";
    }
  } else {
    const nearSl = Number.isFinite(S) && markPx >= S - eps;
    const nearTp = Number.isFinite(T) && markPx <= T + eps;
    if (nearTp && !nearSl) return "TP";
    if (nearSl && !nearTp) return "SL";
    if (nearSl && nearTp && Number.isFinite(S) && Number.isFinite(T)) {
      return Math.abs(markPx - S) <= Math.abs(markPx - T) ? "SL" : "TP";
    }
  }
  return "SL";
}

/**
 * @param {object} ctx
 * @param {object} ctx.mem
 * @param {() => Promise<any>} [ctx.publicGet]
 * @param {(symU: string) => void} ctx.clearMemBracketTrailForSymbol
 * @param {any} ctx.log
 */
export async function reconcileUsdMExternalClosesFromPositions(ctx, rawPositions) {
  const { mem, publicGet, clearMemBracketTrailForSymbol, log } = ctx;
  const cur = {};
  for (const p of rawPositions || []) {
    const u = String(p?.symbol || "").toUpperCase();
    const amt = Math.abs(Number(p?.positionAmt || 0));
    if (amt > 1e-8) cur[u] = amt;
  }
  const prev = mem.prevFuturesQtyBySymbol && typeof mem.prevFuturesQtyBySymbol === "object" ? mem.prevFuturesQtyBySymbol : {};
  for (const symU of Object.keys(prev)) {
    const was = Number(prev[symU]) || 0;
    if (was <= 1e-8) continue;
    if (cur[symU] > 1e-8) continue;

    const trMeta = mem.trailingBySymbol?.[symU];
    const trailStep = Number(trMeta?.trailStep) || 0;
    const exitViaTrailedStop = trailStep > 0;

    const openLeg = findLastOpenTrade(mem.trades, symU);
    const symDisplay = String(openLeg?.symbol || symU).toUpperCase();
    const strategy = openLeg?.strategy || "AUTO";
    const isLong = openLeg?.side === "BUY";
    const closeSide = isLong ? "SELL" : "BUY";

    let bracketType = "SL";
    let markPx = NaN;

    if (!exitViaTrailedStop && typeof publicGet === "function") {
      const pb = pickBracketTargets(mem.placedBracketTargets, symU);
      const sl = pb?.stopLoss ?? openLeg?.stopLoss;
      const tp = pb?.takeProfit ?? openLeg?.takeProfit;
      try {
        const d = await publicGet("/fapi/v1/premiumIndex", { symbol: symDisplay });
        markPx = Number(d?.markPrice);
      } catch {
        /* ignore */
      }
      bracketType = inferSlTpFromMark(isLong, markPx, sl, tp);
    }

    mem.recentLocalCloses = Array.isArray(mem.recentLocalCloses) ? mem.recentLocalCloses : [];
    mem.recentLocalCloses.push({
      symbol: symDisplay,
      closedAt: Date.now(),
      closeSide,
      strategy,
      bracketType,
      posId: `fut_${symDisplay}`,
      qty: openLeg?.qty != null ? Number(openLeg.qty) : undefined,
      entryPrice: openLeg?.price != null ? Number(openLeg.price) : undefined,
      stopLoss: openLeg?.stopLoss != null ? Number(openLeg.stopLoss) : undefined,
      takeProfit: openLeg?.takeProfit != null ? Number(openLeg.takeProfit) : undefined,
      leverage: openLeg?.meta?.leverage ?? openLeg?.leverage,
      markPx: Number.isFinite(markPx) ? markPx : undefined,
      exitViaTrailedStop,
      trailStepAtClose: trailStep,
      trailingMode: trMeta?.trailingMode != null ? String(trMeta.trailingMode) : undefined,
      exchangeNativeClose: true,
    });

    clearMemBracketTrailForSymbol?.(symU);

    log?.info?.("binance_usdm_external_close_hint", {
      symbol: symDisplay,
      bracketType,
      exitViaTrailedStop,
      trailStep,
    });
  }
  mem.prevFuturesQtyBySymbol = cur;
}
