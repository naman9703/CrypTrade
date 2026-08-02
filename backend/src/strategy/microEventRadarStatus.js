/**
 * MICRO_EVENT — live radar snapshot for UI (read-only; mirrors live engine evaluation).
 */
import {
  optsFromMicroEventCfg,
  runMicroEventDetectors,
  scoreMicroEventConfluence,
  evaluateMicroEventFromSnapshot,
} from "./techniques/microEvent.js";
import { resolveMicroEventCfg } from "./microEventIntraday.js";
import { buildMicroEventFeedStatus } from "./microEventFeedStatus.js";
import { getMicrostructureSnapshot } from "./data/microstructureSnapshot.js";
import {
  isMicroEventLiveEngineRunning,
  getMicroEventEngineState,
  checkMicroEventFrequencyGate,
  microEventLiveEvents,
} from "../svc/microEventLiveEngine.js";
import { resolveMicroEventWatchSymbols } from "../svc/microEventLiveEngine.js";

const TAPE_LIMIT = 40;
/** @type {{ time: number, symbol: string, kind: string, action?: string, reason?: string, score?: number, layers?: object, source?: string }[]} */
let eventTape = [];
let tapeHooked = false;

function hookTapeOnce() {
  if (tapeHooked) return;
  tapeHooked = true;
  microEventLiveEvents.on("signal", (p) => {
    eventTape.unshift({
      time: Date.now(),
      symbol: p.symbol,
      kind: "signal",
      action: p.action,
      reason: p.reason,
      score: p.confluenceScore,
      layers: p.layers,
      source: p.source,
    });
    if (eventTape.length > TAPE_LIMIT) eventTape.length = TAPE_LIMIT;
  });
  microEventLiveEvents.on("skip", ({ symbol, audit, source }) => {
    eventTape.unshift({
      time: Date.now(),
      symbol,
      kind: "skip",
      reason: audit?.failedGate ?? "skip",
      score: audit?.score,
      layers: audit?.layers,
      source,
    });
    if (eventTape.length > TAPE_LIMIT) eventTape.length = TAPE_LIMIT;
  });
}

function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  return `$${Math.round(n)}`;
}

function buildDetectorRows(snapshot, opts, hits) {
  const hitTypes = new Set((hits ?? []).map((h) => h.type));
  const rows = [];

  const liqOk =
    snapshot.liqDom === "longs" || snapshot.liqDom === "shorts"
      ? snapshot.liqTotalUsd >= opts.liqMinUsd && snapshot.liqZLike >= opts.liqZMin
      : false;
  rows.push({
    id: "liq",
    label: "Liq spike",
    pass: hitTypes.has("liq") || liqOk,
    value: fmtUsd(snapshot.liqTotalUsd),
    threshold: `≥${fmtUsd(opts.liqMinUsd)} z≥${opts.liqZMin}`,
    detail: `${snapshot.liqDom} z=${Number(snapshot.liqZLike ?? 0).toFixed(2)} · ${snapshot.liqTickCount ?? 0} ticks/${opts.liqWindowSec ?? 90}s`,
  });

  const oiOk =
    opts.oiGateEnabled &&
    ((snapshot.oiDeltaPct1m != null && snapshot.oiDeltaPct1m <= -opts.oiMinDropPct1m) ||
      (snapshot.oiDeltaPct5m != null && snapshot.oiDeltaPct5m <= -opts.oiMinDropPct5m));
  const oiWarm =
    snapshot.oiDeltaPct1m == null &&
    snapshot.oiDeltaPct5m == null &&
    (snapshot.oi ?? 0) > 0;
  rows.push({
    id: "oi",
    label: "OI unwind",
    pass: hitTypes.has("oi") || Boolean(oiOk),
    value: oiWarm
      ? "warming up"
      : snapshot.oiDeltaPct1m != null
        ? `${snapshot.oiDeltaPct1m.toFixed(2)}% / ${snapshot.oiDeltaPct5m?.toFixed(2) ?? "—"}%`
        : "—",
    threshold: `≤-${opts.oiMinDropPct1m}% 1m`,
    detail: snapshot.oiGateExcluded
      ? "OI excluded (history window)"
      : opts.oiGateEnabled
        ? `OI ${fmtUsd(snapshot.oi)} · poll history`
        : "off",
  });

  rows.push({
    id: "book",
    label: "Book imbalance",
    pass: hitTypes.has("book"),
    value: snapshot.bookImbalance != null ? snapshot.bookImbalance.toFixed(2) : "—",
    threshold: `≥${opts.minImbalance}`,
    detail: "Live L2 only — no historical replay",
  });

  const cvdOk =
    opts.cvdGateEnabled &&
    ((snapshot.aggressiveBuyUsd60s >= opts.minAggressiveUsd && snapshot.cvdSlope60s >= opts.minCvdSlope) ||
      (snapshot.aggressiveSellUsd60s >= opts.minAggressiveUsd && snapshot.cvdSlope60s <= -opts.minCvdSlope));
  rows.push({
    id: "cvd",
    label: "CVD aggression",
    pass: hitTypes.has("cvd") || Boolean(cvdOk),
    value: fmtUsd(snapshot.aggressiveBuyUsd60s) + " / " + fmtUsd(snapshot.aggressiveSellUsd60s),
    threshold: `≥${fmtUsd(opts.minAggressiveUsd)} slope ${opts.minCvdSlope}`,
    detail: `slope=${Math.round(snapshot.cvdSlope60s ?? 0)}`,
  });

  rows.push({
    id: "funding",
    label: "Funding crowd",
    pass: hitTypes.has("funding"),
    value: snapshot.fundingZ != null ? snapshot.fundingZ.toFixed(2) : "—",
    threshold: `|z|≥${opts.minFundingZ}`,
    detail: snapshot.crowdedSide ?? "neutral",
  });

  rows.push({
    id: "macro",
    label: "Macro / calendar",
    pass: hitTypes.has("macro"),
    value: snapshot.calendarActive ? "active" : "—",
    threshold: "event window",
    detail: snapshot.calendarEvents?.[0]?.eventType ?? "none",
  });

  return rows;
}

function buildCoinRadar(symbol, state, now = Date.now()) {
  const sym = String(symbol || "").toUpperCase();
  const cfg = resolveMicroEventCfg(state);
  const opts = optsFromMicroEventCfg(cfg);
  const snapshot = getMicrostructureSnapshot(sym, {
    liqWindowSec: cfg.microEventLiqWindowSec,
    domRatio: cfg.microEventLiqDomRatio,
    nowMs: now,
  });

  const hits = runMicroEventDetectors(snapshot, opts);
  const conf = scoreMicroEventConfluence(hits, snapshot, opts);
  const full = evaluateMicroEventFromSnapshot(snapshot, cfg, snapshot.lastPrice ?? 0);

  const engineState = getMicroEventEngineState();
  const lastFire = engineState.lastFireBySymbol?.[sym] ?? 0;
  const cooldownMs = Math.max(0, opts.cooldownSec * 1000);
  const cooldownRemainingMs = Math.max(0, cooldownMs - (now - lastFire));
  const freq = checkMicroEventFrequencyGate(sym, cfg, now);

  const hb = Math.floor(now / 3_600_000);
  const tradesHour = engineState.tradesThisHour?.[`${sym}:${hb}`] ?? 0;

  let phase = "SCANNING";
  if (full.action) phase = "ARMED";
  else if (conf.score >= opts.minConfluenceScore * 0.7) phase = "BUILDING";
  else if (hits.some((h) => h.type === "liq")) phase = "SPIKE";

  return {
    symbol: sym,
    phase,
    primarySide: conf.primarySide,
    confluenceScore: conf.score,
    minConfluenceScore: opts.minConfluenceScore,
    confirmCount: conf.confirmCount ?? 0,
    minConfirmLayers: opts.minConfirmLayers,
    failedGate: conf.failedGate,
    layers: conf.layers,
    pass: conf.pass,
    fadeAction: full.action,
    cooldownRemainingMs,
    tradesThisHour: tradesHour,
    maxTradesPerHour: opts.maxTradesPerHour,
    frequencyOk: freq.ok,
    detectors: buildDetectorRows(snapshot, opts, hits),
    snapshot: {
      liqTotalUsd: snapshot.liqTotalUsd,
      liqDom: snapshot.liqDom,
      liqZLike: snapshot.liqZLike,
      cvdUsd60s: snapshot.cvdUsd60s,
      fundingZ: snapshot.fundingZ,
      bookImbalance: snapshot.bookImbalance,
    },
  };
}

function buildReadinessGates(state, feedStatus, getTradingMode) {
  const mode = String(getTradingMode?.() ?? state.tradingMode ?? "PAPER").toUpperCase();
  const tickOn = state.microEventLiveTickEnabled !== false;
  const twoWay = state.supertrendFuturesTwoWay === true;
  const liveAllow =
    mode !== "BINANCE_LIVE" || process.env.MICRO_EVENT_LIVE_ALLOW === "1";

  return [
    {
      id: "bot",
      label: "Bot running",
      ok: state.running === true,
      hint: state.running ? "OK" : "Start bot to activate tick executor",
    },
    {
      id: "tick_engine",
      label: "Tick executor",
      ok: !tickOn || isMicroEventLiveEngineRunning(),
      hint: tickOn ? (isMicroEventLiveEngineRunning() ? "Running" : "Start bot") : "Bar-close mode",
    },
    {
      id: "two_way",
      label: "2-way shorts",
      ok: twoWay,
      hint: twoWay ? "SELL can open shorts" : "Enable supertrendFuturesTwoWay — SELL blocked in 1-way",
    },
    {
      id: "feeds",
      label: "Critical feeds",
      ok: feedStatus?.autotradeEligible === true,
      hint: feedStatus?.autotradeEligible ? "Feeds OK" : "Feeds warming up — check feed panel",
    },
    {
      id: "live_allow",
      label: "Live capital gate",
      ok: liveAllow,
      hint: liveAllow ? "Paper/demo or LIVE_ALLOW=1" : "Set MICRO_EVENT_LIVE_ALLOW=1 for live",
    },
  ];
}

function buildOpenPositions(positions) {
  const now = Date.now();
  return (positions ?? [])
    .filter((p) => String(p?.meta?.strategyKey ?? p?.strategy ?? "").toUpperCase() === "MICRO_EVENT")
    .map((p) => {
      const entryTime = Number(p.meta?.entryTime ?? p.openedAt ?? 0);
      const maxHold = Number(p.meta?.maxHoldSec ?? 0);
      const ageSec = entryTime > 0 ? Math.round((now - entryTime) / 1000) : null;
      return {
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        qty: p.qty,
        confluenceScore: p.meta?.confluenceScore ?? null,
        ageSec,
        maxHoldSec: maxHold > 0 ? maxHold : null,
        holdPct: maxHold > 0 && ageSec != null ? Math.min(100, (ageSec / maxHold) * 100) : null,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      };
    });
}

/**
 * @param {{
 *   state?: object,
 *   depthStatusBySymbol?: Record<string, object>,
 *   positions?: object[],
 *   getTradingMode?: () => string,
 * }} ctx
 */
export function buildMicroEventRadarStatus(ctx = {}) {
  hookTapeOnce();
  const state = ctx.state ?? {};
  const now = Date.now();
  const watch = resolveMicroEventWatchSymbols(state);
  const symbols = watch.length ? watch : [String(state.symbol || "BTCUSDT").toUpperCase()];
  const tickEnabled = state.microEventLiveTickEnabled !== false;

  const primarySym = String(state.symbol || symbols[0] || "BTCUSDT").toUpperCase();
  const feedStatus = buildMicroEventFeedStatus({
    symbol: primarySym,
    watchSymbols: symbols,
    depthStatusBySymbol: ctx.depthStatusBySymbol ?? {},
    tickEngineRunning: isMicroEventLiveEngineRunning(),
    microEventLiveTickEnabled: tickEnabled,
  });

  const coins = symbols.map((sym) => buildCoinRadar(sym, state, now));
  const hottest = coins.reduce(
    (best, c) => (!best || (c.confluenceScore ?? 0) > (best.confluenceScore ?? 0) ? c : best),
    null,
  );

  const cfgEcho = resolveMicroEventCfg(state);
  const optsEcho = optsFromMicroEventCfg(cfgEcho);

  return {
    updatedAt: now,
    mode: tickEnabled ? "tick" : "bar_close",
    botRunning: state.running === true,
    tickEngineRunning: isMicroEventLiveEngineRunning(),
    focusSymbol: primarySym,
    headline: hottest?.phase === "ARMED"
      ? `${hottest.symbol} · ARMED ${hottest.fadeAction} score=${hottest.confluenceScore}`
      : hottest
        ? `${hottest.symbol} · ${hottest.phase} score=${hottest.confluenceScore ?? 0}`
        : "Scanning…",
    readinessGates: buildReadinessGates(state, feedStatus, ctx.getTradingMode),
    effectiveConfig: {
      microEventMinConfluenceScore: optsEcho.minConfluenceScore,
      microEventMinConfirmLayers: optsEcho.minConfirmLayers,
      microEventLiqMinUsd: optsEcho.liqMinUsd,
      microEventLiqZMin: optsEcho.liqZMin,
      microEventCooldownSec: optsEcho.cooldownSec,
      microEventMaxTradesPerHour: optsEcho.maxTradesPerHour,
      microEventMaxHoldSec: optsEcho.maxHoldSec,
      microEventTradeSides: optsEcho.tradeSides,
      supertrendFuturesTwoWay: state.supertrendFuturesTwoWay === true,
    },
    coins,
    tape: [...eventTape],
    openPositions: buildOpenPositions(ctx.positions),
    feedStatus,
    validationStatus: {
      label: "Backtest: liq+CVD+funding+OI replay (book live-only)",
      certified: false,
      note: "Run backtest-validate-micro-event.mjs for OOS metrics before promote language",
    },
  };
}

export function getMicroEventRadarTapeForTests() {
  return [...eventTape];
}

export function resetMicroEventRadarTapeForTests() {
  eventTape = [];
}
