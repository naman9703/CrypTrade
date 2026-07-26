#!/usr/bin/env node
/**
 * BUYBD half-year regime autopsy + causal stand-down screening.
 *
 * Known: prepared-mit BUYBD is EG on Y1+HOLD+FULL but −9.6% in 2026 H1 (regime
 * concentration). Phase-6 rule: find a MEASURABLE causal condition where the
 * setup fails and stand down there — no calendar cherry-picking.
 *
 * Method:
 *  1. One FULL sim (2023-07 → 2026-07-24) of the BUYBD config.
 *  2. Tag every trade with rolling, entry-time-causal market features:
 *     30d return, 30d vol percentile (vs trailing 1y), 14d/100d range
 *     compression, position in 60d range, ADX / atrPct / regime / daySituation.
 *  3. Per-half-year metrics on R-multiples (sizing-independent).
 *  4. Feature contrast: failing halves vs green halves.
 *  5. Soft-screen relative stand-down rules; a rule is interesting only if it
 *     (a) rescues the failing half's meanR, (b) keeps ≥60% of trades, and
 *     (c) does not turn any green half red.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-half-regime-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = Date.parse("2023-07-01");
const TO = Date.parse("2026-07-24");

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const CFG_BASE = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  maxDailyLoss: 0,
  riskConsecutiveLossLimit: 0,
};

// ── daily series for causal features ────────────────────────────────────────
function buildDailySeries(candles) {
  const days = [];
  let cur = null;
  for (const c of candles) {
    const d = new Date(Number(c.ts));
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (!cur || cur.key !== key) {
      if (cur) days.push(cur);
      cur = { key, open: +c.open, high: +c.high, low: +c.low, close: +c.close };
    } else {
      cur.high = Math.max(cur.high, +c.high);
      cur.low = Math.min(cur.low, +c.low);
      cur.close = +c.close;
    }
  }
  if (cur) days.push(cur);
  return days;
}

function dayIdxAt(days, ts) {
  const d = new Date(Number(ts));
  const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let lo = 0;
  let hi = days.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid].key <= key) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Rolling entry-time features from *prior* completed days only (causal). */
function marketFeaturesAt(days, ts) {
  const i = dayIdxAt(days, ts) - 1; // last fully completed day
  if (i < 40) return null;
  const closeAt = (k) => days[k].close;
  const ret = (n) => (i - n >= 0 ? (closeAt(i) - closeAt(i - n)) / closeAt(i - n) : null);

  // daily returns for vol
  const dRets = [];
  for (let k = Math.max(1, i - 365); k <= i; k++) {
    dRets.push((days[k].close - days[k - 1].close) / days[k - 1].close);
  }
  const std = (arr) => {
    if (arr.length < 5) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  };
  const vol30 = std(dRets.slice(-30));
  // percentile of vol30 vs rolling 30d windows over trailing year
  const windows = [];
  for (let end = 30; end <= dRets.length; end += 5) {
    const w = std(dRets.slice(end - 30, end));
    if (w != null) windows.push(w);
  }
  const volPctile =
    vol30 != null && windows.length > 5
      ? windows.filter((w) => w <= vol30).length / windows.length
      : null;

  const range = (k) => days[k].high - days[k].low;
  const avgRange = (n) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - n + 1); k <= i; k++) {
      s += range(k) / days[k].close;
      c++;
    }
    return c ? s / c : null;
  };
  const r14 = avgRange(14);
  const r100 = avgRange(100);

  let hi60 = -Infinity;
  let lo60 = Infinity;
  for (let k = Math.max(0, i - 59); k <= i; k++) {
    hi60 = Math.max(hi60, days[k].high);
    lo60 = Math.min(lo60, days[k].low);
  }
  const posInRange60 = hi60 > lo60 ? (closeAt(i) - lo60) / (hi60 - lo60) : null;

  return {
    ret7: ret(7),
    ret30: ret(30),
    ret90: ret(90),
    vol30,
    volPctile,
    compression: r14 != null && r100 != null && r100 > 0 ? r14 / r100 : null,
    posInRange60,
  };
}

// ── metrics on R (sizing-independent) ───────────────────────────────────────
function rOf(t) {
  // Same fallback chain as engine/metrics.js — mitigation fills can lack initialRiskUsd.
  let risk = Number(t.initialRiskUsd ?? 0);
  if (!(risk > 0)) {
    const entry = Number(t.entryPrice ?? t.entryFill);
    const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
      risk = Math.abs(entry - stop) * qty;
    }
  }
  return risk > 0 ? Number(t.netPnl) / risk : null;
}
function rMetrics(list) {
  const rs = list
    .map((t) => (t.r != null ? Number(t.r) : rOf(t)))
    .filter((x) => x != null && Number.isFinite(x));
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: rs.length,
    sumR: +rs.reduce((a, b) => a + b, 0).toFixed(2),
    meanR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    pfR: neg < 0 ? +(pos / -neg).toFixed(3) : pos > 0 ? 99 : 0,
    wr: rs.length ? +((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(1) : null,
  };
}

function halfKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
}

// ── run ─────────────────────────────────────────────────────────────────────
const pad = 45 * 864e5;
const candles = await readCandles(SYMBOL, TF, FROM - pad, TO, { market: "futures" });
const funding = await readFundingRates(SYMBOL, FROM - pad, TO).catch(() => []);
const days = buildDailySeries(candles);

clearIntradayAdapterCache?.();
let cfg = { ...CFG_BASE, backtestSignalStartMs: FROM };
cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
process.stderr.write("FULL sim…\n");
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

const trades = (sim.trades ?? [])
  .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
  .filter((t) => Number(t.entryTs) >= FROM && Number(t.entryTs) < TO)
  .map((t) => {
    const ctx = t.liqContext || {};
    const feats = ctx.features || {};
    return {
      entryTs: t.entryTs,
      half: halfKey(t.entryTs),
      side: String(t.direction || "").toUpperCase(),
      netPnl: t.netPnl,
      r: rOf(t),
      mfePct: t.mfePct,
      exitReason: t.exitReason,
      levelType: ctx.levelType ?? null,
      regime: feats.marketState?.regime ?? null,
      daySituation: feats.marketState?.daySituation ?? null,
      adx: feats.marketState?.adx ?? null,
      atrPct: feats.marketState?.atrPct ?? null,
      mkt: marketFeaturesAt(days, t.entryTs),
    };
  });

console.log(`FULL trades n=${trades.length}`);

// per-half table
const halves = [...new Set(trades.map((t) => t.half))].sort();
console.log("\n══ Per-half (R-based) ══");
const halfRows = {};
for (const h of halves) {
  const m = rMetrics(trades.filter((t) => t.half === h));
  halfRows[h] = m;
  console.log(
    `  ${h}  n=${String(m.n).padStart(3)} sumR=${String(m.sumR).padStart(7)} meanR=${String(m.meanR).padStart(7)} pfR=${String(m.pfR).padStart(6)} wr=${m.wr}%`,
  );
}

// feature means per half
const featKeys = ["ret30", "ret90", "volPctile", "compression", "posInRange60"];
console.log("\n══ Market features per half (means) ══");
console.log("  half    " + featKeys.map((k) => k.padStart(13)).join(""));
for (const h of halves) {
  const rows = trades.filter((t) => t.half === h && t.mkt);
  const means = featKeys.map((k) => {
    const v = rows.map((r) => Number(r.mkt[k])).filter(Number.isFinite);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : "n/a";
  });
  console.log(`  ${h}  ` + means.map((m) => String(m).padStart(13)).join(""));
}

// per-trade feature vs R correlation (quintile meanR)
console.log("\n══ Feature quintiles → meanR (all trades) ══");
for (const k of [...featKeys, "adx", "atrPct"]) {
  const rows = trades
    .map((t) => ({ v: Number(k === "adx" || k === "atrPct" ? t[k] : t.mkt?.[k]), r: t.r }))
    .filter((x) => Number.isFinite(x.v) && x.r != null)
    .sort((a, b) => a.v - b.v);
  if (rows.length < 50) continue;
  const q = 5;
  const out = [];
  for (let i = 0; i < q; i++) {
    const s = rows.slice(Math.floor((i * rows.length) / q), Math.floor(((i + 1) * rows.length) / q));
    const mean = s.reduce((a, b) => a + b.r, 0) / s.length;
    out.push(`Q${i + 1} ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}(${s[0].v.toFixed(2)}..)`);
  }
  console.log(`  ${k.padEnd(13)} ${out.join("  ")}`);
}

// ── soft stand-down screening ───────────────────────────────────────────────
const rules = [
  ["volPctile<0.25", (t) => (t.mkt?.volPctile ?? 1) < 0.25],
  ["volPctile<0.35", (t) => (t.mkt?.volPctile ?? 1) < 0.35],
  ["volPctile>0.85", (t) => (t.mkt?.volPctile ?? 0) > 0.85],
  ["compression<0.6", (t) => (t.mkt?.compression ?? 1) < 0.6],
  ["compression<0.75", (t) => (t.mkt?.compression ?? 1) < 0.75],
  ["ret90<-0.15", (t) => (t.mkt?.ret90 ?? 0) < -0.15],
  ["ret30<-0.10", (t) => (t.mkt?.ret30 ?? 0) < -0.1],
  ["ret30>+0.15", (t) => (t.mkt?.ret30 ?? 0) > 0.15],
  ["posInRange60<0.25", (t) => (t.mkt?.posInRange60 ?? 0.5) < 0.25],
  ["posInRange60>0.85", (t) => (t.mkt?.posInRange60 ?? 0.5) > 0.85],
  ["regime=SQUEEZE", (t) => t.regime === "SQUEEZE"],
  ["adx>40", (t) => Number(t.adx ?? 0) > 40],
];

console.log("\n══ Stand-down screening (drop when rule true) ══");
console.log(
  "  rule".padEnd(22) +
    "kept%".padStart(7) +
    "  FULL meanR→".padStart(14) +
    "  worstHalf→".padStart(24) +
    "  2026H1 meanR→".padStart(16),
);
const baseFull = rMetrics(trades);
const base26 = rMetrics(trades.filter((t) => t.half === "2026H1"));
const screen = [];
for (const [id, drop] of rules) {
  const kept = trades.filter((t) => !drop(t));
  const full = rMetrics(kept);
  const h26 = rMetrics(kept.filter((t) => t.half === "2026H1"));
  const perHalf = halves.map((h) => ({ h, m: rMetrics(kept.filter((t) => t.half === h)) }));
  const worst = perHalf.filter((x) => x.m.n >= 5).sort((a, b) => (a.m.meanR ?? 9) - (b.m.meanR ?? 9))[0];
  const greenHalvesTurnedRed = perHalf.filter(
    (x) => (halfRows[x.h]?.meanR ?? 0) > 0.05 && (x.m.meanR ?? 0) < 0 && x.m.n >= 5,
  ).length;
  const keptPct = +((kept.length / trades.length) * 100).toFixed(0);
  screen.push({ id, keptPct, full, h26, worst: worst ? { h: worst.h, meanR: worst.m.meanR } : null, greenHalvesTurnedRed });
  console.log(
    `  ${id.padEnd(20)}${String(keptPct + "%").padStart(7)}` +
      `${String(`${baseFull.meanR}→${full.meanR}`).padStart(14)}` +
      `${String(worst ? `${worst.h}:${worst.m.meanR}` : "n/a").padStart(24)}` +
      `${String(`${base26.meanR}→${h26.meanR ?? "n/a"}`).padStart(16)}` +
      (greenHalvesTurnedRed ? "  ⚠ turns green half red" : ""),
  );
}

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-half-regime-autopsy.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      config: "INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M (guards off)",
      halves: halfRows,
      screen,
      nTrades: trades.length,
      trades,
    },
    null,
    2,
  ),
);
console.log("\nWrote .liq-buybd-half-regime-autopsy.json");
await closePool?.();
