#!/usr/bin/env node
/**
 * 1m liq bars — log every liquidation bar + simulate trades with all non-liq gates OFF.
 *
 * Liq-only trigger: z-score + min USD/bar + forced-side dominance (1.2× ratio).
 * Disabled: OI, displacement, ATR floor, confirm stall, min R:R, event cooldown, bar gap.
 *
 * Usage (backend/):
 *   DAYS=3 node scripts/research-liq-cascade-3d-liq-only-csv.mjs
 *   DAYS=3 OUT=scripts/.liq-cascade-3d-liq-only.csv node scripts/research-liq-cascade-3d-liq-only-csv.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const DAYS = Number(process.env.DAYS || 3);
const TF = process.env.TF || "1m";
const LIQ_SOURCE = process.env.LIQ_SOURCE || "force_orders";
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const OUT =
  process.env.OUT ||
  path.join(__dirname, `.liq-cascade-${DAYS}d-liq-only-events.csv`);

const presetMod = await import("../src/strategy/presets/liqCascadeOptimized.js");

/** All non-liq gates off; liq spike + dom only. */
const LIQ_ONLY_PATCH = {
  liqCascadeInterval: "1min",
  liqCascadeLiqSource: LIQ_SOURCE,
  liqCascadeOiGateMode: "off",
  liqCascadeMinOiDropPct: 0,
  liqCascadeMinDispAtr: 0,
  liqCascadeStrongDispAtr: 0,
  liqCascadeMinAtrPct: 0,
  liqCascadeMinRr: 0,
  liqCascadeTpRr: 0,
  liqCascadeTpAtrMult: 5,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 1,
  liqCascadeEventCooldownLiqBars: 0,
  liqCascadeMinBarGap: 0,
  liqCascadeMaxTradesPerDay: 999,
  liqCascadeZScoreMin: 1.2,
  liqCascadeMinLiqUsdBar: 5_000,
  liqCascadeLookbackBars: 60,
  liqCascadeLiveTickEnabled: false,
  intradayLiqEntryAtSignalClose: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  liqCascadeDirectionMode: "fade",
};

const PRESETS = {
  BTCUSDT: { ...presetMod.LIQ_CASCADE_BTC_1M, ...LIQ_ONLY_PATCH, symbol: "BTCUSDT" },
  ETHUSDT: { ...presetMod.LIQ_CASCADE_ETH_1M, ...LIQ_ONLY_PATCH, symbol: "ETHUSDT" },
  BNBUSDT: { ...presetMod.LIQ_CASCADE_BNB_1M, ...LIQ_ONLY_PATCH, symbol: "BNBUSDT" },
};

const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 60 * 60 * 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  hydrateLiqCascadeCfg,
  liqCascadePadFromMs,
  optsFromLiqCascadeCfg,
} = await import("../src/strategy/liqCascadeIntraday.js");
const { prepareLiqBars, liqIntervalToMs } = await import("../src/strategy/techniques/liqCascade.js");

function csvEscape(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function candleIdxAtOrBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function fadeSide(dom) {
  if (dom === "longs") return "BUY";
  if (dom === "shorts") return "SELL";
  return "";
}

function matchTradeToLiqBar(trades, liqBarTs, tfMs) {
  const windowMs = Math.max(tfMs * 2, 120_000);
  for (const t of trades) {
    const entryTs = Number(t.entryTs);
    if (!Number.isFinite(entryTs)) continue;
    if (Math.abs(entryTs - liqBarTs) <= windowMs) return t;
    if (entryTs >= liqBarTs && entryTs <= liqBarTs + windowMs) return t;
  }
  return null;
}

function slR(t) {
  const entry = Number(t.entryPrice);
  const sl = Number(t.slPrice);
  if (!(entry > 0) || !(sl > 0)) return null;
  return Math.abs(entry - sl) / entry;
}

function pnlR(t) {
  const risk = slR(t);
  if (!(risk > 0)) return null;
  const entry = Number(t.entryPrice);
  const exit = Number(t.exitPrice);
  const dir = String(t.direction ?? t.side ?? "").toUpperCase();
  const ret = dir === "BUY" || dir === "LONG" ? (exit - entry) / entry : (entry - exit) / entry;
  return ret / risk;
}

const CSV_HEADER = [
  "symbol",
  "liq_bar_close_utc",
  "liq_long_usd",
  "liq_short_usd",
  "total_liq_usd",
  "z_score",
  "dominance",
  "z_trigger_pass",
  "dom_trigger_pass",
  "min_usd_trigger_pass",
  "liq_signal_trigger",
  "fade_side",
  "chart_close_at_liq_bar",
  "trade_simulated",
  "trade_side",
  "entry_time_utc",
  "entry_price",
  "stop_loss",
  "take_profit",
  "exit_time_utc",
  "exit_price",
  "exit_reason",
  "net_pnl_usd",
  "pnl_pct",
  "pnl_r",
  "hold_bars",
  "mfe_pct",
  "mae_pct",
  "skip_reason",
].join(",");

const rows = [CSV_HEADER];

async function processSymbol(symbol) {
  const preset = PRESETS[symbol];
  const padFrom = liqCascadePadFromMs(fromMs, TF);
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(symbol, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
  }
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateLiqCascadeCfg(preset, symbol, padFrom, toMs);
  const opts = optsFromLiqCascadeCfg(cfg);
  const intervalMs = liqIntervalToMs(cfg.liqCascadeInterval ?? "1min");
  const liqSeries = cfg._liqCascadeLiqSeries ?? [];
  const liqBars = prepareLiqBars(liqSeries, {
    intervalMs,
    lookbackBars: Number(cfg.liqCascadeLookbackBars ?? 60),
  });
  const tfMs = candles.length > 1 ? Number(candles[1].ts) - Number(candles[0].ts) : 60_000;

  const simCfg = {
    ...cfg,
    backtestSignalStartMs: fromMs,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "LIQ_CASCADE",
    cfg: simCfg,
    symbol,
    tf: TF,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "LIQ_CASCADE",
    candles,
    cfg: simCfg,
    costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
    gateMode: "off",
    fundingRates: await readFundingRates(symbol, fromMs, toMs).catch(() => []),
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters,
  });
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && String(t.exitReason ?? "") !== "tp1_partial",
  );
  const usedTradeIds = new Set();

  const liqInWindow = liqBars.filter((b) => b.ts >= fromMs && b.ts <= toMs && b.totalUsd > 0);

  for (const lb of liqInWindow) {
    const zPass = lb.z != null && lb.z >= opts.liqZScoreMin;
    const domPass = lb.dom === "longs" || lb.dom === "shorts";
    const usdPass = lb.totalUsd >= opts.minLiqUsdBar;
    const liqTrigger = zPass && domPass && usdPass;

    const idx = candleIdxAtOrBefore(candles, lb.ts);
    const chartClose = idx != null ? Number(candles[idx]?.close) : null;

    let trade = null;
    let skipReason = "";
    if (liqTrigger) {
      trade = matchTradeToLiqBar(
        trades.filter((t) => !usedTradeIds.has(t.tradeNumber ?? t.entryTs)),
        lb.ts,
        tfMs,
      );
      if (trade) usedTradeIds.add(trade.tradeNumber ?? trade.entryTs);
      else skipReason = "liq_trigger_no_adapter_trade";
    }

    const risk = trade ? slR(trade) : null;
    const entry = trade ? Number(trade.entryPrice) : null;
    const exit = trade ? Number(trade.exitPrice) : null;
    const dir = trade ? String(trade.direction ?? trade.side ?? "").toUpperCase() : "";
    const pnlPct =
      trade && entry > 0
        ? dir === "BUY" || dir === "LONG"
          ? ((exit - entry) / entry) * 100
          : ((entry - exit) / entry) * 100
        : null;

    rows.push(
      [
        symbol,
        new Date(lb.ts).toISOString(),
        Math.round(lb.liqLongUsd ?? lb.longUsd ?? 0),
        Math.round(lb.liqShortUsd ?? lb.shortUsd ?? 0),
        Math.round(lb.totalUsd),
        lb.z != null ? +Number(lb.z).toFixed(3) : "",
        lb.dom ?? "neutral",
        zPass ? "yes" : "no",
        domPass ? "yes" : "no",
        usdPass ? "yes" : "no",
        liqTrigger ? "yes" : "no",
        fadeSide(lb.dom),
        chartClose != null ? +chartClose.toFixed(4) : "",
        trade ? "yes" : "no",
        trade ? dir : "",
        trade ? new Date(Number(trade.entryTs)).toISOString() : "",
        trade?.entryPrice != null ? +Number(trade.entryPrice).toFixed(4) : "",
        trade?.slPrice != null ? +Number(trade.slPrice).toFixed(4) : "",
        trade?.tpPrice != null ? +Number(trade.tpPrice).toFixed(4) : "",
        trade ? new Date(Number(trade.exitTs)).toISOString() : "",
        trade?.exitPrice != null ? +Number(trade.exitPrice).toFixed(4) : "",
        trade?.exitReason ?? "",
        trade?.netPnl != null ? +Number(trade.netPnl).toFixed(4) : "",
        pnlPct != null ? +pnlPct.toFixed(4) : "",
        trade ? (pnlR(trade) != null ? +pnlR(trade).toFixed(3) : "") : "",
        trade?.barsHeld ?? "",
        trade?.mfePct != null ? +Number(trade.mfePct).toFixed(4) : "",
        trade?.maePct != null ? +Number(trade.maePct).toFixed(4) : "",
        skipReason,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return {
    symbol,
    liqBarsNonZero: liqInWindow.length,
    liqTriggers: liqInWindow.filter(
      (b) =>
        b.z != null &&
        b.z >= opts.liqZScoreMin &&
        (b.dom === "longs" || b.dom === "shorts") &&
        b.totalUsd >= opts.minLiqUsdBar,
    ).length,
    simTrades: trades.length,
    tickCount: cfg._liqCascadeTickCount ?? null,
  };
}

const summary = {
  window: { days: DAYS, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  setup: "1m_liq_bars_liq_only_gates",
  liqOnlyPatch: LIQ_ONLY_PATCH,
  coins: [],
};

for (const sym of SYMBOLS) {
  try {
    summary.coins.push(await processSymbol(sym));
  } catch (err) {
    summary.coins.push({ symbol: sym, error: String(err?.message || err) });
  }
}

fs.writeFileSync(OUT, rows.join("\n") + "\n");
summary.csvPath = OUT;
summary.totalEventRows = rows.length - 1;
summary.totals = {
  liqBarsNonZero: summary.coins.reduce((a, c) => a + (c.liqBarsNonZero ?? 0), 0),
  liqTriggers: summary.coins.reduce((a, c) => a + (c.liqTriggers ?? 0), 0),
  simTrades: summary.coins.reduce((a, c) => a + (c.simTrades ?? 0), 0),
};

console.log(JSON.stringify(summary, null, 2));
await closePool?.().catch(() => {});
