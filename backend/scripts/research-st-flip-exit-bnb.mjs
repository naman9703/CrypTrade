#!/usr/bin/env node
/**
 * One-change: enable Supertrend flip exit on ATR×3 + trail + no fixed TP.
 *
 * Prior: trail engages only after fixed TP off; still PF~0.65 / ret~-72%.
 * Most exits remain full ATR SL. Named exit-contract change: exit on ST flip.
 *
 *   FROM=2025-01-01 TO=2026-08-02 node scripts/research-st-flip-exit-bnb.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });
if (!process.env.MARKET_FEED) process.env.MARKET_FEED = "BINANCE_FUTURES";

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-08-02";
const ATR_MULT = Number(process.env.ATR_MULT || 3);
const BASELINE_RUN_ID = process.env.BASELINE_RUN_ID || "db6a6e92-61e9-4177-8fe9-f0346393fc94";

const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");

function pickBot(snap) {
  if (!snap || typeof snap !== "object") return {};
  if (snap.bot && typeof snap.bot === "object") return { ...snap.bot };
  return { ...snap };
}

/** Fallback when Timescale is down — matches known db6a6e92 ST futures research stack. */
const FALLBACK_BOT = {
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  futuresLeverage: 12,
  riskPerTrade: 0.025,
  riskPerTradePct: 2.5,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  supertrendFuturesFixedSlPct: 0.003,
  supertrendFuturesFixedTpPct: 0.01,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND",
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  supertrendFuturesExitOnFlip: false,
  openFeeRate: 0.0004,
  closeFeeRate: 0.0004,
  slippagePct: 0.0005,
};

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

let baseBot = { ...FALLBACK_BOT };
let startUsdt = 10000;
let candleSource = "binance_rest";
let funding = [];
let closePool = null;
let candles = null;

try {
  const { initPool, closePool: cp, getPool } = await import("../src/db/pool.js");
  closePool = cp;
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: () => {} });
  const pool = getPool();
  if (pool) {
    const runRes = await pool.query(
      `SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id = $1`,
      [BASELINE_RUN_ID],
    );
    if (runRes.rows.length) {
      const snap = runRes.rows[0].config_snapshot;
      baseBot = pickBot(typeof snap === "string" ? JSON.parse(snap) : snap);
      startUsdt = Number(runRes.rows[0].initial_capital) || 10000;
    }
    const { readCandles } = await import("../src/backtest/data/klineIngest.js");
    const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
    const dbCandles = await readCandles(SYMBOL, TF, fromMs, toMs);
    if (dbCandles.length > 100) {
      candles = dbCandles;
      candleSource = "db";
      try {
        funding = await readFundingRates(SYMBOL, fromMs, toMs);
      } catch {
        funding = [];
      }
    }
  }
} catch (err) {
  console.error(`[research] db unavailable (${err?.message || err}) — using REST + fallback bot`);
}

if (!candles?.length) {
  console.error(`[research] fetching ${SYMBOL} ${TF} ${FROM}→${TO} via Binance REST…`);
  candles = await fetchBinanceKlinesRange({
    symbol: SYMBOL,
    interval: TF,
    startTime: fromMs,
    endTime: toMs,
    feedKind: "BINANCE_FUTURES",
  });
  candleSource = "binance_rest";
}
if (!candles?.length) {
  console.error(JSON.stringify({ ok: false, error: "no_candles", candleSource }));
  process.exit(1);
}
console.error(`[research] bars=${candles.length} source=${candleSource} startUsdt=${startUsdt}`);

/** Best prior exit stack (still red): ATR SL + trail, no fixed TP, flip off. */
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
};

const flipCfg = {
  ...baseCfg,
  // ONE CHANGE
  supertrendFuturesExitOnFlip: true,
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
  let trailStepGt0 = 0;
  for (const t of sim.trades) {
    const k = String(t.exitReason || "unknown");
    byExit[k] = (byExit[k] || 0) + 1;
    if (Number(t.trailStep || 0) > 0) trailStepGt0++;
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
    trailStepGt0,
    finalEquity: sim.finalEquity,
  };
}

const noFlip = await runOne("atr3_trail_no_tp_flip_off", baseCfg);
const withFlip = await runOne("atr3_trail_no_tp_flip_on", flipCfg);

const out = {
  ok: true,
  hypothesis:
    "Most losers are full ATR SL. One change: supertrendFuturesExitOnFlip true — exit on structure flip.",
  window: {
    symbol: SYMBOL,
    tf: TF,
    from: FROM,
    to: TO,
    bars: candles.length,
    atrMult: ATR_MULT,
    candleSource,
  },
  noFlip,
  withFlip,
  delta: {
    n: withFlip.n - noFlip.n,
    wr: withFlip.wr - noFlip.wr,
    pf: withFlip.pf - noFlip.pf,
    ret: withFlip.ret - noFlip.ret,
    dd: withFlip.dd - noFlip.dd,
  },
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-04-st-bnb-flip-exit-one-change.md");
const a = noFlip;
const b = withFlip;
const md = `# ST BNB — flip exit on ATR×${ATR_MULT}+trail+noTP (one change)

**Date:** 2026-08-04  
**Hypothesis:** Full ATR SL holds through adverse ST flips; exit on flip cuts losers earlier.  
**One change:** \`supertrendFuturesExitOnFlip: false → true\`.  
**Base stack:** ATR×${ATR_MULT} SL, trail on, fixed TP off.  
**Window:** ${FROM} → ${TO} · ${SYMBOL} ${TF}

| | Flip off | Flip on |
|--|--|--|
| Trades | ${a.n} | ${b.n} |
| /day | ${a.tradesPerDay?.toFixed?.(2)} | ${b.tradesPerDay?.toFixed?.(2)} |
| WR | ${((a.wr ?? 0) * 100).toFixed(1)}% | ${((b.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${a.pf?.toFixed?.(3) ?? a.pf} | ${b.pf?.toFixed?.(3) ?? b.pf} |
| Return % | ${a.ret?.toFixed?.(1) ?? a.ret} | ${b.ret?.toFixed?.(1) ?? b.ret} |
| Max DD % | ${a.dd?.toFixed?.(1) ?? a.dd} | ${b.dd?.toFixed?.(1) ?? b.dd} |
| Exits | ${JSON.stringify(a.byExit)} | ${JSON.stringify(b.byExit)} |

## Verdict

${
  (b.ret ?? -999) > 0 && (b.pf ?? 0) >= 1
    ? "Promising on this window — needs multi-year + WF before promote."
    : (b.pf ?? 0) > (a.pf ?? 0) + 0.02 || (b.ret ?? -999) > (a.ret ?? -999) + 5
      ? "Flip helps vs no-flip base but **not yet profitable**. Next autopsy on flip vs trail losers."
      : "No material lift (or worse). Archive flip-on for this stack or next named hyp (disaster SL / risk)."
}
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
