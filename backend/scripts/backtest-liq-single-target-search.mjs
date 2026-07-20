#!/usr/bin/env node
/**
 * Focused single-coin liquidity-sweep search.
 *
 * Goal: test whether a defensible liquidity-sweep strategy can approach
 * ~1 logical trade/day on one coin without becoming net-negative after costs.
 *
 * Usage:
 *   SYMBOL=BNBUSDT FROM=2026-05-01 TO=2026-06-01 node scripts/backtest-liq-single-target-search.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || process.argv[2] || "2026-05-01";
const TO = process.env.TO || process.argv[3] || "2026-06-01";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const ONLY = String(process.env.ONLY || "").trim().toLowerCase();

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  fillLiqSoloPresetDefaults,
  fillSmcSoloPresetDefaults,
  fillFibSoloPresetDefaults,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

const candles = await readCandles(SYMBOL, TF, fromMs - 5 * 86_400_000, toMs);
await closePool?.();
if (!candles.length) {
  console.error(`No candles for ${SYMBOL} ${TF} ${FROM}->${TO}`);
  process.exit(1);
}

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    if (t.entryTs < fromMs || t.entryTs >= toMs) continue;
    const k = `${t.entryTs}:${t.direction}`;
    if (!m.has(k)) {
      m.set(k, {
        entryTs: t.entryTs,
        direction: t.direction,
        pnl: 0,
        grossWin: 0,
        grossLoss: 0,
        exits: new Map(),
      });
    }
    const o = m.get(k);
    const pnl = Number(t.netPnl ?? 0);
    o.pnl += pnl;
    if (pnl > 0) o.grossWin += pnl;
    if (pnl < 0) o.grossLoss += Math.abs(pnl);
    const r = t.exitReason || "?";
    o.exits.set(r, (o.exits.get(r) || 0) + 1);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function exitsSummary(trades) {
  const out = {};
  for (const t of trades) {
    if (t.entryTs < fromMs || t.entryTs >= toMs) continue;
    const r = t.exitReason || "?";
    out[r] = (out[r] || 0) + 1;
  }
  return out;
}

function liqCfg(overrides = {}) {
  return fillLiqSoloPresetDefaults(
    fillFibSoloPresetDefaults({
      ...INTRADAY_PRO_LIQ_15M,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: LEVERAGE,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTradeUnit: "PCT",
      slippagePct: 0.0005,
      srIntradayMaxTradesPerDay: 8,
      intradayLiqMaxTradesPerSidePerDay: 4,
      intradayLiqOnePickPerDay: false,
      ...overrides,
    }),
  );
}

function smcCfg(base, overrides = {}) {
  return materializeIntradayEngineCfgSync(
    fillSmcSoloPresetDefaults({
      ...base,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: LEVERAGE,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTradeUnit: "PCT",
      slippagePct: 0.0005,
      srIntradayMaxTradesPerDay: 8,
      ...overrides,
    }),
    materializeIntradayPanelOnCfg,
  );
}

const variants = [
  {
    label: "PDH/PDL loose reclaim",
    cfg: liqCfg({
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinWickRatio: 0,
      intradayLiqMinRr: 0,
      intradayLiqMinScore: 5,
      intradayLiqRequireHtfAlign: false,
    }),
  },
  {
    label: "PDH/PDL + session extremes",
    cfg: liqCfg({
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinWickRatio: 0,
      intradayLiqMinRr: 0,
      intradayLiqMinScore: 5,
      intradayLiqSessionExtreme: true,
      intradayLiqSessionExtremeMinTouches: 2,
      intradayLiqSessionExtremeMinExtensionPct: 0.001,
      intradayLiqRequireHtfAlign: false,
    }),
  },
  {
    label: "SMC sweep preset",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M),
  },
  {
    label: "SMC sweep no HTF",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcRequireHtfBias: false,
      intradayLiqMinRr: 1.0,
      intradaySmcMinRr: 1.0,
    }),
  },
  {
    label: "SMC noHTF strong reclaim",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcRequireHtfBias: false,
      intradayLiqMinRr: 1.0,
      intradaySmcMinRr: 1.0,
      intradayLiqMinReclaimBodyRatio: 0.35,
      intradayLiqMinSweepExtensionPct: 0.005,
    }),
  },
  {
    label: "SMC noHTF internal TP",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcRequireHtfBias: false,
      intradayLiqMinRr: 1.0,
      intradaySmcMinRr: 1.0,
      intradaySmcTp2Mode: "internal",
      intradaySmcMaxTpRr: 3,
      intradaySmcMaxHoldBars: 24,
    }),
  },
  {
    label: "SMC noHTF full TP2 only",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcRequireHtfBias: false,
      intradayLiqMinRr: 1.0,
      intradaySmcMinRr: 1.0,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: false,
      intradaySmcTp2Mode: "internal",
      intradaySmcMaxTpRr: 2.5,
      intradaySmcMaxHoldBars: 24,
    }),
  },
  {
    label: "SMC noHTF trail SL-only",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcRequireHtfBias: false,
      intradayLiqMinRr: 1.0,
      intradaySmcMinRr: 1.0,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: true,
      futuresTrailingStopMode: "SUPERTREND",
      futuresTrailingStFeeBreakeven: true,
      futuresTrailingStAdvanced: true,
      trailBufferRate: 0.0015,
      trailFeeBeMultiplier: 1.25,
      trailPostT02SpacingFrac: 0.002,
      trailPostT02ActivationBufferRate: 0.0014,
    }),
  },
  {
    label: "SMC sweep daily sniper",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcPickMode: "daily_sniper",
      intradaySmcOneTradePerDay: true,
      intradayLiqOnePickPerDay: true,
      intradaySmcRequireHtfBias: true,
      intradaySmcMinRr: 1.0,
      intradayLiqMinRr: 1.0,
    }),
  },
  {
    label: "SMC balanced no HTF",
    cfg: smcCfg(INTRADAY_PRO_ICT_15M, {
      intradaySmcIctProfile: "balanced",
      intradaySmcRequireChoch: true,
      intradaySmcChochStrict: false,
      intradaySmcRequireMss: true,
      intradaySmcRequireRetrace: true,
      intradaySmcRequireFvgRetrace: true,
      intradaySmcRequireHtfBias: false,
      intradaySmcEntryZoneMode: "EITHER",
      intradaySmcMinRr: 1.0,
      intradayLiqMinRr: 1.0,
    }),
  },
  {
    label: "SMC research CHoCH+FVG",
    cfg: smcCfg(INTRADAY_PRO_ICT_RESEARCH_15M, {
      intradaySmcMinRr: 1.0,
      intradayLiqMinRr: 1.0,
    }),
  },
  {
    label: "SMC full ICT",
    cfg: smcCfg(INTRADAY_PRO_ICT_FULL_15M, {
      intradaySmcMinRr: 1.0,
      intradayLiqMinRr: 1.0,
    }),
  },
];

async function runVariant({ label, cfg }) {
  clearIntradayAdapterCache();
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: LEVERAGE,
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: LEVERAGE,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const logical = logicalTrades(out.trades);
  const pnl = logical.reduce((a, t) => a + t.pnl, 0);
  const wins = logical.filter((t) => t.pnl > 0).length;
  const grossWin = logical.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(logical.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const metrics = computeAllMetrics({
    trades: out.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs),
    equityCurve: out.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  return {
    label,
    entries: logical.length,
    perDay: logical.length / days,
    returnPct: (pnl / START) * 100,
    winRatePct: logical.length ? (wins / logical.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDdPct: metrics.maxDrawdownPct ?? 0,
    exits: exitsSummary(out.trades),
  };
}

console.log(`\n=== Focused liquidity single-coin search ===`);
console.log(`${SYMBOL} ${TF} ${FROM}->${TO} risk=${RISK}% lev=${LEVERAGE}x days=${days.toFixed(0)}\n`);
console.log(
  `${"variant".padEnd(28)}${"entries".padStart(8)}${"/day".padStart(7)}${"ret%".padStart(9)}${"WR%".padStart(7)}${"PF".padStart(7)}${"DD%".padStart(8)}  exits`,
);

const results = [];
for (const v of variants.filter((variant) => !ONLY || variant.label.toLowerCase().includes(ONLY))) {
  const r = await runVariant(v);
  results.push(r);
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "inf";
  console.log(
    `${r.label.padEnd(28)}${String(r.entries).padStart(8)}${r.perDay.toFixed(2).padStart(7)}${r.returnPct.toFixed(2).padStart(9)}${r.winRatePct.toFixed(1).padStart(7)}${pf.padStart(7)}${r.maxDdPct.toFixed(2).padStart(8)}  ${JSON.stringify(r.exits)}`,
  );
}

const viable = results
  .filter((r) => r.returnPct > 0 && r.perDay >= 0.5)
  .sort((a, b) => b.returnPct - a.returnPct);

console.log("\nBest positive high-frequency candidate:");
console.log(viable[0] ? JSON.stringify(viable[0], null, 2) : "none");
