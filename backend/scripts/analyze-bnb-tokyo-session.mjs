#!/usr/bin/env node
/**
 * BNB Tokyo / Asia session pattern study — Jan 1 to Jun 8 2026.
 * Session: ICT Asia = 00:00–04:00 UTC (09:00–13:00 JST).
 *
 * Usage: node scripts/analyze-bnb-tokyo-session.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = "2026-01-01";
const TO = "2026-06-09"; // exclusive end for Jun 8 close
const ASIA_START = 0;
const ASIA_END = 4;
const PRE_ASIA_START = 20; // prior UTC evening range proxy (NY late)
const FEE = 0.0008; // round-trip ~0.08%

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const candles = await readCandles(SYMBOL, TF, fromMs, toMs, { market: "futures" });
if (!candles?.length) {
  console.error("No candles");
  process.exit(1);
}

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function utcHour(ts) {
  return new Date(ts).getUTCHours();
}

/** Bars whose open time falls in [startH, endH) UTC on a given day. */
function sessionBars(day, startH, endH) {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const out = [];
  for (const c of candles) {
    if (c.ts < dayStart || c.ts >= dayStart + 86_400_000) continue;
    const h = utcHour(c.ts);
    if (h >= startH && h < endH) out.push(c);
  }
  return out;
}

function preAsiaBars(day) {
  const prev = new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const bars = [];
  for (const d of [prev, day]) {
    const dayStart = Date.parse(`${d}T00:00:00.000Z`);
    for (const c of candles) {
      if (c.ts < dayStart || c.ts >= dayStart + 86_400_000) continue;
      const h = utcHour(c.ts);
      if (d === prev && h >= PRE_ASIA_START) bars.push(c);
      if (d === day && h < ASIA_START) bars.push(c);
    }
  }
  return bars;
}

function rangeOf(bars) {
  if (!bars.length) return null;
  return {
    hi: Math.max(...bars.map((b) => b.high)),
    lo: Math.min(...bars.map((b) => b.low)),
    open: bars[0].open,
    close: bars[bars.length - 1].close,
  };
}

function netPct(side, entry, exit) {
  const gross = side === "LONG" ? (exit - entry) / entry : (entry - exit) / entry;
  return gross - FEE;
}

/** Simulate one trade within Asia session bars. */
function simTrade(side, entryIdx, entry, sl, tp, bars) {
  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    if (side === "LONG") {
      if (b.low <= sl) return { win: false, exit: sl, bars: i - entryIdx + 1 };
      if (b.high >= tp) return { win: true, exit: tp, bars: i - entryIdx + 1 };
    } else {
      if (b.high >= sl) return { win: false, exit: sl, bars: i - entryIdx + 1 };
      if (b.low <= tp) return { win: true, exit: tp, bars: i - entryIdx + 1 };
    }
  }
  const last = bars[bars.length - 1].close;
  const win = side === "LONG" ? last > entry : last < entry;
  return { win, exit: last, bars: bars.length - entryIdx, eod: true };
}

const days = [];
let d = FROM;
while (d < TO) {
  days.push(d);
  d = new Date(Date.parse(`${d}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

const patterns = {
  /** Fade sweep of pre-Asia range high → target mid/range low */
  sweepHiFade: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  sweepLoFade: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  /** Break pre-Asia high, retest hold → long to 1× range extension */
  breakHiMom: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  breakLoMom: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  /** First 15m Asia candle color fade (opposite) */
  firstBarFade: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  /** First 15m Asia candle follow (same direction) */
  firstBarFollow: { wins: 0, losses: 0, skip: 0, pnl: 0 },
  /** Asia closes outside pre-range → fade back into range at last hour */
  closeOutsideFade: { wins: 0, losses: 0, skip: 0, pnl: 0 },
};

const dayLog = [];

for (const day of days) {
  const asia = sessionBars(day, ASIA_START, ASIA_END);
  if (asia.length < 8) continue;
  const pre = preAsiaBars(day);
  const preR = rangeOf(pre);
  const asiaR = rangeOf(asia);
  if (!preR || !asiaR) continue;

  const preMid = (preR.hi + preR.lo) / 2;
  const preWidth = preR.hi - preR.lo;
  if (preWidth <= 0) continue;

  const entry = { day, preR, asiaR, preWidth };

  // --- Pattern A: sweep high fade (short) ---
  let sweepHiIdx = -1;
  for (let i = 0; i < asia.length; i++) {
    if (asia[i].high > preR.hi * 1.0003 && asia[i].close < preR.hi) {
      sweepHiIdx = i;
      break;
    }
  }
  if (sweepHiIdx >= 0 && sweepHiIdx < asia.length - 2) {
    const e = asia[sweepHiIdx].close;
    const sl = asia[sweepHiIdx].high * 1.001;
    const tp = preMid;
    const r = simTrade("SHORT", sweepHiIdx + 1, e, sl, tp, asia.slice(sweepHiIdx + 1));
    const p = netPct("SHORT", e, r.exit);
    patterns.sweepHiFade.pnl += p;
    r.win ? patterns.sweepHiFade.wins++ : patterns.sweepHiFade.losses++;
    entry.sweepHi = { p, win: r.win };
  } else patterns.sweepHiFade.skip++;

  // --- Pattern B: sweep low fade (long) ---
  let sweepLoIdx = -1;
  for (let i = 0; i < asia.length; i++) {
    if (asia[i].low < preR.lo * 0.9997 && asia[i].close > preR.lo) {
      sweepLoIdx = i;
      break;
    }
  }
  if (sweepLoIdx >= 0 && sweepLoIdx < asia.length - 2) {
    const e = asia[sweepLoIdx].close;
    const sl = asia[sweepLoIdx].low * 0.999;
    const tp = preMid;
    const r = simTrade("LONG", sweepLoIdx + 1, e, sl, tp, asia.slice(sweepLoIdx + 1));
    const p = netPct("LONG", e, r.exit);
    patterns.sweepLoFade.pnl += p;
    r.win ? patterns.sweepLoFade.wins++ : patterns.sweepLoFade.losses++;
    entry.sweepLo = { p, win: r.win };
  } else patterns.sweepLoFade.skip++;

  // --- Pattern C: first bar fade ---
  const fb = asia[0];
  const bull = fb.close > fb.open;
  if (asia.length > 2) {
    const side = bull ? "SHORT" : "LONG";
    const e = fb.close;
    const sl = bull ? fb.high * 1.001 : fb.low * 0.999;
    const tp = bull ? preMid : preMid;
    const r = simTrade(side, 1, e, sl, tp, asia.slice(1));
    const p = netPct(side, e, r.exit);
    patterns.firstBarFade.pnl += p;
    r.win ? patterns.firstBarFade.wins++ : patterns.firstBarFade.losses++;
    entry.firstFade = { p, win: r.win, side };
  } else patterns.firstBarFade.skip++;

  // --- Pattern D: first bar follow to range extension ---
  if (asia.length > 2) {
    const side = bull ? "LONG" : "SHORT";
    const e = fb.close;
    const sl = bull ? fb.low * 0.999 : fb.high * 1.001;
    const tp = bull ? e + preWidth * 0.5 : e - preWidth * 0.5;
    const r = simTrade(side, 1, e, sl, tp, asia.slice(1));
    const p = netPct(side, e, r.exit);
    patterns.firstBarFollow.pnl += p;
    r.win ? patterns.firstBarFollow.wins++ : patterns.firstBarFollow.losses++;
    entry.firstFollow = { p, win: r.win, side };
  } else patterns.firstBarFollow.skip++;

  // --- Best-of-day: pick first triggered sweep fade only (one trade rule) ---
  let oneTrade = null;
  if (sweepHiIdx >= 0) oneTrade = entry.sweepHi ? { type: "sweepHiFade", ...entry.sweepHi } : null;
  else if (sweepLoIdx >= 0) oneTrade = entry.sweepLo ? { type: "sweepLoFade", ...entry.sweepLo } : null;
  else oneTrade = entry.firstFade ? { type: "firstBarFade", ...entry.firstFade } : null;

  dayLog.push({ day, oneTrade, preWidth, asiaRange: asiaR.hi - asiaR.lo });
}

function stat(name, p) {
  const n = p.wins + p.losses;
  const wr = n ? ((p.wins / n) * 100).toFixed(1) : "—";
  const avg = n ? ((p.pnl / n) * 100).toFixed(3) : "—";
  const tot = (p.pnl * 100).toFixed(2);
  console.log(
    `${name.padEnd(22)} n=${String(n).padStart(3)} skip=${String(p.skip).padStart(3)} WR=${wr.padStart(5)}% avg=${avg.padStart(7)}% tot=${tot.padStart(8)}%`,
  );
}

console.log(`\n=== BNB ${TF} Tokyo/Asia session study ===`);
console.log(`Session: ${ASIA_START}:00–${ASIA_END}:00 UTC · ${FROM} → Jun 8 2026 · ${days.length} calendar days\n`);
console.log("Pre-Asia range: prior day 20:00 UTC → 00:00 UTC (overnight box)\n");
console.log("Pattern results (1 entry model each, exit within Asia session):\n");
stat("Sweep HIGH → fade", patterns.sweepHiFade);
stat("Sweep LOW → fade", patterns.sweepLoFade);
stat("1st 15m bar FADE", patterns.firstBarFade);
stat("1st 15m bar FOLLOW", patterns.firstBarFollow);

const onePerDay = dayLog.filter((x) => x.oneTrade);
const oneWins = onePerDay.filter((x) => x.oneTrade.win).length;
const onePnl = onePerDay.reduce((s, x) => s + (x.oneTrade.p || 0), 0);
console.log(`\nOne-trade rule (sweep fade priority, else 1st-bar fade):`);
console.log(`  days with trade: ${onePerDay.length}/${dayLog.length}`);
console.log(`  WR: ${((oneWins / onePerDay.length) * 100).toFixed(1)}%`);
console.log(`  total net: ${(onePnl * 100).toFixed(2)}% (non-compounded)`);

// Session character
let insidePre = 0;
let brokeHi = 0;
let brokeLo = 0;
for (const { asiaR, preR } of dayLog.map((x) => {
  const asia = sessionBars(x.day, ASIA_START, ASIA_END);
  const pre = preAsiaBars(x.day);
  return { asiaR: rangeOf(asia), preR: rangeOf(pre) };
})) {
  if (!asiaR || !preR) continue;
  if (asiaR.hi <= preR.hi && asiaR.lo >= preR.lo) insidePre++;
  else if (asiaR.hi > preR.hi && asiaR.lo >= preR.lo) brokeHi++;
  else if (asiaR.lo < preR.lo && asiaR.hi <= preR.hi) brokeLo++;
}
const nDays = dayLog.length;
console.log(`\nSession behaviour (${nDays} days):`);
console.log(`  Asia fully inside overnight box: ${insidePre} (${((insidePre / nDays) * 100).toFixed(0)}%)`);
console.log(`  Asia broke HIGH only: ${brokeHi} (${((brokeHi / nDays) * 100).toFixed(0)}%)`);
console.log(`  Asia broke LOW only: ${brokeLo} (${((brokeLo / nDays) * 100).toFixed(0)}%)`);

// --- Refined models ---
function runModel(name, fn) {
  let wins = 0;
  let losses = 0;
  let skip = 0;
  let pnl = 0;
  for (const day of days) {
    const asia = sessionBars(day, ASIA_START, ASIA_END);
    if (asia.length < 8) {
      skip++;
      continue;
    }
    const pre = preAsiaBars(day);
    const preR = rangeOf(pre);
    if (!preR || preR.hi - preR.lo <= 0) {
      skip++;
      continue;
    }
    const r = fn(asia, preR, day);
    if (!r) {
      skip++;
      continue;
    }
    pnl += r.p;
    r.win ? wins++ : losses++;
  }
  stat(name, { wins, losses, skip, pnl });
}

console.log("\nRefined models (one trade/day max):\n");

runModel("Hi sweep fade → pre LOW", (asia, preR) => {
  const preMid = (preR.hi + preR.lo) / 2;
  for (let i = 0; i < asia.length - 2; i++) {
    if (asia[i].high > preR.hi * 1.0003 && asia[i].close < preR.hi) {
      const e = asia[i].close;
      const sl = asia[i].high * 1.001;
      const tp = preR.lo;
      const t = simTrade("SHORT", i + 1, e, sl, tp, asia.slice(i + 1));
      return { win: t.win, p: netPct("SHORT", e, t.exit) };
    }
  }
  return null;
});

runModel("Hi sweep fade (width>0.4%)", (asia, preR) => {
  const w = (preR.hi - preR.lo) / preR.lo;
  if (w < 0.004) return null;
  for (let i = 0; i < asia.length - 2; i++) {
    if (asia[i].high > preR.hi * 1.0003 && asia[i].close < preR.hi) {
      const e = asia[i].close;
      const sl = asia[i].high * 1.001;
      const tp = (preR.hi + preR.lo) / 2;
      const t = simTrade("SHORT", i + 1, e, sl, tp, asia.slice(i + 1));
      return { win: t.win, p: netPct("SHORT", e, t.exit) };
    }
  }
  return null;
});

runModel("Lo sweep fade → pre HIGH", (asia, preR) => {
  for (let i = 0; i < asia.length - 2; i++) {
    if (asia[i].low < preR.lo * 0.9997 && asia[i].close > preR.lo) {
      const e = asia[i].close;
      const sl = asia[i].low * 0.999;
      const tp = preR.hi;
      const t = simTrade("LONG", i + 1, e, sl, tp, asia.slice(i + 1));
      return { win: t.win, p: netPct("LONG", e, t.exit) };
    }
  }
  return null;
});

runModel("Hi sweep ONLY (skip low days)", (asia, preR) => {
  let hi = false;
  let lo = false;
  for (const b of asia) {
    if (b.high > preR.hi * 1.0003) hi = true;
    if (b.low < preR.lo * 0.9997) lo = true;
  }
  if (lo || !hi) return null;
  for (let i = 0; i < asia.length - 2; i++) {
    if (asia[i].high > preR.hi * 1.0003 && asia[i].close < preR.hi) {
      const e = asia[i].close;
      const sl = asia[i].high * 1.001;
      const tp = (preR.hi + preR.lo) / 2;
      const t = simTrade("SHORT", i + 1, e, sl, tp, asia.slice(i + 1));
      return { win: t.win, p: netPct("SHORT", e, t.exit) };
    }
  }
  return null;
});

runModel("00:00 open fade prior close", (asia, preR, day) => {
  const prevDay = new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const prevAsia = sessionBars(prevDay, ASIA_START, ASIA_END);
  if (!prevAsia.length) return null;
  const prevClose = prevAsia[prevAsia.length - 1].close;
  const open0 = asia[0].open;
  const gap = (open0 - prevClose) / prevClose;
  if (Math.abs(gap) < 0.0015) return null;
  const side = gap > 0 ? "SHORT" : "LONG";
  const e = asia[0].close;
  const sl = gap > 0 ? asia[0].high * 1.001 : asia[0].low * 0.999;
  const tp = prevClose;
  const t = simTrade(side, 1, e, sl, tp, asia.slice(1));
  return { win: t.win, p: netPct(side, e, t.exit) };
});

runModel("Asia mean-revert to pre mid", (asia, preR) => {
  const preMid = (preR.hi + preR.lo) / 2;
  const open0 = asia[0].open;
  const dist = (open0 - preMid) / preMid;
  if (Math.abs(dist) < 0.002) return null;
  const side = dist > 0 ? "SHORT" : "LONG";
  const e = asia[0].close;
  const sl = side === "SHORT" ? asia[0].high * 1.0015 : asia[0].low * 0.9985;
  const tp = preMid;
  const t = simTrade(side, 1, e, sl, tp, asia.slice(1));
  return { win: t.win, p: netPct(side, e, t.exit) };
});

// Hour-of-sweep for high fade
let earlyHi = { w: 0, l: 0, p: 0 };
let lateHi = { w: 0, l: 0, p: 0 };
for (const day of days) {
  const asia = sessionBars(day, ASIA_START, ASIA_END);
  const preR = rangeOf(preAsiaBars(day));
  if (!preR || asia.length < 8) continue;
  for (let i = 0; i < asia.length - 2; i++) {
    if (asia[i].high > preR.hi * 1.0003 && asia[i].close < preR.hi) {
      const e = asia[i].close;
      const sl = asia[i].high * 1.001;
      const tp = (preR.hi + preR.lo) / 2;
      const t = simTrade("SHORT", i + 1, e, sl, tp, asia.slice(i + 1));
      const p = netPct("SHORT", e, t.exit);
      const h = utcHour(asia[i].ts);
      const bucket = h < 2 ? earlyHi : lateHi;
      t.win ? bucket.w++ : bucket.l++;
      bucket.p += p;
      break;
    }
  }
}
console.log("\nSweep-high fade timing (00-02 UTC vs 02-04 UTC):");
for (const [label, b] of [
  ["00:00-02:00 UTC", earlyHi],
  ["02:00-04:00 UTC", lateHi],
]) {
  const n = b.w + b.l;
  console.log(`  ${label}: n=${n} WR=${n ? ((b.w / n) * 100).toFixed(1) : "—"}% tot=${(b.p * 100).toFixed(2)}%`);
}

await closePool?.();
