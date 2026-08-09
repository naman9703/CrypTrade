#!/usr/bin/env node
/**
 * Offline Supertrend XGB train from exported backtest trade CSV.
 * Usage: node scripts/research-supertrend-xgb-from-csv.mjs [path-to-csv]
 *
 * Writes meta JSON under scripts/.research-decisions/ and trains model into
 * ai-service MODEL_DIR (default ai-service/data/model).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSupertrendXgbFeatures,
  labelTradeRrPositive,
} from "../src/strategy/supertrendXgbFeatures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DEFAULT_CSV = resolve(
  process.env.HOME || "",
  "Downloads/backtest-7b7d8123-trades (3).csv",
);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 3) continue;
    const o = {};
    for (let j = 0; j < headers.length; j++) o[headers[j]] = cols[j] ?? "";
    rows.push(o);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
      continue;
    }
    if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseIstEntryTs(s) {
  // "2024-01-15 10:30:00 IST" or ISO-ish
  const t = String(s || "").replace(/\s+IST$/i, "").trim();
  if (!t) return NaN;
  // Treat as IST = UTC+5:30
  const ms = Date.parse(t.replace(" ", "T") + "+05:30");
  return Number.isFinite(ms) ? ms : Date.parse(t);
}

function main() {
  const csvPath = resolve(process.argv[2] || DEFAULT_CSV);
  const raw = readFileSync(csvPath, "utf8");
  const csvRows = parseCsv(raw);
  const rows = [];
  for (const r of csvRows) {
    const rr = Number(r.RR);
    const label = labelTradeRrPositive({ rr, netPnl: Number(r.Net) });
    if (label == null) continue;
    const entryTs = parseIstEntryTs(r["Entry (IST)"]);
    if (!Number.isFinite(entryTs)) continue;
    const feats = encodeSupertrendXgbFeatures(
      {
        atr14Pct: r["ATR14 %"],
        atrPercentile: r["ATR percentile (100)"],
        adx14: r.ADX14,
        rsi14: r.RSI14,
        distToEma20Pct: r["Dist to EMA20 %"],
        distToEma50Pct: r["Dist to EMA50 %"],
        distToEma200Pct: r["Dist to EMA200 %"],
        emaStack: r["EMA stack"],
        volVsAvg20: r["Volume vs 20-avg"],
        bodyPct: r["Body %"],
        upperWickPct: r["Upper wick %"],
        lowerWickPct: r["Lower wick %"],
        distToSwingHighPct: r["Dist to swing high %"],
        distToSwingLowPct: r["Dist to swing low %"],
        entryHourUtc: r["Entry hour (UTC)"],
        entryWeekday: r["Entry weekday"],
        session: r.Session,
      },
      r.Side,
    );
    rows.push({
      entry_ts: entryTs,
      features: feats,
      label,
      rr: Number.isFinite(rr) ? rr : label === 1 ? 1 : -1,
    });
  }
  if (rows.length < 40) {
    console.error(JSON.stringify({ ok: false, error: "need_at_least_40", n: rows.length }));
    process.exit(1);
  }

  const payloadPath = join(__dirname, ".tmp-st-xgb-rows.json");
  writeFileSync(payloadPath, JSON.stringify(rows));
  const modelDir = join(ROOT, "ai-service/data/model");
  mkdirSync(modelDir, { recursive: true });

  const py = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, "ai-service"))})
os.environ["MODEL_DIR"] = ${JSON.stringify(modelDir)}
from scripts.train_supertrend_xgb import train_supertrend_from_trades
rows = json.load(open(${JSON.stringify(payloadPath)}))
meta = train_supertrend_from_trades(
    rows,
    source_run_id="7b7d8123",
    symbol="BTCUSDT",
    timeframe="15m",
)
print(json.dumps(meta))
`;
  const res = spawnSync("python3", ["-c", py], {
    encoding: "utf8",
    cwd: join(ROOT, "ai-service"),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status || 1);
  }
  const meta = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop());
  const outDir = join(__dirname, ".research-decisions");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "2026-08-02-supertrend-xgb-gate.md");
  const oos = meta.splits?.oos || {};
  const base = meta.baseline_splits?.oos || {};
  const md = `# Supertrend XGB gate — first train (CSV 7b7d8123)

**Date:** 2026-08-02  
**Source:** \`${csvPath}\` (${rows.length} labeled rows, RR>0 label)  
**Artifact:** \`ai-service/data/model/supertrend_xgb.pkl\`  
**Model:** ${meta.model_kind} · threshold **${meta.threshold}**

## Splits (time-ordered 60/20/20)

| Split | Baseline n | Gated kept | keep_frac | WR | mean R | PF |
|-------|------------|------------|-----------|----|--------|-----|
| OOS | ${base.n} | ${oos.kept} | ${oos.keep_frac?.toFixed?.(3) ?? oos.keep_frac} | ${oos.wr?.toFixed?.(3) ?? oos.wr} | ${oos.mean_r?.toFixed?.(3) ?? oos.mean_r} | ${oos.pf?.toFixed?.(3) ?? oos.pf} |

## Gates

- freq_ok_val (≥50% keep on val): **${meta.freq_ok_val}**
- oos_pf_ge_1: **${meta.oos_pf_ge_1}**
- oos_mean_r_positive: **${meta.oos_mean_r_positive}**

## Top importance

${(meta.feature_importance || [])
  .slice(0, 8)
  .map((x) => `- ${x.feature}: ${Number(x.importance).toFixed(4)}`)
  .join("\n") || "- (none)"}

## Verdict

Trade-level A/B (gated vs all flips on OOS holdout) is logged above.  
**Full sim A/B** (Apply gate & re-backtest in panel) still required with Docker/DB up — harvest metrics alone are not deploy language.

Promote language only if full-sim OOS ret>0, PF≥1, n≥30, and frequency ≥50% of baseline (target ≥2/wk when window allows).

Live gate: **blocked** until those gates pass.
`;
  writeFileSync(outPath, md);
  console.log(JSON.stringify({ ok: true, n: rows.length, meta, decisionLog: outPath }, null, 2));
}

main();
