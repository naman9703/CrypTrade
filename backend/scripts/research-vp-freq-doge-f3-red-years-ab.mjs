#!/usr/bin/env node
/**
 * DOGE F3 — fix remaining red years under locked bear-HTF 0.35%.
 * H1: BUY max prior60 (2020-21 blow-off)
 * H2: raise sell/bear HTF (2024-25 residual)
 * Then stack only if both solo pass year-keep.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-red-years-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "DOGEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;

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
  VOLUME_PROFILE_FREQ_DOGE_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const LOCKED = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpNoveltyEnabled: false,
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...LOCKED, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function fmtYears(m) {
  return Object.entries(m.years)
    .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
    .join(" ");
}

function redYears(m) {
  return Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
}

function evaluate(h0, r) {
  const years = Object.keys({ ...h0.years, ...r.years });
  const noCatastrophic = years.every((y) => (r.years[y]?.retPct ?? 0) > -10);
  const allNonNeg = years.every((y) => (r.years[y]?.retPct ?? 0) >= 0);
  const keepGood = ["2021-22", "2022-23", "2023-24", "2025-26"].every((y) => {
    const a = r.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    return a >= b - 12;
  });
  const fix2021 = (r.years["2020-21"]?.retPct ?? -999) > (h0.years["2020-21"]?.retPct ?? 0) + 3;
  const fix2425 = (r.years["2024-25"]?.retPct ?? -999) > (h0.years["2024-25"]?.retPct ?? 0) + 5;
  return {
    noCatastrophic,
    allNonNeg,
    keepGood,
    fix2021,
    fix2425,
    accept: keepGood && r.ret >= h0.ret - 5 && r.tw >= h0.tw * 0.7 && r.ret > 0 && (fix2021 || fix2425),
    optimized: allNonNeg && r.ret > 0 && r.pf >= 1.1 && r.tw >= h0.tw * 0.7,
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCKED);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const variants = [
  { id: "H0_locked", over: {} },
  // 2020-21 blow-off BUY rej
  { id: "buy_max60_050", over: { vpBuyRejectionMaxPrior60dPct: 0.5 } },
  { id: "buy_max60_100", over: { vpBuyRejectionMaxPrior60dPct: 1.0 } },
  { id: "buy_max60_200", over: { vpBuyRejectionMaxPrior60dPct: 2.0 } },
  { id: "buy_max60_300", over: { vpBuyRejectionMaxPrior60dPct: 3.0 } },
  // 2024-25 residual
  { id: "bear_htf_050", over: { vpRejectionSellBearMinHtfSepPct: 0.005 } },
  { id: "sell_htf_050_global", over: { vpSellMinHtfSepPct: 0.005 } },
  { id: "sell_htf_035_global", over: { vpSellMinHtfSepPct: 0.0035 } },
];

console.log(`\n══ DOGE red-year A/B (solo first) ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = evaluate(ab[0] ? ab[0] : m, m);
  ab.push({ id: v.id, ...m, score: sc });
  // fix evaluate: first is h0
}

const h0 = ab[0];
for (let i = 0; i < ab.length; i++) {
  ab[i].score = evaluate(h0, ab[i]);
  const r = ab[i];
  console.log(
    `${r.id}\n  FULL n=${r.trades} tw=${r.tw} ret=${r.ret} pf=${r.pf} cal=${r.calmar} dd=${r.dd}\n  years ${fmtYears(r)}\n  RED: ${redYears(r).join(" ") || "none"}\n  accept=${r.score.accept} optimized=${r.score.optimized} allNonNeg=${r.score.allNonNeg} keepGood=${r.score.keepGood}`,
  );
}

// Stack best solo fixes if complementary
const bestBuy = ab
  .filter((r) => r.id.startsWith("buy_max60_") && r.score.keepGood && r.score.fix2021)
  .sort((a, b) => (b.years["2020-21"]?.retPct ?? 0) - (a.years["2020-21"]?.retPct ?? 0))[0];
const bestSell = ab
  .filter((r) => (r.id.includes("htf") || r.id.includes("sell")) && r.id !== "H0_locked" && r.score.keepGood && r.score.fix2425)
  .sort((a, b) => (b.years["2024-25"]?.retPct ?? -999) - (a.years["2024-25"]?.retPct ?? -999))[0];

if (bestBuy && bestSell) {
  const stack = {
    id: `STACK_${bestBuy.id}+${bestSell.id}`,
    over: { ...bestBuy.over, ...bestSell.over },
  };
  // recover overs from variants
  const buyOver = variants.find((v) => v.id === bestBuy.id)?.over ?? {};
  const sellOver = variants.find((v) => v.id === bestSell.id)?.over ?? {};
  stack.over = { ...buyOver, ...sellOver };
  console.error(`run ${stack.id}`);
  const trades = await run(candles, funding, stack.over);
  const m = metricsFor(trades);
  const sc = evaluate(h0, m);
  ab.push({ id: stack.id, over: stack.over, ...m, score: sc });
  console.log(
    `${stack.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} dd=${m.dd}\n  years ${fmtYears(m)}\n  RED: ${redYears(m).join(" ") || "none"}\n  accept=${sc.accept} optimized=${sc.optimized} allNonNeg=${sc.allNonNeg}`,
  );
} else {
  console.log(`\nNo complementary solo stack (bestBuy=${bestBuy?.id ?? "none"} bestSell=${bestSell?.id ?? "none"})`);
  // Still try best buy + bear_htf_050 even if sell solo didn't fully fix
  if (bestBuy) {
    for (const sellId of ["bear_htf_050", "sell_htf_050_global"]) {
      const sellOver = variants.find((v) => v.id === sellId)?.over ?? {};
      const buyOver = variants.find((v) => v.id === bestBuy.id)?.over ?? {};
      const id = `STACK_${bestBuy.id}+${sellId}`;
      console.error(`run ${id}`);
      const trades = await run(candles, funding, { ...buyOver, ...sellOver });
      const m = metricsFor(trades);
      const sc = evaluate(h0, m);
      ab.push({ id, ...m, score: sc });
      console.log(
        `${id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar} dd=${m.dd}\n  years ${fmtYears(m)}\n  RED: ${redYears(m).join(" ") || "none"}\n  accept=${sc.accept} optimized=${sc.optimized} allNonNeg=${sc.allNonNeg}`,
      );
    }
  }
}

console.log("\n══ Ranked (optimized first) ══");
const ranked = [...ab].sort(
  (a, b) =>
    Number(b.score.optimized) - Number(a.score.optimized) ||
    Number(b.score.allNonNeg) - Number(a.score.allNonNeg) ||
    Number(b.score.accept) - Number(a.score.accept) ||
    b.ret - a.ret,
);
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(40)} opt=${r.score.optimized} all≥0=${r.score.allNonNeg} ret=${r.ret}% | 20-21=${r.years["2020-21"]?.retPct} 24-25=${r.years["2024-25"]?.retPct} 21-22=${r.years["2021-22"]?.retPct} 22-23=${r.years["2022-23"]?.retPct} 25-26=${r.years["2025-26"]?.retPct}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-red-years-ab.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), ab: ranked }, null, 2));
console.error("wrote", outPath);
await closePool?.();
