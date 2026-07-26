#!/usr/bin/env node
/**
 * BNB LIQ PREPARED_MIT residual autopsy + freq-restore soft→hard.
 *
 * Path A: losers inside locked PREPARED_MIT (toxic on) — cut residual bleed → cushion → loosen.
 * Path B: high-freq near-miss mit+minSl+h020 (toxic OFF, tw≥2 both windows, HOLD red) —
 *         soft relative abstain until HOLD green with tw≥2, then hard-sim.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-prepared-mit-residual.mjs
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

const SLEEVE = {
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.5,
  intradayLiqMitigationWaitBars: 6,
  intradayLiqDaySituationBias: true,
};

const HI_FREQ = {
  ...SLEEVE,
  intradayLiqDaySituationBias: false,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
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

function egOk(m) {
  return m.pf >= 1 && m.ret > 0;
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

function rateBy(rows, keyFn, minN = 4) {
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
    const softToxic =
      (day === "breakout" && side === "SELL") ||
      (day === "breakdown" && side === "BUY") ||
      (day === "breakout" && side === "BUY" && Number(retN(candles, entryIdx, 16)) > 0.01) ||
      (day === "breakdown" && side === "SELL" && Number(retN(candles, entryIdx, 16)) < -0.01);
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
    const mae = Number(t.maePct ?? 0);
    const exitReason = String(t.exitReason ?? "");
    const microMfeThenSl = mfe > 0 && mfe < 0.005 && exitReason.toLowerCase().includes("sl");
    rows.push({
      entryTs: Number(t.entryTs),
      exitTs: Number(t.exitTs ?? t.entryTs),
      exitReason,
      pnl: Number(t.netPnl ?? 0),
      mfe,
      mae,
      side,
      day,
      toxic,
      softToxic,
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
      kz: hour >= 7 && hour < 16,
      asia: hour >= 0 && hour < 7,
      lateNy: hour >= 16 && hour < 20,
      pdhPdl: ["pdh", "pdl"].includes(String(feat?.level?.type ?? "")),
      survivor: mfe >= 0.005,
      microMfeThenSl,
      loser: Number(t.netPnl ?? 0) < 0,
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
  return { label, ...m, pass: gatesOk(m), eg: egOk(m) };
}

function dualSoft(y1Rows, holdRows, label, pred) {
  const y1 = softKeep(y1Rows, label, pred, Y1_FROM, Y1_TO);
  const hold = softKeep(holdRows, label, pred, HOLD_FROM, HOLD_TO);
  return {
    label,
    y1: { n: y1.n, tw: y1.tw, ret: y1.ret, pf: y1.pf, wr: y1.wr },
    hold: { n: hold.n, tw: hold.tw, ret: hold.ret, pf: hold.pf, wr: hold.wr },
    pass: gatesOk(y1) && gatesOk(hold),
    eg: egOk(y1) && egOk(hold),
    twOk: y1.tw >= 2 && hold.tw >= 2,
  };
}

console.log("=== PREPARED_MIT residual + freq restore ===\n");

const pad = 30 * 864e5;
const dataLo = Math.min(FULL_FROM, HOLD_FROM, Y1_FROM) - pad;
const dataHi = Math.max(FULL_TO, HOLD_TO, Y1_TO);

const bnbCandles = await readCandles("BNBUSDT", TF, dataLo, dataHi, { market: "futures" });
const bnbFunding = await readFundingRates("BNBUSDT", dataLo, dataHi).catch(() => []);
const bnbPre = precomputeIntraday(bnbCandles);

console.log("Harvest SLEEVE Y1+HOLD…");
const sleeveY1 = enrich(
  await runSim("BNBUSDT", bnbCandles, bnbFunding, SLEEVE, Y1_FROM, Y1_TO),
  bnbCandles,
  bnbPre,
);
const sleeveHold = enrich(
  await runSim("BNBUSDT", bnbCandles, bnbFunding, SLEEVE, HOLD_FROM, HOLD_TO),
  bnbCandles,
  bnbPre,
);
const sleeveY1M = metrics(
  sleeveY1.map((r) => ({ netPnl: r.pnl, entryTs: r.entryTs, exitTs: r.exitTs, exitReason: r.exitReason })),
  Y1_FROM,
  Y1_TO,
);
const sleeveHoldM = metrics(
  sleeveHold.map((r) => ({ netPnl: r.pnl, entryTs: r.entryTs, exitTs: r.exitTs, exitReason: r.exitReason })),
  HOLD_FROM,
  HOLD_TO,
);
console.log(`SLEEVE Y1  n=${sleeveY1M.n} tw=${sleeveY1M.tw} ret=${sleeveY1M.ret}% pf=${sleeveY1M.pf}`);
console.log(`SLEEVE HOLD n=${sleeveHoldM.n} tw=${sleeveHoldM.tw} ret=${sleeveHoldM.ret}% pf=${sleeveHoldM.pf}`);

const sleeveLosers = [...sleeveY1, ...sleeveHold].filter((r) => r.loser);
console.log(`\n--- SLEEVE losers pooled n=${sleeveLosers.length} ---`);
const sleeveClusters = {
  byExit: rateBy(sleeveLosers, (r) => r.exitReason, 3),
  bySideDay: rateBy(sleeveLosers, (r) => `${r.side}|${r.day}`, 3),
  bySession: rateBy(sleeveLosers, (r) => r.session, 3),
  byLevel: rateBy(sleeveLosers, (r) => r.level, 3),
  byHourBand: rateBy(sleeveLosers, (r) => (r.asia ? "asia" : r.kz ? "kz" : r.lateNy ? "lateNy" : "other"), 3),
  byChase: rateBy(sleeveLosers, (r) => (r.chase ? "chase" : "ok"), 3),
  byVol: rateBy(sleeveLosers, (r) => (r.vol >= 1.5 ? "vol15+" : r.vol >= 1.2 ? "vol12" : "volLo"), 3),
  byMicro: rateBy(sleeveLosers, (r) => (r.microMfeThenSl ? "microMfeSl" : "other"), 3),
  byBody: rateBy(sleeveLosers, (r) => (r.bodyEff >= 0.5 ? "bodyHi" : "bodyLo"), 3),
  bySpent: rateBy(sleeveLosers, (r) => (r.dailyUsed >= 0.7 ? "spent" : "room"), 3),
  byImpulse: rateBy(sleeveLosers, (r) => (r.impulse >= 1.8 ? "imp18+" : r.impulse >= 1.5 ? "imp15" : "imp12"), 3),
};
for (const [name, list] of Object.entries(sleeveClusters)) {
  const w = list[0];
  if (w) console.log(`${name.padEnd(12)} worst=${w.k} n=${w.n} pnl=${w.pnl} pf=${w.pf}`);
}

console.log("\n========== Path A soft abstain on SLEEVE ==========");
const pathARules = [
  ["H0", () => true],
  ["drop_chase", (r) => !r.chase],
  ["drop_asia", (r) => !r.asia],
  ["drop_lateNy", (r) => !r.lateNy],
  ["kz_only", (r) => r.kz],
  ["vol12", (r) => r.vol >= 1.2],
  ["vol15", (r) => r.vol >= 1.5],
  ["drop_spent", (r) => r.dailyUsed < 0.7],
  ["bodyHi", (r) => r.bodyEff >= 0.5],
  ["imp15", (r) => r.impulse >= 1.5],
  ["imp18", (r) => r.impulse >= 1.8],
  ["pdh_pdl", (r) => r.pdhPdl],
  ["fadeAlign", (r) => r.fadeAlign],
  ["drop_SELL_breakout", (r) => !(r.side === "SELL" && r.day === "breakout")],
  ["drop_BUY_breakdown", (r) => !(r.side === "BUY" && r.day === "breakdown")],
  ["drop_chase_spent", (r) => !r.chase && r.dailyUsed < 0.7],
  ["drop_asia_chase", (r) => !r.asia && !r.chase],
  ["vol12_drop_chase", (r) => r.vol >= 1.2 && !r.chase],
  ["kz_vol12", (r) => r.kz && r.vol >= 1.2],
  ["oracle_mfe05", (r) => r.survivor],
];
const pathA = pathARules.map(([label, pred]) => dualSoft(sleeveY1, sleeveHold, label, pred));
for (const s of pathA) {
  const mark = s.pass ? " ★PASS" : s.eg && s.twOk ? " ◆EG+TW" : s.eg ? " ◆EG" : "";
  console.log(
    `${s.label.padEnd(22)} Y1 tw=${s.y1.tw} ret=${String(s.y1.ret).padStart(7)} pf=${s.y1.pf} | HOLD tw=${s.hold.tw} ret=${String(s.hold.ret).padStart(7)} pf=${s.hold.pf}${mark}`,
  );
}

console.log("\nHarvest HI_FREQ (mit+minSl+h020, no toxic) Y1+HOLD…");
const hfY1 = enrich(
  await runSim("BNBUSDT", bnbCandles, bnbFunding, HI_FREQ, Y1_FROM, Y1_TO),
  bnbCandles,
  bnbPre,
);
const hfHold = enrich(
  await runSim("BNBUSDT", bnbCandles, bnbFunding, HI_FREQ, HOLD_FROM, HOLD_TO),
  bnbCandles,
  bnbPre,
);
const hfY1M = metrics(
  hfY1.map((r) => ({ netPnl: r.pnl, entryTs: r.entryTs, exitTs: r.exitTs, exitReason: r.exitReason })),
  Y1_FROM,
  Y1_TO,
);
const hfHoldM = metrics(
  hfHold.map((r) => ({ netPnl: r.pnl, entryTs: r.entryTs, exitTs: r.exitTs, exitReason: r.exitReason })),
  HOLD_FROM,
  HOLD_TO,
);
console.log(`HI_FREQ Y1  n=${hfY1M.n} tw=${hfY1M.tw} ret=${hfY1M.ret}% pf=${hfY1M.pf}`);
console.log(`HI_FREQ HOLD n=${hfHoldM.n} tw=${hfHoldM.tw} ret=${hfHoldM.ret}% pf=${hfHoldM.pf}`);

const hfHoldLosers = hfHold.filter((r) => r.loser);
console.log(`\n--- HI_FREQ HOLD losers n=${hfHoldLosers.length} ---`);
const hfClusters = {
  bySideDay: rateBy(hfHoldLosers, (r) => `${r.side}|${r.day}`, 4),
  byToxic: rateBy(hfHoldLosers, (r) => (r.toxic ? "toxic" : "ok"), 4),
  bySoftToxic: rateBy(hfHoldLosers, (r) => (r.softToxic ? "softToxic" : "ok"), 4),
  bySession: rateBy(hfHoldLosers, (r) => r.session, 4),
  byHourBand: rateBy(hfHoldLosers, (r) => (r.asia ? "asia" : r.kz ? "kz" : r.lateNy ? "lateNy" : "other"), 4),
  byChase: rateBy(hfHoldLosers, (r) => (r.chase ? "chase" : "ok"), 4),
  byVol: rateBy(hfHoldLosers, (r) => (r.vol >= 1.5 ? "vol15+" : r.vol >= 1.2 ? "vol12" : "volLo"), 4),
  byLevel: rateBy(hfHoldLosers, (r) => r.level, 4),
  bySpent: rateBy(hfHoldLosers, (r) => (r.dailyUsed >= 0.7 ? "spent" : "room"), 4),
  byFade: rateBy(hfHoldLosers, (r) => (r.fadeAlign ? "fade" : "notFade"), 4),
  byMicro: rateBy(hfHoldLosers, (r) => (r.microMfeThenSl ? "microMfeSl" : "other"), 4),
  bySideSession: rateBy(hfHoldLosers, (r) => `${r.side}|${r.session}`, 4),
};
for (const [name, list] of Object.entries(hfClusters)) {
  const w = list[0];
  if (w) console.log(`${name.padEnd(14)} worst=${w.k} n=${w.n} pnl=${w.pnl} pf=${w.pf}`);
}

console.log("\n========== Path B soft abstain on HI_FREQ (goal: tw≥2 + eg both) ==========");
const pathBRules = [
  ["H0", () => true],
  ["drop_toxic", (r) => !r.toxic],
  ["drop_softToxic", (r) => !r.softToxic],
  ["drop_chase", (r) => !r.chase],
  ["drop_asia", (r) => !r.asia],
  ["drop_lateNy", (r) => !r.lateNy],
  ["kz_only", (r) => r.kz],
  ["vol12", (r) => r.vol >= 1.2],
  ["vol15", (r) => r.vol >= 1.5],
  ["drop_spent", (r) => r.dailyUsed < 0.7],
  ["fadeAlign", (r) => r.fadeAlign],
  ["pdh_pdl", (r) => r.pdhPdl],
  ["bodyHi", (r) => r.bodyEff >= 0.5],
  ["imp15", (r) => r.impulse >= 1.5],
  ["drop_SELL_breakout", (r) => !(r.side === "SELL" && r.day === "breakout")],
  ["drop_BUY_breakdown", (r) => !(r.side === "BUY" && r.day === "breakdown")],
  // partial toxic: only SELL into breakout (keep BUY breakdown fades if green?)
  ["drop_SELL_bo_only", (r) => !(r.side === "SELL" && r.day === "breakout")],
  ["drop_BUY_bd_only", (r) => !(r.side === "BUY" && r.day === "breakdown")],
  ["toxic_or_chase", (r) => !r.toxic && !r.chase],
  ["toxic_or_spent", (r) => !r.toxic && r.dailyUsed < 0.7],
  ["toxic_or_asia", (r) => !r.toxic && !r.asia],
  ["toxic_vol12", (r) => !r.toxic && r.vol >= 1.2],
  ["softToxic_chase", (r) => !r.softToxic && !r.chase],
  ["softToxic_spent", (r) => !r.softToxic && r.dailyUsed < 0.7],
  ["softToxic_vol12", (r) => !r.softToxic && r.vol >= 1.2],
  ["chase_spent", (r) => !r.chase && r.dailyUsed < 0.7],
  ["asia_toxic", (r) => !r.asia && !r.toxic],
  ["lateNy_toxic", (r) => !r.lateNy && !r.toxic],
  ["kz_not_toxic", (r) => r.kz && !r.toxic],
  ["notFade_drop", (r) => r.fadeAlign],
  ["oracle_mfe05", (r) => r.survivor],
];
const pathB = pathBRules.map(([label, pred]) => dualSoft(hfY1, hfHold, label, pred));
pathB.sort((a, b) => (b.pass ? 1 : 0) - (a.pass ? 1 : 0) || (b.eg && b.twOk ? 1 : 0) - (a.eg && a.twOk ? 1 : 0) || b.hold.pf + b.y1.pf - (a.hold.pf + a.y1.pf));
for (const s of pathB) {
  const mark = s.pass ? " ★PASS" : s.eg && s.twOk ? " ◆EG+TW" : s.eg ? " ◆EG" : s.twOk ? " ·tw" : "";
  console.log(
    `${s.label.padEnd(22)} Y1 tw=${s.y1.tw} ret=${String(s.y1.ret).padStart(7)} pf=${s.y1.pf} | HOLD tw=${s.hold.tw} ret=${String(s.hold.ret).padStart(7)} pf=${s.hold.pf}${mark}`,
  );
}

const softHits = pathB.filter((s) => s.label !== "oracle_mfe05" && (s.pass || (s.eg && s.twOk)));
const softNear = pathB
  .filter((s) => s.label !== "oracle_mfe05" && s.twOk && s.y1.pf >= 0.95 && s.hold.pf >= 0.95)
  .slice(0, 10);

/** Map soft labels → hard overrides on top of HI_FREQ */
const HARD_MAP = {
  drop_toxic: { intradayLiqDaySituationBias: true },
  drop_chase: { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true },
  drop_asia: { intradayLiqSessionNarratives: "london_sweep,ny_continuation" },
  drop_lateNy: { intradayLiqActiveHourEnd: 16 },
  kz_only: { intradayLiqRequireKillzone: true },
  vol12: { intradayLiqSweepMinVolRatio: 1.2 },
  vol15: { intradayLiqSweepMinVolRatio: 1.5 },
  drop_spent: { intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 },
  fadeAlign: { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true },
  pdh_pdl: { intradayLiqSessionExtreme: false },
  bodyHi: { intradayLiqMinReclaimBodyRatio: 0.5 },
  imp15: { intradayLiqSweepDisplacementMinAtrMult: 1.5 },
  drop_SELL_breakout: { intradayLiqDaySituationBias: true }, // engine does both sides
  drop_BUY_breakdown: { intradayLiqDaySituationBias: true },
  drop_SELL_bo_only: { intradayLiqDaySituationBias: true },
  drop_BUY_bd_only: { intradayLiqDaySituationBias: true },
  toxic_or_chase: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  toxic_or_spent: {
    intradayLiqDaySituationBias: true,
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  },
  toxic_or_asia: {
    intradayLiqDaySituationBias: true,
    intradayLiqSessionNarratives: "london_sweep,ny_continuation",
  },
  toxic_vol12: { intradayLiqDaySituationBias: true, intradayLiqSweepMinVolRatio: 1.2 },
  softToxic_chase: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  softToxic_spent: {
    intradayLiqDaySituationBias: true,
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  },
  softToxic_vol12: { intradayLiqDaySituationBias: true, intradayLiqSweepMinVolRatio: 1.2 },
  chase_spent: {
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  },
  asia_toxic: {
    intradayLiqDaySituationBias: true,
    intradayLiqSessionNarratives: "london_sweep,ny_continuation",
  },
  lateNy_toxic: { intradayLiqDaySituationBias: true, intradayLiqActiveHourEnd: 16 },
  kz_not_toxic: { intradayLiqDaySituationBias: true, intradayLiqRequireKillzone: true },
  notFade_drop: { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true },
};

// Path A cushion → loosen: if soft abstain on sleeve improves PF a lot, try hard + freq loosen
const EXTRA = [
  ["HI_FREQ", {}],
  ["SLEEVE", { intradayLiqDaySituationBias: true, intradayLiqActiveHourStart: undefined, intradayLiqActiveHourEnd: undefined }],
  ["hf_toxic", { intradayLiqDaySituationBias: true }],
  ["hf_vol12", { intradayLiqSweepMinVolRatio: 1.2 }],
  ["hf_vol15", { intradayLiqSweepMinVolRatio: 1.5 }],
  ["hf_spent", { intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 }],
  ["hf_chase_htf", { intradayLiqRequireHtfAlign: true, intradayLiqHtfAlignPdhPdl: true }],
  ["hf_noAsia", { intradayLiqSessionNarratives: "london_sweep,ny_continuation" }],
  ["hf_h016", { intradayLiqActiveHourEnd: 16 }],
  ["hf_disp15", { intradayLiqSweepDisplacementMinAtrMult: 1.5 }],
  ["hf_toxic_vol12", { intradayLiqDaySituationBias: true, intradayLiqSweepMinVolRatio: 1.2 }],
  ["hf_toxic_spent", { intradayLiqDaySituationBias: true, intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 }],
  ["hf_chase_spent", {
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  }],
  ["hf_vol12_spent", { intradayLiqSweepMinVolRatio: 1.2, intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 }],
  ["hf_toxic_h016", { intradayLiqDaySituationBias: true, intradayLiqActiveHourEnd: 16 }],
  ["sleeve_vol12", { ...SLEEVE, intradayLiqSweepMinVolRatio: 1.2 }],
  ["sleeve_disp10", { ...SLEEVE, intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["sleeve_wait8", { ...SLEEVE, intradayLiqMitigationWaitBars: 8 }],
  ["sleeve_wait4", { ...SLEEVE, intradayLiqMitigationWaitBars: 4 }],
  ["sleeve_mit035", { ...SLEEVE, intradayLiqMitigationFrac: 0.35, intradayLiqMitigationWaitBars: 8 }],
  ["sleeve_noDailyCap", { ...SLEEVE, maxDailyLoss: 0, riskConsecutiveLossLimit: 0 }],
  ["sleeve_side3", { ...SLEEVE, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["sleeve_disp10_vol12", { ...SLEEVE, intradayLiqSweepDisplacementMinAtrMult: 1.0, intradayLiqSweepMinVolRatio: 1.2 }],
];

const targets = [...new Set([
  ...softHits.map((s) => s.label),
  ...softNear.map((s) => s.label),
  ...pathA.filter((s) => s.eg && s.label !== "oracle_mfe05" && s.label !== "H0").slice(0, 5).map((s) => s.label),
])];

const seen = new Set();
const variants = [];
for (const [id, patch] of EXTRA) {
  if (seen.has(id)) continue;
  seen.add(id);
  const base = id.startsWith("sleeve") ? { ...SLEEVE } : { ...HI_FREQ };
  // clear hour undef for sleeve
  const over = { ...base, ...patch };
  if (over.intradayLiqActiveHourStart === undefined) delete over.intradayLiqActiveHourStart;
  if (over.intradayLiqActiveHourEnd === undefined) delete over.intradayLiqActiveHourEnd;
  variants.push([id, over]);
}
for (const label of targets) {
  const patch = HARD_MAP[label];
  if (!patch) continue;
  const id = `soft_${label}`;
  if (seen.has(id)) continue;
  seen.add(id);
  variants.push([id, { ...HI_FREQ, ...patch }]);
}

console.log(`\n========== HARD Y1+HOLD (${variants.length} variants) ==========`);
const hard = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}…\n`);
  const y1t = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, Y1_FROM, Y1_TO);
  const ht = await runSim("BNBUSDT", bnbCandles, bnbFunding, over, HOLD_FROM, HOLD_TO);
  const y1 = metrics(y1t, Y1_FROM, Y1_TO);
  const hold = metrics(ht, HOLD_FROM, HOLD_TO);
  const pass = gatesOk(y1) && gatesOk(hold);
  const eg = egOk(y1) && egOk(hold);
  hard.push({ id, over, y1, hold, pass, eg });
  const mark = pass ? " ★PASS" : eg ? " ◆EG" : "";
  console.log(
    `${id.padEnd(28)} Y1 n=${String(y1.n).padStart(3)} tw=${y1.tw} ret=${String(y1.ret).padStart(7)} pf=${y1.pf} | HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)} pf=${hold.pf}${mark}`,
  );
}

let promote = hard.filter((h) => h.pass);
const egTw = hard.filter((h) => h.eg && h.y1.tw >= 2 && h.hold.tw >= 2);
const best = [...hard].sort(
  (a, b) =>
    (b.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    (b.eg && b.y1.tw >= 2 && b.hold.tw >= 2 ? 1 : 0) - (a.eg && a.y1.tw >= 2 && a.hold.tw >= 2 ? 1 : 0) ||
    (b.eg ? 1 : 0) - (a.eg ? 1 : 0) ||
    b.y1.tw + b.hold.tw - (a.y1.tw + a.hold.tw) ||
    b.y1.pf + b.hold.pf - (a.y1.pf + a.hold.pf),
)[0];

const fullRuns = [];
const topCandidates = [
  ...promote,
  ...egTw.filter((h) => !promote.includes(h)),
  ...hard.filter((h) => h.eg).sort((a, b) => b.y1.tw + b.hold.tw - (a.y1.tw + a.hold.tw)).slice(0, 2),
].slice(0, 3);

for (const c of topCandidates) {
  process.stderr.write(`FULL ${c.id}…\n`);
  const ft = await runSim("BNBUSDT", bnbCandles, bnbFunding, c.over, FULL_FROM, FULL_TO);
  const full = metrics(ft, FULL_FROM, FULL_TO);
  fullRuns.push({ id: c.id, full });
  console.log(`FULL ${c.id} n=${full.n} tw=${full.tw} ret=${full.ret}% pf=${full.pf}`);
}

const verdict = promote.length
  ? "PROMOTE_CANDIDATE"
  : egTw.length
    ? "EG_TW2_SOFT_OR_HARD"
    : best?.eg
      ? "EG_BELOW_TW2"
      : "REJECT";

const out = {
  generatedAt: new Date().toISOString(),
  sleeveBaseline: { y1: sleeveY1M, hold: sleeveHoldM },
  hiFreqBaseline: { y1: hfY1M, hold: hfHoldM },
  sleeveClusters,
  hfClusters,
  pathA,
  pathB,
  softHits: softHits.map((s) => s.label),
  hard,
  fullRuns,
  promote: promote.map((p) => p.id),
  egTw: egTw.map((p) => p.id),
  best: best ? { id: best.id, y1: best.y1, hold: best.hold, pass: best.pass, eg: best.eg } : null,
  verdict,
};

const outPath = path.join(__dirname, ".liq-bnb-prepared-mit-residual.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict} best=${best?.id} promote=${promote.map((p) => p.id).join(",") || "—"} wrote ${outPath}`);

await closePool?.();
