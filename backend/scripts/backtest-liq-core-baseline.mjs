#!/usr/bin/env node
/**
 * LIQ_CORE baseline + filter ablation (multi-coin).
 *
 * Doctrine: docs/LIQ_CORE_PLAYBOOK.md
 *
 * Usage (from backend/):
 *   node scripts/backtest-liq-core-baseline.mjs
 *   FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BNBUSDT,ETHUSDT,BTCUSDT node scripts/backtest-liq-core-baseline.mjs
 *   SKIP_ENSURE=1 node scripts/backtest-liq-core-baseline.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const TF = process.env.TF || "15m";
const RISK = Number(process.env.RISK || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT,BTCUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);
const weeks = days / 7;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter, selectIntradayPicks } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

/** One-change ablations vs CORE (filter policy: reject if only cuts N). */
const VARIANTS = [
  { id: "core", label: "LIQ_CORE baseline", over: {} },
  { id: "legacy", label: "Legacy LIQ_15M (EOD onePick)", useLegacy: true },
  {
    id: "core_eod",
    label: "CORE + EOD best pick",
    over: { intradayLiqPickMode: "eod_best", intradayLiqOnePickPerDay: true },
  },
  {
    id: "core_body35",
    label: "CORE + reclaim body 0.35",
    over: { intradayLiqMinReclaimBodyRatio: 0.35 },
  },
  {
    id: "core_sameBarReject",
    label: "CORE + reject same-bar reclaim",
    over: { intradayLiqRejectSameBarReclaim: true },
  },
  {
    id: "core_minRr15",
    label: "CORE + minRr 1.5",
    over: { intradayLiqMinRr: 1.5 },
  },
  {
    id: "core_noSessionExt",
    label: "CORE without session extremes",
    over: { intradayLiqSessionExtreme: false },
  },
  {
    id: "core_hold24",
    label: "CORE maxHold 24 bars",
    over: { intradayLiqMaxHoldBars: 24 },
  },
  {
    id: "core_score52",
    label: "CORE + entryScore≥52",
    over: { intradayLiqUseEntryScore: true, intradayLiqMinEntryScore: 52 },
  },
];

function summarize(trades, candlesLen = 0) {
  const closed = (trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  let eq = 100;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of closed) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({
    trades: closed,
    equityCurve: curve,
    tf: TF,
    startingEquity: 100,
  });
  const exits = {};
  for (const t of closed) {
    const k = String(t.exitReason ?? "?");
    exits[k] = (exits[k] ?? 0) + 1;
  }
  return {
    trades: closed.length,
    tw: +(closed.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    exits,
  };
}

async function runOne(symbol, variant) {
  clearIntradayAdapterCache?.();
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  }
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs, { market: "futures" });
  const funding = await readFundingRates(symbol, fromMs - padMs, toMs).catch(() => []);

  const base = variant.useLegacy
    ? { ...INTRADAY_PRO_LIQ_15M }
    : { ...INTRADAY_PRO_LIQ_CORE_15M, ...(variant.over || {}) };

  let cfg = {
    ...base,
    symbol,
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

  const picks = selectIntradayPicks(candles, cfg);
  const candidates = picks.candidateCount ?? 0;
  const picked = picks.pickedCount ?? 0;

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
    symbol,
  });
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const full = summarize(trades);
  return {
    symbol,
    variant: variant.id,
    label: variant.label,
    candidates,
    picked,
    ...full,
  };
}

console.log(`\n=== LIQ_CORE baseline + ablation === ${FROM}→${TO} ${TF}`);
console.log(`symbols=${SYMBOLS.join(",")} risk=${RISK}% lev=${LEVERAGE}x weeks=${weeks.toFixed(1)}\n`);

const rows = [];
for (const variant of VARIANTS) {
  for (const symbol of SYMBOLS) {
    process.stderr.write(`run ${variant.id} ${symbol}…\n`);
    try {
      const row = await runOne(symbol, variant);
      rows.push(row);
      console.log(
        `${variant.id.padEnd(20)} ${symbol.padEnd(10)} n=${String(row.trades).padStart(3)} tw=${row.tw} ret=${String(row.ret).padStart(7)}% pf=${row.pf} dd=${row.dd} cal=${row.calmar} cand=${row.candidates} pick=${row.picked}`,
      );
    } catch (err) {
      console.error(`FAIL ${variant.id} ${symbol}:`, err?.message || err);
      rows.push({ symbol, variant: variant.id, label: variant.label, error: String(err?.message || err) });
    }
  }
  console.log("");
}

/** Portfolio rollup for CORE vs legacy (sum trades, mean ret crude). */
function rollup(id) {
  const rs = rows.filter((r) => r.variant === id && !r.error);
  if (!rs.length) return null;
  const trades = rs.reduce((s, r) => s + r.trades, 0);
  return {
    id,
    coins: rs.length,
    trades,
    tw: +(trades / weeks).toFixed(2),
    retSum: +rs.reduce((s, r) => s + r.ret, 0).toFixed(2),
    pfMean: +(rs.reduce((s, r) => s + r.pf, 0) / rs.length).toFixed(2),
  };
}

const coreRoll = rollup("core");
const legacyRoll = rollup("legacy");
console.log("PORTFOLIO (sum N / sum ret% per-coin sims — not shared equity):");
console.log("  CORE  ", coreRoll);
console.log("  LEGACY", legacyRoll);

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: TO, tf: TF, weeks },
  symbols: SYMBOLS,
  risk: RISK,
  leverage: LEVERAGE,
  rows,
  portfolio: { core: coreRoll, legacy: legacyRoll },
  doctrine: "docs/LIQ_CORE_PLAYBOOK.md",
};

const outPath = path.join(__dirname, ".liq-core-baseline.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("wrote", outPath);

await closePool?.();
