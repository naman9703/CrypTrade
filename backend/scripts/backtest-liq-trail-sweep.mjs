/**
 * Trailing-stop sweep for INTRADAY_PRO liquidity sweep (BNB 15m).
 * Usage: node scripts/backtest-liq-trail-sweep.mjs [--quick] [--with-tp]
 *
 * Default: SL-only liq exits (TP1/TP2/BE off) + structure SL + trailing.
 * --with-tp: also sweep top configs with default TP1+TP2+BE enabled.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const quick = process.argv.includes("--quick");
const withTp = process.argv.includes("--with-tp");
const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = new Date("2026-01-01").getTime();
const TO = new Date("2026-05-27").getTime();
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const {
  fillLiqSoloPresetDefaults,
  fillFibSoloPresetDefaults,
  INTRADAY_PRO_LIQ_15M,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

console.log("Loading candles…");
const candles = await readCandles(SYMBOL, TF, FROM - 5 * 864e5, TO);
console.log(`  ${candles.length} bars (${SYMBOL} ${TF})\n`);

function aggregateTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${new Date(t.entryTs).toISOString().slice(0, 16)}:${t.direction}`;
    if (!m.has(k)) m.set(k, { pnl: 0, wins: 0, reasons: [] });
    const o = m.get(k);
    o.pnl += Number(t.netPnl);
    if (Number(t.netPnl) > 0) o.wins += 1;
    o.reasons.push(t.exitReason || "?");
  }
  return [...m.values()];
}

function baseLiqCfg(overrides = {}) {
  return fillLiqSoloPresetDefaults(
    fillFibSoloPresetDefaults({
      ...INTRADAY_PRO_LIQ_15M,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
      slippagePct: 0.0005,
      trailingStopLossAuto: true,
      futuresTrailingStopMode: "SUPERTREND",
      /** SL-only — trailing is the profit path */
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: false,
      ...overrides,
    }),
  );
}

async function runOne(label, rawCfg, exitMode = "sl_trail") {
  clearIntradayAdapterCache();
  let cfg = baseLiqCfg(rawCfg);
  if (exitMode === "full_tp") {
    cfg = baseLiqCfg({
      ...rawCfg,
      intradayLiqTp1Enabled: true,
      intradayLiqTp2Enabled: true,
      intradayLiqPartialTp: true,
      intradayLiqBreakevenAfterPartial: true,
    });
  }
  cfg = mergeAdaptiveCfg(cfg, candles);
  const simCfg = {
    ...cfg,
    symbol: SYMBOL,
    timeframe: TF,
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
  };
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: simCfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter },
    symbol: SYMBOL,
    costModelOverride: {
      leverage: 12,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const agg = aggregateTrades(sim.trades);
  const n = agg.length;
  const wins = agg.filter((x) => x.pnl > 0).length;
  const ret = agg.reduce((a, x) => a + x.pnl, 0);
  const wr = n > 0 ? (wins / n) * 100 : 0;
  const exits = {};
  for (const t of sim.trades) {
    const r = t.exitReason || "?";
    exits[r] = (exits[r] || 0) + 1;
  }
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const dd = m.maxDrawdownPct ?? 0;
  const pf = m.profitFactor ?? 0;
  const slN = exits.sl ?? 0;
  const trailN = exits.trail ?? 0;
  const slPct = n > 0 ? (slN / sim.trades.length) * 100 : 0;
  const score = ret * 0.55 + wr * 0.25 - dd * 0.35 - (n < 12 ? (12 - n) * 2 : 0);
  return { label, ret, wr, pf, dd, n, exits, slN, trailN, slPct, score, exitMode };
}

const results = [];

async function sweep(label, cfg, exitMode = "sl_trail") {
  process.stdout.write(`  ${label.slice(0, 56).padEnd(56)} `);
  const r = await runOne(label, cfg, exitMode);
  results.push(r);
  console.log(
    `n=${String(r.n).padStart(2)} ret=${r.ret.toFixed(1).padStart(6)} WR=${r.wr.toFixed(0).padStart(3)}% trail=${r.trailN} sl=${r.slN} DD=${r.dd.toFixed(1)}%`,
  );
  return r;
}

console.log("=== Phase 1: Trail architecture (SL-only liq) ===\n");
await sweep("no_trail", { trailingStopLossAuto: false });
await sweep("adv_only_default", {
  futuresTrailingStFeeBreakeven: false,
  futuresTrailingStAdvanced: true,
  trailBufferRate: 0.0015,
  trailPostT02SpacingFrac: 0.002,
  trailPostT02ActivationBufferRate: 0.0014,
});
await sweep("tiered_both_default", {
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  trailBufferRate: 0.0015,
  trailFeeBeMultiplier: 1.25,
  trailT01LockSlippageFrac: 0.0002,
  trailPostT02SpacingFrac: 0.002,
  trailPostT02ActivationBufferRate: 0.0014,
});
await sweep("fee_be_only", {
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: false,
  trailBufferRate: 0.0015,
  trailFeeBeMultiplier: 1.25,
});
await sweep("fee_ladder_mode", {
  futuresTrailingStopMode: "FEE_LADDER",
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: false,
  trailBufferRate: 0.001,
  extraScalpingPcts: [0.5, 1.0],
});

const advBuf = quick ? [0.001, 0.002] : [0.0006, 0.001, 0.0015, 0.002, 0.0025, 0.003];
const postSpacing = quick ? [0.0015, 0.003] : [0.0005, 0.001, 0.0015, 0.002, 0.003, 0.004];
const postBuf = quick ? [0, 0.002] : [0, 0.0008, 0.0014, 0.002, 0.003, 0.005];
const feeMult = quick ? [1.15, 1.25] : [1.0, 1.1, 1.15, 1.25, 1.35, 1.5];

console.log("\n=== Phase 2: Advanced-only grid (SL-only) ===\n");
for (const buf of advBuf) {
  for (const sp of postSpacing) {
    for (const p2b of postBuf) {
      await sweep(`adv buf=${buf} sp=${sp} p2=${p2b}`, {
        futuresTrailingStFeeBreakeven: false,
        futuresTrailingStAdvanced: true,
        trailBufferRate: buf,
        trailPostT02SpacingFrac: sp,
        trailPostT02ActivationBufferRate: p2b > 0 ? p2b : null,
      });
    }
  }
}

if (!quick) {
  console.log("\n=== Phase 3: Tiered (fee BE + advanced) ===\n");
  for (const buf of [0.001, 0.0015, 0.002, 0.0025]) {
    for (const fm of feeMult) {
      for (const sp of [0.001, 0.002, 0.003]) {
        for (const t01 of [0, 0.0002, 0.0005]) {
          await sweep(`tier buf=${buf} fm=${fm} sp=${sp} t01=${t01}`, {
            futuresTrailingStFeeBreakeven: true,
            futuresTrailingStAdvanced: true,
            trailBufferRate: buf,
            trailFeeBeMultiplier: fm,
            trailT01LockSlippageFrac: t01,
            trailPostT02SpacingFrac: sp,
            trailPostT02ActivationBufferRate: 0.0014,
          });
        }
      }
    }
  }
}

const slTrail = results.filter((r) => r.exitMode === "sl_trail");
slTrail.sort((a, b) => b.score - a.score);

function printTop(title, list, n = 15) {
  console.log(`\n${title}\n`);
  for (const r of list.slice(0, n)) {
    console.log(
      `${r.label.padEnd(52)} ret=${r.ret.toFixed(2).padStart(7)} WR=${r.wr.toFixed(0).padStart(3)}% n=${String(r.n).padStart(2)} trail=${String(r.trailN).padStart(3)} sl=${String(r.slN).padStart(2)} PF=${r.pf.toFixed(2)} DD=${r.dd.toFixed(1)}%`,
    );
  }
}

printTop("TOP 15 by balanced score (0.55×return + 0.25×WR − 0.35×DD)", slTrail);

const byRet = [...slTrail].filter((r) => r.n >= 10).sort((a, b) => b.ret - a.ret);
const byWr = [...slTrail].filter((r) => r.n >= 10).sort((a, b) => b.wr - a.wr);
printTop("TOP 10 by return (min 10 entries)", byRet, 10);
printTop("TOP 10 by win rate (min 10 entries)", byWr, 10);

if (withTp && byRet[0]) {
  console.log("\n=== Phase 4: Best SL-trail configs with TP1+TP2+BE restored ===\n");
  const topLabels = byRet.slice(0, 5);
  for (const t of topLabels) {
    const m = t.label.match(/buf=([\d.]+).*sp=([\d.]+).*p2=([\d.]+)/);
    const cfg =
      t.label.startsWith("tier")
        ? {
            futuresTrailingStFeeBreakeven: true,
            futuresTrailingStAdvanced: true,
            trailBufferRate: Number(t.label.match(/buf=([\d.]+)/)?.[1] ?? 0.0015),
            trailFeeBeMultiplier: Number(t.label.match(/fm=([\d.]+)/)?.[1] ?? 1.25),
            trailPostT02SpacingFrac: Number(t.label.match(/sp=([\d.]+)/)?.[1] ?? 0.002),
            trailPostT02ActivationBufferRate: 0.0014,
          }
        : {
            futuresTrailingStFeeBreakeven: false,
            futuresTrailingStAdvanced: true,
            trailBufferRate: m ? Number(m[1]) : 0.0015,
            trailPostT02SpacingFrac: m ? Number(m[2]) : 0.002,
            trailPostT02ActivationBufferRate: m ? Number(m[3]) : 0.0014,
          };
    await sweep(`${t.label} +TP`, cfg, "full_tp");
  }
}

const best = slTrail[0];
const bestRet = byRet[0];
const bestWr = byWr[0];
console.log("\n--- Recommended (SL-only liq + trail, BNB 15m Jan–May 2026) ---");
console.log(`Balanced:  ${best?.label} → ${best?.ret.toFixed(2)} USDT, ${best?.wr.toFixed(0)}% WR, ${best?.n} trades`);
console.log(`Max return: ${bestRet?.label} → ${bestRet?.ret.toFixed(2)} USDT, ${bestRet?.wr.toFixed(0)}% WR`);
console.log(`Max WR:     ${bestWr?.label} → ${bestWr?.wr.toFixed(0)}% WR, ${bestWr?.ret.toFixed(2)} USDT`);

await closePool();
