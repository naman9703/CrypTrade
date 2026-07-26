#!/usr/bin/env node
/**
 * BNB LIQ — residual autopsy inside prepared cell (dispOK ∧ slWide) + iterate to gates.
 *
 * Base lock path from prior work: RequireDisplacementV2 + MinSlPct≥1.2%.
 * Soft: find relative abstain inside cell that clears Y1 soft PF≥1 ret>0 tw≥2.
 * Hard: one-change then small stacks; also multi-coin freq restore; exit tweaks.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-prepared-cell-lock.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const Y1_FROM = Date.parse(process.env.FROM || "2025-07-01");
const Y1_TO = Date.parse(process.env.TO || "2026-07-01");
const HOLD_FROM = Date.parse(process.env.HOLD_FROM || "2024-07-01");
const HOLD_TO = Date.parse(process.env.HOLD_TO || "2025-07-01");
const FULL_FROM = Date.parse(process.env.FULL_FROM || "2023-07-01");
const FULL_TO = Date.parse(process.env.FULL_TO || "2026-07-01");

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { buildLiqMarketContext } = await import("../src/strategy/techniques/liq/marketState.js");

const BASE = {
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.012,
};

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

function gatesOk(m) {
  return m.pf >= 1 && m.ret > 0 && m.tw >= 2;
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

function retN(candles, idx, n) {
  if (idx < n) return NaN;
  const a = Number(candles[idx - n]?.close);
  const b = Number(candles[idx]?.close);
  if (!(a > 0)) return NaN;
  return (b - a) / a;
}

function rateBy(rows, keyFn, minN = 5) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = [];
  for (const [k, xs] of map) {
    if (xs.length < minN) continue;
    let gp = 0;
    let gl = 0;
    let pnl = 0;
    let wins = 0;
    for (const r of xs) {
      pnl += r.pnl;
      if (r.pnl > 0) {
        gp += r.pnl;
        wins += 1;
      } else gl += Math.abs(r.pnl);
    }
    out.push({
      k,
      n: xs.length,
      pnl: +pnl.toFixed(2),
      avg: +(pnl / xs.length).toFixed(4),
      pf: +(gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(3),
      wr: +((100 * wins) / xs.length).toFixed(1),
    });
  }
  return out.sort((a, b) => a.avg - b.avg);
}

async function runSim(symbol, candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...BASE,
    ...(over || {}),
    symbol,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: Number(over?.riskPerTrade ?? 2.5),
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: lo,
  };
  // riskPerTrade may be in over for sizing tests — strip non-engine keys already spread
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
    symbol,
  });
  return (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi,
  );
}

function enrich(trades, candles, pre) {
  const rows = [];
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const entryIdx = findIdx(candles, Number(t.entryTs));
    if (entryIdx < 0) continue;
    const feat = t.liqContext?.features ?? null;
    const ms = feat?.marketState ?? buildLiqMarketContext(candles, entryIdx, pre, {}) ?? {};
    const side = String(t.side ?? t.direction ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
    const entryPx = Number(t.entryFill ?? t.entryPrice ?? candles[entryIdx].close);
    const slPx = Number(t.initialSlPrice ?? t.slPrice ?? 0);
    const slPct = entryPx > 0 && slPx > 0 ? Math.abs(entryPx - slPx) / entryPx : 0;
    const impulse = Number(feat?.displacement?.impulseAtr ?? 0);
    const day = String(ms.daySituation ?? "range");
    const toxic =
      (day === "breakout" && side === "SELL") || (day === "breakdown" && side === "BUY");
    const prior4 = retN(candles, entryIdx, 4);
    const prior16 = retN(candles, entryIdx, 16);
    const prior64 = retN(candles, entryIdx, 64);
    const fadeAlign =
      (side === "BUY" && Number.isFinite(prior16) && prior16 < -0.003) ||
      (side === "SELL" && Number.isFinite(prior16) && prior16 > 0.003);
    const chase =
      (side === "BUY" && Number.isFinite(prior16) && prior16 > 0.005) ||
      (side === "SELL" && Number.isFinite(prior16) && prior16 < -0.005);
    const hour = new Date(Number(t.entryTs)).getUTCHours();
    const mfe = Number(t.mfePct ?? 0);
    rows.push({
      entryTs: Number(t.entryTs),
      exitTs: Number(t.exitTs ?? t.entryTs),
      exitReason: String(t.exitReason ?? ""),
      pnl: Number(t.netPnl ?? 0),
      mfe,
      side,
      day,
      toxic,
      level: String(feat?.level?.type ?? t.liqContext?.levelType ?? "?"),
      session: String(feat?.sessionNarrative ?? ms.sessionNarrative ?? "?"),
      vol: Number(feat?.sweep?.sweepVolSpike ?? 0),
      abs: Number(feat?.sweep?.absorptionProxy ?? 0),
      bodyEff: Number(feat?.displacement?.bodyEfficiency ?? 0),
      dailyUsed: Number(feat?.continuation?.dailyRangeUsedPct ?? 0),
      remain: Number(feat?.continuation?.remainingDailyAtr ?? 0),
      atrPct: Number(ms.atrPct ?? 0),
      adx: Number(ms.adx ?? 0),
      impulse,
      slPct,
      prior4,
      prior16,
      prior64,
      fadeAlign,
      chase,
      hour,
      kz: hour >= 7 && hour < 16, // rough London+NY UTC
      asia: hour >= 0 && hour < 7,
      pdhPdl: ["pdh", "pdl"].includes(String(feat?.level?.type ?? "")),
      survivor: mfe >= 0.005,
    });
  }
  return rows;
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
  return { label, ...m, pass: gatesOk(m) };
}

console.log("=== Prepared-cell residual lock ===\n");

const pad = 30 * 864e5;
const dataLo = Math.min(FULL_FROM, HOLD_FROM, Y1_FROM) - pad;
const dataHi = Math.max(FULL_TO, HOLD_TO, Y1_TO);

const bnbCandles = await readCandles("BNBUSDT", TF, dataLo, dataHi, { market: "futures" });
const bnbFunding = await readFundingRates("BNBUSDT", dataLo, dataHi).catch(() => []);
const bnbPre = precomputeIntraday(bnbCandles);

// --- Soft: CORE trades filtered to prepared cell (approx), then BASE hard harvest ---
console.log("Harvest BASE (disp+minSl) Y1…");
const baseY1Trades = await runSim("BNBUSDT", bnbCandles, bnbFunding, {}, Y1_FROM, Y1_TO);
const baseRows = enrich(baseY1Trades, bnbCandles, bnbPre);
const baseM = metrics(baseY1Trades, Y1_FROM, Y1_TO);
console.log(`BASE Y1 n=${baseM.n} tw=${baseM.tw} ret=${baseM.ret}% pf=${baseM.pf}`);

// Residual clusters on BASE trades
const clusters = {
  bySession: rateBy(baseRows, (r) => r.session),
  byLevel: rateBy(baseRows, (r) => r.level),
  byDay: rateBy(baseRows, (r) => r.day),
  bySideDay: rateBy(baseRows, (r) => `${r.side}|${r.day}`),
  byToxic: rateBy(baseRows, (r) => (r.toxic ? "toxic" : "ok")),
  byFade: rateBy(baseRows, (r) => (r.fadeAlign ? "fadeAlign" : "notFade")),
  byChase: rateBy(baseRows, (r) => (r.chase ? "chase" : "ok")),
  byHourBand: rateBy(baseRows, (r) => (r.asia ? "asia" : r.kz ? "kz" : "off")),
  byVol: rateBy(baseRows, (r) => (r.vol >= 1.5 ? "vol15+" : "vol<15")),
  byDailyUsed: rateBy(baseRows, (r) => (r.dailyUsed >= 0.7 ? "spent" : "room")),
  byAbs: rateBy(baseRows, (r) => (r.abs >= 0.55 ? "absHi" : "absLo")),
  byBodyEff: rateBy(baseRows, (r) => (r.bodyEff >= 0.5 ? "bodyHi" : "bodyLo")),
  bySideSession: rateBy(baseRows, (r) => `${r.side}|${r.session}`),
  byLevelDay: rateBy(baseRows, (r) => `${r.level}|${r.day}`),
};

console.log("\n--- residual worst cells ---");
for (const [name, list] of Object.entries(clusters)) {
  const worst = list[0];
  if (worst) console.log(`${name.padEnd(14)} worst=${worst.k} n=${worst.n} pnl=${worst.pnl} pf=${worst.pf}`);
}

console.log("\n========== SOFT abstains on BASE trades ==========");
const softRules = [
  ["H0", () => true],
  ["drop_toxic", (r) => !r.toxic],
  ["keep_fadeAlign", (r) => r.fadeAlign],
  ["drop_chase", (r) => !r.chase],
  ["asia_only", (r) => r.asia],
  ["kz_only", (r) => r.kz],
  ["drop_asia", (r) => !r.asia],
  ["pdh_pdl", (r) => r.pdhPdl],
  ["vol15", (r) => r.vol >= 1.5],
  ["drop_spent", (r) => r.dailyUsed < 0.7],
  ["absLo", (r) => r.abs < 0.55],
  ["bodyHi", (r) => r.bodyEff >= 0.5],
  ["fade_not_toxic", (r) => r.fadeAlign && !r.toxic],
  ["fade_pdh_pdl", (r) => r.fadeAlign && r.pdhPdl],
  ["not_toxic_kz", (r) => !r.toxic && r.kz],
  ["not_toxic_vol15", (r) => !r.toxic && r.vol >= 1.5],
  ["not_toxic_fade_vol", (r) => !r.toxic && r.fadeAlign && r.vol >= 1.2],
  ["drop_SELL_breakout", (r) => !(r.side === "SELL" && r.day === "breakout")],
  ["drop_BUY_breakdown", (r) => !(r.side === "BUY" && r.day === "breakdown")],
  ["range_only", (r) => r.day === "range"],
  ["range_or_aligned", (r) => r.day === "range" || r.fadeAlign],
  ["oracle_mfe05", (r) => r.survivor],
];
const soft = softRules.map(([label, pred]) => softKeep(baseRows, label, pred, Y1_FROM, Y1_TO));
for (const s of soft) {
  console.log(
    `${s.label.padEnd(24)} n=${String(s.n).padStart(3)} tw=${s.tw} ret=${String(s.ret).padStart(7)}% pf=${s.pf}${s.pass ? " ★" : ""}`,
  );
}

const softPass = soft.filter((s) => s.pass && s.label !== "oracle_mfe05");
const softNear = soft
  .filter((s) => s.label !== "oracle_mfe05" && s.tw >= 1.5 && s.n >= 40)
  .sort((a, b) => b.pf - a.pf || b.ret - a.ret)
  .slice(0, 8);

/** Map soft → hard overrides (on top of BASE) */
const HARD_MAP = {
  drop_toxic: { intradayLiqDaySituationBias: true },
  keep_fadeAlign: { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true },
  drop_chase: { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true },
  asia_only: { intradayLiqSessionNarratives: "asia_accum" },
  kz_only: { intradayLiqRequireKillzone: true },
  drop_asia: {
    // deny asia via narratives london+ny
    intradayLiqSessionNarratives: "london_sweep,ny_continuation",
  },
  pdh_pdl: { intradayLiqSessionExtreme: false },
  vol15: { intradayLiqSweepMinVolRatio: 1.5 },
  drop_spent: { intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 },
  fade_not_toxic: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  not_toxic_kz: { intradayLiqDaySituationBias: true, intradayLiqRequireKillzone: true },
  not_toxic_vol15: { intradayLiqDaySituationBias: true, intradayLiqSweepMinVolRatio: 1.5 },
  not_toxic_fade_vol: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
    intradayLiqSweepMinVolRatio: 1.2,
  },
  range_only: { intradayLiqDaySituationBias: true, intradayLiqVetoCounterTrend: true },
  // exit / risk experiments (not soft-mapped)
};

const hardTargets = softPass.length
  ? softPass.map((s) => s.label)
  : softNear.map((s) => s.label);

// Always include smart structural / exit / size experiments
const EXTRA = [
  ["BASE", {}],
  ["BASE_tp15", { intradayLiqMaxTpRr: 1.5 }],
  ["BASE_tp25", { intradayLiqMaxTpRr: 2.5 }],
  ["BASE_hold24", { intradayLiqMaxHoldBars: 24 }],
  ["BASE_hold36", { intradayLiqMaxHoldBars: 36 }],
  ["BASE_atrBuf", { intradayLiqSlBufferAtrMult: 0.2 }],
  ["BASE_minSl010", { intradayLiqMinSlPct: 0.01 }], // slightly looser freq
  ["BASE_disp15", { intradayLiqSweepDisplacementMinAtrMult: 1.5 }],
  ["BASE_disp10", { intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["BASE_risk1", { riskPerTrade: 1.0 }],
  ["BASE_mit05", { intradayLiqMitigationEntry: true, intradayLiqMitigationFrac: 0.5, intradayLiqMitigationWaitBars: 6 }],
  ["BASE_toxic", { intradayLiqDaySituationBias: true }],
  ["BASE_toxic_vol12", { intradayLiqDaySituationBias: true, intradayLiqSweepMinVolRatio: 1.2 }],
  ["BASE_toxic_pdh", { intradayLiqDaySituationBias: true, intradayLiqSessionExtreme: false }],
  ["BASE_toxic_hold24", { intradayLiqDaySituationBias: true, intradayLiqMaxHoldBars: 24 }],
  ["BASE_toxic_tp15", { intradayLiqDaySituationBias: true, intradayLiqMaxTpRr: 1.5 }],
  ["BASE_fade_toxic", HARD_MAP.fade_not_toxic],
  ["BASE_kz_toxic", HARD_MAP.not_toxic_kz],
  ["BASE_vol15_toxic", HARD_MAP.not_toxic_vol15],
];

const seen = new Set();
const variants = [];
for (const [id, over] of EXTRA) {
  if (seen.has(id)) continue;
  seen.add(id);
  variants.push([id, over]);
}
for (const label of hardTargets) {
  const over = HARD_MAP[label];
  if (!over) continue;
  const id = `soft_${label}`;
  if (seen.has(id)) continue;
  seen.add(id);
  variants.push([id, over]);
}

console.log(`\n========== HARD Y1 + HOLD (${variants.length} variants) ==========`);
const hard = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}…\n`);
  const y1t = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, Y1_FROM, Y1_TO);
  const ht = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, HOLD_FROM, HOLD_TO);
  const y1 = metrics(y1t, Y1_FROM, Y1_TO);
  const hold = metrics(ht, HOLD_FROM, HOLD_TO);
  const pass = gatesOk(y1) && gatesOk(hold);
  const y1Only = gatesOk(y1);
  hard.push({ id, over, y1, hold, pass, y1Only });
  console.log(
    `${id.padEnd(28)} Y1 n=${String(y1.n).padStart(3)} tw=${y1.tw} ret=${String(y1.ret).padStart(7)}% pf=${y1.pf} | HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)}% pf=${hold.pf}${pass ? " ★PASS" : y1Only ? " ◆Y1" : ""}`,
  );
}

let promote = hard.filter((h) => h.pass);
let best = [...hard].sort(
  (a, b) =>
    (b.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    (b.y1Only ? 1 : 0) - (a.y1Only ? 1 : 0) ||
    b.y1.pf + b.hold.pf - (a.y1.pf + a.hold.pf) ||
    b.y1.ret - a.y1.ret,
)[0];

// If something clears or is close, run FULL + multi-coin
const multi = [];
const followUps = [];
if (promote.length || (best && best.y1.pf >= 0.95 && best.hold.pf >= 0.95)) {
  const top = promote[0] || best;
  console.log(`\n========== FULL + multi-coin on ${top.id} ==========`);
  const symbols = ["BNBUSDT", "ETHUSDT", "BTCUSDT"];
  for (const sym of symbols) {
    process.stderr.write(`FULL ${sym} ${top.id}…\n`);
    const candles = sym === "BNBUSDT" ? bnbCandles : await readCandles(sym, TF, dataLo, dataHi, { market: "futures" });
    const funding =
      sym === "BNBUSDT"
        ? bnbFunding
        : await readFundingRates(sym, dataLo, dataHi).catch(() => []);
    const trades = await runSim(sym, candles, funding, top.over, FULL_FROM, FULL_TO);
    const m = metrics(trades, FULL_FROM, FULL_TO);
    multi.push({ symbol: sym, id: top.id, full: m });
    console.log(`${sym} FULL n=${m.n} tw=${m.tw} ret=${m.ret}% pf=${m.pf}`);
  }
}

// Second iteration: if best is toxic variants near green, try risk1% on best for Calmar-style
if (!promote.length && best) {
  const near = hard
    .filter((h) => h.y1.pf >= 0.9 && h.hold.pf >= 0.9)
    .slice(0, 3);
  for (const n of near) {
    const id = `${n.id}_risk1`;
    process.stderr.write(`${id}…\n`);
    const over = { ...n.over, riskPerTrade: 1.0 };
    const y1t = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, Y1_FROM, Y1_TO);
    const ht = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, HOLD_FROM, HOLD_TO);
    const y1 = metrics(y1t, Y1_FROM, Y1_TO);
    const hold = metrics(ht, HOLD_FROM, HOLD_TO);
    const pass = gatesOk(y1) && gatesOk(hold);
    followUps.push({ id, over, y1, hold, pass });
    console.log(
      `${id.padEnd(28)} Y1 pf=${y1.pf} ret=${y1.ret} tw=${y1.tw} | HOLD pf=${hold.pf} ret=${hold.ret} tw=${hold.tw}${pass ? " ★" : ""}`,
    );
  }
  promote = [...promote, ...followUps.filter((f) => f.pass)];
}

const allHard = [...hard, ...followUps];
best = [...allHard].sort(
  (a, b) =>
    (b.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    b.y1.pf + (b.hold?.pf ?? 0) - (a.y1.pf + (a.hold?.pf ?? 0)),
)[0];

const verdict = promote.length ? "PROMOTE_CANDIDATE" : best?.y1Only ? "Y1_ONLY" : "REJECT";

const out = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  baselineY1: baseM,
  clusters: {
    bySession: clusters.bySession,
    byLevel: clusters.byLevel,
    byDay: clusters.byDay,
    bySideDay: clusters.bySideDay,
    byToxic: clusters.byToxic,
    byFade: clusters.byFade,
    byChase: clusters.byChase,
    byHourBand: clusters.byHourBand,
    byVol: clusters.byVol,
    bySideSession: clusters.bySideSession.slice(0, 15),
    byLevelDay: clusters.byLevelDay.slice(0, 15),
  },
  soft,
  softPass: softPass.map((s) => s.label),
  hard: allHard,
  multi,
  best: best ? { id: best.id, y1: best.y1, hold: best.hold, pass: best.pass } : null,
  promote: promote.map((p) => p.id),
  verdict,
};

const outPath = path.join(__dirname, ".liq-bnb-prepared-cell-lock.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict} best=${best?.id} wrote ${outPath}`);
await closePool?.();
