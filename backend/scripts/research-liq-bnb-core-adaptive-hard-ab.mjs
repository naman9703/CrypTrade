#!/usr/bin/env node
/**
 * BNB LIQ_CORE — hard A/B for adaptive soft candidates (relative FT / continuous).
 *
 * Only runs when softPassers exist in .liq-bnb-core-adaptive-autopsy.json.
 * If soft exhausted, writes REJECT artifact and exits 0 (fork is next).
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-core-adaptive-hard-ab.mjs
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
const RISK = Number(process.env.RISK || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const softPath = path.join(__dirname, ".liq-bnb-core-adaptive-autopsy.json");
if (!fs.existsSync(softPath)) {
  console.error("Missing soft autopsy artifact:", softPath);
  process.exit(1);
}
const soft = JSON.parse(fs.readFileSync(softPath, "utf8"));
const passers = soft.softPassers ?? [];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

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
  };
}

async function runVariant(candles, funding, over) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...(over || {}),
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
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
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const windows = {};
  for (const w of yearWindows(fromMs, toMs)) {
    windows[w.id] = metrics(trades, w.lo, w.hi);
  }
  return windows;
}

const CONTINUOUS_OVER = {
  abstain_fakeReversal: {
    intradayLiqDaySituationBias: true,
    intradayLiqVetoCounterTrend: true,
  },
  impulse_x_room: {
    intradayLiqContinuationGate: true,
    intradayLiqMinContinuationR: 1.2,
    intradayLiqRequireDisplacementV2: true,
  },
  room_and_not_fake: {
    intradayLiqDaySituationBias: true,
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  },
};

const outPath = path.join(__dirname, ".liq-bnb-core-adaptive-hard-ab.json");

if (!passers.length) {
  const bestSoft = (soft.hardCandidates ?? []).slice(0, 5);
  const verdict = {
    generatedAt: new Date().toISOString(),
    verdict: "SKIP_HARD_SOFT_EXHAUST",
    reason:
      "No softPassers (FULL PF≥1 + Y25/H12 ret>0 + tw≥2). Per plan: do not hard-gate; fork to Liquidity Map / SMC.",
    primaryFailure: soft.primaryFailure,
    bestSoftFails: bestSoft,
    softPassers: [],
  };
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  await closePool?.();
  process.exit(0);
}

console.log(`Hard A/B softPassers=${passers.join(", ")}`);
const padMs = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - padMs, toMs).catch(() => []);

const results = [];
process.stderr.write("run CORE…\n");
results.push({ id: "CORE", windows: await runVariant(candles, funding, {}) });

for (const label of passers) {
  const softRow = [...(soft.softFt ?? []), ...(soft.softCont ?? []), ...(soft.softCompounds ?? [])].find(
    (s) => s.label === label,
  );
  let over = softRow?.over ?? null;
  if (!over && CONTINUOUS_OVER[label]) over = CONTINUOUS_OVER[label];
  if (!over) {
    console.warn(`No hard mapping for ${label} — skip`);
    continue;
  }
  process.stderr.write(`run ${label}…\n`);
  const windows = await runVariant(candles, funding, over);
  const full = windows.FULL;
  const pass =
    full.pf >= 1 && windows.Y2025.ret > 0 && windows.H12m.ret > 0 && full.tw >= 2;
  results.push({ id: label, over, windows, pass });
  console.log(
    `${label.padEnd(28)} FULL pf=${full.pf} ret=${full.ret} tw=${full.tw} Y25=${windows.Y2025.ret} H12=${windows.H12m.ret}${pass ? " ★PASS" : ""}`,
  );
}

const anyPass = results.some((r) => r.pass);
const out = {
  generatedAt: new Date().toISOString(),
  verdict: anyPass ? "PROMOTE_CANDIDATE" : "REJECT",
  results,
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`verdict=${out.verdict} wrote ${outPath}`);
await closePool?.();
