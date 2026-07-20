#!/usr/bin/env node
/**
 * Liquidity sweep + informational data edge test (Coinalyze liq, Bybit OI, funding).
 *
 * Usage: cd backend && node scripts/research-liq-liquidity-data-edge.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const HOLDOUT_FRAC = Number(process.env.HOLDOUT_FRAC || 0.25);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  ensureObservableData,
  loadObservableSeries,
  observableFeaturesAt,
} = await import("../src/backtest/data/observableFeatures.js");
const { INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { harvestLiqCandidates } = await import("../src/strategy/techniques/liq/candidateHarvest.js");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function liqLong(o) {
  return num(o.coinalyze_liq_long_usd) ?? num(o.coinalyze_liq_24h_usd) * 0.5;
}
function liqShort(o) {
  return num(o.coinalyze_liq_short_usd) ?? num(o.coinalyze_liq_24h_usd) * 0.5;
}

/** Skip = true means do NOT take the trade */
const LIQ_RULES = {
  baseline: { label: "Always take (no filter)", fn: () => false },

  // Coinalyze — regime / chaos
  cz_skip_liq_day_15m: {
    label: "Skip if prior-day total liq > $15M",
    fn: (t, o) => num(o.coinalyze_liq_24h_usd) != null && o.coinalyze_liq_24h_usd > 15_000_000,
  },
  cz_skip_liq_day_30m: {
    label: "Skip if prior-day total liq > $30M",
    fn: (t, o) => num(o.coinalyze_liq_24h_usd) != null && o.coinalyze_liq_24h_usd > 30_000_000,
  },
  cz_skip_liq_day_50m: {
    label: "Skip if prior-day total liq > $50M",
    fn: (t, o) => num(o.coinalyze_liq_24h_usd) != null && o.coinalyze_liq_24h_usd > 50_000_000,
  },

  // Directional liquidation context (sweep thesis)
  cz_skip_long_after_long_liq: {
    label: "Skip LONG if prior-day long liq > short liq × 1.5",
    fn: (t, o) => {
      if (!t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      return L != null && S != null && L > S * 1.5;
    },
  },
  cz_favor_long_after_short_liq: {
    label: "Skip LONG unless prior-day short liq > long liq (shorts wiped)",
    fn: (t, o) => {
      if (!t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      if (L == null || S == null) return false;
      return S <= L;
    },
  },
  cz_skip_short_after_short_liq: {
    label: "Skip SHORT if prior-day short liq > long liq × 1.5",
    fn: (t, o) => {
      if (t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      return L != null && S != null && S > L * 1.5;
    },
  },
  cz_favor_short_after_long_liq: {
    label: "Skip SHORT unless prior-day long liq > short liq",
    fn: (t, o) => {
      if (t.isLong) return false;
      const L = liqLong(o);
      const S = liqShort(o);
      if (L == null || S == null) return false;
      return L <= S;
    },
  },

  // Bybit OI cascade proxy
  by_oi_drop2: {
    label: "Skip if Bybit OI −4h < −2%",
    fn: (t, o) => num(o.bybit_oi_change_4h) != null && o.bybit_oi_change_4h < -0.02,
  },
  by_oi_drop3: {
    label: "Skip if Bybit OI −4h < −3%",
    fn: (t, o) => num(o.bybit_oi_change_4h) != null && o.bybit_oi_change_4h < -0.03,
  },

  // Funding (LIQ long bias)
  fund_favor_long_neg: {
    label: "Skip LONG unless funding z < 0",
    fn: (t, o) => t.isLong && num(o.binance_funding_zscore) != null && o.binance_funding_zscore >= 0,
  },

  // Combos
  combo_cz_oi: {
    label: "Skip high liq day (30M) OR Bybit OI drop 3%",
    fn: (t, o) => LIQ_RULES.cz_skip_liq_day_30m.fn(t, o) || LIQ_RULES.by_oi_drop3.fn(t, o),
  },
  combo_sweep_long: {
    label: "Skip LONG: long-liq dominant OR no short-liq lead",
    fn: (t, o) =>
      LIQ_RULES.cz_skip_long_after_long_liq.fn(t, o) || LIQ_RULES.cz_favor_long_after_short_liq.fn(t, o),
  },
};

function metrics(rows) {
  const n = rows.length;
  if (!n) return { n: 0, winRate: 0, meanR: 0, sumR: 0, pf: 0 };
  const wins = rows.filter((t) => t.win).length;
  const sumR = rows.reduce((s, t) => s + t.R, 0);
  const gw = rows.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const gl = Math.abs(rows.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  return { n, winRate: (wins / n) * 100, meanR: sumR / n, sumR, pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0 };
}

function evaluateRules(trades, sliceFrom, sliceTo) {
  const window = trades.filter((t) => t.entryTs >= sliceFrom && t.entryTs < sliceTo);
  const base = metrics(window);
  const out = { baseline: { ...base, kept: base }, rules: [] };

  for (const [id, rule] of Object.entries(LIQ_RULES)) {
    if (id === "baseline") continue;
    const kept = [];
    const skipped = [];
    for (const t of window) {
      (rule.fn(t, t.obs) ? skipped : kept).push(t);
    }
    const mk = metrics(kept);
    const ms = metrics(skipped);
    out.rules.push({
      id,
      label: rule.label,
      skipPct: window.length ? (skipped.length / window.length) * 100 : 0,
      kept: mk,
      skipped: ms,
      wrDelta: mk.winRate - base.winRate,
      meanRDelta: mk.meanR - base.meanR,
      skippedWorse: ms.n === 0 || ms.meanR < mk.meanR,
      pass:
        mk.n >= Math.max(5, window.length * 0.35) &&
        mk.meanR > base.meanR &&
        mk.winRate >= base.winRate - 2 &&
        (skipped.length === 0 || ms.meanR < mk.meanR),
    });
  }
  out.rules.sort((a, b) => b.meanRDelta - a.meanRDelta);
  return { window, base, ...out };
}

async function harvestCoin(sym) {
  process.stdout.write(`  sync ${sym}...\n`);
  await ensureObservableData(sym, fromMs, toMs);
  const series = await loadObservableSeries(sym, fromMs, toMs);
  const obsSeries = { binance: series.binance, bybit: series.bybit, coinalyze: series.coinalyze };
  const candles = await readCandles(sym, "15m", fromMs, toMs, { market: "futures" });
  if (!candles?.length) return [];
  const cfg = mergeAdaptiveCfg(
    materializeIntradayEngineCfgSync(
      { ...INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, symbol: sym, timeframe: "15m" },
      materializeIntradayPanelOnCfg,
    ),
    candles,
  );
  const pre = precomputeIntraday(candles);
  const rows = harvestLiqCandidates(candles, pre, { ...cfg, symbol: sym, observableSeries: obsSeries });
  return rows
    .filter((r) => r.selectedByDayPicker === 1)
    .map((r) => {
      const entryTs = Number(r.entryTs);
      const R = Number(r.endCloseR ?? r.fwd_closeR_20);
      if (!Number.isFinite(R)) return null;
      const obs = observableFeaturesAt(obsSeries, entryTs);
      return {
        symbol: sym,
        entryTs,
        isLong: r.side === "BUY",
        side: r.side,
        R,
        win: R > 0,
        obs,
        hasCzLiq: obs.coinalyze_has_liq === 1,
      };
    })
    .filter(Boolean);
}

console.log(`\n=== LIQ Sweep × Liquidity Data Edge ===`);
console.log(`${FROM} → ${TO} | ${COINS.join(", ")} | holdout from ${new Date(holdoutMs).toISOString().slice(0, 10)}\n`);

const perCoin = {};
const allTrades = [];
for (const sym of COINS) {
  const trades = await harvestCoin(sym);
  perCoin[sym] = trades;
  allTrades.push(...trades);
  const cov = trades.length
    ? (trades.filter((t) => t.hasCzLiq).length / trades.length) * 100
    : 0;
  console.log(`${sym}: ${trades.length} day-picked setups | Coinalyze liq cov ${cov.toFixed(0)}%`);
}

const pooledTrain = evaluateRules(allTrades, fromMs, holdoutMs);
const pooledHold = evaluateRules(allTrades, holdoutMs, toMs);

const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(d));

function table(title, ev) {
  const b = ev.base;
  const lines = [
    `### ${title}`,
    "",
    `Setups: ${ev.window.length} | Baseline WR **${fmt(b.winRate)}%** | meanR **${fmt(b.meanR, 3)}** | PF **${fmt(b.pf, 2)}**`,
    "",
    "| Rule | Skip% | Kept | WR% | ΔWR | meanR | ΔmeanR | Skip meanR | Pass |",
    "|------|-------|------|-----|-----|-------|--------|------------|------|",
  ];
  for (const r of ev.rules) {
    lines.push(
      `| ${r.id} | ${fmt(r.skipPct, 0)}% | ${r.kept.n} | ${fmt(r.kept.winRate)} | ${fmt(r.wrDelta, 1)} | ${fmt(r.kept.meanR, 3)} | ${fmt(r.meanRDelta, 3)} | ${fmt(r.skipped.meanR, 3)} | ${r.pass ? "✅" : "❌"} |`,
    );
  }
  const winners = ev.rules.filter((r) => r.pass);
  lines.push("", winners.length ? `**Pass:** ${winners.map((w) => w.id).join(", ")}` : "**Pass:** none");
  return lines.join("\n");
}

const md = [
  "# LIQ Sweep × Liquidity Data Edge",
  "",
  `Window: ${FROM} → ${TO} | Coins: ${COINS.join(", ")}`,
  "",
  "Coinalyze = daily aggregated liquidations. Bybit OI = 15m cascade proxy.",
  "",
  "## Pooled (all coins)",
  "",
  table("Train (first 75%)", pooledTrain),
  "",
  table("Holdout (last 25%)", pooledHold),
  "",
  "## Per coin (holdout)",
  "",
];

for (const sym of COINS) {
  const h = evaluateRules(perCoin[sym], holdoutMs, toMs);
  md.push(`**${sym}** — ${h.window.length} holdout setups | baseline WR ${fmt(h.base.winRate)}% meanR ${fmt(h.base.meanR, 3)}`);
  const w = h.rules.filter((r) => r.pass);
  md.push(w.length ? `Pass: ${w.map((x) => `${x.id} (WR ${fmt(x.kept.winRate)}%, meanR ${fmt(x.kept.meanR, 3)})`).join("; ")}` : "Pass: none");
  md.push("");
}

const report = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  coins: COINS,
  holdoutFrom: new Date(holdoutMs).toISOString().slice(0, 10),
  totals: { setups: allTrades.length, perCoin: Object.fromEntries(COINS.map((s) => [s, perCoin[s].length])) },
  pooled: { train: pooledTrain, holdout: pooledHold },
  holdoutWinners: pooledHold.rules.filter((r) => r.pass).map((r) => r.id),
};

const OUT_JSON = path.join(__dirname, ".research-liq-liquidity-data-edge.json");
const OUT_MD = path.join(__dirname, ".research-liq-liquidity-data-edge.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, md.join("\n"));
console.log("\n" + md.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
