#!/usr/bin/env node
/**
 * SOL VP FREQ — Phase 2b A/B after H1 + H2b (bear60 VAL) signal.
 * Autopsy: residual VAH after vacuum block still bleeds; VAL bear60 is the edge.
 *
 * Usage: node scripts/backtest-vp-freq-sol-ab2.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "SOLUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
const START_USDT = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const BASE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: SYMBOL,
  timeframe: TF,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpNoveltyEnabled: false,
  // H1
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: false,
  // H2b
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
};

const VARIANTS = [
  { id: "H2b_baseline", patch: {} },
  {
    id: "H7_no_vah",
    patch: { vpAllowedSetups: ["val_breakdown", "va_rejection", "poc_bounce", "lvn_vacuum", "naked_poc"] },
  },
  {
    id: "H8_val_rej",
    patch: { vpAllowedSetups: ["val_breakdown", "va_rejection"] },
  },
  {
    id: "H9_val_only",
    patch: { vpAllowedSetups: ["val_breakdown"] },
  },
  {
    id: "H10_val_rej_wbvac",
    patch: {
      vpAllowedSetups: ["val_breakdown", "va_rejection"],
      vpValSellBlockWeakBearVacuum: true,
    },
  },
  {
    id: "H11_val_rej_wbvac_chase",
    patch: {
      vpAllowedSetups: ["val_breakdown", "va_rejection"],
      vpValSellBlockWeakBearVacuum: true,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "H12_val_only_wbvac_chase",
    patch: {
      vpAllowedSetups: ["val_breakdown"],
      vpValSellBlockWeakBearVacuum: true,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    id: "H13_val_rej_htf025",
    patch: {
      vpAllowedSetups: ["val_breakdown", "va_rejection"],
      vpValSellBlockWeakBearVacuum: true,
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
      vpMinHtfSepPct: 0.0025,
    },
  },
];

const WINDOWS = [
  { label: "full", from: FROM, to: TO },
  { label: "y2021_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y2022_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y2023_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "y2024_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "y2025_26", from: "2025-06-01", to: "2026-05-31" },
];

function setupBreakdown(trades) {
  const acc = {};
  for (const t of trades) {
    const k = t.vpSetup || String(t.reason || "").replace(/^vp_/, "") || "?";
    if (!acc[k]) acc[k] = { n: 0, pnl: 0 };
    acc[k].n += 1;
    acc[k].pnl += Number(t.netPnl ?? 0);
  }
  for (const v of Object.values(acc)) v.pnl = +v.pnl.toFixed(2);
  return acc;
}

async function runWindow(from, to, patch) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const cfgBase = {
    ...BASE,
    ...patch,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
  const padFrom = volumeProfilePadFromMs(fromMs, TF, cfgBase);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try {
    funding = await readFundingRates(SYMBOL, padFrom, toMs);
  } catch {
    funding = [];
  }
  const cfg = { ...cfgBase, backtestSignalStartMs: fromMs };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
    costModelOverride: {
      leverage: 12,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const windowTrades = closed.filter((t) => {
    const ts = Number(t.entryTs ?? t.entry_time);
    return ts >= fromMs && ts < toMs;
  });
  const m = computeAllMetrics({
    trades: windowTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const days = Math.max(1, (toMs - fromMs) / 86_400_000);
  return {
    trades: windowTrades.length,
    tradesPerWeek: +(windowTrades.length / (days / 7)).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: m.maxDrawdownPct
      ? +((m.totalReturnPct ?? 0) / Math.abs(m.maxDrawdownPct)).toFixed(2)
      : null,
    setups: setupBreakdown(windowTrades),
  };
}

console.log(`\n══ SOL VP FREQ A/B2 ══\n`);
const rows = [];
for (const v of VARIANTS) {
  for (const w of WINDOWS) {
    process.stderr.write(`${v.id} ${w.label}…\n`);
    rows.push({ variant: v.id, window: w.label, ...(await runWindow(w.from, w.to, v.patch)) });
  }
}

function pad(s, w) {
  return String(s ?? "").padEnd(w);
}
console.log(
  `${pad("variant", 28)} ${pad("window", 10)} ${pad("tr", 5)} ${pad("t/wk", 6)} ${pad("WR%", 6)} ${pad("ret%", 9)} ${pad("PF", 6)} ${pad("DD%", 6)} Cal`,
);
console.log("─".repeat(90));
for (const r of rows) {
  console.log(
    `${pad(r.variant, 28)} ${pad(r.window, 10)} ${pad(r.trades, 5)} ${pad(r.tradesPerWeek, 6)} ${pad(r.wr, 6)} ${pad(r.ret, 9)} ${pad(r.pf, 6)} ${pad(r.dd, 6)} ${r.calmar ?? ""}`,
  );
}
console.log("\nFull setup PnL:");
for (const r of rows.filter((x) => x.window === "full")) {
  console.log(`  ${r.variant}:`, JSON.stringify(r.setups));
}

const outPath = path.join(__dirname, ".vp-freq-sol-ab2.json");
fs.writeFileSync(outPath, JSON.stringify({ from: FROM, to: TO, base: BASE, variants: VARIANTS, rows }, null, 2));
console.log(`\nWrote ${outPath}`);
await closePool?.();
