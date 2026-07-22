#!/usr/bin/env node
/**
 * SOL VP FREQ — sequential one-change A/B on full + year windows.
 * H1: block vacuum VAH (path≥2%) always
 * H2: + VAL require bear prior60
 * H3: + block weak_bear vacuum VAL
 * H4: + VAL prior5d chase filter @5%
 * H5: + block flat prior60 VAL
 * H6: allowlist VAL+structured VAH + va_rejection (drop poc)
 *
 * Usage: node scripts/backtest-vp-freq-sol-ab.mjs
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
const RISK_PCT = 2.5;
const LEVERAGE = 12;

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

const CORE = {
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
};

const H1 = {
  // Block ALL vacuum VAH (path≥2%) — SOL autopsy: vacuum VAH −$89, structured +$11
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: false,
};

const H2 = {
  ...H1,
  // Surgical bull60 VAL abstains (keep paying bull_chop structured / some bull_trend vac)
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellBlockBull60Extending: true,
  vpValSellBull60ExtendRatio: 0.6,
};

const H2_bear_only = {
  ...H1,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
};

const H3 = {
  ...H2,
  vpValSellBlockWeakBearVacuum: true,
};

const H4 = {
  ...H3,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
};

const H5 = {
  ...H4,
  vpValSellBlockFlatPrior60: true,
  vpValSellFlatPrior60LoPct: -0.05,
  vpValSellFlatPrior60HiPct: 0.05,
};

const H6 = {
  ...H5,
  vpAllowedSetups: ["vah_breakout", "val_breakdown", "va_rejection"],
};

const VARIANTS = [
  { id: "core", patch: {} },
  { id: "H1_block_vac_vah", patch: H1 },
  { id: "H2_bull60_surg", patch: H2 },
  { id: "H2b_val_bear60", patch: H2_bear_only },
  { id: "H3_weak_bear_vac", patch: H3 },
  { id: "H4_val_chase5", patch: H4 },
  { id: "H5_flat60", patch: H5 },
  { id: "H6_no_poc", patch: H6 },
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

function baseCfg(patch = {}) {
  return {
    ...CORE,
    ...patch,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
}

async function runWindow(from, to, patch) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const cfgBase = baseCfg(patch);
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
      leverage: LEVERAGE,
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
    setups: setupBreakdown(windowTrades),
  };
}

console.log(`\n══ SOL VP FREQ A/B ══ ${FROM}→${TO}\n`);
const rows = [];

for (const v of VARIANTS) {
  for (const w of WINDOWS) {
    // Year windows only for core, H1, and best candidate chain endpoints to save time
    if (w.label !== "full" && !["core", "H1_block_vac_vah", "H2_bull60_surg", "H5_flat60", "H6_no_poc"].includes(v.id)) {
      continue;
    }
    process.stderr.write(`${v.id} ${w.label}…\n`);
    const r = await runWindow(w.from, w.to, v.patch);
    rows.push({ variant: v.id, window: w.label, ...r });
  }
}

function pad(s, w) {
  return String(s ?? "").padEnd(w);
}

console.log("\nResults:");
console.log(
  `${pad("variant", 20)} ${pad("window", 10)} ${pad("tr", 5)} ${pad("t/wk", 6)} ${pad("WR%", 6)} ${pad("ret%", 9)} ${pad("PF", 6)} DD%`,
);
console.log("─".repeat(78));
for (const r of rows) {
  console.log(
    `${pad(r.variant, 20)} ${pad(r.window, 10)} ${pad(r.trades, 5)} ${pad(r.tradesPerWeek, 6)} ${pad(r.wr, 6)} ${pad(r.ret, 9)} ${pad(r.pf, 6)} ${r.dd}`,
  );
}

console.log("\nFull setup PnL:");
for (const r of rows.filter((x) => x.window === "full")) {
  console.log(`  ${r.variant}:`, JSON.stringify(r.setups));
}

const outPath = path.join(__dirname, ".vp-freq-sol-ab.json");
fs.writeFileSync(outPath, JSON.stringify({ from: FROM, to: TO, rows }, null, 2));
console.log(`\nWrote ${outPath}`);
await closePool?.();
