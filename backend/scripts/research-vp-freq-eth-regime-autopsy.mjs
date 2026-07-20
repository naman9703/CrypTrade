#!/usr/bin/env node
/**
 * Deep market-feature autopsy: ETH VP FREQ 2022–23 vs 2025–26.
 * Goal: explain WHY same setups fail/win — not to cut trade count.
 *
 * Attaches at each entry: macro, HTF, ADX/ATR, bar quality, VP geometry,
 * brackets, post-entry MAE/MFE efficiency.
 *
 * Usage (from backend/):
 *   node scripts/research-vp-freq-eth-regime-autopsy.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const WINDOWS = [
  { tag: "2022-23", from: "2022-06-01", to: "2023-05-31" },
  { tag: "2025-26", from: "2025-06-01", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const {
  buildVolumeProfile,
  pathToNextHvn,
  volumeProfileBrackets,
  priorTrendMovePct,
} = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function avg(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function pct(xs, p) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * (a.length - 1))));
  return a[i];
}
function sessionOf(hour) {
  if (hour >= 0 && hour < 8) return "asia";
  if (hour >= 8 && hour < 13) return "london";
  if (hour >= 13 && hour < 21) return "ny";
  return "off";
}
function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0) || !Number.isFinite(b)) return null;
  return (b - a) / a;
}
function volRatio(candles, idx, lb = 20) {
  const slice = candles.slice(Math.max(0, idx - lb), idx).map((c) => Number(c.volume) || 0);
  const m = slice.length ? slice.reduce((s, x) => s + x, 0) / slice.length : 0;
  return m > 0 ? (Number(candles[idx].volume) || 0) / m : 1;
}
function bodyDir(bar, side) {
  const r = Math.max(bar.high - bar.low, 1e-12);
  return side === "BUY" ? (bar.close - bar.open) / r : (bar.open - bar.close) / r;
}
function closeStr(bar) {
  const r = Math.max(bar.high - bar.low, 1e-12);
  return (bar.close - bar.low) / r;
}
function upperWick(bar) {
  const r = Math.max(bar.high - bar.low, 1e-12);
  return (bar.high - Math.max(bar.open, bar.close)) / r;
}
function lowerWick(bar) {
  const r = Math.max(bar.high - bar.low, 1e-12);
  return (Math.min(bar.open, bar.close) - bar.low) / r;
}

/** Realized vol proxy: stdev of 1-bar returns over lookback, annualized-ish for display as %. */
function realizedVolPct(candles, idx, lb = 96) {
  if (idx < lb + 1) return null;
  const rets = [];
  for (let i = idx - lb + 1; i <= idx; i++) {
    const a = candles[i - 1].close;
    const b = candles[i].close;
    if (a > 0) rets.push((b - a) / a);
  }
  if (rets.length < 10) return null;
  const m = avg(rets);
  const v = avg(rets.map((r) => (r - m) ** 2));
  return Math.sqrt(v) * 100; // % per bar
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

function attachFeatures(trade, candles, pre, cfg) {
  const ts = Number(trade.entryTs ?? trade.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) return null;
  const bar = candles[idx];
  const side = String(trade.direction ?? trade.side).toUpperCase();
  const reason = String(trade.entryReason ?? trade.reason ?? "");
  const setup = reason.replace(/^vp_/, "") || String(trade.vpSetup ?? "");

  const vp = buildVolumeProfile(candles, idx, {
    mode: cfg.vpProfileMode ?? "composite_utc",
    lookback: cfg.vpLookbackBars ?? 384,
    bins: cfg.vpBins ?? 50,
    valueAreaPct: cfg.vpValueAreaPct,
    distribute: cfg.vpVolumeDistribute,
    includePriorSession: cfg.vpIncludePriorSession !== false,
    vpCompositeDays: cfg.vpCompositeDays,
  });

  const px = bar.close;
  const path = vp ? pathToNextHvn(px, side, vp) : null;
  const br = vp ? volumeProfileBrackets(px, side, vp, cfg) : null;
  const atr = pre.atrSeries[idx];
  const atrPct = atr > 0 && px > 0 ? atr / px : null;
  const adx = pre.adxSeries[idx];
  const hour = new Date(ts).getUTCHours();

  const distVah = vp?.vah > 0 ? (px - vp.vah) / vp.vah : null;
  const distVal = vp?.val > 0 ? (px - vp.val) / vp.val : null;
  const distPoc = vp?.poc > 0 ? (px - vp.poc) / vp.poc : null;
  const vaWidth = vp?.vah > 0 && vp?.val > 0 ? (vp.vah - vp.val) / px : null;

  const mae = Number(trade.maePct ?? 0);
  const mfe = Number(trade.mfePct ?? 0);
  const slPct = Number(trade.initialSlPct ?? trade.slPct ?? br?.slPct ?? 0);
  const tpPct = Number(trade.initialTpPct ?? trade.tpPct ?? br?.tpPct ?? 0);
  // efficiency: did we capture available MFE? (mfe vs tp)
  const mfeCapture = tpPct > 0 ? mfe / (tpPct * 100) : null; // mae/mfe often stored as %
  const maeVsSl = slPct > 0 ? Math.abs(mae) / (slPct * 100) : null;

  // next 8 bars after entry — did VAH get retested (pullback opportunity)?
  let retestedVah = false;
  let maxFavor8 = 0;
  let maxAdverse8 = 0;
  if (vp && idx + 8 < candles.length) {
    for (let j = idx + 1; j <= idx + 8; j++) {
      const c = candles[j];
      if (side === "BUY") {
        if (c.low <= vp.vah * 1.001) retestedVah = true;
        maxFavor8 = Math.max(maxFavor8, (c.high - px) / px);
        maxAdverse8 = Math.max(maxAdverse8, (px - c.low) / px);
      } else {
        if (c.high >= vp.vah * 0.999 && setup.includes("rejection")) retestedVah = true;
        maxFavor8 = Math.max(maxFavor8, (px - c.low) / px);
        maxAdverse8 = Math.max(maxAdverse8, (c.high - px) / px);
      }
    }
  }

  return {
    tag: trade._tag,
    side,
    setup,
    reason,
    pnl: Number(trade.netPnl ?? 0),
    win: Number(trade.netPnl ?? 0) > 0,
    exit: String(trade.exitReason ?? ""),
    lossPat: String(trade.lossPattern ?? ""),
    bars: Number(trade.barsHeld ?? 0),
    mae,
    mfe,
    entry: new Date(ts).toISOString(),
    hour,
    session: sessionOf(hour),
    // macro
    prior1d: priorPct(candles, idx, 96),
    prior5d: priorPct(candles, idx, 96 * 5),
    prior20d: priorPct(candles, idx, 96 * 20),
    prior60d: priorPct(candles, idx, 96 * 60),
    prior4h: priorTrendMovePct(candles, idx, 16),
    aboveEma20d: pre.macroAboveEma20d?.[idx] === true,
    slope5d: pre.macroEma5dSlope?.[idx] ?? null,
    // HTF
    htfUp: pre.htfUp[idx] === true,
    htfDown: pre.htfDown[idx] === true,
    htfSep: pre.htfSep[idx] ?? 0,
    // vol / trend strength
    adx,
    atrPct,
    rv1d: realizedVolPct(candles, idx, 96),
    rv5d: realizedVolPct(candles, idx, 96 * 5),
    volR: volRatio(candles, idx),
    // bar quality
    body: bodyDir(bar, side),
    closeStr: closeStr(bar),
    upperWick: upperWick(bar),
    lowerWick: lowerWick(bar),
    rangePct: (bar.high - bar.low) / px,
    // VP geometry
    distVah,
    distVal,
    distPoc,
    vaWidth,
    pathPct: path?.distPct ?? null,
    pathKind: path?.kind ?? null,
    slPct,
    tpPct,
    rr: br?.rr ?? null,
    slReason: br?.slReason ?? null,
    tpReason: br?.tpReason ?? null,
    levelSrc: vp?.priorSession?.vah ? "has_prior" : "dev_only",
    // post-entry behavior clues
    retestedVah,
    maxFavor8,
    maxAdverse8,
    mfeCapture,
    maeVsSl,
  };
}

function summarizeCohort(rows, label) {
  if (!rows.length) return { label, n: 0 };
  const wins = rows.filter((r) => r.win);
  const losses = rows.filter((r) => !r.win);
  const num = (k) => rows.map((r) => r[k]);
  const feat = (k) => ({
    all: avg(num(k)),
    win: avg(wins.map((r) => r[k])),
    loss: avg(losses.map((r) => r[k])),
    p25: pct(num(k), 25),
    p75: pct(num(k), 75),
  });
  const byLoss = {};
  for (const r of rows) {
    const k = r.lossPat || r.exit || "?";
    if (!byLoss[k]) byLoss[k] = { n: 0, net: 0 };
    byLoss[k].n += 1;
    byLoss[k].net += r.pnl;
  }
  const bySession = {};
  for (const r of rows) {
    if (!bySession[r.session]) bySession[r.session] = { n: 0, net: 0, wins: 0 };
    bySession[r.session].n += 1;
    bySession[r.session].net += r.pnl;
    if (r.win) bySession[r.session].wins += 1;
  }
  return {
    label,
    n: rows.length,
    wr: (wins.length / rows.length) * 100,
    net: rows.reduce((s, r) => s + r.pnl, 0),
    avgMfe: avg(num("mfe")),
    avgMae: avg(num("mae")),
    avgBars: avg(num("bars")),
    pctRetestVah: (rows.filter((r) => r.retestedVah).length / rows.length) * 100,
    avgFavor8: avg(num("maxFavor8")),
    avgAdverse8: avg(num("maxAdverse8")),
    features: {
      prior5d: feat("prior5d"),
      prior20d: feat("prior20d"),
      prior60d: feat("prior60d"),
      prior4h: feat("prior4h"),
      htfSep: feat("htfSep"),
      adx: feat("adx"),
      atrPct: feat("atrPct"),
      rv1d: feat("rv1d"),
      rv5d: feat("rv5d"),
      volR: feat("volR"),
      body: feat("body"),
      closeStr: feat("closeStr"),
      upperWick: feat("upperWick"),
      pathPct: feat("pathPct"),
      vaWidth: feat("vaWidth"),
      distVah: feat("distVah"),
      distPoc: feat("distPoc"),
      slPct: feat("slPct"),
      tpPct: feat("tpPct"),
      rr: feat("rr"),
      rangePct: feat("rangePct"),
      slope5d: feat("slope5d"),
    },
    pctAboveEma20d: (rows.filter((r) => r.aboveEma20d).length / rows.length) * 100,
    pctHtfUp: (rows.filter((r) => r.htfUp).length / rows.length) * 100,
    pctHtfDown: (rows.filter((r) => r.htfDown).length / rows.length) * 100,
    byLoss,
    bySession,
  };
}

/** Interaction: which feature buckets flip expectancy between years? */
function bucketExpectancy(rows, key, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const subset = rows.filter((r) => Number.isFinite(r[key]) && r[key] >= lo && r[key] < hi);
    out.push({
      bucket: `[${lo}, ${hi})`,
      n: subset.length,
      net: subset.reduce((s, r) => s + r.pnl, 0),
      wr: subset.length ? (subset.filter((r) => r.win).length / subset.length) * 100 : 0,
      avgMfe: avg(subset.map((r) => r.mfe)),
      avgMae: avg(subset.map((r) => r.mae)),
      pctRetest: subset.length
        ? (subset.filter((r) => r.retestedVah).length / subset.length) * 100
        : 0,
    });
  }
  return out;
}

async function runWindow(tag, from, to) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  // NO buy-chase cut — we want the raw failure modes.
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    vpBuyChaseFilter: false,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
  };
  const padFrom = volumeProfilePadFromMs(fromMs, TF, cfg);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  if (!candles.length) throw new Error(`no candles ${tag}`);
  const pre = precomputeVolumeProfile(candles);
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const rows = [];
  for (const t of closed) {
    t._tag = tag;
    const f = attachFeatures(t, candles, pre, cfg);
    if (f) rows.push(f);
  }
  return { tag, rows, candles, pre, cfg };
}

const all = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  all[w.tag] = await runWindow(w.tag, w.from, w.to);
}

const report = { generatedAt: new Date().toISOString(), windows: {} };

for (const [tag, { rows }] of Object.entries(all)) {
  const vah = rows.filter((r) => r.setup === "vah_breakout" && r.side === "BUY");
  const val = rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL");
  const varejSell = rows.filter((r) => r.setup === "va_rejection" && r.side === "SELL");
  report.windows[tag] = {
    all: summarizeCohort(rows, `${tag} all`),
    vah_buy: summarizeCohort(vah, `${tag} VAH BUY`),
    val_sell: summarizeCohort(val, `${tag} VAL SELL`),
    va_rej_sell: summarizeCohort(varejSell, `${tag} VA_REJ SELL`),
    vah_by_prior5d: bucketExpectancy(vah, "prior5d", [-1, -0.05, 0, 0.04, 0.08, 0.15, 1]),
    vah_by_atr: bucketExpectancy(vah, "atrPct", [0, 0.004, 0.007, 0.01, 0.02, 1]),
    vah_by_path: bucketExpectancy(vah, "pathPct", [0, 0.003, 0.006, 0.01, 0.02, 1]),
    vah_by_rv1d: bucketExpectancy(vah, "rv1d", [0, 0.05, 0.08, 0.12, 0.2, 5]),
    vah_by_body: bucketExpectancy(vah, "body", [-1, 0.32, 0.45, 0.6, 0.8, 2]),
    vah_by_sl: bucketExpectancy(vah, "slPct", [0, 0.004, 0.007, 0.01, 0.015, 1]),
    vah_losers_retest: (() => {
      const L = vah.filter((r) => !r.win);
      return {
        n: L.length,
        pctRetest: L.length ? (L.filter((r) => r.retestedVah).length / L.length) * 100 : 0,
        avgFavor8: avg(L.map((r) => r.maxFavor8)),
        avgAdverse8: avg(L.map((r) => r.maxAdverse8)),
        avgMfe: avg(L.map((r) => r.mfe)),
        instant: L.filter((r) => r.lossPat === "INSTANT_SL").length,
        whipsaw: L.filter((r) => r.lossPat === "WHIPSAW_GAVE_BACK").length,
        fast: L.filter((r) => r.lossPat === "FAST_FAIL").length,
      };
    })(),
    varej_by_prior20d: bucketExpectancy(varejSell, "prior20d", [-1, -0.2, -0.1, -0.05, 0, 0.05, 1]),
    varej_by_upperWick: bucketExpectancy(varejSell, "upperWick", [0, 0.3, 0.45, 0.6, 1]),
  };
}

// Cross-year VAH winner/loser discrimination
const vahBad = all["2022-23"].rows.filter((r) => r.setup === "vah_breakout" && r.side === "BUY");
const vahGood = all["2025-26"].rows.filter((r) => r.setup === "vah_breakout" && r.side === "BUY");
function winLossSplit(rows) {
  return {
    winners: summarizeCohort(
      rows.filter((r) => r.win),
      "winners",
    ),
    losers: summarizeCohort(
      rows.filter((r) => !r.win),
      "losers",
    ),
  };
}
report.vah_winloss = {
  "2022-23": winLossSplit(vahBad),
  "2025-26": winLossSplit(vahGood),
};

// Counterfactual BEHAVIOR ideas (not cut): measure on 2022-23 VAH losers
const ideas = [];
{
  const vah = vahBad;
  // 1) Retest entry: if loser retested VAH in 8 bars, could have entered better / waited
  const L = vah.filter((r) => !r.win);
  ideas.push({
    idea: "retest_entry_opportunity",
    note: "% of VAH losers that pulled back to VAH within 8 bars after breakout (auction retest)",
    pct: L.length ? (L.filter((r) => r.retestedVah).length / L.length) * 100 : 0,
    nLosers: L.length,
  });
  // 2) MFE before SL — if avg MFE > 0.4% maybe trail/partial could salvage
  ideas.push({
    idea: "mfe_before_sl_on_losers",
    avgMfePct: avg(L.map((r) => r.mfe)),
    pctWithMfeOver0_4: L.length ? (L.filter((r) => r.mfe >= 0.4).length / L.length) * 100 : 0,
    pctWithMfeOver0_8: L.length ? (L.filter((r) => r.mfe >= 0.8).length / L.length) * 100 : 0,
  });
  // 3) SL too tight vs ATR: mae/atr
  const atrTight = L.filter((r) => r.atrPct > 0 && r.slPct > 0 && r.slPct < r.atrPct * 1.2);
  ideas.push({
    idea: "sl_tighter_than_1_2x_atr",
    pct: L.length ? (atrTight.length / L.length) * 100 : 0,
    n: atrTight.length,
  });
  // 4) High path but still lost = false breakout into HVN resistance quickly
  ideas.push({
    idea: "path_vs_outcome",
    lossAvgPath: avg(L.map((r) => r.pathPct)),
    winAvgPath: avg(vah.filter((r) => r.win).map((r) => r.pathPct)),
  });
}
report.behaviorClues = ideas;

const outPath = path.resolve(__dirname, ".vp-freq-eth-regime-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error("wrote", outPath);

await closePool?.();
