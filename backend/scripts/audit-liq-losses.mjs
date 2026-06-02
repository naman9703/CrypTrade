#!/usr/bin/env node
/**
 * Forensic audit: every losing backtest trade vs strict liquidity sweep rules.
 * Usage: node scripts/audit-liq-losses.mjs [runIdPrefix]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runArg = process.argv[2];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday, selectIntradayPicks } = await import("../src/strategy/intradayPro.js");
const {
  scanSessionLiquidityCycles,
  listSessionLiquiditySetups,
  bestSessionLiquidityForDaySide,
  dayStartIndex,
  utcDayId,
} = await import("../src/strategy/techniques/liquidity.js");
const { fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
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

/** Strict textbook verify at reclaim bar. */
function verifySweepAtBar(candles, idx, side, pre, opts) {
  const bar = candles[idx];
  const dayStart = dayStartIndex(candles, idx);
  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? 0.001);
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];
  const level = side === "BUY" ? pdl : pdh;
  const opposing = side === "BUY" ? pdh : pdl;
  const levelType = side === "BUY" ? "pdl" : "pdh";
  if (!(level > 0) || !(opposing > 0)) {
    return { ok: false, reason: "missing_pdh_pdl", pdh, pdl };
  }

  const setups = listSessionLiquiditySetups(candles, idx, side, pre, opts);
  const atBar = setups.filter((s) => s.reclaimIdx === idx);
  if (!atBar.length) {
    return { ok: false, reason: "no_reclaim_setup_at_entry_bar", pdh, pdl, level, levelType };
  }

  const bestAtBar = atBar.sort((a, b) => b.liqQuality - a.liqQuality)[0];
  const cycles = scanSessionLiquidityCycles(
    candles,
    idx,
    side,
    level,
    opposing,
    levelType,
    sweepPct,
    dayStart,
    opts,
  );
  const cycleAtBar = cycles.find((c) => c.reclaimIdx === idx);
  if (!cycleAtBar) {
    return { ok: false, reason: "cycle_scan_mismatch", bestAtBar: bestAtBar.levelType };
  }

  const reclaimClose = bar.close;
  const wick = cycleAtBar.wick;
  const buf = Number(opts.intradayLiqSlBufferPct ?? 0.0015);
  let slOk = false;
  let reclaimOk = false;
  if (side === "SELL") {
    reclaimOk = reclaimClose < level;
    const slExpected = wick * (1 + buf);
    slOk = true; // checked vs trade sl separately
    if (!(cycleAtBar.wick > level * (1 + sweepPct * 0.5))) {
      return { ok: false, reason: "wick_did_not_sweep_pdh", level, wick, reclaimClose };
    }
  } else {
    reclaimOk = reclaimClose > level;
    if (!(cycleAtBar.wick < level * (1 - sweepPct * 0.5))) {
      return { ok: false, reason: "wick_did_not_sweep_pdl", level, wick, reclaimClose };
    }
  }

  if (!reclaimOk) {
    return { ok: false, reason: "reclaim_close_wrong_side_of_level", level, reclaimClose, side };
  }

  const eodBest = bestSessionLiquidityForDaySide(candles, idx, side, pre, { ...opts, _liqPre: pre });
  const eodDayEnd = (() => {
    const d = utcDayId(bar.ts);
    for (let j = candles.length - 1; j >= 0; j--) {
      if (utcDayId(candles[j].ts) === d) return j;
    }
    return idx;
  })();
  const eodPick = bestSessionLiquidityForDaySide(candles, eodDayEnd, side, pre, { ...opts, _liqPre: pre });

  return {
    ok: true,
    levelType: bestAtBar.levelType,
    level: bestAtBar.level,
    wick: bestAtBar.wick,
    opposing: bestAtBar.opposingLevel,
    extension: bestAtBar.extension,
    liqQuality: bestAtBar.liqQuality,
    sweepStartIdx: bestAtBar.sweepStartIdx,
    reclaimIdx: bestAtBar.reclaimIdx,
    pdh,
    pdl,
    eodSameAsEntry: eodPick?.reclaimIdx === idx,
    eodReclaimIso:
      eodPick?.reclaimIdx != null ? new Date(candles[eodPick.reclaimIdx].ts).toISOString() : null,
    barEodBestSame: eodBest?.reclaimIdx === idx,
  };
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

let runId = runArg;
if (!runId) {
  runId = (
    await pool.query(
      `SELECT id::text FROM backtest_runs WHERE status='done' ORDER BY finished_at DESC LIMIT 1`,
    )
  ).rows[0]?.id;
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

let cfg = fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(pickBotCfg(run.config_snapshot)));
cfg.symbol = run.symbol;
cfg.timeframe = run.timeframe;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const candles = await readCandles(run.symbol, run.timeframe, fromMs - 5 * 86400000, toMs);
const pre = precomputeIntraday(candles);
const { series, pickedCount } = selectIntradayPicks(candles, cfg);

const { rows: allTrades } = await pool.query(
  `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price,
          sl_price, tp_price, exit_reason, net_pnl, mfe_pct, mae_pct, bars_held
   FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
  [runId],
);

/** Collapse partial legs: group by entry_time + direction */
const entries = new Map();
for (const t of allTrades) {
  const key = `${new Date(t.entry_time).toISOString()}:${t.direction}`;
  if (!entries.has(key)) entries.set(key, { ...t, legs: [] });
  entries.get(key).legs.push(t);
}
for (const e of entries.values()) {
  e.netPnlTotal = e.legs.reduce((s, l) => s + Number(l.net_pnl), 0);
  e.worstExit = e.legs.map((l) => l.exit_reason).join("+");
}

const losses = [...entries.values()].filter((e) => e.netPnlTotal < -0.01);
const wins = [...entries.values()].filter((e) => e.netPnlTotal > 0.01);

console.log("=== RUN ===", runId);
console.log("trades rows", allTrades.length, "unique entries", entries.size, "losses", losses.length);
console.log("pickedCount", pickedCount, "cfg strict", cfg.intradayLiqStrictMode);

const categories = {
  valid_sweep: [],
  no_signal_at_entry: [],
  invalid_sweep_rules: [],
  eod_pick_mismatch: [],
  sl_bracket_mismatch: [],
  not_pdh_pdl: [],
  other: [],
};

for (const e of losses.sort((a, b) => a.netPnlTotal - b.netPnlTotal)) {
  const idx = findBarIndex(candles, e.entry_time);
  const iso = new Date(e.entry_time).toISOString().slice(0, 16);
  const sig = idx >= 0 ? series[idx] : null;
  const audit = idx >= 0 ? verifySweepAtBar(candles, idx, e.direction, pre, cfg) : { ok: false, reason: "no_bar" };

  const row = {
    trade: e.trade_number,
    entry: iso,
    side: e.direction,
    pnl: e.netPnlTotal.toFixed(2),
    exit: e.worstExit,
    hasSignal: Boolean(sig),
    signalLevel: sig?.liqBrackets?.levelType,
    auditOk: audit.ok,
    auditReason: audit.reason || (audit.ok ? "ok" : "?"),
    eodPick: audit.eodReclaimIso?.slice(0, 16),
    eodSame: audit.eodSameAsEntry,
    levelType: audit.levelType,
    ext: audit.extension != null ? (audit.extension * 100).toFixed(2) + "%" : null,
    sl: Number(e.sl_price),
    slExpected: audit.wick
      ? e.direction === "SELL"
        ? audit.wick * (1 + (cfg.intradayLiqSlBufferPct ?? 0.0015))
        : audit.wick * (1 - (cfg.intradayLiqSlBufferPct ?? 0.0015))
      : null,
  };

  if (!sig) {
    categories.no_signal_at_entry.push(row);
  } else if (!audit.ok) {
    categories.invalid_sweep_rules.push(row);
  } else if (audit.levelType !== "pdh" && audit.levelType !== "pdl") {
    categories.not_pdh_pdl.push(row);
  } else if (audit.eodSameAsEntry === false) {
    categories.eod_pick_mismatch.push(row);
  } else if (
    row.slExpected != null &&
    Math.abs(row.sl - row.slExpected) / row.slExpected > 0.002
  ) {
    categories.sl_bracket_mismatch.push(row);
  } else {
    categories.valid_sweep.push(row);
  }
}

console.log("\n=== LOSS CATEGORIES ===");
for (const [cat, list] of Object.entries(categories)) {
  console.log(`\n${cat}: ${list.length}`);
  for (const r of list.slice(0, 15)) {
    console.log(
      `  #${r.trade} ${r.entry} ${r.side} pnl=${r.pnl} exit=${r.exit} sig=${r.hasSignal}/${r.signalLevel} audit=${r.auditReason} eod=${r.eodSame} ext=${r.ext}`,
    );
  }
  if (list.length > 15) console.log(`  ... +${list.length - 15} more`);
}

/** Sample wins for comparison */
let validWins = 0;
for (const e of wins) {
  const idx = findBarIndex(candles, e.entry_time);
  if (idx < 0) continue;
  const audit = verifySweepAtBar(candles, idx, e.direction, pre, cfg);
  if (audit.ok && audit.eodSameAsEntry && (audit.levelType === "pdh" || audit.levelType === "pdl")) {
    validWins++;
  }
}
console.log("\n=== WINS with valid EOD PDH/PDL sweep ===", validWins, "/", wins.length);

await closePool();
