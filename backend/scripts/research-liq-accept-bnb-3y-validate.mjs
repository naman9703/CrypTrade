#!/usr/bin/env node
/**
 * BNB LIQ_ACCEPT vs LIQ_CORE — 3y full sim + holdout + WF + MC + acceptance gates.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-accept-bnb-3y-validate.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2023-07-01";
const TO = process.env.TO || "2026-07-01";
const HOLD_FROM = process.env.HOLD_FROM || "2025-07-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdFromMs = Date.parse(HOLD_FROM);

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
  INTRADAY_PRO_LIQ_ACCEPT_BNB_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

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
  const years = Math.max(0.01, (hi - lo) / (365.25 * 864e5));
  const totalRet = Number(m.totalReturnPct ?? 0);
  const cagr = years > 0 ? (Math.pow(Math.max(1e-9, 1 + totalRet / 100), 1 / years) - 1) * 100 : 0;
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +totalRet.toFixed(2),
    cagr: +cagr.toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    cal: +(m.calmar ?? 0).toFixed(2),
    rMultiples: s.map((t) => Number(t.rMultiple ?? t.r ?? 0)).filter((x) => Number.isFinite(x)),
  };
}

function yearSlices(lo, hi) {
  const out = [];
  let y = new Date(lo).getUTCFullYear();
  const endY = new Date(hi - 1).getUTCFullYear();
  while (y <= endY) {
    const a = Math.max(lo, Date.UTC(y, 0, 1));
    const b = Math.min(hi, Date.UTC(y + 1, 0, 1));
    if (b > a) out.push({ year: y, lo: a, hi: b });
    y += 1;
  }
  return out;
}

function baseCfg(over = {}) {
  const playbook = String(over.intradayLiqPlaybook ?? INTRADAY_PRO_LIQ_ACCEPT_BNB_15M.intradayLiqPlaybook ?? "LIQ_ACCEPT").toUpperCase();
  const presetBase =
    playbook === "LIQ_CORE" ? INTRADAY_PRO_LIQ_CORE_15M : INTRADAY_PRO_LIQ_ACCEPT_BNB_15M;
  let cfg = {
    ...presetBase,
    ...over,
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
    backtestSignalStartMs: fromMs,
  };
  if (playbook === "LIQ_CORE") {
    cfg.intradayLiqClassicEnabled = cfg.intradayLiqClassicEnabled ?? true;
    cfg.intradayLiqAcceptEnabled = false;
  } else {
    cfg.intradayLiqClassicEnabled = false;
    cfg.intradayLiqAcceptEnabled = cfg.intradayLiqAcceptEnabled ?? true;
  }
  return materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
}

async function load() {
  const pad = 21 * 864e5;
  const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
  const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
  return { candles, funding };
}

async function runSim(candles, funding, over = {}) {
  clearIntradayAdapterCache?.();
  const cfg = baseCfg(over);
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
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

async function validateVariant(label, over = {}) {
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  const trades = await runSim(candles, funding, over);
  const full = metrics(trades, fromMs, toMs);
  const hold = metrics(trades, holdFromMs, toMs);
  const is = metrics(trades, fromMs, holdFromMs);

  console.log(
    `FULL  n=${full.n} ${full.tw}/wk ret=${full.ret}% PF=${full.pf} WR=${full.wr}% DD=${full.dd}% Cal=${full.cal}`,
  );
  console.log(
    `IS    n=${is.n} ${is.tw}/wk ret=${is.ret}% PF=${is.pf} WR=${is.wr}%`,
  );
  console.log(
    `HOLD  n=${hold.n} ${hold.tw}/wk ret=${hold.ret}% PF=${hold.pf} WR=${hold.wr}%`,
  );

  console.log("\nYear table:");
  for (const { year, lo, hi } of yearSlices(fromMs, toMs)) {
    const y = metrics(trades, lo, hi);
    console.log(`  ${year}  n=${String(y.n).padStart(4)} ${String(y.tw).padStart(5)}/wk ret=${String(y.ret).padStart(7)}% PF=${y.pf}`);
  }

  const oosTrades = trades.filter(
    (t) => Number(t.entryTs) >= holdFromMs && String(t.exitReason ?? "") !== "tp1_partial",
  );
  const mc = monteCarloBootstrap(oosTrades.map((t) => Number(t.rMultiple ?? t.r ?? 0)), {
    iterations: 2000,
    startingEquity: 100,
    riskPct: 2.5,
  });

  const wfSplits = purgedWalkForwardSplits(fromMs, toMs, { nFolds: 4, embargoDays: 1 });
  let wfDeg = 0;
  const wfRows = [];
  for (const sp of wfSplits) {
    const tr = metrics(trades, sp.trainLo, sp.trainHi);
    const te = metrics(trades, sp.testLo, sp.testHi);
    const deg = tr.pf > 0 ? ((tr.pf - te.pf) / tr.pf) * 100 : 0;
    wfDeg = Math.max(wfDeg, deg);
    wfRows.push({ tr, te, deg });
  }

  const gate = acceptanceGates({
    oosReturnPct: hold.ret,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: hold.cal,
    walkForwardDegradationPct: wfDeg,
  });

  console.log("\nWalk-forward (max degradation):");
  for (let i = 0; i < wfRows.length; i++) {
    const w = wfRows[i];
    console.log(
      `  fold${i + 1} train PF=${w.tr.pf} ret=${w.tr.ret}% | test PF=${w.te.pf} ret=${w.te.ret}% deg=${w.deg.toFixed(1)}%`,
    );
  }
  console.log(`  MC p5=${mc.insufficient ? "N/A" : mc.p5ReturnPct.toFixed(2)}%`);
  console.log("\nAcceptance gates:");
  for (const [name, g] of Object.entries(gate.gates)) {
    console.log(`  ${g.pass ? "PASS" : "FAIL"} ${name.padEnd(20)} ${Number(g.value).toFixed(2)} (need ${g.threshold})`);
  }
  console.log(`VERDICT: ${gate.allPass ? "ACCEPTED" : "REJECTED"}`);

  return { label, full, hold, is, gate, trades, wfDeg, mc };
}

const { candles, funding } = await load();
console.log(`BNB LIQ_ACCEPT validation | ${candles.length} bars | ${FROM} → ${TO} | hold ${HOLD_FROM}+`);

const variants = [
  ["CORE baseline (X4+T1+P1)", { ...INTRADAY_PRO_LIQ_CORE_15M, intradayLiqPlaybook: "LIQ_CORE" }],
  ["ACCEPT H0 (hold2 ext0.003)", { intradayLiqPlaybook: "LIQ_ACCEPT" }],
  ["ACCEPT H1 (hold1)", { intradayLiqPlaybook: "LIQ_ACCEPT", intradayLiqAcceptHoldBars: 1 }],
  ["ACCEPT H3 (hold3)", { intradayLiqPlaybook: "LIQ_ACCEPT", intradayLiqAcceptHoldBars: 3 }],
  ["ACCEPT no minExt", { intradayLiqPlaybook: "LIQ_ACCEPT", intradayLiqMinSweepExtensionPct: 0 }],
  ["ACCEPT HTF align", { intradayLiqPlaybook: "LIQ_ACCEPT", intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true }],
  ["ACCEPT maxTpRr=3", { intradayLiqPlaybook: "LIQ_ACCEPT", intradayLiqMaxTpRr: 3 }],
];

const results = [];
for (const [label, over] of variants) {
  results.push(await validateVariant(label, over));
}

const outPath = path.join(__dirname, ".liq-accept-bnb-3y-validate.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      symbol: SYMBOL,
      from: FROM,
      to: TO,
      holdFrom: HOLD_FROM,
      results: results.map((r) => ({
        label: r.label,
        full: r.full,
        hold: r.hold,
        is: r.is,
        wfDeg: r.wfDeg,
        mcP5: r.mc.insufficient ? null : r.mc.p5ReturnPct,
        gates: r.gate,
      })),
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);

await closePool?.();
