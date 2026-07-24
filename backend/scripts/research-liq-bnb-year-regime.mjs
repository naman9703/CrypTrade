#!/usr/bin/env node
/**
 * BNB LIQ — VP-style year-by-year regime autopsy + relative abstain search.
 *
 * Process (docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md):
 * 1) Year windows vs baseline
 * 2) Setup / context cells that pay vs bleed
 * 3) Universal vs year-specific features
 * 4) Soft condition→abstain rules that flip years without crushing others
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-year-regime.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2023-07-01";
const TO = process.env.TO || "2026-07-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { resolveSessionNarrative } = await import("../src/strategy/techniques/liq/marketState.js");
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js"
);

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  return "other_loss";
}

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  };
}

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const t = Number(ts);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].ts);
    if (ct === t) return mid;
    if (ct < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function priorReturn(candles, idx, bars) {
  if (idx < bars) return NaN;
  const a = Number(candles[idx - bars]?.close);
  const b = Number(candles[idx]?.close);
  if (!(a > 0) || !(b > 0)) return NaN;
  return (b - a) / a;
}

function yearWindows(lo, hi) {
  const out = [];
  let y = new Date(lo).getUTCFullYear();
  const endY = new Date(hi - 1).getUTCFullYear();
  while (y <= endY) {
    const a = Math.max(lo, Date.UTC(y, 0, 1));
    const b = Math.min(hi, Date.UTC(y + 1, 0, 1));
    if (b > a) out.push({ id: `Y${y}`, lo: a, hi: b });
    y += 1;
  }
  // Rolling one-year slices ending at TO (VP-style)
  out.push({ id: "H12m", lo: Math.max(lo, hi - 365.25 * 864e5), hi });
  out.push({ id: "FULL", lo, hi });
  return out;
}

function rateBy(rows, keyFn, minN = 5) {
  const m = {};
  for (const r of rows) {
    const k = keyFn(r);
    m[k] ??= { n: 0, pnl: 0, wins: 0, instant: 0 };
    m[k].n += 1;
    m[k].pnl += r.pnl;
    if (r.win) m[k].wins += 1;
    if (r.fc === "never_green" || r.fc === "sl_no_follow") m[k].instant += 1;
  }
  return Object.entries(m)
    .map(([k, v]) => {
      let gp = 0;
      let gl = 0;
      for (const r of rows.filter((x) => keyFn(x) === k)) {
        if (r.pnl > 0) gp += r.pnl;
        else gl += Math.abs(r.pnl);
      }
      return {
        k,
        n: v.n,
        pnl: +v.pnl.toFixed(2),
        wr: +((100 * v.wins) / Math.max(1, v.n)).toFixed(1),
        avg: +(v.pnl / v.n).toFixed(3),
        pf: +(gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(3),
        instantPct: +((100 * v.instant) / Math.max(1, v.n)).toFixed(1),
      };
    })
    .filter((x) => x.n >= minN)
    .sort((a, b) => a.avg - b.avg);
}

function softKeep(rows, label, pred) {
  const keep = rows.filter(pred);
  let gp = 0;
  let gl = 0;
  for (const r of keep) {
    if (r.pnl > 0) gp += r.pnl;
    else gl += Math.abs(r.pnl);
  }
  const pf = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
  const pnl = keep.reduce((s, r) => s + r.pnl, 0);
  return {
    label,
    keep: keep.length,
    keepPct: +((100 * keep.length) / Math.max(1, rows.length)).toFixed(1),
    pf: +pf.toFixed(3),
    pnl: +pnl.toFixed(2),
    wr: +((100 * keep.filter((r) => r.win).length) / Math.max(1, keep.length)).toFixed(1),
  };
}

function baseCfg(over = {}) {
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  return materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
}

async function runSim(candles, funding, over = {}) {
  clearIntradayAdapterCache?.();
  const cfg = baseCfg(over);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const pad = 21 * 864e5;
const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
const pre = precomputeIntraday(candles);

console.log(`BNB LIQ year-regime | ${candles.length} bars | ${FROM}→${TO}`);
console.log("CORE defaults BE-off=", INTRADAY_PRO_LIQ_CORE_15M.intradayLiqBreakevenAfterPartial);

const trades = await runSim(candles, funding, {});
console.log("\n========== PHASE 0 — YEAR TABLE ==========");
const windows = yearWindows(fromMs, toMs);
const yearMetrics = {};
for (const w of windows) {
  const m = metrics(trades, w.lo, w.hi);
  yearMetrics[w.id] = m;
  console.log(`${w.id.padEnd(6)} n=${String(m.n).padStart(4)} ${String(m.tw).padStart(5)}/wk ret=${String(m.ret).padStart(8)}% PF=${m.pf} WR=${m.wr}% DD=${m.dd}%`);
}

function enrich(t) {
  const idx = findIdx(candles, t.entryBarTs ?? t.entryTs);
  const dir =
    t.direction === -1 || t.direction === "SELL" || t.direction === "short" ? "SELL" : "BUY";
  const level = String(t.liqContext?.levelType ?? "?");
  const feat = t.liqContext?.features ?? {};
  const reclaimIdx = Number(feat.reclaimIdx ?? NaN);
  const sweepStart = Number(feat.sweepStartIdx ?? NaN);
  const sameBar = Number.isFinite(reclaimIdx) && Number.isFinite(sweepStart) && reclaimIdx === sweepStart;
  let dayType = "range";
  if (idx >= 0) {
    if (isBreakdownDay(candles, idx, pre)) dayType = "breakdown";
    else if (isBreakoutDay(candles, idx, pre)) dayType = "breakout";
  }
  const narrative = resolveSessionNarrative(Number(t.entryTs));
  const prior5 = priorReturn(candles, idx, 5 * 96); // ~5d on 15m
  const prior20 = priorReturn(candles, idx, 20 * 96);
  const prior60 = priorReturn(candles, idx, 60 * 96);
  const htfUp = !!pre.htfUp?.[idx];
  const htfDown = !!pre.htfDown?.[idx];
  const htfAlign = (dir === "BUY" && htfUp) || (dir === "SELL" && htfDown);
  const htfAgainst = (dir === "BUY" && htfDown) || (dir === "SELL" && htfUp);
  const toxicFade =
    (dir === "BUY" && dayType === "breakdown") || (dir === "SELL" && dayType === "breakout");
  const withTrendFade =
    (dir === "BUY" && dayType === "breakout") || (dir === "SELL" && dayType === "breakdown");
  const macro =
    Number.isFinite(prior60) && prior60 > 0.15
      ? "bull60"
      : Number.isFinite(prior60) && prior60 < -0.15
        ? "bear60"
        : "flat60";
  const oppR = Number(feat.continuation?.distanceToOpposingR ?? NaN);
  const disp = Number(feat.displacement?.impulseAtr ?? NaN);
  const slDist =
    Math.abs(Number(t.entryPrice) - Number(t.initialSlPrice || t.slPrice || 0)) /
    Math.max(Number(t.entryPrice), 1e-9);
  const pnl = Number(t.netPnl ?? 0);
  const year = new Date(Number(t.entryTs)).getUTCFullYear();
  return {
    t,
    pnl,
    win: pnl > 0,
    fc: failClass(t),
    dir,
    level,
    sameBar,
    dayType,
    narrative,
    toxicFade,
    withTrendFade,
    htfAlign,
    htfAgainst,
    prior5,
    prior20,
    prior60,
    macro,
    oppR,
    disp,
    slDist,
    year,
    entryTs: Number(t.entryTs),
  };
}

const rows = trades
  .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
  .map(enrich);

console.log("\n========== PHASE 1 — 2025 MARKET CHARACTER ==========");
const y2025 = rows.filter((r) => r.year === 2025);
console.log("2025 n=", y2025.length, softKeep(y2025, "all", () => true));
console.log("dayType", rateBy(y2025, (r) => r.dayType, 8));
console.log("toxicFade", rateBy(y2025, (r) => (r.toxicFade ? "toxic" : "ok"), 8));
console.log("level", rateBy(y2025, (r) => r.level, 8));
console.log("sameBar", rateBy(y2025, (r) => (r.sameBar ? "same" : "multi"), 8));
console.log("narrative", rateBy(y2025, (r) => r.narrative, 8));
console.log("macro", rateBy(y2025, (r) => r.macro, 8));
console.log("htf", rateBy(y2025, (r) => (r.htfAgainst ? "against" : r.htfAlign ? "align" : "flat"), 8));
console.log("dir×day", rateBy(y2025, (r) => `${r.dir}_${r.dayType}`, 5));
console.log("level×toxic", rateBy(y2025, (r) => `${r.level}_${r.toxicFade ? "tox" : "ok"}`, 5));

console.log("\n========== PHASE 2 — UNIVERSAL vs YEAR-SPECIFIC ==========");
function cellSign(yearRows, pred) {
  const sub = yearRows.filter(pred);
  if (sub.length < 8) return { n: sub.length, avg: null };
  const avg = sub.reduce((s, r) => s + r.pnl, 0) / sub.length;
  return { n: sub.length, avg: +avg.toFixed(3) };
}
const cells = [
  ["toxicFade", (r) => r.toxicFade],
  ["!toxicFade", (r) => !r.toxicFade],
  ["sameBar", (r) => r.sameBar],
  ["multiBar", (r) => !r.sameBar],
  ["session_ext", (r) => r.level === "session_high" || r.level === "session_low"],
  ["pdh_pdl", (r) => r.level === "pdh" || r.level === "pdl"],
  ["htfAgainst", (r) => r.htfAgainst],
  ["!htfAgainst", (r) => !r.htfAgainst],
  ["bull60", (r) => r.macro === "bull60"],
  ["bear60", (r) => r.macro === "bear60"],
  ["asia", (r) => r.narrative === "asia_accum"],
  ["london", (r) => r.narrative === "london_sweep"],
  ["ny", (r) => r.narrative === "ny_continuation"],
  ["!toxic+multi", (r) => !r.toxicFade && !r.sameBar],
  ["!toxic+pdh_pdl", (r) => !r.toxicFade && (r.level === "pdh" || r.level === "pdl")],
  ["!toxic+multi+pdh", (r) => !r.toxicFade && !r.sameBar && (r.level === "pdh" || r.level === "pdl")],
  ["SELL_breakdown", (r) => r.dir === "SELL" && r.dayType === "breakdown"],
  ["BUY_breakout", (r) => r.dir === "BUY" && r.dayType === "breakout"],
  ["BUY_breakdown", (r) => r.dir === "BUY" && r.dayType === "breakdown"],
  ["SELL_breakout", (r) => r.dir === "SELL" && r.dayType === "breakout"],
];

console.log("cell".padEnd(22), "Y2023", "Y2024", "Y2025", "Y2026", "universal?");
for (const [name, pred] of cells) {
  const byY = {};
  for (const y of [2023, 2024, 2025, 2026]) {
    byY[y] = cellSign(
      rows.filter((r) => r.year === y),
      pred,
    );
  }
  const avgs = [2023, 2024, 2025, 2026].map((y) => byY[y].avg).filter((a) => a != null);
  const allPos = avgs.length >= 2 && avgs.every((a) => a > 0);
  const allNeg = avgs.length >= 2 && avgs.every((a) => a < 0);
  const tag = allPos ? "KEEP-univ" : allNeg ? "ABSTAIN-univ" : "mixed";
  console.log(
    name.padEnd(22),
    ...[2023, 2024, 2025, 2026].map((y) => {
      const c = byY[y];
      return c.avg == null ? "n/a".padStart(10) : `${c.avg}`.padStart(10);
    }),
    tag,
  );
}

console.log("\n========== PHASE 3 — SOFT ABSTAINS (per year + full) ==========");
const rules = [
  ["all", () => true],
  ["abstain_toxic", (r) => !r.toxicFade],
  ["abstain_sameBar", (r) => !r.sameBar],
  ["abstain_session", (r) => r.level === "pdh" || r.level === "pdl"],
  ["abstain_htfAgainst", (r) => !r.htfAgainst],
  ["keep_!tox_multi", (r) => !r.toxicFade && !r.sameBar],
  ["keep_!tox_pdh", (r) => !r.toxicFade && (r.level === "pdh" || r.level === "pdl")],
  ["keep_!tox_multi_pdh", (r) => !r.toxicFade && !r.sameBar && (r.level === "pdh" || r.level === "pdl")],
  ["keep_withTrend_or_range", (r) => !r.toxicFade],
  ["abstain_asia", (r) => r.narrative !== "asia_accum"],
  ["keep_london_ny", (r) => r.narrative === "london_sweep" || r.narrative === "ny_continuation"],
  ["abstain_bull60_SELL", (r) => !(r.macro === "bull60" && r.dir === "SELL")],
  ["abstain_bear60_BUY", (r) => !(r.macro === "bear60" && r.dir === "BUY")],
  ["macro_align_fade", (r) => !(r.macro === "bull60" && r.dir === "SELL") && !(r.macro === "bear60" && r.dir === "BUY")],
  ["!tox+macroAlign", (r) => !r.toxicFade && !(r.macro === "bull60" && r.dir === "SELL") && !(r.macro === "bear60" && r.dir === "BUY")],
  ["!tox+multi+macro", (r) => !r.toxicFade && !r.sameBar && !(r.macro === "bull60" && r.dir === "SELL") && !(r.macro === "bear60" && r.dir === "BUY")],
];

function yearSoft(year) {
  const yr = rows.filter((r) => r.year === year);
  return rules.map(([label, pred]) => softKeep(yr, label, pred));
}

for (const y of [2025, 2024, 2023, 2026]) {
  console.log(`\n--- soft Y${y} ---`);
  const softs = yearSoft(y).sort((a, b) => b.pf - a.pf);
  for (const s of softs.slice(0, 8)) console.log(s);
}

console.log("\n--- soft FULL (need pf>=1) ---");
for (const [label, pred] of rules) {
  const s = softKeep(rows, label, pred);
  if (s.pf >= 0.9 || label === "all") console.log(s);
}

// Hard A/B candidates from soft winners
console.log("\n========== PHASE 4 — HARD A/B (relative rules) ==========");
const variants = [
  ["H0", {}],
  ["D1_daySitBias", { intradayLiqDaySituationBias: true }],
  ["D2_noSame", { intradayLiqRejectSameBarReclaim: true }],
  ["D3_pdhPdlOnly", { intradayLiqSessionExtreme: false }],
  ["D4_day+noSame", { intradayLiqDaySituationBias: true, intradayLiqRejectSameBarReclaim: true }],
  ["D5_day+pdh", { intradayLiqDaySituationBias: true, intradayLiqSessionExtreme: false }],
  ["D6_htfAlign", { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true }],
  ["D7_day+htf", { intradayLiqDaySituationBias: true, intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true }],
  ["D8_day+noSame+pdh", { intradayLiqDaySituationBias: true, intradayLiqRejectSameBarReclaim: true, intradayLiqSessionExtreme: false }],
  ["D9_killzone", { intradayLiqRequireKillzone: true }],
  ["D10_day+kz", { intradayLiqDaySituationBias: true, intradayLiqRequireKillzone: true }],
];

const ab = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}\n`);
  const t = await runSim(candles, funding, over);
  const row = { id };
  for (const w of windows) {
    row[w.id] = metrics(t, w.lo, w.hi);
  }
  ab.push(row);
  const y25 = row.Y2025;
  const y24 = row.Y2024;
  const full = row.FULL;
  const h12 = row.H12m;
  const y25Ok = y25.pf >= 1 && y25.ret > 0;
  const fullOk = full.pf >= 1 && full.ret > 0;
  console.log(
    `${id.padEnd(18)} Y25 pf=${y25.pf} ret=${y25.ret} n=${y25.n} | Y24 pf=${y24.pf} ret=${y24.ret} | H12 pf=${h12.pf} ret=${h12.ret} | FULL pf=${full.pf} ret=${full.ret} tw=${full.tw}${y25Ok ? " ★Y25" : ""}${fullOk ? " ★FULL" : ""}`,
  );
}

const outPath = path.join(__dirname, ".liq-bnb-year-regime.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      from: FROM,
      to: TO,
      yearMetrics,
      ab,
      note: "VP-style relative abstain search; promote only if Y25+ improves and other years not crushed",
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);
await closePool?.();
