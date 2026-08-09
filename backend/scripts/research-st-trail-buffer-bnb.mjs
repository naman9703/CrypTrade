#!/usr/bin/env node
/**
 * One-change: lower trailBufferRate so fee-BE can lock before ATR SL.
 *
 * Probe: baseline trailBufferRate=0.015 (1.5%) → activation ~fee+1.5%.
 * Loser MFE P50~0.3% never locks; winners MFE P50~2.4% do.
 *
 *   FROM=2025-01-01 TO=2026-08-02 node scripts/research-st-trail-buffer-bnb.mjs
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
const NEW_BUF = Number(process.env.TRAIL_BUFFER_RATE || 0.0005);
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
const oldBuf = Number(baseBot.trailBufferRate ?? 0.015);

console.error(`[research] candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}

const baseCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  slAtrMultiplier: ATR_MULT,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesUseFixedTp: false,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesExitOnFlip: false,
  supertrendXgbGateEnabled: false,
  supertrendStretchSkipEnabled: false,
  // keep baseline buffer
  trailBufferRate: oldBuf,
};

const lowBufCfg = {
  ...baseCfg,
  // ONE CHANGE
  trailBufferRate: NEW_BUF,
};

async function runOne(label, cfg) {
  console.error(`[research] sim ${label} (buf=${cfg.trailBufferRate}) …`);
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
  let slN = 0;
  let slTrail = 0;
  let slLoss = 0;
  let slLossTrail = 0;
  for (const t of sim.trades) {
    const k = String(t.exitReason || "unknown");
    byExit[k] = (byExit[k] || 0) + 1;
    if (k === "sl") {
      slN++;
      if (Number(t.trailStep || 0) > 0) slTrail++;
      if (+t.netPnl <= 0) {
        slLoss++;
        if (Number(t.trailStep || 0) > 0) slLossTrail++;
      }
    }
  }
  const days = Math.max(1, (toMs - fromMs) / 86_400_000);
  return {
    label,
    ms: Date.now() - t0,
    bufferRate: cfg.trailBufferRate,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    tradesPerDay: m.totalTrades / days,
    byExit,
    pctSlWithTrailStep: slN ? slTrail / slN : null,
    pctSlLossWithTrailStep: slLoss ? slLossTrail / slLoss : null,
    finalEquity: sim.finalEquity,
  };
}

const hi = await runOne("buf_baseline", baseCfg);
const lo = await runOne("buf_low", lowBufCfg);

const out = {
  ok: true,
  hypothesis:
    "trailBufferRate 1.5% blocks BE until ~1.7% MFE; losers die at ATR first. Lower buffer to default 0.05%.",
  window: { symbol: SYMBOL, tf: TF, from: FROM, to: TO, bars: candles.length, atrMult: ATR_MULT },
  hi,
  lo,
  delta: {
    n: lo.n - hi.n,
    wr: lo.wr - hi.wr,
    pf: lo.pf - hi.pf,
    ret: lo.ret - hi.ret,
    dd: lo.dd - hi.dd,
  },
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-08-st-bnb-trail-buffer-one-change.md");
const a = hi;
const b = lo;
const md = `# ST BNB — lower trailBufferRate (one change)

**Date:** 2026-08-08  
**Hypothesis:** Baseline \`trailBufferRate=${oldBuf}\` (1.5%) delays ST trail activation past typical loser MFE; winners clear ~2%+ so they lock.  
**One change:** \`trailBufferRate: ${oldBuf} → ${NEW_BUF}\`.  
**Base:** ATR×${ATR_MULT}, trail on, fixed TP off, flip off, SUPERTREND trail mode.  
**Window:** ${FROM} → ${TO} · ${SYMBOL} ${TF}

| | buf ${oldBuf} | buf ${NEW_BUF} |
|--|--|--|
| Trades | ${a.n} | ${b.n} |
| /day | ${a.tradesPerDay?.toFixed?.(2)} | ${b.tradesPerDay?.toFixed?.(2)} |
| WR | ${((a.wr ?? 0) * 100).toFixed(1)}% | ${((b.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${a.pf?.toFixed?.(3) ?? a.pf} | ${b.pf?.toFixed?.(3) ?? b.pf} |
| Return % | ${a.ret?.toFixed?.(1) ?? a.ret} | ${b.ret?.toFixed?.(1) ?? b.ret} |
| Max DD % | ${a.dd?.toFixed?.(1) ?? a.dd} | ${b.dd?.toFixed?.(1) ?? b.dd} |
| SL-loss w/ trailStep | ${((a.pctSlLossWithTrailStep ?? 0) * 100).toFixed(1)}% | ${((b.pctSlLossWithTrailStep ?? 0) * 100).toFixed(1)}% |
| Exits | ${JSON.stringify(a.byExit)} | ${JSON.stringify(b.byExit)} |

## Verdict

${
  (b.ret ?? -999) > 0 && (b.pf ?? 0) >= 1
    ? "Promising on this window — needs multi-year + WF before promote."
    : (b.pf ?? 0) > (a.pf ?? 0) + 0.02 || (b.ret ?? -999) > (a.ret ?? -999) + 5
      ? "Lower buffer helps vs 1.5% but **not yet profitable**. Next autopsy on remaining ATR SL."
      : "No material lift (or worse). Archive this buffer cut or try intermediate (e.g. 0.002)."
}
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
