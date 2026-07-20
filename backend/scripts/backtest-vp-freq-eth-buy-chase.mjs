#!/usr/bin/env node
/**
 * ETH VP FREQ — baseline vs VAH buy-chase filter (prior5d).
 *
 * Hypothesis: 2022–23 VAH longs lost because they chased relief rallies after
 * sharp ~5d bounces (dead-cat / short-covering). Block BUY vah_breakout when
 * prior5d > 8%; optional non-bull-only mode keeps strong bear-to-bull trend
 * continuation VAH longs alive.
 *
 * Usage (from backend/):
 *   node scripts/backtest-vp-freq-eth-buy-chase.mjs
 *   FROM=2022-06-01 TO=2023-05-31 node scripts/backtest-vp-freq-eth-buy-chase.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2022-06-01";
const TO = process.env.TO || "2026-05-31";
const TF = "15m";
const SYMBOL = "ETHUSDT";
const RISK = 2.5;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function yearBucket(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function summarizeByYear(trades) {
  const years = {};
  let eq = 100;
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const y = yearBucket(Number(t.entryTs ?? t.entry_time));
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq, buys: 0, vah: 0 };
    const pnl = Number(t.netPnl ?? 0);
    const reason = String(t.entryReason ?? t.reason ?? "");
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    if (String(t.direction ?? t.side).toUpperCase() === "BUY") years[y].buys += 1;
    if (reason.includes("vah_breakout")) years[y].vah += 1;
    eq += pnl;
    years[y].end = eq;
  }
  for (const y of Object.keys(years)) {
    const r = years[y];
    r.wr = r.n ? (r.wins / r.n) * 100 : 0;
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

async function runCfg(label, patch) {
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    ...patch,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
  };
  const padFrom = volumeProfilePadFromMs(fromMs, TF, cfg);
  if (process.env.ENSURE_KLINES === "1") {
    try {
      await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
    } catch (err) {
      console.warn(`[buy-chase] ensureKlines skipped: ${err?.message || err}`);
    }
  }
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  if (!candles.length) throw new Error(`no_candles ${SYMBOL} ${TF}`);
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) {
      wins += 1;
      grossWin += pnl;
    } else if (pnl < 0) {
      grossLoss += -pnl;
    }
  }
  const metrics = {
    totalTrades: closed.length,
    totalReturnPct: eq - 100,
    maxDrawdownPct: maxDd,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
  };
  const years = summarizeByYear(closed);
  console.log(`\n=== ${label} ===`);
  console.log(
    `N=${metrics.totalTrades} ret=${(metrics.totalReturnPct ?? 0).toFixed(1)}% DD=${(metrics.maxDrawdownPct ?? 0).toFixed(1)}%`,
  );
  for (const [y, r] of Object.entries(years).sort()) {
    console.log(
      `  ${y}: n=${r.n} wr=${r.wr.toFixed(0)}% ret=${r.retPct.toFixed(1)}% net=$${r.net.toFixed(1)} buys=${r.buys} vah=${r.vah}`,
    );
  }
  return {
    label,
    n: metrics.totalTrades,
    ret: metrics.totalReturnPct,
    dd: metrics.maxDrawdownPct,
    wr: metrics.winRate,
    pf: metrics.profitFactor,
    chase: cfg.vpBuyChaseFilter === true,
    maxPrior5d: cfg.vpBuyChaseMaxPrior5dPct,
    years,
  };
}

const baseline = await runCfg("baseline (chase OFF)", {
  vpBuyChaseFilter: false,
});
const chase = await runCfg("buy-chase ON (prior5d>8%)", {
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
});
const chaseNonBull = await runCfg("buy-chase ON non-bull only", {
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
  vpBuyChaseNonBullOnly: true,
  vpBuyChaseBullPrior60dPct: 0.05,
});

const out = {
  from: FROM,
  to: TO,
  baseline,
  chase,
  chaseNonBull,
};
const outPath = path.resolve(__dirname, ".vp-freq-eth-buy-chase.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);

await closePool?.();
