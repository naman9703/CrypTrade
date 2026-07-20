#!/usr/bin/env node
/**
 * 1-year informational edge test — does Bybit/Binance observable data
 * improve win rate & returns by skipping bad setups?
 *
 * Window: 1 year, few coins, train/holdout split (75/25).
 *
 * Usage:
 *   cd backend && node scripts/research-info-edge-1y.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const RISK_PCT = Number(process.env.RISK_PCT || 5);
const HOLDOUT_FRAC = Number(process.env.HOLDOUT_FRAC || 0.25);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { portfolioReplay } = await import("../src/backtest/engine/portfolioReplay.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const {
  ensureObservableData,
  loadObservableSeries,
  observableFeaturesAt,
} = await import("../src/backtest/data/observableFeatures.js");
const { INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { harvestLiqCandidates } = await import("../src/strategy/techniques/liq/candidateHarvest.js");

/** Abstention rules — skip trade when true (bad context). */
const INFO_RULES = {
  baseline: { label: "Always trade", fn: () => false },

  // Binance funding
  bn_fund_z_gt1: {
    label: "Skip if funding z crowded vs side (|z|>1)",
    fn: (t, o) => {
      const z = o.binance_funding_zscore;
      if (z == null) return false;
      return t.isLong ? z > 1 : z < -1;
    },
  },
  bn_fund_z_gt15: {
    label: "Skip if funding z crowded vs side (|z|>1.5)",
    fn: (t, o) => {
      const z = o.binance_funding_zscore;
      if (z == null) return false;
      return t.isLong ? z > 1.5 : z < -1.5;
    },
  },
  bn_fund_long_pos: {
    label: "Skip longs when funding rate > 0.03%/8h",
    fn: (t, o) => t.isLong && o.binance_funding_rate != null && o.binance_funding_rate > 0.0003,
  },

  // Bybit OI (liquidation cascade proxy — no historical liq feed)
  by_oi_drop2: {
    label: "Skip when Bybit OI −4h < −2% (cascade proxy)",
    fn: (t, o) => o.bybit_oi_change_4h != null && o.bybit_oi_change_4h < -0.02,
  },
  by_oi_drop3: {
    label: "Skip when Bybit OI −4h < −3%",
    fn: (t, o) => o.bybit_oi_change_4h != null && o.bybit_oi_change_4h < -0.03,
  },
  by_oi_drop24_5: {
    label: "Skip when Bybit OI −24h < −5%",
    fn: (t, o) => o.bybit_oi_change_24h != null && o.bybit_oi_change_24h < -0.05,
  },

  // Weak move: price thesis vs OI divergence
  weak_long_oi: {
    label: "Skip long when OI −4h < −2% (weak rally)",
    fn: (t, o) => {
      const c = o.bybit_oi_change_4h ?? o.binance_oi_change_4h;
      return t.isLong && c != null && c < -0.02;
    },
  },
  weak_short_oi: {
    label: "Skip short when OI −4h < −2% (squeeze risk)",
    fn: (t, o) => {
      const c = o.bybit_oi_change_4h ?? o.binance_oi_change_4h;
      return !t.isLong && c != null && c < -0.02;
    },
  },

  // Long/short ratio crowding (Bybit)
  by_lsr_long_17: {
    label: "Skip long when Bybit L/S ratio > 1.7",
    fn: (t, o) => t.isLong && o.bybit_long_short_ratio != null && o.bybit_long_short_ratio > 1.7,
  },
  by_lsr_short_07: {
    label: "Skip short when Bybit L/S ratio < 0.7",
    fn: (t, o) => !t.isLong && o.bybit_long_short_ratio != null && o.bybit_long_short_ratio < 0.7,
  },

  // Favorable-only (take when supportive — inverse abstention)
  favor_long_neg_fund: {
    label: "Skip long unless funding z < 0 (shorts pay)",
    fn: (t, o) => t.isLong && o.binance_funding_zscore != null && o.binance_funding_zscore >= 0,
  },
  favor_long_oi_up: {
    label: "Skip long unless OI −4h > 0",
    fn: (t, o) => {
      const c = o.bybit_oi_change_4h ?? o.binance_oi_change_4h;
      return t.isLong && c != null && c <= 0;
    },
  },

  combo_oi_cascade: {
    label: "Skip OI drop 3% OR weak-side OI",
    fn: (t, o) => INFO_RULES.by_oi_drop3.fn(t, o) || INFO_RULES.weak_long_oi.fn(t, o) || INFO_RULES.weak_short_oi.fn(t, o),
  },
  combo_crowd: {
    label: "Skip funding z>1.5 OR L/S crowd",
    fn: (t, o) => INFO_RULES.bn_fund_z_gt15.fn(t, o) || INFO_RULES.by_lsr_long_17.fn(t, o) || INFO_RULES.by_lsr_short_07.fn(t, o),
  },

  // Coinalyze liquidations (aggregated)
  cz_liq_4h_5m: {
    label: "Skip when Coinalyze liq 4h > $5M",
    fn: (t, o) => o.coinalyze_liq_4h_usd != null && o.coinalyze_liq_4h_usd > 5_000_000,
  },
  cz_liq_4h_10m: {
    label: "Skip when Coinalyze liq 4h > $10M",
    fn: (t, o) => o.coinalyze_liq_4h_usd != null && o.coinalyze_liq_4h_usd > 10_000_000,
  },
  cz_liq_24h_p90: {
    label: "Skip when Coinalyze liq 24h > $30M (high vol day)",
    fn: (t, o) => o.coinalyze_liq_24h_usd != null && o.coinalyze_liq_24h_usd > 30_000_000,
  },
  cz_liq_day_20m: {
    label: "Skip when prior-day Coinalyze liq > $20M",
    fn: (t, o) => o.coinalyze_liq_24h_usd != null && o.coinalyze_liq_24h_usd > 20_000_000,
  },
  cz_liq_day_50m: {
    label: "Skip when prior-day Coinalyze liq > $50M",
    fn: (t, o) => o.coinalyze_liq_24h_usd != null && o.coinalyze_liq_24h_usd > 50_000_000,
  },
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

function tradeFromSim(t, sym, obs) {
  if (String(t.exitReason ?? "") === "tp1_partial") return null;
  const risk = Number(t.initialRiskUsd) || 0;
  if (risk <= 0) return null;
  const R = Number(t.netPnl ?? 0) / risk;
  const isLong = t.side === "BUY";
  return {
    symbol: sym,
    entryTs: Number(t.entryTs),
    exitTs: Number(t.exitTs ?? t.entryTs),
    isLong,
    R,
    win: R > 0,
    obs,
  };
}

async function collectStTrades(sym, obsSeries) {
  const candles = await readCandles(sym, "15m", fromMs, toMs, { market: "futures" });
  if (!candles?.length) return [];
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
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
    startingUsdt: 10_000,
    timeframe: "15m",
    adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(c)) },
    symbol: sym,
  });
  return sim.trades
    .map((t) => tradeFromSim(t, sym, observableFeaturesAt(obsSeries, Number(t.entryTs))))
    .filter(Boolean);
}

async function collectLiqTrades(sym, obsSeries) {
  const candles = await readCandles(sym, "15m", fromMs, toMs, { market: "futures" });
  if (!candles?.length) return [];
  const base = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, symbol: sym, timeframe: "15m" },
    materializeIntradayPanelOnCfg,
  );
  const cfg = mergeAdaptiveCfg(base, candles);
  const pre = precomputeIntraday(candles);
  const rows = harvestLiqCandidates(candles, pre, { ...cfg, symbol: sym, observableSeries: obsSeries });
  return rows
    .filter((r) => r.selectedByDayPicker === 1)
    .map((r) => {
      const R = Number(r.endCloseR ?? r.fwd_closeR_20);
      if (!Number.isFinite(R)) return null;
      const obs = {
        binance_funding_rate: r.binance_funding_rate ?? null,
        binance_funding_zscore: r.binance_funding_zscore ?? null,
        binance_oi_change_4h: r.binance_oi_change_4h ?? null,
        binance_oi_change_24h: r.binance_oi_change_24h ?? null,
        binance_long_short_ratio: r.binance_long_short_ratio ?? null,
        bybit_oi_change_4h: r.bybit_oi_change_4h ?? null,
        bybit_oi_change_24h: r.bybit_oi_change_24h ?? null,
        bybit_long_short_ratio: r.bybit_long_short_ratio ?? null,
      };
      return {
        symbol: sym,
        entryTs: Number(r.entryTs),
        exitTs: Number(r.entryTs) + 20 * 15 * 60_000,
        isLong: r.side === "BUY",
        R,
        win: R > 0,
        obs,
      };
    })
    .filter(Boolean);
}

function metrics(rows) {
  const n = rows.length;
  if (!n) return { n: 0, winRate: 0, meanR: 0, sumR: 0, pf: 0 };
  const wins = rows.filter((t) => t.win).length;
  const sumR = rows.reduce((s, t) => s + t.R, 0);
  const grossWin = rows.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const grossLoss = Math.abs(rows.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  return {
    n,
    winRate: (wins / n) * 100,
    meanR: sumR / n,
    sumR,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
  };
}

function portfolioRet(rows, sliceFrom) {
  if (!rows.length) return { returnPct: 0, maxDdPct: 0 };
  const events = rows.map((t) => ({ ts: t.exitTs, R: t.R, symbol: t.symbol, rawTrade: t }));
  const replay = portfolioReplay({
    events,
    startingUsdt: 10_000,
    riskFrac: RISK_PCT / 100,
    startTs: sliceFrom,
  });
  return {
    returnPct: ((replay.finalEquity - 10_000) / 10_000) * 100,
    maxDdPct: replay.maxDrawdownPct ?? 0,
  };
}

function evaluateStrategy(name, allTrades) {
  const train = allTrades.filter((t) => t.entryTs >= fromMs && t.entryTs < holdoutMs);
  const hold = allTrades.filter((t) => t.entryTs >= holdoutMs && t.entryTs < toMs);
  const baseTrain = metrics(train);
  const baseHold = metrics(hold);
  const basePortHold = portfolioRet(hold, holdoutMs);

  const rules = [];
  for (const [id, rule] of Object.entries(INFO_RULES)) {
    const keptTrain = [];
    const skipTrain = [];
    const keptHold = [];
    const skipHold = [];
    for (const t of train) {
      (rule.fn(t, t.obs) ? skipTrain : keptTrain).push(t);
    }
    for (const t of hold) {
      (rule.fn(t, t.obs) ? skipHold : keptHold).push(t);
    }
    const mTrain = metrics(keptTrain);
    const mSkipTrain = metrics(skipTrain);
    const mHold = metrics(keptHold);
    const mSkipHold = metrics(skipHold);
    const portHold = portfolioRet(keptHold, holdoutMs);

    const wrDeltaHold = mHold.winRate - baseHold.winRate;
    const meanRDeltaHold = mHold.meanR - baseHold.meanR;
    const skippedWorseHold = mSkipHold.meanR < mHold.meanR;
    const beatsHold =
      mHold.n >= Math.max(3, baseHold.n * 0.5) &&
      (meanRDeltaHold > 0 || portHold.returnPct > basePortHold.returnPct) &&
      skippedWorseHold;

    rules.push({
      id,
      label: rule.label,
      skipPctTrain: train.length ? (skipTrain.length / train.length) * 100 : 0,
      skipPctHold: hold.length ? (skipHold.length / hold.length) * 100 : 0,
      train: { kept: mTrain, skipped: mSkipTrain },
      hold: { kept: mHold, skipped: mSkipHold, port: portHold },
      wrDeltaHold,
      meanRDeltaHold,
      skippedWorseHold,
      beatsHold,
    });
  }

  rules.sort((a, b) => b.meanRDeltaHold - a.meanRDeltaHold);

  return {
    name,
    trades: allTrades.length,
    trainN: train.length,
    holdN: hold.length,
    coverage: {
      fundingPct: allTrades.length
        ? (allTrades.filter((t) => t.obs.binance_funding_zscore != null).length / allTrades.length) * 100
        : 0,
      bybitOiPct: allTrades.length
        ? (allTrades.filter((t) => t.obs.bybit_oi_change_4h != null).length / allTrades.length) * 100
        : 0,
    },
    baseline: { train: baseTrain, hold: baseHold, portHold: basePortHold },
    rules,
    winners: rules.filter((r) => r.id !== "baseline" && r.beatsHold),
  };
}

async function loadTrades(collector) {
  const all = [];
  for (const sym of COINS) {
    process.stdout.write(`  ${sym}: sync observables...\n`);
    await ensureObservableData(sym, fromMs, toMs);
    const series = await loadObservableSeries(sym, fromMs, toMs);
    const merged = { binance: series.binance, bybit: series.bybit, coinalyze: series.coinalyze };
    process.stdout.write(`  ${sym}: collect trades...\n`);
    all.push(...(await collector(sym, merged)));
  }
  return all.sort((a, b) => a.entryTs - b.entryTs);
}

console.log(`\n=== Informational Edge Test (1Y) ===`);
console.log(`${FROM} → ${TO} | coins: ${COINS.join(", ")} | holdout from ${new Date(holdoutMs).toISOString().slice(0, 10)}\n`);

const stTrades = await loadTrades(collectStTrades);
const liqTrades = await loadTrades(collectLiqTrades);

const st = evaluateStrategy("SUPERTREND_ELITE", stTrades);
const liq = evaluateStrategy("LIQ_SWEEP (harvest)", liqTrades);

function fmt(n, d = 1) {
  return n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(d);
}

function tableBlock(result) {
  const b = result.baseline;
  const lines = [
    `## ${result.name}`,
    "",
    `Trades: ${result.trades} (train ${result.trainN}, holdout ${result.holdN}) | funding cov ${fmt(result.coverage.fundingPct, 0)}% | Bybit OI cov ${fmt(result.coverage.bybitOiPct, 0)}%`,
    "",
    `**Baseline holdout:** WR ${fmt(b.hold.winRate)}% | meanR ${fmt(b.hold.meanR, 3)} | PF ${fmt(b.hold.pf, 2)} | port ${fmt(b.portHold.returnPct)}%`,
    "",
    "| Rule | Skip% | Hold WR | ΔWR | Hold meanR | ΔmeanR | Skip meanR | Port% | Pass? |",
    "|------|-------|---------|-----|------------|--------|------------|-------|-------|",
  ];
  for (const r of result.rules) {
    if (r.id === "baseline") continue;
    const pass = r.beatsHold ? "✅" : "❌";
    lines.push(
      `| ${r.id} | ${fmt(r.skipPctHold, 0)}% | ${fmt(r.hold.kept.winRate)}% | ${fmt(r.wrDeltaHold, 1)} | ${fmt(r.hold.kept.meanR, 3)} | ${fmt(r.meanRDeltaHold, 3)} | ${fmt(r.hold.skipped.meanR, 3)} | ${fmt(r.hold.port.returnPct, 1)} | ${pass} |`,
    );
  }
  lines.push("");
  if (result.winners.length) {
    lines.push(`**Holdout-validated edges:** ${result.winners.map((w) => w.id).join(", ")}`);
  } else {
    lines.push("**Holdout-validated edges:** none");
  }
  return lines.join("\n");
}

const md = [
  "# Informational Edge — 1 Year Test",
  "",
  `**Window:** ${FROM} → ${TO} (${COINS.join(", ")})`,
  "",
  "**Note:** No historical liquidation feed — Bybit OI drop used as cascade proxy.",
  "",
  "**Pass:** holdout meanR or port return improves AND skipped trades have worse meanR.",
  "",
  tableBlock(st),
  "",
  tableBlock(liq),
];

const report = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  coins: COINS,
  holdoutFrom: new Date(holdoutMs).toISOString().slice(0, 10),
  supertrend: st,
  liqSweep: liq,
};

const OUT_JSON = path.join(__dirname, ".research-info-edge-1y.json");
const OUT_MD = path.join(__dirname, ".research-info-edge-1y.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, md.join("\n"));
console.log("\n" + md.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
