/**
 * MICRO_EVENT — tick-first microstructure event detectors + confluence scoring.
 * Default: continuation (ride forced flow).
 */
export const MICRO_EVENT_WARMUP = 30;

export const MICRO_EVENT_DEFAULTS = Object.freeze({
  directionMode: "continuation",
  eventTypesEnabled: ["liq", "oi", "book", "cvd", "funding", "macro"],
  minConfluenceScore: 55,
  minConfirmLayers: 2,
  liqWindowSec: 90,
  liqZMin: 1.5,
  liqMinUsd: 25_000,
  liqDomRatio: 1.2,
  liqRequired: true,
  oiGateEnabled: true,
  oiMinDropPct1m: 0.3,
  oiMinDropPct5m: 0.8,
  bookGateEnabled: true,
  minImbalance: 0.62,
  maxOppositeWallUsd: 500_000,
  cvdGateEnabled: true,
  minAggressiveUsd: 15_000,
  minCvdSlope: 5000,
  fundingGateEnabled: true,
  minFundingZ: 1.2,
  crowdedSideFilter: "any",
  macroGateEnabled: true,
  macroScoreBoost: 15,
  slBufferPct: 0.0015,
  tpRr: 1.2,
  maxHoldSec: 180,
  maxTradesPerHour: 12,
  cooldownSec: 45,
  tradeSides: "BOTH",
});

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v, d) {
  const s = String(v ?? "").trim();
  return s || d;
}

/** @param {object} cfg */
export function optsFromMicroEventCfg(cfg = {}) {
  const c = cfg;
  const types = c.microEventTypesEnabled;
  return {
    ...MICRO_EVENT_DEFAULTS,
    directionMode: str(c.microEventDirectionMode, MICRO_EVENT_DEFAULTS.directionMode).toLowerCase(),
    eventTypesEnabled: Array.isArray(types)
      ? types.map((x) => String(x).toLowerCase())
      : [...MICRO_EVENT_DEFAULTS.eventTypesEnabled],
    minConfluenceScore: num(c.microEventMinConfluenceScore, MICRO_EVENT_DEFAULTS.minConfluenceScore),
    minConfirmLayers: Math.max(1, Math.round(num(c.microEventMinConfirmLayers, MICRO_EVENT_DEFAULTS.minConfirmLayers))),
    liqWindowSec: num(c.microEventLiqWindowSec, MICRO_EVENT_DEFAULTS.liqWindowSec),
    liqZMin: num(c.microEventLiqZMin, MICRO_EVENT_DEFAULTS.liqZMin),
    liqMinUsd: num(c.microEventLiqMinUsd, MICRO_EVENT_DEFAULTS.liqMinUsd),
    liqDomRatio: num(c.microEventLiqDomRatio, MICRO_EVENT_DEFAULTS.liqDomRatio),
    liqRequired: c.microEventLiqRequired !== false,
    oiGateEnabled: c.microEventOiGateEnabled !== false,
    oiMinDropPct1m: num(c.microEventOiMinDropPct1m, MICRO_EVENT_DEFAULTS.oiMinDropPct1m),
    oiMinDropPct5m: num(c.microEventOiMinDropPct5m, MICRO_EVENT_DEFAULTS.oiMinDropPct5m),
    bookGateEnabled: c.microEventBookGateEnabled !== false,
    minImbalance: num(c.microEventMinImbalance, MICRO_EVENT_DEFAULTS.minImbalance),
    maxOppositeWallUsd: num(c.microEventMaxOppositeWallUsd, MICRO_EVENT_DEFAULTS.maxOppositeWallUsd),
    cvdGateEnabled: c.microEventCvdGateEnabled !== false,
    minAggressiveUsd: num(c.microEventMinAggressiveUsd, MICRO_EVENT_DEFAULTS.minAggressiveUsd),
    minCvdSlope: num(c.microEventMinCvdSlope, MICRO_EVENT_DEFAULTS.minCvdSlope),
    fundingGateEnabled: c.microEventFundingGateEnabled !== false,
    minFundingZ: num(c.microEventMinFundingZ, MICRO_EVENT_DEFAULTS.minFundingZ),
    crowdedSideFilter: str(c.microEventCrowdedSideFilter, MICRO_EVENT_DEFAULTS.crowdedSideFilter),
    macroGateEnabled: c.microEventMacroGateEnabled !== false,
    macroScoreBoost: num(c.microEventMacroScoreBoost, MICRO_EVENT_DEFAULTS.macroScoreBoost),
    slBufferPct: num(c.microEventSlBufferPct, MICRO_EVENT_DEFAULTS.slBufferPct),
    tpRr: num(c.microEventTpRr, MICRO_EVENT_DEFAULTS.tpRr),
    maxHoldSec: Math.max(30, Math.round(num(c.microEventMaxHoldSec, MICRO_EVENT_DEFAULTS.maxHoldSec))),
    maxTradesPerHour: Math.max(1, Math.round(num(c.microEventMaxTradesPerHour, MICRO_EVENT_DEFAULTS.maxTradesPerHour))),
    cooldownSec: Math.max(0, Math.round(num(c.microEventCooldownSec, MICRO_EVENT_DEFAULTS.cooldownSec))),
    tradeSides: str(c.microEventTradeSides, MICRO_EVENT_DEFAULTS.tradeSides).toUpperCase(),
  };
}

/**
 * Resolve trade side from liq dominance + direction mode.
 * @param {'longs'|'shorts'|'neutral'} dom
 * @param {string} directionMode
 */
export function resolveMicroEventAction(dom, directionMode) {
  const mode = String(directionMode || "continuation").toLowerCase();
  if (dom === "longs") return mode === "fade" ? "BUY" : "SELL";
  if (dom === "shorts") return mode === "fade" ? "SELL" : "BUY";
  return null;
}

/** E1 — Liq spike continuation */
export function detectLiqSpike(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("liq")) return null;
  if (snapshot.liqDom !== "longs" && snapshot.liqDom !== "shorts") return null;
  if (snapshot.liqTotalUsd < opts.liqMinUsd) return null;
  if (snapshot.liqZLike < opts.liqZMin) return null;
  const action = resolveMicroEventAction(snapshot.liqDom, opts.directionMode);
  if (!action) return null;
  return {
    type: "liq",
    side: action,
    strength: Math.min(100, snapshot.liqZLike * 20),
    reason: `liq_spike_${snapshot.liqDom}`,
    features: {
      liqTotalUsd: snapshot.liqTotalUsd,
      liqZLike: snapshot.liqZLike,
      liqDom: snapshot.liqDom,
    },
  };
}

/** E2 — OI unwind */
export function detectOiUnwind(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("oi") || !opts.oiGateEnabled) return null;
  const d1 = snapshot.oiDeltaPct1m;
  const d5 = snapshot.oiDeltaPct5m;
  const drop1 = d1 != null && d1 <= -opts.oiMinDropPct1m;
  const drop5 = d5 != null && d5 <= -opts.oiMinDropPct5m;
  if (!drop1 && !drop5) return null;
  const dom = snapshot.liqDom;
  const action = dom === "longs" || dom === "shorts"
    ? resolveMicroEventAction(dom, opts.directionMode)
    : snapshot.cvdUsd60s < 0
      ? "SELL"
      : snapshot.cvdUsd60s > 0
        ? "BUY"
        : null;
  if (!action) return null;
  return {
    type: "oi",
    side: action,
    strength: drop5 ? 70 : 55,
    reason: "oi_unwind",
    features: { oiDeltaPct1m: d1, oiDeltaPct5m: d5 },
  };
}

/** E3 — Book thin imbalance */
export function detectBookThinImbalance(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("book") || !opts.bookGateEnabled) return null;
  const imb = snapshot.bookImbalance;
  if (imb == null) return null;
  let action = null;
  if (imb >= opts.minImbalance && (snapshot.askWallUsd ?? Infinity) <= opts.maxOppositeWallUsd) {
    action = opts.directionMode === "fade" ? "SELL" : "BUY";
  } else if (imb <= 1 - opts.minImbalance && (snapshot.bidWallUsd ?? Infinity) <= opts.maxOppositeWallUsd) {
    action = opts.directionMode === "fade" ? "BUY" : "SELL";
  }
  if (!action) return null;
  return {
    type: "book",
    side: action,
    strength: 50 + Math.abs(imb - 0.5) * 80,
    reason: "book_imbalance",
    features: {
      bookImbalance: imb,
      bidWallUsd: snapshot.bidWallUsd,
      askWallUsd: snapshot.askWallUsd,
      bookPressure: snapshot.bookPressure,
    },
  };
}

/** E4 — CVD aggression */
export function detectCvdAggression(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("cvd") || !opts.cvdGateEnabled) return null;
  const buy = snapshot.aggressiveBuyUsd60s ?? 0;
  const sell = snapshot.aggressiveSellUsd60s ?? 0;
  const slope = snapshot.cvdSlope60s ?? 0;
  let action = null;
  if (buy >= opts.minAggressiveUsd && slope >= opts.minCvdSlope) {
    action = opts.directionMode === "fade" ? "SELL" : "BUY";
  } else if (sell >= opts.minAggressiveUsd && slope <= -opts.minCvdSlope) {
    action = opts.directionMode === "fade" ? "BUY" : "SELL";
  }
  if (!action) return null;
  return {
    type: "cvd",
    side: action,
    strength: 45 + Math.min(40, Math.abs(slope) / 1000),
    reason: "cvd_aggression",
    features: { buyUsd60s: buy, sellUsd60s: sell, cvdSlope60s: slope },
  };
}

/** E5 — Funding crowd */
export function detectFundingCrowd(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("funding") || !opts.fundingGateEnabled) return null;
  const z = snapshot.fundingZ;
  if (z == null || Math.abs(z) < opts.minFundingZ) return null;
  const crowd = snapshot.crowdedSide ?? "neutral";
  if (opts.crowdedSideFilter !== "any" && crowd !== opts.crowdedSideFilter) return null;
  let action = null;
  if (z > 0 || crowd.includes("long")) {
    action = opts.directionMode === "fade" ? "SELL" : "BUY";
  } else if (z < 0 || crowd.includes("short")) {
    action = opts.directionMode === "fade" ? "BUY" : "SELL";
  }
  if (!action) return null;
  return {
    type: "funding",
    side: action,
    strength: 40 + Math.min(35, Math.abs(z) * 15),
    reason: "funding_crowd",
    features: { fundingZ: z, crowdedSide: crowd, fundingRate: snapshot.fundingRate },
  };
}

/** E6 — Macro / listing hook */
export function detectMacroListing(snapshot, opts) {
  if (!opts.eventTypesEnabled.includes("macro") || !opts.macroGateEnabled) return null;
  if (!snapshot.calendarActive || !snapshot.calendarEvents?.length) return null;
  const ev = snapshot.calendarEvents[0];
  const hint = String(ev.directionHint ?? "").toUpperCase();
  let action = hint === "BUY" || hint === "LONG" ? "BUY" : hint === "SELL" || hint === "SHORT" ? "SELL" : null;
  if (!action && (snapshot.liqDom === "longs" || snapshot.liqDom === "shorts")) {
    action = resolveMicroEventAction(snapshot.liqDom, opts.directionMode);
  }
  if (!action) return null;
  return {
    type: "macro",
    side: action,
    strength: 35 + opts.macroScoreBoost,
    reason: `macro_${ev.eventType ?? "event"}`,
    features: { calendarEvents: snapshot.calendarEvents },
  };
}

const DETECTORS = [
  detectLiqSpike,
  detectOiUnwind,
  detectBookThinImbalance,
  detectCvdAggression,
  detectFundingCrowd,
  detectMacroListing,
];

/**
 * @param {object} snapshot
 * @param {object} opts
 */
export function runMicroEventDetectors(snapshot, opts) {
  const hits = [];
  for (const fn of DETECTORS) {
    const hit = fn(snapshot, opts);
    if (hit) hits.push(hit);
  }
  return hits;
}

/**
 * @param {object[]} hits
 * @param {object} snapshot
 * @param {object} opts
 */
export function scoreMicroEventConfluence(hits, snapshot, opts) {
  const liqHit = hits.find((h) => h.type === "liq");
  if (opts.liqRequired && !liqHit) {
    return {
      score: 0,
      pass: false,
      primarySide: null,
      failedGate: "liq_required",
      layers: {},
      hits,
    };
  }

  const primarySide = liqHit?.side ?? hits[0]?.side ?? null;
  if (!primarySide) {
    return { score: 0, pass: false, primarySide: null, failedGate: "no_side", layers: {}, hits };
  }

  const aligned = hits.filter((h) => h.side === primarySide);
  const layerTypes = new Set(aligned.map((h) => h.type));
  const confirmCount = [...layerTypes].filter((t) => t !== "liq").length;

  let score = liqHit ? Math.min(45, liqHit.strength * 0.45) : 0;
  for (const h of aligned) {
    if (h.type === "liq") continue;
    score += h.strength * 0.12;
  }
  if (snapshot.calendarActive) score += opts.macroScoreBoost * 0.5;

  score = Math.round(Math.min(100, score));
  const pass =
    score >= opts.minConfluenceScore &&
    confirmCount >= opts.minConfirmLayers &&
    (!opts.liqRequired || Boolean(liqHit));

  let failedGate = null;
  if (!pass) {
    if (opts.liqRequired && !liqHit) failedGate = "liq_required";
    else if (confirmCount < opts.minConfirmLayers) failedGate = "confirm_layers";
    else failedGate = "min_score";
  }

  const layers = {};
  for (const t of ["liq", "oi", "book", "cvd", "funding", "macro"]) {
    layers[t] = layerTypes.has(t);
  }

  return { score, pass, primarySide, failedGate, layers, confirmCount, hits: aligned };
}

/**
 * @param {number} price
 * @param {'BUY'|'SELL'} action
 * @param {object} opts
 * @param {number} [extremePrice]
 */
export function buildMicroEventBrackets(price, action, opts, extremePrice) {
  if (!(price > 0)) return null;
  const buf = num(opts.slBufferPct, MICRO_EVENT_DEFAULTS.slBufferPct);
  const extreme = extremePrice > 0 ? extremePrice : price;
  const slPx =
    action === "BUY"
      ? Math.min(price, extreme) * (1 - buf * 2)
      : Math.max(price, extreme) * (1 + buf * 2);
  const slPct = Math.abs(price - slPx) / price;
  if (!(slPct > 0)) return null;
  const tpPct = slPct * num(opts.tpRr, MICRO_EVENT_DEFAULTS.tpRr);
  return {
    slPct,
    tpPct,
    entryPrice: price,
    level: extreme,
    maxHoldSec: num(opts.maxHoldSec, MICRO_EVENT_DEFAULTS.maxHoldSec),
  };
}

/**
 * Full evaluation from snapshot — signal or skip audit.
 * @param {object} snapshot
 * @param {object} cfg
 * @param {number} [price]
 */
export function evaluateMicroEventFromSnapshot(snapshot, cfg, price) {
  const opts = optsFromMicroEventCfg(cfg);
  const hits = runMicroEventDetectors(snapshot, opts);
  const conf = scoreMicroEventConfluence(hits, snapshot, opts);
  const px = num(price ?? snapshot.lastPrice, 0);

  if (!conf.pass || !conf.primarySide) {
    return {
      action: null,
      audit: {
        skip: true,
        failedGate: conf.failedGate,
        score: conf.score,
        layers: conf.layers,
        hits,
        snapshot,
      },
    };
  }

  const sides = opts.tradeSides;
  if (sides === "LONG" && conf.primarySide !== "BUY") {
    return { action: null, audit: { skip: true, failedGate: "trade_sides", score: conf.score, hits } };
  }
  if (sides === "SHORT" && conf.primarySide !== "SELL") {
    return { action: null, audit: { skip: true, failedGate: "trade_sides", score: conf.score, hits } };
  }

  const brackets = px > 0 ? buildMicroEventBrackets(px, conf.primarySide, opts, px) : null;
  if (!brackets) {
    return { action: null, audit: { skip: true, failedGate: "brackets", score: conf.score, hits } };
  }

  return {
    action: conf.primarySide,
    reason: `micro_event_${hits.map((h) => h.type).join("_")}`,
    trigger: hits.find((h) => h.type === "liq")?.reason ?? hits[0]?.reason,
    playbook: "MICRO_EVENT",
    confluenceScore: conf.score,
    layers: conf.layers,
    hits,
    liqBrackets: brackets,
    audit: { skip: false, score: conf.score, layers: conf.layers, hits },
  };
}

export function formatMicroEventSkipReason(audit) {
  if (!audit?.skip) return "";
  const gate = audit.failedGate ?? "unknown";
  const layers = audit.layers ?? {};
  const on = Object.entries(layers)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join("+");
  return `micro_event_skip:${gate}:score=${audit.score ?? 0}:layers=${on || "none"}`;
}
