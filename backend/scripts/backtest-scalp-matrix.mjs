#!/usr/bin/env node
/**
 * Scalping strategy matrix — tune + 5-month OOS test on BNB/BTC/ETH.
 *
 * Candidates: CRT_TBS, TOKYO_SESSION, SR_INTRADAY LIQ partial, SITUATION_INTRADAY.
 *
 * Usage: node scripts/backtest-scalp-matrix.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOLS = String(process.env.SYMBOLS || "BNBUSDT,BTCUSDT,ETHUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "15m";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 2);
const TUNE_MONTHS = 3;

const MONTHS = ["2025-07", "2025-09", "2025-11", "2026-01", "2026-04"];

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return { from, to: `${nextY}-${String(nextM).padStart(2, "0")}-01`, label: ym };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg, crtTbsPadFromMs } = await import(
  "../src/strategy/crtTbsIntraday.js"
);
const {
  buildTokyoSessionBacktestAdapter,
  resolveTokyoSessionCfg,
  tokyoSessionPadFromMs,
} = await import("../src/strategy/tokyoSessionIntraday.js");
const { materializeIntradayEngineCfg } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { resolveSituationRouterCfg, buildSituationIntradayBacktestAdapter } = await import(
  "../src/strategy/situationIntraday.js"
);
const {
  CRT_TBS_BNB_15M,
  CRT_TBS_BNB_15M_BALANCED,
  CRT_TBS_BNB_15M_FREQ,
} = await import("../src/strategy/presets/crtTbsOptimized.js");
const { TOKYO_SESSION_BNB_15M } = await import("../src/strategy/presets/tokyoSessionOptimized.js");
const { INTRADAY_PRO_LIQ_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { BNB_SITUATION_ROUTER_15M } = await import("../src/strategy/presets/bnbSituationRouter.js");

const COST = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };
const windows = MONTHS.map(monthWindow);
const tuneWindows = windows.slice(0, TUNE_MONTHS);
const oosWindows = windows.slice(TUNE_MONTHS);

function buildCandidates(symbol) {
  return [
    {
      id: "crt_tbs_selective",
      label: "CRT+TBS selective (London, CHoCH)",
      engine: "CRT_TBS",
      base: { ...CRT_TBS_BNB_15M, symbol, timeframe: TF, riskPerTrade: RISK },
      tune: [
        { crtMinRrToTp2: 0.5, crtRequireEntryBelowEq: true },
        { crtMinRrToTp2: 0.3, crtRequireEntryBelowEq: true },
        { crtMinRrToTp2: 0.3, crtRequireEntryBelowEq: false, crtStructureMode: "choch_or_bos" },
      ],
    },
    {
      id: "crt_tbs_balanced",
      label: "CRT+TBS balanced (London+NY)",
      engine: "CRT_TBS",
      base: { ...CRT_TBS_BNB_15M_BALANCED, symbol, timeframe: TF, riskPerTrade: RISK },
      tune: [
        { crtMinRrToTp2: 0.3 },
        { crtMinRrToTp2: 0.5, crtMaxTradesPerDay: 2 },
        { crtStructureMode: "choch_or_bos", crtMinRrToTp2: 0.3 },
      ],
    },
    {
      id: "crt_tbs_freq",
      label: "CRT+TBS higher frequency",
      engine: "CRT_TBS",
      base: { ...CRT_TBS_BNB_15M_FREQ, symbol, timeframe: TF, riskPerTrade: RISK },
      tune: [
        { crtMaxTradesPerDay: 3, crtMinBarGap: 2 },
        { crtMaxTradesPerDay: 4, crtMinBarGap: 2, crtMinRrToTp2: 0.2 },
        { crtStructureMode: "bos", crtRequireChoch: false, crtMaxTradesPerDay: 3 },
      ],
    },
    {
      id: "tokyo_sweep",
      label: "Tokyo session sweep fade",
      engine: "TOKYO_SESSION",
      base: { ...TOKYO_SESSION_BNB_15M, symbol, timeframe: TF, riskPerTrade: RISK },
      tune: [
        { tokyoTpMinRr: 1.0, tokyoSlMinPct: 0.004 },
        { tokyoTpMinRr: 1.2, tokyoSlMinPct: 0.005 },
        { tokyoTpMinRr: 1.5, tokyoMinPreAsiaWidthPct: 0.005 },
      ],
    },
    {
      id: "tokyo_partial_scalp",
      label: "Tokyo partial scalp (TP1 0.8R)",
      engine: "TOKYO_SESSION",
      base: {
        ...TOKYO_SESSION_BNB_15M,
        symbol,
        timeframe: TF,
        riskPerTrade: RISK,
        tokyoPartialTp: true,
        tokyoPartialFrac: 0.5,
        tokyoTp1Rr: 0.8,
        tokyoTp2Rr: 1.75,
      },
      tune: [
        { tokyoTp1Rr: 0.7, tokyoTp2Rr: 1.5 },
        { tokyoTp1Rr: 0.8, tokyoTp2Rr: 1.75 },
        { tokyoTp1Rr: 1.0, tokyoTp2Rr: 2.0 },
      ],
    },
    {
      id: "sr_liq_partial",
      label: "SR_INTRADAY liquidity partial @1R",
      engine: "SR_INTRADAY",
      base: { ...INTRADAY_PRO_LIQ_15M, symbol, timeframe: TF, riskPerTrade: RISK },
      tune: [
        { intradayLiqMinRr: 1.25, intradayLiqMinSweepExtensionPct: 0.006 },
        { intradayLiqMinRr: 1.5, intradayLiqMinSweepExtensionPct: 0.008 },
        { intradayLiqMinRr: 1.75, intradayLiqMinSweepExtensionPct: 0.01 },
      ],
    },
    ...(symbol === "BNBUSDT"
      ? [
          {
            id: "situation_router",
            label: "Situation router (BNB multi-playbook)",
            engine: "SITUATION_INTRADAY",
            base: { ...BNB_SITUATION_ROUTER_15M, symbol, timeframe: TF, riskPerTrade: RISK },
            tune: [
              { situationMinScore: 6, situationMaxTradesPerDay: 2 },
              { situationMinScore: 7, situationMaxTradesPerDay: 2 },
              { situationMinScore: 8, situationMaxTradesPerDay: 3 },
            ],
          },
        ]
      : []),
  ];
}

function logicalTrades(trades, fromMs, toMs) {
  const seen = new Set();
  let n = 0;
  for (const t of trades) {
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const key = `${ts}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
  }
  return n;
}

function scoreAgg(rows) {
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) return -1e9;
  const ret = ok.reduce((s, r) => s + r.ret, 0) / ok.length;
  const dd = ok.reduce((s, r) => s + r.dd, 0) / ok.length;
  const trades = ok.reduce((s, r) => s + r.trades, 0) / ok.length;
  const perDay = ok.reduce((s, r) => s + r.perDay, 0) / ok.length;
  const freqBonus = perDay >= 0.3 && perDay <= 2 ? 3 : perDay > 2 ? -2 : 0;
  return ret - dd * 0.6 + freqBonus - Math.abs(trades - 8) * 0.15;
}

async function runMatrixForSymbol(symbol) {
  const candleCache = new Map();
  const candidates = buildCandidates(symbol);

  async function loadCandles(window, engine) {
    const key = `${symbol}|${window.label}|${engine}`;
    if (candleCache.has(key)) return candleCache.get(key);
    const fromMs = Date.parse(window.from);
    const toMs = Date.parse(window.to);
    const padMs = engine === "CRT_TBS" ? crtTbsPadFromMs(fromMs, TF) : engine === "TOKYO_SESSION" ? tokyoSessionPadFromMs(fromMs, TF) : fromMs - 21 * 86_400_000;
    const candles = await readCandles(symbol, TF, padMs, toMs, { market: "futures" });
    const v = { candles, fromMs, toMs };
    candleCache.set(key, v);
    return v;
  }

  async function runMonth(window, candidate, tunePatch = {}) {
    const { candles, fromMs, toMs } = await loadCandles(window, candidate.engine);
    if (!candles?.length) return { error: "no_candles", label: window.label };

    const common = {
      strategyMode: "MANUAL",
      marketMode: "FUTURES",
      symbol,
      timeframe: TF,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTrade: RISK,
      riskPerTradeUnit: "PCT",
      slippagePct: 0.0005,
    };

    let sim;
    if (candidate.engine === "CRT_TBS") {
      const cfg = resolveCrtTbsCfg({ ...candidate.base, ...common, ...tunePatch, backtestSignalStartMs: fromMs });
      const adapter = buildCrtTbsBacktestAdapter(candles, cfg, TF);
      sim = await runSimulation({
        strategyKey: "CRT_TBS",
        candles,
        cfg: { ...cfg, symbol },
        gateMode: "off",
        fundingRates: [],
        startingUsdt: START,
        timeframe: TF,
        symbol,
        adapters: { CRT_TBS: adapter },
        costModelOverride: COST,
      });
    } else if (candidate.engine === "TOKYO_SESSION") {
      const cfg = resolveTokyoSessionCfg({ ...candidate.base, ...common, ...tunePatch, backtestSignalStartMs: fromMs });
      const adapter = buildTokyoSessionBacktestAdapter(candles, cfg, TF);
      sim = await runSimulation({
        strategyKey: "TOKYO_SESSION",
        candles,
        cfg: { ...cfg, symbol },
        gateMode: "off",
        fundingRates: [],
        startingUsdt: START,
        timeframe: TF,
        symbol,
        adapters: { TOKYO_SESSION: adapter },
        costModelOverride: COST,
      });
    } else if (candidate.engine === "SITUATION_INTRADAY") {
      const cfg = resolveSituationRouterCfg({ ...candidate.base, ...common, ...tunePatch, backtestSignalStartMs: fromMs });
      const adapter = buildSituationIntradayBacktestAdapter(candles, cfg, TF);
      sim = await runSimulation({
        strategyKey: "SITUATION_INTRADAY",
        candles,
        cfg: { ...cfg, symbol },
        gateMode: "off",
        fundingRates: [],
        startingUsdt: START,
        timeframe: TF,
        symbol,
        adapters: { SITUATION_INTRADAY: adapter },
        costModelOverride: COST,
      });
    } else {
      const cfg = await materializeIntradayEngineCfg({
        ...candidate.base,
        ...common,
        manualStrategy: "SR_INTRADAY",
        ...tunePatch,
        backtestSignalStartMs: fromMs,
      });
      const adapters = await buildBacktestAdapters({
        strategyKey: "SR_INTRADAY",
        cfg,
        symbol,
        tf: TF,
        candles,
        fromMs: Number(candles[0]?.ts) || fromMs,
      });
      sim = await runSimulation({
        strategyKey: "SR_INTRADAY",
        candles,
        cfg,
        gateMode: "off",
        fundingRates: [],
        startingUsdt: START,
        timeframe: TF,
        symbol,
        adapters,
        costModelOverride: COST,
      });
    }

    const inWin = sim.trades.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
    const metrics = computeAllMetrics({ trades: inWin, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
    const days = Math.max(1, (toMs - fromMs) / 86_400_000);
    const trades = logicalTrades(sim.trades, fromMs, toMs);
    return {
      label: window.label,
      trades,
      perDay: trades / days,
      ret: Number(metrics.totalReturnPct ?? 0),
      pf: Number(metrics.profitFactor ?? 0),
      dd: Number(metrics.maxDrawdownPct ?? 0),
      avgR: Number(metrics.expectancyR ?? 0),
    };
  }

  console.log(`\n${"=".repeat(70)}\nSCALP MATRIX | ${symbol} ${TF}`);
  const summary = [];

  for (const candidate of candidates) {
    let bestTune = candidate.tune[0];
    let bestScore = -1e9;
    for (const tune of candidate.tune) {
      const rows = [];
      for (const w of tuneWindows) rows.push(await runMonth(w, candidate, tune));
      const sc = scoreAgg(rows);
      if (sc > bestScore) {
        bestScore = sc;
        bestTune = tune;
      }
    }

    const monthRows = [];
    for (const w of windows) {
      const phase = oosWindows.some((o) => o.label === w.label) ? "oos" : "is";
      monthRows.push({ ...(await runMonth(w, candidate, bestTune)), phase });
    }

    const ok = monthRows.filter((r) => !r.error);
    const isRows = ok.filter((r) => r.phase === "is");
    const oosRows = ok.filter((r) => r.phase === "oos");
    const avg = (rows, k) => (rows.length ? rows.reduce((s, r) => s + r[k], 0) / rows.length : 0);

    const row = {
      id: candidate.id,
      label: candidate.label,
      engine: candidate.engine,
      bestTune,
      all5: {
        avgRetMo: Number(avg(ok, "ret").toFixed(2)),
        avgDd: Number(avg(ok, "dd").toFixed(2)),
        avgTrades: Number(avg(ok, "trades").toFixed(1)),
        avgPerDay: Number(avg(ok, "perDay").toFixed(2)),
        avgPf: Number(avg(ok, "pf").toFixed(2)),
      },
      oos: {
        avgRetMo: Number(avg(oosRows, "ret").toFixed(2)),
        avgDd: Number(avg(oosRows, "dd").toFixed(2)),
        avgTrades: Number(avg(oosRows, "trades").toFixed(1)),
        avgPerDay: Number(avg(oosRows, "perDay").toFixed(2)),
      },
      is: {
        avgRetMo: Number(avg(isRows, "ret").toFixed(2)),
        avgTrades: Number(avg(isRows, "trades").toFixed(1)),
      },
    };
    summary.push(row);
    console.log(
      JSON.stringify({
        id: row.id,
        all5: row.all5,
        oos: row.oos,
        bestTune: row.bestTune,
      }),
    );
  }

  summary.sort((a, b) => b.all5.avgRetMo - a.all5.avgRetMo);
  console.log(`\n--- ${symbol} RANKED ---`);
  for (const r of summary) {
    console.log(
      `${r.label.padEnd(36)} ret=${String(r.all5.avgRetMo).padStart(7)}%  dd=${String(r.all5.avgDd).padStart(5)}%  ` +
        `${String(r.all5.avgPerDay).padStart(4)}/day  oos=${String(r.oos.avgRetMo).padStart(7)}%`,
    );
  }
  return { symbol, summary };
}

console.log(`Scalp matrix | ${SYMBOLS.join(",")} | months=${MONTHS.join(",")} | risk=${RISK}%`);
const all = [];
for (const sym of SYMBOLS) all.push(await runMatrixForSymbol(sym));

const flat = all.flatMap((r) => r.summary.map((v) => ({ symbol: r.symbol, ...v })));
flat.sort((a, b) => b.all5.avgRetMo - a.all5.avgRetMo);

console.log(`\n${"=".repeat(70)}\n=== BEST SCALP CANDIDATES (all coins) ===`);
for (const r of flat.slice(0, 10)) {
  const working = r.all5.avgRetMo > 0 && r.oos.avgRetMo > 0 && r.all5.avgTrades >= 2;
  console.log(
    `${working ? "✓" : " "} ${r.symbol.padEnd(9)} ${r.label.padEnd(32)} ret=${String(r.all5.avgRetMo).padStart(6)}%  ` +
      `oos=${String(r.oos.avgRetMo).padStart(6)}%  ${String(r.all5.avgPerDay).padStart(4)}/day  dd=${String(r.all5.avgDd).padStart(5)}%`,
  );
}

const winners = flat.filter((r) => r.all5.avgRetMo > 0 && r.oos.avgRetMo > 0 && r.all5.avgTrades >= 2);
console.log(`\nWorking scalps (pos all5 + pos OOS + ≥2 tr/mo): ${winners.length}`);
if (winners.length) {
  for (const w of winners) {
    console.log(`  → ${w.symbol} ${w.label}: +${w.all5.avgRetMo}%/mo, OOS +${w.oos.avgRetMo}%, ${w.all5.avgPerDay}/day`);
  }
} else {
  console.log("  None passed all three criteria on this 5-month window.");
}

await closePool?.();
