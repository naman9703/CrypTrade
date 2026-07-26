#!/usr/bin/env node
/**
 * DOGE F3 residual under locked bear-HTF 0.35% —
 * autopsy 2024-25 + 2020-21 losers → soft probes → ONE hard A/B family.
 *
 * Goal: no year left catastrophically red. Not "less negative".
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-residual-optimize.mjs
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
const BAD_YEARS = ["2024-25", "2020-21"];

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
  VOLUME_PROFILE_FREQ_DOGE_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

/** Locked DOGE sleeve = baseline for residual work. */
const LOCKED = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpNoveltyEnabled: false,
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
    years[y] ??= { n: 0, start: eq, net: 0 };
    years[y].n += 1;
    const pnl = Number(t.netPnl ?? 0);
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
    y.net = +y.net.toFixed(2);
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
  const cfg = { ...LOCKED, ...over, backtestSignalStartMs: fromMs };
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

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : "—";
}

function bucket(label, rows, fn) {
  const m = {};
  for (const r of rows) {
    const k = fn(r);
    m[k] ??= [];
    m[k].push(r);
  }
  console.log(`\n-- ${label} --`);
  const out = [];
  for (const [k, list] of Object.entries(m).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
    const s = summarize(list);
    out.push({ k, ...s });
    console.log(`  ${String(k).padEnd(48)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
  }
  return out;
}

function yearOk(ret) {
  if (ret == null) return true;
  return ret > -10; // soft bar: no year worse than -10% under research sleeve
}

function scorecard(h0, r) {
  const badYears = BAD_YEARS.map((y) => ({
    y,
    from: h0.years[y]?.retPct ?? 0,
    to: r.years[y]?.retPct ?? 0,
  }));
  const allYears = Object.keys({ ...h0.years, ...r.years });
  const yearKeep = allYears.every((y) => {
    const a = r.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    // good years must not collapse >12pp; bad years must improve
    if (BAD_YEARS.includes(y)) return a > b + 3;
    return a >= b - 12;
  });
  const allAcceptable = allYears.every((y) => yearOk(r.years[y]?.retPct));
  const fullOk = r.ret >= h0.ret - 5;
  const freqOk = r.tw >= h0.tw * 0.75;
  return {
    yearKeep,
    allAcceptable,
    fullOk,
    freqOk,
    accept: yearKeep && fullOk && freqOk && r.ret > 0,
    optimized: allAcceptable && r.ret > 0 && r.pf >= 1.1,
    badYears,
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCKED);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

console.log(`\n══ 0) Locked DOGE F3 baseline ══`);
const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(
  `H0 n=${h0.trades} tw=${h0.tw} ret=${h0.ret}% pf=${h0.pf} cal=${h0.calmar} dd=${h0.dd}%`,
);
console.log(
  `  years ${Object.entries(h0.years)
    .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
    .join(" ")}`,
);
console.log(
  `  RED years: ${Object.entries(h0.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`)
    .join(" ") || "none"}`,
);

const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling",
    lookback: 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, LOCKED);
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  rows.push({
    year: yearBucket(ts),
    side,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    cell: cell.key,
    macro: cell.macro,
    pathLabel: cell.path,
    isVacuum: Number(path?.distPct ?? 0) >= 0.02,
    pathPct: Number(path?.distPct ?? 0),
    prior5d,
    prior20d,
    prior60d,
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
  });
}

for (const by of BAD_YEARS) {
  const bad = rows.filter((r) => r.year === by);
  const good = rows.filter((r) => !BAD_YEARS.includes(r.year) && r.year !== "2020-21");
  console.log(`\n══ 1) Residual autopsy ${by} ══`);
  console.log("bad:", summarize(bad));
  const losers = bad.filter((r) => !r.win);
  const winners = bad.filter((r) => r.win);
  console.log("losers vs winners means:");
  for (const k of ["prior5d", "prior20d", "prior60d", "pathPct", "htfSep"]) {
    console.log(
      `  ${k.padEnd(10)} L=${fmt(avg(losers.map((r) => r[k])))} W=${fmt(avg(winners.map((r) => r[k])))} goodAll=${fmt(avg(good.map((r) => r[k])))}`,
    );
  }
  bucket(`${by} cells`, bad, (r) => r.cell);
  bucket(`${by} side|macro|path`, bad, (r) => `${r.side}|${r.macro}|${r.pathLabel}`);
}

const residual2425 = rows.filter((r) => r.year === "2024-25");
const residual2021 = rows.filter((r) => r.year === "2020-21");
const goodPool = rows.filter((r) => !BAD_YEARS.includes(r.year));

console.log("\n══ 2) Soft probes (full tagged book) ══");
const probes = [
  { id: "drop_SELL_bear_structured", pred: (r) => r.cell === "SELL|va_rejection|bear_trend|structured" },
  { id: "drop_SELL_bear_vacuum", pred: (r) => r.cell === "SELL|va_rejection|bear_trend|vacuum" },
  { id: "drop_SELL_bull_chop_any", pred: (r) => r.side === "SELL" && r.macro === "bull_chop" },
  { id: "drop_BUY_bull_chop_any", pred: (r) => r.side === "BUY" && r.macro === "bull_chop" },
  { id: "drop_BUY_bull_trend_vac", pred: (r) => r.cell === "BUY|va_rejection|bull_trend|vacuum" },
  { id: "drop_SELL_weak_bear_vac", pred: (r) => r.cell === "SELL|va_rejection|weak_bear|vacuum" },
  { id: "drop_SELL_prior20_le_m15", pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.15 },
  { id: "drop_SELL_prior20_le_m10", pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.1 },
  { id: "drop_BUY_prior5_gt08", pred: (r) => r.side === "BUY" && r.prior5d != null && r.prior5d > 0.08 },
  { id: "drop_SELL_htf_lt050", pred: (r) => r.side === "SELL" && Number.isFinite(r.htfSep) && r.htfSep < 0.005 },
  { id: "drop_bear_htf_lt050", pred: (r) => r.macro === "bear_trend" && r.side === "SELL" && Number.isFinite(r.htfSep) && r.htfSep < 0.005 },
  {
    id: "drop_SELL_ext_down_05",
    pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.05,
  },
];

for (const p of probes) {
  const kept = rows.filter((r) => !p.pred(r));
  const sAll = summarize(kept);
  const s2425 = summarize(kept.filter((r) => r.year === "2024-25"));
  const s2021 = summarize(kept.filter((r) => r.year === "2020-21"));
  const sGood = summarize(kept.filter((r) => !BAD_YEARS.includes(r.year)));
  console.log(
    `${p.id.padEnd(30)} drop=${rows.length - kept.length} ALL n=${sAll.n} net=${sAll.net} | 24-25 ${s2425.net} | 20-21 ${s2021.net} | good ${sGood.net}`,
  );
}

// Hard A/B candidates from residual evidence (existing knobs + scoped denies)
const variants = [
  { id: "H0_locked", over: {} },
  { id: "bear_htf_050", over: { vpRejectionSellBearMinHtfSepPct: 0.005 } },
  {
    id: "ext_down_05",
    over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 },
  },
  {
    id: "ext_down_10",
    over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.1 },
  },
  { id: "buy_block_bull_trend", over: { vpBuyRejectionBlockBullTrend: true } },
  {
    id: "deny_bear_structured",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|bear_trend|structured"],
    },
  },
  {
    id: "deny_bear_vacuum_residual",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|bear_trend|vacuum"],
    },
  },
  {
    id: "deny_bull_chop_BUY",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "BUY|va_rejection|bull_chop|vacuum",
        "BUY|va_rejection|bull_chop|structured",
        "BUY|va_rejection|bull_chop|tight",
      ],
    },
  },
  {
    id: "deny_SELL_bull_chop",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|bull_chop|vacuum",
        "SELL|va_rejection|bull_chop|structured",
        "SELL|va_rejection|bull_chop|tight",
      ],
    },
  },
  {
    id: "wick_040",
    over: { vpRejectionMinWickRatio: 0.4 },
  },
];

console.log(`\n══ 3) Hard A/B vs locked H0 ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = scorecard(h0, m);
  ab.push({ id: v.id, over: v.over, ...m, score: sc });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} dd=${m.dd}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  accept=${sc.accept} optimized=${sc.optimized} yearKeep=${sc.yearKeep} allOk=${sc.allAcceptable}`,
  );
}

ab.sort((a, b) => Number(b.score.optimized) - Number(a.score.optimized) || Number(b.score.accept) - Number(a.score.accept) || b.ret - a.ret);
console.log("\n══ 4) Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(28)} opt=${r.score.optimized} acc=${r.score.accept} ret=${r.ret}% 24-25=${r.years["2024-25"]?.retPct ?? "—"} 20-21=${r.years["2020-21"]?.retPct ?? "—"} 21-22=${r.years["2021-22"]?.retPct ?? "—"} 25-26=${r.years["2025-26"]?.retPct ?? "—"}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-residual-optimize.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      h0,
      residual2425: summarize(residual2425),
      residual2021: summarize(residual2021),
      goodPool: summarize(goodPool),
      ab,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
