#!/usr/bin/env node
/**
 * BNB LIQ_CORE — 1-year deep trade autopsy (candles before/after + regime).
 *
 * For each trade: reconstruct path from OHLC around entry/exit, classify
 * failure mode (entry timing vs exit geometry vs fake breakout), cluster patterns,
 * soft-test relative abstains, then hard A/B the top one-change on Y1 and a prior year.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-core-1y-deep-autopsy.mjs
 *   FROM=2025-01-01 TO=2026-01-01 SKIP_ENSURE=1 node scripts/research-liq-bnb-core-1y-deep-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
/** Default: last 12 months of research window */
const FROM = process.env.FROM || "2025-07-01";
const TO = process.env.TO || "2026-07-01";
/** Prior year for holdout hard check after Y1 soft→hard */
const HOLD_FROM = process.env.HOLD_FROM || "2024-07-01";
const HOLD_TO = process.env.HOLD_TO || "2025-07-01";
const RISK = Number(process.env.RISK || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdFromMs = Date.parse(HOLD_FROM);
const holdToMs = Date.parse(HOLD_TO);
const PRE_BARS = 16; // 4h of 15m context before entry
const POST_BARS = 32; // 8h path after entry (or until exit)

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
  if (!(a > 0) && !(b > 0)) return NaN;
  if (!(a > 0)) return NaN;
  return (b - a) / a;
}

function barShape(bar) {
  if (!bar) return null;
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  const c = Number(bar.close);
  const range = Math.max(1e-12, h - l);
  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  return {
    bodyRatio: body / range,
    upperWickRatio: upper / range,
    lowerWickRatio: lower / range,
    bull: c >= o,
    rangePct: c > 0 ? range / c : 0,
  };
}

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  return "other_loss";
}

/**
 * Path taxonomy from OHLC after entry until exit (or POST_BARS).
 * Answers: entry bad vs exit left money / chased into trend.
 */
function analyzePath(candles, entryIdx, exitIdx, side, entryPx, slPx, tpPx) {
  const isBuy = side === "BUY";
  const end = Math.min(candles.length - 1, Math.max(entryIdx, exitIdx), entryIdx + POST_BARS);
  let mfePct = 0;
  let maePct = 0;
  let mfeBar = 0;
  let maeBar = 0;
  let firstGreenBar = null;
  let firstTouchSlBar = null;
  let touchedTp = false;
  let barsHeld = Math.max(0, end - entryIdx);

  for (let j = entryIdx; j <= end; j++) {
    const b = candles[j];
    const hi = Number(b.high);
    const lo = Number(b.low);
    const fav = isBuy ? (hi - entryPx) / entryPx : (entryPx - lo) / entryPx;
    const adv = isBuy ? (entryPx - lo) / entryPx : (hi - entryPx) / entryPx;
    if (fav > mfePct) {
      mfePct = fav;
      mfeBar = j - entryIdx;
    }
    if (adv > maePct) {
      maePct = adv;
      maeBar = j - entryIdx;
    }
    if (firstGreenBar == null && fav >= 0.001) firstGreenBar = j - entryIdx;
    const hitSl = isBuy ? lo <= slPx : hi >= slPx;
    if (hitSl && firstTouchSlBar == null) firstTouchSlBar = j - entryIdx;
    if (tpPx > 0) {
      const hitTp = isBuy ? hi >= tpPx : lo <= tpPx;
      if (hitTp) touchedTp = true;
    }
  }

  // Direction of auction into entry (prior PRE_BARS)
  const priorStart = Math.max(0, entryIdx - PRE_BARS);
  const priorRet = retN(candles, entryIdx, Math.min(PRE_BARS, entryIdx));
  const prior4 = retN(candles, entryIdx, Math.min(4, entryIdx));
  const prior64 = retN(candles, entryIdx, Math.min(64, entryIdx));

  let alignedTrendInto = false;
  if (Number.isFinite(priorRet)) {
    // Fading: BUY after dump into SSL, SELL after rally into BSL is "aligned"
    alignedTrendInto = (isBuy && priorRet < -0.003) || (!isBuy && priorRet > 0.003);
  }
  let chasingBreak = false;
  if (Number.isFinite(priorRet)) {
    // Buying after rally / selling after dump into level = chase
    chasingBreak = (isBuy && priorRet > 0.005) || (!isBuy && priorRet < -0.005);
  }

  let pathClass = "ok_path";
  if (mfePct <= 0.001 && (firstTouchSlBar != null && firstTouchSlBar <= 2)) {
    pathClass = "immediate_sl";
  } else if (mfePct <= 0.001) {
    pathClass = "never_green_slow";
  } else if (mfePct < 0.005 && maePct >= mfePct) {
    pathClass = "micro_mfe_then_sl";
  } else if (mfePct >= 0.005 && !touchedTp && maeBar < mfeBar) {
    pathClass = "gave_back_after_green"; // had progress then reversed — exit/hold issue candidate
  } else if (mfePct >= 0.008 && touchedTp === false && maePct > mfePct * 0.8) {
    pathClass = "mfe_not_captured"; // entry ok-ish, exit geometry
  } else if (chasingBreak && mfePct < 0.005) {
    pathClass = "chase_into_break";
  }

  // Pre window structure: consecutive closes same direction
  let preSameDir = 0;
  for (let j = entryIdx - 1; j >= priorStart; j--) {
    const c0 = Number(candles[j].close);
    const c1 = Number(candles[j + 1]?.close ?? c0);
    const up = c1 >= c0;
    if (isBuy ? !up : up) preSameDir += 1;
    else break;
  }

  return {
    mfePct: +mfePct.toFixed(5),
    maePct: +maePct.toFixed(5),
    mfeBar,
    maeBar,
    firstGreenBar,
    firstTouchSlBar,
    touchedTp,
    barsHeld,
    priorRet: Number.isFinite(priorRet) ? +priorRet.toFixed(5) : null,
    prior4: Number.isFinite(prior4) ? +prior4.toFixed(5) : null,
    prior64: Number.isFinite(prior64) ? +prior64.toFixed(5) : null,
    alignedTrendInto,
    chasingBreak,
    pathClass,
    preSameDir,
  };
}

function classifyIssue(row) {
  // Entry vs exit diagnosis
  if (row.pathClass === "immediate_sl" || row.pathClass === "never_green_slow" || row.pathClass === "chase_into_break") {
    return "entry";
  }
  if (row.pathClass === "gave_back_after_green" || row.pathClass === "mfe_not_captured") {
    return "exit";
  }
  if (row.fc === "winner") return "none";
  if (row.toxicFade) return "entry_regime";
  return "mixed";
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
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
  };
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

function softKeep(rows, label, pred, lo, hi) {
  const keep = rows.filter(pred);
  const trades = keep.map((r) => ({
    netPnl: r.pnl,
    entryTs: r.entryTs,
    exitTs: r.exitTs,
    exitReason: r.exitReason,
  }));
  const m = metrics(trades, lo, hi);
  return { label, keep: keep.length, ...m };
}

async function runSim(candles, funding, over, signalLo, signalHi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...(over || {}),
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
    backtestSignalStartMs: signalLo,
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
    (t) => Number(t.entryTs) >= signalLo && Number(t.entryTs) < signalHi,
  );
}

console.log(`\n=== BNB LIQ_CORE 1y deep autopsy === ${FROM}→${TO}`);
console.log(`Holdout check window: ${HOLD_FROM}→${HOLD_TO}\n`);

const padMs = 30 * 86_400_000;
const dataLo = Math.min(fromMs, holdFromMs) - padMs;
const dataHi = Math.max(toMs, holdToMs);
const candles = await readCandles(SYMBOL, TF, dataLo, dataHi, { market: "futures" });
const funding = await readFundingRates(SYMBOL, dataLo, dataHi).catch(() => []);
const pre = precomputeIntraday(candles);
console.log(`candles=${candles.length}`);

const y1Trades = await runSim(candles, funding, {}, fromMs, toMs);
console.log(`Y1 trades=${y1Trades.length}`);

const rows = [];
for (const t of y1Trades) {
  if (String(t.exitReason ?? "") === "tp1_partial") continue;
  const entryTs = Number(t.entryTs);
  const exitTs = Number(t.exitTs ?? t.entryTs);
  const entryIdx = findIdx(candles, entryTs);
  const exitIdx = findIdx(candles, exitTs);
  if (entryIdx < 0) continue;

  const side = String(t.side ?? t.direction ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const entryPx = Number(t.entryFill ?? t.entryPrice ?? candles[entryIdx].close);
  const slPx = Number(t.initialSlPrice ?? t.slPrice ?? 0);
  const tpPx = Number(t.tp2 ?? t.tpPrice ?? t.liqContext?.opposingLevel ?? 0);
  const feat = t.liqContext?.features ?? null;
  const ms = feat?.marketState ?? buildLiqMarketContext(candles, entryIdx, pre, {}) ?? {};
  const path = analyzePath(candles, entryIdx, exitIdx, side, entryPx, slPx, tpPx);
  const entryShape = barShape(candles[entryIdx]);
  const pre1 = barShape(candles[entryIdx - 1]);
  const post1 = barShape(candles[Math.min(candles.length - 1, entryIdx + 1)]);

  const daySituation = String(ms.daySituation ?? "range");
  const toxicFade =
    (daySituation === "breakout" && side === "SELL") ||
    (daySituation === "breakdown" && side === "BUY");
  const level = String(feat?.level?.type ?? t.liqContext?.levelType ?? "?");
  const session = String(feat?.sessionNarrative ?? ms.sessionNarrative ?? "?");
  const atrPct = Number(ms.atrPct ?? 0);
  const volSpike = Number(feat?.sweep?.sweepVolSpike ?? 0);
  const absorption = Number(feat?.sweep?.absorptionProxy ?? 0);
  const dailyUsed = Number(feat?.continuation?.dailyRangeUsedPct ?? 0);
  const impulseAtr = Number(feat?.displacement?.impulseAtr ?? 0);
  const holdBars = Math.max(0, exitIdx - entryIdx);
  const exitReason = String(t.exitReason ?? "?");
  const pnl = Number(t.netPnl ?? 0);
  const fc = failClass(t);

  const row = {
    entryTs,
    exitTs,
    side,
    pnl,
    fc,
    exitReason,
    level,
    session,
    daySituation,
    toxicFade,
    atrPct,
    volSpike,
    absorption,
    dailyUsed,
    impulseAtr,
    holdBars,
    entryBody: entryShape?.bodyRatio ?? null,
    pre1Body: pre1?.bodyRatio ?? null,
    post1Against:
      post1 == null
        ? null
        : side === "BUY"
          ? !post1.bull
          : post1.bull,
    ...path,
    issue: null,
  };
  row.issue = classifyIssue(row);
  rows.push(row);
}

const baseline = metrics(
  rows.map((r) => ({ netPnl: r.pnl, entryTs: r.entryTs, exitTs: r.exitTs, exitReason: r.exitReason })),
  fromMs,
  toMs,
);
console.log(
  `Baseline Y1: n=${baseline.n} tw=${baseline.tw} ret=${baseline.ret}% pf=${baseline.pf} wr=${baseline.wr}%`,
);

const clusters = {
  byFail: rateBy(rows, (r) => r.fc),
  byPath: rateBy(rows, (r) => r.pathClass),
  byIssue: rateBy(rows, (r) => r.issue),
  byPathDay: rateBy(rows, (r) => `${r.pathClass}|${r.daySituation}`),
  byIssueDay: rateBy(rows, (r) => `${r.issue}|${r.daySituation}`),
  byToxic: rateBy(rows, (r) => (r.toxicFade ? "toxic" : "ok")),
  byChase: rateBy(rows, (r) => (r.chasingBreak ? "chase" : "not_chase")),
  byAligned: rateBy(rows, (r) => (r.alignedTrendInto ? "aligned_into" : "not_aligned")),
  bySession: rateBy(rows, (r) => r.session),
  byLevel: rateBy(rows, (r) => r.level),
  byExit: rateBy(rows, (r) => r.exitReason),
  byPost1Against: rateBy(rows, (r) => (r.post1Against ? "post1_against" : "post1_with")),
  byImmediateSlSession: rateBy(
    rows.filter((r) => r.pathClass === "immediate_sl"),
    (r) => r.session,
    3,
  ),
};

console.log("\n--- byPath (worst avg first) ---");
for (const c of clusters.byPath.slice(0, 10)) {
  console.log(`${c.k.padEnd(28)} n=${String(c.n).padStart(3)} pnl=${String(c.pnl).padStart(8)} pf=${c.pf} wr=${c.wr}`);
}
console.log("\n--- byIssue ---");
for (const c of clusters.byIssue) {
  console.log(`${c.k.padEnd(16)} n=${String(c.n).padStart(3)} pnl=${String(c.pnl).padStart(8)} pf=${c.pf}`);
}
console.log("\n--- byPathDay (top loss) ---");
for (const c of clusters.byPathDay.slice(0, 12)) {
  console.log(`${c.k.padEnd(40)} n=${String(c.n).padStart(3)} pnl=${String(c.pnl).padStart(8)} pf=${c.pf}`);
}

const loss$ = rows.filter((r) => r.pnl < 0).reduce((s, r) => s + r.pnl, 0);
const entryLoss$ = rows.filter((r) => r.pnl < 0 && (r.issue === "entry" || r.issue === "entry_regime")).reduce((s, r) => s + r.pnl, 0);
const exitLoss$ = rows.filter((r) => r.pnl < 0 && r.issue === "exit").reduce((s, r) => s + r.pnl, 0);
const primary = {
  entryLossShare: loss$ < 0 ? +((entryLoss$ / loss$) * 100).toFixed(1) : null,
  exitLossShare: loss$ < 0 ? +((exitLoss$ / loss$) * 100).toFixed(1) : null,
  topPath: clusters.byPath[0]?.k ?? null,
  topPathDay: clusters.byPathDay[0]?.k ?? null,
  note:
    Math.abs(entryLoss$) >= Math.abs(exitLoss$)
      ? "Dominant $ loss is ENTRY (immediate/never-green/chase/toxic) — fix trigger/confirm, not trail"
      : "Dominant $ loss is EXIT (gave back / MFE not captured) — fix exit geometry",
};

console.log("\nprimary=", JSON.stringify(primary, null, 2));

// Soft abstains derived from patterns (causal at entry only — no post1_against as hard gate)
console.log("\n========== SOFT pattern abstains (Y1) ==========");
const softRules = [
  ["H0_all", () => true],
  ["drop_immediate_sl", (r) => r.pathClass !== "immediate_sl"], // oracle-ish path label
  ["drop_never_green_path", (r) => r.pathClass !== "never_green_slow" && r.pathClass !== "immediate_sl"],
  ["drop_toxic", (r) => !r.toxicFade],
  ["drop_chase", (r) => !r.chasingBreak],
  ["keep_aligned_into", (r) => r.alignedTrendInto],
  ["drop_toxic_or_chase", (r) => !r.toxicFade && !r.chasingBreak],
  ["drop_session_ext", (r) => r.level === "pdh" || r.level === "pdl"],
  ["asia_only", (r) => r.session === "asia_accum"],
  ["drop_high_dailyUsed", (r) => !(r.dailyUsed >= 0.7)],
  ["drop_weak_vol", (r) => r.volSpike >= 1.2],
  ["drop_weak_absorb", (r) => r.absorption >= 0.45],
  ["entry_body_ge_0.35", (r) => (r.entryBody ?? 0) >= 0.35],
  ["aligned_not_toxic", (r) => r.alignedTrendInto && !r.toxicFade],
  ["aligned_not_chase_not_toxic", (r) => r.alignedTrendInto && !r.chasingBreak && !r.toxicFade],
  // Exit-side soft (counterfactual keep winners that gave back — not causal)
  ["oracle_drop_entry_issues", (r) => r.issue !== "entry" && r.issue !== "entry_regime"],
  ["oracle_mfe05", (r) => r.mfePct >= 0.005],
];

const soft = [];
for (const [label, pred] of softRules) {
  const row = softKeep(rows, label, pred, fromMs, toMs);
  soft.push(row);
  const star = row.pf >= 1 && row.ret > 0 && row.tw >= 2 ? " ★" : "";
  console.log(
    `${label.padEnd(32)} n=${String(row.n).padStart(3)} tw=${row.tw} ret=${String(row.ret).padStart(7)}% pf=${row.pf} wr=${row.wr}${star}`,
  );
}

const softPass = soft.filter(
  (s) =>
    s.pf >= 1 &&
    s.ret > 0 &&
    s.tw >= 2 &&
    !s.label.startsWith("oracle") &&
    s.label !== "drop_immediate_sl" &&
    s.label !== "drop_never_green_path",
);

// Map soft labels → hard cfg overrides (causal only)
const HARD_MAP = {
  drop_toxic: { intradayLiqDaySituationBias: true },
  drop_chase: {
    // approximate: require premium/discount / or macro — use daySit + require prior dump via continuation? 
    // No direct chase gate — use HTF align as proxy for not chasing break
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  drop_toxic_or_chase: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  drop_session_ext: { intradayLiqSessionExtreme: false },
  asia_only: { intradayLiqSessionNarratives: "asia_accum" },
  drop_high_dailyUsed: {
    intradayLiqContinuationGate: true,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  },
  drop_weak_vol: { intradayLiqSweepMinVolRatio: 1.2 },
  drop_weak_absorb: {
    intradayLiqSweepQualityGate: true,
    intradayLiqMaxAbsorptionProxy: 0, // quality gate uses min scores; soft used absorb high
  },
  "entry_body_ge_0.35": { intradayLiqMinReclaimBodyRatio: 0.35 },
  aligned_not_toxic: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
  aligned_not_chase_not_toxic: {
    intradayLiqDaySituationBias: true,
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
    intradayLiqRequirePremiumDiscountAlign: true,
  },
  keep_aligned_into: {
    intradayLiqRequireHtfAlign: true,
    intradayLiqHtfAlignPdhPdl: true,
  },
};

// Prefer softPass; else best causal soft by PF with tw>=2 and ret better than baseline
const causalSoft = soft.filter(
  (s) => HARD_MAP[s.label] && s.tw >= 1.5 && s.n >= 30,
);
const hardTargets = softPass.length
  ? softPass
  : causalSoft.sort((a, b) => b.pf - a.pf || b.ret - a.ret).slice(0, 3);

console.log(`\nHard targets: ${hardTargets.map((h) => h.label).join(", ") || "(none)"}`);

const hardResults = [];
process.stderr.write("hard CORE Y1…\n");
const coreY1 = await runSim(candles, funding, {}, fromMs, toMs);
hardResults.push({ id: "CORE", window: "Y1", ...metrics(coreY1, fromMs, toMs) });

for (const tgt of hardTargets) {
  const over = HARD_MAP[tgt.label];
  if (!over) continue;
  process.stderr.write(`hard ${tgt.label} Y1…\n`);
  const trades = await runSim(candles, funding, over, fromMs, toMs);
  const m = metrics(trades, fromMs, toMs);
  const pass = m.pf >= 1 && m.ret > 0 && m.tw >= 2;
  hardResults.push({ id: tgt.label, window: "Y1", over, soft: tgt, ...m, pass });
  console.log(
    `HARD Y1 ${tgt.label.padEnd(28)} n=${m.n} tw=${m.tw} ret=${m.ret}% pf=${m.pf}${pass ? " ★" : ""}`,
  );
}

// Holdout for any Y1 hard that improves vs CORE
const coreHold = await runSim(candles, funding, {}, holdFromMs, holdToMs);
hardResults.push({ id: "CORE", window: "HOLD", ...metrics(coreHold, holdFromMs, holdToMs) });

for (const hr of hardResults.filter((h) => h.window === "Y1" && h.id !== "CORE")) {
  process.stderr.write(`hard ${hr.id} HOLD…\n`);
  const trades = await runSim(candles, funding, hr.over, holdFromMs, holdToMs);
  const m = metrics(trades, holdFromMs, holdToMs);
  const y1 = hardResults.find((x) => x.window === "Y1" && x.id === hr.id);
  const pass = (y1?.pass === true) && m.ret > 0 && m.pf >= 1 && m.tw >= 2;
  hardResults.push({ id: hr.id, window: "HOLD", over: hr.over, ...m, pass });
  console.log(
    `HARD HOLD ${hr.id.padEnd(26)} n=${m.n} tw=${m.tw} ret=${m.ret}% pf=${m.pf}${pass ? " ★" : ""}`,
  );
}

const promote = hardResults.filter((h) => h.window === "HOLD" && h.pass);
const verdict = promote.length
  ? "PROMOTE_CANDIDATE"
  : hardResults.some((h) => h.window === "Y1" && h.pass)
    ? "Y1_ONLY_HOLD_FAIL"
    : "REJECT";

// Sample worst trades for human audit (compact)
const worst = [...rows]
  .filter((r) => r.pnl < 0)
  .sort((a, b) => a.pnl - b.pnl)
  .slice(0, 25)
  .map((r) => ({
    ts: new Date(r.entryTs).toISOString(),
    side: r.side,
    pnl: r.pnl,
    fc: r.fc,
    path: r.pathClass,
    issue: r.issue,
    day: r.daySituation,
    session: r.session,
    level: r.level,
    exit: r.exitReason,
    priorRet: r.priorRet,
    mfe: r.mfePct,
    mae: r.maePct,
    toxic: r.toxicFade,
    chase: r.chasingBreak,
  }));

const out = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  y1: { from: FROM, to: TO },
  hold: { from: HOLD_FROM, to: HOLD_TO },
  baseline,
  primary,
  clusters: {
    byFail: clusters.byFail,
    byPath: clusters.byPath,
    byIssue: clusters.byIssue,
    byPathDay: clusters.byPathDay.slice(0, 20),
    byToxic: clusters.byToxic,
    byChase: clusters.byChase,
    byAligned: clusters.byAligned,
    bySession: clusters.bySession,
    byLevel: clusters.byLevel,
    byExit: clusters.byExit,
  },
  soft,
  softPass: softPass.map((s) => s.label),
  hardResults,
  verdict,
  worstTrades: worst,
  nRows: rows.length,
};

const outPath = path.join(__dirname, ".liq-bnb-core-1y-deep-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict}`);
console.log(`wrote ${outPath}`);
await closePool?.();
