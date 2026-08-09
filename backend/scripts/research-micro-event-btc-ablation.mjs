#!/usr/bin/env node
/**
 * MICRO_EVENT BTC tick ablation — coverage-native force_orders window + costs.
 *
 * Hypothesis: continuation on liq cascades has edge after fees; CVD/OI confirms
 * lift expectancy without crushing N.
 *
 * Ablations (one stack step each):
 *   1) LIQ_ONLY
 *   2) LIQ_CVD
 *   3) LIQ_CVD_OI
 * Optional DIRECTION=fade flips continuation→fade as a separate one-change run.
 *
 * Usage (backend/):
 *   node scripts/research-micro-event-btc-ablation.mjs
 *   DIRECTION=fade SKIP_ENSURE=1 node scripts/research-micro-event-btc-ablation.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const TF = process.env.TF || "1m";
const RISK = Number(process.env.RISK || 1);
const DIRECTION = String(process.env.DIRECTION || "continuation").toLowerCase();
const HOLD_SEC = process.env.HOLD_SEC != null ? Number(process.env.HOLD_SEC) : null;
const COST_FLOOR_PCT = 0.13; // ~round-trip fees+slip approx

const COST = { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const { rows: boundsRows } = await pool.query(
  `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*)::int AS n
   FROM force_orders WHERE symbol = $1`,
  [SYMBOL],
);
const firstTs = boundsRows[0]?.first_ts;
const lastTs = boundsRows[0]?.last_ts;
const tickCount = Number(boundsRows[0]?.n ?? 0);
if (!firstTs || !lastTs || !(tickCount > 0)) {
  console.error(`No force_orders for ${SYMBOL} — keep WS + migration 036 running.`);
  await closePool?.().catch(() => {});
  process.exit(1);
}

const fromMs = process.env.FROM ? Date.parse(process.env.FROM) : new Date(firstTs).getTime();
const toMs = process.env.TO ? Date.parse(process.env.TO) : new Date(lastTs).getTime() + 60_000;
const spanDays = (toMs - fromMs) / 864e5;
const split = fromMs + Math.round((toMs - fromMs) * 0.6);
const WINDOWS = {
  IS: [fromMs, split],
  OOS: [split, toMs],
  FULL: [fromMs, toMs],
};

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  hydrateMicroEventCfg,
  microEventPadFromMs,
  buildMicroEventBacktestAdapter,
} = await import("../src/strategy/microEventIntraday.js");
const presetMod = await import("../src/strategy/presets/microEventOptimized.js");

const ABLATIONS = [
  { key: "LIQ_ONLY", base: presetMod.MICRO_EVENT_BTC_1M_LIQ_ONLY },
  { key: "LIQ_CVD", base: presetMod.MICRO_EVENT_BTC_1M_LIQ_CVD },
  { key: "LIQ_CVD_OI", base: presetMod.MICRO_EVENT_BTC_1M_LIQ_CVD_OI },
];

function rOf(t) {
  let risk = Number(t.initialRiskUsd ?? 0);
  if (!(risk > 0)) {
    const entry = Number(t.entryPrice ?? t.entryFill);
    const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
      risk = Math.abs(entry - stop) * qty;
    }
  }
  return risk > 0 ? Number(t.netPnl) / risk : null;
}

function maxDdFromCurve(curve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve ?? []) {
    const e = Number(p.equity ?? p.eq ?? 0);
    if (e > peak) peak = e;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
  }
  return maxDd;
}

function summarizeTrades(trades, from, to, finalEq, equityCurve) {
  const weeks = Math.max((to - from) / (7 * 864e5), 1 / 7);
  const retPct = ((finalEq - 100) / 100) * 100;
  const ddPct = maxDdFromCurve(equityCurve);
  const rs = trades.map(rOf).filter((x) => x != null && Number.isFinite(x));
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pfR = neg < 0 ? pos / -neg : pos > 0 ? 99 : 0;
  const wins = trades.filter((t) => Number(t.netPnl) > 0).length;
  const losses = trades.filter((t) => Number(t.netPnl) <= 0).length;
  const byExit = {};
  for (const t of trades) {
    const k = String(t.exitReason ?? "unknown");
    byExit[k] = (byExit[k] ?? 0) + 1;
  }
  return {
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    wr: trades.length ? +((wins / trades.length) * 100).toFixed(1) : 0,
    wins,
    losses,
    byExit,
    rs,
    trades: trades.map((t) => ({
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      side: t.side ?? t.action,
      netPnl: Number(t.netPnl),
      r: rOf(t),
      exitReason: t.exitReason,
      entryPrice: t.entryPrice ?? t.entryFill,
      sl: t.initialSlPrice ?? t.slPrice,
      holdBars: t.holdBars,
    })),
  };
}

/**
 * Hydrate once on FULL coverage window, then slice candles per IS/OOS/FULL.
 * Avoids repeated force_orders/aggTrade DB hits (was crashing Timescale recovery).
 */
async function hydrateOnce(overrides) {
  const patch = {
    ...overrides,
    symbol: SYMBOL,
    riskPerTrade: RISK,
    microEventDirectionMode: DIRECTION,
  };
  if (HOLD_SEC != null && Number.isFinite(HOLD_SEC) && HOLD_SEC > 0) {
    patch.microEventMaxHoldSec = HOLD_SEC;
  }
  let cfg = await hydrateMicroEventCfg(patch, SYMBOL, fromMs, toMs);
  return {
    ...cfg,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
  };
}

async function runWindow(label, cfgHydrated, candlesAll, fundingAll, winFrom, winTo) {
  const padFrom = microEventPadFromMs(winFrom, TF);
  const slice = candlesAll.filter((c) => Number(c.ts) >= padFrom && Number(c.ts) < winTo);
  const funding = fundingAll.filter((f) => Number(f.ts ?? f.time) >= padFrom && Number(f.ts ?? f.time) < winTo);
  const cfg = { ...cfgHydrated, backtestSignalStartMs: winFrom };
  const meta = cfg._microEventBacktestCtx?.hydrationMeta ?? {};
  const adapter = buildMicroEventBacktestAdapter(slice, cfg, TF, {
    liqSeries: cfg._microEventLiqSeries ?? [],
    backtestCtx: cfg._microEventBacktestCtx ?? null,
  });
  const sim = await runSimulation({
    strategyKey: "MICRO_EVENT",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { MICRO_EVENT: adapter },
    symbol: SYMBOL,
    costModelOverride: COST,
  });
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= winFrom && Number(t.entryTs) < winTo);
  const summary = summarizeTrades(trades, winFrom, winTo, Number(sim.finalEquity ?? 100), sim.equityCurve);
  return {
    label,
    tickCount: cfg._microEventTickCount ?? 0,
    hydration: meta,
    ...summary,
  };
}

console.log(`=== MICRO_EVENT BTC ablation (${DIRECTION}) ===`);
if (HOLD_SEC != null) console.log(`HOLD_SEC override: ${HOLD_SEC}s`);
console.log(
  `force_orders: n=${tickCount} ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${spanDays.toFixed(2)}d)`,
);
console.log(`IS ${new Date(WINDOWS.IS[0]).toISOString()} → ${new Date(WINDOWS.IS[1]).toISOString()}`);
console.log(`OOS ${new Date(WINDOWS.OOS[0]).toISOString()} → ${new Date(WINDOWS.OOS[1]).toISOString()}`);

const padFrom = microEventPadFromMs(fromMs, TF);
if (!process.env.SKIP_ENSURE) {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" }).catch((e) =>
    console.warn("ensureKlines:", e?.message || e),
  );
}
const candlesAll = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const fundingAll = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.log(`candles=${candlesAll.length} funding=${fundingAll.length}`);

const results = {};
for (const abl of ABLATIONS) {
  console.log(`\n── ${abl.key} ──`);
  const cfgHydrated = await hydrateOnce(abl.base);
  console.log(
    `  hydrated ticks=${cfgHydrated._microEventTickCount} agg=${cfgHydrated._microEventBacktestCtx?.aggTradeCount ?? 0} oi=${cfgHydrated._microEventBacktestCtx?.oiSeries?.length ?? 0}`,
  );
  const row = {};
  for (const [wLabel, [wFrom, wTo]] of Object.entries(WINDOWS)) {
    const r = await runWindow(`${abl.key}/${wLabel}`, cfgHydrated, candlesAll, fundingAll, wFrom, wTo);
    row[wLabel] = r;
    console.log(
      `  ${wLabel.padEnd(4)} n=${String(r.n).padStart(3)} tw=${String(r.tw).padStart(5)} ret=${String(r.retPct).padStart(7)}% pfR=${String(r.pfR).padStart(6)} wr=${String(r.wr).padStart(5)}% meanR=${r.meanR ?? "—"} exits=${JSON.stringify(r.byExit)}`,
    );
    if (wLabel === "FULL") {
      console.log(`       hydration: ${JSON.stringify(r.hydration)}`);
    }
  }
  results[abl.key] = row;
}

/** Phase0-style: mean net R and whether PF clears 1 after costs (from FULL trades). */
function pickBest() {
  const ranked = ABLATIONS.map((a) => {
    const oos = results[a.key].OOS;
    const full = results[a.key].FULL;
    const score =
      (oos.retPct > 0 ? 1000 : 0) +
      (oos.pfR >= 1 ? 200 : 0) +
      Math.min(oos.n, 50) * 2 +
      oos.retPct +
      (full.pfR >= 1 ? 50 : 0);
    return { key: a.key, oos, full, score };
  }).sort((a, b) => b.score - a.score);
  return ranked;
}

const ranked = pickBest();
const best = ranked[0];
const dataQuality = {
  source: "force_orders",
  tickCount,
  spanDays: +spanDays.toFixed(2),
  verdict: spanDays >= 56 && tickCount >= 500 ? "sufficient" : "partial",
  note:
    spanDays < 56
      ? "Edge confirmation pending on coverage — keep force_orders WS; ≥8 weeks before promote language."
      : "Coverage gate met for full-window claims.",
};

console.log("\n══ Ranking (OOS-first) ══");
for (const r of ranked) {
  console.log(
    `  ${r.key.padEnd(12)} OOS n=${r.oos.n} ret=${r.oos.retPct}% pfR=${r.oos.pfR} | FULL n=${r.full.n} ret=${r.full.retPct}% pfR=${r.full.pfR}`,
  );
}

const oosOk = best.oos.retPct > 0 && best.oos.pfR >= 1 && best.oos.n >= 5;
const promoteReady = dataQuality.verdict === "sufficient" && best.oos.n >= 30 && best.oos.retPct > 0 && best.oos.pfR >= 1;
let nextHypothesis = "";
if (best.oos.n === 0) {
  nextHypothesis = "Zero OOS fills — lower liqMinUsd / liqZMin one notch OR verify aggTrades CVD hydrate on coverage window.";
} else if (best.oos.retPct <= 0 && best.oos.pfR < 1) {
  const exits = best.oos.byExit;
  if ((exits.sl ?? 0) > (exits.tp ?? 0) + (exits.tp2 ?? 0)) {
    nextHypothesis = "SL-heavy — one change: try DIRECTION=fade OR widen microEventSlBufferPct / raise tpRr (isolated).";
  } else if ((exits.max_hold ?? exits.time ?? 0) > best.oos.n / 2) {
    nextHypothesis = "Time-stop heavy — one change: raise microEventMaxHoldSec (120→240) keeping brackets fixed.";
  } else {
    nextHypothesis = "Negative expectancy — autopsy losers by side/session; try fade as single change if continuation red.";
  }
} else if (!promoteReady) {
  nextHypothesis = `Best=${best.key} green on thin sample — keep collecting force_orders; re-run weekly until n≥30 OOS + ≥8w coverage.`;
} else {
  nextHypothesis = "Coverage + OOS gates met — run backtest-validate-micro-event.mjs WF+MC before paper capital language.";
}

console.log(`\nBEST: ${best.key} | dataQuality=${dataQuality.verdict} | promoteReady=${promoteReady}`);
console.log(`NEXT: ${nextHypothesis}`);
console.log(`costFloor≈${COST_FLOOR_PCT}% RT — PF/ret already include fees+slippage in sim.`);

const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  direction: DIRECTION,
  windows: {
    IS: WINDOWS.IS.map((x) => new Date(x).toISOString()),
    OOS: WINDOWS.OOS.map((x) => new Date(x).toISOString()),
    FULL: WINDOWS.FULL.map((x) => new Date(x).toISOString()),
  },
  dataQuality,
  results: Object.fromEntries(
    Object.entries(results).map(([k, v]) => [
      k,
      Object.fromEntries(
        Object.entries(v).map(([w, row]) => [
          w,
          {
            n: row.n,
            tw: row.tw,
            retPct: row.retPct,
            ddPct: row.ddPct,
            meanR: row.meanR,
            pfR: row.pfR,
            wr: row.wr,
            byExit: row.byExit,
            hydration: row.hydration,
            trades: row.trades,
          },
        ]),
      ),
    ]),
  ),
  ranked: ranked.map((r) => ({ key: r.key, score: r.score, oos: { n: r.oos.n, ret: r.oos.retPct, pfR: r.oos.pfR } })),
  best: best.key,
  oosOk,
  promoteReady,
  nextHypothesis,
};

const jsonPath = path.join(__dirname, `.micro-event-btc-ablation-${DIRECTION}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${jsonPath}`);

const mdPath = path.join(
  __dirname,
  ".research-decisions",
  `${new Date().toISOString().slice(0, 10)}-micro-event-btc-ablation.md`,
);
fs.mkdirSync(path.dirname(mdPath), { recursive: true });
const lines = [
  `# MICRO_EVENT BTC ablation — ${DIRECTION}`,
  ``,
  `- Generated: ${out.generatedAt}`,
  `- Window: coverage-native force_orders ${out.windows.FULL[0]} → ${out.windows.FULL[1]} (${dataQuality.spanDays}d, n_ticks=${tickCount})`,
  `- dataQuality: **${dataQuality.verdict}** — ${dataQuality.note}`,
  `- Costs: fee 4bps/side + slip 5bps, lev 10`,
  ``,
  `## Results`,
  ``,
  `| Variant | OOS n | tw/wk | ret% | pfR | FULL n | FULL ret% | FULL pfR |`,
  `|--------|-------|-------|------|-----|--------|-----------|----------|`,
];
for (const a of ABLATIONS) {
  const o = results[a.key].OOS;
  const f = results[a.key].FULL;
  lines.push(
    `| ${a.key} | ${o.n} | ${o.tw} | ${o.retPct} | ${o.pfR} | ${f.n} | ${f.retPct} | ${f.pfR} |`,
  );
}
lines.push(
  ``,
  `## Verdict`,
  ``,
  `- Best: **${best.key}** (OOS ret=${best.oos.retPct}% pfR=${best.oos.pfR} n=${best.oos.n})`,
  `- promoteReady: ${promoteReady}`,
  `- Next: ${nextHypothesis}`,
  ``,
  `## Correctness fixes this run`,
  ``,
  `- LIQ_ONLY minConfluenceScore 20→10 (z=1.5 was scored ~13.5 and never passed)`,
  `- Sparse liq series (no zero-pad) + skip zero-liq bars before CVD scan`,
  `- Binary-search CVD window sums`,
  ``,
);
fs.writeFileSync(mdPath, lines.join("\n"));
console.log(`Wrote ${mdPath}`);

await closePool?.().catch(() => {});
