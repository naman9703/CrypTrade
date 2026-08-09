#!/usr/bin/env node
/**
 * One-change: enable Supertrend trailing on ATR×3 initial SL set.
 *
 * Prior: ATR×3 cut instant-chop but PF~0.66 / ret~-78% (2025→2026 BNB).
 * Stretch skip REJECT. Next named exit-contract change: trailingStopLossAuto=true
 * (mode already SUPERTREND in baseline cfg).
 *
 *   FROM=2025-01-01 TO=2026-08-02 ATR_MULT=3 node scripts/research-st-trail-atr-bnb.mjs
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
const ATR_MULT = Number(process.env.ATR_MULT || 3);
const BASELINE_RUN_ID = process.env.BASELINE_RUN_ID || "db6a6e92-61e9-4177-8fe9-f0346393fc94";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
if (!pool) {
  console.error(JSON.stringify({ ok: false, error: "db_not_configured" }));
  process.exit(1);
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
const runRes = await pool.query(`SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id = $1`, [
  BASELINE_RUN_ID,
]);
if (!runRes.rows.length) {
  console.error(JSON.stringify({ ok: false, error: "baseline_run_not_found" }));
  process.exit(1);
}
const snap = runRes.rows[0].config_snapshot;
const baseBot = pickBot(typeof snap === "string" ? JSON.parse(snap) : snap);
const startUsdt = Number(runRes.rows[0].initial_capital) || 10000;

const atrCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  slAtrMultiplier: ATR_MULT,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendXgbGateEnabled: false,
  supertrendStretchSkipEnabled: false,
};

const trailCfg = {
  ...atrCfg,
  // ONE CHANGE
  trailingStopLossAuto: true,
};

console.error(`[research] candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}

async function runOne(label, cfg) {
  console.error(`[research] sim ${label} …`);
  const t0 = Date.now();
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
  const byExit = {};
  for (const t of sim.trades) {
    const k = String(t.exitReason || "unknown");
    byExit[k] = (byExit[k] || 0) + 1;
  }
  const sl = sim.trades.filter((t) => String(t.exitReason) === "sl");
  const slLe2 = sl.filter((t) => Number(t.barsHeld ?? 99) <= 2);
  return {
    label,
    ms: Date.now() - t0,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    pctSlLe2: sl.length ? slLe2.length / sl.length : null,
    byExit,
    finalEquity: sim.finalEquity,
  };
}

const atrOnly = await runOne("atr_stop_no_trail", atrCfg);
const withTrail = await runOne("atr_stop_plus_trail", trailCfg);

const out = {
  ok: true,
  hypothesis:
    "ATR×3 still red with fixed TP/no trail. One change: trailingStopLossAuto=true (SUPERTREND trail mode).",
  window: { symbol: SYMBOL, tf: TF, from: FROM, to: TO, bars: candles.length, atrMult: ATR_MULT },
  atrOnly,
  withTrail,
  delta: {
    n: withTrail.n - atrOnly.n,
    wr: withTrail.wr - atrOnly.wr,
    pf: withTrail.pf - atrOnly.pf,
    ret: withTrail.ret - atrOnly.ret,
    dd: withTrail.dd - atrOnly.dd,
  },
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-04-st-bnb-trail-atr-one-change.md");
const a = atrOnly;
const b = withTrail;
const md = `# ST BNB — ATR×${ATR_MULT} + trailing (one change)

**Date:** 2026-08-04  
**Hypothesis:** Fixed TP / no trail leaves winners uncapped poorly and losers path-dependent; enable ST trail on ATR initial SL.  
**One change:** \`trailingStopLossAuto: false → true\` (mode already \`SUPERTREND\`).  
**Window:** ${FROM} → ${TO} · ${SYMBOL} ${TF}

| | ATR×${ATR_MULT} no trail | + trail |
|--|--|--|
| Trades | ${a.n} | ${b.n} |
| WR | ${((a.wr ?? 0) * 100).toFixed(1)}% | ${((b.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${a.pf?.toFixed?.(3) ?? a.pf} | ${b.pf?.toFixed?.(3) ?? b.pf} |
| Return % | ${a.ret?.toFixed?.(1) ?? a.ret} | ${b.ret?.toFixed?.(1) ?? b.ret} |
| Max DD % | ${a.dd?.toFixed?.(1) ?? a.dd} | ${b.dd?.toFixed?.(1) ?? b.dd} |
| SL ≤2 bars | ${((a.pctSlLe2 ?? 0) * 100).toFixed(1)}% | ${((b.pctSlLe2 ?? 0) * 100).toFixed(1)}% |
| Exits | ${JSON.stringify(a.byExit)} | ${JSON.stringify(b.byExit)} |

## Verdict

${
  (b.ret ?? -999) > 0 && (b.pf ?? 0) >= 1
    ? "Promising on this window — needs full multi-year + WF before promote."
    : (b.pf ?? 0) > (a.pf ?? 0) || (b.ret ?? -999) > (a.ret ?? -999)
      ? "Trail helps vs ATR-only but **not yet profitable**. Next autopsy on trail exits — one change only."
      : "No lift (or worse). Archive trail-on for this ST+ATR BNB combo or revisit disaster-SL / flip-exit."
}
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
