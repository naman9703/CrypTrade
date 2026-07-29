#!/usr/bin/env node
/**
 * BTC SMC — practical ICT baseline (n≥30) + inducement A/B.
 *
 * Baseline = ladder D: CHoCH + retrace + pd_array SL, MSS off, KZ ALL, no premium.
 * H1'26 alone gave n=36 @ 1.67/wk (freq usable; PF terrible). Expand window for
 * n≥50 when possible. Inducement = one opt-in change only.
 *
 *   SKIP_ENSURE=1 FROM=2025-01-01 TO=2026-06-01 node scripts/research-smc-btc-inducement-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = 10_000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  INTRADAY_PRO_ICT_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = fromMs - 14 * 864e5;
const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));

const PRACTICAL_ICT = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcRequireMss: false,
  intradaySmcRequireBos: false,
  intradaySmcChochStrict: false,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcFvgEntryMode: "zone",
  intradaySmcKillzoneMode: "ALL",
  intradaySmcRequirePremiumDiscount: false,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 8,
  intradaySmcMinRr: 1.5,
  intradaySmcSlMode: "pd_array",
  intradaySmcMaxHoldBars: 48,
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcRequirePdInducement: false,
};

function aggregate(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const cur = m.get(ts) ?? {
      entryTs: ts,
      netPnl: 0,
      mfePct: Number(t.mfePct ?? 0),
      exitReason: t.exitReason,
      techniques: t.techniques,
    };
    cur.netPnl += Number(t.netPnl ?? 0);
    cur.mfePct = Math.max(cur.mfePct, Number(t.mfePct ?? 0));
    cur.exitReason = t.exitReason ?? cur.exitReason;
    if (t.techniques) cur.techniques = t.techniques;
    m.set(ts, cur);
  }
  return [...m.values()].sort((a, b) => a.entryTs - b.entryTs);
}

function metrics(entries) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const e of entries) {
    eq += e.netPnl;
    curve.push({ ts: e.entryTs, equity: eq });
  }
  const m = computeAllMetrics({
    trades: entries.map((e) => ({ entryTs: e.entryTs, exitTs: e.entryTs, netPnl: e.netPnl })),
    equityCurve: curve,
    tf: TF,
    startingEquity: START,
  });
  const wins = entries.filter((e) => e.netPnl > 0).length;
  const neverGreen = entries.filter((e) => e.netPnl <= 0 && e.mfePct <= 0.001).length;
  return {
    n: entries.length,
    tw: +(entries.length / weeks).toFixed(2),
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    neverGreen,
    neverGreenPct: entries.length ? +((neverGreen / entries.length) * 100).toFixed(1) : 0,
  };
}

async function run(label, over = {}) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...PRACTICAL_ICT,
    ...over,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
  const cfg = materializeIntradayEngineCfgSync(raw, materializeIntradayPanelOnCfg);
  const merged = mergeAdaptiveCfg(cfg, candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
      backtestSignalStartMs: fromMs,
    },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: {
      leverage: 12,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  return { id: label, ...metrics(aggregate(sim.trades ?? [])) };
}

console.log(`\n══ BTC inducement A/B — practical ICT — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} weeks=${weeks.toFixed(1)}`);

const variants = [
  { id: "baseline_practical", over: {} },
  { id: "inducement_on", over: { intradaySmcRequirePdInducement: true } },
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  const r = await run(v.id, v.over);
  results.push(r);
  console.log(
    `${r.id.padEnd(22)} n=${String(r.n).padStart(4)} tw=${r.tw} wr=${r.wr}% ret=${r.ret}% pf=${r.pf} neverGreen=${r.neverGreen} (${r.neverGreenPct}%) (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}

const base = results[0];
const ind = results[1];
console.log("\n── Delta (inducement − baseline) ──");
if (base && ind) {
  console.log(
    `Δn=${ind.n - base.n} Δtw=${(ind.tw - base.tw).toFixed(2)} Δret=${(ind.ret - base.ret).toFixed(2)} Δpf=${(ind.pf - base.pf).toFixed(2)} ΔneverGreen=${ind.neverGreen - base.neverGreen}`,
  );
  const sampleOk = ind.n >= 30 || base.n >= 30;
  console.log(`sample_ok_n30=${sampleOk} (base n=${base.n}, ind n=${ind.n})`);
  console.log(
    `verdict=${ind.ret > 0 && ind.pf >= 1 && ind.n >= 30 ? "PROMISING_HOLD_FOR_HOLDOUT" : "REJECT_OR_INCONCLUSIVE"}`,
  );
}

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-inducement-ab.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      window: { from: FROM, to: TO },
      note: "Practical ICT = CHoCH+retrace, no MSS/premium, KZ ALL, pd_array SL. Not shippable.",
      results,
    },
    null,
    2,
  ),
);
console.log("wrote .smc-btc-inducement-ab.json");
await closePool();
