#!/usr/bin/env node
/**
 * DOGE F3 — deeper POC-cell restore (NOT open VAL).
 *
 * Hypothesis: under year-clean rej+poc lock, some POC cells bleed while others
 * pay. Block bleed cells → optionally restore N via ATR/score loosen without
 * re-redding years.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-poc-cell-restore.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "DOGEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { describeVpConditionCell } = await import("../src/strategy/vpConditionCell.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  VOLUME_PROFILE_FREQ_DOGE_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const LOCK = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpNoveltyEnabled: false,
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function findIdx(candles, ts) {
  let lo = 0,
    hi = candles.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...LOCK, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function score(m, h0) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const twUp = m.tw > h0.tw + 0.01;
  const retOk = m.ret >= h0.ret - 40;
  const calmarOk = m.calmar >= 1;
  const accept = allNonNeg && (twUp || (m.calmar > h0.calmar + 0.05 && m.ret >= h0.ret - 15));
  return { red, allNonNeg, twUp, retOk, calmarOk, accept: accept && retOk };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);
const pre = precomputeVolumeProfile(candles);

const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(`\n══ H0 lock (rej+poc year-clean) ══`);
console.log(`n=${h0.trades} tw=${h0.tw} ret=${h0.ret}% pf=${h0.pf} cal=${h0.calmar}`);
console.log(
  `years ${Object.entries(h0.years)
    .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
    .join(" ")}`,
);

const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "unknown";
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling",
    lookback: 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, LOCK);
  rows.push({
    year: yearBucket(ts),
    side,
    setup,
    cell: cell.key,
    macro: cell.macro,
    path: cell.path,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    mfePct: Number(t.mfePct ?? 0),
  });
}

const poc = rows.filter((r) => r.setup === "poc_bounce");
const rej = rows.filter((r) => r.setup === "va_rejection");
console.log(`\n══ Setup split ══`);
console.log("poc", summarize(poc));
console.log("rej", summarize(rej));

console.log("\n══ POC cells (net sorted) ══");
const pocByCell = {};
for (const r of poc) {
  pocByCell[r.cell] ??= [];
  pocByCell[r.cell].push(r);
}
const pocCellStats = Object.entries(pocByCell)
  .map(([k, list]) => ({ cell: k, ...summarize(list) }))
  .sort((a, b) => a.net - b.net);
for (const s of pocCellStats) {
  console.log(`  ${s.cell.padEnd(48)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
}

console.log("\n══ REJ cells (net sorted) ══");
const rejByCell = {};
for (const r of rej) {
  rejByCell[r.cell] ??= [];
  rejByCell[r.cell].push(r);
}
for (const [k, list] of Object.entries(rejByCell).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
  const s = summarize(list);
  console.log(`  ${k.padEnd(48)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
}

const bleedPoc = pocCellStats.filter((s) => s.net < 0).map((s) => s.cell);
const payPoc = pocCellStats.filter((s) => s.net > 0).map((s) => s.cell);
const bleedRej = Object.entries(rejByCell)
  .map(([k, list]) => ({ cell: k, ...summarize(list) }))
  .filter((s) => s.net < -5)
  .map((s) => s.cell);

console.log(`\nbleed POC cells (${bleedPoc.length}):`, bleedPoc.join(" | ") || "none");
console.log(`pay POC cells (${payPoc.length}):`, payPoc.join(" | ") || "none");

console.log("\n══ Soft: drop bleed POC cells ══");
for (const cell of bleedPoc) {
  const kept = rows.filter((r) => r.cell !== cell);
  const sAll = summarize(kept);
  const byY = {};
  let eq = START;
  for (const r of kept) {
    byY[r.year] ??= { n: 0, start: eq };
    byY[r.year].n += 1;
    eq += r.pnl;
    byY[r.year].end = eq;
  }
  const yStr = Object.entries(byY)
    .map(([y, s]) => `${y}:${+(((s.end - s.start) / s.start) * 100).toFixed(1)}%`)
    .join(" ");
  console.log(`  drop ${cell} → n=${sAll.n} net=${sAll.net} | ${yStr}`);
}

if (bleedPoc.length) {
  const kept = rows.filter((r) => !bleedPoc.includes(r.cell));
  console.log(`  drop ALL bleed POC →`, summarize(kept));
}

// Hard A/B — cell blocks + cautious N restore (never VAL)
const variants = [
  { id: "H0", over: {} },
  ...(bleedPoc.length
    ? [
        {
          id: "block_bleed_poc",
          over: { vpPreparedRegimeOnly: true, vpPreparedBlockCellKeys: bleedPoc },
        },
      ]
    : []),
  ...(bleedPoc.length >= 1
    ? [
        {
          id: "block_bleed_poc+atr007",
          over: {
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: bleedPoc,
            vpMinAtrPct: 0.007,
          },
        },
        {
          id: "block_bleed_poc+score5",
          over: {
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: bleedPoc,
            vpMinScore: 5,
          },
        },
        {
          id: "block_bleed_poc+gap1",
          over: {
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: bleedPoc,
            vpMinBarGap: 1,
          },
        },
        {
          id: "block_bleed_poc+atr007+score5",
          over: {
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: bleedPoc,
            vpMinAtrPct: 0.007,
            vpMinScore: 5,
          },
        },
      ]
    : []),
  // If no POC bleed, try blocking worst REJ cells only (quality) then N restore
  ...(bleedPoc.length === 0 && bleedRej.length
    ? [
        {
          id: "block_bleed_rej",
          over: { vpPreparedRegimeOnly: true, vpPreparedBlockCellKeys: bleedRej.slice(0, 3) },
        },
        {
          id: "block_bleed_rej+atr007",
          over: {
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: bleedRej.slice(0, 3),
            vpMinAtrPct: 0.007,
          },
        },
      ]
    : []),
  // Allowlist paying POC + all rej (tighten POC only)
  ...(payPoc.length
    ? [
        {
          id: "poc_allow_pay_only",
          over: {
            // Keep all setups; deny non-paying POC via block of bleed (already) —
            // allowlist would kill rej. Instead: block every POC cell not in pay list.
            vpPreparedRegimeOnly: true,
            vpPreparedBlockCellKeys: pocCellStats.filter((s) => s.net <= 0).map((s) => s.cell),
          },
        },
      ]
    : []),
  // Isolated: atr007 alone (known risky with poc — confirm under current lock)
  { id: "atr007_alone", over: { vpMinAtrPct: 0.007 } },
  { id: "score5_alone", over: { vpMinScore: 5 } },
];

// Dedupe
const seen = new Set();
const unique = variants.filter((v) => {
  if (seen.has(v.id)) return false;
  seen.add(v.id);
  return true;
});

console.log(`\n══ Hard A/B (${unique.length}) ══`);
const ab = [];
for (const v of unique) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = score(m, h0);
  ab.push({ id: v.id, over: v.over, ...m, ...sc });
  console.log(
    `${v.id}\n  n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} pf=${m.pf}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | yearClean=${sc.allNonNeg} accept=${sc.accept}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.accept) - Number(a.accept) ||
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.calmarOk) - Number(a.calmarOk) ||
    b.tw - a.tw ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(32)} accept=${r.accept} clean=${r.allNonNeg} cal≥1=${r.calmarOk} tw=${r.tw} ret=${r.ret}% cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best = ab.find((r) => r.accept && r.allNonNeg) || ab.find((r) => r.allNonNeg && r.id !== "H0");
console.log(`\n══ Best candidate: ${best?.id ?? "none"} ══`);

const outPath = path.join(__dirname, ".vp-freq-doge-poc-cell-restore.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      h0,
      pocCellStats,
      bleedPoc,
      payPoc,
      bleedRej,
      ab,
      best: best ? { id: best.id, over: best.over, tw: best.tw, ret: best.ret, calmar: best.calmar, years: best.years } : null,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
