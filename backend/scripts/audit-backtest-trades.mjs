#!/usr/bin/env node
/**
 * Production trade audit: verify each trade's fill times/prices vs OHLC + 1m mark trailing replay.
 * Usage: node scripts/audit-backtest-trades.mjs <runId> [maxTrades]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runId = process.argv[2] || "e5a6f1d4-a58e-4241-bf1e-85d449cdaeac";
const maxTrades = Number(process.argv[3] || 0) || Infinity;

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { query } = await import("../src/db/query.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readMicroTrailBars } = await import("../src/backtest/data/markPriceIngest.js");
const { resolveEntryFillTs, resolveExitFillTs } = await import("../src/backtest/engine/runner.js");
const { applySlippage, resolveCostModel } = await import("../src/backtest/engine/costModel.js");
const { replayTradeTrailingMicro, computeTrailReplayStartMs } = await import(
  "../src/backtest/engine/trailTickReplay.js"
);
const { buildSupertrendSeries } = await import("../src/backtest/engine/signals/supertrend.js");
const { tfToMs } = await import("../src/backtest/data/timeframe.js");

function toIST(ms) {
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function inRange(px, bar, pad = 1) {
  if (!bar || !Number.isFinite(px)) return false;
  const lo = Math.min(bar.low, bar.high) - pad;
  const hi = Math.max(bar.low, bar.high) + pad;
  return px >= lo && px <= hi;
}

function pickBotCfg(snapshot, fallback) {
  if (snapshot?.bot && typeof snapshot.bot === "object") return { ...snapshot.bot };
  if (snapshot && typeof snapshot === "object" && !snapshot.bot) return { ...snapshot };
  const fb = fallback?.bot && typeof fallback.bot === "object" ? fallback.bot : fallback;
  return fb && typeof fb === "object" ? { ...fb } : {};
}

function inferEntrySameBar(trade, engineType) {
  const sc = trade.signal_context ?? {};
  if (sc.entrySameBar === true) return true;
  if (sc.entrySameBar === false) return false;
  const et = String(engineType ?? "").toUpperCase();
  return et === "SUPERTREND_ELITE" || et === "UNIFIED_ELITE";
}

function resolveEntryFillMs(trade, tf, engineType) {
  const sc = trade.signal_context ?? {};
  if (sc.entryFillTs != null && Number.isFinite(Number(sc.entryFillTs))) return Number(sc.entryFillTs);
  const barMs = new Date(trade.entry_time).getTime();
  const tfMs = tfToMs(tf);
  return resolveEntryFillTs(barMs, tfMs, inferEntrySameBar(trade, engineType));
}

function resolveExitFillMs(trade, tf) {
  const sc = trade.signal_context ?? {};
  if (sc.exitFillTs != null && Number.isFinite(Number(sc.exitFillTs))) return Number(sc.exitFillTs);
  const barMs = new Date(trade.exit_time).getTime();
  return resolveExitFillTs(barMs, tfToMs(tf), trade.exit_reason);
}

function barContaining(candles, ms, tfMs) {
  let best = candles[0];
  for (const c of candles) {
    if (c.ts <= ms) best = c;
    else break;
  }
  if (!best) return null;
  if (ms >= best.ts + tfMs && candles.length) {
    const next = candles.find((c) => c.ts === best.ts + tfMs);
    if (next && ms >= next.ts) return next;
  }
  return best;
}

const runRow = (
  await query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
       FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      WHERE br.id = $1`,
    [runId],
  )
).rows[0];
if (!runRow) {
  console.error("run not found:", runId);
  process.exit(1);
}

const symbol = String(runRow.symbol);
const tf = String(runRow.timeframe);
const tfMs = tfToMs(tf);
const fromMs = new Date(runRow.start_date).getTime();
const toMs = new Date(runRow.end_date).getTime();
let cfg = pickBotCfg(runRow.config_snapshot, runRow.strategy_cfg_raw);
const cm = resolveCostModel(cfg, runRow.cost_model ?? {});

const trades = (
  await query(
    `SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  )
).rows.slice(0, maxTrades);

const parentCandles = await readCandles(symbol, tf, fromMs, toMs);
const stSeries = buildSupertrendSeries(parentCandles, cfg);
const markBars = await readMicroTrailBars(symbol, fromMs, toMs, { priceSource: "mark" });

const results = [];
let failCount = 0;

for (const t of trades) {
  const entryBarMs = new Date(t.entry_time).getTime();
  const exitBarMs = new Date(t.exit_time).getTime();
  const entryFillMs = resolveEntryFillMs(t, tf, runRow.engine_type);
  const exitFillMs = resolveExitFillMs(t, tf);
  const entryPx = Number(t.entry_price);
  const exitPx = Number(t.exit_price);
  const rawEntryClose = Number(parentCandles.find((c) => c.ts === entryBarMs)?.close);
  const expectedEntry =
    inferEntrySameBar(t, runRow.engine_type) && Number.isFinite(rawEntryClose)
      ? applySlippage(String(t.direction), rawEntryClose, cm.slippagePct)
      : null;

  const m1From = entryBarMs - 3600000;
  const m1To = exitBarMs + 2 * tfMs;
  const m1Trade = await readCandles(symbol, "1m", m1From, m1To);
  const m1Mark = markBars.filter((b) => b.ts >= m1From && b.ts < m1To);

  const entry1mTrade = barContaining(m1Trade, entryFillMs, 60_000);
  const entry1mMark = barContaining(m1Mark, entryFillMs, 60_000);
  const exit1mTrade = barContaining(m1Trade, exitFillMs, 60_000);
  const exit1mMark = barContaining(m1Mark, exitFillMs, 60_000);

  const entryParent = parentCandles.find((c) => c.ts === entryBarMs);
  const exitParent = parentCandles.find((c) => c.ts === exitBarMs);

  const entryPriceOk1h = inRange(entryPx, entryParent, 0.01);
  const exitPriceOk1h = inRange(exitPx, exitParent, 0.01);
  const entryPriceOk1mTrade = inRange(entryPx, entry1mTrade, 0.01);
  const entryPriceOk1mMark = inRange(entryPx, entry1mMark, 0.01);
  const exitPriceOk1mTrade = inRange(exitPx, exit1mTrade, 0.01);
  const exitPriceOk1mMark = inRange(exitPx, exit1mMark, 0.01);
  const entrySlippageOk =
    expectedEntry != null && Math.abs(entryPx - expectedEntry) < Math.max(0.01, entryPx * 1e-6);

  let trailReplay = null;
  const sc = t.signal_context ?? {};
  if (String(t.exit_reason).toLowerCase() === "trail") {
    trailReplay = replayTradeTrailingMicro({
      trade: {
        direction: t.direction,
        entryPrice: entryPx,
        qty: t.quantity,
        entryTs: t.entry_time,
        exitTs: t.exit_time,
        exitReason: t.exit_reason,
        slPrice: t.sl_price,
        initialSlPrice: sc.initialSlPrice,
        trailReplayStartMs: computeTrailReplayStartMs(entryBarMs, tfMs),
      },
      cfg,
      costModel: runRow.cost_model,
      markBars: m1Mark,
      parentCandles,
      stSeries,
      tfMs,
    });
  }

  const trailOk =
    !trailReplay ||
    trailReplay.replaySkipped ||
    (trailReplay.exitReason === "trail" &&
      String(trailReplay.trailTierLabel) === String(sc.trailTierLabel ?? t.signal_context?.trailTierLabel) &&
      Math.abs(Number(trailReplay.exitPrice) - exitPx) < Math.max(1, exitPx * 0.002));

  const issues = [];
  if (!entrySlippageOk && expectedEntry != null) {
    issues.push(`entry price ${entryPx} != expected close+slippage ${expectedEntry.toFixed(2)}`);
  }
  if (!entryPriceOk1mTrade && entrySlippageOk) {
    issues.push(
      `entry ${entryPx.toFixed(2)} not in 1m trade bar at fill (${toIST(entryFillMs)}); bar H=${entry1mTrade?.high} — slippage-adjusted fill above 1m high is expected for same-bar close entries`,
    );
  }
  if (!exitPriceOk1h) issues.push(`exit price ${exitPx} outside 1h exit bar OHLC`);
  if (trailReplay && !trailReplay.replaySkipped && !trailOk) {
    issues.push(
      `trail replay mismatch tier ${trailReplay.trailTierLabel} vs stored ${t.signal_context?.trailTierLabel}, exit ${trailReplay.exitPrice?.toFixed(2)} vs ${exitPx}`,
    );
  }

  const row = {
    tradeNumber: t.trade_number,
    direction: t.direction,
    entryBarIST: toIST(entryBarMs),
    entryFillIST: toIST(entryFillMs),
    exitBarIST: toIST(exitBarMs),
    exitFillIST: toIST(exitFillMs),
    minutesBetweenFillTimes: Math.round((exitFillMs - entryFillMs) / 60000),
    barsHeld: t.bars_held,
    entryPrice: entryPx,
    expectedEntryFromBarClose: expectedEntry,
    exitPrice: exitPx,
    exitReason: t.exit_reason,
    tier: t.signal_context?.trailTierLabel,
    entryOk1h: entryPriceOk1h,
    entryOk1mAtFill: entryPriceOk1mTrade,
    exitOk1h: exitPriceOk1h,
    exitOk1mAtFill: exitPriceOk1mTrade,
    trailReplayOk: trailOk,
    issues,
  };
  if (issues.some((x) => !x.includes("slippage-adjusted"))) failCount++;
  results.push(row);
}

console.log(
  JSON.stringify(
    {
      runId,
      symbol,
      tf,
      tradesAudited: results.length,
      hardFails: failCount,
      trade2: results.find((r) => r.tradeNumber === 2),
      summary: results.map((r) => ({
        n: r.tradeNumber,
        issues: r.issues.length,
        trailOk: r.trailReplayOk,
        entryFillIST: r.entryFillIST,
        exitFillIST: r.exitFillIST,
        mins: r.minutesBetweenFillTimes,
      })),
    },
    null,
    2,
  ),
);

await closePool();
process.exit(failCount > 0 ? 1 : 0);
