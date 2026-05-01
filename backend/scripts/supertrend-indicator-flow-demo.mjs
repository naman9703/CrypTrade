#!/usr/bin/env node
/**
 * Supertrend indicator → order flow (mirrors backend/src/state/bot.js)
 * ========================================================================
 *
 * LIVE BOT (when Supertrend autotrade is ON and bot is running):
 *
 * 1) Binance WebSocket sends a kline with `x: true` (bar fully closed).
 * 2) `processSupertrendCandleClose(candle)` runs:
 *    - Ensures Market + autotrade toggle match (SPOT + spot toggle, FUTURES + futures toggle,
 *      or AUTO → futures toggle wins if on, else spot).
 *    - Aligns the closed bar `ts` with `computeSupertrendSeries` on the feed buffer.
 *    - If `row.buySignal` → log "BUY signal (bar close) → SPOT|FUTURES" →
 *        `trySupertrendSpotOrder` OR `trySupertrendFuturesOrder` with `side: "BUY"`.
 *    - If `row.sellSignal` → same with `side: "SELL"`.
 *
 * 3a) SPOT BUY (`trySupertrendSpotOrder`, indicatorFullCapital):
 *     - Resolve `exch.spot` (or single spot exchange).
 *     - `getAccount()` → spend ≈ free USDT × SUPERTREND_SPOT_NOTIONAL_BUFFER_PCT.
 *     - `spotBracketFromAtr` for SL/TP from ATR + regime.
 *     - `placeOrder` MARKET BUY + OCO/brackets as implemented in the connector.
 *
 * 3b) SPOT SELL:
 *     - Requires an existing tracked long; sells / flattens via connector `placeOrder` SELL path.
 *
 * 4a) FUTURES BUY (`trySupertrendFuturesOrder`):
 *     - `ai.predict` when enough candles; else cached `lastAi`; else `SUPERTREND_FUTURES_AI_FALLBACK_PROB`.
 *     - Leverage: MANUAL from config or `decideFuturesLeverage(prob, …)`.
 *     - `riskPlan` on futures wallet → qty, SL, TP (ATR + regime + AI confidence scaling; USDT unit = target notional per trade).
 *     - `placeOrder` on futures connector (MARKET + exchange brackets).
 *
 * 4b) FUTURES SELL:
 *     - `closePosition({ id })` on a long (reduce-only market), not a new short entry.
 *
 * This script: fetches recent public klines, computes Supertrend, then runs execution **only when
 * the same condition as the live bot holds**: `buySignal` or `sellSignal` on the relevant closed bar.
 * (The bot does not default to BUY when there is no flip — neither does this script.)
 *
 * Usage (Binance Spot Demo API = TRADING_MODE BINANCE_DEMO_API + BINANCE_DEMO_API_KEY/SECRET in .env):
 *   cd backend
 *   node scripts/supertrend-indicator-flow-demo.mjs --venue spot              # only if latest bar has a signal
 *   node scripts/supertrend-indicator-flow-demo.mjs --venue spot --last-signal # replay most recent signal bar in window
 *   node scripts/supertrend-indicator-flow-demo.mjs --venue spot --side BUY    # force execution (test harness; not signal-based)
 *   node scripts/supertrend-indicator-flow-demo.mjs --mimic-both --venue both   # walk BUY + SELL (spot+futures), dry-run by default
 *   node scripts/supertrend-indicator-flow-demo.mjs --mimic-both --venue spot --execute  # real demo orders for both paths
 *
 * Flags:
 *   --venue spot|futures|both   (required, except `both` only valid with --mimic-both)
 *   --mimic-both           Run BUY-path then SELL-path for each venue, with step-by-step narrative (mirrors bot)
 *   --execute              With --mimic-both: place real orders (default for mimic-both is dry-run)
 *   --last-signal          Use most recent bar in klines that had buy/sellSignal (good for testing fills)
 *   --side BUY|SELL        Force side (ignores indicator); real bot never does this without a signal
 *   --symbol BTCUSDT       (default: DEFAULT_SYMBOL or BTCUSDT)
 *   --timeframe 1m         (default: DEFAULT_TIMEFRAME or 1m)
 *   --dry-run              Print steps only; no placeOrder / closePosition
 *   --skip-indicator       Skip Supertrend; requires --side (pure connector test)
 *
 * Supertrend params: SUPERTREND_PERIOD / SUPERTREND_MULTIPLIER / SUPERTREND_WILDER_ATR (or *_SCRIPT fallbacks).
 */

import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { clamp, roundTo } from "../src/lib/math.js";
import { computeIndicators } from "../src/strategy/indicators.js";
import { riskPlan, spotBracketFromAtr } from "../src/strategy/risk.js";
import { computeSupertrendSeries } from "../src/strategy/supertrend.js";
import { createExchange } from "../src/state/exchangeFactory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const log = {
  info: (...a) => console.log("[flow]", ...a),
  warn: (...a) => console.warn("[flow]", ...a),
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    venue: null,
    side: null,
    symbol: process.env.DEFAULT_SYMBOL || "BTCUSDT",
    timeframe: process.env.DEFAULT_TIMEFRAME || "1m",
    dryRun: false,
    skipIndicator: false,
    lastSignal: false,
    mimicBoth: false,
    mimicExecute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--venue" && argv[i + 1]) out.venue = String(argv[++i]).toLowerCase();
    else if (a === "--side" && argv[i + 1]) out.side = String(argv[++i]).toUpperCase();
    else if (a === "--symbol" && argv[i + 1]) out.symbol = String(argv[++i]).toUpperCase();
    else if (a === "--timeframe" && argv[i + 1]) out.timeframe = String(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-indicator") out.skipIndicator = true;
    else if (a === "--last-signal") out.lastSignal = true;
    else if (a === "--mimic-both") out.mimicBoth = true;
    else if (a === "--execute") out.mimicExecute = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function decideFuturesLeverageScript({ prob, atrPct, regime }) {
  const p = clamp(Number(prob ?? 0), 0, 1);
  const a = Math.max(0, Number(atrPct || 0));
  const reg = String(regime || "").toUpperCase();
  const volatile = reg.includes("VOLAT") || a >= 0.012;
  let lev =
    p >= 0.85 ? 15 :
    p >= 0.78 ? 10 :
    p >= 0.7 ? 7 :
    p >= 0.62 ? 5 :
    p >= 0.55 ? 3 : 2;
  if (volatile) lev = Math.max(2, Math.floor(lev * 0.6));
  return clamp(lev, 1, 5);
}

function aiGateProbability(calProb, rawProb) {
  const w = clamp(Number(process.env.AI_GATE_CALIBRATED_BLEND ?? 0.65), 0, 1);
  const cal = Number(calProb);
  const raw = Number(rawProb);
  if (Number.isFinite(raw) && Number.isFinite(cal)) return clamp(w * cal + (1 - w) * raw, 0, 1);
  return clamp(Number.isFinite(cal) ? cal : 0, 0, 1);
}

async function fetchKlines(symbol, interval, variant) {
  const isFut = variant === "futures";
  const base = isFut
    ? process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com"
    : process.env.BINANCE_REST_BASE || "https://api.binance.com";
  const url = isFut ? `${base}/fapi/v1/klines` : `${base}/api/v3/klines`;
  const { data } = await axios.get(url, {
    params: { symbol, interval, limit: 200 },
    timeout: 15_000,
  });
  if (!Array.isArray(data)) throw new Error("bad_klines");
  return data.map((k) => ({
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

async function tryPredictAi(symbol, timeframe, candles) {
  const baseUrl = process.env.AI_BASE_URL || "http://localhost:8001";
  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/$/, "")}/predict`,
      { symbol, timeframe, candles },
      { timeout: Math.max(5000, Number(process.env.AI_PREDICT_TIMEOUT_MS || 60_000)) },
    );
    const cal = Number(data?.probability ?? 0);
    const raw = Number(data?.raw_probability ?? data?.rawProbability ?? NaN);
    return aiGateProbability(cal, raw);
  } catch {
    return NaN;
  }
}

async function runSpotBuy({ ex, symbol, candles, dryRun }) {
  const spot = ex?.spot && ex.spot.placeOrder ? ex.spot : ex.placeOrder ? ex : null;
  if (!spot?.placeOrder) {
    log.warn("No spot connector with placeOrder (need hybrid spot or spot-only mode).");
    return;
  }
  const last = candles[candles.length - 1];
  const indicators = computeIndicators(candles);
  const regime = "TRENDING";
  const { stopLoss, takeProfit } = spotBracketFromAtr({
    entryPrice: last.close,
    atr: indicators.latest?.atr_14,
    regime,
    side: "BUY",
  });
  log.info("Step SPOT-BUY: spotBracketFromAtr", { stopLoss, takeProfit, close: last.close });

  const bufferPct = clamp(Number(process.env.SUPERTREND_SPOT_NOTIONAL_BUFFER_PCT ?? 1), 0.85, 1);
  const acct = await spot.getAccount();
  const tradable = Number(acct.freeBalance ?? acct.equity ?? 0);
  log.info("Step SPOT-BUY: getAccount", { freeBalance: tradable, equity: acct.equity });
  if (!tradable || tradable <= 0) {
    log.warn("No spendable quote — abort.");
    return;
  }
  const spend = tradable * bufferPct;
  const qty = roundTo(spend / Number(last.close), 8);
  log.info("Step SPOT-BUY: size (~full wallet)", { spend, qty, bufferPct });

  if (dryRun) {
    log.info("DRY-RUN: would spot.placeOrder BUY", { symbol, qty, price: last.close, stopLoss, takeProfit });
    return;
  }
  const order = await spot.placeOrder({
    symbol,
    side: "BUY",
    qty,
    price: last.close,
    stopLoss,
    takeProfit,
    strategy: "SUPERTREND_SCRIPT",
    meta: { supertrend: true, indicatorFullCapital: true, spendQuoteUsdt: spend },
  });
  log.info("Step SPOT-BUY: placeOrder OK", order);
}

async function runSpotSell({ ex, symbol, candles, dryRun }) {
  const spot = ex?.spot && ex.spot.placeOrder ? ex.spot : ex.placeOrder ? ex : null;
  if (!spot?.placeOrder) {
    log.warn("No spot connector with placeOrder.");
    return;
  }
  const last = candles[candles.length - 1];
  const indicators = computeIndicators(candles);
  const regime = "TRENDING";
  const { stopLoss, takeProfit } = spotBracketFromAtr({
    entryPrice: last.close,
    atr: indicators.latest?.atr_14,
    regime,
    side: "SELL",
  });
  const positions = await ex.getPositions?.().catch(() => []);
  const symU = String(symbol).toUpperCase();
  const here = (positions || []).filter(
    (p) => String(p.symbol).toUpperCase() === symU && (!p.venue || p.venue === "SPOT"),
  );
  if (!here.length) {
    log.warn("SPOT SELL: no spot position for symbol — same as bot skip.");
    return;
  }
  const qty = roundTo(Number(here[0].qty || 0), 8);
  log.info("Step SPOT-SELL: flatten long", { qty, stopLoss, takeProfit });

  if (dryRun) {
    log.info("DRY-RUN: would spot.placeOrder SELL", { symbol, qty });
    return;
  }
  const order = await spot.placeOrder({
    symbol,
    side: "SELL",
    qty,
    price: last.close,
    stopLoss,
    takeProfit,
    strategy: "SUPERTREND_SCRIPT",
    meta: { supertrend: true },
  });
  log.info("Step SPOT-SELL: placeOrder OK", order);
}

async function runFuturesBuy({ ex, symbol, timeframe, candles, dryRun }) {
  let futuresEx = ex?.futures;
  if (!futuresEx?.placeOrder && String(ex?.name || "").toLowerCase().includes("futures")) futuresEx = ex;
  if (!futuresEx?.placeOrder) {
    log.warn("No futures connector with placeOrder.");
    return;
  }
  const last = candles[candles.length - 1];
  const indicators = computeIndicators(candles);
  const regimeType = "TRENDING";

  let gateProb = await tryPredictAi(symbol, timeframe, candles);
  if (!Number.isFinite(gateProb)) {
    const rawFb = process.env.SUPERTREND_FUTURES_AI_FALLBACK_PROB;
    const fb = rawFb === undefined || rawFb === "" ? 0.58 : clamp(Number(rawFb), 0, 1);
    gateProb = fb;
    log.info("Step FUT-BUY: using AI fallback prob", gateProb);
  } else {
    log.info("Step FUT-BUY: AI gate probability", gateProb);
  }

  const manualLev = Number(process.env.SCRIPT_FUTURES_LEVERAGE || NaN);
  const lev = Number.isFinite(manualLev)
    ? clamp(manualLev, 1, 100)
    : decideFuturesLeverageScript({
        prob: gateProb,
        atrPct: 0.008,
        regime: regimeType,
      });
  log.info("Step FUT-BUY: leverage", lev);

  const plan = await riskPlan({
    exchange: futuresEx,
    side: "BUY",
    entryPrice: last.close,
    confidence: gateProb,
    riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.01),
    atr: indicators.latest?.atr_14,
    futuresLeverage: lev,
    stats: { trades: 0, wins: 0, pnl: 0 },
    regime: regimeType,
    aiConfidence: gateProb,
  });
  if (!plan.ok) {
    log.warn("Step FUT-BUY: riskPlan failed", plan.reason);
    return;
  }
  log.info("Step FUT-BUY: riskPlan", { qty: plan.qty, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit });

  if (dryRun) {
    log.info("DRY-RUN: would futures.placeOrder BUY", {
      symbol,
      qty: plan.qty,
      price: last.close,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      leverage: lev,
    });
    return;
  }
  const order = await futuresEx.placeOrder({
    symbol,
    side: "BUY",
    qty: plan.qty,
    price: last.close,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    strategy: "SUPERTREND_SCRIPT",
    meta: { supertrend: true, futuresLeverage: lev, leverage: lev },
  });
  log.info("Step FUT-BUY: placeOrder OK", order);
}

async function runFuturesSell({ ex, symbol, dryRun }) {
  const positions = await ex.getPositions().catch(() => []);
  const symU = String(symbol).toUpperCase();
  const long = (positions || []).find((p) => {
    if (String(p.symbol).toUpperCase() !== symU || p.side !== "BUY") return false;
    return !p.venue || p.venue === "FUTURES";
  });
  if (!long) {
    log.warn("FUTURES SELL: no long — same as bot skip.");
    return;
  }
  const id = long.id || long.symbol;
  log.info("Step FUT-SELL: closePosition", { id });

  if (dryRun) {
    log.info("DRY-RUN: would closePosition", { id });
    return;
  }
  let r;
  if (typeof ex.closePosition === "function") r = await ex.closePosition({ id });
  else if (ex.futures && typeof ex.futures.closePosition === "function") r = await ex.futures.closePosition({ id });
  else {
    log.warn("No closePosition on exchange.");
    return;
  }
  log.info("Step FUT-SELL: result", r);
}

function supertrendOptsFromEnv() {
  const period = Math.max(
    2,
    Math.floor(
      Number(
        process.env.SUPERTREND_PERIOD ??
          process.env.SUPERTREND_PERIOD_SCRIPT ??
          10,
      ),
    ),
  );
  const multiplier = Number(
    process.env.SUPERTREND_MULTIPLIER ?? process.env.SUPERTREND_MULTIPLIER_SCRIPT ?? 3,
  );
  const wilderAtr =
    String(process.env.SUPERTREND_WILDER_ATR ?? process.env.SUPERTREND_WILDER_SCRIPT ?? "1") !== "0";
  return { period, multiplier, wilderAtr, stOpts: { period, multiplier, wilderAtr } };
}

/** @param {(r: { ready?: boolean, buySignal?: boolean }) => boolean} predicate */
function findLastSignalSlice(candles, series, predicate) {
  for (let i = series.length - 1; i >= 0; i--) {
    const r = series[i];
    if (!r?.ready) continue;
    if (predicate(r)) return { idx: i, row: r, workCandles: candles.slice(0, i + 1) };
  }
  return null;
}

async function runMimicBothFlow(args, ex) {
  const { period, multiplier, wilderAtr, stOpts } = supertrendOptsFromEnv();
  const mimicDry = args.dryRun || !args.mimicExecute;
  const venues = args.venue === "both" ? ["spot", "futures"] : [args.venue];

  log.info("MIMIC-BOTH dryRun=", mimicDry, mimicDry ? "(add --execute for real demo orders)" : "");
  console.log(`
================================================================================
MIMIC: Supertrend BUY vs SELL (same rules as backend/src/state/bot.js)
--------------------------------------------------------------------------------
• BUY signal  — on bar close, trend flips to bullish → open long
                SPOT: getAccount → size → spotBracketFromAtr → placeOrder MARKET BUY
                FUTURES: AI prob (or fallback) → leverage → riskPlan → placeOrder MARKET BUY
• SELL signal — on bar close, trend flips to bearish → exit long
                SPOT: placeOrder MARKET SELL for tracked spot qty (needs an open long)
                FUTURES: closePosition (reduce-only style close of long; needs an open long)
SELL paths skip if there is no position — same as production.
================================================================================
`);

  for (const venue of venues) {
    const variant = venue === "futures" ? "futures" : "spot";
    const candles = await fetchKlines(args.symbol, args.timeframe, variant);
    const series = computeSupertrendSeries(candles, stOpts);
    const buyHit = findLastSignalSlice(candles, series, (r) => r.buySignal);
    const sellHit = findLastSignalSlice(candles, series, (r) => r.sellSignal);

    console.log(`\n────────── Venue: ${venue.toUpperCase()} (${candles.length} bars, period=${period} mult=${multiplier} wilder=${wilderAtr}) ──────────`);

    console.log(
      `\n▶ [${venue}] BUY path — Supertrend buySignal (bearish → bullish) on replay bar; bot calls trySupertrend*Order(BUY).`,
    );
    if (!buyHit) {
      log.warn("No buySignal in this klines window — cannot replay BUY from indicator.");
    } else {
      log.info("Replay: last buySignal bar", {
        ts: buyHit.row.ts,
        trend: buyHit.row.trend,
        barsAgo: candles.length - 1 - buyHit.idx,
      });
      if (venue === "spot") {
        await runSpotBuy({
          ex,
          symbol: args.symbol,
          candles: buyHit.workCandles,
          dryRun: mimicDry,
        });
      } else {
        await runFuturesBuy({
          ex,
          symbol: args.symbol,
          timeframe: args.timeframe,
          candles: buyHit.workCandles,
          dryRun: mimicDry,
        });
      }
    }

    console.log(
      `\n▶ [${venue}] SELL path — Supertrend sellSignal (bullish → bearish); bot calls trySupertrend*Order(SELL) / close long.`,
    );
    if (!sellHit) {
      log.warn("No sellSignal in this klines window — cannot replay SELL from indicator.");
    } else {
      log.info("Replay: last sellSignal bar (spot uses this bar’s close for brackets; futures close uses live positions)", {
        ts: sellHit.row.ts,
        trend: sellHit.row.trend,
        barsAgo: candles.length - 1 - sellHit.idx,
      });
      if (venue === "spot") {
        await runSpotSell({
          ex,
          symbol: args.symbol,
          candles: sellHit.workCandles,
          dryRun: mimicDry,
        });
      } else {
        await runFuturesSell({ ex, symbol: args.symbol, dryRun: mimicDry });
      }
    }
  }

  log.info("MIMIC-BOTH finished.");
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`
supertrend-indicator-flow-demo.mjs — see file header for full indicator→order FLOW.

Binance Spot Demo API: TRADING_MODE=BINANCE_DEMO_API + BINANCE_DEMO_API_KEY / SECRET.

Usage:
  node scripts/supertrend-indicator-flow-demo.mjs --venue spot|futures [--last-signal] [--side BUY|SELL] [--dry-run]

  --mimic-both --venue spot|futures|both   Walk BUY then SELL indicator→order paths (dry-run unless --execute)
  --mimic-both --venue both --execute      Live demo orders for all four blocks (spot buy/sell + fut buy/sell)

  Default single run: only trades if latest bar has buySignal/sellSignal (same as bot).
  --last-signal: replay most recent flip in the 200-bar window.

Loads backend/.env. Env: SCRIPT_FUTURES_LEVERAGE, SUPERTREND_* (see file header).
`);
    process.exit(0);
  }

  if (args.mimicBoth) {
    if (!args.venue || !["spot", "futures", "both"].includes(args.venue)) {
      console.error("--mimic-both requires --venue spot|futures|both");
      process.exit(1);
    }
    if (args.lastSignal || args.skipIndicator || args.side) {
      console.error("--mimic-both cannot be combined with --last-signal, --skip-indicator, or --side");
      process.exit(1);
    }
    const mode = process.env.TRADING_MODE || "PAPER";
    log.info("TRADING_MODE=", mode, "mimic-both venue=", args.venue);
    const ex = await createExchange({ mode, log });
    log.info("Exchange:", ex.name, ex.storeInfo || {});
    await runMimicBothFlow(args, ex);
    return;
  }

  if (!args.venue || !["spot", "futures"].includes(args.venue)) {
    console.error("Required: --venue spot|futures (or use --mimic-both --venue both)");
    process.exit(1);
  }

  const mode = process.env.TRADING_MODE || "PAPER";
  log.info("TRADING_MODE=", mode, "venue=", args.venue, "dryRun=", args.dryRun);

  const ex = await createExchange({ mode, log });
  log.info("Exchange:", ex.name, ex.storeInfo || {});

  const variant = args.venue === "futures" ? "futures" : "spot";
  const candles = await fetchKlines(args.symbol, args.timeframe, variant);
  log.info("Fetched klines:", candles.length, "bars");

  const { period, multiplier, wilderAtr, stOpts } = supertrendOptsFromEnv();
  let workCandles = candles;
  let side = args.side;
  let signalMeta = null;

  if (args.skipIndicator) {
    if (!side || !["BUY", "SELL"].includes(side)) {
      console.error("--skip-indicator requires --side BUY or --side SELL");
      process.exit(1);
    }
    log.warn("skip-indicator: executing --side without Supertrend (not how the live bot runs).");
  } else if (side) {
    log.warn("Forced --side", side, "— live bot only trades on Supertrend buy/sellSignal at bar close.");
  } else {
    const series = computeSupertrendSeries(candles, stOpts);
    if (args.lastSignal) {
      let idx = -1;
      let row = null;
      for (let i = series.length - 1; i >= 0; i--) {
        const r = series[i];
        if (!r?.ready) continue;
        if (r.buySignal || r.sellSignal) {
          idx = i;
          row = r;
          break;
        }
      }
      if (idx < 0 || !row) {
        log.info("No Supertrend buy/sell signal in this klines window — nothing to replay.");
        log.info("Tip: try a longer timeframe, another symbol, or wait and run without --last-signal when a bar closes with a flip.");
        process.exit(0);
      }
      workCandles = candles.slice(0, idx + 1);
      side = row.buySignal ? "BUY" : "SELL";
      signalMeta = { mode: "last-signal", signalTs: row.ts, trend: row.trend };
      log.info("Replaying last signal in window:", {
        signalTs: row.ts,
        side,
        trend: row.trend,
        barsAgo: candles.length - 1 - idx,
      });
    } else {
      const lastRow = series[series.length - 1];
      log.info("Latest closed bar Supertrend (must match bot / chart settings):", {
        period,
        multiplier,
        wilderAtr,
        ts: lastRow?.ts,
        ready: lastRow?.ready,
        trend: lastRow?.trend,
        buySignal: lastRow?.buySignal,
        sellSignal: lastRow?.sellSignal,
      });
      if (lastRow?.buySignal) side = "BUY";
      else if (lastRow?.sellSignal) side = "SELL";
      else {
        log.info(
          "No buySignal/sellSignal on the latest bar — the live bot would NOT place an order here.",
        );
        log.info(
          "Use --last-signal to test execution on the most recent flip in this 200-bar window, or --side BUY|SELL to force a connector test.",
        );
        process.exit(0);
      }
      signalMeta = { mode: "latest-bar", signalTs: lastRow.ts, trend: lastRow.trend };
    }
  }

  if (!side) {
    log.warn("No side resolved — abort.");
    process.exit(1);
  }

  log.info("=== Supertrend signal → order (mimics bot) ===", { venue: args.venue, side, ...signalMeta });

  if (args.venue === "spot") {
    if (side === "BUY") await runSpotBuy({ ex, symbol: args.symbol, candles: workCandles, dryRun: args.dryRun });
    else await runSpotSell({ ex, symbol: args.symbol, candles: workCandles, dryRun: args.dryRun });
  } else if (side === "BUY") {
    await runFuturesBuy({
      ex,
      symbol: args.symbol,
      timeframe: args.timeframe,
      candles: workCandles,
      dryRun: args.dryRun,
    });
  } else {
    await runFuturesSell({ ex, symbol: args.symbol, dryRun: args.dryRun });
  }

  log.info("Done. If you expected a fill, check TRADING_MODE, venue (spot vs futures), and open orders on the matching Binance UI (demo spot vs demo-fapi).");
}

main().catch((e) => {
  console.error(e?.response?.data || e?.message || e);
  process.exit(1);
});
