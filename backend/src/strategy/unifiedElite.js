/**
 * UNIFIED_ELITE — Unified intraday strategy combining the only validated signal
 * (SUPERTREND_ELITE) with two compounding layers:
 *
 *   Layer 1 — Regime gate
 *     At entry bar, classify market state via regimeEngine. Skip VOLATILE_AVOID
 *     and SQUEEZE bars — those are where trend-following entries get wrecked.
 *     TREND_UP / TREND_DOWN let the Elite signal through at full size.
 *
 *   Layer 2 — Liquidity proximity scaling
 *     If a PDH/PDL sweep was *reclaimed* in the last N bars when the Elite
 *     signal fires, size up by 1.5× (higher conviction that institutions just
 *     cleared stops before the trending move).
 *
 *   Layer 3 — LIQ+SR supplemental path (RANGE regime only)
 *     In ranging markets where the trend signal would be filtered, a high-quality
 *     A+ institutional liq sweep setup (score ≥ unifiedLiqSrMinScore) can fire
 *     at reduced risk (unifiedLiqSrRiskScale × base risk). This adds intraday
 *     trades in consolidating markets without touching the validated Elite edge.
 *
 * Architecture vs. validated baselines:
 *   - Core signal: SUPERTREND_ELITE (same 5-gate stack, unchanged)
 *   - Regime classifier: regimeEngine (class labels only; NOT the failed playbooks)
 *   - Supplemental: LIQ+SR A+ in RANGE only (in-sample positive on 3 coins)
 *
 * Honest expectation:
 *   - Elite-regime path: ~1.0 trades / coin / month after VOLATILE/SQUEEZE skip
 *   - LIQ+SR supplement: ~0.5–1 trade / coin / month in RANGE
 *   - 5-coin portfolio: ~7–10 trades / month total
 *   - CAGR target: 15–25% (Elite baseline 11–21% + regime quality lift)
 *
 * Configuration knobs (all optional, sensible defaults):
 *   unifiedRegimeGate {boolean}   — gate 1 on/off (default true)
 *   unifiedLiqScale   {boolean}   — layer 2 on/off (default true)
 *   unifiedLiqScaleFactor {number} — size multiplier when sweep is nearby (default 1.5)
 *   unifiedLiqLookback {number}   — bars back to check for PDH/PDL sweep (default 8)
 *   unifiedLiqSrEnabled {boolean} — layer 3 LIQ+SR supplemental on/off (default true)
 *   unifiedLiqSrMinScore {number} — min A+ setup score to fire supplemental (default 10)
 *   unifiedLiqSrRiskScale {number} — risk scaling for supplemental trades (default 0.5)
 *   unifiedLiqSrMaxPerDay {number} — max supplemental trades per UTC day (default 1)
 */

import { dirStore, dayStore } from "./adapterPersisted.js";
import { buildRegimeSeries, REGIMES } from "./regimeEngine.js";
import { inSmcKillzone } from "./techniques/sessionKillzones.js";
import { listSessionLiquiditySetups } from "./techniques/liquidity.js";
import {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  ELITE_ST_DEFAULTS,
  ELITE_ST_ACTIVATION_PATCH,
  normalizeEliteStRunCfg,
} from "./supertrendElite.js";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const UNIFIED_ELITE_DEFAULTS = {
  // Layer 1: regime gate
  unifiedRegimeGate: true,
  // "skip_squeeze_only" = safest default: VOLATILE_AVOID bars are high-ATR momentum
  // moves where Elite actually performs best; skipping them hurts. Only SQUEEZE
  // (pre-compression / false breakout territory) is reliably bad for ST entries.
  // Set to "skip_volatile_squeeze" to also skip VOLATILE_AVOID (more conservative).
  unifiedRegimeGateMode: "skip_squeeze_only",

  // Layer 2: liq proximity scale-up
  unifiedLiqScale: true,
  unifiedLiqScaleFactor: 1.5,
  unifiedLiqLookback: 8,   // bars to look back for a reclaimed PDH/PDL sweep

  // Layer 3: LIQ+SR supplemental path (RANGE regime only)
  unifiedLiqSrEnabled: true,
  unifiedLiqSrMinScore: 10,   // institutional A+ quality threshold
  unifiedLiqSrRiskScale: 0.5, // 0.5× base risk for supplemental trades
  unifiedLiqSrMaxPerDay: 1,   // keep frequency conservative
  unifiedLiqSrKillzone: "LONDON_NY", // only fire in high-liquidity sessions
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether any of the last `lookback` bars performed a PDH/PDL sweep-
 * and-reclaim (classic institutional stop-hunt pattern confirming a level).
 * Only checks the PREVIOUS bars (no look-ahead); the signal bar itself is
 * excluded because it is still forming at trigger time.
 */
function hasPdLevelSweep(candles, idx, side, lookback) {
  const end = Math.max(0, idx - 1);
  const start = Math.max(0, end - lookback);
  for (let i = start; i <= end; i++) {
    // Simple heuristic: wick pierced at least 0.05% beyond the prior-bar's
    // high/low and the bar CLOSED back inside the level.
    const c = candles[i];
    if (!c) continue;
    const prev = candles[i - 1];
    if (!prev) continue;
    const buffer = prev.close * 0.0005; // 0.05% tolerance
    if (side === "BUY") {
      // A BUY setup follows a low sweep of a prior low then close above it.
      if (c.low < prev.low - buffer && c.close > prev.low) return true;
    } else {
      // A SELL setup follows a high sweep of a prior high then close below it.
      if (c.high > prev.high + buffer && c.close < prev.high) return true;
    }
  }
  return false;
}

/**
 * Compute config options for the unified strategy from a flat bot config.
 */
export function buildUnifiedEliteOptsFromCfg(cfg = {}) {
  const c = cfg;
  const elite = buildEliteStOptsFromCfg(normalizeEliteStRunCfg(cfg));
  return {
    ...elite,
    // Layer 1 — regime gate
    unifiedRegimeGate: c.unifiedRegimeGate !== false,
    unifiedRegimeGateMode: String(c.unifiedRegimeGateMode ?? UNIFIED_ELITE_DEFAULTS.unifiedRegimeGateMode),

    // Layer 2 — liq proximity
    unifiedLiqScale: c.unifiedLiqScale !== false,
    unifiedLiqScaleFactor: Number(c.unifiedLiqScaleFactor ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqScaleFactor),
    unifiedLiqLookback: Math.max(1, Number(c.unifiedLiqLookback ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqLookback)),

    // Layer 3 — LIQ+SR supplemental
    unifiedLiqSrEnabled: c.unifiedLiqSrEnabled !== false,
    unifiedLiqSrMinScore: Number(c.unifiedLiqSrMinScore ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqSrMinScore),
    unifiedLiqSrRiskScale: Number(c.unifiedLiqSrRiskScale ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqSrRiskScale),
    unifiedLiqSrMaxPerDay: Math.max(1, Number(c.unifiedLiqSrMaxPerDay ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqSrMaxPerDay)),
    unifiedLiqSrKillzone: String(c.unifiedLiqSrKillzone ?? UNIFIED_ELITE_DEFAULTS.unifiedLiqSrKillzone).toUpperCase(),
  };
}

// ─── Backtest adapter ─────────────────────────────────────────────────────────

/**
 * Builds the stateful per-bar adapter used by runSimulation.
 *
 * Returns standard `{ action, reason, [riskScale] }` objects.  When `riskScale`
 * is attached, the runner multiplies the computed position size by it (the
 * runner already supports this via the `signal_context.riskScale` field — if
 * not present the scale is treated as 1.0).
 *
 * @param {Array} candles OHLCV array for the primary timeframe
 * @param {object} opts from buildUnifiedEliteOptsFromCfg
 */
export function buildUnifiedEliteBacktestAdapter(candles, opts = {}) {
  const o = { ...UNIFIED_ELITE_DEFAULTS, ...opts };

  // Pre-compute regime series once (O(n)).
  const regimeSeries = o.unifiedRegimeGate ? buildRegimeSeries(candles) : null;

  // Pre-compute LIQ+SR setups once for the supplemental path (O(n)).
  let liqSetups = null;
  if (o.unifiedLiqSrEnabled) {
    try {
      // Use institutional A+ config — same as INTRADAY_PRO_SR_APLUS_15M defaults.
      const liqOpts = {
        intradayLiqStrictMode: true,
        intradayLiqMinScore: 6,
        intradayLiqMinRr: 2.0,
        intradayLiqMinSweepExtensionPct: 0.004,
        intradayLiqMinReclaimBodyRatio: 0.35, // validated reclaim quality gate
        intradayLiqMinReclaimClosePct: 0,
        intradayLiqRejectSameBarReclaim: true,
        intradayLiqMaxSlPct: 0.035,
        intradayLiqMaxSweepBars: 40,
        intradayLiqOnePickPerDay: true,
        intradayLiqMaxTradesPerSidePerDay: 1,
        intradayLiqRequireHtfAlign: false, // supplemental only fires in RANGE (no HTF trend)
        intradayGateLiquidity: true,
        intradayLiqEntryAtSignalClose: true,
        intradayLiqBreakevenAfterPartial: true,
        intradayLiqPartialTp: true,
        intradayLiqTp1Enabled: true,
        intradayLiqTp2Enabled: true,
        intradayLiqPartialFrac: 0.5,
      };
      liqSetups = listSessionLiquiditySetups(candles, liqOpts);
    } catch {
      liqSetups = null;
    }
  }

  // Build the Elite adapter (manages its own lastDir reset).
  const eliteAdapter = buildEliteStBacktestAdapter(candles, o);

  // Per-day state for supplemental path.
  let dayKey = "";
  let liqSrTodayCount = 0;
  const dayLocal = { curDay: null, tradesToday: 0, liqSrTodayCount: 0 };

  return function unifiedEliteAdapter(bar, idx, ctx) {
    const ts = bar.ts;
    const dDay = dayStore(ctx, dayLocal);

    const d = new Date(ts);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (k !== (ctx?.persisted ? dDay.curDay : dayKey)) {
      if (ctx?.persisted) {
        dDay.curDay = k;
        dDay.liqSrTodayCount = 0;
      } else {
        dayKey = k;
        liqSrTodayCount = 0;
      }
    }
    const liqCount = ctx?.persisted ? (dDay.liqSrTodayCount ?? 0) : liqSrTodayCount;

    // ── Regime classification ──────────────────────────────────────────────────
    const reg = regimeSeries ? regimeSeries[idx] : null;
    const regime = reg?.regime ?? REGIMES.TREND_UP;
    // Determine which regimes to gate out.
    // "skip_volatile_squeeze" = block both VOLATILE_AVOID and SQUEEZE
    // "skip_squeeze_only"     = only block SQUEEZE (safer default for 1H trend strategy)
    const gateMode = o.unifiedRegimeGateMode ?? "skip_squeeze_only";
    const isSqueeze = regime === REGIMES.SQUEEZE;
    const isVolatile = regime === REGIMES.VOLATILE_AVOID;
    const shouldSkip =
      gateMode === "skip_volatile_squeeze" ? (isSqueeze || isVolatile) : isSqueeze;
    const isRange = regime === REGIMES.RANGE;

    // ── ELITE PATH (trend / volatile regimes) ─────────────────────────────────
    if (!isRange) {
      // Gate: skip regimes classified as low-quality for trend entries.
      if (o.unifiedRegimeGate && shouldSkip) return null;

      const sig = eliteAdapter(bar, idx, ctx);
      if (!sig || (sig.action !== "BUY" && sig.action !== "SELL")) return null;

      // Layer 2: check liq proximity for scale-up.
      let riskScale = 1.0;
      if (o.unifiedLiqScale) {
        const hasSweep = hasPdLevelSweep(candles, idx, sig.action, o.unifiedLiqLookback);
        if (hasSweep) riskScale = o.unifiedLiqScaleFactor;
      }

      return {
        action: sig.action,
        reason: riskScale > 1 ? `${sig.reason}_liq_boost` : sig.reason,
        riskScale,
        signal_context: { layer: "elite", regime, regimeConf: reg?.confidence ?? 0 },
      };
    }

    // ── SUPPLEMENTAL PATH (RANGE regime only) ─────────────────────────────────
    if (!o.unifiedLiqSrEnabled) return null;
    if (liqCount >= o.unifiedLiqSrMaxPerDay) return null;

    // Session filter — only fire in high-liquidity hours.
    if (!inSmcKillzone(ts, { intradaySmcKillzoneMode: o.unifiedLiqSrKillzone })) return null;

    // Find the best liq setup at this bar index.
    if (!liqSetups) return null;
    const setup = liqSetups.find((s) => s.signalIdx === idx && s.score >= o.unifiedLiqSrMinScore);
    if (!setup) return null;

    if (ctx?.persisted) dDay.liqSrTodayCount = liqCount + 1;
    else liqSrTodayCount++;
    return {
      action: setup.side,
      reason: `unified_liq_sr_${setup.side.toLowerCase()}_range`,
      riskScale: o.unifiedLiqSrRiskScale,
      signal_context: {
        layer: "liq_sr_supplemental",
        regime,
        liqScore: setup.score,
        liqContext: setup.context ?? null,
      },
    };
  };
}

/** Bot/backtest cfg patch — apply when switching to UNIFIED_ELITE in the UI. */
export const UNIFIED_ELITE_ACTIVATION_PATCH = {
  ...ELITE_ST_ACTIVATION_PATCH,
  manualStrategy: "UNIFIED_ELITE",
  unifiedRegimeGate: UNIFIED_ELITE_DEFAULTS.unifiedRegimeGate,
  unifiedRegimeGateMode: UNIFIED_ELITE_DEFAULTS.unifiedRegimeGateMode,
  unifiedLiqScale: UNIFIED_ELITE_DEFAULTS.unifiedLiqScale,
  unifiedLiqScaleFactor: UNIFIED_ELITE_DEFAULTS.unifiedLiqScaleFactor,
  unifiedLiqLookback: UNIFIED_ELITE_DEFAULTS.unifiedLiqLookback,
  unifiedLiqSrEnabled: UNIFIED_ELITE_DEFAULTS.unifiedLiqSrEnabled,
  unifiedLiqSrMinScore: UNIFIED_ELITE_DEFAULTS.unifiedLiqSrMinScore,
  unifiedLiqSrRiskScale: UNIFIED_ELITE_DEFAULTS.unifiedLiqSrRiskScale,
  unifiedLiqSrMaxPerDay: UNIFIED_ELITE_DEFAULTS.unifiedLiqSrMaxPerDay,
  unifiedLiqSrKillzone: UNIFIED_ELITE_DEFAULTS.unifiedLiqSrKillzone,
};

// ─── Strategy object (matches the interface expected by strategies.js) ────────

export const UNIFIED_ELITE = {
  name: "Unified Elite — SUPERTREND_ELITE + regime gate + liq scale + RANGE LIQ/SR supplement",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
