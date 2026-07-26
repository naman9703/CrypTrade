#!/usr/bin/env node
/**
 * DOGE — residual 2024-25 under STACK (buy max60=100% + bear HTF 0.50%).
 * Soft probes → one more hard A/B to clear the last red year.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-2425-final.mjs
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

const STACK = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpRejectionSellBearMinHtfSepPct: 0.005,
  vpBuyRejectionMaxPrior60dPct: 1.0,
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
  const cfg = { ...STACK, ...over, backtestSignalStartMs: fromMs };
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

function bucket(label, rows, fn) {
  const m = {};
  for (const r of rows) {
    const k = fn(r);
    m[k] ??= [];
    m[k].push(r);
  }
  console.log(`\n-- ${label} --`);
  for (const [k, list] of Object.entries(m).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
    const s = summarize(list);
    console.log(`  ${String(k).padEnd(48)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
  }
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, STACK);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(`\nSTACK baseline n=${h0.trades} ret=${h0.ret}%`);
console.log(
  `years ${Object.entries(h0.years)
    .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
    .join(" ")}`,
);

const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = "va_rejection";
  const vp = buildVolumeProfile(candles, idx, { mode: "rolling", lookback: 384, bins: 50, includePriorSession: true });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, STACK);
  rows.push({
    year: yearBucket(ts),
    side,
    pnl: Number(t.netPnl ?? 0),
    cell: cell.key,
    macro: cell.macro,
    pathLabel: cell.path,
    isVacuum: Number(path?.distPct ?? 0) >= 0.02,
    prior5d: priorPct(candles, idx, 96 * 5),
    prior20d: priorPct(candles, idx, 96 * 20),
    prior60d: priorPct(candles, idx, 96 * 60),
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
  });
}

const bad = rows.filter((r) => r.year === "2024-25");
console.log("\n2024-25 residual under STACK:", summarize(bad));
bucket("cells", bad, (r) => r.cell);
bucket("side|macro", bad, (r) => `${r.side}|${r.macro}`);

console.log("\nSoft drops on 2024-25 / full:");
const probes = [
  { id: "deny_residual_bear_vac", pred: (r) => r.cell === "SELL|va_rejection|bear_trend|vacuum" },
  { id: "deny_residual_bear_any", pred: (r) => r.side === "SELL" && r.macro === "bear_trend" },
  { id: "deny_BUY_bear_tight", pred: (r) => r.cell === "BUY|va_rejection|bear_trend|tight" },
  { id: "deny_SELL_bull_trend_vac", pred: (r) => r.cell === "SELL|va_rejection|bull_trend|vacuum" },
  { id: "deny_BUY_bull_chop_vac", pred: (r) => r.cell === "BUY|va_rejection|bull_chop|vacuum" },
  { id: "deny_BUY_bull_trend_vac", pred: (r) => r.cell === "BUY|va_rejection|bull_trend|vacuum" },
  { id: "drop_SELL_p20_le_m15", pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.15 },
  { id: "drop_SELL_p20_le_m20", pred: (r) => r.side === "SELL" && r.prior20d != null && r.prior20d <= -0.2 },
  { id: "drop_htf_lt_008_sell", pred: (r) => r.side === "SELL" && Number.isFinite(r.htfSep) && r.htfSep < 0.008 },
  { id: "drop_bear_htf_lt_008", pred: (r) => r.macro === "bear_trend" && r.side === "SELL" && Number.isFinite(r.htfSep) && r.htfSep < 0.008 },
];
for (const p of probes) {
  const kept = rows.filter((r) => !p.pred(r));
  const sAll = summarize(kept);
  const sBad = summarize(kept.filter((r) => r.year === "2024-25"));
  const sGood = summarize(kept.filter((r) => r.year !== "2024-25"));
  console.log(
    `${p.id.padEnd(28)} drop=${rows.length - kept.length} ALL ${sAll.net} | 24-25 ${sBad.net} (n=${sBad.n}) | other ${sGood.net}`,
  );
}

const variants = [
  { id: "H0_stack", over: {} },
  {
    id: "deny_bear_vac",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["SELL|va_rejection|bear_trend|vacuum"],
    },
  },
  {
    id: "deny_bear_any_path",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|bear_trend|vacuum",
        "SELL|va_rejection|bear_trend|structured",
        "SELL|va_rejection|bear_trend|tight",
      ],
    },
  },
  {
    id: "ext_down_15",
    over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.15 },
  },
  {
    id: "ext_down_20",
    over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.2 },
  },
  { id: "bear_htf_008", over: { vpRejectionSellBearMinHtfSepPct: 0.008 } },
  {
    id: "deny_BUY_bear_tight",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: ["BUY|va_rejection|bear_trend|tight"],
    },
  },
  {
    id: "deny_top_bleed_cells",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
      vpPreparedBlockCellKeys: [
        "SELL|va_rejection|bear_trend|vacuum",
        "BUY|va_rejection|bear_trend|tight",
        "SELL|va_rejection|bear_trend|structured",
        "BUY|va_rejection|bull_chop|vacuum",
        "SELL|va_rejection|bull_trend|vacuum",
      ],
    },
  },
];

console.log("\n══ Hard A/B ══");
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  ab.push({ id: v.id, ...m, allNonNeg, red });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${red.join(" ") || "none"} | all≥0=${allNonNeg}`,
  );
}

ab.sort((a, b) => Number(b.allNonNeg) - Number(a.allNonNeg) || b.ret - a.ret);
console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(24)} all≥0=${r.allNonNeg} ret=${r.ret}% 24-25=${r.years["2024-25"]?.retPct} 20-21=${r.years["2020-21"]?.retPct} 21-22=${r.years["2021-22"]?.retPct} 25-26=${r.years["2025-26"]?.retPct}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-2425-final.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), h0, ab }, null, 2));
console.error("wrote", outPath);
await closePool?.();
