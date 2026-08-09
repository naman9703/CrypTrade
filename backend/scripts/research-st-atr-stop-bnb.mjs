#!/usr/bin/env node
/**
 * One-change experiment: ST BNB 15m — widen stop from noise-tight 0.3% fixed SL
 * to ATR-based SL (slAtrMultiplier), keeping all other cfg identical.
 *
 * Hypothesis (autopsy XGB@0.09 run): 72.5% of SL exits die in ≤2 bars; 0.3% SL
 * sits inside normal 15m noise. Wider ATR stop should cut instant chops without
 * N-crush filters.
 *
 * Usage (from backend/, or via docker exec):
 *   FROM=2025-01-01 TO=2026-08-02 ATR_MULT=2 node scripts/research-st-atr-stop-bnb.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-08-02";
const START_USDT = Number(process.env.START_USDT || 10000);
const ATR_MULT = Number(process.env.ATR_MULT || 2);
const BASELINE_RUN_ID = process.env.BASELINE_RUN_ID || "db6a6e92-61e9-4177-8fe9-f0346393fc94";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
if (!pool) {
  console.error(JSON.stringify({ ok: false, error: "db_not_configured" }));
  process.exit(1);
}
async function query(sql, params) {
  return pool.query(sql, params);
}

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");

function pickBot(snap) {
  if (!snap || typeof snap !== "object") return {};
  if (snap.bot && typeof snap.bot === "object") return { ...snap.bot };
  return { ...snap };
}

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const runRes = await query(`SELECT config_snapshot, cost_model, initial_capital FROM backtest_runs WHERE id = $1`, [
  BASELINE_RUN_ID,
]);
if (!runRes.rows.length) {
  console.error(JSON.stringify({ ok: false, error: "baseline_run_not_found", id: BASELINE_RUN_ID }));
  process.exit(1);
}
const snap = runRes.rows[0].config_snapshot;
const baseBot = pickBot(typeof snap === "string" ? JSON.parse(snap) : snap);
const startUsdt = Number(runRes.rows[0].initial_capital) || START_USDT;

const baseCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  // Explicit: fixed 0.3% path (baseline)
  supertrendFuturesFixedSlPct: Number(baseBot.supertrendFuturesFixedSlPct ?? 0.003),
  slAtrMultiplier: 0,
  supertrendXgbGateEnabled: false,
};

const atrCfg = {
  ...baseCfg,
  // ONE CHANGE: ATR stop takes precedence in computeStopPct when slAtrMultiplier > 0
  slAtrMultiplier: ATR_MULT,
};

console.error(`[research] load candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
if (!candles?.length) {
  console.error(JSON.stringify({ ok: false, error: "no_candles" }));
  process.exit(1);
}
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}

async function runOne(label, cfg) {
  const t0 = Date.now();
  console.error(`[research] sim ${label} …`);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: startUsdt,
    timeframe: TF,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: startUsdt,
  });
  const sl = sim.trades.filter((t) => String(t.exitReason || t.exit_reason) === "sl");
  const instant = sl.filter((t) => Number(t.barsHeld ?? t.bars_held ?? 99) <= 2);
  return {
    label,
    ms: Date.now() - t0,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    slN: sl.length,
    slLe2: instant.length,
    pctSlLe2: sl.length ? instant.length / sl.length : null,
    finalEquity: sim.finalEquity,
    cfgNote:
      label === "atr_stop"
        ? { slAtrMultiplier: ATR_MULT, fixedSlPct: cfg.supertrendFuturesFixedSlPct }
        : { slAtrMultiplier: 0, fixedSlPct: cfg.supertrendFuturesFixedSlPct },
  };
}

const baseline = await runOne("fixed_0.3pct", baseCfg);
const atr = await runOne("atr_stop", atrCfg);

const out = {
  ok: true,
  hypothesis:
    "0.3% fixed SL dies inside 15m noise (72.5% SL ≤2 bars). One change: slAtrMultiplier=" +
    ATR_MULT +
    " (ATR path precedes fixed SL).",
  window: { symbol: SYMBOL, tf: TF, from: FROM, to: TO, bars: candles.length },
  baseline,
  atr,
  delta: {
    n: atr.n - baseline.n,
    wr: atr.wr - baseline.wr,
    pf: atr.pf - baseline.pf,
    ret: atr.ret - baseline.ret,
    dd: atr.dd - baseline.dd,
    pctSlLe2: (atr.pctSlLe2 ?? 0) - (baseline.pctSlLe2 ?? 0),
  },
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-04-st-bnb-atr-stop-one-change.md");
const md = `# ST BNB 15m — ATR stop (one change)

**Date:** 2026-08-04  
**Hypothesis:** Instant SL chop from 0.3% fixed stop inside 15m noise.  
**One change:** \`slAtrMultiplier=${ATR_MULT}\` (ATR-based SL; fixed 0.3% unused when ATR present).  
**Window:** ${FROM} → ${TO} · ${SYMBOL} ${TF} · start ${startUsdt}

| | Fixed 0.3% SL | ATR×${ATR_MULT} |
|--|--|--|
| Trades | ${baseline.n} | ${atr.n} |
| WR | ${(baseline.wr * 100).toFixed(1)}% | ${(atr.wr * 100).toFixed(1)}% |
| PF | ${baseline.pf?.toFixed?.(3) ?? baseline.pf} | ${atr.pf?.toFixed?.(3) ?? atr.pf} |
| Return % | ${baseline.ret?.toFixed?.(1) ?? baseline.ret} | ${atr.ret?.toFixed?.(1) ?? atr.ret} |
| Max DD % | ${baseline.dd?.toFixed?.(1) ?? baseline.dd} | ${atr.dd?.toFixed?.(1) ?? atr.dd} |
| SL ≤2 bars | ${((baseline.pctSlLe2 ?? 0) * 100).toFixed(1)}% | ${((atr.pctSlLe2 ?? 0) * 100).toFixed(1)}% |

## Verdict

${
  atr.ret > 0 && atr.pf >= 1
    ? "Promising on this window — still needs full baseline window + OOS / WF before promote language."
    : atr.ret > baseline.ret || atr.pf > baseline.pf
      ? "Improved vs tight SL but **not profitable yet**. Next: one more autopsy-driven change (not XGB thr), or disaster-SL / trail contract — do not stack filters."
      : "No improvement — archive this ATR mult or try different mult only after new named hypothesis."
}

XGB gate deferred until base ST stop geometry is non-pathological.
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
