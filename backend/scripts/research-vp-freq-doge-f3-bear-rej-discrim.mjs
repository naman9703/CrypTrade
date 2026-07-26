#!/usr/bin/env node
/**
 * DOGE F3 residual — discriminator inside SELL|va_rejection|bear_trend|* bleed.
 * Soft buckets → ONE hard A/B (no blanket cell deny).
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-bear-rej-discrim.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "DOGEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const BAD_YEAR = "2024-25";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { describeVpConditionCell } = await import("../src/strategy/vpConditionCell.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function findIdx(candles, ts) {
  let lo = 0,
    hi = candles.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
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

async function run(candles, funding, over = {}) {
  const cfg = { ...CORE, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function avg(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function bucketExpectancy(rows, key, edges) {
  const bins = {};
  for (const r of rows) {
    const v = r[key];
    let label = "unk";
    if (Number.isFinite(v)) {
      label = `>${edges[edges.length - 1]}`;
      for (let i = 0; i < edges.length; i++) {
        if (v <= edges[i]) {
          label = i === 0 ? `≤${edges[i]}` : `${edges[i - 1]}→${edges[i]}`;
          break;
        }
      }
    }
    bins[label] ??= [];
    bins[label].push(r);
  }
  console.log(`\n-- ${key} buckets --`);
  for (const [k, list] of Object.entries(bins).sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = summarize(list);
    console.log(`  ${k.padEnd(20)} n=${s.n} net=${s.net} wr=${s.wr}%`);
  }
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const baseTrades = await run(candles, funding);
const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
  const path = (() => {
    const vp = buildVolumeProfile(candles, idx, {
      mode: "rolling",
      lookback: 384,
      bins: 50,
      includePriorSession: true,
    });
    return vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  })();
  const cell = describeVpConditionCell(pre, idx, side, setup, path, CORE);
  if (side !== "SELL" || cell.macro !== "bear_trend") continue;
  rows.push({
    year: yearBucket(ts),
    pnl: Number(t.netPnl ?? 0),
    cell: cell.key,
    pathPct: Number(path?.distPct ?? 0),
    isVacuum: Number(path?.distPct ?? 0) >= 0.02,
    prior5d: priorPct(candles, idx, 96 * 5),
    prior20d: priorPct(candles, idx, 96 * 20),
    prior60d: priorPct(candles, idx, 96 * 60),
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
  });
}

const bad = rows.filter((r) => r.year === BAD_YEAR);
const good = rows.filter((r) => r.year !== BAD_YEAR && r.year !== "2020-21");
console.log("\n══ SELL bear_trend rej only ══");
console.log("all", summarize(rows));
console.log("bad", summarize(bad));
console.log("good", summarize(good));
console.log("bad means", {
  p5: avg(bad.map((r) => r.prior5d)),
  p20: avg(bad.map((r) => r.prior20d)),
  p60: avg(bad.map((r) => r.prior60d)),
  htf: avg(bad.map((r) => r.htfSep)),
  path: avg(bad.map((r) => r.pathPct)),
});
console.log("good means", {
  p5: avg(good.map((r) => r.prior5d)),
  p20: avg(good.map((r) => r.prior20d)),
  p60: avg(good.map((r) => r.prior60d)),
  htf: avg(good.map((r) => r.htfSep)),
  path: avg(good.map((r) => r.pathPct)),
});

console.log("\nBAD year buckets");
bucketExpectancy(bad, "prior5d", [-0.05, -0.02, 0, 0.02, 0.05]);
bucketExpectancy(bad, "prior20d", [-0.15, -0.1, -0.05, 0]);
bucketExpectancy(bad, "htfSep", [0.002, 0.0035, 0.005, 0.008]);
bucketExpectancy(bad, "pathPct", [0.01, 0.02, 0.03, 0.05]);

console.log("\nGOOD years buckets");
bucketExpectancy(good, "prior5d", [-0.05, -0.02, 0, 0.02, 0.05]);
bucketExpectancy(good, "prior20d", [-0.15, -0.1, -0.05, 0]);
bucketExpectancy(good, "htfSep", [0.002, 0.0035, 0.005, 0.008]);
bucketExpectancy(good, "pathPct", [0.01, 0.02, 0.03, 0.05]);

// Soft: within bear SELL rej, drop subtypes
function soft(label, pred) {
  const keptAll = rows.filter((r) => !pred(r));
  // Reconstruct approximate full book by replacing bear-trend sells with kept subset
  // Better: apply as full-sim filters below. Soft here is cell-local only.
  const badK = bad.filter((r) => !pred(r));
  const goodK = good.filter((r) => !pred(r));
  console.log(
    `${label.padEnd(40)} bad ${summarize(bad).net}→${summarize(badK).net} (n ${bad.length}→${badK.length}) | good ${summarize(good).net}→${summarize(goodK).net} (n ${good.length}→${goodK.length})`,
  );
}

console.log("\n══ Soft subtype drops (bear_trend SELL rej only) ══");
soft("drop vacuum path≥2%", (r) => r.isVacuum);
soft("drop structured/tight", (r) => !r.isVacuum);
soft("drop htfSep<0.0035", (r) => Number.isFinite(r.htfSep) && r.htfSep < 0.0035);
soft("drop htfSep<0.005", (r) => Number.isFinite(r.htfSep) && r.htfSep < 0.005);
soft("drop prior20d≤-10%", (r) => r.prior20d != null && r.prior20d <= -0.1);
soft("drop prior20d≤-5%", (r) => r.prior20d != null && r.prior20d <= -0.05);
soft("drop prior5d>0", (r) => r.prior5d != null && r.prior5d > 0);
soft("drop prior5d≤-5%", (r) => r.prior5d != null && r.prior5d <= -0.05);

// Hard A/B: universal-looking candidates only
const variants = [
  { id: "H0", over: {} },
  // Require stronger HTF on ALL sells (FREQ already has HTF align at 0.15%)
  { id: "H_sell_htf_035", over: { vpSellMinHtfSepPct: 0.0035, vpSellMacroAdapt: false } },
  { id: "H_sell_htf_050", over: { vpSellMinHtfSepPct: 0.005, vpSellMacroAdapt: false } },
  // Extended-down block (prior20 ≤ -5%) — already rejected globally; re-measure with focus
  { id: "H_ext_down_05", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  // Deeper washout only (prior20 ≤ -10%) — may be more universal for false bear rej
  { id: "H_ext_down_10", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.1 } },
  // Deny only structured bear (vacuum pays in good years weakly; structured bled bad year)
  {
    id: "deny_bear_structured",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|bear_trend|structured"],
    },
  },
  // Deny vacuum ONLY when also shallow HTF — need code. Approximate with sell htf 0.35 + keep vacuum.
];

console.log("\n══ Hard A/B ══");
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, ...m });
  console.log(
    `${v.id} FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} | ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%`)
      .join(" ")}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-bear-rej-discrim.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), ab, bad: summarize(bad), good: summarize(good) }, null, 2));
console.error("wrote", outPath);
await closePool?.();
