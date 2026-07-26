#!/usr/bin/env node
/**
 * BNB architecture fork after CORE adaptive soft exhaust:
 * Liquidity Map (15m) + SMC ICT (sweep + full) year-grid vs CORE gates.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-arch-fork-year-grid.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
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
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import(
  "../src/strategy/intradayPro.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const {
  LIQUIDITY_MAP_BTC_15M_PRESET,
  resolveLiquidityMapRunCfg,
} = await import("../src/strategy/liquidityMapStrategy.js");

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
  out.push({ id: "H12m", lo: Math.max(lo, hi - 365.25 * 864e5), hi });
  out.push({ id: "FULL", lo, hi });
  return out;
}

function metrics(trades, lo, hi, tf) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf, startingEquity: 100 });
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

function gateCheck(windows) {
  const full = windows.FULL;
  const y25 = windows.Y2025;
  const h12 = windows.H12m;
  return {
    fullPf: full?.pf ?? null,
    y25Ret: y25?.ret ?? null,
    h12Ret: h12?.ret ?? null,
    tw: full?.tw ?? null,
    pass:
      (full?.pf ?? 0) >= 1 &&
      (y25?.ret ?? -Infinity) > 0 &&
      (h12?.ret ?? -Infinity) > 0 &&
      (full?.tw ?? 0) >= 2,
  };
}

async function runLiqMap(candles, funding) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...LIQUIDITY_MAP_BTC_15M_PRESET,
    symbol: SYMBOL,
    timeframe: "15m",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
  };
  cfg = resolveLiquidityMapRunCfg(cfg, candles);
  const adapters = await buildBacktestAdapters({
    strategyKey: "LIQUIDITY_MAP",
    cfg,
    symbol: SYMBOL,
    tf: "15m",
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "LIQUIDITY_MAP",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: SYMBOL,
  });
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const windows = {};
  for (const w of yearWindows(fromMs, toMs)) {
    windows[w.id] = metrics(trades, w.lo, w.hi, "15m");
  }
  return { id: "LIQ_MAP_15M", windows, gates: gateCheck(windows) };
}

async function runSmc(candles, funding, preset, id) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...preset,
    symbol: SYMBOL,
    timeframe: "15m",
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
  cfg = mergeAdaptiveCfg(cfg, candles);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, "15m");
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: "15m",
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const windows = {};
  for (const w of yearWindows(fromMs, toMs)) {
    windows[w.id] = metrics(trades, w.lo, w.hi, "15m");
  }
  return { id, windows, gates: gateCheck(windows) };
}

async function runCore(candles, funding) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    symbol: SYMBOL,
    timeframe: "15m",
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
  const adapter = buildIntradayBacktestAdapter(candles, cfg, "15m");
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: "15m",
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const windows = {};
  for (const w of yearWindows(fromMs, toMs)) {
    windows[w.id] = metrics(trades, w.lo, w.hi, "15m");
  }
  return { id: "CORE", windows, gates: gateCheck(windows) };
}

console.log(`\n=== BNB arch fork year-grid === ${FROM}→${TO}`);
const padMs = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, "15m", fromMs - padMs, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - padMs, toMs).catch(() => []);
console.log(`candles=${candles.length}`);

const results = [];
for (const runner of [
  () => runCore(candles, funding),
  () => runLiqMap(candles, funding),
  () => runSmc(candles, funding, INTRADAY_PRO_ICT_15M, "SMC_SWEEP_15M"),
  () => runSmc(candles, funding, INTRADAY_PRO_ICT_FULL_15M, "SMC_FULL_15M"),
]) {
  const row = await runner();
  results.push(row);
  const f = row.windows.FULL;
  console.log(
    `${row.id.padEnd(16)} FULL n=${String(f.n).padStart(4)} tw=${f.tw} ret=${String(f.ret).padStart(7)}% pf=${f.pf} Y25=${row.windows.Y2025.ret} H12=${row.windows.H12m.ret}${row.gates.pass ? " ★PASS" : ""}`,
  );
  for (const [wid, m] of Object.entries(row.windows)) {
    if (wid === "FULL") continue;
    console.log(
      `  ${wid.padEnd(6)} n=${String(m.n).padStart(4)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% pf=${m.pf}`,
    );
  }
}

const anyPass = results.some((r) => r.gates.pass);
const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  from: FROM,
  to: TO,
  verdict: anyPass ? "FORK_PROMOTE_CANDIDATE" : "FORK_REJECT",
  results,
};
const outPath = path.join(__dirname, ".liq-bnb-arch-fork-year-grid.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${out.verdict} wrote ${outPath}`);
await closePool?.();
