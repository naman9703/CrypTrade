/**
 * LIQ_CASCADE — Activity audit for gate / confirm / bracket skips (live bar-close).
 * Mirrors one-shot detection + confirm ladder in liqCascade.js; emits structured skip events only.
 */
import { atr as atrFn } from "./indicators.js";
import {
  LIQ_CASCADE_DEFAULTS,
  LIQ_CASCADE_WARMUP,
  buildBrackets,
  computeInBarDisplacement,
  confirmCascadeBar,
  effectiveOiWindowBars,
  liqIntervalToMs,
  lookupAtOrBefore,
  prepareLiqBars,
  prepareOiBars,
  resolveOiGate,
} from "./techniques/liqCascade.js";

const SPIKE_LIQ_FRAC = 0.5;
const SPIKE_Z_FRAC = 0.45;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function resolveFadeAction(dom, directionMode) {
  const mode = String(directionMode || "fade").toLowerCase();
  if (dom === "longs") return mode === "continuation" ? "SELL" : "BUY";
  if (dom === "shorts") return mode === "continuation" ? "BUY" : "SELL";
  return null;
}

/** @returns {{ key: string, label: string, pass: boolean, display: string }[]} */
export function buildLiqCascadeGateRows(lb, { disp, atrPct, oiGate, opts }) {
  const zMin = num(opts.liqZScoreMin, LIQ_CASCADE_DEFAULTS.liqZScoreMin);
  const liqMin = num(opts.minLiqUsdBar, LIQ_CASCADE_DEFAULTS.minLiqUsdBar);
  const dispMin = num(opts.minDispAtrMult, LIQ_CASCADE_DEFAULTS.minDispAtrMult);
  const atrMin = num(opts.minAtrPct, LIQ_CASCADE_DEFAULTS.minAtrPct);
  const oiMin = num(opts.minOiDropPct, LIQ_CASCADE_DEFAULTS.minOiDropPct);
  const oiMode = String(opts.oiGateMode ?? LIQ_CASCADE_DEFAULTS.oiGateMode).toLowerCase();

  return [
    {
      key: "zScore",
      label: "Liq z-score",
      pass: lb.z != null && lb.z >= zMin,
      display: lb.z != null ? lb.z.toFixed(2) : "—",
      threshold: String(zMin),
    },
    {
      key: "liqUsd",
      label: "Liq USD",
      pass: lb.totalUsd >= liqMin,
      display: `$${Math.round(lb.totalUsd).toLocaleString()}`,
      threshold: `$${Math.round(liqMin).toLocaleString()}`,
    },
    {
      key: "dominance",
      label: "Forced side",
      pass: lb.dom === "longs" || lb.dom === "shorts",
      display: lb.dom,
      threshold: "longs|shorts",
    },
    {
      key: "oiDrop",
      label: oiMode === "window" ? "OI window drop" : oiMode === "off" ? "OI gate (off)" : "OI bar drop",
      pass: oiGate.ok,
      display: oiGate.dropPct != null ? `${Number(oiGate.dropPct).toFixed(3)}%` : "—",
      threshold: `${oiMin}%`,
    },
    {
      key: "displacement",
      label: "In-bar disp (ATR)",
      pass: disp != null && disp >= dispMin,
      display: disp != null ? disp.toFixed(2) : "—",
      threshold: String(dispMin),
    },
    {
      key: "volatility",
      label: "ATR %",
      pass: atrPct != null && atrPct >= atrMin,
      display: atrPct != null ? `${atrPct.toFixed(3)}%` : "—",
      threshold: `${atrMin}%`,
    },
  ];
}

export function formatLiqCascadeSkipReason(event) {
  if (event.type === "gate_skip") {
    const g = event.failedGate;
    return `gate:${g?.key ?? "unknown"} (${g?.display ?? "—"} vs ${g?.threshold ?? "—"})`;
  }
  if (event.type === "confirm_skip") {
    return `confirm:${event.reasonCode}${event.confirmTier ? ` (tier ${event.confirmTier})` : ""}`;
  }
  if (event.type === "bracket_skip") {
    return `bracket:${event.reasonCode}`;
  }
  if (event.type === "adapter_skip") {
    return `adapter:${event.reasonCode}`;
  }
  return event.reasonCode ?? "skipped";
}

export function initLiqCascadeActivityPersisted() {
  return {
    detectionAttempted: Object.create(null),
    signaledLiqBarTs: Object.create(null),
    emittedKeys: Object.create(null),
    cascade: null,
    cooldownUntilLiqTs: 0,
  };
}

function isSpikeHint(lb, opts) {
  const zMin = num(opts.liqZScoreMin, LIQ_CASCADE_DEFAULTS.liqZScoreMin);
  const liqMin = num(opts.minLiqUsdBar, LIQ_CASCADE_DEFAULTS.minLiqUsdBar);
  return (
    lb.totalUsd >= liqMin * SPIKE_LIQ_FRAC ||
    (lb.z != null && lb.z >= zMin * SPIKE_Z_FRAC)
  );
}

/**
 * Advance audit state for one candle index; return skip events for Activity (this bar only).
 * @param {ReturnType<typeof initLiqCascadeActivityPersisted>} persisted
 */
export function stepLiqCascadeActivityAudit(persisted, candles, barIdx, ctx) {
  const events = [];
  if (!persisted || !candles?.length || barIdx < LIQ_CASCADE_WARMUP + 1) return events;

  const opts = { ...LIQ_CASCADE_DEFAULTS, ...ctx.opts };
  const liqBars = ctx.liqBars ?? [];
  const oiBars = ctx.oiBars ?? [];
  const atr = ctx.atr ?? atrFn(candles, 14);
  const closes = ctx.closes ?? candles.map((c) => Number(c.close));
  const tfMs = ctx.tfMs ?? (Number(candles[1]?.ts) - Number(candles[0]?.ts) || 60_000);
  const intervalMs = ctx.intervalMs ?? liqIntervalToMs(opts.liqInterval);
  const confirmMode = String(opts.confirmMode ?? LIQ_CASCADE_DEFAULTS.confirmMode).toLowerCase();
  const confirmLiqBars = num(opts.confirmLiqBars, LIQ_CASCADE_DEFAULTS.confirmLiqBars);
  const confirmSpan = confirmMode === "stall_reclaim" ? 1 : Math.max(1, confirmLiqBars);
  const confirmBars = Math.max(3, Math.round((confirmSpan * intervalMs) / tfMs));
  const strongDisp = num(opts.strongDispAtrMult, LIQ_CASCADE_DEFAULTS.strongDispAtrMult);
  const sides = String(opts.tradeSides || "BOTH").toUpperCase();

  const i = barIdx;
  const ts = Number(candles[i].ts);
  const lb = lookupAtOrBefore(ts, liqBars);

  if (
    lb &&
    !persisted.detectionAttempted[lb.ts] &&
    !persisted.signaledLiqBarTs[lb.ts] &&
    !persisted.cascade
  ) {
    const { disp, barCloseIdx } = computeInBarDisplacement(candles, atr, lb);
    if (barCloseIdx != null && i === barCloseIdx) {
      persisted.detectionAttempted[lb.ts] = true;
      const eventCooldownLiqBars = num(opts.eventCooldownLiqBars, LIQ_CASCADE_DEFAULTS.eventCooldownLiqBars);
      const inEventCooldown =
        eventCooldownLiqBars > 0 && lb.ts < Number(persisted.cooldownUntilLiqTs ?? 0);
      if (isSpikeHint(lb, opts) && !inEventCooldown) {
        const atrVal = atr[barCloseIdx];
        const atrPct =
          closes[barCloseIdx] > 0 && atrVal > 0 ? (atrVal / closes[barCloseIdx]) * 100 : null;
        const oiGate = resolveOiGate(oiBars, lb.ts, gateOpts);
        const gates = buildLiqCascadeGateRows(lb, { disp, atrPct, oiGate, opts });
        const failed = gates.find((g) => !g.pass);
        const fadeAction = resolveFadeAction(lb.dom, opts.directionMode);

        if (failed) {
          events.push({
            type: "gate_skip",
            reasonCode: `gate_${failed.key}`,
            liqBarTs: lb.ts,
            liqUsd: lb.totalUsd,
            dom: lb.dom,
            fadeAction,
            failedGate: failed,
            gates,
            z: lb.z,
            dispAtr: disp,
            oiDropPct: oiGate.dropPct,
          });
        } else {
          persisted.cascade = {
            dom: lb.dom,
            liqBarTs: lb.ts,
            startIdx: barCloseIdx,
            detectIdx: barCloseIdx,
            confirmTier: disp >= strongDisp ? "A" : "B",
            expiresIdx: barCloseIdx + confirmBars,
            z: lb.z,
            liqUsd: lb.totalUsd,
            oiDrop: oiGate.dropPct,
            disp,
            hadConfirm: false,
            bracketRejected: false,
          };
        }
      }
    }
  }

  let cascade = persisted.cascade;
  if (!cascade) return events;

  if (i > cascade.expiresIdx) {
    if (!persisted.signaledLiqBarTs[cascade.liqBarTs]) {
      const fadeAction = resolveFadeAction(cascade.dom, opts.directionMode);
      events.push({
        type: cascade.hadConfirm && cascade.bracketRejected ? "bracket_skip" : "confirm_skip",
        reasonCode:
          cascade.hadConfirm && cascade.bracketRejected ? "min_rr_not_met" : "confirm_window_expired",
        liqBarTs: cascade.liqBarTs,
        liqUsd: cascade.liqUsd,
        dom: cascade.dom,
        fadeAction,
        confirmTier: cascade.confirmTier,
        z: cascade.z,
        dispAtr: cascade.disp,
        oiDropPct: cascade.oiDrop,
      });
    }
    persisted.cascade = null;
    return events;
  }

  if (i < cascade.detectIdx) return events;

  if (confirmCascadeBar(candles, i, cascade, liqBars, opts)) {
    cascade.hadConfirm = true;
    const action = resolveFadeAction(cascade.dom, opts.directionMode);
    if (!action) {
      persisted.cascade = null;
      return events;
    }
    if (sides === "LONG" && action !== "BUY") {
      persisted.cascade = null;
      return events;
    }
    if (sides === "SHORT" && action !== "SELL") {
      persisted.cascade = null;
      return events;
    }

    const startIdx = cascade.startIdx ?? cascade.detectIdx;
    const liqBrackets = buildBrackets(candles, startIdx, i, action, atr, closes, opts);
    if (!liqBrackets) {
      cascade.bracketRejected = true;
      if (cascade.confirmTier === "A" && i >= cascade.detectIdx + 1) {
        const fadeAction = action;
        events.push({
          type: "bracket_skip",
          reasonCode: "min_rr_not_met",
          liqBarTs: cascade.liqBarTs,
          liqUsd: cascade.liqUsd,
          dom: cascade.dom,
          fadeAction,
          confirmTier: cascade.confirmTier,
          z: cascade.z,
          dispAtr: cascade.disp,
          oiDropPct: cascade.oiDrop,
        });
        persisted.cascade = null;
      }
      return events;
    }

    persisted.signaledLiqBarTs[cascade.liqBarTs] = true;
    const eventCooldownLiqBars = num(opts.eventCooldownLiqBars, LIQ_CASCADE_DEFAULTS.eventCooldownLiqBars);
    if (eventCooldownLiqBars > 0) {
      persisted.cooldownUntilLiqTs = cascade.liqBarTs + eventCooldownLiqBars * intervalMs;
    }
    persisted.cascade = null;
  }

  return events;
}

/** Adapter limits when series has a signal but live adapter returns null. */
export function liqCascadeAdapterSkipReason(adapterPersisted, barIdx, opts) {
  if (!adapterPersisted) return null;
  const maxTrades = num(opts.maxTradesPerDay, LIQ_CASCADE_DEFAULTS.maxTradesPerDay);
  const minGap = num(opts.minBarGap, LIQ_CASCADE_DEFAULTS.minBarGap);
  const tradesToday = Number(adapterPersisted.tradesToday ?? 0);
  const lastSignalIdx = Number(adapterPersisted.lastSignalIdx ?? -Infinity);
  if (tradesToday >= maxTrades) return "max_trades_per_day";
  if (barIdx - lastSignalIdx < minGap) return "min_bar_gap";
  return null;
}

/**
 * Prepare liq/OI bars + run audit step; dedupe emitted keys on persisted.
 * @returns {object[]} fresh events for this bar
 */
export function collectLiqCascadeBarCloseAuditEvents(persisted, candles, barIdx, { liqSeries, oiSeries, oiIntervalMs, opts }) {
  const intervalMs = liqIntervalToMs(opts.liqInterval ?? LIQ_CASCADE_DEFAULTS.liqInterval);
  const oiMs = oiIntervalMs ?? intervalMs;
  const lookbackBars = num(opts.liqLookbackBars, LIQ_CASCADE_DEFAULTS.liqLookbackBars);
  const liqBars = prepareLiqBars(liqSeries ?? [], { intervalMs, lookbackBars });
  const oiBars = prepareOiBars(oiSeries ?? [], oiMs);
  const gateOpts = oiMs > intervalMs
    ? { ...opts, oiWindowBars: effectiveOiWindowBars(opts, oiMs, intervalMs) }
    : opts;
  const atr = atrFn(candles, 14);
  const closes = candles.map((c) => Number(c.close));
  const tfMs =
    candles.length > 1 ? Number(candles[1].ts) - Number(candles[0].ts) || 60_000 : 60_000;

  const raw = stepLiqCascadeActivityAudit(persisted, candles, barIdx, {
    opts: gateOpts,
    liqBars,
    oiBars,
    atr,
    closes,
    tfMs,
    intervalMs,
  });

  const fresh = [];
  for (const ev of raw) {
    const dedupeKey = `${ev.type}:${ev.liqBarTs ?? barIdx}:${ev.reasonCode}:${ev.failedGate?.key ?? ""}`;
    if (persisted.emittedKeys[dedupeKey]) continue;
    persisted.emittedKeys[dedupeKey] = true;
    fresh.push(ev);
  }
  return fresh;
}
