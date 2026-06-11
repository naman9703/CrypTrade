#!/usr/bin/env node
/**
 * Per-trade S/R + liquidity marking verification for a finished SR_INTRADAY run.
 *
 * For each trade it:
 *  - pulls the persisted signal_context.liq (what the chart marks)
 *  - re-derives PDH/PDL/PWH/PWL + the liquidity sweep at the entry bar
 *  - checks the marked level / opposing / sweep-wick are internally consistent
 *  - for losses, explains the outcome (MFE/MAE vs 1R, exit reason, where price went)
 *  - scans the whole window for valid sweep setups that were NOT taken
 *
 * Usage: node scripts/audit-sr-run-trades.mjs [runIdPrefix] [symbol] [timeframe]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runArg = process.argv[2];
const symbolArg = process.argv[3];
const tfArg = process.argv[4];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday, selectIntradayPicks } = await import("../src/strategy/intradayPro.js");
const { listSessionLiquiditySetups, dayStartIndex, utcDayId } = await import(
  "../src/strategy/techniques/liquidity.js"
);

function pickBotCfg(snapshot) {
  if (!snapshot) return {};
  if (snapshot.bot && typeof snapshot.bot === "object") return snapshot.bot;
  return snapshot;
}

function findBarIndex(candles, ts) {
  const t = new Date(ts).getTime();
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - t);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return bestDiff <= 15 * 60 * 1000 ? best : -1;
}

function fmt(n, d = 2) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

let runId = runArg;
if (!runId) {
  const where = ["status='done'", "timeframe='15m'"];
  const params = [];
  if (symbolArg) {
    params.push(symbolArg);
    where.push(`symbol=$${params.length}`);
  } else {
    where.push("symbol='BNBUSDT'");
  }
  const q = await pool.query(
    `SELECT id::text FROM backtest_runs WHERE ${where.join(" AND ")} ORDER BY finished_at DESC LIMIT 1`,
    params,
  );
  runId = q.rows[0]?.id;
}

const runQ = await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [
  `${String(runId).slice(0, 8)}%`,
]);
const run = runQ.rows[0];
if (!run) {
  console.error("Run not found");
  process.exit(1);
}
runId = run.id;

const cfg = pickBotCfg(run.config_snapshot);
cfg.symbol = run.symbol;
cfg.timeframe = run.timeframe;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const candles = await readCandles(run.symbol, run.timeframe, fromMs - 7 * 86400000, toMs);
const pre = precomputeIntraday(candles);
const { series } = selectIntradayPicks(candles, cfg);

const { rows: allTrades } = await pool.query(
  `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price,
          sl_price, tp_price, exit_reason, net_pnl, roi_pct, mfe_pct, mae_pct, bars_held,
          signal_context
   FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
  [runId],
);

console.log("=== RUN ===", String(runId).slice(0, 8), run.symbol, run.timeframe);
console.log(
  "window",
  new Date(run.start_date).toISOString().slice(0, 10),
  "→",
  new Date(run.end_date).toISOString().slice(0, 10),
);
console.log("trade rows:", allTrades.length);

// Collapse partial legs into one logical entry.
const entries = new Map();
for (const t of allTrades) {
  const key = `${new Date(t.entry_time).toISOString()}:${t.direction}`;
  if (!entries.has(key)) entries.set(key, { ...t, legs: [] });
  entries.get(key).legs.push(t);
}
for (const e of entries.values()) {
  e.netPnlTotal = e.legs.reduce((s, l) => s + Number(l.net_pnl), 0);
  e.exits = e.legs.map((l) => l.exit_reason).join("+");
  e.mfe = Math.max(...e.legs.map((l) => Number(l.mfe_pct ?? 0)));
  e.mae = Math.min(...e.legs.map((l) => Number(l.mae_pct ?? 0)));
}

const uniq = [...entries.values()].sort((a, b) => a.trade_number - b.trade_number);
const wins = uniq.filter((e) => e.netPnlTotal > 0.01);
const losses = uniq.filter((e) => e.netPnlTotal < -0.01);

console.log(
  `unique entries: ${uniq.length} · wins ${wins.length} · losses ${losses.length} · WR ${((wins.length / uniq.length) * 100).toFixed(1)}%`,
);

function liqFromCtx(ctx) {
  if (!ctx) return null;
  if (ctx.liq) return ctx.liq;
  return null;
}

/** Re-derive the best liquidity setup whose reclaim is the entry bar. */
function deriveAtEntry(idx, side) {
  const setups = listSessionLiquiditySetups(candles, idx, side, pre, cfg);
  const atBar = setups.filter((s) => s.reclaimIdx === idx);
  if (!atBar.length) return null;
  return atBar.sort((a, b) => b.liqQuality - a.liqQuality)[0];
}

function markingCheck(stored, derived, side, idx) {
  const issues = [];
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];
  // Stored level should equal the side's session level (pdl for BUY, pdh for SELL) OR a cluster level.
  if (stored?.level > 0) {
    const expectSession = side === "BUY" ? pdl : pdh;
    const matchesSession = expectSession > 0 && Math.abs(stored.level - expectSession) / expectSession < 0.0005;
    const matchesDerived = derived && Math.abs(stored.level - derived.level) / derived.level < 0.0005;
    if (!matchesSession && !matchesDerived) {
      issues.push(`level ${fmt(stored.level)} != pdh/pdl(${fmt(expectSession)}) & != derived(${derived ? fmt(derived.level) : "—"})`);
    }
    // sweep wick must be beyond the level in the sweep direction
    if (stored.sweepWick > 0) {
      const beyond = side === "BUY" ? stored.sweepWick < stored.level : stored.sweepWick > stored.level;
      if (!beyond) issues.push(`wick ${fmt(stored.sweepWick)} not beyond level ${fmt(stored.level)} for ${side}`);
    }
    // opposing must be on the profit side
    if (stored.opposingLevel > 0) {
      const ok = side === "BUY" ? stored.opposingLevel > stored.level : stored.opposingLevel < stored.level;
      if (!ok) issues.push(`opposing ${fmt(stored.opposingLevel)} on wrong side of level`);
    }
  } else {
    issues.push("no stored level (chart can't mark S/R)");
  }
  return issues;
}

console.log("\n=== PER-TRADE VERIFICATION ===");
const header =
  "#  side  entry(UTC)        pnl     exit            lvlType  level     opposing  wick      mfe%   mae%   derived  marking";
console.log(header);

let derivedMatch = 0;
let noStored = 0;
let markingIssues = 0;
const lossRows = [];

for (const e of uniq) {
  const idx = findBarIndex(candles, e.entry_time);
  const side = e.direction;
  const ctx = e.signal_context;
  const stored = liqFromCtx(ctx);
  const derived = idx >= 0 ? deriveAtEntry(idx, side) : null;
  if (derived && stored && Math.abs((stored.level ?? 0) - derived.level) / derived.level < 0.0005) {
    derivedMatch++;
  }
  if (!stored?.level) noStored++;
  const issues = stored ? markingCheck(stored, derived, side, idx) : ["no signal_context.liq stored"];
  if (issues.length) markingIssues++;

  const iso = new Date(e.entry_time).toISOString().slice(5, 16).replace("T", " ");
  const row = `${String(e.trade_number).padEnd(2)} ${side.padEnd(4)} ${iso}  ${fmt(e.netPnlTotal).padStart(7)}  ${(e.exits || "").slice(0, 14).padEnd(14)}  ${String(stored?.levelType ?? "—").padEnd(7)}  ${fmt(stored?.level).padStart(8)}  ${fmt(stored?.opposingLevel).padStart(8)}  ${fmt(stored?.sweepWick).padStart(8)}  ${fmt(e.mfe).padStart(5)}  ${fmt(e.mae).padStart(5)}  ${derived ? "yes" : "NO ".padEnd(3)}     ${issues.length ? "⚠ " + issues.join("; ") : "ok"}`;
  console.log(row);

  if (e.netPnlTotal < -0.01) {
    lossRows.push({ e, idx, stored, derived, issues });
  }
}

console.log(
  `\nmarking summary: derivedMatch ${derivedMatch}/${uniq.length} · noStoredLevel ${noStored} · withMarkingIssues ${markingIssues}`,
);

console.log("\n=== LOSS DEEP-DIVE ===");
for (const { e, stored } of lossRows) {
  const side = e.direction;
  const entry = Number(e.entry_price);
  const sl = Number(e.sl_price);
  const tp = Number(e.tp_price);
  const riskPct = sl > 0 ? (Math.abs(entry - sl) / entry) * 100 : null;
  const oneR = riskPct;
  const mfeReachedR = oneR && oneR > 0 ? e.mfe / oneR : null;
  const tp1 = stored?.tp1Price ? Number(stored.tp1Price) : null;
  const reachedTp1 =
    tp1 != null && oneR != null && e.mfe != null
      ? side === "BUY"
        ? entry * (1 + e.mfe / 100) >= tp1
        : entry * (1 - e.mfe / 100) <= tp1
      : null;
  console.log(
    `#${e.trade_number} ${side} pnl=${fmt(e.netPnlTotal)} exit=${e.exits}\n` +
      `   entry=${fmt(entry)} sl=${fmt(sl)} tp=${fmt(tp)} risk=${fmt(riskPct)}% · MFE=${fmt(e.mfe)}% (${fmt(mfeReachedR)}R) MAE=${fmt(e.mae)}%` +
      (tp1 != null ? ` · TP1=${fmt(tp1)} reached=${reachedTp1}` : " · TP1=none") +
      `\n   diagnosis: ${diagnoseLoss(e, mfeReachedR, reachedTp1)}`,
  );
}

function diagnoseLoss(e, mfeReachedR, reachedTp1) {
  const exits = String(e.exits || "");
  if (mfeReachedR != null && mfeReachedR < 0.3) {
    return "went against immediately (MFE < 0.3R) — sweep reclaim failed / entry into continuation, not reversal";
  }
  if (reachedTp1 === true) {
    return "reached TP1 (1R) then reversed to stop — partial logic / breakeven not protecting, or full size stopped";
  }
  if (mfeReachedR != null && mfeReachedR >= 0.7) {
    return "ran most of the way to target then reversed — TP too far / opposing pool not reached before momentum died";
  }
  if (exits.includes("EOD") || exits.includes("TIME")) {
    return "timed out (EOD/time stop) without hitting TP — slow drift, target unrealistic for session";
  }
  return "stopped after partial favorable move — normal R-cost loss within expectancy";
}

// ---- Missed setups: valid sweep reclaims not taken as entries ----
console.log("\n=== MISSED SETUP SCAN (valid sweep reclaims not entered) ===");
const takenBars = new Set();
for (const e of uniq) {
  const idx = findBarIndex(candles, e.entry_time);
  if (idx >= 0) takenBars.add(idx);
}

const startIdx = candles.findIndex((c) => c.ts >= fromMs);
let missedBuy = 0;
let missedSell = 0;
const missedSamples = [];
for (let i = Math.max(2, startIdx); i < candles.length; i++) {
  for (const side of ["BUY", "SELL"]) {
    const setups = listSessionLiquiditySetups(candles, i, side, pre, cfg);
    const atBar = setups.filter((s) => s.reclaimIdx === i && (s.levelType === "pdh" || s.levelType === "pdl"));
    if (!atBar.length) continue;
    if (takenBars.has(i)) continue;
    // Only count "clean" ones with decent quality so we don't flag noise.
    const best = atBar.sort((a, b) => b.liqQuality - a.liqQuality)[0];
    if (best.liqQuality < 55) continue;
    if (side === "BUY") missedBuy++;
    else missedSell++;
    if (missedSamples.length < 25) {
      missedSamples.push({
        i,
        iso: new Date(candles[i].ts).toISOString().slice(5, 16).replace("T", " "),
        side,
        levelType: best.levelType,
        q: best.liqQuality,
        ext: best.extension,
      });
    }
  }
}
console.log(
  `taken entry bars: ${takenBars.size} · missed clean PDH/PDL reclaims (q>=55): BUY ${missedBuy} SELL ${missedSell}`,
);
for (const m of missedSamples) {
  console.log(
    `  ${m.iso} ${m.side} ${m.levelType} q=${fmt(m.q, 0)} ext=${fmt((m.ext ?? 0) * 100)}%`,
  );
}
console.log(
  "\nNote: 'missed' here = a textbook PDH/PDL sweep+reclaim that the full SR_INTRADAY gate stack",
  "vetoed (fib/vp/orderflow/htf/score). Many are correctly skipped; this is the upper bound of frequency.",
);

await closePool();
