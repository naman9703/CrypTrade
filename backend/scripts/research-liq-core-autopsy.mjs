#!/usr/bin/env node
/**
 * LIQ_CORE trade autopsy — exit / day-type / failure-class clusters.
 * Usage: SYMBOLS=BNBUSDT node scripts/research-liq-core-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const TF = process.env.TF || "15m";
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const weeks = (toMs - fromMs) / (7 * 864e5);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter, precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js"
);

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

function bucket(map, key, pnl) {
  map[key] ??= { n: 0, pnl: 0, wins: 0 };
  map[key].n += 1;
  map[key].pnl += pnl;
  if (pnl > 0) map[key].wins += 1;
}

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  if (String(t.exitReason || "").includes("time_stop")) return "time_stop_gave_back";
  if (mfe >= 0.01) return "gave_back_after_mfe";
  return "other_loss";
}

function printBucket(title, map, minN = 1) {
  console.log(`\n══ ${title} ══`);
  const rows = Object.entries(map)
    .map(([k, v]) => ({
      k,
      ...v,
      pnl: +v.pnl.toFixed(2),
      wr: +((v.wins / v.n) * 100).toFixed(1),
      avg: +(v.pnl / v.n).toFixed(2),
    }))
    .filter((r) => r.n >= minN)
    .sort((a, b) => a.pnl - b.pnl);
  for (const r of rows) {
    console.log(
      `  ${String(r.n).padStart(4)}  pnl=${String(r.pnl).padStart(8)}  avg=${String(r.avg).padStart(6)}  wr=${String(r.wr).padStart(5)}%  ${r.k}`,
    );
  }
}

const report = { generatedAt: new Date().toISOString(), window: { from: FROM, to: TO }, symbols: {} };

for (const SYMBOL of SYMBOLS) {
  process.stderr.write(`autopsy ${SYMBOL}…\n`);
  clearIntradayAdapterCache?.();
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(SYMBOL, TF, { from: fromMs, to: toMs, market: "futures" });
  }
  const pad = 21 * 864e5;
  const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
  const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
  const pre = precomputeIntraday(candles);
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
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
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
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
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);

  const byExit = {};
  const bySide = {};
  const byLevel = {};
  const byDayType = {};
  const bySideDay = {};
  const byFail = {};
  const byHour = {};
  const byBars = {};
  let toxicPnl = 0;
  let toxicN = 0;
  let okFadePnl = 0;
  let okFadeN = 0;

  for (const t of trades) {
    const pnl = Number(t.netPnl ?? 0);
    const idx = findIdx(candles, t.entryBarTs ?? t.entryTs);
    const dir =
      t.direction === -1 || t.direction === "SELL" || t.direction === "short"
        ? "SELL"
        : "BUY";
    const levelType = String(t.entryReason || t.reason || "");
    const lt = /session_high|session_low/.test(levelType)
      ? levelType.includes("high")
        ? "session_high"
        : "session_low"
      : /pdh/.test(levelType)
        ? "pdh"
        : /pdl/.test(levelType)
          ? "pdl"
          : levelType.slice(0, 40) || "?";

    let dayType = "range";
    if (idx >= 0) {
      if (isBreakdownDay(candles, idx, pre)) dayType = "breakdown";
      else if (isBreakoutDay(candles, idx, pre)) dayType = "breakout";
    }
    const toxic = (dir === "BUY" && dayType === "breakdown") || (dir === "SELL" && dayType === "breakout");
    if (toxic) {
      toxicN += 1;
      toxicPnl += pnl;
    } else {
      okFadeN += 1;
      okFadePnl += pnl;
    }

    const hour = new Date(Number(t.entryTs)).getUTCHours();
    const bars = Number(t.barsHeld ?? 0);
    const barBucket = bars <= 4 ? "0-4" : bars <= 16 ? "5-16" : bars <= 32 ? "17-32" : "33+";

    bucket(byExit, String(t.exitReason ?? "?"), pnl);
    bucket(bySide, dir, pnl);
    bucket(byLevel, lt, pnl);
    bucket(byDayType, dayType, pnl);
    bucket(bySideDay, `${dir}|${dayType}`, pnl);
    bucket(byFail, failClass(t), pnl);
    bucket(byHour, `H${String(hour).padStart(2, "0")}`, pnl);
    bucket(byBars, barBucket, pnl);
  }

  let eq = 100;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: 100 });

  console.log(
    `\n######## ${SYMBOL} CORE n=${trades.length} tw=${(trades.length / weeks).toFixed(2)} ret=${(m.totalReturnPct ?? 0).toFixed(2)}% pf=${(m.profitFactor ?? 0).toFixed(2)}`,
  );
  console.log(
    `toxic fades: n=${toxicN} pnl=${toxicPnl.toFixed(2)} | other: n=${okFadeN} pnl=${okFadePnl.toFixed(2)}`,
  );
  printBucket("exit", byExit);
  printBucket("side|dayType", bySideDay);
  printBucket("failure class", byFail);
  printBucket("barsHeld", byBars);

  report.symbols[SYMBOL] = {
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    toxic: { n: toxicN, pnl: +toxicPnl.toFixed(2) },
    other: { n: okFadeN, pnl: +okFadePnl.toFixed(2) },
    byExit,
    bySide,
    byLevel,
    byDayType,
    bySideDay,
    byFail,
    byHour,
    byBars,
  };
}

const outPath = path.join(__dirname, ".liq-core-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("wrote", outPath);
await closePool?.();
