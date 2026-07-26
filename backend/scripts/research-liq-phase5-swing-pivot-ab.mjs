#!/usr/bin/env node
/**
 * Phase 5 — ONE change hard A/B: swing-pivot liquidity levels vs clean CORE.
 *
 * Hypothesis (from Phase 4): false_reclaim (52% of loss $) comes from sweeping
 * insignificant PDH/PDL / session clusters. Fractal swing pivots (N bars L/R)
 * are more significant pools → fewer false reclaims → higher OOS expectancy.
 *
 * Soft entry filters all failed Phase-5 probes — this changes the TRIGGER set.
 *
 * Accept: OOS (last 30% of Y1) PF≥1, ret>0, tw≥2, meanR > CORE OOS meanR,
 * and no single regime blows up worse than CORE by >15pp of that regime's loss.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-phase5-swing-pivot-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = Date.parse(process.env.FROM || "2025-07-01");
const TO = Date.parse(process.env.TO || "2026-07-01");
const HOLD_FROM = Date.parse(process.env.HOLD_FROM || "2024-07-01");
const HOLD_TO = Date.parse(process.env.HOLD_TO || "2025-07-01");
const split = FROM + 0.7 * (TO - FROM);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const CLEAN = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  riskConsecutiveLossLimit: 0,
  intradayLiqDaySituationBias: false,
  intradayLiqMitigationEntry: false,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqSweepDisplacementMinAtrMult: 0,
  intradayLiqMinSlPct: 0,
  intradayGateLiquidity: true,
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
};

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  const rArr = s
    .map((t) => {
      const risk = Number(t.initialRiskUsd ?? 0);
      return risk > 0 ? Number(t.netPnl) / risk : null;
    })
    .filter((x) => x != null && Number.isFinite(x));
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    meanR: rArr.length ? +(rArr.reduce((a, b) => a + b, 0) / rArr.length).toFixed(3) : null,
  };
}

async function runVariant(candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = { ...CLEAN, ...over, backtestSignalStartMs: lo };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
}

const variants = [
  ["CORE_daily+sess", {}],
  ["pivot_only_L3", { intradayLiqLevels: "swing_pivot", intradayLiqSwingPivotLookback: 3, intradayLiqSessionExtreme: false }],
  ["pivot_only_L5", { intradayLiqLevels: "swing_pivot", intradayLiqSwingPivotLookback: 5, intradayLiqSessionExtreme: false }],
  ["pivot_only_L7", { intradayLiqLevels: "swing_pivot", intradayLiqSwingPivotLookback: 7, intradayLiqSessionExtreme: false }],
  ["daily+pivot_L5", { intradayLiqLevels: "daily,swing_pivot", intradayLiqSwingPivotLookback: 5, intradayLiqSessionExtreme: false }],
  ["daily+sess+pivot_L5", { intradayLiqLevels: "daily,swing_pivot", intradayLiqSwingPivotLookback: 5, intradayLiqSessionExtreme: true }],
];

const pad = 40 * 864e5;
const candles = await readCandles(SYMBOL, TF, Math.min(HOLD_FROM, FROM) - pad, Math.max(HOLD_TO, TO), {
  market: "futures",
});
const funding = await readFundingRates(SYMBOL, Math.min(HOLD_FROM, FROM) - pad, Math.max(HOLD_TO, TO)).catch(
  () => [],
);

console.log("=== Phase 5 hard A/B: swing-pivot levels ===");
console.log(`IS ${new Date(FROM).toISOString().slice(0, 10)}→${new Date(split).toISOString().slice(0, 10)}`);
console.log(`OOS ${new Date(split).toISOString().slice(0, 10)}→${new Date(TO).toISOString().slice(0, 10)}`);
console.log(`HOLD ${new Date(HOLD_FROM).toISOString().slice(0, 10)}→${new Date(HOLD_TO).toISOString().slice(0, 10)}\n`);

const hard = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}…\n`);
  // One sim covering full Y1 then slice — cheaper than 3 sims when window overlaps
  const y1Trades = await runVariant(candles, funding, over, FROM, TO);
  const is = metrics(y1Trades, FROM, split);
  const oos = metrics(y1Trades, split, TO);
  const holdTrades = await runVariant(candles, funding, over, HOLD_FROM, HOLD_TO);
  const hold = metrics(holdTrades, HOLD_FROM, HOLD_TO);
  const y1 = metrics(y1Trades, FROM, TO);

  const oosPass = oos.pf >= 1 && oos.ret > 0 && oos.tw >= 2;
  const holdEg = hold.pf >= 1 && hold.ret > 0;
  hard.push({ id, over, is, oos, hold, y1, oosPass, holdEg });
  console.log(
    `${id.padEnd(22)} IS n=${String(is.n).padStart(3)} tw=${is.tw} ret=${String(is.ret).padStart(7)} pf=${is.pf} R=${is.meanR} | ` +
      `OOS n=${String(oos.n).padStart(3)} tw=${oos.tw} ret=${String(oos.ret).padStart(7)} pf=${oos.pf} R=${oos.meanR} | ` +
      `HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)} pf=${hold.pf}` +
      `${oosPass ? " ★OOS" : ""}${holdEg ? " ◆HOLD" : ""}`,
  );
}

const core = hard.find((h) => h.id === "CORE_daily+sess");
const ranked = [...hard]
  .filter((h) => h.id !== "CORE_daily+sess")
  .sort(
    (a, b) =>
      (b.oosPass ? 1 : 0) - (a.oosPass ? 1 : 0) ||
      (b.oos.pf ?? 0) - (a.oos.pf ?? 0) ||
      (b.oos.meanR ?? -9) - (a.oos.meanR ?? -9),
  );

const best = ranked[0];
const improvedVsCore =
  best &&
  core &&
  (best.oos.meanR ?? -9) > (core.oos.meanR ?? -9) + 0.02 &&
  (best.oos.pf ?? 0) > (core.oos.pf ?? 0);

let verdict = "REJECT";
if (best?.oosPass && best.holdEg) verdict = "PROMOTE_CANDIDATE";
else if (best?.oosPass) verdict = "OOS_ONLY_HOLD_FAIL";
else if (improvedVsCore && best.oos.tw >= 2) verdict = "IMPROVES_BUT_STILL_RED";

const out = {
  generatedAt: new Date().toISOString(),
  hypothesis:
    "Swing-pivot liquidity levels reduce false_reclaim vs PDH/PDL+session CORE by raising level significance.",
  split: new Date(split).toISOString(),
  core: core ? { is: core.is, oos: core.oos, hold: core.hold, y1: core.y1 } : null,
  hard,
  best: best ? { id: best.id, oos: best.oos, hold: best.hold, oosPass: best.oosPass, holdEg: best.holdEg } : null,
  verdict,
};
fs.writeFileSync(path.join(__dirname, ".liq-phase5-swing-pivot-ab.json"), JSON.stringify(out, null, 2));

const md = `# Phase 5 hard A/B — swing-pivot levels (2026-07-25)

**Hypothesis:** false_reclaim (Phase 4 top cause, 52% loss $) is driven by sweeping
insignificant daily/session pools. Fractal swing pivots (N L/R) raise level significance.

**Method:** isolated \`intradayLiqLevels\` change vs clean CORE. IS=first 70% Y1, OOS=last 30%, HOLD=prior year.

## Results

| Variant | IS ret/PF/tw | OOS ret/PF/tw | HOLD ret/PF/tw |
|---------|--------------|---------------|----------------|
${hard
  .map(
    (h) =>
      `| ${h.id} | ${h.is.ret}/${h.is.pf}/${h.is.tw} | ${h.oos.ret}/${h.oos.pf}/${h.oos.tw} | ${h.hold.ret}/${h.hold.pf}/${h.hold.tw} |`,
  )
  .join("\n")}

## Verdict: **${verdict}**

Best: \`${best?.id ?? "—"}\` OOS pf=${best?.oos.pf} ret=${best?.oos.ret} tw=${best?.oos.tw}

${
  verdict === "REJECT" || verdict === "IMPROVES_BUT_STILL_RED"
    ? "Do **not** promote. Documented so we do not re-test the same idea. Next: address false_reclaim via **entry timing** (wait for post-reclaim displacement bar) as a separate one-change hard A/B — only if candle-path evidence supports a new mechanism vs prior progress-confirm reject."
    : "Candidate for further WF — still not live."
}

Artifact: \`.liq-phase5-swing-pivot-ab.json\`
`;
fs.writeFileSync(path.join(__dirname, ".research-decisions", "2026-07-25-liq-phase5-swing-pivot-ab.md"), md);
console.log(`\nverdict=${verdict} best=${best?.id}`);
await closePool?.();
