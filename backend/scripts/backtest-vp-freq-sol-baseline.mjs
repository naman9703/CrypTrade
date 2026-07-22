#!/usr/bin/env node
/**
 * SOL VP FREQ — Phase 0 baseline (coin-native).
 *
 * Starts from FREQ CORE + soft HTF (NOT ETH/BTC/BNB locked overlays).
 * Backfills futures 15m if needed, then full-sim year windows + setup PnL +
 * setup-ablation variants to name which SOL setups pay vs bleed.
 *
 * Usage (backend/):
 *   node scripts/backtest-vp-freq-sol-baseline.mjs
 *   SKIP_ENSURE=1 FROM=2021-01-01 TO=2026-05-31 node scripts/backtest-vp-freq-sol-baseline.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "SOLUSDT";
const TF = process.env.TF || "15m";
/** Binance SOLUSDT perp listed ~2020-09-14 — use 2021 for cleaner pad. */
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
const START_USDT = Number(process.env.START_USDT || 100);
const RISK_PCT = Number(process.env.RISK_PCT || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const SKIP_ENSURE = process.env.SKIP_ENSURE === "1";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

/** Phase-0 FREQ core — no coin-specific abstain overlays. */
const SOL_FREQ_CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: SYMBOL,
  timeframe: TF,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
};

const WINDOWS = [
  { label: "full", from: FROM, to: TO },
  { label: "y2021_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y2022_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y2023_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "y2024_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "y2025_26", from: "2025-06-01", to: "2026-05-31" },
];

const VARIANTS = [
  { id: "core_all", label: "FREQ core all setups + HTF 0.15%", patch: {} },
  {
    id: "htf_025",
    label: "HTF sep 0.25%",
    patch: { vpMinHtfSepPct: 0.0025 },
  },
  {
    id: "no_vah",
    label: "Drop vah_breakout",
    patch: {
      vpAllowedSetups: ["lvn_vacuum", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
    },
  },
  {
    id: "no_val",
    label: "Drop val_breakdown",
    patch: {
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "poc_bounce", "va_rejection", "naked_poc"],
    },
  },
  {
    id: "breaks_only",
    label: "VAH+VAL+vacuum+naked",
    patch: {
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "naked_poc"],
    },
  },
  {
    id: "val_only",
    label: "VAL shorts only",
    patch: { vpAllowedSetups: ["val_breakdown"] },
  },
  {
    id: "long_bias",
    label: "Long bias (vah+lvn+naked+rej)",
    patch: {
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "naked_poc", "va_rejection"],
    },
  },
  {
    id: "no_vacuum",
    label: "Drop lvn_vacuum",
    patch: {
      vpAllowedSetups: ["vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
    },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function setupBreakdown(trades) {
  const acc = {};
  for (const t of trades) {
    const k = t.vpSetup || String(t.reason || "").replace(/^vp_/, "") || "?";
    if (!acc[k]) acc[k] = { n: 0, pnl: 0, wins: 0 };
    acc[k].n += 1;
    const pnl = Number(t.netPnl ?? 0);
    acc[k].pnl += pnl;
    if (pnl > 0) acc[k].wins += 1;
  }
  for (const v of Object.values(acc)) {
    v.pnl = +v.pnl.toFixed(2);
    v.wr = v.n ? +((v.wins / v.n) * 100).toFixed(1) : 0;
  }
  return acc;
}

function baseCfg(patch = {}) {
  return {
    ...SOL_FREQ_CORE,
    ...patch,
    symbol: SYMBOL,
    timeframe: TF,
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
  if (!candles?.length || candles.length < 500) {
    return { error: `candles=${candles?.length ?? 0}`, from, to };
  }
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
  const years = {};
  let eq = START_USDT;
  for (const t of windowTrades) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? +(((r.end - r.start) / r.start) * 100).toFixed(2) : 0;
    r.net = +r.net.toFixed(2);
  }
  return {
    from,
    to,
    candles: candles.length,
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
    years,
  };
}

console.log(`\n══ SOL VP FREQ Phase 0 baseline ══`);
console.log(`${SYMBOL} ${TF}  ${FROM} → ${TO}  risk ${RISK_PCT}% lev ${LEVERAGE}x\n`);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const ensureFrom = Date.parse("2020-09-14");

if (!SKIP_ENSURE) {
  process.stderr.write(`ensureKlines ${SYMBOL} ${TF} from ${new Date(ensureFrom).toISOString()}…\n`);
  const ens = await ensureKlines(SYMBOL, TF, { from: ensureFrom, to: toMs, market: "futures" });
  console.log(`ensureKlines: inserted=${ens.inserted} gaps≈${ens.gaps}`);
}

const rows = [];

// Year windows on core_all
for (const w of WINDOWS) {
  process.stderr.write(`Window ${w.label} (${w.from}→${w.to}) core_all…\n`);
  const r = await runWindow(w.from, w.to, {});
  rows.push({ variant: "core_all", window: w.label, ...r });
}

// Ablations on full window only
for (const v of VARIANTS.filter((x) => x.id !== "core_all")) {
  process.stderr.write(`Variant ${v.id} full…\n`);
  const r = await runWindow(FROM, TO, v.patch);
  rows.push({ variant: v.id, window: "full", label: v.label, ...r });
}

function pad(s, w) {
  return String(s ?? "").padEnd(w);
}

console.log("\nYear windows (core_all):");
console.log(
  `${pad("window", 12)} ${pad("tr", 5)} ${pad("t/wk", 6)} ${pad("WR%", 6)} ${pad("ret%", 9)} ${pad("PF", 6)} ${pad("DD%", 6)} Calmar`,
);
console.log("─".repeat(70));
for (const r of rows.filter((x) => x.variant === "core_all")) {
  if (r.error) {
    console.log(`${pad(r.window, 12)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${pad(r.window, 12)} ${pad(r.trades, 5)} ${pad(r.tradesPerWeek, 6)} ${pad(r.wr, 6)} ${pad(r.ret, 9)} ${pad(r.pf, 6)} ${pad(r.dd, 6)} ${r.calmar ?? ""}`,
  );
}

console.log("\nSetup PnL by year window (core_all):");
for (const r of rows.filter((x) => x.variant === "core_all" && !x.error)) {
  console.log(`  ${r.window}:`, JSON.stringify(r.setups));
}

console.log("\nFull-window ablations:");
console.log(
  `${pad("variant", 14)} ${pad("tr", 5)} ${pad("t/wk", 6)} ${pad("WR%", 6)} ${pad("ret%", 9)} ${pad("PF", 6)} DD%`,
);
console.log("─".repeat(70));
for (const r of rows.filter((x) => x.window === "full")) {
  if (r.error) {
    console.log(`${pad(r.variant, 14)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${pad(r.variant, 14)} ${pad(r.trades, 5)} ${pad(r.tradesPerWeek, 6)} ${pad(r.wr, 6)} ${pad(r.ret, 9)} ${pad(r.pf, 6)} ${r.dd}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-sol-baseline.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      symbol: SYMBOL,
      tf: TF,
      from: FROM,
      to: TO,
      risk: RISK_PCT,
      leverage: LEVERAGE,
      core: SOL_FREQ_CORE,
      variants: VARIANTS,
      rows,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);
await closePool?.();
