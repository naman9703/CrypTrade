#!/usr/bin/env node
/**
 * XRP VP FREQ — Phase 1 funnel + cell autopsy + one-change A/B (IS/OOS).
 *
 * Coin-native only — do not copy AVAX/SOL/ETH cell matrices.
 * Prior 1y screen: uniform ETH-shaped −37% (VAH+VAL bleed).
 *
 * Usage: node scripts/backtest-vp-freq-xrp-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "XRPUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2023-06-01";
const START_USDT = 100;
const RISK_PCT = 2.5;
const LEVERAGE = 12;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: RISK_PCT,
  riskPerTradeUnit: "PCT",
  futuresLeverage: LEVERAGE,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
};

/** Isolated funnels — pick best OOS before cell work. */
const FUNNELS = [
  {
    id: "F0_open",
    over: {
      vpAllowedSetups: [
        "lvn_vacuum",
        "vah_breakout",
        "val_breakdown",
        "poc_bounce",
        "va_rejection",
        "naked_poc",
      ],
    },
  },
  {
    id: "F1_val_rej",
    over: { vpAllowedSetups: ["val_breakdown", "va_rejection"] },
  },
  {
    id: "F2_val_only",
    over: { vpAllowedSetups: ["val_breakdown"] },
  },
  {
    id: "F3_rej_only",
    over: { vpAllowedSetups: ["va_rejection"] },
  },
  {
    id: "F4_vah_val",
    over: { vpAllowedSetups: ["vah_breakout", "val_breakdown"] },
  },
  {
    id: "F5_val_rej_wbVac",
    over: {
      vpAllowedSetups: ["val_breakdown", "va_rejection"],
      vpValSellBlockWeakBearVacuum: true,
    },
  },
  {
    id: "F6_val_rej_chase",
    over: {
      vpAllowedSetups: ["val_breakdown", "va_rejection"],
      vpValSellBlockWeakBearVacuum: true,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function metricsFor(trades) {
  let eq = START_USDT;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const years = {};
  eq = START_USDT;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

function sliceMetrics(trades, lo, hi) {
  const subset = trades.filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = START_USDT;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of subset) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: subset, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const weeks = Math.max(1, (hi - lo) / (7 * 864e5));
  return {
    trades: subset.length,
    tw: +(subset.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...CORE, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function cellAutopsy(trades) {
  const by = {};
  for (const t of trades) {
    const k = String(t.vpConditionCellKey || "?");
    by[k] ??= { n: 0, pnl: 0, y22n: 0, y22: 0, oosN: 0, oos: 0 };
    const pnl = Number(t.netPnl ?? 0);
    by[k].n += 1;
    by[k].pnl += pnl;
    if (yearBucket(t.entryTs) === "2022-23") {
      by[k].y22n += 1;
      by[k].y22 += pnl;
    }
    if (Number(t.entryTs) < oosEndMs) {
      by[k].oosN += 1;
      by[k].oos += pnl;
    }
  }
  return Object.entries(by)
    .map(([k, v]) => ({
      k,
      n: v.n,
      pnl: +v.pnl.toFixed(2),
      y22n: v.y22n,
      y22: +v.y22.toFixed(2),
      oosN: v.oosN,
      oos: +v.oos.toFixed(2),
    }))
    .sort((a, b) => a.pnl - b.pnl);
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
process.stderr.write(`ensureKlines ${SYMBOL}…\n`);
if (process.env.SKIP_ENSURE !== "1") {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
}
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
process.stderr.write(`candles=${candles.length} funding=${funding.length}\n`);

const funnelRows = [];
console.log(`\n══ XRP funnel screen ══ ${FROM}→${TO} OOS≤${OOS_END}`);
for (const f of FUNNELS) {
  process.stderr.write(`run ${f.id}\n`);
  const trades = await run(candles, funding, f.over);
  const full = metricsFor(trades);
  const oos = sliceMetrics(trades, fromMs, oosEndMs);
  const is = sliceMetrics(trades, oosEndMs, toMs);
  const row = { id: f.id, full, oos, is, years: full.years };
  funnelRows.push(row);
  console.log(
    `${f.id.padEnd(18)} FULL tr=${full.trades} tw=${full.tw} ret=${full.ret} cal=${full.calmar} pf=${full.pf} | OOS ret=${oos.ret} pf=${oos.pf} n=${oos.trades} | IS ret=${is.ret}`,
  );
  console.log(
    `  years ${Object.entries(full.years)
      .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
      .join(" ")}`,
  );
}

funnelRows.sort((a, b) => b.oos.ret - a.oos.ret || b.full.calmar - a.full.calmar);
const best = funnelRows[0];
console.log(`\nBest OOS funnel: ${best.id} (OOS ${best.oos.ret}% / full cal ${best.full.calmar})`);

const bestFunnel = FUNNELS.find((f) => f.id === best.id);
process.stderr.write(`autopsy ${best.id}\n`);
const bestTrades = await run(candles, funding, bestFunnel.over);
const cells = cellAutopsy(bestTrades);
console.log(`\n══ Cell autopsy (${best.id}) — worst overall ══`);
for (const c of cells.slice(0, 15)) {
  console.log(`  ${c.n}\t${c.pnl}\ty22 ${c.y22n}/${c.y22}\toos ${c.oosN}/${c.oos}\t${c.k}`);
}
console.log(`\n══ Best overall ══`);
for (const c of cells.slice(-8).reverse()) {
  console.log(`  ${c.n}\t${c.pnl}\ty22 ${c.y22n}/${c.y22}\toos ${c.oosN}/${c.oos}\t${c.k}`);
}

/** One-change cell denies from worst bleeds with n≥3 or strong OOS bleed. */
const denyCandidates = cells
  .filter((c) => c.pnl < -15 && (c.n >= 3 || c.oos < -20))
  .slice(0, 5)
  .map((c) => c.k);

const abRows = [];
if (denyCandidates.length) {
  console.log(`\n══ One-change cell denies vs ${best.id} ══`);
  process.stderr.write(`run baseline_again\n`);
  const baseTrades = bestTrades;
  const baseFull = metricsFor(baseTrades);
  const baseOos = sliceMetrics(baseTrades, fromMs, oosEndMs);
  abRows.push({ id: "H0_baseline", full: baseFull, oos: baseOos });

  for (const cell of denyCandidates) {
    const id = `deny_${cell.replace(/\|/g, "_")}`;
    process.stderr.write(`run ${id}\n`);
    const over = {
      ...bestFunnel.over,
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [cell],
    };
    const trades = await run(candles, funding, over);
    const full = metricsFor(trades);
    const oos = sliceMetrics(trades, fromMs, oosEndMs);
    abRows.push({ id, cell, full, oos });
    console.log(
      `${id}\n  FULL tr=${full.trades} ret=${full.ret} cal=${full.calmar} pf=${full.pf} | OOS ret=${oos.ret} n=${oos.trades}`,
    );
    console.log(
      `  years ${Object.entries(full.years)
        .map(([y, s]) => `${y}:${s.retPct}%`)
        .join(" ")}`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  window: { from: FROM, to: TO, oosEnd: OOS_END },
  funnels: funnelRows,
  bestFunnel: best.id,
  cells: cells.slice(0, 40),
  oneChange: abRows,
};
const outPath = path.join(__dirname, ".vp-freq-xrp-optimize.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("wrote", outPath);

await closePool?.();
