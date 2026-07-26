#!/usr/bin/env node
/**
 * Exit/risk autopsy on BUYBD+comp≥0.75 residual trades.
 * Goal: find a named failure mode that drives DD / left-tail (MC p5, Calmar).
 *
 * Soft-screens (post-hoc, sizing-independent R):
 *  - giveback: loser had MFE≥X R then finished ≤−0.5R
 *  - quick SL: holdBars≤N and full SL
 *  - cluster: Nth consecutive loss in a streak
 *  - time_stop losers with MFE>0 (held through green → red)
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-exit-risk-autopsy.mjs
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
const PAD = 150 * 864e5;

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

function rOf(t) {
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

function mfeR(t) {
  const risk = Number(t.initialRiskUsd ?? 0);
  const entry = Number(t.entryPrice ?? t.entryFill);
  const qty = Math.abs(Number(t.qty) || 0);
  const mfePct = Number(t.mfePct ?? t.mfe ?? NaN);
  // Prefer dollar MFE if present
  if (Number.isFinite(Number(t.mfeUsd)) && risk > 0) return Number(t.mfeUsd) / risk;
  if (Number.isFinite(mfePct) && entry > 0 && qty > 0 && risk > 0) {
    // mfePct is often % of price — convert via notional
    return ((mfePct / 100) * entry * qty) / risk;
  }
  if (Number.isFinite(Number(t.mfe)) && risk > 0) {
    // runner stores mfe as fraction of equity sometimes — skip if tiny
    const m = Number(t.mfe);
    if (m > 0 && m < 5) return m; // already R-like?
  }
  return null;
}

function holdBars(t) {
  const a = Number(t.entryTs ?? t.entryBarTs);
  const b = Number(t.exitTs ?? t.exitBarTs);
  if (!(a > 0 && b > a)) return null;
  return Math.round((b - a) / (15 * 60_000));
}

function halfKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
}

function rMetrics(list) {
  const rs = list.map((t) => (t.r != null ? t.r : rOf(t))).filter((x) => x != null && Number.isFinite(x));
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: rs.length,
    meanR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    pfR: neg < 0 ? +(pos / -neg).toFixed(3) : pos > 0 ? 99 : 0,
    sumR: +rs.reduce((a, b) => a + b, 0).toFixed(2),
  };
}

function maxDdFromRs(rs, riskFrac = 0.025) {
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of rs) {
    eq *= 1 + r * riskFrac;
    if (eq > peak) peak = eq;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return maxDd * 100;
}

const candles = await readCandles(SYMBOL, TF, FROM - PAD, TO, { market: "futures" });
const funding = await readFundingRates(SYMBOL, FROM - PAD, TO).catch(() => []);

clearIntradayAdapterCache?.();
let cfg = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  maxDailyLoss: 0,
  riskConsecutiveLossLimit: 0,
  backtestSignalStartMs: FROM,
};
cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
console.log(`compressionMin=${cfg.intradayLiqRangeCompressionMin} maxHold=${cfg.intradayLiqMaxHoldBars} tp1=${cfg.intradayLiqTp1Enabled} partial=${cfg.intradayLiqPartialTp}`);

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
    const r = rOf(t);
    return {
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      half: halfKey(t.entryTs),
      side: String(t.direction || "").toUpperCase(),
      exitReason: String(t.exitReason ?? ""),
      netPnl: t.netPnl,
      r,
      mfeR: mfeR(t),
      maePct: t.maePct ?? null,
      hold: holdBars(t),
      mfePct: t.mfePct ?? null,
      mfe: t.mfe ?? null,
      raw: { initialRiskUsd: t.initialRiskUsd, entryPrice: t.entryPrice, qty: t.qty, mfePct: t.mfePct, mfe: t.mfe },
    };
  })
  .sort((a, b) => a.entryTs - b.entryTs);

// streak tags
let streak = 0;
for (const t of trades) {
  if (t.r != null && t.r < 0) {
    streak += 1;
    t.lossStreak = streak;
  } else {
    streak = 0;
    t.lossStreak = 0;
  }
}

console.log(`n=${trades.length}`);
const base = rMetrics(trades);
const dd = maxDdFromRs(trades.map((t) => t.r).filter((x) => x != null));
console.log(`FULL meanR=${base.meanR} pfR=${base.pfR} sumR=${base.sumR} syntheticDD@2.5%=${dd.toFixed(1)}%`);

// Exit reason × W/L
console.log("\n══ Exit reason × result ══");
const byReason = new Map();
for (const t of trades) {
  const key = t.exitReason || "unknown";
  if (!byReason.has(key)) byReason.set(key, { w: [], l: [] });
  if (t.r != null && t.r > 0) byReason.get(key).w.push(t);
  else if (t.r != null && t.r <= 0) byReason.get(key).l.push(t);
}
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].l.length - a[1].l.length)) {
  const lm = rMetrics(v.l);
  const wm = rMetrics(v.w);
  console.log(
    `  ${k.padEnd(18)} W n=${String(v.w.length).padStart(3)} meanR=${String(wm.meanR).padStart(6)} | L n=${String(v.l.length).padStart(3)} meanR=${String(lm.meanR).padStart(7)} sumR=${lm.sumR}`,
  );
}

const losers = trades.filter((t) => t.r != null && t.r < 0);
const winners = trades.filter((t) => t.r != null && t.r > 0);

console.log("\n══ Loser path (MFE before loss) ══");
const withMfe = losers.filter((t) => t.mfeR != null);
console.log(`  losers with mfeR: ${withMfe.length}/${losers.length}`);
if (withMfe.length) {
  const buckets = [
    ["mfeR=0", (t) => t.mfeR <= 0.05],
    ["mfeR 0.05–0.5", (t) => t.mfeR > 0.05 && t.mfeR <= 0.5],
    ["mfeR 0.5–1.0", (t) => t.mfeR > 0.5 && t.mfeR <= 1.0],
    ["mfeR >1.0", (t) => t.mfeR > 1.0],
  ];
  for (const [id, fn] of buckets) {
    const rows = withMfe.filter(fn);
    const m = rMetrics(rows);
    console.log(`  ${id.padEnd(16)} n=${String(m.n).padStart(3)} sumR=${String(m.sumR).padStart(7)} meanR=${m.meanR}`);
  }
}

console.log("\n══ Hold bars (losers vs winners) ══");
for (const [label, rows] of [
  ["losers", losers],
  ["winners", winners],
]) {
  const hs = rows.map((t) => t.hold).filter((x) => x != null);
  if (!hs.length) continue;
  hs.sort((a, b) => a - b);
  const p = (q) => hs[Math.min(hs.length - 1, Math.floor(q * hs.length))];
  console.log(
    `  ${label.padEnd(8)} n=${hs.length} p25=${p(0.25)} p50=${p(0.5)} p75=${p(0.75)} mean=${(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(1)}`,
  );
}

// Soft stand-down / exit proxies (drop trades matching rule — look-ahead for giveback)
console.log("\n══ Soft screens (drop matching trades) ══");
console.log("  (giveback rules are look-ahead — only useful as upper bound; cluster/guards are causal)");

const rules = [
  ["drop giveback mfe≥0.5→loss", (t) => t.r < 0 && t.mfeR != null && t.mfeR >= 0.5],
  ["drop giveback mfe≥1.0→loss", (t) => t.r < 0 && t.mfeR != null && t.mfeR >= 1.0],
  ["drop time_stop losers", (t) => t.r < 0 && t.exitReason === "time_stop"],
  ["drop time_stop w/ mfe>0.3", (t) => t.r < 0 && t.exitReason === "time_stop" && (t.mfeR ?? 0) > 0.3],
  ["drop streak≥3rd loss", (t) => t.lossStreak >= 3],
  ["drop streak≥4th loss", (t) => t.lossStreak >= 4],
  ["drop hold>48 losers", (t) => t.r < 0 && (t.hold ?? 0) > 48],
  ["drop hold>32 losers", (t) => t.r < 0 && (t.hold ?? 0) > 32],
  ["keep only SL+TP exits", (t) => !["sl", "stop", "tp", "tp2", "hit_tp", "hit_tp2"].some((x) => t.exitReason.includes(x))],
];

for (const [id, drop] of rules) {
  const kept = trades.filter((t) => !drop(t));
  const m = rMetrics(kept);
  const synDd = maxDdFromRs(kept.map((t) => t.r).filter((x) => x != null));
  const keptPct = +((kept.length / trades.length) * 100).toFixed(0);
  const oos = rMetrics(kept.filter((t) => t.entryTs >= Date.parse("2025-07-01")));
  console.log(
    `  ${id.padEnd(28)} kept=${String(keptPct + "%").padStart(4)} meanR ${base.meanR}→${m.meanR} synDD ${dd.toFixed(0)}→${synDd.toFixed(0)}% OOS meanR=${oos.meanR} n=${m.n}`,
  );
}

// Sample raw mfe fields for debugging
console.log("\n══ Sample trade fields (first 3 losers) ══");
for (const t of losers.slice(0, 3)) {
  console.log(JSON.stringify({ exit: t.exitReason, r: t.r, mfeR: t.mfeR, hold: t.hold, raw: t.raw }));
}

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-exit-risk-autopsy.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      n: trades.length,
      base,
      synDdPct: dd,
      byReason: Object.fromEntries(
        [...byReason.entries()].map(([k, v]) => [
          k,
          { w: v.w.length, l: v.l.length, lSumR: rMetrics(v.l).sumR },
        ]),
      ),
      trades: trades.map(({ raw, ...rest }) => rest),
    },
    null,
    2,
  ),
);
console.log("\nWrote .liq-buybd-exit-risk-autopsy.json");
await closePool?.();
