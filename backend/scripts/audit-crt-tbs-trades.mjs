#!/usr/bin/env node
/**
 * Per-trade CRT+TBS rule audit for a backtest run.
 * Usage: node scripts/audit-crt-tbs-trades.mjs [runIdPrefix]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const RUN_PREFIX = process.argv[2] || "";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const runQ = RUN_PREFIX
  ? await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [`${RUN_PREFIX}%`])
  : await pool.query(`SELECT * FROM backtest_runs WHERE status='done' ORDER BY created_at DESC LIMIT 1`);
const run = runQ.rows[0];
if (!run) {
  console.error("No run found");
  process.exit(1);
}

const cfg = pickBot(run.config_snapshot);
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { crtTbsPadFromMs, optsFromCrtTbsCfg } = await import("../src/strategy/crtTbsIntraday.js");
const {
  buildCrtContext,
  isTurtleBodySoup,
  buildCrtBrackets,
  buildCrtTbsSeries,
  CRT_TBS_WARMUP,
} = await import("../src/strategy/techniques/crtTbs.js");
const { sweepReclaim, rejectionWickRatio } = await import("../src/strategy/techniques/liquidity.js");
const { inSmcKillzone, utcHourFromTs } = await import("../src/strategy/techniques/sessionKillzones.js");
const { detectChochInRange } = await import("../src/strategy/techniques/bosChoch.js");

const candles = await readCandles(run.symbol, run.timeframe, crtTbsPadFromMs(fromMs, run.timeframe), toMs, {
  market: "futures",
});
const opts = optsFromCrtTbsCfg(cfg);
const pre = precomputeIntraday(candles);
const ctx = buildCrtContext(candles, opts);
const { series } = buildCrtTbsSeries(candles, { ...opts, pre });

const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));

function fmtTs(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function barStr(b) {
  if (!b) return "n/a";
  const body = Math.abs(b.close - b.open);
  const range = b.high - b.low;
  const wickL = rejectionWickRatio(b, "BUY");
  const wickS = rejectionWickRatio(b, "SELL");
  return `O=${b.open.toFixed(2)} H=${b.high.toFixed(2)} L=${b.low.toFixed(2)} C=${b.close.toFixed(2)} body=${(body / Math.max(range, 1e-9)).toFixed(2)} wickL=${wickL.toFixed(2)} wickS=${wickS.toFixed(2)}`;
}

function crtRangeOk(hi, lo, atr, close) {
  const range = hi - lo;
  if (!(range > 0)) return { ok: false, reason: "invalid_range" };
  const minPct = opts.minCrtRangePct ?? 0.0025;
  const pct = range / close;
  if (pct < minPct) return { ok: false, reason: `range_pct ${(pct * 100).toFixed(3)}% < ${(minPct * 100).toFixed(3)}%` };
  if (Number.isFinite(atr) && atr > 0) {
    const minAtr = opts.minCrtRangeAtr ?? 0.4;
    const ratio = range / atr;
    if (ratio < minAtr) return { ok: false, reason: `range_atr ${ratio.toFixed(2)} < ${minAtr}` };
  }
  return { ok: true, range, pct };
}

function findTbsBar(entryIdx, side, crtLo, crtHi) {
  const level = side === "BUY" ? crtLo : crtHi;
  const chochMax = Math.max(1, Number(opts.chochMaxBars ?? 8));
  for (let j = entryIdx; j >= Math.max(CRT_TBS_WARMUP, entryIdx - chochMax); j--) {
    const b = candles[j];
    if (isTurtleBodySoup(b, level, side, opts)) {
      const swept = sweepReclaim(b, level, side, opts.sweepPct);
      const kz = inSmcKillzone(b.ts, opts);
      const eq = (crtHi + crtLo) / 2;
      const pd = side === "BUY" ? b.close <= eq : b.close >= eq;
      return { idx: j, bar: b, swept, kz, pd, level };
    }
  }
  return null;
}

const tradesQ = await pool.query(
  `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price, net_pnl, exit_reason, signal_context
   FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`,
  [run.id],
);

// Group by unique entry (partial TP creates 2 rows per logical trade)
const byEntry = new Map();
for (const t of tradesQ.rows) {
  const key = new Date(t.entry_time).getTime();
  if (!byEntry.has(key)) {
    byEntry.set(key, { ...t, legs: [] });
  }
  byEntry.get(key).legs.push({
    trade_number: t.trade_number,
    exit_reason: t.exit_reason,
    net_pnl: Number(t.net_pnl),
    exit_time: t.exit_time,
  });
}

const uniqueTrades = [...byEntry.values()].sort(
  (a, b) => new Date(a.entry_time) - new Date(b.entry_time),
);

console.log(`\n${"=".repeat(72)}`);
console.log(`CRT+TBS TRADE-BY-TRADE AUDIT`);
console.log(`Run: ${run.id} | ${run.symbol} ${run.timeframe} | ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
console.log(`Strategy: ${cfg.manualStrategy} | crtTradeSides=${cfg.crtTradeSides} | risk=${cfg.riskPerTrade}%`);
console.log(`Logical entries: ${uniqueTrades.length} (${tradesQ.rows.length} DB rows incl. partial legs)`);
console.log(`${"=".repeat(72)}\n`);

const summary = { valid: 0, questionable: 0, invalid: 0 };

for (let n = 0; n < uniqueTrades.length; n++) {
  const t = uniqueTrades[n];
  const entryTs = new Date(t.entry_time).getTime();
  const entryIdx = tsToIdx.get(entryTs);
  const side = t.direction === "BUY" || t.direction === "long" ? "BUY" : "SELL";
  const sc = t.signal_context || {};
  const liq = sc.liq || {};
  const trigger = (sc.entryReason || "").replace("crt_tbs_", "");

  const issues = [];
  const passes = [];

  console.log(`\n${"─".repeat(72)}`);
  console.log(`TRADE ${n + 1} — ${fmtTs(entryTs)} UTC | ${side} | trigger: ${trigger}`);
  console.log(`DB rows: ${t.legs.map((l) => `#${l.trade_number} ${l.exit_reason} $${l.net_pnl.toFixed(2)}`).join(" | ")}`);
  console.log(`Net PnL (all legs): $${t.legs.reduce((s, l) => s + l.net_pnl, 0).toFixed(2)}`);

  if (entryIdx == null) {
    issues.push("ENTRY_BAR_NOT_FOUND in candle series");
    console.log("  ✗ Cannot find entry bar in loaded candles");
    summary.invalid++;
    continue;
  }

  const entryBar = candles[entryIdx];
  const hi = ctx.crtHigh[entryIdx];
  const lo = ctx.crtLow[entryIdx];
  const eq = ctx.crtEq[entryIdx];
  const crtRefTs = ctx.crtTs[entryIdx];
  const atr = pre.atrSeries?.[entryIdx];

  console.log(`\n  Chart @ entry bar [idx ${entryIdx}]:`);
  console.log(`    ${barStr(entryBar)}`);
  console.log(`  CRT reference (prior 4H): ${crtRefTs ? fmtTs(crtRefTs) : "?"} | H=${hi?.toFixed(2)} L=${lo?.toFixed(2)} EQ=${eq?.toFixed(2)}`);
  console.log(`  Signal context: sweepWick=${liq.sweepWick} level=${liq.level} opposing=${liq.opposingLevel}`);

  // Rule 1: LONG-only preset
  if (String(opts.tradeSides).toUpperCase() === "LONG" && side !== "BUY") {
    issues.push("SHORT blocked by crtTradeSides=LONG preset");
  } else {
    passes.push(`tradeSides=${opts.tradeSides} allows ${side}`);
  }

  // Rule 2: Engine signal at entry bar
  const engineSig = series[entryIdx];
  if (!engineSig) {
    issues.push("NO_ENGINE_SIGNAL at entry bar (series[idx] is null)");
  } else if (engineSig.action !== side) {
    issues.push(`ENGINE_SIDE_MISMATCH: engine=${engineSig.action} trade=${side}`);
  } else {
    passes.push(`engine fired ${engineSig.trigger} on entry bar`);
  }

  // Rule 3: CRT range size
  const rangeChk = crtRangeOk(hi, lo, atr, entryBar.close);
  if (!rangeChk.ok) issues.push(`CRT_RANGE_FAIL: ${rangeChk.reason}`);
  else passes.push(`CRT range OK (${((rangeChk.range / entryBar.close) * 100).toFixed(2)}% of price, ATR=${atr?.toFixed(2)})`);

  // Rule 4: Find TBS bar (manipulation)
  const tbs = findTbsBar(entryIdx, side, lo, hi);
  if (!tbs) {
    issues.push(`NO_TBS within ${opts.chochMaxBars ?? 8} bars before entry at CRT ${side === "BUY" ? "low" : "high"} ${side === "BUY" ? lo?.toFixed(2) : hi?.toFixed(2)}`);
  } else {
    const barsAfter = entryIdx - tbs.idx;
    console.log(`\n  TBS bar [idx ${tbs.idx}] (${barsAfter} bars before entry) ${fmtTs(tbs.bar.ts)}:`);
    console.log(`    ${barStr(tbs.bar)}`);
    console.log(`    swept CRT ${side === "BUY" ? "low" : "high"} @ ${tbs.level.toFixed(2)}: ${tbs.swept}`);
    console.log(`    killzone on TBS bar (UTC h${utcHourFromTs(tbs.bar.ts)}): ${tbs.kz}`);
    console.log(`    premium/discount (close ${tbs.bar.close.toFixed(2)} vs EQ ${eq.toFixed(2)}): ${tbs.pd ? "OK" : "FAIL"}`);

    if (!tbs.swept) issues.push("TBS bar did not sweep-reclaim CRT level");
    else passes.push("TBS sweep+reclaim at CRT extreme");

    if (opts.killzoneOnTbsBar !== false && !tbs.kz) {
      issues.push(`KILLZONE_FAIL on TBS bar (hour ${utcHourFromTs(tbs.bar.ts)} UTC, mode ${opts.intradaySmcKillzoneMode})`);
    } else if (opts.killzoneOnTbsBar !== false) {
      passes.push(`killzone OK on TBS bar (h${utcHourFromTs(tbs.bar.ts)} UTC)`);
    }

    if (opts.premiumDiscountFilter !== false && !tbs.pd) {
      issues.push(`PREMIUM_DISCOUNT_FAIL on TBS bar: ${side} needs close ${side === "BUY" ? "<=" : ">="} EQ`);
    } else if (opts.premiumDiscountFilter !== false) {
      passes.push("premium/discount OK on TBS bar");
    }

    const wick = rejectionWickRatio(tbs.bar, side);
    const bodyRatio = Math.abs(tbs.bar.close - tbs.bar.open) / Math.max(1e-12, tbs.bar.high - tbs.bar.low);
    if (wick < (opts.minTbsWick ?? 0.32)) issues.push(`WICK_RATIO_LOW: ${wick.toFixed(2)} < ${opts.minTbsWick}`);
    else passes.push(`wick ratio ${wick.toFixed(2)} >= ${opts.minTbsWick}`);
    if (bodyRatio < (opts.minBodyRatio ?? 0.25)) issues.push(`BODY_RATIO_LOW: ${bodyRatio.toFixed(2)}`);
    else passes.push(`body ratio ${bodyRatio.toFixed(2)} >= ${opts.minBodyRatio}`);

    // Rule 5: CHoCH between TBS and entry
    if (opts.requireChoch !== false) {
      const choch = detectChochInRange(candles, tbs.idx, entryIdx, side, opts);
      console.log(`    CHoCH ${tbs.idx}→${entryIdx}: ${choch.ok ? "YES" : "NO"}${choch.type ? ` (${choch.type})` : ""}`);
      if (!choch.ok) issues.push("CHoCH_NOT_CONFIRMED between TBS and entry");
      else passes.push(`CHoCH confirmed (${choch.type || "structure"}) within ${barsAfter} bars`);
    }

    // Sweep wick match
    const expectedWick = side === "BUY" ? tbs.bar.low : tbs.bar.high;
    if (liq.sweepWick && Math.abs(liq.sweepWick - expectedWick) > 0.02) {
      issues.push(`SWEEP_WICK_MISMATCH: signal=${liq.sweepWick} tbs_bar=${expectedWick.toFixed(2)}`);
    } else {
      passes.push(`sweep wick matches TBS bar (${expectedWick.toFixed(2)})`);
    }
  }

  // Rule 6: Brackets
  if (tbs && Number.isFinite(hi) && Number.isFinite(lo)) {
    const wick = side === "BUY" ? tbs.bar.low : tbs.bar.high;
    const br = buildCrtBrackets(side, entryBar.close, wick, hi, lo, opts);
    if (!br) issues.push("BRACKETS_INVALID at entry");
    else {
      passes.push(`brackets: SL=${br.slPrice.toFixed(2)} TP1=${br.tp1Price.toFixed(2)} TP2=${br.tp2Price.toFixed(2)}`);
      if (liq.level && Math.abs(liq.level - br.level) > 0.05) {
        issues.push(`LEVEL_MISMATCH: signal=${liq.level} computed=${br.level.toFixed(2)}`);
      }
    }
  }

  // ICT textbook quality flags (not hard rules)
  const warnings = [];
  if (rangeChk.ok && rangeChk.pct < 0.003) warnings.push("narrow CRT range (<0.3%) — marginal setup quality");
  if (liq.rr != null && liq.rr < 0.3) warnings.push(`very low R:R to TP2 (${liq.rr.toFixed(2)}) — CRT high nearly at entry`);
  if (trigger === "tbs_crt_low" && entryIdx === tbs?.idx) warnings.push("same-bar entry (no delayed CHoCH) — aggressive");
  if (side === "BUY" && entryBar.close > eq) warnings.push("entry above CRT equilibrium — chasing, not discount entry");

  const verdict =
    issues.length === 0 ? "VALID — all strategy rules satisfied" :
    issues.some((i) => i.includes("NO_ENGINE") || i.includes("NO_TBS") || i.includes("CHoCH_NOT") || i.includes("KILLZONE_FAIL")) ?
      "INVALID — rule violation" :
      "QUESTIONABLE — minor mismatch";

  if (issues.length === 0) summary.valid++;
  else if (verdict.startsWith("INVALID")) summary.invalid++;
  else summary.questionable++;

  console.log(`\n  Rules passed (${passes.length}):`);
  for (const p of passes) console.log(`    ✓ ${p}`);
  if (issues.length) {
    console.log(`  Rule failures (${issues.length}):`);
    for (const i of issues) console.log(`    ✗ ${i}`);
  }
  if (warnings.length) {
    console.log(`  Quality warnings:`);
    for (const w of warnings) console.log(`    ⚠ ${w}`);
  }
  console.log(`\n  VERDICT: ${verdict}`);
}

console.log(`\n${"=".repeat(72)}`);
console.log(`SUMMARY: ${summary.valid} valid | ${summary.questionable} questionable | ${summary.invalid} invalid`);
console.log(`Total logical entries: ${uniqueTrades.length}`);
console.log(`${"=".repeat(72)}\n`);

await closePool();
