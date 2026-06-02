#!/usr/bin/env node
/**
 * Liquidity sweep trade funnel — why so few entries vs intraday target (2–3/day).
 * Usage: node scripts/backtest-liq-trade-funnel.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-27");

const { INTRADAY_PRO_LIQ_15M, INTRADAY_PRO_SR_APLUS_15M } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { passesHtfTrend, passesHtfZoneAlignment, passesVolumeExpansion } = await import(
  "../src/strategy/techniques/supportResistance.js",
);
const { detectStructureShift } = await import("../src/strategy/techniques/structureShift.js");
const { passesConfirmationCandle } = await import("../src/strategy/techniques/confirmationCandles.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  precomputeIntraday,
  selectIntradayPicks,
  buildIntradayOptsFromCfg,
  mergeAdaptiveCfg,
} = await import("../src/strategy/intradayPro.js");
const WARMUP = 100;
const {
  scanSessionLiquidityCycles,
  listSessionLiquiditySetups,
  computeLiquidityBrackets,
  utcDayId,
  dayStartIndex,
} = await import("../src/strategy/techniques/liquidity.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
if (!candles.length) {
  console.error("No candles in DB — run a backtest ingest first.");
  process.exit(1);
}
const pre = precomputeIntraday(candles);

function baseCfg(overrides = {}) {
  return fillLiqSoloPresetDefaults(
    fillFibSoloPresetDefaults({
      ...INTRADAY_PRO_LIQ_15M,
      symbol,
      timeframe: tf,
      ...overrides,
    }),
  );
}

function diagnoseFunnel(cfg) {
  const opts = { ...buildIntradayOptsFromCfg(cfg), _liqPre: pre };
  const sweepPct = Number(opts.sweepPct ?? 0.001);
  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  const minQ = Number(opts.intradayLiqMinQuality ?? 0);

  const counts = {
    reclaimBars: 0,
    cyclesRaw: 0,
    failExtension: 0,
    failMaxBars: 0,
    failBrackets: 0,
    failMinRr: 0,
    failReclaimStrength: 0,
    failSameBar: 0,
    passBuildSetup: 0,
    poolCandidates: 0,
    failMinScore: 0,
  };

  const byDayReclaims = new Map();
  const byDayPassed = new Map();

  for (let i = WARMUP; i < candles.length; i++) {
    const day = utcDayId(candles[i].ts);
    const dayStart = dayStartIndex(candles, i);
    const pdh = pre.prevDayHigh[i];
    const pdl = pre.prevDayLow[i];
    if (!(pdh > 0) || !(pdl > 0)) continue;

    for (const side of ["BUY", "SELL"]) {
      const level = side === "BUY" ? pdl : pdh;
      const opposing = side === "BUY" ? pdh : pdl;
      const levelType = side === "BUY" ? "pdl" : "pdh";

      const cycles = scanSessionLiquidityCycles(
        candles,
        i,
        side,
        level,
        opposing,
        levelType,
        sweepPct,
        dayStart,
        opts,
      );
      for (const c of cycles) {
        if (c.reclaimIdx !== i) continue;
        counts.cyclesRaw++;
        byDayReclaims.set(day, (byDayReclaims.get(day) || 0) + 1);

        if (minExt > 0 && c.extension + 1e-6 < minExt) {
          counts.failExtension++;
          continue;
        }
        const maxBars = Number(opts.intradayLiqMaxSweepBars ?? 40);
        if (maxBars > 0 && c.reclaimIdx - c.sweepStartIdx > maxBars) {
          counts.failMaxBars++;
          continue;
        }

        const bar = candles[i];
        if (opts.intradayLiqRejectSameBarReclaim === true && c.reclaimIdx === c.sweepStartIdx) {
          counts.failSameBar++;
          continue;
        }

        const br = computeLiquidityBrackets(side, bar.close, c.wick, c.opposing, opts);
        if (!br) {
          counts.failBrackets++;
          if (br === null) counts.failMinRr++;
          continue;
        }
        if (minRr > 0 && br.rr < minRr) {
          counts.failMinRr++;
          continue;
        }

        counts.passBuildSetup++;
        byDayPassed.set(day, (byDayPassed.get(day) || 0) + 1);
      }
    }
  }

  const liqMinScore = Number(opts.intradayLiqMinScore ?? 6);
  for (let i = WARMUP; i < candles.length; i++) {
    for (const side of ["BUY", "SELL"]) {
      const setups = listSessionLiquiditySetups(candles, i, side, pre, opts);
      for (const s of setups) {
        if (s.reclaimIdx !== i) continue;
        counts.poolCandidates++;
        if (s.score < liqMinScore) counts.failMinScore++;
      }
    }
  }

  const picks = selectIntradayPicks(candles, cfg);
  const tradingDays = new Set();
  for (let i = WARMUP; i < candles.length; i++) {
    tradingDays.add(utcDayId(candles[i].ts));
  }

  const daysWithReclaim = byDayReclaims.size;
  const daysWithPass = byDayPassed.size;

  return {
    counts,
    picks: picks.pickedCount,
    tradingDays: tradingDays.size,
    daysWithReclaim,
    daysWithPass,
    avgReclaimsPerDay: [...byDayReclaims.values()].reduce((a, b) => a + b, 0) / Math.max(1, daysWithReclaim),
    avgPassPerDay: [...byDayPassed.values()].reduce((a, b) => a + b, 0) / Math.max(1, daysWithPass),
  };
}

async function backtestPnl(cfg) {
  const merged = mergeAdaptiveCfg(baseCfg(cfg), candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: { ...merged, symbol, timeframe: tf, manualStrategy: "SR_INTRADAY", marketMode: "FUTURES", riskPerTrade: 2.5, futuresLeverage: 12 },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    symbol,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const m = new Map();
  for (const t of sim.trades) {
    const k = new Date(t.entryTs).toISOString().slice(0, 16) + ":" + t.direction;
    if (!m.has(k)) m.set(k, 0);
    m.set(k, m.get(k) + Number(t.netPnl));
  }
  const arr = [...m.values()];
  const wins = arr.filter((p) => p > 0).length;
  return {
    n: arr.length,
    pnl: arr.reduce((a, b) => a + b, 0),
    wr: arr.length ? (wins / arr.length) * 100 : 0,
  };
}

console.log("\n=== LIQUIDITY SWEEP FUNNEL (BNB 15m) ===\n");
console.log("Bars:", candles.length, "from", new Date(fromMs).toISOString().slice(0, 10));

const current = diagnoseFunnel(INTRADAY_PRO_LIQ_15M);
console.log("\n--- Current preset (INTRADAY_PRO_LIQ_15M) ---");
console.log("Trading days:", current.tradingDays);
console.log("Days with ≥1 raw reclaim:", current.daysWithReclaim, `(${((current.daysWithReclaim / current.tradingDays) * 100).toFixed(0)}%)`);
console.log("Days with ≥1 setup passing filters:", current.daysWithPass);
console.log("Raw reclaim events (PDH/PDL cycles on reclaim bar):", current.counts.cyclesRaw);
console.log(
  "  → fail min extension",
  `${(Number(INTRADAY_PRO_LIQ_15M.intradayLiqMinSweepExtensionPct) * 100).toFixed(2)}%`,
  ":",
  current.counts.failExtension,
);
console.log("  → fail max sweep bars:", current.counts.failMaxBars);
console.log("  → fail brackets/geometry:", current.counts.failBrackets);
console.log("  → fail min R:R:", current.counts.failMinRr);
console.log("  → fail same-bar reclaim:", current.counts.failSameBar);
console.log("Setups passing core filters:", current.counts.passBuildSetup);
console.log("Pool at reclaim (listSessionLiquiditySetups):", current.counts.poolCandidates);
console.log("  → below min score:", current.counts.failMinScore);
console.log("Picked for backtest:", current.picks, `(${(current.picks / current.tradingDays).toFixed(2)}/day)`);
console.log("Target intraday: 2–3/day → need ~", current.tradingDays * 2, "–", current.tradingDays * 3, "trades");

const btCurrent = await backtestPnl(INTRADAY_PRO_LIQ_15M);
console.log("Backtest PnL:", btCurrent.pnl.toFixed(2), "WR:", btCurrent.wr.toFixed(0) + "%", "n:", btCurrent.n);

const variants = [
  { label: "textbook 0.3% ext, RR≥1.2", patch: { intradayLiqMinSweepExtensionPct: 0.003, intradayLiqMinRr: 1.2, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5 } },
  { label: "0.5% ext, RR≥1.2, 2/side/day", patch: { intradayLiqMinSweepExtensionPct: 0.005, intradayLiqMinRr: 1.2, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5 } },
  { label: "0.5% ext, RR off, 3/day cap", patch: { intradayLiqMinSweepExtensionPct: 0.005, intradayLiqMinRr: 0, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5 } },
  { label: "0.35% ext, RR≥1.2, session extreme on", patch: { intradayLiqMinSweepExtensionPct: 0.0035, intradayLiqMinRr: 1.2, intradayLiqSessionExtreme: true, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5 } },
  { label: "loose + no HTF (clusters only)", patch: { intradayLiqMinSweepExtensionPct: 0.004, intradayLiqMinRr: 1.0, intradayLiqRequireHtfAlign: false, intradayLiqOnePickPerDay: false, srIntradayMaxTradesPerDay: 6 } },
];

console.log("\n--- Filter + frequency variants ---\n");
console.log("label".padEnd(42), "passSetup".padStart(8), "picked".padStart(7), "perDay".padStart(7), "PnL".padStart(8), "WR".padStart(5));

for (const v of variants) {
  const f = diagnoseFunnel({ ...INTRADAY_PRO_LIQ_15M, ...v.patch });
  const bt = await backtestPnl({ ...INTRADAY_PRO_LIQ_15M, ...v.patch });
  console.log(
    v.label.padEnd(42),
    String(f.counts.passBuildSetup).padStart(8),
    String(f.picks).padStart(7),
    (f.picks / f.tradingDays).toFixed(2).padStart(7),
    bt.pnl.toFixed(1).padStart(8),
    (bt.wr.toFixed(0) + "%").padStart(5),
  );
}

function diagnoseAplusFunnel(cfg) {
  const opts = { ...buildIntradayOptsFromCfg(cfg), _liqPre: pre };
  const counts = {
    liqSetups: 0,
    failHtfTrend: 0,
    failZone: 0,
    failBos: 0,
    failConfirm: 0,
    failVol: 0,
    passAplus: 0,
  };
  for (let i = WARMUP; i < candles.length; i++) {
    for (const side of ["BUY", "SELL"]) {
      const setups = listSessionLiquiditySetups(candles, i, side, pre, opts);
      for (const setup of setups) {
        if (setup.reclaimIdx !== i) continue;
        counts.liqSetups++;
        if (!passesHtfTrend(side, pre, i, opts)) {
          counts.failHtfTrend++;
          continue;
        }
        const bar = candles[i];
        if (!passesHtfZoneAlignment(side, bar, pre, i, setup, opts)) {
          counts.failZone++;
          continue;
        }
        const cycle = {
          reclaimIdx: setup.reclaimIdx,
          sweepStartIdx: setup.sweepStartIdx,
          wick: setup.wick,
        };
        const bos = detectStructureShift(candles, cycle, side, opts);
        if (opts.intradaySrRequireBos !== false && !bos.ok) {
          counts.failBos++;
          continue;
        }
        const confirmIdx = bos.ok ? bos.bosIdx : i;
        const confirmBar = candles[confirmIdx];
        const confirmPrev = confirmIdx > 0 ? candles[confirmIdx - 1] : null;
        if (
          opts.intradaySrRequireConfirm !== false &&
          !passesConfirmationCandle(confirmBar, confirmPrev, side, opts)
        ) {
          counts.failConfirm++;
          continue;
        }
        if (
          opts.intradaySrRequireVolume !== false &&
          !passesVolumeExpansion(pre, confirmIdx, opts) &&
          !passesVolumeExpansion(pre, i, opts)
        ) {
          counts.failVol++;
          continue;
        }
        counts.passAplus++;
      }
    }
  }
  const picks = selectIntradayPicks(candles, cfg).pickedCount;
  return { counts, picks };
}

console.log("\n=== INSTITUTIONAL A+ FUNNEL ===\n");
const aplusCfg = fillLiqSoloPresetDefaults({ ...INTRADAY_PRO_SR_APLUS_15M, symbol, timeframe: tf });
const aplusF = diagnoseAplusFunnel(aplusCfg);
console.log("Liquidity setups at reclaim:", aplusF.counts.liqSetups);
console.log("  → fail HTF trend:", aplusF.counts.failHtfTrend);
console.log("  → fail HTF zone:", aplusF.counts.failZone);
console.log("  → fail BOS:", aplusF.counts.failBos);
console.log("  → fail confirmation:", aplusF.counts.failConfirm);
console.log("  → fail volume:", aplusF.counts.failVol);
console.log("Pass full A+ checklist:", aplusF.counts.passAplus);
console.log("Picked:", aplusF.picks);
const btAplus = await backtestPnl(aplusCfg);
console.log("A+ backtest PnL:", btAplus.pnl.toFixed(2), "WR:", btAplus.wr.toFixed(0) + "%", "n:", btAplus.n);

await closePool();
