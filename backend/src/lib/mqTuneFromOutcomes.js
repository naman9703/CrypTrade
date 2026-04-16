/**
 * Derive suggested Move Quality config from mq-trade-outcomes.jsonl (same rows as scripts/analyze-mq-trades.mjs).
 * Uses the p-th percentile of **winning** trades per metric as a practical floor (captures typical winners without chasing extremes).
 */
import fs from "fs";
import path from "path";
import { clamp } from "./math.js";
import { resolveModeDataRootDir } from "./tradingModePersistence.js";

/**
 * @param {string} persistenceSlug
 * @returns {{ path: string, rows: object[] }}
 */
export function readMqTradeOutcomeRows(persistenceSlug) {
  const slug =
    persistenceSlug != null && String(persistenceSlug).trim() ? String(persistenceSlug).trim() : "paper";
  const filePath = path.join(resolveModeDataRootDir(), slug, "mq-trade-outcomes.jsonl");
  if (!fs.existsSync(filePath)) {
    return { path: filePath, rows: [] };
  }
  const txt = fs.readFileSync(filePath, "utf8");
  const rows = [];
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      /* skip */
    }
  }
  return { path: filePath, rows: rows.filter((r) => r && typeof r === "object") };
}

function percentileLinear(vals, p) {
  const a = vals.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (p / 100) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(a.length - 1, Math.ceil(pos));
  const w = pos - lo;
  if (hi <= lo) return a[lo];
  return a[lo] * (1 - w) + a[hi] * w;
}

/**
 * @param {object[]} rows
 * @param {{ minTrades?: number, winPercentileFloor?: number }} [opts]
 */
export function computeMqTuningPatch(rows, opts = {}) {
  const minTrades = opts.minTrades ?? 8;
  const pFloor = clamp(Number(opts.winPercentileFloor ?? 35), 5, 50);

  if (rows.length < minTrades) {
    return {
      ok: false,
      error: "insufficient_trades",
      n: rows.length,
      minTrades,
      message: `Need at least ${minTrades} logged Supertrend closes with MQ data (currently ${rows.length}).`,
    };
  }

  const wins = rows.filter(
    (t) => String(t.outcome || "").toUpperCase() === "WIN" || (Number.isFinite(Number(t.pnl)) && Number(t.pnl) > 0),
  );
  if (wins.length < 3) {
    return {
      ok: false,
      error: "insufficient_wins",
      n: rows.length,
      nWins: wins.length,
      message: `Need at least 3 winning trades for tuning (currently ${wins.length} wins).`,
    };
  }

  const g = (key) => percentileLinear(
    wins.map((w) => Number(w[key])),
    pFloor,
  );

  const patch = {
    supertrendMoveQualityMinScore: clamp(g("mqScore") ?? 0.55, 0.35, 0.82),
    supertrendMoveQualityMinAdx: Math.round(clamp(g("adx") ?? 20, 15, 40)),
    supertrendMoveQualityMinMoveSlRatio: clamp(g("moveVsSL") ?? 1.4, 1.05, 2.8),
    supertrendMoveQualityMinAtrExpansion: clamp(g("atrExpand") ?? 1.05, 1.0, 1.25),
    supertrendMoveQualityMinBodyVsAvg: clamp(g("bodyRatio") ?? 0.55, 0.45, 0.85),
  };

  return {
    ok: true,
    n: rows.length,
    nWins: wins.length,
    winPercentileFloor: pFloor,
    patch,
    message: `Tuned from ${rows.length} closes (${wins.length} wins): floors ≈ ${pFloor}th percentile of winner metrics.`,
  };
}
