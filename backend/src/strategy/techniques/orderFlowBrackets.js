/**
 * Order-flow entry brackets — guide Step 6–7.
 * SL beyond absorption; TP1 @ 1R (partial); TP2 at opposing VP level (POC/VAH/VAL).
 */

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} entryFill
 * @param {object} ofMeta
 * @param {{ poc?: number, vah?: number, val?: number } | null} vp
 * @param {object} [cfg]
 */
export function buildOrderFlowBrackets(side, entryFill, ofMeta, vp, cfg = {}) {
  const entry = Number(entryFill);
  if (!Number.isFinite(entry) || entry <= 0 || !ofMeta) return null;

  const stopBeyond = Number(ofMeta.stopBeyond);
  let slPct = 0;
  if (Number.isFinite(stopBeyond) && stopBeyond > 0) {
    slPct = Math.abs(entry - stopBeyond) / entry;
  }
  if (slPct <= 0 || slPct > 0.05) return null;

  const minRr = Math.max(0, Number(cfg.intradayOfMinRr ?? 1.5));
  const partialFrac = Math.max(0.1, Math.min(0.6, Number(cfg.intradayOfPartialFrac ?? 0.4)));

  let tp2Price = null;
  if (vp) {
    if (side === "BUY") {
      tp2Price = Number(vp.vah) > entry ? vp.vah : vp.poc > entry ? vp.poc : null;
    } else {
      tp2Price = Number(vp.val) < entry && vp.val > 0 ? vp.val : vp.poc < entry ? vp.poc : null;
    }
  }
  const tp1Pct = slPct;
  const maxTp2R = Math.max(1.5, Number(cfg.intradayOfMaxTp2R ?? 3));
  let tp2Pct =
    tp2Price != null && Number.isFinite(tp2Price) ? Math.abs(tp2Price - entry) / entry : slPct * 2;
  tp2Pct = Math.min(tp2Pct, slPct * maxTp2R);
  if (minRr > 0 && tp2Pct / slPct < minRr) return null;

  const slPrice = side === "BUY" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp1Price = side === "BUY" ? entry * (1 + tp1Pct) : entry * (1 - tp1Pct);
  const tp2Px = tp2Price ?? (side === "BUY" ? entry * (1 + tp2Pct) : entry * (1 - tp2Pct));

  return {
    slPct,
    tp1Pct,
    tp2Pct,
    rr: tp2Pct / slPct,
    slPrice,
    tp1Price,
    tp2Price: tp2Px,
    partialFrac,
    partialTp: cfg.intradayOfTp1Enabled !== false,
    tp2Enabled: cfg.intradayOfTp2Enabled !== false,
    keyLevel: ofMeta.keyLevel ?? null,
    patterns: ofMeta.patterns ?? [],
    dataTier: ofMeta.dataTier ?? null,
  };
}

/** Map OF brackets to runner position legs (mirrors liquidity partial TP). */
export function mapOrderFlowEntryLegs(br, cfg = {}) {
  if (!br?.slPrice) return null;
  const tp1On = br.partialTp !== false && cfg.intradayOfTp1Enabled !== false;
  const tp2On = br.tp2Enabled !== false && cfg.intradayOfTp2Enabled !== false;
  return {
    slPrice: br.slPrice,
    tp: tp2On ? br.tp2Price : tp1On ? br.tp1Price : 0,
    tp1: tp1On ? br.tp1Price : 0,
    partialTp: tp1On && tp2On,
    partialFrac: br.partialFrac ?? 0.4,
    stages: { tp1On, tp2On, beOn: cfg.intradayOfBreakevenAfterPartial !== false },
    beAt1R: cfg.intradayOfBreakevenAfterPartial !== false,
    beTriggerPx: tp1On ? br.tp1Price : 0,
  };
}

export function resolveOrderFlowEntryBrackets(cfg, barSignal, entryFill, side) {
  const br = barSignal?.ofBrackets;
  const meta = barSignal?.ofMeta;
  if (!br?.slPct && !meta?.stopBeyond) return null;
  const vp = meta?.vp ?? br?.vp ?? null;
  const rebuilt = meta ? buildOrderFlowBrackets(side, entryFill, meta, vp, cfg) : null;
  if (rebuilt) return rebuilt;
  return br?.slPct ? br : null;
}
