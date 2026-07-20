#!/usr/bin/env node
/**
 * ABST-001 — funding/OI abstention vs always-trade baseline.
 *
 * Usage:
 *   cd backend && node scripts/research-abstention-experiment.mjs
 *   STRATEGY=LIQ_SWEEP node scripts/research-abstention-experiment.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const STRATEGY = process.env.STRATEGY || "BOTH";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const RISK_PCT = Number(process.env.RISK_PCT || 5);
const HOLDOUT_FRAC = Number(process.env.HOLDOUT_FRAC || 0.25);
const START_USDT = Number(process.env.START_USDT || 10_000);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);

const ST_SYMBOLS = (process.env.ST_SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim());
const LIQ_CSV = process.env.LIQ_CSV || path.join(__dirname, ".liq-candidate-trades.csv");
const LIQ_PICKED_ONLY = process.env.LIQ_PICKED_ONLY !== "0";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { portfolioReplay, tradesToREvents } = await import("../src/backtest/engine/portfolioReplay.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const {
  ensureObservableData,
  loadObservableSeries,
  observableFeaturesAt,
} = await import("../src/backtest/data/observableFeatures.js");

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === "," && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function loadLiqCandidatesFromCsv() {
  if (!fs.existsSync(LIQ_CSV)) {
    console.warn(`LIQ CSV missing: ${LIQ_CSV}`);
    return [];
  }
  const text = fs.readFileSync(LIQ_CSV, "utf8").trim();
  const lines = text.split("\n");
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const trades = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    if (!cols.length) continue;
    const entryTs = Number(cols[idx.entryTs]);
    if (!entryTs || entryTs < fromMs || entryTs >= toMs) continue;
    if (LIQ_PICKED_ONLY && cols[idx.selectedByDayPicker] !== "1") continue;
    const side = cols[idx.side];
    const isLong = side === "BUY";
    const R = Number(cols[idx.endCloseR] ?? cols[idx.fwd_closeR_20]);
    if (!Number.isFinite(R)) continue;
    const obs = {
      binance_funding_rate: numOrNull(cols[idx.binance_funding_rate]),
      binance_funding_zscore: numOrNull(cols[idx.binance_funding_zscore]),
      binance_oi_change_4h: numOrNull(cols[idx.binance_oi_change_4h]),
      binance_has_funding: Number(cols[idx.binance_has_funding] || 0),
      bybit_oi_change_4h: numOrNull(cols[idx.bybit_oi_change_4h]),
      bybit_long_short_ratio: numOrNull(cols[idx.bybit_long_short_ratio]),
      bybit_has_oi: Number(cols[idx.bybit_has_oi] || 0),
    };
    trades.push({
      symbol: cols[idx.symbol],
      entryTs,
      exitTs: entryTs + 20 * 15 * 60_000,
      isLong,
      side,
      netPnl: R,
      R,
      obs,
      hasFunding: obs.binance_has_funding === 1,
      hasBybitOi: obs.bybit_has_oi === 1,
    });
  }
  return trades.sort((a, b) => a.exitTs - b.exitTs);
}

function numOrNull(v) {
  const n = Number(v);
  return v === "" || !Number.isFinite(n) ? null : n;
}

/** @returns {boolean} true = skip trade */
const ABSTENTION_RULES = {
  baseline: () => false,
  fund_z1: (t, o) => {
    const z = o.binance_funding_zscore;
    if (z == null || !Number.isFinite(z)) return false;
    return t.isLong ? z > 1 : z < -1;
  },
  fund_z15: (t, o) => {
    const z = o.binance_funding_zscore;
    if (z == null || !Number.isFinite(z)) return false;
    return t.isLong ? z > 1.5 : z < -1.5;
  },
  fund_z2: (t, o) => {
    const z = o.binance_funding_zscore;
    if (z == null || !Number.isFinite(z)) return false;
    return t.isLong ? z > 2 : z < -2;
  },
  fund_rate_long: (t, o) => {
    const r = o.binance_funding_rate;
    if (r == null || !Number.isFinite(r)) return false;
    return t.isLong && r > 0.0003;
  },
  bybit_oi_drop3: (t, o) => {
    const c = o.bybit_oi_change_4h;
    if (c == null || !Number.isFinite(c)) return false;
    return c < -0.03;
  },
  weak_long_oi: (t, o) => {
    const c = o.bybit_oi_change_4h ?? o.binance_oi_change_4h;
    if (c == null || !Number.isFinite(c)) return false;
    return t.isLong && c < -0.02;
  },
  weak_short_oi: (t, o) => {
    const c = o.bybit_oi_change_4h ?? o.binance_oi_change_4h;
    if (c == null || !Number.isFinite(c)) return false;
    return !t.isLong && c < -0.02;
  },
  lsr_long_crowd: (t, o) => {
    const lsr = o.bybit_long_short_ratio;
    if (lsr == null || !Number.isFinite(lsr)) return false;
    return t.isLong && lsr > 1.7;
  },
  combo_fund_oi: (t, o) =>
    ABSTENTION_RULES.fund_z15(t, o) || ABSTENTION_RULES.bybit_oi_drop3(t, o),
};

function eliteCfg(sym) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: true,
    supertrendWilderAtr: true,
    supertrendPeriod: 10,
    supertrendMultiplier: 3.0,
    eliteStRequireHtf4hAlign: true,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: 20,
    eliteStRequireAdxRising: true,
    eliteStMinVolumeVsAvg: 1.5,
    eliteStRequireAtrExpansion: true,
  };
}

async function runSt(sym, sliceFrom, sliceTo, obsSeries) {
  const candles = await readCandles(sym, "15m", sliceFrom, sliceTo, { market: "futures" });
  if (!candles?.length) return [];
  let funding = [];
  try {
    funding = await readFundingRates(sym, sliceFrom, sliceTo);
  } catch {
    funding = [];
  }
  const c = eliteCfg(sym);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles,
    cfg: c,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: "15m",
    adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(c)) },
    symbol: sym,
  });
  return enrichTrades(sim.trades, sym, obsSeries);
}

async function runLiqSweepExperiment() {
  console.log(`\n${"=".repeat(72)}\nLIQ_SWEEP (candidate harvest, day-picked) | ${FROM}→${TO}\n`);
  const trades = loadLiqCandidatesFromCsv();
  const cov = coverageStats(trades);
  console.log(`Trades: ${cov.n} | funding coverage ${cov.fundingPct.toFixed(0)}% | bybit OI ${cov.bybitOiPct.toFixed(0)}%`);
  const full = evaluateRules(trades, fromMs, toMs);
  const holdout = evaluateRules(trades, holdoutMs, toMs);
  return { name: "LIQ_SWEEP (candidate harvest)", symbols: ["CSV"], trades: cov.n, coverage: cov, full, holdout };
}

function enrichTrades(trades, sym, obsSeries) {
  const out = [];
  for (const t of trades || []) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const entryTs = Number(t.entryTs);
    if (!entryTs) continue;
    const obs = observableFeaturesAt(obsSeries, entryTs);
    const isLong = t.side === "BUY";
    const risk = Number(t.initialRiskUsd) || 0;
    const net = Number(t.netPnl ?? 0);
    const R = risk > 0 ? net / risk : 0;
    out.push({
      symbol: sym,
      entryTs,
      exitTs: Number(t.exitTs ?? entryTs),
      isLong,
      side: t.side,
      netPnl: net,
      R,
      obs,
      hasFunding: obs.binance_has_funding === 1,
      hasBybitOi: obs.bybit_has_oi === 1,
    });
  }
  return out;
}

async function collectTrades(runFn, symbols) {
  const obsCache = {};
  for (const sym of symbols) {
    process.stdout.write(`  sync observable ${sym}...\n`);
    await ensureObservableData(sym, fromMs, toMs, { skipBybit: false });
    obsCache[sym] = await loadObservableSeries(sym, fromMs, toMs, { skipBybit: false });
  }
  const all = [];
  for (const sym of symbols) {
    const merged = {
      binance: obsCache[sym].binance,
      bybit: obsCache[sym].bybit,
    };
    const rows = await runFn(sym, fromMs, toMs, merged);
    all.push(...rows);
  }
  return all.sort((a, b) => a.exitTs - b.exitTs);
}

function expectancy(rows) {
  if (!rows.length) return 0;
  return rows.reduce((s, t) => s + t.R, 0) / rows.length;
}

function evaluateRules(trades, sliceFrom, sliceTo) {
  const window = trades.filter((t) => t.entryTs >= sliceFrom && t.entryTs < sliceTo);
  const results = {};

  for (const [ruleId, ruleFn] of Object.entries(ABSTENTION_RULES)) {
    const kept = [];
    const skipped = [];
    for (const t of window) {
      const abstain = ruleId === "baseline" ? false : ruleFn(t, t.obs);
      if (abstain) skipped.push(t);
      else kept.push(t);
    }
    const events = kept.map((t) => ({
      ts: t.exitTs,
      R: t.R,
      symbol: t.symbol,
      rawTrade: t,
    }));
    const replay =
      events.length > 0
        ? portfolioReplay({
            events,
            startingUsdt: START_USDT,
            riskFrac: RISK_PCT / 100,
            startTs: sliceFrom,
          })
        : { finalEquity: START_USDT, maxDrawdownPct: 0, trades: [] };
    const retPct = ((replay.finalEquity - START_USDT) / START_USDT) * 100;
    results[ruleId] = {
      tradesTotal: window.length,
      kept: kept.length,
      skipped: skipped.length,
      skipPct: window.length ? (skipped.length / window.length) * 100 : 0,
      expRKept: expectancy(kept),
      expRSkipped: expectancy(skipped),
      returnPct: retPct,
      maxDdPct: replay.maxDrawdownPct ?? 0,
      skippedWorse: expectancy(skipped) < expectancy(kept),
      beatsBaseline: null,
    };
  }
  const baseRet = results.baseline.returnPct;
  for (const [id, r] of Object.entries(results)) {
    if (id !== "baseline") r.beatsBaseline = r.returnPct > baseRet;
  }
  return results;
}

function coverageStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, fundingPct: 0, bybitOiPct: 0 };
  return {
    n,
    fundingPct: (trades.filter((t) => t.hasFunding).length / n) * 100,
    bybitOiPct: (trades.filter((t) => t.hasBybitOi).length / n) * 100,
  };
}

function formatTable(title, full, holdout) {
  const lines = [
    `### ${title}`,
    "",
    "| Rule | Kept | Skip% | ExpR kept | ExpR skip | Full ret% | Hold ret% | Skip worse? | Beats base (hold)? |",
    "|------|------|-------|-----------|-----------|-----------|-----------|-------------|-------------------|",
  ];
  for (const id of Object.keys(ABSTENTION_RULES)) {
    const f = full[id];
    const h = holdout[id];
    const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : Number(x).toFixed(d));
    lines.push(
      `| ${id} | ${f.kept}/${f.tradesTotal} | ${fmt(f.skipPct, 0)}% | ${fmt(f.expRKept, 3)} | ${fmt(f.expRSkipped, 3)} | ${fmt(f.returnPct, 1)} | ${fmt(h.returnPct, 1)} | ${f.skippedWorse ? "✅" : "❌"} | ${h.beatsBaseline ? "✅" : "❌"} |`,
    );
  }
  return lines.join("\n");
}

async function runExperiment(name, runFn, symbols, riskNote) {
  console.log(`\n${"=".repeat(72)}\n${name} — ${symbols.join(", ")} | ${FROM}→${TO} | risk ${riskNote}\n`);
  const trades = await collectTrades(runFn, symbols);
  const cov = coverageStats(trades);
  console.log(`Trades: ${cov.n} | funding coverage ${cov.fundingPct.toFixed(0)}% | bybit OI ${cov.bybitOiPct.toFixed(0)}%`);
  const full = evaluateRules(trades, fromMs, toMs);
  const holdout = evaluateRules(trades, holdoutMs, toMs);
  return { name, symbols, trades: cov.n, coverage: cov, full, holdout };
}

const report = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  holdoutFrom: new Date(holdoutMs).toISOString().slice(0, 10),
  riskPct: RISK_PCT,
  experiments: [],
};

const runs = [];
if (STRATEGY === "BOTH" || STRATEGY === "SUPERTREND_ELITE" || STRATEGY === "ST") {
  runs.push(
    runExperiment(
      "SUPERTREND_ELITE",
      runSt,
      ST_SYMBOLS,
      `${RISK_PCT}%`,
    ),
  );
}
if (STRATEGY === "BOTH" || STRATEGY === "LIQ_SWEEP" || STRATEGY === "LIQ") {
  runs.push(runLiqSweepExperiment());
}

const results = [];
for (const run of runs) {
  results.push(await run);
}
const md = [
  "# ABST-001 Abstention Experiments",
  "",
  `Window: ${FROM} → ${TO} | Holdout from ${new Date(holdoutMs).toISOString().slice(0, 10)}`,
  "",
  "**Question:** Does skipping trades on funding/OI context beat always-trade on holdout?",
  "",
  "**Pass:** skipped trades have worse ExpR than kept AND holdout return beats baseline.",
  "",
];

for (const r of results) {
  report.experiments.push({
    strategy: r.name,
    symbols: r.symbols,
    trades: r.trades,
    coverage: r.coverage,
    full: r.full,
    holdout: r.holdout,
    winners: Object.entries(r.holdout)
      .filter(([id, row]) => id !== "baseline" && row.beatsBaseline && row.skippedWorse)
      .map(([id]) => id),
  });
  md.push(formatTable(r.name, r.full, r.holdout));
  md.push("");
  const winners = report.experiments.at(-1).winners;
  md.push(winners.length ? `**Holdout winners:** ${winners.join(", ")}` : "**Holdout winners:** none");
  md.push("");
}

const OUT_JSON = path.join(__dirname, ".research-abstention-experiment.json");
const OUT_MD = path.join(__dirname, ".research-abstention-experiment.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, md.join("\n"));
console.log("\n" + md.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
