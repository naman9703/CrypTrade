#!/usr/bin/env node
/**
 * DOGE VP FREQ — F3 va_rejection Phase 1–4:
 *   baseline → 2024-25 autopsy vs good years → soft probes → ONE hard A/B.
 *
 * Coin-native only. Do not copy AVAX/ETH/BTC cell matrices.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-2024-autopsy.mjs
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
const GOOD_YEARS = new Set(["2023-24", "2025-26", "2022-23", "2021-22"]);

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
  vpPreparedAllowlistOnly: false,
  vpPreparedBlockCellKeys: [],
  vpPreparedCellKeys: [],
  vpPreparedRegimeOnly: false,
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

function atrPct(candles, idx, n = 14) {
  if (idx < n) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const pc = Number(candles[i - 1]?.close ?? candles[i].close);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr = sum / n;
  const c = Number(candles[idx].close);
  return c > 0 ? atr / c : null;
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
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0, avg: n ? +(net / n).toFixed(2) : 0 };
}

function avg(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
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

function softDrop(rows, pred) {
  const kept = rows.filter((r) => !pred(r));
  return { dropped: rows.length - kept.length, ...summarize(kept.map((r) => ({ pnl: r.pnl }))) };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

console.log(`\n══ 0) DOGE F3 baseline ══ ${FROM}→${TO}`);
const baseTrades = await run(candles, funding);
const baseM = metricsFor(baseTrades);
console.log(
  `H0 n=${baseM.trades} tw=${baseM.tw} ret=${baseM.ret}% pf=${baseM.pf} cal=${baseM.calmar} dd=${baseM.dd}%`,
);
console.log(
  `  years ${Object.entries(baseM.years)
    .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
    .join(" ")}`,
);

const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const atr = atrPct(candles, idx, 14);
  const vp = buildVolumeProfile(candles, idx, {
    mode: CORE.vpProfileMode ?? "rolling",
    lookback: CORE.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const pathPct = Number(path?.distPct ?? 0);
  const isVacuum = pathPct >= 0.02;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, CORE);
  const htfSep = Number(pre?.htfSep?.[idx] ?? NaN);
  rows.push({
    ts,
    year: yearBucket(ts),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    prior5d,
    prior20d,
    prior60d,
    atr,
    pathPct,
    isVacuum,
    cell: cell.key,
    macro: cell.macro,
    pathLabel: cell.path,
    htfSep,
    win: Number(t.netPnl ?? 0) > 0,
  });
}

const bad = rows.filter((r) => r.year === BAD_YEAR);
const good = rows.filter((r) => GOOD_YEARS.has(r.year));
console.log(`\n══ 1) Market character — ${BAD_YEAR} vs good years ══`);
console.log(`bad ${BAD_YEAR}:`, summarize(bad));
console.log(`good years pool:`, summarize(good));

const featKeys = ["prior5d", "prior20d", "prior60d", "pathPct", "atr", "htfSep"];
console.log("\nfeature means (bad losers vs bad winners vs good all):");
const badL = bad.filter((r) => !r.win);
const badW = bad.filter((r) => r.win);
for (const k of featKeys) {
  console.log(
    `  ${k.padEnd(10)} badL=${fmt(avg(badL.map((r) => r[k])))} badW=${fmt(avg(badW.map((r) => r[k])))} good=${fmt(avg(good.map((r) => r[k])))}`,
  );
}
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : "—";
}

const badCells = bucket(`${BAD_YEAR} cells`, bad, (r) => r.cell);
bucket(`${BAD_YEAR} side|vac`, bad, (r) => `${r.side}|vac=${r.isVacuum ? 1 : 0}`);
bucket(`${BAD_YEAR} macro`, bad, (r) => r.macro);
bucket(`good years cells`, good, (r) => r.cell);

console.log("\n══ 2) Soft probes (counterfactual drop on tagged rows) ══");
const probes = [
  {
    id: "drop_bad_year_worst_cell",
    pred: (r) => {
      const worst = badCells[0]?.k;
      return worst && r.cell === worst;
    },
  },
  { id: "drop_SELL_vacuum", pred: (r) => r.side === "SELL" && r.isVacuum },
  { id: "drop_BUY_vacuum", pred: (r) => r.side === "BUY" && r.isVacuum },
  { id: "drop_weak_bear", pred: (r) => r.macro === "weak_bear" },
  { id: "drop_bull_chop", pred: (r) => r.macro === "bull_chop" },
  { id: "drop_bear_trend", pred: (r) => r.macro === "bear_trend" },
  { id: "drop_SELL_prior5d_gt5", pred: (r) => r.side === "SELL" && r.prior5d != null && r.prior5d > 0.05 },
  { id: "drop_BUY_prior5d_gt8", pred: (r) => r.side === "BUY" && r.prior5d != null && r.prior5d > 0.08 },
  { id: "drop_SELL_prior20d_le_m5", pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.05 },
  { id: "drop_path_vacuum", pred: (r) => r.isVacuum },
  {
    id: "drop_SELL_ext_down_rej",
    pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.05,
  },
];

const softRows = [];
for (const p of probes) {
  const full = softDrop(rows, p.pred);
  const badOnly = softDrop(bad, p.pred);
  const goodOnly = softDrop(good, p.pred);
  softRows.push({ id: p.id, full, badOnly, goodOnly });
  console.log(
    `${p.id.padEnd(32)} drop=${full.dropped} FULL n=${full.n} net=${full.net} | bad n=${badOnly.n} net=${badOnly.net} | good n=${goodOnly.n} net=${goodOnly.net}`,
  );
}

// Pick hard A/B candidates from autopsy evidence (not soft harvest alone).
// Prefer: improves bad year AND does not destroy good-year net; uses existing knobs.
const hardVariants = [
  { id: "H0_baseline", over: {} },
  {
    id: "H1_rej_sell_block_ext_down",
    over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 },
  },
  {
    id: "H2_buy_rej_block_bull_trend",
    over: { vpBuyRejectionBlockBullTrend: true },
  },
  {
    id: "H3_buy_rej_block_unprepared",
    over: { vpBuyRejectionBlockUnpreparedMacro: true },
  },
  {
    id: "H4_sell_macro_adapt",
    over: {
      vpSellMacroAdapt: true,
      vpSellMinHtfSepPct: 0.0025,
      vpSellMacroBullMinHtfSepPct: 0.005,
      vpSellMacroPrior20dBullPct: 0.02,
    },
  },
  {
    id: "H5_wick_floor_040",
    over: { vpRejectionMinWickRatio: 0.4 },
  },
];

// Add top 1–2 cell denies from bad year if they have n≥3 and negative net,
// and the same cell is not strongly positive in good years.
const goodByCell = {};
for (const r of good) {
  goodByCell[r.cell] ??= 0;
  goodByCell[r.cell] += r.pnl;
}
const denyCells = badCells
  .filter((c) => c.n >= 3 && c.net < -5 && (goodByCell[c.k] ?? 0) <= 5)
  .slice(0, 2)
  .map((c) => c.k);
for (const cell of denyCells) {
  hardVariants.push({
    id: `deny_${cell.replace(/\|/g, "_")}`,
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [cell],
    },
  });
}
if (denyCells.length >= 2) {
  hardVariants.push({
    id: "deny_top2_bad_cells",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: denyCells,
    },
  });
}

console.log(`\n══ 3) Hard A/B (one-family) vs H0 ══`);
console.log(`deny cells from autopsy: ${denyCells.join(" , ") || "(none)"}`);
const ab = [];
for (const v of hardVariants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} dd=${m.dd} | years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}`,
  );
}

const h0 = ab[0];
const scored = ab
  .slice(1)
  .map((r) => {
    const badY = r.years[BAD_YEAR]?.retPct ?? -999;
    const h0Bad = h0.years[BAD_YEAR]?.retPct ?? -999;
    const goodKeep = ["2021-22", "2022-23", "2023-24", "2025-26"].every((y) => {
      const a = r.years[y]?.retPct;
      const b = h0.years[y]?.retPct;
      if (a == null || b == null) return true;
      // allow small degradation
      return a >= b - 15;
    });
    const improvedBad = badY > h0Bad + 5;
    const fullOk = r.ret > h0.ret;
    const freqOk = r.tw >= h0.tw * 0.7;
    return {
      id: r.id,
      improvedBad,
      goodKeep,
      fullOk,
      freqOk,
      accept: improvedBad && goodKeep && fullOk && freqOk && r.ret > 0,
      badY,
      h0Bad,
      ret: r.ret,
      tw: r.tw,
    };
  })
  .sort((a, b) => Number(b.accept) - Number(a.accept) || b.ret - a.ret);

console.log("\n══ 4) Accept scorecard ══");
for (const s of scored) {
  console.log(
    `${s.id.padEnd(40)} accept=${s.accept} badΔ ${s.h0Bad}→${s.badY} full=${s.ret}% tw=${s.tw} goodKeep=${s.goodKeep} fullOk=${s.fullOk} freqOk=${s.freqOk}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  baseline: baseM,
  badYear: BAD_YEAR,
  badSummary: summarize(bad),
  goodSummary: summarize(good),
  badCells,
  softRows,
  denyCells,
  ab,
  scorecard: scored,
};
const outPath = path.join(__dirname, ".vp-freq-doge-f3-2024-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("wrote", outPath);
await closePool?.();
