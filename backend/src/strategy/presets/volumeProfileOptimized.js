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
 * - H9 widen flat prior60 ±5%→±8% (Calmar 0.95→~1.29 on cert window, 2026-07-23)
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
  // H9 (2026-07-23): widen flat prior60 abstain ±5%→±8% — cuts transition bleed,
  // Calmar 0.95→~1.29 / ret +261%→+304% on cert window (see research decision).
  vpValSellFlatPrior60LoPct: -0.08,
  vpValSellFlatPrior60HiPct: 0.08,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
  vpNoveltyEnabled: false,
};

/**
 * SOL — VAL + prepared rejection bear60 stack (2026-07-21 cert path).
 *
 * Coin-native Phase 0–3 (FREQ core → autopsy → one-change A/B → cert gates):
 * - Raw FREQ core −94% full / only 2022–23 paid; VAH vacuum multi-year destroyer (−$89).
 * - Residual structured VAH still bled after vacuum path block → drop VAH entirely.
 * - VAL edge concentrates in prior60d ≤ −5% (bear60 +$19 vs bull60 −$16 / flat60 −$11).
 * - H8: reopen prepared SELL va_rejection (block extended-down bounce shorts) — raises N + return.
 * - Root cause of MC p5 fail: weak rejection wicks (ratio &lt; 0.40) inflate left-tail R → wick 0.40.
 * - Root cause of Calmar &lt; 1 after wick lock: shallow HTF alignment losers → HTF sep 0.20%.
 * - WF fold0 (2021-11→2022-10) still −11%: relief-bounce VAL harvest looked promising but
 *   full resim breaks Calmar / 2025–26 — knob kept off the lock.
 * - Vol-target / chop-trail / wick&gt;0.40 / blanket relief-bounce rejected.
 *
 * Locked behaviour (H8 + wick0.40 + HTF0.20):
 * - VAL + va_rejection allow-list
 * - require prior60d bear floor (−5%)
 * - rejection: extended-down block (prior20d ≤ −5%) + min wick 0.40
 * - HTF sep 0.20%
 * - Relief-bounce VAL block available (`vpValSellBlockReliefBounce`) but NOT locked —
 *   blanket 0.15 flips WF fold0 green yet breaks 2025–26 / Calmar on full resim.
 *
 * Full-window (pre-WF): ~186t / +303% / Calmar ~1.06 / MC p5 ~+9.5% / all years ≥0.
 * Frequency ~0.66/wk. Core MC+Calmar pass; WF degradation still fails fold0 (−11%).
 */
export const VOLUME_PROFILE_FREQ_SOL_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "SOLUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.002,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpRejectionMinWickRatio: 0.4,
  vpNoveltyEnabled: false,
};

/**
 * AVAX — VAL+rej coin-native prepared-cell stack (2026-07-22 R22 lock).
 *
 * Coin-native Phase 0–4 (FREQ core → funnel → weakBearVac → cell denies → OOS):
 * - Raw / ETH-shaped funnel fails; VAH bleeds; VAL+rej is the only positive funnel.
 * - Edge concentrates in bull_trend vacuum VAL + bull/chop vacuum rejection — NOT bear60-only
 *   (SOL-style bear60 would crush AVAX; do not copy).
 * - Named bleeds locked via cell deny (not year cuts):
 *   SELL val bear_trend|vacuum, bull_chop|vacuum, bear_trend|structured, bull_chop|structured;
 *   SELL va_rejection weak_bear|vacuum;
 *   BUY va_rejection bull_chop (structured/vacuum/tight) — 2022–23 cert-gap fix (H3).
 * - VAL prior5d chase filter (5%) improves OOS without collapsing N.
 * - Wick floors / ext-down rej / ETH sellMacroAdapt / vol-target / deny bear|bull SELL vac rej
 *   REJECTED on AVAX (kill overall edge — those SELL vac rej cells pay hard).
 *
 * DB+funding H3 (2026-07-22): ~166t / +604% / Calmar ~1.48 / DD~29% / OOS +87%;
 * 2022–23 ~−24% (above −25% catastrophic bar). Frequency ~0.59/wk.
 * Not WF+MC certified until harness re-pass — research sleeve.
 */
export const VOLUME_PROFILE_FREQ_AVAX_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "AVAXUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellBlockWeakBearVacuum: true,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: false,
  vpPreparedBlockVacuumValBear: false,
  vpPreparedBlockCellKeys: [
    "SELL|val_breakdown|bear_trend|vacuum",
    "SELL|val_breakdown|bull_chop|vacuum",
    "SELL|val_breakdown|bear_trend|structured",
    "SELL|val_breakdown|bull_chop|structured",
    "SELL|val_breakdown|bear_trend|tight",
    "SELL|va_rejection|weak_bear|vacuum",
    "BUY|va_rejection|bull_chop|structured",
    "BUY|va_rejection|bull_chop|vacuum",
    "BUY|va_rejection|bull_chop|tight",
  ],
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
  if (sym === "SOLUSDT") return VOLUME_PROFILE_FREQ_SOL_15M;
  if (sym === "AVAXUSDT") return VOLUME_PROFILE_FREQ_AVAX_15M;
  return VOLUME_PROFILE_FREQ_15M;
}

/** Deepest macro feature lookback used by FREQ gates (`macroPrior60d`). */
export const VOLUME_PROFILE_MACRO_LOOKBACK_DAYS = 60;

export function volumeProfileMinutesPerBar(tf = "15m") {
  return (
    { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[
      String(tf || "15m").toLowerCase()
    ] ?? 15
  );
}

/**
 * Bars of history needed before the first scored bar: VP profile lookback + 1d,
 * and ≥60d so `macroPrior60d` / bear-flat VAL gates are real (not null / fake-0).
 */
export function volumeProfileHistoryBars(tf = "15m", cfg = {}) {
  const mpb = volumeProfileMinutesPerBar(tf);
  const lookback = Math.max(48, Math.round(Number(cfg?.vpLookbackBars ?? 384)));
  const lookbackPad = lookback + Math.ceil((24 * 60) / mpb);
  const macroBars = Math.ceil((VOLUME_PROFILE_MACRO_LOOKBACK_DAYS * 24 * 60) / mpb);
  return Math.max(lookbackPad, macroBars);
}

/**
 * Warmup pad so rolling VP lookback / HTF / macroPrior60d see history before the
 * run window. Short windows without this pad fake prior60=0 and diverge from live
 * (live holds a multi-week buffer) and from long research runs.
 */
export function volumeProfilePadFromMs(fromMs, tf = "15m", cfg = {}) {
  const mpb = volumeProfileMinutesPerBar(tf);
  const padBars = volumeProfileHistoryBars(tf, cfg);
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
