/**
 * VOLUME_PROFILE — selective Tier-A VP setups (LVN vacuum + VA breakouts).
 * Backtest: npm run backtest:volume-profile -- BNBUSDT 15m
 */

/** Shared production tuning (BNB 15m ~+14.5% / 5mo; BTC 15m ~+28% / 5mo in research). */
/** Regime immunity — blocks counter-trend / fake VA breakouts (H2 2025 trap pattern). */
export const VP_REGIME_IMMUNITY = {
  vpRegimeImmunity: true,
  vpMaxPriorTrendPct: 0.012,
  vpPriorTrendLookback: 16,
  vpBuyBreakoutMinHtfSep: 0.004,
  vpBuyRelaxedMinHtfSep: 0.0035,
  vpBuyHighPathMinPct: 0.012,
  vpSellBreakdownMinHtfSep: 0.0035,
};

export const VOLUME_PROFILE_PRODUCTION = {
  vpTierAOnly: true,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown"],
  vpMinScore: 12,
  vpMinRR: 2,
  vpMinAdx: 24,
  vpMinHtfSepPct: 0.0035,
  vpMinCloseBeyondPct: 0.0025,
  vpMaxTradesPerDay: 2,
  vpMinBarGap: 12,
  vpBreakoutMinVolRatio: 1.6,
  vpValBreakdownMinVolRatio: 1.6,
  vpBreakoutMinPathPct: 0.007,
  vpLvnSizeMult: 2,
  ...VP_REGIME_IMMUNITY,
};

export const VOLUME_PROFILE_BASE = {
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  marketMode: "FUTURES",
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  volumeProfileEnabled: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  requireVpSetup: true,
  vpRequireHtfAlign: true,
  vpAllowHvnFlip: false,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown"],
  vpTierAOnly: true,
  intradayVpBrackets: true,
  vpStructureBrackets: true,
  /**
   * Production default = rolling lookback (validated positive on BNB/ETH Tier-A).
   * `composite_utc` / `session_utc` remain research modes (AMT-aligned) but were
   * net-negative under the same Tier-A gates in 2025-01→2026-06 honesty tests.
   */
  vpProfileMode: "rolling",
  vpLookbackBars: 384,
  vpCompositeDays: 5,
  vpValueAreaPct: 0.7,
  vpVolumeDistribute: "close_weighted",
  vpIncludePriorSession: true,
  vpEnableNakedPoc: true,
  vpBreakoutUsePriorSession: true,
  vpMinRR: 2,
  vpMinRunPct: 0.01,
  minLvnRunPct: 0.01,
  vpMinScore: 12,
  vpMinBarGap: 12,
  vpSessionStartHour: 7,
  vpSessionEndHour: 22,
  vpMinAdx: 24,
  vpMinHtfSepPct: 0.0035,
  vpMinCloseBeyondPct: 0.0025,
  vpMinBreakoutBody: 0.52,
  vpMinBreakoutCloseStrength: 0.62,
  ...VP_REGIME_IMMUNITY,
  vpHardBlockCeilingFloor: false,
  vpLvnSizeMult: 2,
  vpBreakoutMinVolRatio: 1.6,
  vpValBreakdownMinVolRatio: 1.6,
  vpBreakoutMinPathPct: 0.007,
  vpMaxTradesPerDay: 2,
  vpLvnMinVolRatio: 1.15,
  vpMinWickRatio: 0.32,
  vpMaxSlPct: 0.008,
  vpMaxTpPct: 0.028,
  supertrendFuturesFixedSlPct: 0.004,
  supertrendFuturesFixedTpPct: 0.014,
};

/** Primary — optimized BNB 15m */
export const VOLUME_PROFILE_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/** Alias — same production tuning (legacy UI label) */
export const VOLUME_PROFILE_TIER_A_15M = {
  ...VOLUME_PROFILE_15M,
};

/** More signals (~1/mo) — targets ~80% WR; allows slightly weaker HTF trend */
export const VOLUME_PROFILE_BALANCED_15M = {
  ...VOLUME_PROFILE_15M,
  vpMinHtfSepPct: 0.0032,
  vpMinScore: 11,
};

/**
 * FREQUENCY research stream — target ~1 trade/day (picker cap).
 *
 * Hypothesis: Tier-A stack crushed N with filters that do not create auction edge.
 * Keep real VP setups; drop N-only gates; **coin-resolve allowed setups** (BNB ≠ ETH ≠ BTC).
 *
 * UI honesty window 2025-06→2026-05 (uniform ETH-shaped on all coins = fail BNB/BTC):
 *   ETH all+softHTF: +37–167% research / user +37.8% @ ~73–79 trades
 *   BNB longs only (vah): +29.5% PF1.45 @ 37t — val_breakdown/poc_bounce bleed
 *   BTC shorts (val_bd+va_rej): +20% PF1.30 @ 43t — vah_breakout bleed −23
 * Cap: vpMaxTradesPerDay=1 (BNB may use 2 — still positive).
 */
export const VOLUME_PROFILE_FREQ_CORE = {
  /** When set, runtime merges `resolveVolumeProfileFreqPreset(symbol)` entry knobs per leg. */
  vpPlaybook: "FREQ",
  vpTierAOnly: false,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
  vpAllowHvnFlip: false,
  vpRequireHtfAlign: false,
  vpRegimeImmunity: false,
  vpMinAdx: 0,
  vpMinBarVolRatio: 0.45,
  vpMinAtrPct: 0.0006,
  vpMaxAtrPct: 0.06,
  vpMinScore: 8,
  vpMinRR: 1.2,
  vpMinRunPct: 0.003,
  vpMinCloseBeyondPct: 0.0008,
  vpMinBreakoutBody: 0.32,
  vpMinBreakoutCloseStrength: 0.48,
  vpBreakoutMinVolRatio: 1.05,
  vpValBreakdownMinVolRatio: 1.05,
  vpBreakoutMinPathPct: 0.003,
  vpLvnMinVolRatio: 0.95,
  vpMinWickRatio: 0.18,
  vpNearTolPct: 0.0025,
  vpRejectionMinVolRatio: 1.0,
  vpRejectionSpikePct: 0.002,
  vpOutsideVaLookback: 8,
  vpSessionStartHour: 0,
  vpSessionEndHour: 24,
  vpMaxTradesPerDay: 1,
  vpMinBarGap: 4,
  vpMaxSlPct: 0.012,
  vpMaxTpPct: 0.03,
  vpBuyBreakoutMinHtfSep: 0,
  vpBuyRelaxedMinHtfSep: 0,
  vpBuyHighPathMinPct: 0,
  vpSellBreakdownMinHtfSep: 0,
};

/**
 * BNB — VAH breakout + VAL breakdown with soft HTF (FREQ funnel reopen 2026-07-15).
 * Autopsy: open ETH funnel fails (−19%); va_rejection/poc_bounce bleed.
 * Winner: add val_breakdown behind HTF≥0.25% → ~70t / +52% / PF1.34 / 1.35/wk
 * (both holdout halves >0). Softening score/gap alone does not raise N without edge loss.
 */
/** BNB — legacy funnel preset (superseded by VOLUME_PROFILE_FREQ_BNB_15M for FREQ resolve). */
export const VOLUME_PROFILE_FREQ_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "naked_poc", "val_breakdown"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0025,
  vpMinScore: 7,
  vpMinBreakoutBody: 0.28,
  vpMinBreakoutCloseStrength: 0.45,
  vpBreakoutMinVolRatio: 1.0,
  vpBreakoutMinPathPct: 0.0025,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
};

/**
 * BNB — VAL-short native stack (2026-07-20).
 *
 * Multi-year autopsy: VAH vacuum was main bleed; VAL shorts work when regime-prepared.
 * Unlike ETH, vol-target sizing hurts BNB — do not copy ETH overlay.
 *
 * Locked behaviour:
 * - VAL-only funnel (drop VAH / vacuum long bleed)
 * - bull60 dump / non-vac / extending VAL abstain (shared physics with ETH)
 * - weak_bear vacuum VAL block + prepared bear vacuum VAL block
 * - H7 flat prior60 VAL block (transition grind −$23 multi-year)
 * - H8 prior5d chase block on VAL shorts (squeeze shorts −$42 multi-year)
 */
export const VOLUME_PROFILE_FREQ_BNB_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0025,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: false,
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellBlockBull60Extending: true,
  vpValSellBull60ExtendRatio: 0.6,
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
  vpValSellBlockWeakBearVacuum: true,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumValBear: true,
  vpPreparedBlockVacuumVah: false,
  vpValSellBlockFlatPrior60: true,
  vpValSellFlatPrior60LoPct: -0.05,
  vpValSellFlatPrior60HiPct: 0.05,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
  vpNoveltyEnabled: false,
};

/** ETH — open auction funnel + soft BUY HTF; macro-adaptive SELL HTF (2026-07-15).
 * Regime dependencies (2026-07-16 autopsy):
 * - Vacuum VAH (path≥2%) bleeds in bear/chop; structured 1–2% wins → cap vacuum outside bull macro.
 * - SELL va_rejection in extended down (2022 bounce shorts) → block when prior20d≤−5%.
 * - VAL shorts with shallow HTF in non-bear macro (bull-grind pullbacks) → harder min HTF when prior60d>−5%.
 * - After the above, remaining high-prior5d VAH buys are mostly bad chase → block prior5d>8%.
 * - Remaining weak-bear shorts (macroBear but prior20d only mildly negative) still lose → require HTF≥0.5%.
 * - Residual vacuum VAH in squeeze years: only allow path≥2% when prior5d≤1% (pullback, not chase).
 * Locked behaviour:
 * - chop-only MFE giveback trail on SELLs
 * - va_rejection min wick 0.35
 */
export const VOLUME_PROFILE_FREQ_ETH_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "ETHUSDT",
  timeframe: "15m",
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpSellMacroAdapt: true,
  vpSellMinHtfSepPct: 0.0025,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
  vpSellNonBearMinHtfSepPct: 0.005,
  vpSellBearPrior60dPct: -0.05,
  vpSellWeakBearMinHtfSepPct: 0.005,
  vpSellWeakBearPrior20dFloorPct: -0.1,
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
  vpVacuumEntryMode: "breakout",
  vpVacuumPathPct: 0.02,
  vpVacuumRetestBars: 8,
  vpVacuumRetestMaxTpPct: 0.015,
  backtestChopMfeTrail: true,
  backtestChopMfeTrailSides: "SELL",
  backtestChopPriorMs: 60 * 86_400_000,
  backtestChopPriorAbsMax: 0.05,
  backtestChopMfeTrailActivatePct: 0.01,
  backtestChopMfeTrailGivebackFrac: 0.35,
  vpRejectionMinWickRatio: 0.35,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpRejectionMinCloseDepth: 0,
  vpRejectionDepthExtendedOnly: false,
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: true,
  vpBuyVacuumBullPriorPct: 0.05,
  vpBuyVacuumPriorLookback: 96 * 60,
  vpBuyVacuumMaxPrior5dPct: 0.01,
  vpBuyVacuumPrior5dLookback: 96 * 5,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
  // Relative/adaptive 2021–22 physics (NOT year cut, NOT bear60-only):
  // H1 dump-into-bull + H2 bull60 non-vac + H3 extending residual bull:
  //   when prior60d>+5% AND prior20d/prior60d > 0.6 → abstain VAL
  //   (20d still extending the 60d bull — blow-off residue; brief squeezes kept)
  // Full-sim: lock +638%→+690%; 2021–22 −20.5%→−13.4%; all trained years ≥ baseline class.
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellBlockBull60Extending: true,
  vpValSellBull60ExtendRatio: 0.6,
  // H4 — BUY va_rejection min reclaim body (signal-bar quality, not cell blanket).
  // Wick-only dips fail; real body reclaims kept. Full-sim: 21–22 −13.4%→−2.9%;
  // lock +690%→+669% (N−2); 25–26 +155%→+166%. closeStrength@entry REJECTED.
  vpBuyRejectionMinBody: 0.2,
  // H6 — abstain BUY VAH vacuum in bull_trend (fake expansion chase).
  // Keeps weak_bear vacuum VAH (ETH edge). Full-sim: lock +669%→+703%; 2020–21
  // year-table −28%→−22%; clears catastrophic-year gate when combined with H5.
  vpBuyBreakoutBlockBullVacuum: true,
  // H5 — weak_bear vacuum VAL only when prior60d still extremely elevated (>15%).
  // Residual leftover bull while local HTF is weak. Blanket weak_bear vacuum
  // REJECTED (kills lock +42 runner at prior60~9.5%). Soft ceil keeps that runner.
  vpValSellBlockWeakBearVacuumHighPrior60: true,
  vpValSellWeakBearVacPrior60Pct: 0.15,
  // Vol-target sizing — cut risk in high-ATR regimes (2020–21 bull vol).
  // Full-sim with H5+H6: Calmar 0.82→1.37, DD 39.9%→25.1%, return +520%→+567%.
  // Not a year cut: same entries, adaptive size. Required for Calmar gate.
  volTargetSizing: true,
  volTargetAtrPct: 0.005,
  volTargetMinMult: 0.4,
  volTargetMaxMult: 2,
  // BTC novelty bleed list must NOT auto-attach on ETH (crushes OOS). Opt-in only.
  vpNoveltyEnabled: false,
};

/**
 * BTC — two-sided auction with regime-adaptive longs (2026-07-16) +
 * prepared-regime abstention (2026-07-17).
 *
 * Why it looked "short-biased": a 1y funnel (+VAH → −13…−33% in 2025–26 bear) banned
 * VAH forever. Multi-year autopsy shows that was setup mismatch, not coin destiny:
 * - BUY va_rejection was always allowed and is a major edge (~+$48 / 5t)
 * - Raw VAH is ~flat; vacuum/bear VAH bleeds; structured/bull VAH wins
 * - Adaptive VAH (vacuum cap outside bull macro) → longs help every year window
 *
 * Prepared-regime doctrine (2026-07-17 matrix 2021→2026):
 * Live invents new regimes — do not year-patch. Block measurable unprepared bleed
 * cells; expand prepared set only after autopsy. Unknown cells stay tradeable until
 * classified (allowlist-only is too sparse today).
 * Locked blocks:
 * - vacuum VAH (any macro)
 * - vacuum VAL in bear_trend
 * - SELL va_rejection when prior20d ≤ 0 (down/flat → squeeze shorts; keep BUY rej)
 *
 * Research: lock ~32t / ~+116% / DD~9%; OOS 2021–22 with rej rule ~+7% (was −34%);
 * vacuum retest / poc expand rejected as frequency restores (destroy lock expectancy).
 * Not WF+MC certified. Frequency still below ≥2/wk — restore must come from
 * positive cells / other TF / portfolio, not reopening vacuum bleed.
 */
export const VOLUME_PROFILE_FREQ_BTC_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BTCUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.005,
  vpSellMinHtfSepPct: 0.005,
  vpSellMacroAdapt: true,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
  vpSellWeakBearMinHtfSepPct: 0.008,
  vpSellWeakBearPrior20dFloorPct: -0.1,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  // Adaptive longs — reopen VAH; block vacuum breakouts outside bull macro
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: true,
  vpBuyVacuumBullPriorPct: 0.05,
  vpBuyVacuumPriorLookback: 96 * 60,
  // Prepared-regime abstention — known bleed cells (matrix-validated)
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: true,
  vpPreparedBlockVacuumValBear: true,
  vpPreparedVacuumPathPct: 0.02,
  // SELL VAH rejection only after prior20d strength (exhaustion); after down/flat
  // 20d these are squeeze-prone bounce shorts (2021–22 residual bleed).
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0,
  vpMinScore: 6,
  vpValBreakdownMinVolRatio: 1.0,
  vpMinBreakoutBody: 0.28,
  vpMinBreakoutCloseStrength: 0.45,
  vpMinBarGap: 1,
  vpMaxTradesPerDay: 2,
};

export function resolveVolumeProfileFreqPreset(symbol) {
  const sym = String(symbol ?? "").toUpperCase();
  if (sym === "ETHUSDT") return VOLUME_PROFILE_FREQ_ETH_15M;
  if (sym === "BTCUSDT") return VOLUME_PROFILE_FREQ_BTC_15M;
  if (sym === "BNBUSDT") return VOLUME_PROFILE_FREQ_BNB_15M;
  return VOLUME_PROFILE_FREQ_15M;
}

/**
 * Warmup pad so rolling VP lookback / HTF gates see history before the run window.
 * Without this, UI backtests rebuild profiles from in-window bars only and diverge
 * from research scripts that pad ~21d (ETH FREQ 79/+167 vs ~78/+124).
 */
export function volumeProfilePadFromMs(fromMs, tf = "15m", cfg = {}) {
  const mpb =
    { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[
      String(tf || "15m").toLowerCase()
    ] ?? 15;
  const lookback = Math.max(48, Math.round(Number(cfg?.vpLookbackBars ?? 384)));
  const padBars = Math.max(lookback + Math.ceil((24 * 60) / mpb), Math.ceil((21 * 24 * 60) / mpb));
  return Number(fromMs) - padBars * mpb * 60_000;
}

/** True when cfg is the FREQ research stream (explicit playbook or FREQ_CORE fingerprint). */
export function isVolumeProfileFreqPlaybook(cfg = {}) {
  if (String(cfg.vpPlaybook ?? "").toUpperCase() === "FREQ") return true;
  // Legacy saves: FREQ buttons applied before vpPlaybook existed / playbook stripped on save.
  return (
    cfg.vpTierAOnly === false &&
    cfg.vpRegimeImmunity === false &&
    Number(cfg.vpMinAdx ?? -1) === 0
  );
}

/**
 * Coin-resolve VP FREQ entry setups for the active symbol.
 *
 * Unlike LIQ fill-undefined defaults, this **overwrites** VP entry knobs from the
 * coin preset so a shared portfolio snapshot (e.g. ETH-shaped) still gets BNB longs
 * / BTC shorts when each leg runs with `cfg.symbol` set.
 *
 * Activates when `manualStrategy=VOLUME_PROFILE` and FREQ playbook (or fingerprint).
 * Never clobbers generic trailing / risk / instance fields (ST trail, leverage, etc.).
 * Does inject locked FREQ exit knobs (`backtestChopMfeTrail*`) — those are part of the
 * coin research preset and were previously dropped when saved bot snapshots omitted them.
 */
export function fillVolumeProfileFreqDefaults(cfg = {}) {
  const strat = String(cfg.manualStrategy ?? "").toUpperCase();
  if (strat !== "VOLUME_PROFILE") return cfg;
  if (!isVolumeProfileFreqPlaybook(cfg)) return cfg;

  const sym = String(cfg.symbol ?? "").toUpperCase();
  if (!sym) return cfg;

  const preset = resolveVolumeProfileFreqPreset(sym);
  const out = { ...cfg, symbol: sym, vpPlaybook: "FREQ" };

  // Entry / gate knobs + locked FREQ chop-trail exits. Never copy generic trail/sizing
  // from BASE (that was forcing trailingStopLossAuto=false and wiping user trail).
  const entryKeys = new Set([
    "requireVpSetup",
    "volumeProfileEnabled",
    "volumeProfileSoftGates",
    "volumeProfileGatesEnabled",
    "volumeProfileGateMode",
    "intradayVpBrackets",
    "minLvnRunPct",
    "vpPlaybook",
    // Locked SELL chop MFE giveback trail (ETH FREQ research) — not generic ST trail.
    "backtestChopMfeTrail",
    "backtestChopMfeTrailSides",
    "backtestChopPriorMs",
    "backtestChopPriorAbsMax",
    "backtestChopMfeTrailActivatePct",
    "backtestChopMfeTrailGivebackFrac",
    // Locked ETH FREQ risk overlay — required for Calmar gate (high-ATR de-risk).
    "volTargetSizing",
    "volTargetAtrPct",
    "volTargetMinMult",
    "volTargetMaxMult",
  ]);
  for (const [key, val] of Object.entries(preset)) {
    if (!(key.startsWith("vp") || entryKeys.has(key))) continue;
    out[key] = val;
  }
  return out;
}

/** Multi-coin patch — runtime per-leg resolve via fillVolumeProfileFreqDefaults. */
export const VOLUME_PROFILE_FREQ_PORTFOLIO_15M = {
  ...VOLUME_PROFILE_FREQ_ETH_15M,
  vpPlaybook: "FREQ",
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["ETHUSDT", "BNBUSDT", "BTCUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

export const VOLUME_PROFILE_BTC_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BTCUSDT",
  timeframe: "15m",
};

/** Slightly more signals on 5m — still Tier-A only */
export const VOLUME_PROFILE_5M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  vpLookbackBars: 288,
  vpMinBarGap: 18,
  vpMinScore: 11,
  vpMaxTradesPerDay: 2,
};
