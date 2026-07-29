#!/usr/bin/env node
/**
 * BTC SMC — practical frequency ladder (true ICT core, not reclaim-sweep).
 *
 * Keeps CHoCH + FVG/OB retrace (guide entry). Peels N-crushers one at a time:
 * premium/discount, killzone, MSS, session extreme, pick caps.
 * Target lens: ≥1–2 trades/week with FULL/OOS not deeply red.
 *
 *   SKIP_ENSURE=1 FROM=2026-01-01 TO=2026-06-01 node scripts/research-smc-btc-practical-freq-ladder.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2026-01-01";
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
  INTRADAY_PRO_ICT_RESEARCH_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = fromMs - 14 * 864e5;
const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));

/** ICT core: CHoCH + retrace into PD array. MSS/KZ/PD are ladder knobs. */
const ICT_CORE = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcChochStrict: false,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcFvgEntryMode: "zone",
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
};

function aggregate(trades) {
  const m = new Map();
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const cur = m.get(ts) ?? { entryTs: ts, netPnl: 0 };
    cur.netPnl += Number(t.netPnl ?? 0);
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
  return {
    n: entries.length,
    tw: +(entries.length / weeks).toFixed(2),
    wr: entries.length ? +((wins / entries.length) * 100).toFixed(1) : 0,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  };
}

async function run(label, over) {
  clearIntradayAdapterCache?.();
  const raw = {
    ...ICT_CORE,
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
  const m = metrics(aggregate(sim.trades ?? []));
  return { id: label, over, ...m };
}

console.log(`\n══ BTC practical ICT freq ladder — ${FROM}→${TO} ══`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} weeks=${weeks.toFixed(1)}`);

const variants = [
  {
    id: "A_guide_full",
    over: {
      intradaySmcRequireMss: true,
      intradaySmcKillzoneMode: "LONDON_NY",
      intradaySmcRequirePremiumDiscount: true,
    },
  },
  {
    id: "B_no_premium",
    over: {
      intradaySmcRequireMss: true,
      intradaySmcKillzoneMode: "LONDON_NY",
      intradaySmcRequirePremiumDiscount: false,
    },
  },
  {
    id: "C_kz_all",
    over: {
      intradaySmcRequireMss: true,
      intradaySmcKillzoneMode: "ALL",
      intradaySmcRequirePremiumDiscount: false,
    },
  },
  {
    id: "D_no_mss",
    over: {
      intradaySmcRequireMss: false,
      intradaySmcKillzoneMode: "ALL",
      intradaySmcRequirePremiumDiscount: false,
    },
  },
  {
    id: "E_choch_retrace_kzLN",
    over: {
      intradaySmcRequireMss: false,
      intradaySmcKillzoneMode: "LONDON_NY",
      intradaySmcRequirePremiumDiscount: false,
    },
  },
  {
    id: "F_research_preset",
    over: {
      ...INTRADAY_PRO_ICT_RESEARCH_15M,
      symbol: SYMBOL,
      timeframe: TF,
      intradaySmcOneTradePerDay: false,
      intradayLiqOnePickPerDay: false,
      srIntradayMaxTradesPerDay: 8,
      intradaySmcSlMode: "pd_array",
      intradaySmcKillzoneMode: "ALL",
    },
  },
  {
    id: "G_sweep_broken_ref",
    over: {
      ...INTRADAY_PRO_ICT_15M,
      symbol: SYMBOL,
      timeframe: TF,
      intradaySmcSlMode: "structure",
    },
  },
];

const results = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const t0 = Date.now();
  // F/G replace ICT_CORE via spread in over that includes full preset keys —
  // for F/G pass preset as base by merging carefully
  let r;
  if (v.id === "F_research_preset" || v.id === "G_sweep_broken_ref") {
    clearIntradayAdapterCache?.();
    const raw = {
      ...(v.id === "F_research_preset" ? INTRADAY_PRO_ICT_RESEARCH_15M : INTRADAY_PRO_ICT_15M),
      ...v.over,
      symbol: SYMBOL,
      timeframe: TF,
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
    r = { id: v.id, over: v.over, ...metrics(aggregate(sim.trades ?? [])) };
  } else {
    r = await run(v.id, v.over);
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  results.push(r);
  const freqOk = r.tw >= 1.5 ? "FREQ~OK" : r.tw >= 0.5 ? "THIN" : "STARVED";
  console.log(
    `${r.id.padEnd(22)} n=${String(r.n).padStart(4)} tw=${String(r.tw).padStart(5)} wr=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(8)}% pf=${r.pf} ${freqOk} (${sec}s)`,
  );
}

results.sort((a, b) => {
  const aOk = a.tw >= 1.0 && a.ret > 0 ? 2 : a.tw >= 1.0 ? 1 : 0;
  const bOk = b.tw >= 1.0 && b.ret > 0 ? 2 : b.tw >= 1.0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  if (b.ret !== a.ret) return b.ret - a.ret;
  return b.tw - a.tw;
});

console.log("\n══ Rank (freq≥1/wk + ret>0 first) ══");
for (const r of results) {
  console.log(`${r.id.padEnd(22)} tw=${r.tw} n=${r.n} ret=${r.ret}% wr=${r.wr}%`);
}

fs.writeFileSync(
  path.join(__dirname, ".smc-btc-practical-freq-ladder.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, to: TO, results }, null, 2),
);
console.log("wrote .smc-btc-practical-freq-ladder.json");
await closePool();
