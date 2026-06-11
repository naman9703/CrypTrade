#!/usr/bin/env node
/**
 * Counterfactual SL/TP analysis for last TOKYO_SESSION backtest run.
 * Usage: node scripts/analyze-tokyo-session-sl-tp.mjs [runIdPrefix]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const RUN_PREFIX = process.argv[2] || "";
const FEE_RT = 0.0008; // ~0.08% round trip
const HOLD_BARS_MAX = 32; // ~8h on 15m

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const runQ = RUN_PREFIX
  ? await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [`${RUN_PREFIX}%`])
  : await pool.query(
      `SELECT * FROM backtest_runs WHERE status='done'
       AND config_snapshot->'bot'->>'manualStrategy' = 'TOKYO_SESSION'
       ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    );
const run = runQ.rows[0];
if (!run) {
  console.error("No TOKYO_SESSION run found");
  process.exit(1);
}

const cfg = pickBot(run.config_snapshot);
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const buf = Number(cfg.tokyoSlBufferPct ?? 0.0005);

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { tokyoSessionPadFromMs } = await import("../src/strategy/tokyoSessionIntraday.js");
const { inTokyoSession, buildTokyoSessionRangeByDay, tokyoSessionDayId } = await import(
  "../src/strategy/techniques/tokyoSession.js"
);

const candles = await readCandles(run.symbol, run.timeframe, tokyoSessionPadFromMs(fromMs, run.timeframe), toMs, {
  market: "futures",
});
const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));
const sessionRanges = buildTokyoSessionRangeByDay(candles, cfg);

const trades = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price,
            net_pnl, exit_reason, sl_price, tp_price, mae_pct, mfe_pct, bars_held, signal_context
     FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [run.id],
  )
).rows;

function sessionBoundsMs(entryMs) {
  const d = new Date(entryMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const startUtc = Number(cfg.tokyoSessionStartUtc ?? 0);
  const endUtc = Number(cfg.tokyoSessionEndUtc ?? 4);
  return { startMs: dayStart + startUtc * 3_600_000, endMs: dayStart + endUtc * 3_600_000 };
}

function first2FromEntry(entryMs) {
  const { startMs } = sessionBoundsMs(entryMs);
  const sessionBars = [];
  for (const c of candles) {
    if (c.ts >= startMs && c.ts < entryMs + 1) sessionBars.push(c);
    if (c.ts > entryMs) break;
  }
  if (sessionBars.length < 2) return null;
  const c1 = sessionBars[sessionBars.length - 2];
  const c2 = sessionBars[sessionBars.length - 1];
  return { c1, c2, hi2: Math.max(c1.high, c2.high), lo2: Math.min(c1.low, c2.low) };
}

function slPriceForMode(mode, side, entry, f2, sess, bufPct) {
  const b = bufPct;
  if (!f2) return null;
  const { c2, hi2, lo2 } = f2;
  const mid = (hi2 + lo2) / 2;
  if (side === "BUY") {
    if (mode === "C2_EXTREME") return c2.low * (1 - b);
    if (mode === "FIRST2_OPPOSITE") return hi2 * (1 + b);
    if (mode === "FIRST2_MID") return mid * (1 - b);
    if (mode === "SESSION_LOW") return (sess?.low ?? lo2) * (1 - b);
    if (mode === "SESSION_HIGH") return (sess?.high ?? hi2) * (1 + b);
    if (mode === "SESSION_OPPOSITE") return (sess?.high ?? hi2) * (1 + b);
    if (mode.startsWith("FIXED_")) {
      const pct = Number(mode.split("_")[1]) / 100;
      return entry * (1 - pct);
    }
    return lo2 * (1 - b);
  }
  if (mode === "C2_EXTREME") return c2.high * (1 + b);
  if (mode === "FIRST2_OPPOSITE") return lo2 * (1 - b);
  if (mode === "FIRST2_MID") return mid * (1 + b);
  if (mode === "SESSION_HIGH") return (sess?.high ?? hi2) * (1 + b);
  if (mode === "SESSION_LOW") return (sess?.low ?? lo2) * (1 - b);
  if (mode === "SESSION_OPPOSITE") return (sess?.low ?? lo2) * (1 - b);
  if (mode.startsWith("FIXED_")) {
    const pct = Number(mode.split("_")[1]) / 100;
    return entry * (1 + pct);
  }
  return hi2 * (1 + b);
}

function tpPriceForMode(mode, side, entry, sl, rr, sess) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  if (mode === "RR") return side === "BUY" ? entry + rr * risk : entry - rr * risk;
  if (mode === "SESSION_EXTREME") {
    if (side === "BUY") return sess?.high ?? entry + rr * risk;
    return sess?.low ?? entry - rr * risk;
  }
  if (mode.startsWith("FIXED_")) {
    const pct = Number(mode.split("_")[1]) / 100;
    return side === "BUY" ? entry * (1 + pct) : entry * (1 - pct);
  }
  return side === "BUY" ? entry + rr * risk : entry - rr * risk;
}

function validBracket(side, entry, sl, tp) {
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl <= 0 || tp <= 0) return false;
  if (side === "BUY") return sl < entry && tp > entry;
  return sl > entry && tp < entry;
}

/** Walk forward from entry bar; return outcome pnl% (no sizing, gross move - fees). */
function replayTrade(entryIdx, side, sl, tp, holdMax = HOLD_BARS_MAX) {
  const entry = candles[entryIdx].close;
  if (!validBracket(side, entry, sl, tp)) return null;
  const isLong = side === "BUY";
  for (let j = entryIdx + 1; j < Math.min(candles.length, entryIdx + 1 + holdMax); j++) {
    const b = candles[j];
    const hitSl = isLong ? b.low <= sl : b.high >= sl;
    const hitTp = isLong ? b.high >= tp : b.low <= tp;
    if (hitSl && hitTp) {
      // conservative: SL first if both in bar
      const pnl = isLong ? (sl - entry) / entry : (entry - sl) / entry;
      return pnl - FEE_RT;
    }
    if (hitSl) {
      const pnl = isLong ? (sl - entry) / entry : (entry - sl) / entry;
      return pnl - FEE_RT;
    }
    if (hitTp) {
      const pnl = isLong ? (tp - entry) / entry : (entry - tp) / entry;
      return pnl - FEE_RT;
    }
  }
  const last = candles[Math.min(candles.length - 1, entryIdx + holdMax)];
  const pnl = isLong ? (last.close - entry) / entry : (entry - last.close) / entry;
  return pnl - FEE_RT;
}

function replaySessionEnd(entryIdx, side) {
  const entryMs = candles[entryIdx].ts;
  const { endMs } = sessionBoundsMs(entryMs);
  const entry = candles[entryIdx].close;
  let exit = entry;
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].ts >= endMs) {
      exit = candles[j - 1]?.close ?? candles[j].close;
      break;
    }
    if (j === candles.length - 1) exit = candles[j].close;
  }
  const pnl = side === "BUY" ? (exit - entry) / entry : (entry - exit) / entry;
  return pnl - FEE_RT;
}

const SL_MODES = [
  "FIRST2_RANGE",
  "C2_EXTREME",
  "FIRST2_MID",
  "FIRST2_OPPOSITE",
  "SESSION_LOW",
  "SESSION_HIGH",
  "SESSION_OPPOSITE",
  "FIXED_0.15",
  "FIXED_0.20",
  "FIXED_0.25",
  "FIXED_0.30",
  "FIXED_0.40",
  "FIXED_0.50",
];
const RR_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3];
const TP_MODES = ["RR", "SESSION_EXTREME"];

const comboStats = new Map();

for (const t of trades) {
  const entryMs = new Date(t.entry_time).getTime();
  const entryIdx = tsToIdx.get(entryMs);
  if (entryIdx == null) continue;
  const side = t.direction;
  const f2 = first2FromEntry(entryMs);
  const dayId = tokyoSessionDayId(entryMs, cfg);
  const sess = sessionRanges.get(dayId);

  for (const slMode of SL_MODES) {
    const sl = slPriceForMode(slMode, side, Number(t.entry_price), f2, sess, buf);
    if (!Number.isFinite(sl)) continue;
    const riskPct = (Math.abs(Number(t.entry_price) - sl) / Number(t.entry_price)) * 100;

    for (const tpMode of TP_MODES) {
      for (const rr of RR_LEVELS) {
        const entryPx = Number(t.entry_price);
        const tp = tpPriceForMode(tpMode, side, entryPx, sl, rr, sess);
        if (!Number.isFinite(tp) || !validBracket(side, entryPx, sl, tp)) continue;
        const pnl = replayTrade(entryIdx, side, sl, tp);
        if (pnl == null) continue;
        const key = `${slMode}|${tpMode}|${rr}R`;
        if (!comboStats.has(key)) comboStats.set(key, { n: 0, wins: 0, sum: 0, slMode, tpMode, rr });
        const row = comboStats.get(key);
        row.n += 1;
        row.sum += pnl * 100;
        if (pnl > 0) row.wins += 1;
      }
    }
  }

  // Session-end exit baseline
  const se = replaySessionEnd(entryIdx, side);
  if (!comboStats.has("SESSION_END|hold|0R")) {
    comboStats.set("SESSION_END|hold|0R", { n: 0, wins: 0, sum: 0, slMode: "SESSION_END", tpMode: "hold", rr: 0 });
  }
  const ser = comboStats.get("SESSION_END|hold|0R");
  ser.n += 1;
  ser.sum += se * 100;
  if (se > 0) ser.wins += 1;

  // Flip direction at same entry
  const flipSide = side === "BUY" ? "SELL" : "BUY";
  const flipSl = slPriceForMode("FIRST2_RANGE", flipSide, Number(t.entry_price), f2, sess, buf);
  const flipTp = tpPriceForMode("RR", flipSide, Number(t.entry_price), flipSl, 2, sess);
  const flipPnl = replayTrade(entryIdx, flipSide, flipSl, flipTp);
  if (flipPnl != null) {
    const key = "FLIP|FIRST2_RANGE|2R";
    if (!comboStats.has(key)) comboStats.set(key, { n: 0, wins: 0, sum: 0, slMode: "FLIP", tpMode: "FIRST2_RANGE", rr: 2 });
    const row = comboStats.get(key);
    row.n += 1;
    row.sum += flipPnl * 100;
    if (flipPnl > 0) row.wins += 1;
  }
}

const ranked = [...comboStats.values()]
  .map((r) => ({ ...r, avg: r.sum / r.n, wr: (r.wins / r.n) * 100, key: `${r.slMode}|${r.tpMode}|${r.rr}R` }))
  .sort((a, b) => b.sum - a.sum);

console.log("=".repeat(78));
console.log("TOKYO_SESSION SL/TP COUNTERFACTUAL ANALYSIS");
console.log("=".repeat(78));
console.log(`Run:      ${run.id}`);
console.log(`Symbol:   ${run.symbol} ${run.timeframe}`);
console.log(`Period:   ${run.start_date} → ${run.end_date}`);
console.log(`Trades:   ${trades.length}`);
console.log(`Actual:   ${cfg.tokyoSlMode} SL · ${cfg.tokyoTpRr}R TP · ${cfg.tokyoDirMode} · risk ${cfg.riskPerTrade}%`);
console.log(`Exits:    ${trades.filter((t) => t.exit_reason === "sl").length} SL / ${trades.filter((t) => t.exit_reason === "tp").length} TP`);
console.log(`Actual net sum (equity legs): $${trades.reduce((s, t) => s + Number(t.net_pnl), 0).toFixed(2)}`);

console.log("\n--- Top 20 combos by total gross move % (all trades, incl. fees) ---");
for (const r of ranked.slice(0, 20)) {
  console.log(
    `${r.key.padEnd(38)} total=${r.sum.toFixed(1)}% avg=${r.avg.toFixed(3)}% wr=${r.wr.toFixed(0)}% n=${r.n}`,
  );
}

const positive = ranked.filter((r) => r.sum > 0);
console.log(`\n--- Positive total return combos: ${positive.length} / ${ranked.length} ---`);
for (const r of positive.slice(0, 15)) {
  console.log(
    `${r.key.padEnd(38)} total=${r.sum.toFixed(1)}% avg=${r.avg.toFixed(3)}% wr=${r.wr.toFixed(0)}%`,
  );
}

// Per actual losers: would wider SL + lower RR have saved them?
let savedByWider = 0;
let savedByLowerRr = 0;
const losers = trades.filter((t) => Number(t.net_pnl) < 0);
for (const t of losers) {
  const entryMs = new Date(t.entry_time).getTime();
  const entryIdx = tsToIdx.get(entryMs);
  if (entryIdx == null) continue;
  const side = t.direction;
  const f2 = first2FromEntry(entryMs);
  const dayId = tokyoSessionDayId(entryMs, cfg);
  const sess = sessionRanges.get(dayId);

  const slWide = slPriceForMode(side === "BUY" ? "SESSION_LOW" : "SESSION_HIGH", side, Number(t.entry_price), f2, sess, buf);
  const tp1 = tpPriceForMode("RR", side, Number(t.entry_price), slWide, 1, sess);
  const pnl1 = replayTrade(entryIdx, side, slWide, tp1);
  if (pnl1 != null && pnl1 > 0) savedByWider += 1;

  const slCur = slPriceForMode("FIRST2_RANGE", side, Number(t.entry_price), f2, sess, buf);
  const tp05 = tpPriceForMode("RR", side, Number(t.entry_price), slCur, 0.5, sess);
  const pnl05 = replayTrade(entryIdx, side, slCur, tp05);
  if (pnl05 != null && pnl05 > 0) savedByLowerRr += 1;
}

console.log("\n--- Loss autopsy (51 losers) ---");
console.log(`Would win with SESSION_LOW SL + 1R TP: ${savedByWider}/${losers.length}`);
console.log(`Would win with current SL + 0.5R TP:   ${savedByLowerRr}/${losers.length}`);

// MFE distribution for losers that hit SL
const slLosers = losers.filter((t) => t.exit_reason === "sl");
const mfeBuckets = { "<0.1%": 0, "0.1-0.3%": 0, "0.3-0.5%": 0, "0.5-1%": 0, ">1%": 0 };
for (const t of slLosers) {
  const mfe = Number(t.mfe_pct);
  if (mfe < 0.1) mfeBuckets["<0.1%"]++;
  else if (mfe < 0.3) mfeBuckets["0.1-0.3%"]++;
  else if (mfe < 0.5) mfeBuckets["0.3-0.5%"]++;
  else if (mfe < 1) mfeBuckets["0.5-1%"]++;
  else mfeBuckets[">1%"]++;
}
console.log("SL losers MFE (had favorable move before stop):", mfeBuckets);

// Best fixed SL/TP only
const fixedOnly = ranked.filter((r) => r.slMode.startsWith("FIXED_"));
console.log("\n--- Best fixed-% SL combos ---");
for (const r of fixedOnly.slice(0, 8)) {
  console.log(`${r.key.padEnd(38)} total=${r.sum.toFixed(1)}% wr=${r.wr.toFixed(0)}%`);
}

// FIRST2_RANGE only (current SL anchor) across RR
const f2r = ranked.filter((r) => r.slMode === "FIRST2_RANGE" && r.tpMode === "RR");
console.log("\n--- FIRST2_RANGE SL × RR (current SL placement) ---");
for (const r of f2r) {
  console.log(`${r.rr}R`.padEnd(6) + ` total=${r.sum.toFixed(1)}% avg=${r.avg.toFixed(3)}% wr=${r.wr.toFixed(0)}%`);
}

// Entry-time only session (first 2 bars) for SL/TP — no lookahead
const entryOnly = new Map();
for (const t of trades) {
  const entryMs = new Date(t.entry_time).getTime();
  const entryIdx = tsToIdx.get(entryMs);
  if (entryIdx == null) continue;
  const side = t.direction;
  const f2 = first2FromEntry(entryMs);
  if (!f2) continue;
  const entryPx = Number(t.entry_price);
  const slLo = f2.lo2 * (1 - buf);
  const slHi = f2.hi2 * (1 + buf);
  const sl = side === "BUY" ? slLo : slHi;
  for (const rr of [0.5, 0.75, 1, 1.5, 2]) {
    const tp = side === "BUY" ? entryPx + rr * (entryPx - sl) : entryPx - rr * (sl - entryPx);
    const pnl = replayTrade(entryIdx, side, sl, tp);
    if (pnl == null) continue;
    const key = `ENTRY_FIRST2|${rr}R`;
    if (!entryOnly.has(key)) entryOnly.set(key, { sum: 0, n: 0, wins: 0, rr });
    const row = entryOnly.get(key);
    row.n++;
    row.sum += pnl * 100;
    if (pnl > 0) row.wins++;
  }
  // TP = opposite side of first-2 box
  const tpOpp = side === "BUY" ? f2.hi2 : f2.lo2;
  const pnlOpp = replayTrade(entryIdx, side, sl, tpOpp);
  if (pnlOpp != null) {
    const key = "ENTRY_FIRST2|TP_OPPOSITE_SIDE";
    if (!entryOnly.has(key)) entryOnly.set(key, { sum: 0, n: 0, wins: 0 });
    const row = entryOnly.get(key);
    row.n++;
    row.sum += pnlOpp * 100;
    if (pnlOpp > 0) row.wins++;
  }
}
console.log("\n--- Entry-time first-2 box only (no session lookahead) ---");
for (const [key, row] of [...entryOnly.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`${key.padEnd(28)} total=${row.sum.toFixed(1)}% wr=${((row.wins / row.n) * 100).toFixed(0)}% n=${row.n}`);
}

// Run full backtest sim on top realistic combos
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildTokyoSessionBacktestAdapter, resolveTokyoSessionCfg } = await import(
  "../src/strategy/tokyoSessionIntraday.js"
);
const { TOKYO_SESSION_BNB_15M } = await import("../src/strategy/presets/tokyoSessionOptimized.js");
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

async function simCombo(label, patch) {
  const c = resolveTokyoSessionCfg({ ...TOKYO_SESSION_BNB_15M, ...cfg, ...patch, symbol: run.symbol, timeframe: run.timeframe });
  const adapter = buildTokyoSessionBacktestAdapter(candles, c, run.timeframe);
  const sim = await runSimulation({
    candles,
    strategyKey: "TOKYO_SESSION",
    cfg: { ...c, symbol: run.symbol },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: run.timeframe,
    adapters: { TOKYO_SESSION: adapter },
    symbol: run.symbol,
    costModelOverride: cost,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: run.timeframe, startingEquity: 100 });
  const inW = sim.trades.filter((tr) => tr.entryTs >= fromMs && tr.entryTs < toMs);
  return { label, ret: m.totalReturnPct ?? 0, n: inW.length, wr: (m.winRate ?? 0) * 100, dd: m.maxDrawdownPct ?? 0, pf: m.profitFactor ?? 0 };
}

console.log("\n--- Full engine re-sim (realistic cfg patches) ---");
const sims = await Promise.all([
  simCombo("actual (2R FIRST2_RANGE)", {}),
  simCombo("1R TP", { tokyoTpRr: 1 }),
  simCombo("0.75R not supported — 1R + C2 SL", { tokyoTpRr: 1, tokyoSlMode: "C2_EXTREME" }),
  simCombo("1R + FIRST2_MID SL", { tokyoTpRr: 1, tokyoSlMode: "FIRST2_MID" }),
  simCombo("1.5R not native — 2R + C2 SL", { tokyoTpRr: 2, tokyoSlMode: "C2_EXTREME" }),
  simCombo("1R + wider buffer 0.1%", { tokyoTpRr: 1, tokyoSlBufferPct: 0.001 }),
  simCombo("1R + skip mixed off", { tokyoTpRr: 1, tokyoSkipMixedBodies: false }),
]);
for (const s of sims.sort((a, b) => b.ret - a.ret)) {
  console.log(`${s.label.padEnd(36)} ret=${s.ret.toFixed(1)}% n=${s.n} wr=${s.wr.toFixed(0)}% dd=${s.dd.toFixed(1)}% pf=${s.pf?.toFixed(2)}`);
}

await closePool();
