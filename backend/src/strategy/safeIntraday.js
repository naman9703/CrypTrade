/**
 * SAFE_INTRADAY — conservative intraday futures trend follower.
 *
 * Signal core: SUPERTREND_ELITE 5-gate stack (research candidate; deploy claim revoked).
 * Safety overlays:
 *   - London/NY session only (skip thin Asia chop)
 *   - Max trades per UTC day
 *   - Uses trailing Supertrend exit (no fixed TP bleed)
 *
 * Honest expectation: ~0.03–0.05% / day on average (~1%/month), NOT 1%/day.
 * See docs/SAFE_INTRADAY_SETUP.md
 */

import { inSmcKillzone } from "./techniques/sessionKillzones.js";
import { dirStore, dayStore } from "./adapterPersisted.js";
import {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  ELITE_ST_DEFAULTS,
  normalizeEliteStRunCfg,
} from "./supertrendElite.js";

/** Validated Elite gates from STRATEGY_RESEARCH_HANDOFF (moderate risk). */
export const SAFE_INTRADAY_ELITE_OPTS = {
  period: 10,
  multiplier: 3.0,
  wilderAtr: true,
  minAdx: 20,
  requireAdxRising: true,
  adxRisingLookback: 3,
  minVolumeVsAvg: 1.5,
  requireHtf1hEmaAlign: true,
  htf1hMinSep: 0.0003,
  requireHtf4hAlign: true,
  htf4hPeriod: 10,
  htf4hMultiplier: 3.0,
  requireAtrExpansion: true,
  minAtrExpansion: 1.15,
  atrExpansionLookback: 12,
  liqSweepEnabled: false,
};

export const SAFE_INTRADAY_DEFAULTS = {
  /** Max new entries per UTC calendar day. */
  maxTradesPerDay: 2,
  /** ICT session filter — LONDON_NY = 07–10 + 12–16 UTC. */
  killzoneMode: "LONDON_NY",
  /** Documented target (not guaranteed): ~1% per month ≈ 0.03–0.05% per day avg. */
  targetMonthlyPct: 1,
};

/**
 * Bot/backtest cfg patch — apply when switching to SAFE_INTRADAY in the UI.
 */
export const SAFE_INTRADAY_ACTIVATION_PATCH = {
  manualStrategy: "SAFE_INTRADAY",
  strategyMode: "MANUAL",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  supertrendPeriod: SAFE_INTRADAY_ELITE_OPTS.period,
  supertrendMultiplier: SAFE_INTRADAY_ELITE_OPTS.multiplier,
  supertrendWilderAtr: true,
  eliteStMinAdx: SAFE_INTRADAY_ELITE_OPTS.minAdx,
  eliteStRequireAdxRising: true,
  eliteStMinVolumeVsAvg: SAFE_INTRADAY_ELITE_OPTS.minVolumeVsAvg,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStRequireHtf4hAlign: true,
  eliteStRequireAtrExpansion: true,
  eliteStLiqSweepEnabled: false,
  safeIntradayMaxTradesPerDay: SAFE_INTRADAY_DEFAULTS.maxTradesPerDay,
  safeIntradayKillzoneMode: SAFE_INTRADAY_DEFAULTS.killzoneMode,
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 10,
  maxDailyLoss: 1.5,
  maxDailyLossUnit: "PCT",
  riskKillSwitchDdPct: 8,
  riskConsecutiveLossLimit: 2,
  riskWeeklyMaxLossPct: 4,
  riskScale: 1,
};

export function buildSafeIntradayOptsFromCfg(cfg = {}) {
  const c = normalizeEliteStRunCfg(cfg);
  const elite = buildEliteStOptsFromCfg(c);
  return {
    ...elite,
    maxTradesPerDay: Math.max(
      1,
      Math.floor(Number(c.safeIntradayMaxTradesPerDay ?? SAFE_INTRADAY_DEFAULTS.maxTradesPerDay)),
    ),
    killzoneMode: String(c.safeIntradayKillzoneMode ?? c.intradaySmcKillzoneMode ?? SAFE_INTRADAY_DEFAULTS.killzoneMode).toUpperCase(),
    killzoneEnabled: c.intradaySmcKillzoneEnabled !== false,
  };
}

/**
 * Wraps Elite adapter with session + daily trade cap (UTC day).
 */
export function buildSafeIntradayBacktestAdapter(candles, cfg = {}) {
  const opts = buildSafeIntradayOptsFromCfg(cfg);
  const eliteOpts = { ...SAFE_INTRADAY_ELITE_OPTS, ...opts };
  const inner = buildEliteStBacktestAdapter(candles, eliteOpts);

  const eliteLocal = { lastDir: 0 };
  let dayKey = "";
  let tradesToday = 0;
  const dayLocal = { curDay: null, tradesToday: 0 };

  return function safeIntradayAdapter(bar, idx, ctx) {
    const dDay = dayStore(ctx, dayLocal);
    const d = new Date(bar.ts);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (key !== (ctx?.persisted ? dDay.curDay : dayKey)) {
      if (ctx?.persisted) dDay.curDay = key;
      else dayKey = key;
      if (ctx?.persisted) dDay.tradesToday = 0;
      else tradesToday = 0;
    }
    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;

    if (opts.killzoneEnabled && !inSmcKillzone(bar.ts, { intradaySmcKillzoneMode: opts.killzoneMode })) {
      return null;
    }

    if (tradesCount >= opts.maxTradesPerDay) return null;

    const st = dirStore(ctx, eliteLocal);
    const sig = inner(bar, idx, ctx ? { ...ctx, persisted: st } : undefined);
    if (sig?.action === "BUY" || sig?.action === "SELL") {
      if (ctx?.persisted) dDay.tradesToday = tradesCount + 1;
      else tradesToday += 1;
    }
    return sig;
  };
}

export const SAFE_INTRADAY = {
  name: "Safe Intraday — Elite trend + session cap + daily trade limit",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
