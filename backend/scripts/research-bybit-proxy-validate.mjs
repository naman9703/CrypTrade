#!/usr/bin/env node
/**
 * Proxy validation — Bybit OI vs Binance OI on overlapping history (~30d).
 *
 * Usage: cd backend && npm run research:bybit:proxy-validate
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const COINS = (process.argv.find((a, i) => process.argv[i - 1] === "--coins") || "BTCUSDT,BNBUSDT,ETHUSDT,SOLUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim());

const DAYS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--days") || 28);
const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 60 * 60 * 1000;

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureOpenInterest, readOpenInterest } = await import("../src/backtest/data/openInterestIngest.js");
const { ensureBybitOpenInterest, readBybitOpenInterest } = await import("../src/backtest/data/bybitMarketIngest.js");
const { nearestBefore } = await import("../src/backtest/data/l2Features.js");
const { pearson, spearman } = await import("./lib/liqResearchStats.js");
const { sourceFidelityToMarkdown } = await import("./lib/sourceFidelity.js");

function alignSeries(binance, bybit) {
  const pairs = [];
  for (const b of binance) {
    const y = nearestBefore(bybit, b.ts, "ts");
    if (!y?.oiUsdt || !b.oiUsdt) continue;
    pairs.push({ ts: b.ts, binance: b.oiUsdt, bybit: y.oiUsdt });
  }
  return pairs;
}

function pctChange(series, i, lookback = 4) {
  const j = i - lookback;
  if (j < 0) return null;
  const a = series[j];
  const b = series[i];
  if (!(a > 0) || !(b > 0)) return null;
  return (b - a) / a;
}

function analyzePairs(pairs) {
  if (pairs.length < 12) {
    return { n: pairs.length, error: "insufficient_overlap" };
  }
  const bx = pairs.map((p) => p.binance);
  const by = pairs.map((p) => p.bybit);
  const pearsonOi = pearson(bx, by);
  const spearmanOi = spearman(bx, by);
  const bChg = [];
  const yChg = [];
  for (let i = 4; i < pairs.length; i++) {
    const bc = pctChange(bx, i);
    const yc = pctChange(by, i);
    if (bc != null && yc != null) {
      bChg.push(bc);
      yChg.push(yc);
    }
  }
  let sameDir = 0;
  for (let i = 0; i < bChg.length; i++) {
    if (Math.sign(bChg[i]) === Math.sign(yChg[i])) sameDir += 1;
  }
  const sameDirection4hPct = bChg.length ? (sameDir / bChg.length) * 100 : null;
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const bMed = median(bx);
  const yMed = median(by);
  let regimeAgree = 0;
  for (const p of pairs) {
    const bHi = p.binance >= bMed;
    const yHi = p.bybit >= yMed;
    if (bHi === yHi) regimeAgree += 1;
  }
  const regimeAgreePct = (regimeAgree / pairs.length) * 100;
  return {
    n: pairs.length,
    pearsonOi,
    spearmanOi,
    sameDirection4hPct,
    regimeAgreePct,
    credibleProxy: pearsonOi != null && pearsonOi >= 0.7,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  windowDays: DAYS,
  fromMs,
  toMs,
  coins: {},
};

for (const symbol of COINS) {
  process.stdout.write(`Proxy validate ${symbol}...\n`);
  await ensureOpenInterest(symbol, { from: fromMs, to: toMs, period: "1h" }).catch(() => {});
  await ensureBybitOpenInterest(symbol, { from: fromMs, to: toMs, intervalTime: "1h" }).catch(() => {});
  const [binance, bybit] = await Promise.all([
    readOpenInterest(symbol, fromMs, toMs),
    readBybitOpenInterest(symbol, fromMs, toMs, "1h"),
  ]);
  const pairs = alignSeries(binance, bybit);
  report.coins[symbol] = analyzePairs(pairs);
}

const OUT_JSON = path.join(__dirname, ".research-bybit-proxy-validation.json");
const OUT_MD = path.join(__dirname, ".research-bybit-proxy-validation.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
const md = sourceFidelityToMarkdown(report);
fs.writeFileSync(OUT_MD, md);
console.log(md);
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
