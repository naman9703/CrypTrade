#!/usr/bin/env node
/**
 * BNB LIQ — internet-guide correctness audit + VP-style prepared-cell / param optimize.
 *
 * Compares CORE (truncated: pierce+reclaim+market) to published ICT sequence:
 *   pool → sweep reclaim → displacement/MSS → (optional retest) → structural SL/TP
 *
 * Phase A: soft prepared-cell matrix (level×session×day×quality) on Y1 trades
 * Phase B: hard one-change / small guide stacks vs CORE on Y1 + HOLD
 *          (quality gates + structural exits + CHoCH + displacement + mitigation)
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-guide-correct-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const Y1_FROM = Date.parse(process.env.FROM || "2025-07-01");
const Y1_TO = Date.parse(process.env.TO || "2026-07-01");
const HOLD_FROM = Date.parse(process.env.HOLD_FROM || "2024-07-01");
const HOLD_TO = Date.parse(process.env.HOLD_TO || "2025-07-01");

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
const { rejectionWickBodyRatio } = await import("../src/strategy/techniques/liquidity.js");

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
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  };
}

async function runSim(candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...(over || {}),
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: lo,
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
  return (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi,
  );
}

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const t = Number(ts);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].ts);
    if (ct === t) return mid;
    if (ct < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function cellStats(rows, keyFn, minN = 8) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const out = [];
  for (const [k, xs] of m) {
    if (xs.length < minN) continue;
    let gp = 0;
    let gl = 0;
    let pnl = 0;
    let wins = 0;
    let death = 0;
    for (const r of xs) {
      pnl += r.pnl;
      if (r.pnl > 0) {
        gp += r.pnl;
        wins += 1;
      } else gl += Math.abs(r.pnl);
      if (r.mfe < 0.005 && r.pnl <= 0) death += 1;
    }
    out.push({
      k,
      n: xs.length,
      pnl: +pnl.toFixed(2),
      avg: +(pnl / xs.length).toFixed(4),
      pf: +(gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(3),
      wr: +((100 * wins) / xs.length).toFixed(1),
      deathPct: +((100 * death) / xs.length).toFixed(1),
      label: pnl > 0 && (gl > 0 ? gp / gl : 99) >= 1 ? "prepared" : "bleed",
    });
  }
  return out.sort((a, b) => a.avg - b.avg);
}

function softKeep(rows, label, pred, lo, hi) {
  const keep = rows.filter(pred);
  const m = metrics(
    keep.map((r) => ({
      netPnl: r.pnl,
      entryTs: r.entryTs,
      exitTs: r.exitTs,
      exitReason: r.exitReason,
    })),
    lo,
    hi,
  );
  return { label, ...m, pass: m.pf >= 1 && m.ret > 0 && m.tw >= 2 };
}

console.log("=== LIQ guide-correct + VP-style optimize ===\n");

const IMPLEMENTATION_GAP = {
  sources: [
    "https://www.ictkillzone.com/ict-liquidity-sweep",
    "https://www.ictkillzone.com/ict-previous-day-high-low",
    "https://huntersalgo.com/guides/ict-liquidity-sweep-explained",
    "https://internationaltradinginstitute.com/blog/liquidity-sweeps-entry-exit-strategies/",
  ],
  publishedSequence: [
    "1 Identify named pool (PDH/PDL/EQH/session/swing)",
    "2 Sweep: wick beyond + close reclaim (Type1) or body breach+next reject (Type2)",
    "3 Displacement / MSS (CHoCH) — reclaim alone insufficient",
    "4 Entry on FVG/OB retrace or retest of swept level — NOT market at reclaim close",
    "5 SL beyond sweep wick + ATR buffer (structural)",
    "6 TP opposing liquidity / fib (structural)",
    "7 Prerequisites: killzone OR session liquidity, HTF bias, vol expansion",
  ],
  coreStatus: {
    pools: "OK — PDH/PDL + session extremes",
    sweepReclaim: "OK — pierce + reclaim; holdBars=2",
    displacementMss: "MISSING ON — RequireChoch/DisplacementV2 OFF",
    entryTiming: "INCORRECT vs guide — market at reclaim+2, not FVG/retest",
    sl: "OK structural wick — ATR buffer OFF (only %)",
    tp: "PARTIAL structural opposing — capped maxTpRr=2",
    killzoneHtfVol: "OFF on CORE (quality gates disabled)",
    fakeSweepFilters: "OFF — wick/body, vol, same-bar, quality gate all off",
  },
  verdict:
    "CORE is a truncated classical fade trigger, not a complete liquidity-sweep strategy. Edge may exist in guide-complete sequence; CORE omitting steps 3–4/7 explains fake-sweep bleed.",
};

const pad = 30 * 864e5;
const candles = await readCandles(
  SYMBOL,
  TF,
  Math.min(Y1_FROM, HOLD_FROM) - pad,
  Math.max(Y1_TO, HOLD_TO),
  { market: "futures" },
);
const funding = await readFundingRates(
  SYMBOL,
  Math.min(Y1_FROM, HOLD_FROM) - pad,
  Math.max(Y1_TO, HOLD_TO),
).catch(() => []);

console.log("Running CORE Y1 harvest for cell matrix…");
const y1Trades = await runSim(candles, funding, {}, Y1_FROM, Y1_TO);
const rows = [];
for (const t of y1Trades) {
  if (String(t.exitReason ?? "") === "tp1_partial") continue;
  const feat = t.liqContext?.features ?? null;
  const ms = feat?.marketState ?? {};
  const entryIdx = findIdx(candles, Number(t.entryTs));
  const sweepIdx = Number(feat?.sweepStartIdx ?? -1);
  const reclaimIdx = Number(feat?.reclaimIdx ?? -1);
  let wickBody = 0;
  if (sweepIdx >= 0 && candles[sweepIdx]) {
    const side = String(t.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
    wickBody = rejectionWickBodyRatio(candles[sweepIdx], side) || 0;
  }
  const entryPx = Number(t.entryFill ?? t.entryPrice ?? 0);
  const slPx = Number(t.initialSlPrice ?? t.slPrice ?? 0);
  const slPct = entryPx > 0 && slPx > 0 ? Math.abs(entryPx - slPx) / entryPx : 0;
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  const day = String(ms.daySituation ?? "range");
  const side = String(t.side ?? t.direction ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const toxic =
    (day === "breakout" && side === "SELL") || (day === "breakdown" && side === "BUY");
  rows.push({
    entryTs: Number(t.entryTs),
    exitTs: Number(t.exitTs ?? t.entryTs),
    exitReason: String(t.exitReason ?? ""),
    pnl,
    mfe,
    side,
    level: String(feat?.level?.type ?? t.liqContext?.levelType ?? "?"),
    session: String(feat?.sessionNarrative ?? ms.sessionNarrative ?? "?"),
    day,
    toxic,
    vol: Number(feat?.sweep?.sweepVolSpike ?? 0),
    abs: Number(feat?.sweep?.absorptionProxy ?? 0),
    impulse: Number(feat?.displacement?.impulseAtr ?? 0),
    bodyEff: Number(feat?.displacement?.bodyEfficiency ?? 0),
    dailyUsed: Number(feat?.continuation?.dailyRangeUsedPct ?? 0),
    atrPct: Number(ms.atrPct ?? 0),
    wickBody,
    sameBar: sweepIdx >= 0 && sweepIdx === reclaimIdx,
    slPct,
    volBin: Number(feat?.sweep?.sweepVolSpike ?? 0) >= 1.5 ? "vol15+" : "vol<15",
    wickBin: wickBody >= 1.5 ? "wick15+" : "wick<15",
    slBin: slPct >= 0.01 ? "slWide" : "slTight",
    atrBin: Number(ms.atrPct ?? 0) >= 0.0045 ? "atrHi" : "atrLo",
    impulseBin: Number(feat?.displacement?.impulseAtr ?? 0) >= 1.2 ? "dispOK" : "dispWeak",
  });
}

const baselineY1 = metrics(y1Trades, Y1_FROM, Y1_TO);
console.log(
  `Y1 baseline n=${baselineY1.n} tw=${baselineY1.tw} ret=${baselineY1.ret}% pf=${baselineY1.pf}`,
);

const cells = {
  byLevelSession: cellStats(rows, (r) => `${r.level}|${r.session}`),
  byDayVol: cellStats(rows, (r) => `${r.day}|${r.volBin}`),
  byDayImpulse: cellStats(rows, (r) => `${r.day}|${r.impulseBin}`),
  byWickVol: cellStats(rows, (r) => `${r.wickBin}|${r.volBin}`),
  bySameBarDay: cellStats(rows, (r) => `${r.sameBar ? "sameBar" : "multi"}|${r.day}`),
  bySlAtr: cellStats(rows, (r) => `${r.slBin}|${r.atrBin}`),
  byToxicImpulse: cellStats(rows, (r) => `${r.toxic ? "toxic" : "ok"}|${r.impulseBin}`),
  byPreparedKey: cellStats(
    rows,
    (r) => `${r.day}|${r.volBin}|${r.impulseBin}|${r.slBin}`,
    6,
  ),
};

console.log("\n--- bleed cells (worst avg) ---");
for (const c of cells.byPreparedKey.filter((x) => x.label === "bleed").slice(0, 12)) {
  console.log(`${c.k.padEnd(40)} n=${c.n} pnl=${c.pnl} pf=${c.pf} death%=${c.deathPct}`);
}
console.log("\n--- prepared cells (best) ---");
for (const c of [...cells.byPreparedKey].filter((x) => x.label === "prepared").reverse().slice(0, 8)) {
  console.log(`${c.k.padEnd(40)} n=${c.n} pnl=${c.pnl} pf=${c.pf}`);
}

console.log("\n========== SOFT relative abstains ==========");
const soft = [
  softKeep(rows, "H0", () => true, Y1_FROM, Y1_TO),
  softKeep(rows, "keep_dispOK", (r) => r.impulseBin === "dispOK", Y1_FROM, Y1_TO),
  softKeep(rows, "keep_vol15", (r) => r.volBin === "vol15+", Y1_FROM, Y1_TO),
  softKeep(rows, "keep_wick15", (r) => r.wickBin === "wick15+", Y1_FROM, Y1_TO),
  softKeep(rows, "keep_slWide", (r) => r.slBin === "slWide", Y1_FROM, Y1_TO),
  softKeep(rows, "keep_atrHi", (r) => r.atrBin === "atrHi", Y1_FROM, Y1_TO),
  softKeep(rows, "drop_toxic", (r) => !r.toxic, Y1_FROM, Y1_TO),
  softKeep(rows, "dispOK_vol15", (r) => r.impulseBin === "dispOK" && r.volBin === "vol15+", Y1_FROM, Y1_TO),
  softKeep(
    rows,
    "dispOK_slWide",
    (r) => r.impulseBin === "dispOK" && r.slBin === "slWide",
    Y1_FROM,
    Y1_TO,
  ),
  softKeep(
    rows,
    "dispOK_vol15_slWide",
    (r) => r.impulseBin === "dispOK" && r.volBin === "vol15+" && r.slBin === "slWide",
    Y1_FROM,
    Y1_TO,
  ),
  softKeep(
    rows,
    "guide_min_disp_vol_notToxic",
    (r) => r.impulseBin === "dispOK" && r.volBin === "vol15+" && !r.toxic,
    Y1_FROM,
    Y1_TO,
  ),
  softKeep(rows, "sameBar_only", (r) => r.sameBar, Y1_FROM, Y1_TO),
  softKeep(rows, "pdh_pdl_only", (r) => r.level === "pdh" || r.level === "pdl", Y1_FROM, Y1_TO),
  softKeep(
    rows,
    "prepared_range_disp_vol",
    (r) => r.day === "range" && r.impulseBin === "dispOK" && r.volBin === "vol15+",
    Y1_FROM,
    Y1_TO,
  ),
];
for (const s of soft) {
  console.log(
    `${s.label.padEnd(32)} n=${String(s.n).padStart(3)} tw=${s.tw} ret=${String(s.ret).padStart(7)}% pf=${s.pf}${s.pass ? " ★" : ""}`,
  );
}

/** Guide-correct hard variants — isolated then small stacks matching soft winners */
const VARIANTS = [
  ["CORE", {}],
  // Structural exits
  ["TP_uncapped", { intradayLiqMaxTpRr: 0 }],
  ["TP_cap3", { intradayLiqMaxTpRr: 3 }],
  ["ATR_SL_buf_0.2", { intradayLiqSlBufferAtrMult: 0.2 }],
  ["minSl_0.012", { intradayLiqMinSlPct: 0.012 }],
  // Fake-sweep quality (guide)
  ["wickBody_1.5", { intradayLiqMinSweepWickBodyRatio: 1.5 }],
  ["vol_1.5", { intradayLiqSweepMinVolRatio: 1.5 }],
  ["sameBar", { intradayLiqRequireSameBarReclaim: true }],
  ["dispV2_1.2", { intradayLiqRequireDisplacementV2: true, intradayLiqSweepDisplacementMinAtrMult: 1.2 }],
  ["choch", { intradayLiqRequireChoch: true }],
  ["killzone", { intradayLiqRequireKillzone: true }],
  // Entry timing (guide step 4 — retest)
  ["mitigation_0.5", { intradayLiqMitigationEntry: true, intradayLiqMitigationFrac: 0.5, intradayLiqMitigationWaitBars: 8 }],
  // Soft-inspired stacks (still ≤3 knobs)
  ["disp_vol", { intradayLiqRequireDisplacementV2: true, intradayLiqSweepMinVolRatio: 1.5 }],
  ["disp_vol_minSl", { intradayLiqRequireDisplacementV2: true, intradayLiqSweepMinVolRatio: 1.5, intradayLiqMinSlPct: 0.012 }],
  ["disp_vol_atrBuf", { intradayLiqRequireDisplacementV2: true, intradayLiqSweepMinVolRatio: 1.5, intradayLiqSlBufferAtrMult: 0.2 }],
  ["choch_disp", { intradayLiqRequireChoch: true, intradayLiqRequireDisplacementV2: true }],
  ["guide_lite", {
    intradayLiqRequireDisplacementV2: true,
    intradayLiqSweepMinVolRatio: 1.5,
    intradayLiqSlBufferAtrMult: 0.2,
    intradayLiqDaySituationBias: true,
  }],
  ["guide_mss_entry", {
    intradayLiqRequireChoch: true,
    intradayLiqRequireDisplacementV2: true,
    intradayLiqMitigationEntry: true,
    intradayLiqMitigationFrac: 0.5,
    intradayLiqMitigationWaitBars: 8,
    intradayLiqSlBufferAtrMult: 0.2,
  }],
];

console.log("\n========== HARD A/B Y1 + HOLD ==========");
const hard = [];
for (const [id, over] of VARIANTS) {
  process.stderr.write(`${id}…\n`);
  const y1t = await runSim(candles, funding, over, Y1_FROM, Y1_TO);
  const holdt = await runSim(candles, funding, over, HOLD_FROM, HOLD_TO);
  const y1 = metrics(y1t, Y1_FROM, Y1_TO);
  const hold = metrics(holdt, HOLD_FROM, HOLD_TO);
  const pass = y1.pf >= 1 && y1.ret > 0 && y1.tw >= 2 && hold.pf >= 1 && hold.ret > 0 && hold.tw >= 2;
  const y1Only = y1.pf >= 1 && y1.ret > 0 && y1.tw >= 2;
  hard.push({ id, over, y1, hold, pass, y1Only });
  console.log(
    `${id.padEnd(22)} Y1 n=${String(y1.n).padStart(3)} tw=${y1.tw} ret=${String(y1.ret).padStart(7)}% pf=${y1.pf} | HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)}% pf=${hold.pf}${pass ? " ★PASS" : y1Only ? " ◆Y1" : ""}`,
  );
}

const promote = hard.filter((h) => h.pass);
const bestY1 = [...hard].sort((a, b) => b.y1.pf - a.y1.pf || b.y1.ret - a.y1.ret)[0];
const verdict = promote.length
  ? "PROMOTE_CANDIDATE"
  : hard.some((h) => h.y1Only)
    ? "Y1_ONLY"
    : "REJECT";

const out = {
  generatedAt: new Date().toISOString(),
  IMPLEMENTATION_GAP,
  baselineY1,
  cells: {
    prepared: cells.byPreparedKey.filter((c) => c.label === "prepared"),
    bleed: cells.byPreparedKey.filter((c) => c.label === "bleed").slice(0, 20),
    byDayImpulse: cells.byDayImpulse,
    byWickVol: cells.byWickVol,
    byToxicImpulse: cells.byToxicImpulse,
  },
  soft,
  softPassers: soft.filter((s) => s.pass).map((s) => s.label),
  hard,
  bestY1: { id: bestY1?.id, y1: bestY1?.y1, hold: bestY1?.hold },
  promote: promote.map((p) => p.id),
  verdict,
};

const outPath = path.join(__dirname, ".liq-bnb-guide-correct-optimize.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict} bestY1=${bestY1?.id} wrote ${outPath}`);
await closePool?.();
