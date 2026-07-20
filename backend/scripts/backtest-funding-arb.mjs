#!/usr/bin/env node
/**
 * Phase 2 — Dual-leg funding cash-and-carry backtest.
 *
 * Usage:
 *   cd backend && node scripts/backtest-funding-arb.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT FROM=2025-01-01 TO=2026-06-01 node scripts/backtest-funding-arb.mjs
 *   FEE_STRESS=2 node scripts/backtest-funding-arb.mjs   # 2× fee sensitivity
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[flag.replace(/^--/, "").toUpperCase().replace(/-/g, "_")] ?? fallback;
}

const SYMBOLS = String(argValue("--symbols", process.env.SYMBOLS || "BTCUSDT,ETHUSDT"))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const FROM_MS = Date.parse(argValue("--from", process.env.FROM || "2025-01-01"));
const TO_MS = Date.parse(argValue("--to", process.env.TO || "2026-06-01"));
const FEE_STRESS = Number(argValue("--fee-stress", process.env.FEE_STRESS || "1"));
const NOTIONAL = Number(argValue("--notional", process.env.NOTIONAL || "10000"));
const LEV = Number(argValue("--leverage", process.env.LEVERAGE || "5"));
const MIN_ANN = Number(argValue("--min-ann", process.env.MIN_ANN || "25"));
const STABILITY = Number(argValue("--stability", process.env.STABILITY || "6"));
const MIN_HOLD = Number(argValue("--min-hold", process.env.MIN_HOLD || "9"));
const EXIT_ANN = Number(argValue("--exit-ann", process.env.EXIT_ANN || "5"));
const FEE_MODE = String(argValue("--fee-mode", process.env.FEE_MODE || "maker")).toLowerCase();
const PROFILE = String(argValue("--profile", process.env.PROFILE || "v2"));

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runFundingArbSim, aggregateFundingArbResults } = await import(
  "../src/backtest/engine/fundingArbSim.js"
);

const warmupMs = 7 * 864e5;
const results = [];

for (const symbol of SYMBOLS) {
  console.log(`\n── ${symbol} ──`);
  try {
    await ensureFunding(symbol, { from: FROM_MS, to: TO_MS });
  } catch (err) {
    console.warn(`  ensureFunding: ${err.message}`);
  }
  const fundingRates = await readFundingRates(symbol, FROM_MS, TO_MS);
  console.log(`  funding settlements: ${fundingRates.length}`);

  // NOTE: ohlcv_candles PK is (symbol, timeframe, open_time) — spot upsert overwrites
  // futures rows. Phase 2 therefore uses futures closes as the spot proxy so we do not
  // corrupt the futures archive. Basis PnL ≈ 0; funding + dual fees remain measurable.
  try {
    const kf = await ensureKlines(symbol, "1h", { from: FROM_MS - warmupMs, to: TO_MS, market: "futures" });
    console.log(`  ensure perp 1h: inserted=${kf.inserted}`);
  } catch (err) {
    console.warn(`  ensure perp: ${err.message}`);
  }

  let perpCandles = [];
  try {
    perpCandles = await readCandles(symbol, "1h", FROM_MS - warmupMs, TO_MS, { market: "futures" });
  } catch (err) {
    console.warn(`  perp candles: ${err.message}`);
  }
  const spotCandles = perpCandles.map((c) => ({ ...c }));
  const spotProxy = true;
  console.log(`  bars: ${perpCandles.length} (spot=perp proxy; basis≈0 by schema)`);

  const sim = runFundingArbSim({
    symbol,
    fundingRates,
    spotCandles,
    perpCandles,
    cfg: {
      minAnnualizedYieldPct: MIN_ANN,
      exitAnnualizedYieldPct: EXIT_ANN,
      stabilityIntervals: STABILITY,
      avgLookback: STABILITY,
      minHoldIntervals: MIN_HOLD,
      feeMode: FEE_MODE,
      notionalUsdt: NOTIONAL,
      perpLeverage: LEV,
      feeStressMult: FEE_STRESS,
    },
  });
  sim.summary.spotProxy = spotProxy;
  if (spotProxy) {
    sim.summary.honestyNotes = [
      ...(sim.summary.honestyNotes || []),
      "spot_proxied_by_perp_closes_ohlcv_pk_limitation",
    ];
  }
  const s = sim.summary;
  console.log(
    `  trades=${s.trades} net=${s.netPnl.toFixed(2)} grossFund=${s.grossFunding.toFixed(2)} ` +
      `fees=${s.fees.toFixed(2)} slip=${s.slipCost.toFixed(2)} basis=${s.basisPnl.toFixed(2)} ann=${s.netAnnualizedOnCapitalPct}% ` +
      `DD=${s.maxDrawdownPct}% honesty=${s.honestyPass ? "PASS" : "FAIL"} [${FEE_MODE}] [spot_proxy]`,
  );
  if (s.honestyNotes.length) console.log(`  notes: ${s.honestyNotes.join(", ")}`);
  results.push(sim);
}

const agg = aggregateFundingArbResults(results);
const generatedAt = new Date().toISOString();

const report = {
  generatedAt,
  profile: PROFILE,
  window: { from: new Date(FROM_MS).toISOString().slice(0, 10), to: new Date(TO_MS).toISOString().slice(0, 10) },
  feeStressMult: FEE_STRESS,
  feeMode: FEE_MODE,
  params: {
    minAnnualizedYieldPct: MIN_ANN,
    exitAnnualizedYieldPct: EXIT_ANN,
    stabilityIntervals: STABILITY,
    minHoldIntervals: MIN_HOLD,
  },
  aggregate: agg,
  perSymbol: results.map((r) => ({ summary: r.summary, tradeCount: r.trades.length })),
  trades: results.flatMap((r) => r.trades),
};

const jsonPath = path.resolve(__dirname, ".funding-arb-backtest.json");
const mdPath = path.resolve(__dirname, ".funding-arb-backtest.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
  `# Funding arb dual-leg backtest (${PROFILE})`,
  ``,
  `Generated: ${generatedAt}`,
  `Window: ${report.window.from} → ${report.window.to}`,
  `Fee mode: **${FEE_MODE}** | stress ${FEE_STRESS}×`,
  `Notional/symbol: ${NOTIONAL} USDT | Perp lev: ${LEV}×`,
  `Entry: min ann ≥ ${MIN_ANN}% for ${STABILITY} consecutive settlements | Exit ann < ${EXIT_ANN}% | Min hold ${MIN_HOLD} settlements`,
  ``,
  `## Aggregate`,
  ``,
  `| Metric | Value |`,
  `|---|---|`,
  `| Trades | ${agg.trades} |`,
  `| Gross funding | ${agg.grossFunding.toFixed(2)} |`,
  `| Basis PnL | ${agg.basisPnl.toFixed(2)} |`,
  `| Fees | ${agg.fees.toFixed(2)} |`,
  `| Slip | ${results.reduce((s, r) => s + r.summary.slipCost, 0).toFixed(2)} |`,
  `| **Net PnL** | **${agg.netPnl.toFixed(2)}** |`,
  `| Capital (peak) | ${agg.capitalDeployedPeak.toFixed(2)} |`,
  `| **Net ann. on capital** | **${agg.netAnnualizedOnCapitalPct}%** |`,
  `| Honesty gate | ${agg.honestyPass ? "PASS" : "FAIL"} |`,
  ``,
  `## Per symbol`,
  ``,
  `| Symbol | Trades | Net | Gross fund | Fees | Basis | Ann% | DD% | Gate |`,
  `|---|---:|---:|---:|---:|---:|---:|---:|---|`,
];
for (const s of agg.perSymbol) {
  mdLines.push(
    `| ${s.symbol} | ${s.trades} | ${s.netPnl.toFixed(2)} | ${s.grossFunding.toFixed(2)} | ${s.fees.toFixed(2)} | ${s.basisPnl.toFixed(2)} | ${s.netAnnualizedOnCapitalPct} | ${s.maxDrawdownPct} | ${s.honestyPass ? "PASS" : "FAIL"} |`,
  );
}
mdLines.push(
  ``,
  `## Honesty doctrine`,
  ``,
  `- Gross funding green but net ≤ 0 after fees/basis/slip → **FAIL** (not “promising”).`,
  `- Re-run with \`FEE_STRESS=2\` — if edge dies, document and do not promote to Phase 3.`,
  `- Compare vs \`SUPERTREND_ELITE\` (~10–21% CAGR) only after net ann > 0 on ≥1y window.`,
  ``,
);
fs.writeFileSync(mdPath, mdLines.join("\n"));

const decisionDir = path.resolve(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const decisionPath = path.join(
  decisionDir,
  `2026-07-14-funding-arb-phase2b-${agg.honestyPass ? "go" : "nogo"}.md`,
);
const vsElite =
  agg.netAnnualizedOnCapitalPct >= 10
    ? "Net ann. overlaps Elite band — still need longer WF + live ops risk (counterparty, leg risk) before replacing directional deployment."
    : agg.honestyPass
      ? "Net positive but below Elite CAGR band — treat as complementary yield sleeve, not Elite replacement."
      : "Net non-positive after costs — **NO-GO** for Phase 3 live/testnet. Do not promote.";

fs.writeFileSync(
  decisionPath,
  [
    `# Decision — Funding arb Phase 2b (anti-churn)`,
    ``,
    `Date: ${generatedAt.slice(0, 10)}`,
    `Window: ${report.window.from} → ${report.window.to}`,
    `Symbols: ${SYMBOLS.join(", ")}`,
    `Profile: ${PROFILE}`,
    `Fee mode: ${FEE_MODE} | stress: ${FEE_STRESS}×`,
    `Entry: ≥${MIN_ANN}% ann × ${STABILITY} consecutive | Min hold: ${MIN_HOLD} | Exit ann: ${EXIT_ANN}%`,
    ``,
    `## Changes vs Phase 2a (FAILED)`,
    ``,
    `- Raised entry threshold 8% → ${MIN_ANN}% ann`,
    `- Stability requires consecutive settlements *above* threshold (not just same sign)`,
    `- Min hold ${MIN_HOLD} settlements before soft yield-decay exit (flips still exit)`,
    `- Default fee path: **maker** (perp maker ~2bps, spot maker ~10bps, slip 1bp/leg)`,
    ``,
    `## Result`,
    ``,
    `- Trades: ${agg.trades} (was 95 in Phase 2a)`,
    `- Net PnL: ${agg.netPnl.toFixed(2)} USDT`,
    `- Net annualized on capital: ${agg.netAnnualizedOnCapitalPct}%`,
    `- Honesty gate: **${agg.honestyPass ? "PASS" : "FAIL"}**`,
    ``,
    `## Verdict vs SUPERTREND_ELITE`,
    ``,
    vsElite,
    ``,
    `## Next`,
    ``,
    agg.honestyPass
      ? "- Run FEE_STRESS=2 and feeMode=taker sensitivity; if still PASS, consider Phase 3 paper dual-leg."
      : "- If still FAIL: further raise threshold / hold, or abandon; keep Elite as primary deployable stream.",
    ``,
    `Artifacts: \`.funding-arb-backtest.json\`, \`.funding-arb-backtest.md\``,
    ``,
  ].join("\n"),
);

console.log("\n═══ Aggregate ═══");
console.log(
  `profile=${PROFILE} feeMode=${FEE_MODE} trades=${agg.trades} net=${agg.netPnl.toFixed(2)} ann=${agg.netAnnualizedOnCapitalPct}% honesty=${agg.honestyPass ? "PASS" : "FAIL"}`,
);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${decisionPath}`);

await closePool();
