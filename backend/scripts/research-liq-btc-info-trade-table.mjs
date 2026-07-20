#!/usr/bin/env node
/**
 * BTC INTRADAY_PRO_LIQ_15M — per-trade table with all informational filters at entry.
 *
 * Usage: cd backend && node scripts/research-liq-btc-info-trade-table.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const TF = "15m";

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  ensureObservableData,
  loadObservableSeries,
  observableFeaturesAt,
} = await import("../src/backtest/data/observableFeatures.js");
const { passesLiqContextFilter } = await import("../src/backtest/engine/liqContextFilter.js");
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js",
);
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function liqLong(o) {
  return num(o?.coinalyze_liq_long_usd) ?? (num(o?.coinalyze_liq_24h_usd) != null ? o.coinalyze_liq_24h_usd * 0.5 : null);
}
function liqShort(o) {
  return num(o?.coinalyze_liq_short_usd) ?? (num(o?.coinalyze_liq_24h_usd) != null ? o.coinalyze_liq_24h_usd * 0.5 : null);
}
function fmtM(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}
function fmtPct(v, d = 2) {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`;
}
function fmtUsd(v) {
  return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}$${v.toFixed(0)}`;
}
function yn(v) {
  return v ? "Y" : "N";
}
function skipMark(skip) {
  return skip ? "**SKIP**" : "take";
}

/** skip=true → would block trade */
const INFO_FILTERS = {
  edge_v1: {
    label: "edge_v1 bundle",
    skip: (t, o) => !passesLiqContextFilter(t.isLong, o, "edge_v1"),
  },
  oi_drop3: {
    label: "Bybit OI −4h < −3%",
    skip: (t, o) => num(o.bybit_oi_change_4h) != null && o.bybit_oi_change_4h < -0.03,
  },
  oi_drop2: {
    label: "Bybit OI −4h < −2%",
    skip: (t, o) => num(o.bybit_oi_change_4h) != null && o.bybit_oi_change_4h < -0.02,
  },
  cz_long_after_short_liq: {
    label: "LONG: skip unless short_liq > long_liq",
    skip: (t, o) => {
      if (!t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      if (L == null || S == null) return false;
      return S <= L;
    },
  },
  cz_short_after_long_liq: {
    label: "SHORT: skip unless long_liq > short_liq",
    skip: (t, o) => {
      if (t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      if (L == null || S == null) return false;
      return L <= S;
    },
  },
  fund_long_neg_z: {
    label: "LONG: skip if funding z ≥ 0",
    skip: (t, o) => t.isLong && num(o.binance_funding_zscore) != null && o.binance_funding_zscore >= 0,
  },
  fund_short_pos_z: {
    label: "SHORT: skip if funding z ≤ 0",
    skip: (t, o) => !t.isLong && num(o.binance_funding_zscore) != null && o.binance_funding_zscore <= 0,
  },
  cz_liq_day_30m: {
    label: "Skip if prior-day liq > $30M",
    skip: (t, o) => num(o.coinalyze_liq_24h_usd) != null && o.coinalyze_liq_24h_usd > 30_000_000,
  },
  breakdown_day_long: {
    label: "LONG PDL: skip on breakdown day",
    skip: (t) => t.isLong && t.levelType === "pdl" && t.breakdownDay,
  },
  breakout_day_short: {
    label: "SHORT PDH: skip on breakout day",
    skip: (t) => !t.isLong && t.levelType === "pdh" && t.breakoutDay,
  },
};

await ensureObservableData(SYMBOL, fromMs, toMs);
const loaded = await loadObservableSeries(SYMBOL, fromMs, toMs);
const obsAt = (ts) =>
  observableFeaturesAt({ binance: loaded.binance, bybit: loaded.bybit, coinalyze: loaded.coinalyze }, ts);

const warmup = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - warmup, toMs, { market: "futures" });
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs - warmup, toMs);
} catch {
  funding = [];
}

clearIntradayAdapterCache();
let cfg = materializeIntradayEngineCfgSync(
  { ...INTRADAY_PRO_LIQ_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: 2 },
  materializeIntradayPanelOnCfg,
);
cfg = mergeAdaptiveCfg(cfg, candles);
const pre = precomputeIntraday(candles);

const sim = await runSimulation({
  strategyKey: "SR_INTRADAY",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: funding,
  startingUsdt: 10_000,
  timeframe: TF,
  symbol: SYMBOL,
  adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
});

const closed = (sim.trades || []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");

function barIdx(ts) {
  let idx = candles.findIndex((c) => c.ts === ts);
  if (idx < 0) {
    idx = candles.findIndex((c) => c.ts > ts);
    if (idx > 0) idx--;
  }
  return idx;
}

const rows = [];
for (const trade of closed) {
  const idx = barIdx(trade.entryTs);
  const obs = obsAt(trade.entryTs);
  const isLong = trade.direction === "BUY";
  const liq = trade.liqContext ?? {};
  const pnl = Number(trade.netPnl ?? 0);
  const L = liqLong(obs);
  const S = liqShort(obs);
  const base = {
    date: new Date(trade.entryTs).toISOString().slice(0, 16).replace("T", " "),
    side: isLong ? "LONG" : "SHORT",
    level: liq.levelType ?? "?",
    pnl,
    win: pnl > 0,
    exit: trade.exitReason ?? "?",
    mfe: fmtPct(trade.mfePct),
    isLong,
    levelType: liq.levelType ?? "?",
    breakdownDay: idx >= 0 ? isBreakdownDay(candles, idx, pre) : false,
    breakoutDay: idx >= 0 ? isBreakoutDay(candles, idx, pre) : false,
    bybitOi4h: num(obs?.bybit_oi_change_4h),
    fundZ: num(obs?.binance_funding_zscore),
    czLiq24h: num(obs?.coinalyze_liq_24h_usd),
    czLong: L,
    czShort: S,
    liqBias: L != null && S != null ? (S > L ? "short>long" : L > S ? "long>short" : "equal") : "—",
  };
  const filters = {};
  for (const [id, f] of Object.entries(INFO_FILTERS)) {
    filters[id] = f.skip(base, obs);
  }
  rows.push({ ...base, filters, obs });
}

// Filter efficacy summary
const filterStats = {};
for (const [id, meta] of Object.entries(INFO_FILTERS)) {
  const blocked = rows.filter((r) => r.filters[id]);
  const blockedW = blocked.filter((r) => r.win);
  const blockedL = blocked.filter((r) => !r.win);
  const kept = rows.filter((r) => !r.filters[id]);
  const keptPnl = kept.reduce((s, r) => s + r.pnl, 0);
  const removedPnl = blocked.reduce((s, r) => s + r.pnl, 0);
  filterStats[id] = {
    label: meta.label,
    blocked: blocked.length,
    blockedW: blockedW.length,
    blockedL: blockedL.length,
    kept: kept.length,
    keptPnl,
    removedPnl,
    keptWr: kept.length ? (kept.filter((r) => r.win).length / kept.length) * 100 : 0,
    netHelp: removedPnl < 0 && blockedL > blockedW,
  };
}

const md = [
  `# ${SYMBOL} LIQ trades — informational filters at entry`,
  "",
  `**Preset:** INTRADAY_PRO_LIQ_15M | **Window:** ${FROM} → ${TO} | **Trades:** ${rows.length}`,
  "",
  "## Per-trade table",
  "",
  "| # | Date (UTC) | Side | Level | PnL | Win | Exit | MFE | OI−4h | FundZ | CZ liq24h | L>S? | edge_v1 | oi−3% | cz long rule | fund−z | breakdown |",
  "|---|------------|------|-------|-----|-----|------|-----|-------|-------|-----------|------|---------|-------|--------------|--------|-----------|",
];

rows.forEach((r, i) => {
  md.push(
    `| ${i + 1} | ${r.date} | ${r.side} | ${r.level} | ${fmtUsd(r.pnl)} | ${yn(r.win)} | ${r.exit} | ${r.mfe} | ${fmtPct(r.bybitOi4h)} | ${r.fundZ?.toFixed(2) ?? "—"} | ${fmtM(r.czLiq24h)} | ${r.liqBias} | ${skipMark(r.filters.edge_v1)} | ${skipMark(r.filters.oi_drop3)} | ${skipMark(r.filters.cz_long_after_short_liq)} | ${skipMark(r.filters.fund_long_neg_z)} | ${skipMark(r.filters.breakdown_day_long)} |`,
  );
});

md.push(
  "",
  "## Filter summary (would this filter have helped?)",
  "",
  "| Filter | Blocked | W removed | L removed | Kept | Kept PnL | Removed PnL | Kept WR% | Helps? |",
  "|--------|---------|-----------|-----------|------|----------|-------------|----------|--------|",
);

const sorted = Object.entries(filterStats).sort((a, b) => {
  const score = (s) => (s.netHelp ? 1000 : 0) + s.removedPnl * -1 + s.keptWr;
  return score(b[1]) - score(a[1]);
});

for (const [id, s] of sorted) {
  const helps =
    s.blocked === 0
      ? "no effect"
      : s.removedPnl < 0 && s.blockedL >= s.blockedW
        ? s.keptPnl > rows.reduce((a, r) => a + r.pnl, 0)
          ? "**YES**"
          : "partial"
        : "no / hurts";
  md.push(
    `| ${s.label} | ${s.blocked} | ${s.blockedW} | ${s.blockedL} | ${s.kept} | ${fmtUsd(s.keptPnl)} | ${fmtUsd(s.removedPnl)} | ${s.keptWr.toFixed(0)}% | ${helps} |`,
  );
}

const OUT_MD = path.join(__dirname, ".research-liq-btc-info-trade-table.md");
const OUT_JSON = path.join(__dirname, ".research-liq-btc-info-trade-table.json");
fs.writeFileSync(OUT_MD, md.join("\n"));
fs.writeFileSync(
  OUT_JSON,
  JSON.stringify({ symbol: SYMBOL, from: FROM, to: TO, rows, filterStats }, null, 2),
);

console.log(md.join("\n"));
console.log(`\nWrote ${OUT_MD}`);

await closePool();
