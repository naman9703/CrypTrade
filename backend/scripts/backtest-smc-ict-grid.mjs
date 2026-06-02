#!/usr/bin/env node
/**
 * SMC/ICT config grid — fast pick scan + full sim on top combos.
 * Usage: node scripts/backtest-smc-ict-grid.mjs [--quick|--full] [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const QUICK = process.argv.includes("--quick") || !process.argv.includes("--full");
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const WARMUP = 100;
const TOP_N_SIM = 12;

const { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  precomputeIntraday,
  selectIntradayPicks,
  buildIntradayBacktestAdapter,
  mergeAdaptiveCfg,
  buildIntradayOptsFromCfg,
} = await import("../src/strategy/intradayPro.js");
const { evaluateSmcIctSetup } = await import("../src/strategy/evaluateSmcIctSetup.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

const pre = precomputeIntraday(candles);

function baseCfg(overrides = {}) {
  return fillSmcSoloPresetDefaults({
    ...INTRADAY_PRO_ICT_15M,
    symbol,
    timeframe: tf,
    ...overrides,
  });
}

/** Reuses `pre` — same SMC solo path + daily caps as selectIntradayPicks. */
function fastCountPicks(cfg) {
  const o = { ...buildIntradayOptsFromCfg(cfg), ...cfg };
  const maxPerDay = Number(o.maxTradesPerDay ?? 3);
  const smcMinScore = Number(o.intradaySmcMinScore ?? o.intradayLiqMinScore ?? 7);
  const minGap = Number(o.minBarGap ?? 4);
  const maxPerSide = Number(o.intradayLiqMaxTradesPerSidePerDay ?? 1);
  const smcOpts = { ...o, _liqPre: pre };
  const pool = [];

  for (let i = WARMUP; i < candles.length; i++) {
    if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
    for (const side of ["BUY", "SELL"]) {
      const setup = evaluateSmcIctSetup(candles, i, side, pre, smcOpts);
      if (!setup || setup.reclaimIdx !== i || setup.score < smcMinScore) continue;
      pool.push({ idx: i, day: utcDayId(candles[i].ts), score: setup.score, action: side });
    }
  }

  const byDay = new Map();
  for (const c of pool) {
    const list = byDay.get(c.day) || [];
    list.push(c);
    byDay.set(c.day, list);
  }

  let picked = 0;
  for (const list of byDay.values()) {
    list.sort((a, b) => b.score - a.score);
    const chosen = [];
    const sideCount = { BUY: 0, SELL: 0 };
    if (o.intradayLiqOnePickPerDay === true && list.length > 0) {
      for (const side of ["BUY", "SELL"]) {
        const sidePool = list.filter((c) => c.action === side);
        if (sidePool.length) {
          chosen.push(sidePool[0]);
          picked++;
        }
      }
      continue;
    }
    for (const c of list) {
      if (chosen.length >= maxPerDay) break;
      if (sideCount[c.action] >= maxPerSide) continue;
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < minGap)) continue;
      chosen.push(c);
      sideCount[c.action] += 1;
      picked++;
    }
  }
  return picked;
}

function label(cfg) {
  return [
    `kz=${cfg.intradaySmcKillzoneMode ?? "?"}`,
    `ez=${cfg.intradaySmcEntryZoneMode ?? "?"}`,
    `adx=${cfg.intradaySmcMinAdx ?? "?"}`,
    `mss=${cfg.intradaySmcRequireMss !== false}`,
    `retrace=${cfg.intradaySmcRequireRetrace !== false}`,
    `conf=${cfg.intradaySmcRequireConfirm === true}`,
    `rr=${cfg.intradaySmcMinRr ?? cfg.intradayLiqMinRr ?? "?"}`,
    `htf=${cfg.intradaySmcHtfStrictness ?? "?"}`,
    `reqHtf=${cfg.intradaySmcRequireHtfBias !== false}`,
  ].join(" ");
}

function* gridCombos() {
  const killzones = QUICK ? ["ALL", "NY"] : ["ALL", "NY", "LONDON", "SILVER_BULLET", "ASIA"];
  const entryZones = QUICK ? ["EITHER"] : ["OB", "FVG", "EITHER"];
  const adxVals = QUICK ? [0, 15, 18] : [0, 12, 15, 18, 22];
  const htfModes = QUICK ? ["either", "both"] : ["either", "4h", "1h", "both"];
  const mssVals = QUICK ? [true] : [false, true];
  const retraceVals = [false, true];
  const htfReqVals = QUICK ? [true] : [false, true];
  const minRrVals = QUICK ? [0, 2] : [0, 1.5, 2, 2.5];

  for (const intradaySmcKillzoneMode of killzones) {
    for (const intradaySmcEntryZoneMode of entryZones) {
      for (const intradaySmcMinAdx of adxVals) {
        for (const intradaySmcHtfStrictness of htfModes) {
          for (const intradaySmcRequireMss of mssVals) {
            for (const intradaySmcRequireRetrace of retraceVals) {
              for (const intradaySmcRequireHtfBias of htfReqVals) {
                for (const intradaySmcMinRr of minRrVals) {
                  yield {
                    intradaySmcKillzoneMode,
                    intradaySmcEntryZoneMode,
                    intradaySmcMinAdx,
                    intradaySmcHtfStrictness,
                    intradaySmcRequireMss,
                    intradaySmcRequireRetrace,
                    intradaySmcRequireHtfBias,
                    intradaySmcMinRr,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

const benchmarks = [
  { tag: "preset_ict", cfg: baseCfg() },
  {
    tag: "strict_ny",
    cfg: baseCfg({
      intradaySmcKillzoneMode: "NY",
      intradaySmcMinAdx: 18,
      intradaySmcHtfStrictness: "both",
      intradaySmcRequireRetrace: true,
      intradaySmcMinRr: 2,
    }),
  },
  {
    tag: "balanced_no_retrace",
    cfg: baseCfg({
      intradaySmcRequireRetrace: false,
      intradaySmcMinAdx: 15,
      intradaySmcMinRr: 1.5,
    }),
  },
];

const results = [];
let n = 0;
const t0 = Date.now();

for (const overrides of gridCombos()) {
  n++;
  const cfg = baseCfg(overrides);
  const picks = fastCountPicks(cfg);
  results.push({ picks, cfg, label: label(cfg) });
  if (n % 1000 === 0) {
    process.stderr.write(`  ${n} combos, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }
}

results.sort((a, b) => b.picks - a.picks);

const presetCfg = baseCfg();
const presetPicksFast = fastCountPicks(presetCfg);
const presetPicksFull = (() => {
  // Match the live/backtest engine: it adaptive-merges cfg before selecting picks.
  const merged = mergeAdaptiveCfg(presetCfg, candles);
  const { series } = selectIntradayPicks(candles, merged);
  return series.filter((s) => s?.action && s.ts >= fromMs && s.ts <= toMs).length;
})();

console.log(
  JSON.stringify(
    {
      mode: QUICK ? "quick" : "full",
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      combos: n,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
      preset: { label: label(presetCfg), picksFast: presetPicksFast, picksFull: presetPicksFull },
      benchmarks: benchmarks.map((b) => ({
        tag: b.tag,
        label: label(b.cfg),
        picks: fastCountPicks(b.cfg),
      })),
      topByPicks: results.slice(0, 12).map((r) => ({ picks: r.picks, label: r.label })),
      zeroPickCount: results.filter((r) => r.picks === 0).length,
      withPicks: results.filter((r) => r.picks > 0).length,
      medianPicks: results[Math.floor(results.length / 2)]?.picks ?? 0,
    },
    null,
    2,
  ),
);

process.stderr.write(`\nFull sim (${TOP_N_SIM + benchmarks.length} configs)...\n`);

async function simRow(cfg, tag) {
  const merged = mergeAdaptiveCfg(cfg, candles);
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
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: tf,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs);
  const pnls = trades.map((t) => Number(t.netPnl ?? t.pnlUsdt ?? 0));
  const pnl = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const startEq = 10_000;
  let peak = startEq;
  let maxDd = 0;
  let eq = startEq;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return {
    tag,
    label: label(merged),
    trades: trades.length,
    winRatePct: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    pnlUsdt: Math.round(pnl * 100) / 100,
    returnPct: Math.round((pnl / startEq) * 10000) / 100,
    maxDdPct: Math.round(maxDd * 10000) / 100,
  };
}

const seen = new Set();
const simTargets = benchmarks.map((b) => ({ tag: b.tag, cfg: b.cfg }));
for (const r of results) {
  if (simTargets.length >= TOP_N_SIM + benchmarks.length) break;
  if (seen.has(r.label)) continue;
  seen.add(r.label);
  simTargets.push({ tag: `top_picks_${simTargets.length}`, cfg: r.cfg });
}

const simResults = [];
for (const { tag, cfg } of simTargets) {
  simResults.push(await simRow(cfg, tag));
  process.stderr.write(`  ${tag} ok (${simResults.at(-1).trades} trades)\n`);
}

console.log("\n--- SIM RESULTS ---");
console.log(JSON.stringify(simResults, null, 2));
