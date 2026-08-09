#!/usr/bin/env node
/**
 * Autopsy + one-change A/B: ATR-stop ST + RSI/EMA20 stretch skip.
 *
 * Named failure mode (from XGB importance + ATR-stop set): entries that chase
 * after the flip — stretched vs EMA20 / RSI extreme in trade direction — die to SL.
 *
 * Rule (one concept — "no chase"):
 *   BUY  skip if dist_ema20_pct > emaStretchPct  OR rsi14 > rsiHigh
 *   SELL skip if dist_ema20_pct < -emaStretchPct OR rsi14 < rsiLow
 *
 * Usage:
 *   FROM=2025-01-01 TO=2026-08-02 ATR_MULT=3 node scripts/research-st-stretch-skip-bnb.mjs
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
const ATR_MULT = Number(process.env.ATR_MULT || 3);
const BASELINE_RUN_ID = process.env.BASELINE_RUN_ID || "db6a6e92-61e9-4177-8fe9-f0346393fc94";
const EMA_STRETCH = Number(process.env.EMA_STRETCH_PCT || 0.15); // percent points
const RSI_HIGH = Number(process.env.RSI_HIGH || 55);
const RSI_LOW = Number(process.env.RSI_LOW || 45);

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
const { buildIndicatorSeries, featuresAtBar } = await import("../src/backtest/reporting/tradeCsvFeatures.js");

function pickBot(snap) {
  if (!snap || typeof snap !== "object") return {};
  if (snap.bot && typeof snap.bot === "object") return { ...snap.bot };
  return { ...snap };
}

function findBarIndex(candles, entryTs) {
  const t = Number(entryTs);
  if (!Number.isFinite(t)) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ts = Number(candles[mid].ts);
    if (ts === t) return mid;
    if (ts < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function isWeakFlip({ side, distEma20, rsi }, opts) {
  const d = Number(distEma20);
  const r = Number(rsi);
  const stretch = Number(opts.emaStretchPct);
  const hi = Number(opts.rsiHigh);
  const lo = Number(opts.rsiLow);
  if (String(side).toUpperCase() === "BUY" || String(side).toUpperCase() === "LONG") {
    if (Number.isFinite(d) && d < -stretch) return true;
    if (Number.isFinite(r) && r < lo) return true;
    return false;
  }
  if (Number.isFinite(d) && d > stretch) return true;
  if (Number.isFinite(r) && r > hi) return true;
  return false;
}

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const runRes = await pool.query(
  `SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id = $1`,
  [BASELINE_RUN_ID],
);
if (!runRes.rows.length) {
  console.error(JSON.stringify({ ok: false, error: "baseline_run_not_found" }));
  process.exit(1);
}
const snap = runRes.rows[0].config_snapshot;
const baseBot = pickBot(typeof snap === "string" ? JSON.parse(snap) : snap);
const startUsdt = Number(runRes.rows[0].initial_capital) || START_USDT;

const atrCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  supertrendFuturesFixedSlPct: Number(baseBot.supertrendFuturesFixedSlPct ?? 0.003),
  slAtrMultiplier: ATR_MULT,
  supertrendXgbGateEnabled: false,
};

console.error(`[research] candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}
const series = buildIndicatorSeries(candles);

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
  return { label, ms: Date.now() - t0, sim, m };
}

const atrOnly = await runOne("atr_stop", atrCfg);

// Autopsy stretch on ATR-stop trades
const rows = [];
for (const t of atrOnly.sim.trades) {
  const entryTs = t.entryTs ?? t.entry_ts;
  const idx = findBarIndex(candles, entryTs instanceof Date ? entryTs.getTime() : entryTs);
  if (idx < 0) continue;
  const f = featuresAtBar(candles, series, idx);
  const side = String(t.side || t.direction || "").toUpperCase();
  const net = Number(t.netPnl ?? t.net_pnl);
  const win = Number.isFinite(net) ? net > 0 : false;
  const weak = isWeakFlip(
    { side, distEma20: f.distToEma20Pct, rsi: f.rsi14 },
    { emaStretchPct: EMA_STRETCH, rsiHigh: RSI_HIGH, rsiLow: RSI_LOW },
  );
  rows.push({
    side,
    win,
    net,
    dist: f.distToEma20Pct,
    rsi: f.rsi14,
    stretched: weak,
  });
}

const stretched = rows.filter((r) => r.stretched);
const kept = rows.filter((r) => !r.stretched);
function bucketStats(arr) {
  if (!arr.length) return { n: 0, wr: null, meanNet: null };
  const wins = arr.filter((r) => r.win).length;
  const meanNet = arr.reduce((s, r) => s + (Number(r.net) || 0), 0) / arr.length;
  return { n: arr.length, wr: wins / arr.length, meanNet };
}

const autopsy = {
  rule: { emaStretchPct: EMA_STRETCH, rsiHigh: RSI_HIGH, rsiLow: RSI_LOW },
  all: bucketStats(rows),
  stretched: bucketStats(stretched),
  keptIfSkip: bucketStats(kept),
};

const stretchCfg = {
  ...atrCfg,
  supertrendStretchSkipEnabled: true,
  supertrendStretchEma20Pct: EMA_STRETCH,
  supertrendStretchRsiHigh: RSI_HIGH,
  supertrendStretchRsiLow: RSI_LOW,
};

const withSkip = await runOne("atr_stop_plus_stretch_skip", stretchCfg);

function summarize(label, m, sim) {
  const sl = sim.trades.filter((t) => String(t.exitReason || "") === "sl");
  const slLe2 = sl.filter((t) => Number(t.barsHeld ?? 99) <= 2);
  return {
    label,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    pctSlLe2: sl.length ? slLe2.length / sl.length : null,
    stretchReplay: sim.stretchSkipReplay ?? null,
  };
}

const out = {
  ok: true,
  hypothesis:
    "ATR-stop ST: skip weak/counter-stretched flips (require WITH-trend EMA20/RSI). Prior no-chase rule failed autopsy.",
  window: { symbol: SYMBOL, tf: TF, from: FROM, to: TO, bars: candles.length, atrMult: ATR_MULT },
  autopsy: {
    ...autopsy,
    note: "stretched bucket = weak flips that the rule skips",
  },
  atrOnly: summarize("atr_stop", atrOnly.m, atrOnly.sim),
  atrPlusStretch: summarize("atr_plus_stretch", withSkip.m, withSkip.sim),
};

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-04-st-bnb-stretch-skip-one-change.md");
const a = out.atrOnly;
const b = out.atrPlusStretch;
const md = `# ST BNB — ATR stop + RSI/EMA stretch skip (one change)

**Date:** 2026-08-04  
**Base:** ATR×${ATR_MULT} stop (prior experiment)  
**One added rule:** skip **weak** ST flips (require WITH-trend stretch)  
\`BUY: skip if dist_ema20 < -${EMA_STRETCH}% OR rsi < ${RSI_LOW}\` · \`SELL: skip if dist_ema20 > ${EMA_STRETCH}% OR rsi > ${RSI_HIGH}\`

(First “no-chase” thresholds failed autopsy — stretched WITH flip were *better*; rule inverted.)

## Trade-set autopsy (ATR-stop only) — weak bucket = would skip

| Bucket | N | WR | mean net |
|--|--|--|--|
| All | ${autopsy.all.n} | ${autopsy.all.wr != null ? (autopsy.all.wr * 100).toFixed(1) + "%" : "—"} | ${autopsy.all.meanNet?.toFixed?.(2) ?? "—"} |
| Weak (skip) | ${autopsy.stretched.n} | ${autopsy.stretched.wr != null ? (autopsy.stretched.wr * 100).toFixed(1) + "%" : "—"} | ${autopsy.stretched.meanNet?.toFixed?.(2) ?? "—"} |
| Kept | ${autopsy.keptIfSkip.n} | ${autopsy.keptIfSkip.wr != null ? (autopsy.keptIfSkip.wr * 100).toFixed(1) + "%" : "—"} | ${autopsy.keptIfSkip.meanNet?.toFixed?.(2) ?? "—"} |

## Full sim

| | ATR×${ATR_MULT} | + stretch skip |
|--|--|--|
| Trades | ${a.n} | ${b.n} |
| WR | ${((a.wr ?? 0) * 100).toFixed(1)}% | ${((b.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${a.pf?.toFixed?.(3) ?? a.pf} | ${b.pf?.toFixed?.(3) ?? b.pf} |
| Return % | ${a.ret?.toFixed?.(1) ?? a.ret} | ${b.ret?.toFixed?.(1) ?? b.ret} |
| Max DD % | ${a.dd?.toFixed?.(1) ?? a.dd} | ${b.dd?.toFixed?.(1) ?? b.dd} |
| Replay | — | ${JSON.stringify(b.stretchReplay)} |

## Verdict

${
  (b.ret ?? -999) > 0 && (b.pf ?? 0) >= 1
    ? "Promising on this window — needs longer OOS / WF before promote."
    : (b.pf ?? 0) > (a.pf ?? 0) || (b.ret ?? -999) > (a.ret ?? -999)
      ? "Stretch skip helps vs ATR-only but **not yet profitable**. Next one change only after new autopsy."
      : "No lift — revisit thresholds from autopsy or try trail exit next."
}
`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ ...out, decisionLog: mdPath }, null, 2));
await closePool?.();
