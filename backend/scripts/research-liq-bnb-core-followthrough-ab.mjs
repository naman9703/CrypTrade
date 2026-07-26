#!/usr/bin/env node
/**
 * BNB LIQ_CORE — one-change A/B: RequireFollowThrough (0.5 ATR / 2 bars) vs baseline.
 *
 * Hypothesis: CORE enters on reclaim alone; ~78% loss $ are never_green / sl_no_follow.
 * Guide follow-through (displacement away from sweep extreme before trade) may keep the
 * latent MFE≥0.5% cohort without crushing tw below 2.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-core-followthrough-ab.mjs
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
const RISK = Number(process.env.RISK || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

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
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const VARIANTS = [
  { id: "CORE", label: "LIQ_CORE baseline", over: {} },
  {
    id: "CORE_FT_05_2",
    label: "CORE + RequireFollowThrough 0.5ATR / 2 bars",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughAtrMult: 0.5,
      intradayLiqFollowThroughBars: 2,
    },
  },
];

function yearWindows(lo, hi) {
  const out = [];
  let y = new Date(lo).getUTCFullYear();
  const endY = new Date(hi - 1).getUTCFullYear();
  while (y <= endY) {
    const a = Math.max(lo, Date.UTC(y, 0, 1));
    const b = Math.min(hi, Date.UTC(y + 1, 0, 1));
    if (b > a) out.push({ id: `Y${y}`, lo: a, hi: b });
    y += 1;
  }
  out.push({ id: "H12m", lo: Math.max(lo, hi - 365.25 * 864e5), hi });
  out.push({ id: "FULL", lo, hi });
  return out;
}

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  return "other_loss";
}

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
  const classes = {};
  let loss$ = 0;
  let death$ = 0;
  for (const t of s) {
    const c = failClass(t);
    classes[c] = (classes[c] ?? 0) + 1;
    const pnl = Number(t.netPnl ?? 0);
    if (pnl < 0) {
      loss$ += pnl;
      if (c === "never_green" || c === "sl_no_follow") death$ += pnl;
    }
  }
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    classes,
    deathLossShare: loss$ < 0 ? +((death$ / loss$) * 100).toFixed(1) : null,
  };
}

async function runVariant(candles, funding, variant) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...(variant.over || {}),
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
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
  const trades = (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs,
  );
  const windows = {};
  for (const w of yearWindows(fromMs, toMs)) {
    windows[w.id] = metrics(trades, w.lo, w.hi);
  }
  return {
    id: variant.id,
    label: variant.label,
    over: variant.over,
    windows,
  };
}

console.log(`\n=== BNB LIQ_CORE follow-through A/B === ${FROM}→${TO} ${TF}`);
console.log(`Hypothesis: missing displacement confirm vs wrong concept\n`);

const padMs = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - padMs, toMs).catch(() => []);
console.log(`candles=${candles.length} funding=${funding.length}`);

const results = [];
for (const v of VARIANTS) {
  process.stderr.write(`run ${v.id}…\n`);
  const row = await runVariant(candles, funding, v);
  results.push(row);
  const full = row.windows.FULL;
  console.log(
    `${v.id.padEnd(14)} FULL n=${String(full.n).padStart(4)} tw=${full.tw} ret=${String(full.ret).padStart(7)}% pf=${full.pf} wr=${full.wr}% death%=${full.deathLossShare}`,
  );
  for (const [wid, m] of Object.entries(row.windows)) {
    if (wid === "FULL") continue;
    console.log(
      `  ${wid.padEnd(6)} n=${String(m.n).padStart(4)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% pf=${m.pf} wr=${m.wr}%`,
    );
  }
}

const base = results.find((r) => r.id === "CORE");
const ft = results.find((r) => r.id === "CORE_FT_05_2");
const compare = {};
if (base && ft) {
  for (const wid of Object.keys(base.windows)) {
    const b = base.windows[wid];
    const f = ft.windows[wid];
    compare[wid] = {
      dN: f.n - b.n,
      dTw: +(f.tw - b.tw).toFixed(2),
      dRet: +(f.ret - b.ret).toFixed(2),
      dPf: +(f.pf - b.pf).toFixed(3),
      base: { n: b.n, tw: b.tw, ret: b.ret, pf: b.pf },
      ft: { n: f.n, tw: f.tw, ret: f.ret, pf: f.pf },
    };
  }
}

const gates = {
  target: "FULL PF≥1 + Y25 ret>0 + H12m ret>0 + tw≥2",
  fullPf: ft?.windows?.FULL?.pf ?? null,
  y25Ret: ft?.windows?.Y2025?.ret ?? null,
  h12Ret: ft?.windows?.H12m?.ret ?? null,
  tw: ft?.windows?.FULL?.tw ?? null,
};
gates.pass =
  gates.fullPf >= 1 &&
  gates.y25Ret > 0 &&
  gates.h12Ret > 0 &&
  gates.tw >= 2;

const verdict = gates.pass
  ? "PROMOTE_CANDIDATE"
  : ft?.windows?.FULL?.pf > (base?.windows?.FULL?.pf ?? 0) &&
      ft?.windows?.Y2025?.ret > (base?.windows?.Y2025?.ret ?? -Infinity) &&
      (ft?.windows?.FULL?.tw ?? 0) >= 2
    ? "SOFT_IMPROVE_HOLD_OUT_FAIL"
    : "REJECT";

const out = {
  hypothesis:
    "CORE fade enters on reclaim alone; RequireFollowThrough 0.5ATR/2bars keeps only displacement survivors",
  symbol: SYMBOL,
  tf: TF,
  from: FROM,
  to: TO,
  riskPct: RISK,
  leverage: LEVERAGE,
  variants: results,
  compare,
  gates,
  verdict,
  ts: new Date().toISOString(),
};

const outPath = path.join(__dirname, ".liq-bnb-core-followthrough-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict}`);
console.log(`gates=${JSON.stringify(gates)}`);
console.log(`wrote ${outPath}`);

await closePool?.();
