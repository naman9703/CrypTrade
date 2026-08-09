#!/usr/bin/env node
/**
 * One-change: enable 4H Supertrend alignment on best exit stack.
 *
 * Exit stream stalled at PF~0.65. Named entry-context: only take 15m ST flips
 * when 4H ST agrees (supertrendHtf4hEnabled).
 *
 *   FROM=2025-01-01 TO=2026-08-02 node scripts/research-st-htf4h-bnb.mjs
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

console.error(`[research] candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}

/** Best exit stack so far (still red). */
const baseCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  slAtrMultiplier: ATR_MULT,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferRate: Number(baseBot.trailBufferRate ?? 0.015),
  supertrendFuturesUseFixedTp: false,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesExitOnFlip: false,
  supertrendHtf4hEnabled: false,
  supertrendXgbGateEnabled: false,
  supertrendStretchSkipEnabled: false,
};

const htfCfg = {
  ...baseCfg,
  // ONE CHANGE
  supertrendHtf4hEnabled: true,
};

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
  const days = Math.max(1, (toMs - fromMs) / 86_400_000);
  return {
    label,
    ms: Date.now() - t0,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    tradesPerDay: m.totalTrades / days,
    byExit,
    htf4hReplay: sim.metrics?.htf4hReplay ?? sim.htf4hReplay ?? null,
    finalEquity: sim.finalEquity,
  };
}

const noHtf = await runOne("no_htf4h", baseCfg);
const withHtf = await runOne("htf4h_on", htfCfg);

const out = {
  ok: true,
  hypothesis: "15m ST flips against 4H ST are counter-structure; require 4H alignment.",
  window: { symbol: SYMBOL, tf: TF, from: FROM, to: TO, bars: candles.length, atrMult: ATR_MULT },
  noHtf,
  withHtf,
  delta: {
    n: withHtf.n - noHtf.n,
    wr: withHtf.wr - noHtf.wr,
    pf: withHtf.pf - noHtf.pf,
    ret: withHtf.ret - noHtf.ret,
    dd: withHtf.dd - noHtf.dd,
  },
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-08-st-bnb-htf4h-one-change.md");
const a = noHtf;
const b = withHtf;
const freqOk = (b.tradesPerDay ?? 0) >= 0.5;
const md = `# ST BNB — 4H Supertrend alignment (one change)

**Date:** 2026-08-08  
**Hypothesis:** Counter-4H 15m flips are structure-against-context losers; require HTF ST agree.  
**One change:** \`supertrendHtf4hEnabled: false → true\`.  
**Base:** ATR×${ATR_MULT}, trail on (buf 1.5%), fixed TP off, flip off.  
**Window:** ${FROM} → ${TO} · ${SYMBOL} ${TF}

| | No HTF4H | HTF4H on |
|--|--|--|
| Trades | ${a.n} | ${b.n} |
| /day | ${a.tradesPerDay?.toFixed?.(2)} | ${b.tradesPerDay?.toFixed?.(2)} |
| WR | ${((a.wr ?? 0) * 100).toFixed(1)}% | ${((b.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${a.pf?.toFixed?.(3) ?? a.pf} | ${b.pf?.toFixed?.(3) ?? b.pf} |
| Return % | ${a.ret?.toFixed?.(1) ?? a.ret} | ${b.ret?.toFixed?.(1) ?? b.ret} |
| Max DD % | ${a.dd?.toFixed?.(1) ?? a.dd} | ${b.dd?.toFixed?.(1) ?? b.dd} |
| Exits | ${JSON.stringify(a.byExit)} | ${JSON.stringify(b.byExit)} |
| HTF replay | — | ${JSON.stringify(b.htf4hReplay)} |

## Verdict

${
  (b.ret ?? -999) > 0 && (b.pf ?? 0) >= 1 && freqOk
    ? "Promising on this window — needs multi-year + WF before promote."
    : !freqOk && (b.n ?? 0) < 30
      ? "Frequency crushed — reject as N-starve even if PF greener."
      : (b.pf ?? 0) > (a.pf ?? 0) + 0.05 || (b.ret ?? -999) > (a.ret ?? -999) + 10
        ? "HTF4H helps vs base but **not yet profitable**. Keep frequency check; next entry concept if still red."
        : "No material lift (or worse). Archive HTF4H for this stack or next entry hyp."
}
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
