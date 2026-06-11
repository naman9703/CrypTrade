#!/usr/bin/env node
/**
 * Jun 1–4 2026 — why LIQ+S/R missed moves; per-day funnel + backtest variants.
 * Usage: node scripts/analyze-jun1-4-liq-misses.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse("2026-05-28");
const toMs = Date.parse("2026-06-05");
const studyFrom = Date.parse("2026-06-01");
const studyTo = Date.parse("2026-06-05");

const { INTRADAY_PRO_LIQ_15M, INTRADAY_PRO_SR_APLUS_15M, INTRADAY_PRO_LIQ_DAILY_15M } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  precomputeIntraday,
  selectIntradayPicks,
  buildIntradayOptsFromCfg,
  mergeAdaptiveCfg,
  buildIntradayBacktestAdapter,
} = await import("../src/strategy/intradayPro.js");
const {
  scanSessionLiquidityCycles,
  computeLiquidityBrackets,
  utcDayId,
  dayStartIndex,
} = await import("../src/strategy/techniques/liquidity.js");
const { evaluateInstitutionalSrSetup } = await import("../src/strategy/evaluateInstitutionalSr.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);

const WARMUP = 100;

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs, toMs);
if (!candles.length) {
  console.error("No candles — sync BNB 15m first.");
  process.exit(1);
}
const pre = precomputeIntraday(candles);

function baseCfg(overrides = {}) {
  return fillLiqSoloPresetDefaults(
    fillFibSoloPresetDefaults({
      ...INTRADAY_PRO_SR_APLUS_15M,
      symbol,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      ...overrides,
    }),
  );
}

function dayLabel(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function barTime(ts) {
  return new Date(ts).toISOString().slice(11, 16);
}

function inStudyDay(ts) {
  return ts >= studyFrom && ts < studyTo;
}

function diagnoseDay(cfg, dayStr) {
  const opts = { ...buildIntradayOptsFromCfg(cfg), _liqPre: pre };
  const instMode = cfg.intradaySrAPlusMode === true || cfg.intradayGateInstitutionalSr === true;
  const sweepPct = Number(opts.sweepPct ?? 0.001);
  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  const minScore = Number(opts.intradayLiqMinScore ?? 6);

  const events = [];
  const blockers = {};

  const bump = (k) => {
    blockers[k] = (blockers[k] || 0) + 1;
  };

  for (let i = WARMUP; i < candles.length; i++) {
    if (dayLabel(candles[i].ts) !== dayStr) continue;
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
        const bar = candles[i];
        const ext = c.extension * 100;
        let stage = "raw_reclaim";
        let fail = null;

        if (minExt > 0 && c.extension + 1e-6 < minExt) {
          fail = `extension ${ext.toFixed(2)}% < ${(minExt * 100).toFixed(2)}%`;
          bump("failExtension");
        } else if (opts.intradayLiqRejectSameBarReclaim === true && c.reclaimIdx === c.sweepStartIdx) {
          fail = "same_bar_reclaim";
          bump("failSameBar");
        } else {
          const br = computeLiquidityBrackets(side, bar.close, c.wick, c.opposing, opts);
          if (!br) {
            fail = "brackets_null (minRr/geometry)";
            bump("failBrackets");
          } else if (minRr > 0 && br.rr < minRr) {
            fail = `minRr ${br.rr.toFixed(2)} < ${minRr}`;
            bump("failMinRr");
          } else {
            stage = "brackets_ok";
            if (instMode) {
              const sr = evaluateInstitutionalSrSetup(candles, i, side, pre, opts);
              if (!sr) {
                fail = "institutional_sr_gate";
                bump("failInstSr");
              } else if (sr.score < minScore) {
                fail = `score ${sr.score} < ${minScore}`;
                bump("failMinScore");
              } else {
                stage = "picked_candidate";
              }
            } else if (br && minScore > 0) {
              const qScore = Math.min(12, Math.round(6 + (ext + br.rr * 100) / 50));
              if (qScore < minScore) {
                fail = `score ${qScore} < ${minScore}`;
                bump("failMinScore");
              } else stage = "picked_candidate";
            }
          }
        }

        events.push({
          utc: `${dayStr} ${barTime(bar.ts)}`,
          side,
          levelType,
          close: bar.close,
          level,
          wick: c.wick,
          extPct: ext,
          pdh,
          pdl,
          stage,
          fail,
        });
      }
    }
  }

  return { events, blockers };
}

async function backtestCfg(label, cfg) {
  const merged = mergeAdaptiveCfg(baseCfg(cfg), candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
      backtestPositionSizing: "RISK_AT_SL",
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    symbol,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const studyTrades = sim.trades.filter((t) => inStudyDay(t.entryTs));
  const pnl = studyTrades.reduce((a, t) => a + Number(t.netPnl), 0);
  const wins = studyTrades.filter((t) => Number(t.netPnl) > 0).length;
  const byDay = new Map();
  for (const t of studyTrades) {
    const d = dayLabel(t.entryTs);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  return {
    label,
    totalTrades: studyTrades.length,
    pnl,
    retPct: pnl,
    wr: studyTrades.length ? (wins / studyTrades.length) * 100 : 0,
    byDay: Object.fromEntries(byDay),
    exits: studyTrades.map((t) => ({
      day: dayLabel(t.entryTs),
      utc: barTime(t.entryTs),
      dir: t.direction,
      exit: t.exitReason,
      pnl: Number(t.netPnl).toFixed(2),
    })),
  };
}

console.log("\n=== BNB 15m LIQ+S/R miss analysis: Jun 1–4 2026 ===\n");
console.log("Candles loaded:", candles.length, dayLabel(candles[0].ts), "→", dayLabel(candles.at(-1).ts));

const currentCfg = baseCfg({});
const studyDays = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];

for (const d of studyDays) {
  const pdhIdx = candles.findIndex((c) => dayLabel(c.ts) === d);
  const i = Math.max(WARMUP, pdhIdx);
  const pdh = pre.prevDayHigh[i];
  const pdl = pre.prevDayLow[i];
  console.log(`\n--- ${d}  PDH=${pdh?.toFixed?.(2)} PDL=${pdl?.toFixed?.(2)} ---`);
  const { events, blockers } = diagnoseDay(currentCfg, d);
  console.log("Blockers:", blockers);
  const cands = events.filter((e) => e.stage === "picked_candidate");
  console.log(`Raw reclaims: ${events.length}  Passed all gates: ${cands.length}`);
  for (const e of cands.slice(0, 6)) {
    console.log(`  ✓ ${e.utc} ${e.side} ${e.levelType} ext=${e.extPct.toFixed(2)}% close=${e.close.toFixed(2)}`);
  }
  for (const e of events.filter((x) => x.fail).slice(0, 8)) {
    console.log(`  ✗ ${e.utc} ${e.side} ${e.levelType} — ${e.fail}`);
  }
}

const picks = selectIntradayPicks(candles, currentCfg);
const pickedStudy = [];
for (let i = WARMUP; i < candles.length; i++) {
  if (!inStudyDay(candles[i].ts)) continue;
  if (picks.series[i]) {
    pickedStudy.push({
      day: dayLabel(candles[i].ts),
      utc: barTime(candles[i].ts),
      side: picks.series[i].action,
      score: picks.series[i].score,
      reason: picks.series[i].reason,
    });
  }
}
console.log("\n--- Current preset PICKS (Jun 1–4) ---");
console.log("Count:", pickedStudy.length);
for (const p of pickedStudy) console.log(`  ${p.day} ${p.utc} ${p.side} score=${p.score} ${p.reason}`);

const variants = [
  { label: "current A+ preset", cfg: {} },
  {
    label: "freq: ext.4 rr1.5 no1pick 2/side vol1.0",
    cfg: {
      intradayLiqMinSweepExtensionPct: 0.004,
      intradayLiqMinRr: 1.5,
      intradayLiqOnePickPerDay: false,
      intradayLiqMaxTradesPerSidePerDay: 2,
      srIntradayMaxTradesPerDay: 4,
      intradaySrMinVolRatio: 1.0,
      intradaySrRequireBos: true,
      intradaySrRequireConfirm: false,
      srIntradayMinBarGap: 2,
    },
  },
  {
    label: "freq: ext.3 rr1.2 no bos confirm vol0.9",
    cfg: {
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinRr: 1.2,
      intradayLiqMinReclaimBodyRatio: 0.25,
      intradayLiqOnePickPerDay: false,
      intradayLiqMaxTradesPerSidePerDay: 2,
      srIntradayMaxTradesPerDay: 4,
      intradaySrRequireBos: false,
      intradaySrRequireConfirm: false,
      intradaySrMinVolRatio: 0.9,
      intradayLiqRejectSameBarReclaim: false,
      srIntradayMinBarGap: 2,
    },
  },
  {
    label: "liq-only no inst SR gates",
    cfg: {
      intradaySrAPlusMode: false,
      intradayGateInstitutionalSr: false,
      intradayGateHtfRegime: false,
      intradayLiqMinSweepExtensionPct: 0.004,
      intradayLiqMinRr: 1.5,
      intradayLiqOnePickPerDay: false,
      intradayLiqMaxTradesPerSidePerDay: 2,
      srIntradayMaxTradesPerDay: 4,
      srIntradayMinBarGap: 2,
    },
  },
  {
    label: "NEW: LIQ_DAILY trend continuation",
    cfg: { ...INTRADAY_PRO_LIQ_DAILY_15M },
  },
  {
    label: "NEW daily tuned rvol/adx",
    cfg: {
      ...INTRADAY_PRO_LIQ_DAILY_15M,
      intradayLiqMinRr: 1.2,
      intradayLiqTrendMinRvol: 0.75,
      intradayLiqTrendMinAdx: 14,
    },
  },
];

console.log("\n--- Backtest variants (Jun 1–4 only, $100 start, 2.5% risk) ---\n");
for (const v of variants) {
  const r = await backtestCfg(v.label, v.cfg);
  console.log(
    `${r.label.padEnd(42)} trades=${String(r.totalTrades).padStart(2)} ret=${r.retPct.toFixed(2)}% WR=${r.wr.toFixed(0)}% days=${JSON.stringify(r.byDay)}`,
  );
  for (const t of r.exits) console.log(`    ${t.day} ${t.utc} ${t.dir} ${t.exit} $${t.pnl}`);
}

await closePool?.();
