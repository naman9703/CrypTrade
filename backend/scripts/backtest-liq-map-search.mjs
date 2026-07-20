#!/usr/bin/env node
/**
 * Rolling liquidity-map strategy search.
 *
 * This is a fast research harness, not a production adapter. It tests whether
 * intraday swing/equal-high/equal-low liquidity sweeps can become positive after
 * realistic fee/slippage cost assumptions.
 *
 * Usage:
 *   SYMBOLS=BNBUSDT FROM=2026-01-01 TO=2026-06-01 node scripts/backtest-liq-map-search.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || process.env.SYMBOL || "BNBUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 2.5) / 100;
const COST_R = Number(process.env.COST_R || 0.12);
const TOP = Math.max(5, Number(process.env.TOP || 12));
const LABEL_W = Math.max(42, Number(process.env.LABEL_W || 42));

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { detectRollingLiquiditySweeps, liquidityMapDayId } = await import(
  "../src/strategy/techniques/liquidityMap.js"
);
const { atrPercentileAt } = await import("../src/strategy/techniques/smcRegime.js");
const { inSmcKillzone } = await import("../src/strategy/techniques/sessionKillzones.js");

function trendOk(side, pre, idx, mode) {
  if (mode === "none") return true;
  if (mode === "with") return side === "BUY" ? pre.htfUp?.[idx] === true : pre.htfDown?.[idx] === true;
  if (mode === "against") return side === "BUY" ? pre.htfDown?.[idx] === true : pre.htfUp?.[idx] === true;
  return true;
}

function regimeOk(candles, pre, idx, opts = {}) {
  const adx = Number(pre.adxSeries?.[idx]);
  const minAdx = Number(opts.minAdx ?? 0);
  const maxAdx = Number(opts.maxAdx ?? 0);
  if (minAdx > 0 && (!Number.isFinite(adx) || adx < minAdx)) return false;
  if (maxAdx > 0 && Number.isFinite(adx) && adx > maxAdx) return false;
  const atr = Number(pre.atrSeries?.[idx]);
  const close = Number(candles[idx]?.close);
  const atrPct = close > 0 && atr > 0 ? atr / close : 0;
  const minAtrPct = Number(opts.minAtrPct ?? 0);
  const maxAtrPct = Number(opts.maxAtrPct ?? 0);
  if (minAtrPct > 0 && atrPct < minAtrPct) return false;
  if (maxAtrPct > 0 && atrPct > maxAtrPct) return false;
  const atrPctile = pre._liqMapAtrPctile?.[idx] ?? atrPercentileAt(candles, pre, idx, Number(opts.atrPctileLookback ?? 2880));
  const minAtrPctile = Number(opts.minAtrPctile ?? 0);
  const maxAtrPctile = Number(opts.maxAtrPctile ?? 0);
  if (atrPctile != null && minAtrPctile > 0 && atrPctile < minAtrPctile) return false;
  if (atrPctile != null && maxAtrPctile > 0 && atrPctile > maxAtrPctile) return false;
  if (opts.killzone && !inSmcKillzone(candles[idx]?.ts, { intradaySmcKillzoneMode: opts.killzone })) return false;
  return true;
}

function attachAtrPercentileSeries(candles, pre, lookback = 2880) {
  if (pre._liqMapAtrPctile?.length === candles.length) return pre;
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    out[i] = atrPercentileAt(candles, pre, i, lookback);
  }
  pre._liqMapAtrPctile = out;
  return pre;
}

function rsiOk(side, pre, idx, opts = {}) {
  const rsi = Number(pre.rsiSeries?.[idx]);
  if (!Number.isFinite(rsi)) return true;
  if (side === "BUY") {
    const max = Number(opts.buyRsiMax ?? 0);
    if (max > 0 && rsi > max) return false;
  } else {
    const min = Number(opts.sellRsiMin ?? 0);
    if (min > 0 && rsi < min) return false;
  }
  return true;
}

function simulate(candles, pre, opts) {
  let equity = START;
  let peak = START;
  let maxDd = 0;
  let openUntil = -1;
  const trades = [];
  const used = new Set();
  const maxHold = Math.max(1, Number(opts.maxHoldBars ?? 48));
  const rr = Number(opts.rr ?? 1);
  const slBuf = Number(opts.slBufferPct ?? 0.0015);
  const onePerDay = opts.onePerDay !== false;

  for (let i = 120; i < candles.length - maxHold - 1; i++) {
    const bar = candles[i];
    if (bar.ts < fromMs || bar.ts >= toMs) continue;
    if (i <= openUntil && opts.allowOverlap !== true) continue;
    if (!regimeOk(candles, pre, i, opts)) continue;

    const events = detectRollingLiquiditySweeps(candles, i, opts).filter((e) =>
      trendOk(e.side, pre, i, opts.htfMode || "none") && rsiOk(e.side, pre, i, opts),
    );
    if (!events.length) continue;
    const e = events[0];
    const dayKey = `${liquidityMapDayId(bar.ts)}:${opts.onePerSidePerDay === true ? e.side : "ANY"}`;
    if (onePerDay && used.has(dayKey)) continue;
    used.add(dayKey);

    const entry = Number(e.entry);
    const sl = e.side === "BUY" ? e.wickPrice * (1 - slBuf) : e.wickPrice * (1 + slBuf);
    const riskPx = Math.abs(entry - sl);
    if (!(entry > 0) || !(riskPx > 0)) continue;
    const maxSlPct = Number(opts.maxSlPct ?? 0.03);
    if (maxSlPct > 0 && riskPx / entry > maxSlPct) continue;
    const tp = e.side === "BUY" ? entry + rr * riskPx : entry - rr * riskPx;

    let outR = 0;
    let exitIdx = i + maxHold;
    let reason = "time";
    for (let j = i + 1; j <= i + maxHold; j++) {
      const b = candles[j];
      if (e.side === "BUY") {
        const hitSl = b.low <= sl;
        const hitTp = b.high >= tp;
        if (hitSl && hitTp) {
          outR = opts.sameBarPriority === "tp" ? rr : -1;
          reason = opts.sameBarPriority === "tp" ? "tp" : "sl";
          exitIdx = j;
          break;
        }
        if (hitSl) {
          outR = -1;
          reason = "sl";
          exitIdx = j;
          break;
        }
        if (hitTp) {
          outR = rr;
          reason = "tp";
          exitIdx = j;
          break;
        }
      } else {
        const hitSl = b.high >= sl;
        const hitTp = b.low <= tp;
        if (hitSl && hitTp) {
          outR = opts.sameBarPriority === "tp" ? rr : -1;
          reason = opts.sameBarPriority === "tp" ? "tp" : "sl";
          exitIdx = j;
          break;
        }
        if (hitSl) {
          outR = -1;
          reason = "sl";
          exitIdx = j;
          break;
        }
        if (hitTp) {
          outR = rr;
          reason = "tp";
          exitIdx = j;
          break;
        }
      }
    }
    if (reason === "time") {
      const last = candles[exitIdx];
      const raw = e.side === "BUY" ? (last.close - entry) / riskPx : (entry - last.close) / riskPx;
      outR = Math.max(-1, Math.min(rr, raw));
    }
    const netR = outR - COST_R;
    equity *= 1 + netR * RISK;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    openUntil = exitIdx;
    trades.push({ netR, reason, side: e.side, poolType: e.poolType, score: e.score });
  }

  const wins = trades.filter((t) => t.netR > 0).length;
  const grossWin = trades.filter((t) => t.netR > 0).reduce((a, t) => a + t.netR, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.netR < 0).reduce((a, t) => a + t.netR, 0));
  const exits = trades.reduce((m, t) => {
    m[t.reason] = (m[t.reason] || 0) + 1;
    return m;
  }, {});
  return {
    trades: trades.length,
    perDay: trades.length / days,
    returnPct: ((equity / START) - 1) * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    avgR: trades.length ? trades.reduce((a, t) => a + t.netR, 0) / trades.length : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDdPct: maxDd * 100,
    exits,
  };
}

function variants() {
  if (process.env.ROBUST === "1") {
    const out = [];
    for (const lookback of [48, 72])
      for (const minTouches of [1, 2])
        for (const rr of [0.8, 1])
          for (const minWick of [0.35, 0.45])
            for (const minRvol of [1.1])
              for (const htfMode of ["with", "against"])
                for (const kz of ["LONDON_NY", "NY"])
                  for (const atrBand of [
                    { minAtrPctile: 20, maxAtrPctile: 85, tag: "atr20_85" },
                    { minAtrPctile: 35, maxAtrPctile: 85, tag: "atr35_85" },
                  ])
                    for (const adx of [
                      { minAdx: 16, maxAdx: 0, tag: "adx16" },
                      { minAdx: 18, maxAdx: 32, tag: "adx18_32" },
                    ]) {
                      out.push({
                        label: `rb_lb${lookback}_t${minTouches}_rr${rr}_w${minWick}_rv${minRvol}_${htfMode}_${kz}_${atrBand.tag}_${adx.tag}`,
                        liqMapLookbackBars: lookback,
                        liqMapMaxAgeBars: lookback,
                        liqMapMinTouches: minTouches,
                        liqMapMinWickRatio: minWick,
                        liqMapMinRvol: minRvol,
                        liqMapMinBodyRatio: 0,
                        liqMapSweepPct: 0.0006,
                        liqMapEqualTolPct: 0.0008,
                        liqMapRequireUnresolved: true,
                        liqMapRequireDirectionalClose: false,
                        rr,
                        htfMode,
                        killzone: kz,
                        ...atrBand,
                        ...adx,
                        atrPctileLookback: 2880,
                        minAtrPct: 0.0015,
                        maxAtrPct: 0.04,
                        maxHoldBars: 36,
                        maxSlPct: 0.035,
                        onePerDay: true,
                      });
                    }
    return out;
  }
  if (process.env.SELECTED === "1") {
    return [
      {
        label: "robust_btc_london_trend",
        liqMapLookbackBars: 48,
        liqMapMaxAgeBars: 48,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.35,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1,
        htfMode: "with",
        killzone: "LONDON_NY",
        minAtrPctile: 35,
        maxAtrPctile: 85,
        minAdx: 18,
        maxAdx: 32,
        atrPctileLookback: 2880,
        minAtrPct: 0.0015,
        maxAtrPct: 0.04,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "robust_eth_ny_trend",
        liqMapLookbackBars: 48,
        liqMapMaxAgeBars: 48,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.45,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1,
        htfMode: "with",
        killzone: "NY",
        minAtrPctile: 20,
        maxAtrPctile: 85,
        minAdx: 18,
        maxAdx: 32,
        atrPctileLookback: 2880,
        minAtrPct: 0.0015,
        maxAtrPct: 0.04,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "robust_bnb_ny_countertrend",
        liqMapLookbackBars: 72,
        liqMapMaxAgeBars: 72,
        liqMapMinTouches: 2,
        liqMapMinWickRatio: 0.45,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1,
        htfMode: "against",
        killzone: "NY",
        minAtrPctile: 20,
        maxAtrPctile: 85,
        minAdx: 18,
        maxAdx: 32,
        atrPctileLookback: 2880,
        minAtrPct: 0.0015,
        maxAtrPct: 0.04,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "btc_best_trend_lb72_rr0.8",
        liqMapLookbackBars: 72,
        liqMapMaxAgeBars: 72,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.25,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 0.8,
        htfMode: "with",
        minAdx: 0,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "eth_best_eq_trend_lb48_rr0.8",
        liqMapLookbackBars: 48,
        liqMapMaxAgeBars: 48,
        liqMapMinTouches: 2,
        liqMapMinWickRatio: 0.45,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 0.8,
        htfMode: "none",
        minAdx: 18,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "bn_t1_freq_lb48_rr1.25",
        liqMapLookbackBars: 48,
        liqMapMaxAgeBars: 48,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.25,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1.25,
        htfMode: "none",
        minAdx: 0,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "bn_t1_trend_lb72_rr0.8",
        liqMapLookbackBars: 72,
        liqMapMaxAgeBars: 72,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.35,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 0.8,
        htfMode: "with",
        minAdx: 18,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "bn_t1_trend_lb72_rr1.5",
        liqMapLookbackBars: 72,
        liqMapMaxAgeBars: 72,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.35,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1.5,
        htfMode: "with",
        minAdx: 0,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
      {
        label: "eq_countertrend_quality",
        liqMapLookbackBars: 24,
        liqMapMaxAgeBars: 24,
        liqMapMinTouches: 2,
        liqMapMinWickRatio: 0.45,
        liqMapMinRvol: 1.1,
        liqMapMinBodyRatio: 0,
        liqMapSweepPct: 0.0006,
        liqMapEqualTolPct: 0.0008,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
        rr: 1.25,
        htfMode: "against",
        minAdx: 18,
        maxAdx: 0,
        maxHoldBars: 36,
        maxSlPct: 0.035,
        onePerDay: true,
      },
    ];
  }
  const out = [];
  for (const lookback of [24, 36, 48, 72])
    for (const minTouches of [1, 2])
      for (const rr of [0.8, 1, 1.25, 1.5])
        for (const minWick of [0.25, 0.35, 0.45])
          for (const minRvol of [0, 1.1, 1.4])
            for (const htfMode of ["none", "with", "against"])
              for (const adx of [
                { minAdx: 0, maxAdx: 0, tag: "anyAdx" },
                { minAdx: 0, maxAdx: 24, tag: "rangeAdx" },
                { minAdx: 18, maxAdx: 0, tag: "trendAdx" },
              ]) {
                out.push({
                  label: `lb${lookback}_t${minTouches}_rr${rr}_w${minWick}_rv${minRvol}_${htfMode}_${adx.tag}`,
                  liqMapLookbackBars: lookback,
                  liqMapMaxAgeBars: lookback,
                  liqMapMinTouches: minTouches,
                  liqMapMinWickRatio: minWick,
                  liqMapMinRvol: minRvol,
                  liqMapMinBodyRatio: 0,
                  liqMapSweepPct: 0.0006,
                  liqMapEqualTolPct: 0.0008,
                  liqMapRequireUnresolved: true,
                  liqMapRequireDirectionalClose: false,
                  rr,
                  htfMode,
                  ...adx,
                  maxHoldBars: 36,
                  maxSlPct: 0.035,
                  onePerDay: true,
                });
              }
  return out;
}

console.log(`\n=== Liquidity-map search ===`);
console.log(`symbols=${SYMBOLS.join(",")} ${TF} ${FROM}->${TO} risk=${(RISK * 100).toFixed(2)}% costR=${COST_R}\n`);

const all = [];
for (const symbol of SYMBOLS) {
  const candles = await readCandles(symbol, TF, fromMs - 5 * 86_400_000, toMs);
  if (!candles.length) {
    console.log(`[skip] ${symbol}: no candles`);
    continue;
  }
  const pre = precomputeIntraday(candles);
  attachAtrPercentileSeries(candles, pre, 2880);
  const rows = [];
  const vs = variants();
  const t0 = Date.now();
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    const m = simulate(candles, pre, v);
    rows.push({ symbol, label: v.label, opts: v, ...m });
  }
  rows.sort((a, b) => b.returnPct - a.returnPct || b.avgR - a.avgR);
  all.push(...rows);
  console.log(`\n--- ${symbol} top ${TOP} (${vs.length} configs, ${((Date.now() - t0) / 1000).toFixed(1)}s) ---`);
  console.log(`${"label".padEnd(LABEL_W)}${"tr".padStart(5)}${"/day".padStart(7)}${"ret%".padStart(9)}${"WR%".padStart(7)}${"avgR".padStart(8)}${"PF".padStart(7)}${"DD%".padStart(8)}`);
  for (const r of rows.slice(0, TOP)) {
    const pf = Number.isFinite(r.pf) ? r.pf.toFixed(2) : "inf";
    console.log(
      `${r.label.slice(0, LABEL_W).padEnd(LABEL_W)}${String(r.trades).padStart(5)}${r.perDay.toFixed(2).padStart(7)}${r.returnPct.toFixed(2).padStart(9)}${r.winRatePct.toFixed(1).padStart(7)}${r.avgR.toFixed(3).padStart(8)}${pf.padStart(7)}${r.maxDdPct.toFixed(2).padStart(8)}`,
    );
  }
}

if (SYMBOLS.length > 1) {
  const grouped = new Map();
  for (const r of all) {
    if (!grouped.has(r.label)) grouped.set(r.label, []);
    grouped.get(r.label).push(r);
  }
  const common = [...grouped.entries()]
    .filter(([, rows]) => rows.length === SYMBOLS.length)
    .map(([label, rows]) => ({
      label,
      meanRet: rows.reduce((a, r) => a + r.returnPct, 0) / rows.length,
      minRet: Math.min(...rows.map((r) => r.returnPct)),
      meanPerDay: rows.reduce((a, r) => a + r.perDay, 0) / rows.length,
      pos: rows.filter((r) => r.returnPct > 0).length,
    }))
    .sort((a, b) => b.meanRet - a.meanRet);
  console.log(`\n--- Cross-symbol common configs ---`);
  console.log(`${"label".padEnd(LABEL_W)}${"meanRet%".padStart(10)}${"minRet%".padStart(9)}${"mean/day".padStart(10)}${"pos".padStart(7)}`);
  for (const r of common.slice(0, TOP)) {
    console.log(
      `${r.label.slice(0, LABEL_W).padEnd(LABEL_W)}${r.meanRet.toFixed(2).padStart(10)}${r.minRet.toFixed(2).padStart(9)}${r.meanPerDay.toFixed(2).padStart(10)}${`${r.pos}/${SYMBOLS.length}`.padStart(7)}`,
    );
  }
}

await closePool?.();
