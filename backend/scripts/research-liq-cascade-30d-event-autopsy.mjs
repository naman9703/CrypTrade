#!/usr/bin/env node
/**
 * LIQ_CASCADE — 30d liquidation event autopsy: all S/M/L events, gates, fade P&L sim.
 *
 * Usage (backend/):
 *   DAYS=30 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-30d-event-autopsy.mjs
 *   OUT=scripts/.liq-cascade-30d-events.csv node scripts/research-liq-cascade-30d-event-autopsy.mjs
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const DAYS = Number(process.env.DAYS || 30);
const TF = process.env.TF || "1m";
const LIQ_SOURCE = process.env.LIQ_SOURCE || "force_orders";
const ROUND_TRIP_COST_PCT = Number(process.env.ROUND_TRIP_COST_PCT || 0.13);
const MIN_EVENT_USD = Number(process.env.MIN_EVENT_USD || 5_000);

const PRESETS = {
  BTCUSDT: (await import("../src/strategy/presets/liqCascadeOptimized.js")).LIQ_CASCADE_BTC_1M,
  ETHUSDT: (await import("../src/strategy/presets/liqCascadeOptimized.js")).LIQ_CASCADE_ETH_1M,
  BNBUSDT: (await import("../src/strategy/presets/liqCascadeOptimized.js")).LIQ_CASCADE_BNB_1M,
};

const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 60 * 60 * 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { hydrateLiqCascadeCfg, liqCascadePadFromMs, optsFromLiqCascadeCfg } = await import(
  "../src/strategy/liqCascadeIntraday.js",
);
const indicatorsMod = await import("../src/strategy/indicators.js");
const atrFn = indicatorsMod.atr;
const {
  buildLiqCascadeSeries,
  computeInBarDisplacement,
  prepareLiqBars,
  prepareOiBars,
  resolveOiGate,
  liqIntervalToMs,
  lookupAtOrBefore,
} = await import("../src/strategy/techniques/liqCascade.js");
const { computeLiqCascadeDataQuality } = await import("../src/strategy/liqCascadeDataQuality.js");
const { readRecentForceOrders } = await import("../src/intelligence/collectors/forceOrderPersist.js");

function candleIdxAtOrBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function candleIdxAtOrAfter(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) >= ts) {
      best = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return best;
}

function sizeTier(symbol, totalUsd) {
  const bnb = symbol === "BNBUSDT";
  const smallHi = bnb ? 30_000 : 50_000;
  const medHi = bnb ? 200_000 : 500_000;
  if (totalUsd < MIN_EVENT_USD) return "below_floor";
  if (totalUsd < smallHi) return "small";
  if (totalUsd < medHi) return "medium";
  return "large";
}

function fadeRetPct(dom, rawRetPct) {
  if (rawRetPct == null || !Number.isFinite(rawRetPct)) return null;
  if (dom === "longs") return rawRetPct;
  if (dom === "shorts") return -rawRetPct;
  return null;
}

function forwardRet(candles, idx, horizon) {
  const j = idx + horizon;
  if (idx == null || j >= candles.length) return null;
  const c0 = Number(candles[idx].close);
  const c1 = Number(candles[j].close);
  if (!(c0 > 0)) return null;
  return ((c1 - c0) / c0) * 100;
}

/** Walk 1m candles: bracket TP/SL hit first (conservative intrabar: SL checked before TP). */
function simulateBracketOutcome(candles, entryIdx, action, brackets, maxHold = 24) {
  if (!brackets || entryIdx == null) return { outcome: "no_brackets", pnlPct: null };
  const entry = Number(brackets.entryPrice ?? candles[entryIdx]?.close);
  if (!(entry > 0)) return { outcome: "no_entry", pnlPct: null };
  const slPct = Number(brackets.slPct);
  const tpPct = Number(brackets.tpPct);
  if (!(slPct > 0) || !(tpPct > 0)) return { outcome: "bad_brackets", pnlPct: null };

  const slPx = action === "BUY" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tpPx = action === "BUY" ? entry * (1 + tpPct) : entry * (1 - tpPct);

  for (let j = entryIdx + 1; j < Math.min(candles.length, entryIdx + 1 + maxHold); j++) {
    const hi = Number(candles[j].high);
    const lo = Number(candles[j].low);
    if (action === "BUY") {
      if (lo <= slPx) return { outcome: "sl", pnlPct: -slPct * 100 - ROUND_TRIP_COST_PCT };
      if (hi >= tpPx) return { outcome: "tp", pnlPct: tpPct * 100 - ROUND_TRIP_COST_PCT };
    } else {
      if (hi >= slPx) return { outcome: "sl", pnlPct: -slPct * 100 - ROUND_TRIP_COST_PCT };
      if (lo <= tpPx) return { outcome: "tp", pnlPct: tpPct * 100 - ROUND_TRIP_COST_PCT };
    }
  }
  const last = candles[Math.min(candles.length - 1, entryIdx + maxHold)];
  const exit = Number(last.close);
  const raw = action === "BUY" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
  return { outcome: "timeout", pnlPct: raw - ROUND_TRIP_COST_PCT };
}

async function analyzeSymbol(symbol) {
  const preset = { ...PRESETS[symbol], liqCascadeLiqSource: LIQ_SOURCE };
  const padFrom = liqCascadePadFromMs(fromMs, TF);
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(symbol, TF, { from: padFrom, to: toMs, market: "futures" });
  }
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateLiqCascadeCfg(preset, symbol, padFrom, toMs);
  const opts = optsFromLiqCascadeCfg(cfg);
  const liqSeries = cfg._liqCascadeLiqSeries ?? [];
  const oiSeries = cfg._liqCascadeOiSeries ?? [];
  const intervalMs = liqIntervalToMs(opts.liqInterval);
  const ticks = await readRecentForceOrders(symbol, fromMs, toMs);
  const dataQuality = computeLiqCascadeDataQuality({ ticks, liqSeries, fromMs, toMs, intervalMs });

  const liqBars = prepareLiqBars(liqSeries, {
    intervalMs,
    lookbackBars: opts.liqLookbackBars,
  });
  const oiBars = prepareOiBars(oiSeries, intervalMs);
  const { series } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, opts });
  const atr = atrFn(candles, 14);
  const closes = candles.map((c) => Number(c.close));

  const signalsByLiqBar = new Map();
  for (let i = 0; i < series.length; i++) {
    const sig = series[i];
    if (!sig) continue;
    const ts = Number(candles[i].ts);
    const lb = lookupAtOrBefore(ts, liqBars);
    if (lb) signalsByLiqBar.set(lb.ts, { idx: i, sig });
  }

  const events = [];
  for (const bar of liqBars) {
    if (bar.ts < fromMs || bar.ts > toMs) continue;
    if (bar.totalUsd < MIN_EVENT_USD) continue;

    const idx = candleIdxAtOrBefore(candles, bar.ts);
    const entryIdx = candleIdxAtOrAfter(candles, bar.ts);
    const ts = idx != null ? Number(candles[idx].ts) : null;
    const oiGate = ts != null ? resolveOiGate(oiBars, ts, opts) : { dropPct: null, ok: false, mode: opts.oiGateMode };
    const { disp, barCloseIdx } = computeInBarDisplacement(candles, atr, bar);
    const dispIdx = barCloseIdx ?? idx;
    const atrVal = dispIdx != null ? atr[dispIdx] : null;
    const close = dispIdx != null ? closes[dispIdx] : null;
    const atrPct = close > 0 && atrVal > 0 ? (atrVal / close) * 100 : null;

    const zPass = bar.z != null && bar.z >= opts.liqZScoreMin;
    const liqPass = bar.totalUsd >= opts.minLiqUsdBar;
    const domPass = bar.dom === "longs" || bar.dom === "shorts";
    const oiPass = oiGate.ok;
    const dispPass = disp != null && disp >= opts.minDispAtrMult;
    const atrPass = atrPct != null && atrPct >= opts.minAtrPct;
    const cascadeEligible = !!(zPass && liqPass && domPass && oiPass && dispPass && atrPass);
    const strongDisp = Number(opts.strongDispAtrMult ?? 2.0);
    const confirmTier =
      disp != null && disp >= strongDisp ? "A" : dispPass ? "B" : null;

    const stratHit = signalsByLiqBar.get(bar.ts);
    const signalFired = !!stratHit;
    const fadeAction =
      bar.dom === "longs" ? "BUY" : bar.dom === "shorts" ? "SELL" : null;

    const ret5 = forwardRet(candles, entryIdx, 5);
    const ret15 = forwardRet(candles, entryIdx, 15);
    const ret60 = forwardRet(candles, entryIdx, 60);
    const fade5 = fadeRetPct(bar.dom, ret5);
    const fade15 = fadeRetPct(bar.dom, ret15);
    const fade60 = fadeRetPct(bar.dom, ret60);
    const netFade15 = fade15 != null ? fade15 - ROUND_TRIP_COST_PCT : null;
    const netFade60 = fade60 != null ? fade60 - ROUND_TRIP_COST_PCT : null;

    let bracketSim = { outcome: "no_signal", pnlPct: null };
    if (stratHit) {
      bracketSim = simulateBracketOutcome(
        candles,
        stratHit.idx,
        stratHit.sig.action,
        stratHit.sig.liqBrackets,
        opts.maxHoldBars,
      );
    } else if (cascadeEligible && entryIdx != null && fadeAction) {
      bracketSim = { outcome: "eligible_no_confirm", pnlPct: null };
    }

    const profitFade15 = netFade15 != null && netFade15 > 0 ? "WIN" : netFade15 != null ? "LOSS" : "NA";
    const profitFade60 = netFade60 != null && netFade60 > 0 ? "WIN" : netFade60 != null ? "LOSS" : "NA";
    const profitBracket =
      bracketSim.pnlPct != null
        ? bracketSim.pnlPct > 0
          ? "WIN"
          : "LOSS"
        : signalFired
          ? "NA"
          : cascadeEligible
            ? "NO_ENTRY"
            : "NO_TRADE";

    events.push({
      symbol,
      barCloseUtc: new Date(bar.ts).toISOString(),
      barCloseIst: new Date(bar.ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      sizeTier: sizeTier(symbol, bar.totalUsd),
      liqUsd: Math.round(bar.totalUsd),
      liqLongUsd: Math.round(bar.longUsd),
      liqShortUsd: Math.round(bar.shortUsd),
      domSide: bar.dom,
      zScore: bar.z != null ? +Number(bar.z).toFixed(2) : null,
      zThreshold: opts.liqZScoreMin,
      zPass,
      liqMinUsd: opts.minLiqUsdBar,
      liqPass,
      oiDropPct: oiGate.dropPct != null ? +Number(oiGate.dropPct).toFixed(3) : null,
      oiGateMode: oiGate.mode,
      oiMinPct: opts.minOiDropPct,
      oiPass,
      dispAtr: disp != null ? +Number(disp).toFixed(2) : null,
      dispMin: opts.minDispAtrMult,
      dispPass,
      atrPct: atrPct != null ? +Number(atrPct).toFixed(3) : null,
      atrMin: opts.minAtrPct,
      atrPass,
      decayFromPeak: bar.decayFromPeak != null ? +Number(bar.decayFromPeak).toFixed(2) : null,
      confirmTier: stratHit?.sig?.confirmTier ?? confirmTier,
      cascadeEligible,
      signalFired,
      fadeAction,
      fadeRet5mPct: fade5 != null ? +fade5.toFixed(3) : null,
      fadeRet15mPct: fade15 != null ? +fade15.toFixed(3) : null,
      fadeRet60mPct: fade60 != null ? +fade60.toFixed(3) : null,
      netFade15mPct: netFade15 != null ? +netFade15.toFixed(3) : null,
      netFade60mPct: netFade60 != null ? +netFade60.toFixed(3) : null,
      profitFade15m: profitFade15,
      profitFade60m: profitFade60,
      bracketOutcome: bracketSim.outcome,
      bracketPnlPct: bracketSim.pnlPct != null ? +bracketSim.pnlPct.toFixed(3) : null,
      profitStrategy: profitBracket,
    });
  }

  return { symbol, dataQuality, events };
}

function summarizeTier(events, tier) {
  const rows = events.filter((e) => e.sizeTier === tier);
  const wins15 = rows.filter((e) => e.profitFade15m === "WIN").length;
  const wins60 = rows.filter((e) => e.profitFade60m === "WIN").length;
  const stratWins = rows.filter((e) => e.profitStrategy === "WIN").length;
  const stratTrades = rows.filter((e) => e.profitStrategy === "WIN" || e.profitStrategy === "LOSS").length;
  const meanNet60 =
    rows.filter((e) => e.netFade60mPct != null).reduce((s, e) => s + e.netFade60mPct, 0) /
      (rows.filter((e) => e.netFade60mPct != null).length || 1);
  return {
    tier,
    count: rows.length,
    cascadeEligible: rows.filter((e) => e.cascadeEligible).length,
    signalsFired: rows.filter((e) => e.signalFired).length,
    fade15WinRate: rows.length ? +((wins15 / rows.length) * 100).toFixed(1) : null,
    fade60WinRate: rows.length ? +((wins60 / rows.length) * 100).toFixed(1) : null,
    meanNetFade60mPct: rows.length ? +meanNet60.toFixed(3) : null,
    strategyWinRate: stratTrades ? +((stratWins / stratTrades) * 100).toFixed(1) : null,
    strategyTrades: stratTrades,
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

const allEvents = [];
const bySymbol = [];
for (const sym of Object.keys(PRESETS)) {
  const r = await analyzeSymbol(sym);
  bySymbol.push(r);
  allEvents.push(...r.events);
}

allEvents.sort((a, b) => a.barCloseUtc.localeCompare(b.barCloseUtc));

const tierSummary = {};
for (const sym of Object.keys(PRESETS)) {
  const ev = allEvents.filter((e) => e.symbol === sym);
  tierSummary[sym] = ["small", "medium", "large"].map((t) => summarizeTier(ev, t));
}

const report = {
  generatedAt: new Date().toISOString(),
  window: { days: DAYS, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  roundTripCostPct: ROUND_TRIP_COST_PCT,
  minEventUsd: MIN_EVENT_USD,
  dataQuality: bySymbol.map((s) => ({ symbol: s.symbol, ...s.dataQuality })),
  dataQualityNote:
    "Requested 30d window; profit sim only valid on bars within effective tick coverage (see dataQuality).",
  totals: {
    events: allEvents.length,
    small: allEvents.filter((e) => e.sizeTier === "small").length,
    medium: allEvents.filter((e) => e.sizeTier === "medium").length,
    large: allEvents.filter((e) => e.sizeTier === "large").length,
    cascadeEligible: allEvents.filter((e) => e.cascadeEligible).length,
    signalsFired: allEvents.filter((e) => e.signalFired).length,
    fade60Wins: allEvents.filter((e) => e.profitFade60m === "WIN").length,
    fade60Losses: allEvents.filter((e) => e.profitFade60m === "LOSS").length,
  },
  tierSummary,
  events: allEvents,
};

const outJson = path.join(__dirname, ".liq-cascade-30d-event-autopsy.json");
const outCsv = process.env.OUT || path.join(__dirname, ".liq-cascade-30d-events.csv");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
fs.writeFileSync(outCsv, toCsv(allEvents));

console.log(JSON.stringify({ outJson, outCsv, totals: report.totals, tierSummary, dataQuality: report.dataQuality }, null, 2));

await closePool?.().catch(() => {});
