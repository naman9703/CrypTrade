#!/usr/bin/env node
/**
 * CRT+TBS funnel audit — why setups were taken or blocked.
 * Usage: FROM=2026-06-01 TO=2026-06-08 node scripts/audit-crt-tbs-window.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-06-01";
const TO = process.env.TO || "2026-06-08";
const PAD_DAYS = Number(process.env.PAD_DAYS || 14);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
import {
  buildCrtContext,
  isTurtleBodySoup,
  isTurtleWickSoup,
  buildCrtBrackets,
  evaluateCrtTbsBar,
  CrtTbsDayState,
  CRT_TBS_DEFAULTS,
} from "../src/strategy/techniques/crtTbs.js";
import { sweepReclaim, rejectionWickRatio } from "../src/strategy/techniques/liquidity.js";
import { inSmcKillzone, utcHourFromTs } from "../src/strategy/techniques/sessionKillzones.js";
import { detectChochInRange, detectMarketChoch } from "../src/strategy/techniques/bosChoch.js";
import { buildCrtTbsBacktestAdapter, optsFromCrtTbsCfg } from "../src/strategy/crtTbsIntraday.js";
import { CRT_TBS_BNB_15M } from "../src/strategy/presets/crtTbsOptimized.js";

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padMs = PAD_DAYS * 86_400_000;
const { crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const candles = await readCandles(SYMBOL, TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });
const pre = precomputeIntraday(candles);
const opts = optsFromCrtTbsCfg({ ...CRT_TBS_BNB_15M, symbol: SYMBOL, timeframe: TF });
const ctx = buildCrtContext(candles, opts);
const WARMUP = 100;

function fmtTs(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function crtRangeOk(hi, lo, atr, close) {
  const range = hi - lo;
  if (!(range > 0)) return { ok: false, reason: "invalid_range" };
  const minPct = opts.minCrtRangePct ?? 0.0035;
  if (range / close < minPct) return { ok: false, reason: `range_pct_${((range / close) * 100).toFixed(2)}%` };
  if (Number.isFinite(atr) && atr > 0) {
    const minAtr = opts.minCrtRangeAtr ?? 0.55;
    const ratio = range / atr;
    if (ratio < minAtr) return { ok: false, reason: `range_atr_${ratio.toFixed(2)}` };
  }
  return { ok: true };
}

function auditBar(i) {
  const bar = candles[i];
  const hi = ctx.crtHigh[i];
  const lo = ctx.crtLow[i];
  const eq = ctx.crtEq[i];
  const atr = pre.atrSeries?.[i];
  const events = [];

  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    return { events: [{ kind: "skip", reason: "no_crt_htf" }] };
  }

  const rangeChk = crtRangeOk(hi, lo, atr, bar.close);
  const inKz = inSmcKillzone(bar.ts, opts);
  const tradeSides = String(opts.tradeSides ?? "BOTH").toUpperCase();
  const pdFilter = opts.premiumDiscountFilter !== false;

  const sides = [];
  if (tradeSides !== "SHORT") sides.push({ side: "BUY", level: lo, label: "CRT_LOW" });
  if (tradeSides !== "LONG") sides.push({ side: "SELL", level: hi, label: "CRT_HIGH" });

  for (const { side, level, label } of sides) {
    const swept = sweepReclaim(bar, level, side, opts.sweepPct);
    if (!swept) continue;

    const wick = rejectionWickRatio(bar, side);
    const bodyRatio = Math.abs(bar.close - bar.open) / Math.max(1e-12, bar.high - bar.low);
    const tbs = isTurtleBodySoup(bar, level, side, opts);
    const tws = isTurtleWickSoup(bar, level, side, opts);
    const choch = detectMarketChoch(candles, i, side, opts);
    const chochRange = detectChochInRange(candles, i, i, side, opts);

    const pdOk = !pdFilter || (side === "BUY" ? bar.close <= eq : bar.close >= eq);
    const br = tbs ? buildCrtBrackets(side, bar.close, side === "BUY" ? bar.low : bar.high, hi, lo, opts) : null;

    let block = null;
    if (!rangeChk.ok) block = `range:${rangeChk.reason}`;
    else if (!inKz) block = `killzone:hour_${utcHourFromTs(bar.ts)}_utc`;
    else if (!pdOk) block = `premium_discount:close_${bar.close.toFixed(2)}_vs_eq_${eq.toFixed(2)}`;
    else if (!tbs) {
      if (tws) block = `tws_only:wick_${wick.toFixed(2)}`;
      else if (wick < (opts.minTbsWick ?? 0.38)) block = `wick_${wick.toFixed(2)}<${opts.minTbsWick}`;
      else if (bodyRatio < (opts.minBodyRatio ?? 0.28)) block = `body_${bodyRatio.toFixed(2)}`;
      else block = "not_tbs";
    } else if (opts.requireChoch && !choch.ok) block = `no_choch_same_bar`;
    else if (!br) block = "bad_brackets";

    events.push({
      kind: block ? "blocked" : "candidate",
      side,
      label,
      level,
      crtHigh: hi,
      crtLow: lo,
      crtEq: eq,
      swept,
      tbs,
      tws,
      wick: wick.toFixed(2),
      bodyRatio: bodyRatio.toFixed(2),
      choch: choch.ok,
      chochType: choch.type,
      inKz,
      pdOk,
      block,
      close: bar.close,
    });
  }

  // Delayed path: TBS on prev bar
  const prev = candles[i - 1];
  if (prev && opts.allowDelayedEntry !== false) {
    for (const { side, level, label } of sides) {
      if (!isTurtleBodySoup(prev, level, side, opts)) continue;
      const choch = detectChochInRange(candles, i - 1, i, side, opts);
      const pdOk = !pdFilter || (side === "BUY" ? bar.close <= eq : bar.close >= eq);
      let block = null;
      if (!rangeChk.ok) block = `range:${rangeChk.reason}`;
      else if (!inKz) block = `killzone:hour_${utcHourFromTs(bar.ts)}_utc`;
      else if (!pdOk) block = `premium_discount`;
      else if (opts.requireChoch && !choch.ok) block = `no_choch_delayed`;
      events.push({
        kind: block ? "blocked_delayed" : "candidate_delayed",
        side,
        label: `${label}_delayed`,
        prevTbs: true,
        choch: choch.ok,
        chochType: choch.type,
        block,
      });
    }
  }

  return { events, rangeChk, inKz, hi, lo, eq };
}

// Funnel counts in window
const funnel = {
  sweepLow: 0,
  sweepHigh: 0,
  tbsLow: 0,
  tbsHigh: 0,
  blocked: {},
  candidates: [],
};

for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  if (bar.ts < fromMs || bar.ts >= toMs) continue;

  const { events } = auditBar(i);
  for (const e of events) {
    if (e.label?.includes("LOW") && e.swept) funnel.sweepLow++;
    if (e.label?.includes("HIGH") && e.swept) funnel.sweepHigh++;
    if (e.tbs && e.side === "BUY") funnel.tbsLow++;
    if (e.tbs && e.side === "SELL") funnel.tbsHigh++;
    if (e.kind === "candidate" || e.kind === "candidate_delayed") {
      funnel.candidates.push({ ts: bar.ts, idx: i, ...e });
    }
    if (e.block) {
      funnel.blocked[e.block] = (funnel.blocked[e.block] || 0) + 1;
    }
  }
}

// Strategy actual signals in window
const adapter = buildCrtTbsBacktestAdapter(candles, { ...CRT_TBS_BNB_15M, symbol: SYMBOL }, TF);
const fired = [];
for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  if (bar.ts < fromMs || bar.ts >= toMs) continue;
  const sig = adapter(bar, i);
  if (sig) fired.push({ ts: bar.ts, idx: i, ...sig });
}

// Backtest trades in window
const sim = await runSimulation({
  candles,
  strategyKey: "CRT_TBS",
  cfg: { ...CRT_TBS_BNB_15M, symbol: SYMBOL },
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: TF,
  adapters: { CRT_TBS: adapter },
  symbol: SYMBOL,
  costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
});
const tradesInWindow = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);

console.log(`\n=== CRT+TBS AUDIT ${SYMBOL} ${TF} ${FROM} → ${TO} ===\n`);
console.log("--- Deployed preset filters ---");
console.log(JSON.stringify({
  crtHtfMs: opts.crtHtfMs,
  crtTradeSides: opts.tradeSides,
  crtRequireChoch: opts.requireChoch,
  crtPremiumDiscountFilter: opts.premiumDiscountFilter,
  crtAllowDelayedEntry: opts.allowDelayedEntry,
  crtMinTbsWick: opts.minTbsWick,
  crtMinRangeAtr: opts.minCrtRangeAtr,
  killzone: opts.intradaySmcKillzoneMode,
}, null, 2));

console.log("\n--- Funnel (bars in window) ---");
console.log(`  CRT low sweeps (any reclaim):  ${funnel.sweepLow}`);
console.log(`  CRT high sweeps:             ${funnel.sweepHigh}`);
console.log(`  TBS at CRT low:              ${funnel.tbsLow}`);
console.log(`  TBS at CRT high:             ${funnel.tbsHigh}`);
console.log(`  Full candidates (passed all): ${funnel.candidates.length}`);
console.log(`  Strategy signals fired:       ${fired.length}`);
console.log(`  Backtest entries:             ${new Set(tradesInWindow.map((t) => t.entryTs + "_" + t.direction)).size}`);

console.log("\n--- Block reasons (count) ---");
for (const [k, v] of Object.entries(funnel.blocked).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

console.log("\n--- All sweep/TBS events in window (chronological) ---");
for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  if (bar.ts < fromMs || bar.ts >= toMs) continue;
  const { events, hi, lo, eq } = auditBar(i);
  const interesting = events.filter((e) => e.swept || e.prevTbs || e.kind?.includes("candidate"));
  if (!interesting.length) continue;
  console.log(`\n  ${fmtTs(bar.ts)} UTC | close=${bar.close.toFixed(2)} | CRT H=${hi?.toFixed(2)} L=${lo?.toFixed(2)} EQ=${eq?.toFixed(2)}`);
  for (const e of interesting) {
    const status = e.kind === "candidate" || e.kind === "candidate_delayed" ? "✓ PASS" : `✗ ${e.block}`;
    console.log(
      `    ${e.side} ${e.label} | ${status}` +
        (e.tbs != null ? ` tbs=${e.tbs} wick=${e.wick} choch=${e.choch}` : ` choch=${e.choch}`),
    );
  }
}

if (funnel.candidates.length) {
  console.log("\n--- Candidates that passed all filters ---");
  for (const c of funnel.candidates) {
    console.log(`  ${fmtTs(c.ts)} ${c.side} ${c.label} close=${c.close?.toFixed(2)}`);
  }
}

if (fired.length) {
  console.log("\n--- Strategy fired ---");
  for (const f of fired) {
    console.log(`  ${fmtTs(f.ts)} ${f.action} ${f.trigger} ${f.reason}`);
  }
} else {
  console.log("\n--- Strategy fired: NONE in this window ---");
}

await closePool();
