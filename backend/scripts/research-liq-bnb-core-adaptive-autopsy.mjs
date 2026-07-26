#!/usr/bin/env node
/**
 * BNB LIQ_CORE — adaptive autopsy + relative FT soft-proof + continuous abstain soft search.
 *
 * Phase 1–3 of adaptive LIQ plan:
 * 1) Every-trade loss taxonomy (fail × dayType × level × session × year) + FT distance
 * 2) Soft-proof flexible FT modes (fixed / atrPct / volSpike / regime)
 * 3) Soft-search continuous relative abstains
 *
 * Soft promote bar: FULL PF≥1 + Y25 ret>0 + H12 ret>0 + tw≥2 (oracle MFE keep is reference only).
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-core-adaptive-autopsy.mjs
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
const { buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const {
  measureGuideFollowThrough,
  resolveFollowThroughParams,
} = await import("../src/strategy/techniques/liquidity.js");

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

function metricsFromRows(rows, lo, hi) {
  const s = rows.filter((r) => r.entryTs >= lo && r.entryTs < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  const trades = [];
  for (const r of s) {
    eq += r.pnl;
    curve.push({ ts: r.exitTs || r.entryTs, equity: eq });
    trades.push({ netPnl: r.pnl, exitReason: r.exitReason, entryTs: r.entryTs, exitTs: r.exitTs });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: 100 });
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

function softGates(windows) {
  const full = windows.FULL;
  const y25 = windows.Y2025;
  const h12 = windows.H12m;
  return {
    fullPf: full?.pf ?? null,
    y25Ret: y25?.ret ?? null,
    h12Ret: h12?.ret ?? null,
    tw: full?.tw ?? null,
    pass:
      (full?.pf ?? 0) >= 1 &&
      (y25?.ret ?? -Infinity) > 0 &&
      (h12?.ret ?? -Infinity) > 0 &&
      (full?.tw ?? 0) >= 2,
  };
}

function rateBy(rows, keyFn, minN = 8) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [];
  for (const [k, xs] of buckets) {
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
      if (r.fc === "never_green" || r.fc === "sl_no_follow") death += 1;
    }
    out.push({
      k,
      n: xs.length,
      pnl: +pnl.toFixed(2),
      avg: +(pnl / xs.length).toFixed(3),
      pf: +(gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(3),
      wr: +((100 * wins) / xs.length).toFixed(1),
      deathPct: +((100 * death) / xs.length).toFixed(1),
    });
  }
  return out.sort((a, b) => a.avg - b.avg);
}

function windowMetrics(rows, windows) {
  const out = {};
  for (const w of windows) out[w.id] = metricsFromRows(rows, w.lo, w.hi);
  return out;
}

function softKeep(rows, windows, label, pred) {
  const keep = rows.filter(pred);
  const w = windowMetrics(keep, windows);
  return { label, keep: keep.length, windows: w, gates: softGates(w) };
}

console.log(`\n=== BNB CORE adaptive autopsy === ${FROM}→${TO}`);

const padMs = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - padMs, toMs).catch(() => []);
const pre = precomputeIntraday(candles);
const windows = yearWindows(fromMs, toMs);

clearIntradayAdapterCache?.();
let cfg = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
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

const closed = (sim.trades ?? []).filter(
  (t) =>
    String(t.exitReason ?? "") !== "tp1_partial" &&
    Number(t.entryTs) >= fromMs &&
    Number(t.entryTs) < toMs,
);

const rows = [];
for (const t of closed) {
  const feat = t.liqContext?.features ?? null;
  const ms = feat?.marketState ?? {};
  const sweep = feat?.sweep ?? {};
  const disp = feat?.displacement ?? {};
  const cont = feat?.continuation ?? {};
  const side = String(t.side ?? t.direction ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const daySituation = String(ms.daySituation ?? "range");
  const level = String(feat?.level?.type ?? t.liqContext?.levelType ?? "?");
  const session = String(feat?.sessionNarrative ?? ms.sessionNarrative ?? "?");
  const atrPct = Number(ms.atrPct ?? 0);
  const volSpike = Number(sweep.sweepVolSpike ?? 1);
  const absorption = Number(sweep.absorptionProxy ?? 0);
  const accel = Number(sweep.sweepAcceleration ?? 0);
  const exhaustion = Number(sweep.exhaustionScore ?? 0);
  const dailyUsed = Number(cont.dailyRangeUsedPct ?? 0);
  const remainAtr = Number(cont.remainingDailyAtr ?? 0);
  const expansion = String(cont.expansionState ?? "?");
  const impulseAtr = Number(disp.impulseAtr ?? 0);
  const distOppR = Number(cont.distanceToOpposingR ?? 0);
  const htfAgainst =
    (side === "BUY" && Number(feat?.scoreV2?.components?.htf ?? 0) < 0) ||
    (side === "SELL" && Number(feat?.scoreV2?.components?.htf ?? 0) < 0);

  const cycle = {
    sweepStartIdx: Number(feat?.sweepStartIdx ?? -1),
    reclaimIdx: Number(feat?.reclaimIdx ?? -1),
  };
  const ft2 = measureGuideFollowThrough(candles, cycle, side, pre, 2);
  const ft3 = measureGuideFollowThrough(candles, cycle, side, pre, 3);
  const ftCtx = { atrPct, volSpike, daySituation };

  const fakeReversal =
    ((daySituation === "breakout" && side === "SELL") ||
      (daySituation === "breakdown" && side === "BUY") ||
      (accel > 0.5 && absorption < 0.35) ||
      htfAgainst) === true;

  const year = new Date(Number(t.entryTs)).getUTCFullYear();
  const pnl = Number(t.netPnl ?? 0);
  const mfe = Number(t.mfePct ?? 0);
  rows.push({
    entryTs: Number(t.entryTs),
    exitTs: Number(t.exitTs ?? t.entryTs),
    exitReason: String(t.exitReason ?? ""),
    side,
    pnl,
    mfe,
    survivor: mfe >= 0.005,
    fc: failClass(t),
    daySituation,
    level,
    session,
    year,
    atrPct,
    volSpike,
    absorption,
    accel,
    exhaustion,
    dailyUsed,
    remainAtr,
    expansion,
    impulseAtr,
    distOppR,
    htfAgainst,
    fakeReversal,
    ftRatio2: ft2.ratio,
    ftRatio3: ft3.ratio,
    ftCtx,
  });
}

const baselineWindows = windowMetrics(rows, windows);
console.log("\n--- Baseline CORE ---");
for (const [id, m] of Object.entries(baselineWindows)) {
  console.log(
    `${id.padEnd(6)} n=${String(m.n).padStart(4)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% pf=${m.pf} wr=${m.wr}%`,
  );
}

const taxonomy = {
  byFail: rateBy(rows, (r) => r.fc, 5),
  byDayType: rateBy(rows, (r) => r.daySituation, 5),
  byFailDay: rateBy(rows, (r) => `${r.fc}|${r.daySituation}`, 8),
  byLevel: rateBy(rows, (r) => r.level, 8),
  bySession: rateBy(rows, (r) => r.session, 8),
  byYearFail: rateBy(rows, (r) => `${r.year}|${r.fc}`, 5),
  byFakeReversal: rateBy(rows, (r) => (r.fakeReversal ? "fake_rev" : "clean"), 5),
  byFailFake: rateBy(rows, (r) => `${r.fc}|${r.fakeReversal ? "fake" : "ok"}`, 5),
};

const loss$ = rows.filter((r) => r.pnl < 0).reduce((s, r) => s + r.pnl, 0);
const death$ = rows
  .filter((r) => r.fc === "never_green" || r.fc === "sl_no_follow")
  .reduce((s, r) => s + Math.min(0, r.pnl), 0);
const fakeLoss$ = rows.filter((r) => r.fakeReversal && r.pnl < 0).reduce((s, r) => s + r.pnl, 0);

console.log("\n--- Top loss cells (byFailDay) ---");
for (const row of taxonomy.byFailDay.slice(0, 12)) {
  console.log(
    `${row.k.padEnd(28)} n=${row.n} pnl=${row.pnl} pf=${row.pf} death%=${row.deathPct}`,
  );
}

const primaryFailure = (() => {
  const deathShare = loss$ < 0 ? death$ / loss$ : 0;
  const fakeShare = loss$ < 0 ? fakeLoss$ / loss$ : 0;
  if (deathShare >= 0.7) {
    return {
      name: "instant_no_follow",
      deathLossShare: +((deathShare) * 100).toFixed(1),
      fakeLossShare: +((fakeShare) * 100).toFixed(1),
      note: "Dominant $ loss is never_green/sl_no_follow; relative FT / continuous room must separate survivors",
    };
  }
  return {
    name: "mixed",
    deathLossShare: +((deathShare) * 100).toFixed(1),
    fakeLossShare: +((fakeShare) * 100).toFixed(1),
  };
})();
console.log("\nprimaryFailure=", JSON.stringify(primaryFailure));

// --- Phase 2: relative FT soft ---
function passesFtMode(r, over) {
  const { mult, lookBars } = resolveFollowThroughParams(over, r.ftCtx);
  const ratio = lookBars >= 3 ? r.ftRatio3 : r.ftRatio2;
  // if lookBars=2 use ft2; if 3 use ft3; intermediate ≈ ft2 for soft
  const used = lookBars <= 2 ? r.ftRatio2 : r.ftRatio3;
  return used + 1e-12 >= mult;
}

const ftCandidates = [
  {
    label: "FT_fixed_0.5_2",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "fixed",
      intradayLiqFollowThroughAtrMult: 0.5,
      intradayLiqFollowThroughBars: 2,
    },
  },
  {
    label: "FT_fixed_1.0_2",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "fixed",
      intradayLiqFollowThroughAtrMult: 1.0,
      intradayLiqFollowThroughBars: 2,
    },
  },
  {
    label: "FT_fixed_1.0_3",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "fixed",
      intradayLiqFollowThroughAtrMult: 1.0,
      intradayLiqFollowThroughBars: 3,
    },
  },
  {
    label: "FT_atrPct",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "atrPct",
      intradayLiqFtQuietAtrPct: 0.004,
      intradayLiqFtBusyAtrPct: 0.01,
      intradayLiqFtQuietMult: 1.0,
      intradayLiqFtBusyMult: 0.4,
      intradayLiqFollowThroughBars: 2,
    },
  },
  {
    label: "FT_volSpike",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "volSpike",
      intradayLiqFtWeakVol: 1.2,
      intradayLiqFtWeakVolMult: 1.0,
      intradayLiqFtStrongVolMult: 0.4,
      intradayLiqFollowThroughBars: 2,
    },
  },
  {
    label: "FT_regime",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "regime",
      intradayLiqFtRangeMult: 0.5,
      intradayLiqFtRangeBars: 2,
      intradayLiqFtBreakMult: 1.0,
      intradayLiqFtBreakBars: 3,
    },
  },
  {
    label: "FT_regime_strict",
    over: {
      intradayLiqRequireFollowThrough: true,
      intradayLiqFollowThroughMode: "regime",
      intradayLiqFtRangeMult: 0.75,
      intradayLiqFtRangeBars: 2,
      intradayLiqFtBreakMult: 1.25,
      intradayLiqFtBreakBars: 3,
    },
  },
];

console.log("\n========== PHASE 2 — relative FT soft ==========");
const softFt = [];
for (const c of ftCandidates) {
  const row = softKeep(rows, windows, c.label, (r) => passesFtMode(r, c.over));
  softFt.push({ ...row, over: c.over });
  const g = row.gates;
  console.log(
    `${c.label.padEnd(22)} n=${String(row.keep).padStart(4)} tw=${row.windows.FULL.tw} FULL pf=${row.windows.FULL.pf} ret=${row.windows.FULL.ret} Y25=${row.windows.Y2025.ret} H12=${row.windows.H12m.ret}${g.pass ? " ★PASS" : ""}`,
  );
}

// oracle reference
const oracle = softKeep(rows, windows, "oracle_mfe05", (r) => r.survivor);
console.log(
  `${"oracle_mfe05".padEnd(22)} n=${oracle.keep} tw=${oracle.windows.FULL.tw} FULL pf=${oracle.windows.FULL.pf} ret=${oracle.windows.FULL.ret} Y25=${oracle.windows.Y2025.ret} H12=${oracle.windows.H12m.ret}${oracle.gates.pass ? " ★PASS" : ""}`,
);

// --- Phase 3: continuous relative abstains ---
console.log("\n========== PHASE 3 — continuous relative soft ==========");
const contCandidates = [
  ["abstain_fakeReversal", (r) => !r.fakeReversal],
  ["dailyUsed_lt_0.55", (r) => r.dailyUsed < 0.55],
  ["dailyUsed_lt_0.70", (r) => r.dailyUsed < 0.70],
  ["remainAtr_gte_1.0", (r) => r.remainAtr >= 1.0],
  ["remainAtr_gte_1.5", (r) => r.remainAtr >= 1.5],
  ["expansion_not_spent", (r) => r.expansion !== "spent" && r.expansion !== "exhausted"],
  ["absorption_gte_0.45", (r) => r.absorption >= 0.45],
  ["absorption_gte_0.55", (r) => r.absorption >= 0.55],
  ["accel_lt_0.40", (r) => !(r.accel > 0.4)],
  ["accel_lt_0.25", (r) => !(r.accel > 0.25)],
  ["exhaustion_gte_0.45", (r) => r.exhaustion >= 0.45],
  ["impulse_x_room", (r) => r.impulseAtr >= 0.8 && r.distOppR >= 1.2],
  ["impulse_x_room_loose", (r) => r.impulseAtr >= 0.5 && r.distOppR >= 1.0],
  ["absorb_not_accel", (r) => r.absorption >= 0.4 && !(r.accel > 0.35)],
  ["room_and_not_fake", (r) => !r.fakeReversal && r.dailyUsed < 0.7 && r.remainAtr >= 1.0],
  ["survivor_proxy_combo", (r) => r.absorption >= 0.4 && r.dailyUsed < 0.65 && r.impulseAtr >= 0.6],
];

const softCont = [];
for (const [label, pred] of contCandidates) {
  const row = softKeep(rows, windows, label, pred);
  softCont.push(row);
  const g = row.gates;
  console.log(
    `${label.padEnd(24)} n=${String(row.keep).padStart(4)} tw=${row.windows.FULL.tw} FULL pf=${row.windows.FULL.pf} ret=${row.windows.FULL.ret} Y25=${row.windows.Y2025.ret} H12=${row.windows.H12m.ret}${g.pass ? " ★PASS" : ""}`,
  );
}

// compounds only if both parents soft-improve FULL PF vs baseline
const basePf = baselineWindows.FULL.pf;
const ftImprovers = softFt.filter((s) => s.windows.FULL.pf > basePf + 0.05 && s.windows.FULL.tw >= 2);
const contImprovers = softCont.filter(
  (s) => s.windows.FULL.pf > basePf + 0.05 && s.windows.FULL.tw >= 2,
);
const softCompounds = [];
if (ftImprovers.length && contImprovers.length) {
  console.log("\n========== compounds (improvers only) ==========");
  for (const ft of ftImprovers.slice(0, 3)) {
    for (const ct of contImprovers.slice(0, 3)) {
      const label = `${ft.label}+${ct.label}`;
      const pred = (r) =>
        passesFtMode(r, ft.over) &&
        contCandidates.find((c) => c[0] === ct.label)?.[1](r);
      const row = softKeep(rows, windows, label, pred);
      softCompounds.push({ ...row, parents: [ft.label, ct.label] });
      console.log(
        `${label.padEnd(40)} n=${row.keep} tw=${row.windows.FULL.tw} pf=${row.windows.FULL.pf} Y25=${row.windows.Y2025.ret} H12=${row.windows.H12m.ret}${row.gates.pass ? " ★PASS" : ""}`,
      );
    }
  }
}

const softPassers = [
  ...softFt.filter((s) => s.gates.pass),
  ...softCont.filter((s) => s.gates.pass),
  ...softCompounds.filter((s) => s.gates.pass),
];

const hardCandidates = softPassers.length
  ? softPassers.map((s) => ({
      source: "soft_pass",
      label: s.label,
      over: s.over ?? null,
      windows: s.windows,
    }))
  : [...softFt, ...softCont, ...softCompounds]
      .filter((s) => s.windows.FULL.tw >= 2)
      .sort((a, b) => b.windows.FULL.pf - a.windows.FULL.pf)
      .slice(0, 5)
      .map((s) => ({
        source: "best_soft_fail",
        label: s.label,
        over: s.over ?? null,
        windows: s.windows,
      }));

const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  from: FROM,
  to: TO,
  primaryFailure,
  baseline: baselineWindows,
  taxonomy: {
    byFail: taxonomy.byFail,
    byDayType: taxonomy.byDayType,
    byFailDay: taxonomy.byFailDay.slice(0, 20),
    byLevel: taxonomy.byLevel,
    bySession: taxonomy.bySession,
    byFakeReversal: taxonomy.byFakeReversal,
    byFailFake: taxonomy.byFailFake,
  },
  softFt,
  softCont,
  softCompounds,
  oracle,
  softPassers: softPassers.map((s) => s.label),
  hardCandidates,
  nTrades: rows.length,
  // compact trade sample for follow-ups (not full dump — disk)
  tradeSummary: {
    deathLossShare: primaryFailure.deathLossShare,
    fakeLossShare: primaryFailure.fakeLossShare,
    survivors: rows.filter((r) => r.survivor).length,
    death: rows.filter((r) => r.fc === "never_green" || r.fc === "sl_no_follow").length,
  },
};

const outPath = path.join(__dirname, ".liq-bnb-core-adaptive-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nsoftPassers=${softPassers.length} hardCandidates=${hardCandidates.length}`);
console.log(`wrote ${outPath}`);

await closePool?.();
