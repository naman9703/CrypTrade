#!/usr/bin/env node
/**
 * AVAX VP FREQ — Phase 1–2 autopsy + one-change A/B with IS/OOS split.
 *
 * Baseline (from prior screen): VAL + va_rejection + weak_bear vacuum VAL block.
 * Named gap: 2022–23 ≈ −41% while other years pay.
 *
 * Usage: SKIP_ENSURE=1 node scripts/backtest-vp-freq-avax-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "AVAXUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
/** Holdout: early stress = OOS; later years = IS for comparison. */
const OOS_END = process.env.OOS_END || "2023-06-01";
const START_USDT = 100;
const RISK_PCT = 2.5;
const LEVERAGE = 12;

const USE_REST = process.env.USE_REST === "1" || process.env.SKIP_DB === "1";
const candleCachePath = path.join(__dirname, ".vp-freq-avax-candles-cache.json");

let closePool = async () => {};
let readFundingRates = async () => [];
if (!USE_REST) {
  const pool = await import("../src/db/pool.js");
  closePool = pool.closePool ?? (async () => {});
  if (!pool.getPool?.()) await pool.initPool({ info: () => {}, warn: () => {}, error: console.error });
}

const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  classifyVpMacro,
  classifyVpPath,
  buildVpConditionCellKey,
  vpMacroBullAt,
} = await import("../src/strategy/vpConditionCell.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);

const BASELINE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellBlockWeakBearVacuum: true,
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: RISK_PCT,
  riskPerTradeUnit: "PCT",
  futuresLeverage: LEVERAGE,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
};

/** One change each vs BASELINE — do not stack unless stacked row is labeled. */
const VARIANTS = [
  { id: "H0_weakBearVac", over: {} },
  {
    id: "H1_extDownRej",
    over: {
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
    },
  },
  {
    id: "H2_prepVacValBear",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumValBear: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedVacuumPathPct: 0.02,
    },
  },
  {
    id: "H3_blockBullChopVacVal",
    // Approximate via flat prior60 VAL block (bull_chop / transition grind)
    over: {
      vpValSellBlockFlatPrior60: true,
      vpValSellFlatPrior60LoPct: -0.05,
      vpValSellFlatPrior60HiPct: 0.05,
    },
  },
  {
    id: "H4_valOnly",
    over: { vpAllowedSetups: ["val_breakdown"] },
  },
  {
    id: "H5_htf020",
    over: { vpMinHtfSepPct: 0.002 },
  },
  {
    id: "H6_volTarget",
    over: {
      volTargetSizing: true,
      volTargetAtrPct: 0.005,
      volTargetMinMult: 0.4,
      volTargetMaxMult: 2,
    },
  },
  {
    id: "H7_rejWick35",
    over: { vpRejectionMinWickRatio: 0.35 },
  },
  {
    id: "H8_sellChase",
    over: {
      vpValSellChaseFilter: true,
      vpValSellChaseMaxPrior5dPct: 0.05,
    },
  },
  {
    // Stack only after isolating: weakBear + prepared vac-val-bear + extDown rej
    id: "S1_wb_prep_ext",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumValBear: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedVacuumPathPct: 0.02,
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
    },
  },
  {
    id: "S2_wb_prep_ext_vol",
    over: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumValBear: true,
      vpPreparedBlockVacuumVah: false,
      vpPreparedVacuumPathPct: 0.02,
      vpRejectionSellBlockExtendedDown: true,
      vpRejectionExtendedPriorPct: 0.05,
      volTargetSizing: true,
      volTargetAtrPct: 0.005,
      volTargetMinMult: 0.4,
      volTargetMaxMult: 2,
    },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
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

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function metricsFor(trades, equityCurve) {
  const m = computeAllMetrics({
    trades,
    equityCurve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const years = {};
  let eq = START_USDT;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq, net: 0 };
    years[y].n += 1;
    years[y].net += Number(t.netPnl ?? 0);
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
    y.net = +y.net.toFixed(2);
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    years,
  };
}

function sliceMetrics(trades, lo, hi) {
  const subset = trades.filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = START_USDT;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of subset) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({
    trades: subset,
    equityCurve: curve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const weeks = Math.max(1, (hi - lo) / (7 * 864e5));
  return {
    trades: subset.length,
    tw: +(subset.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, BASELINE);

async function loadCandles() {
  if (USE_REST || process.env.FORCE_REST === "1") {
    if (fs.existsSync(candleCachePath) && process.env.REFRESH_CACHE !== "1") {
      process.stderr.write(`load cache ${candleCachePath}…\n`);
      const cached = JSON.parse(fs.readFileSync(candleCachePath, "utf8"));
      if (cached?.candles?.length && cached.fromMs <= padFrom && cached.toMs >= toMs) {
        return cached.candles.filter((c) => c.ts >= padFrom && c.ts <= toMs);
      }
    }
    process.stderr.write("fetch Binance futures klines (REST, no DB)…\n");
    const rows = await fetchBinanceKlinesRange({
      symbol: SYMBOL,
      interval: TF,
      startTime: padFrom,
      endTime: toMs,
      feedKind: "BINANCE_FUTURES",
      onProgress: ({ pct }) => {
        if (pct % 10 < 1) process.stderr.write(`  klines ${pct}%\n`);
      },
    });
    const candles = rows.map((r) => ({
      ts: Number(r.ts),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
      taker_buy_volume: Number(r.taker_buy_volume ?? 0),
    }));
    fs.writeFileSync(
      candleCachePath,
      JSON.stringify({ symbol: SYMBOL, tf: TF, fromMs: padFrom, toMs, candles }),
    );
    process.stderr.write(`cached ${candles.length} bars → ${candleCachePath}\n`);
    return candles;
  }
  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  const fundingMod = await import("../src/backtest/data/fundingIngest.js");
  readFundingRates = fundingMod.readFundingRates;
  if (!process.env.SKIP_ENSURE) {
    process.stderr.write("ensureKlines…\n");
    await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
  }
  process.stderr.write("load candles…\n");
  return readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
}

process.stderr.write(`mode=${USE_REST ? "REST" : "DB"}\n`);
const candles = await loadCandles();
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
process.stderr.write(`candles=${candles.length}\n`);

async function runCfg(cfg) {
  const runCfg = { ...cfg, backtestSignalStartMs: fromMs };
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, runCfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: runCfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
    costModelOverride: {
      leverage: LEVERAGE,
      openFeeRate: 0.0004,
      closeFeeRate: 0.0004,
      slippagePct: 0.0005,
    },
  });
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  return { trades, equityCurve: sim.equityCurve };
}

// ── Autopsy on H0 ──────────────────────────────────────────────────────────
process.stderr.write("autopsy H0…\n");
{
  const cfg = { ...BASELINE };
  const pre = precomputeVolumeProfile(candles, cfg);
  const { trades } = await runCfg(cfg);
  const rows = [];
  for (const t of trades) {
    const ts = Number(t.entryTs);
    const idx = findIdx(candles, ts);
    if (idx < 1) continue;
    const side = String(t.direction ?? t.side ?? "").toUpperCase();
    const setup = String(t.vpSetup || t.entryReason || t.reason || "").replace(/^vp_/, "");
    const vp = buildVolumeProfile(candles, idx, {
      mode: "rolling",
      lookback: cfg.vpLookbackBars ?? 384,
      bins: 50,
      includePriorSession: true,
    });
    const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
    const pathPct = Number(path?.distPct ?? 0);
    const macroBull = vpMacroBullAt(pre, idx, cfg);
    const prior60 = pre.macroPrior60d?.[idx];
    const prior20 = pre.macroPrior20d?.[idx];
    const prior5 = pre.macroPrior5d?.[idx];
    const macro = classifyVpMacro(prior60, macroBull, -0.05);
    const cell = buildVpConditionCellKey(side, setup, macro, classifyVpPath(pathPct, 0.02));
    rows.push({
      year: yearBucket(ts),
      setup,
      pnl: Number(t.netPnl ?? 0),
      prior5,
      prior20,
      prior60,
      macro,
      cell,
      pathPct,
      htfSep: Number(pre.htfSep?.[idx] ?? NaN),
    });
  }

  function printBuckets(label, subset, keyFn) {
    const map = new Map();
    for (const r of subset) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    console.log(`\n-- ${label} (n=${subset.length} net=${summarize(subset).net}) --`);
    for (const [k, list] of [...map.entries()].sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
      const s = summarize(list);
      console.log(`  ${String(k).padEnd(48)} n=${String(s.n).padStart(3)} net=${String(s.net).padStart(8)} wr=${s.wr}%`);
    }
  }

  console.log(`\n══ AVAX H0 autopsy ══ ${FROM}→${TO}  trades=${rows.length} overall=${JSON.stringify(summarize(rows))}`);
  printBuckets("by setup", rows, (r) => r.setup);
  printBuckets("by cell", rows, (r) => r.cell);
  printBuckets("2022-23 cells", rows.filter((r) => r.year === "2022-23"), (r) => r.cell);
  printBuckets(
    "VAL path×macro",
    rows.filter((r) => r.setup === "val_breakdown"),
    (r) => `${r.macro}|${Number.isFinite(r.pathPct) && r.pathPct >= 0.02 ? "vacuum" : "struct"}`,
  );
  printBuckets(
    "rej prior20",
    rows.filter((r) => r.setup === "va_rejection"),
    (r) => (r.prior20 == null ? "na" : r.prior20 <= -0.05 ? "dump20" : r.prior20 > 0.02 ? "bull20" : "mid20"),
  );
}

// ── A/B variants ───────────────────────────────────────────────────────────
const results = [];
for (const v of VARIANTS) {
  process.stderr.write(`run ${v.id}…\n`);
  const cfg = { ...BASELINE, ...v.over };
  const { trades, equityCurve } = await runCfg(cfg);
  const full = metricsFor(trades, equityCurve);
  const oos = sliceMetrics(trades, fromMs, oosEndMs);
  const hold = sliceMetrics(trades, oosEndMs, toMs);
  const row = { id: v.id, full, oos, hold };
  results.push(row);
  console.log(
    `\n${v.id} FULL tr=${full.trades} tw=${full.tw} ret=${full.ret} pf=${full.pf} dd=${full.dd} cal=${full.calmar}` +
      ` | OOS(${FROM}→${OOS_END}) tr=${oos.trades} ret=${oos.ret} pf=${oos.pf} dd=${oos.dd}` +
      ` | IS(${OOS_END}→${TO}) tr=${hold.trades} ret=${hold.ret} pf=${hold.pf}`,
  );
  console.log(
    "  years:",
    Object.entries(full.years)
      .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
      .join(" "),
  );
}

const outPath = path.join(__dirname, ".vp-freq-avax-optimize.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      symbol: SYMBOL,
      window: `${FROM}→${TO}`,
      oosSplit: `${FROM}→${OOS_END} | ${OOS_END}→${TO}`,
      baseline: "val_rej + weakBearVac",
      results,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);
await closePool?.();
