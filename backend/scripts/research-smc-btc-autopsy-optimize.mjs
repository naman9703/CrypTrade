#!/usr/bin/env node
/**
 * BTC SMC/ICT — trade autopsy on sweep baseline + one-change repair grid.
 *
 * Phase 0 (partial): sweep_default FULL −142% / OOS −47% @ tw=2.21 (freq ok, edge dead).
 * Hypothesis stream: cut loser clusters without crushing N below ~1.5–2/wk.
 *
 *   SKIP_ENSURE=1 node scripts/research-smc-btc-autopsy-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2023-01-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2024-06-01";
const START = Number(process.env.START_USDT || 10_000);
const RISK = 2.5;
const LEV = 12;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  INTRADAY_PRO_ICT_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);
const padFrom = fromMs - 14 * 864e5;

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function aggregateEntries(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const cur = m.get(ts) ?? {
      entryTs: ts,
      exitTs: Number(t.exitTs ?? ts),
      netPnl: 0,
      side: t.direction ?? t.side,
      reason: t.entryReason,
      exitReason: t.exitReason,
      score: t.score,
      techniques: t.techniques,
      smcMeta: t.smcMeta ?? null,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.exitTs = Number(t.exitTs ?? cur.exitTs);
    cur.exitReason = t.exitReason ?? cur.exitReason;
    if (t.smcMeta) cur.smcMeta = t.smcMeta;
    if (t.techniques) cur.techniques = t.techniques;
    m.set(ts, cur);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function metricsFor(entries) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  const years = {};
  for (const e of entries) {
    const y = yearBucket(e.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += e.netPnl;
    years[y].end = eq;
    curve.push({ ts: e.entryTs, equity: eq });
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const fakeTrades = entries.map((e) => ({
    entryTs: e.entryTs,
    exitTs: e.exitTs ?? e.entryTs,
    netPnl: e.netPnl,
  }));
  const m = computeAllMetrics({
    trades: fakeTrades,
    equityCurve: curve,
    tf: TF,
    startingEquity: START,
  });
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  const oos = entries.filter((e) => e.entryTs >= oosEndMs);
  let oosEq = START;
  for (const e of oos) oosEq += e.netPnl;
  const is_ = entries.filter((e) => e.entryTs < oosEndMs);
  let isEq = START;
  for (const e of is_) isEq += e.netPnl;
  const wins = entries.filter((e) => e.netPnl > 0).length;
  const redYears = Object.entries(years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  return {
    trades: entries.length,
    tw: +(entries.length / weeks).toFixed(2),
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    isN: is_.length,
    isRet: is_.length ? +(((isEq - START) / START) * 100).toFixed(2) : 0,
    years,
    redYears,
  };
}

async function runPreset(label, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...INTRADAY_PRO_ICT_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEV,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
  const cfg = materializeIntradayEngineCfgSync(raw, materializeIntradayPanelOnCfg);
  const merged = mergeAdaptiveCfg(cfg, candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: LEV,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: LEV,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const entries = aggregateEntries(sim.trades ?? []);
  const m = metricsFor(entries);
  return { id: label, over, ...m, entries };
}

function bucket(v, edges, labels) {
  if (v == null || Number.isNaN(Number(v))) return "na";
  const x = Number(v);
  for (let i = 0; i < edges.length; i++) {
    if (x < edges[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function sliceStats(entries, keyFn) {
  const g = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    const cur = g.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    cur.n += 1;
    cur.pnl += e.netPnl;
    if (e.netPnl > 0) cur.wins += 1;
    g.set(k, cur);
  }
  return [...g.entries()]
    .map(([k, s]) => ({
      k,
      n: s.n,
      wr: +((s.wins / s.n) * 100).toFixed(1),
      pnl: +s.pnl.toFixed(0),
      avg: +(s.pnl / s.n).toFixed(1),
    }))
    .sort((a, b) => a.pnl - b.pnl);
}

function autopsy(entries) {
  return {
    bySide: sliceStats(entries, (e) => String(e.side ?? "?").toUpperCase()),
    byYear: sliceStats(entries, (e) => yearBucket(e.entryTs)),
    byExit: sliceStats(entries, (e) => String(e.exitReason ?? "unknown")),
    byLevel: sliceStats(entries, (e) => String(e.smcMeta?.levelType ?? e.techniques?.[2] ?? "unk")),
    byExt: sliceStats(entries, (e) =>
      bucket(e.smcMeta?.sweepExtensionPct, [0.003, 0.005, 0.008, 0.012], [
        "<0.3%",
        "0.3-0.5%",
        "0.5-0.8%",
        "0.8-1.2%",
        ">=1.2%",
      ]),
    ),
    byReclaimBody: sliceStats(entries, (e) =>
      bucket(e.smcMeta?.reclaimBodyRatio, [0.35, 0.5, 0.65], ["<0.35", "0.35-0.5", "0.5-0.65", ">=0.65"]),
    ),
    byBarsAfter: sliceStats(entries, (e) =>
      bucket(e.smcMeta?.barsAfterReclaim, [0.5, 2, 4, 8], ["0", "1-2", "3-4", "5-8", ">=9"]),
    ),
    byRr: sliceStats(entries, (e) =>
      bucket(e.smcMeta?.plannedRr, [1.5, 2, 2.5, 3.5], ["<1.5", "1.5-2", "2-2.5", "2.5-3.5", ">=3.5"]),
    ),
    byHourUtc: sliceStats(entries, (e) => {
      const h = new Date(e.entryTs).getUTCHours();
      if (h >= 7 && h < 10) return "london";
      if (h >= 12 && h < 16) return "ny";
      if (h >= 0 && h < 7) return "asia";
      return "off";
    }),
    byScore: sliceStats(entries, (e) => String(e.score ?? e.smcMeta?.score ?? "?")),
  };
}

console.log(`\n══ BTC SMC autopsy+opt — ${SYMBOL} ${TF} ${FROM}→${TO} (OOS ${OOS_END}) ══`);

const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(
  `candles=${candles.length} funding=${funding.length} ${candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "none"}→${candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "none"}`,
);

console.error("run baseline sweep_default");
const baseline = await runPreset("sweep_default", {});
console.log(
  `BASE n=${baseline.trades} tw=${baseline.tw} wr=${baseline.wr}% ret=${baseline.ret}% oos=${baseline.oosRet}% cal=${baseline.calmar} pf=${baseline.pf} | ${baseline.redYears.join(",")}`,
);

const auto = autopsy(baseline.entries);
console.log("\n── Autopsy (worst slices first by pnl) ──");
for (const [name, rows] of Object.entries(auto)) {
  console.log(`\n[${name}]`);
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${String(r.k).padEnd(14)} n=${String(r.n).padStart(3)} wr=${String(r.wr).padStart(5)}% pnl=${String(r.pnl).padStart(8)} avg=${r.avg}`);
  }
}

const variants = [
  { id: "maxHold24", over: { intradaySmcMaxHoldBars: 24 } },
  { id: "maxHold16", over: { intradaySmcMaxHoldBars: 16 } },
  { id: "minRr2", over: { intradaySmcMinRr: 2, intradayLiqMinRr: 2 } },
  { id: "minRr2_5", over: { intradaySmcMinRr: 2.5, intradayLiqMinRr: 2.5 } },
  { id: "adx18", over: { intradaySmcMinAdx: 18 } },
  { id: "adx22", over: { intradaySmcMinAdx: 22 } },
  { id: "score9", over: { intradaySmcMinScore: 9, srIntradayMinScore: 9 } },
  { id: "score10", over: { intradaySmcMinScore: 10, srIntradayMinScore: 10 } },
  { id: "ext005", over: { intradayLiqMinSweepExtensionPct: 0.005 } },
  { id: "ext008", over: { intradayLiqMinSweepExtensionPct: 0.008 } },
  { id: "htf_both", over: { intradaySmcHtfBiasMode: "parallel", intradaySmcHtfStrictness: "both" } },
  { id: "htf_either_par", over: { intradaySmcHtfBiasMode: "parallel", intradaySmcHtfStrictness: "either" } },
  { id: "no_session_ext", over: { intradayLiqSessionExtreme: false } },
  { id: "kz_london_ny", over: { intradaySmcKillzoneMode: "LONDON_NY" } },
  { id: "maxTp3", over: { intradaySmcMaxTpRr: 3 } },
  { id: "be_off", over: { intradayLiqBreakevenAfterPartial: false } },
];

const results = [baseline];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const r = await runPreset(v.id, v.over);
  results.push(r);
  console.log(
    `${v.id.padEnd(16)} n=${String(r.trades).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% oos=${String(r.oosRet).padStart(7)}% cal=${String(r.calmar).padStart(6)} pf=${r.pf} | Δret=${(r.ret - baseline.ret).toFixed(1)} Δoos=${(r.oosRet - baseline.oosRet).toFixed(1)} | ${r.redYears.join(",") || "none"}`,
  );
}

const ranked = [...results].sort((a, b) => {
  const aOk = a.oosRet > 0 && a.ret > 0 ? 1 : 0;
  const bOk = b.oosRet > 0 && b.ret > 0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  if (b.oosRet !== a.oosRet) return b.oosRet - a.oosRet;
  return b.ret - a.ret;
});

console.log("\n══ Rank (OOS then FULL) ══");
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(16)} ret=${r.ret}% oos=${r.oosRet}% tw=${r.tw} n=${r.trades} oosN=${r.oosN} cal=${r.calmar}`,
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  tf: TF,
  window: { from: FROM, to: TO, oosEnd: OOS_END },
  baseline: { ...baseline, entries: undefined },
  autopsy: auto,
  ranked: ranked.map((r) => ({
    id: r.id,
    over: r.over,
    trades: r.trades,
    tw: r.tw,
    wr: r.wr,
    ret: r.ret,
    oosRet: r.oosRet,
    oosN: r.oosN,
    calmar: r.calmar,
    pf: r.pf,
    dd: r.dd,
    redYears: r.redYears,
    years: r.years,
  })),
  note: "BNB presets are not BTC-native. Phase 0 sweep edge is negative; one-change only.",
};
const outPath = path.join(__dirname, ".smc-btc-autopsy-optimize.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outPath}`);
console.log(`Best: ${ranked[0]?.id} ret=${ranked[0]?.ret}% oos=${ranked[0]?.oosRet}% tw=${ranked[0]?.tw}`);

await closePool();
