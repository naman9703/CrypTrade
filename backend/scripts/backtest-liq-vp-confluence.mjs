#!/usr/bin/env node
/**
 * LIQ + VP confluence experiment — liquidity trigger + VP location filter.
 * Compares: LIQ solo | VP intraday gate | VP standalone | LIQ+VP confluence
 *
 * Usage (from backend/):
 *   node scripts/backtest-liq-vp-confluence.mjs
 *   FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BNBUSDT,ETHUSDT node scripts/backtest-liq-vp-confluence.mjs
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
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT")
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
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter, selectIntradayPicks } = await import(
  "../src/strategy/intradayPro.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_ETH_15M,
  INTRADAY_PRO_VP_15M,
  INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M,
  INTRADAY_PRO_LIQ_VP_CONFLUENCE_ETH_15M,
  resolveLiqVpConfluencePreset,
  fillLiqSoloPresetDefaults,
  fillFibSoloPresetDefaults,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { VOLUME_PROFILE_15M } = await import("../src/strategy/presets/volumeProfileOptimized.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!m.has(k)) m.set(k, { pnl: 0, win: false });
    const row = m.get(k);
    row.pnl += Number(t.netPnl ?? 0);
    if (row.pnl > 0) row.win = true;
  }
  return [...m.values()];
}

function variantsForSymbol(sym) {
  const liqBase = sym === "ETHUSDT" ? INTRADAY_PRO_LIQ_ETH_15M : INTRADAY_PRO_LIQ_15M;
  const confluence = resolveLiqVpConfluencePreset(sym);
  const confluenceStrict = { ...confluence, requireVpSetup: true, intradayDualGateMinScore: 8 };

  return [
    {
      id: "liq_solo",
      label: "LIQ solo (liquidity gate only)",
      strategyKey: "SR_INTRADAY",
      preset: {
        ...liqBase,
        intradayGateLiquidity: true,
        intradayGateSession: false,
        intradayGateVp: false,
        intradayGateFib: false,
        intradayGateOrderFlow: false,
        intradayGateHtfRegime: false,
      },
    },
    {
      id: "vp_intraday_gate",
      label: "VP intraday gate only",
      strategyKey: "SR_INTRADAY",
      preset: {
        ...INTRADAY_PRO_VP_15M,
        symbol: sym,
        timeframe: TF,
        intradayGateLiquidity: false,
        intradayGateSession: false,
        intradayGateVp: true,
      },
    },
    {
      id: "liq_vp_confluence",
      label: "LIQ+VP confluence (dual gate, vp bias ok)",
      strategyKey: "SR_INTRADAY",
      preset: confluence,
    },
    {
      id: "liq_vp_confluence_strict",
      label: "LIQ+VP confluence strict (requireVpSetup)",
      strategyKey: "SR_INTRADAY",
      preset: confluenceStrict,
    },
    {
      id: "vp_standalone",
      label: "VP standalone Tier-A",
      strategyKey: "VOLUME_PROFILE",
      preset: { ...VOLUME_PROFILE_15M, symbol: sym, timeframe: TF },
    },
  ];
}

async function runVariant(symbol, variant) {
  await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs);
  if (candles.length < 500) return { symbol, variant: variant.id, error: `candles=${candles.length}` };

  clearIntradayAdapterCache();
  const base = {
    ...variant.preset,
    symbol,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: variant.strategyKey,
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
  };

  let cfg =
    variant.strategyKey === "SR_INTRADAY"
      ? materializeIntradayEngineCfgSync(
          fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(base)),
          materializeIntradayPanelOnCfg,
        )
      : base;
  cfg = mergeAdaptiveCfg(cfg, candles);

  const picks =
    variant.strategyKey === "SR_INTRADAY"
      ? selectIntradayPicks(candles, cfg)
      : { pickedCount: null, candidateCount: null };

  const trailMicro =
    cfg.trailingStopLossAuto === true
      ? await buildTrailMicroContext({
          symbol,
          fromMs: fromMs - padMs,
          toMs,
          cfg,
          trailEnabled: true,
        })
      : null;

  const adapters =
    variant.strategyKey === "SR_INTRADAY"
      ? { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) }
      : await (async () => {
          const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
          return buildBacktestAdapters({
            strategyKey: "VOLUME_PROFILE",
            cfg,
            symbol,
            tf: TF,
            candles,
            fromMs,
          });
        })();

  const sim = await runSimulation({
    strategyKey: variant.strategyKey,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters,
    trailMicro,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });

  const windowTrades = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const logical = logicalTrades(windowTrades);
  const m = computeAllMetrics({
    trades: windowTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });

  const exitReasons = windowTrades.reduce((acc, t) => {
    const k = t.exitReason || "?";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return {
    symbol,
    variant: variant.id,
    label: variant.label,
    picks: picks.pickedCount,
    candidates: picks.candidateCount,
    trades: logical.length,
    tradesPerWeek: +(logical.length / weeks).toFixed(2),
    tradesPerMonth: +((logical.length / days) * 30).toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    exitReasons,
  };
}

console.log(`\n══ LIQ + VP CONFLUENCE experiment ══`);
console.log(`${FROM} → ${TO}  (${days.toFixed(0)}d)  ${TF}  risk ${RISK}%\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const v of variantsForSymbol(sym)) {
    process.stderr.write(`Running ${sym} ${v.id}…\n`);
    rows.push(await runVariant(sym, v));
  }
}

console.log("Results:");
console.log("symbol     variant                  tr  tr/wk  tr/mo   WR%    ret%    PF   DD%  picks");
console.log("─".repeat(95));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.symbol.padEnd(10)} ${r.variant.padEnd(24)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${r.symbol.padEnd(10)} ${r.variant.padEnd(24)} ${String(r.trades).padStart(3)}  ${String(r.tradesPerWeek).padStart(5)}  ${String(r.tradesPerMonth).padStart(5)}  ${String(r.wr).padStart(5)}  ${String(r.ret).padStart(6)}  ${String(r.pf).padStart(4)}  ${String(r.dd).padStart(4)}  ${r.picks ?? "—"}`,
  );
}

const best = rows
  .filter((r) => !r.error)
  .sort((a, b) => {
    const scoreA = (a.ret > 0 ? 100 : 0) + a.tradesPerWeek * 10 + a.pf * 5;
    const scoreB = (b.ret > 0 ? 100 : 0) + b.tradesPerWeek * 10 + b.pf * 5;
    return scoreB - scoreA;
  })[0];

const confluenceRows = rows.filter((r) => r.variant?.startsWith("liq_vp_confluence") && !r.error);
const liqSolo = rows.filter((r) => r.variant === "liq_solo" && !r.error);

console.log("\nConfluence vs LIQ solo (per symbol):");
for (const sym of SYMBOLS) {
  const liq = liqSolo.find((r) => r.symbol === sym);
  const conf = confluenceRows.find((r) => r.symbol === sym && r.variant === "liq_vp_confluence");
  const strict = confluenceRows.find((r) => r.symbol === sym && r.variant === "liq_vp_confluence_strict");
  if (!liq || !conf) continue;
  console.log(
    `  ${sym}: LIQ ${liq.trades}t/${liq.tradesPerWeek}wk ret=${liq.ret}% PF=${liq.pf} → CONFL ${conf.trades}t/${conf.tradesPerWeek}wk ret=${conf.ret}% PF=${conf.pf} | STRICT ${strict?.trades ?? 0}t ret=${strict?.ret ?? 0}%`,
  );
}

const out = {
  window: `${FROM}→${TO}`,
  risk: RISK,
  symbols: SYMBOLS,
  rows,
  bestByComposite: best,
  target: { minTradesPerWeek: 2, minReturnPct: 0, minPf: 1 },
};

const outPath = path.resolve(__dirname, ".liq-vp-confluence-results.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(`Best composite: ${best?.symbol} ${best?.variant} — ${best?.trades} trades, ${best?.ret}% ret, PF ${best?.pf}`);

await closePool?.();
