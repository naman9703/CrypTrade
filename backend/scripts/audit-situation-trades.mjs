#!/usr/bin/env node
/**
 * Trade-by-trade autopsy for SITUATION_INTRADAY losses.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);
const START_USDT = Number(process.env.START_USDT || 100);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildSituationIntradayBacktestAdapter } = await import("../src/strategy/situationIntraday.js");
const { BNB_SITUATION_ROUTER_15M } = await import("../src/strategy/presets/bnbSituationRouter.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { dayStartIndex } = await import("../src/strategy/techniques/liquidity.js");
const { aggregateSituationEntries, tradeLegReturnPct } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
// Match UI backtest worker: exact run window only.
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
const pre = precomputeIntraday(candles);

const sitCfg = { ...BNB_SITUATION_ROUTER_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: RISK };
const STRAT = "SITUATION_INTRADAY";
const adapter = buildSituationIntradayBacktestAdapter(candles, sitCfg, TF);
const sim = await runSimulation({
  candles,
  strategyKey: STRAT,
  cfg: { ...sitCfg, symbol: SYMBOL },
  gateMode: "off",
  fundingRates: [],
  startingUsdt: START_USDT,
  timeframe: TF,
  adapters: { [STRAT]: adapter },
  symbol: SYMBOL,
  costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
});

const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });

function barIdx(ts) {
  return candles.findIndex((c) => c.ts === ts);
}

function dayRangePct(idx) {
  const dayStart = dayStartIndex(candles, idx);
  const dayOpen = candles[dayStart]?.open ?? candles[idx].open;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = dayStart; j <= idx; j++) {
    hi = Math.max(hi, candles[j].high);
    lo = Math.min(lo, candles[j].low);
  }
  return dayOpen > 0 ? (hi - lo) / dayOpen : 0;
}

const entries = new Map();
for (const t of sim.trades.filter((tr) => tr.entryTs >= fromMs && tr.entryTs < toMs)) {
  const k = `${t.entryTs}_${t.direction}`;
  if (!entries.has(k)) {
    const idx = barIdx(t.entryTs);
    const bar = candles[idx];
    entries.set(k, {
      ts: t.entryTs,
      utc: new Date(t.entryTs).toISOString().slice(0, 16),
      month: new Date(t.entryTs).toISOString().slice(0, 7),
      dir: t.direction,
      pnlPct: 0,
      pnlUsdt: 0,
      situation: t.situation || "?",
      trigger: t.trigger || t.entryReason || "?",
      adx: pre.adxSeries[idx],
      rsi: pre.rsiSeries[idx],
      htfDown: pre.htfDown[idx],
      htfUp: pre.htfUp[idx],
      dayRangePct: dayRangePct(idx),
      pdl: pre.prevDayLow[idx],
      pdh: pre.prevDayHigh[idx],
      close: bar?.close,
      exits: [],
    });
  }
  const e = entries.get(k);
  e.pnlUsdt += Number(t.netPnl);
  e.pnlPct += tradeLegReturnPct(t);
  e.exits.push(t.exitReason);
}

const list = [...entries.values()].sort((a, b) => a.ts - b.ts);
const losses = list.filter((t) => t.pnlPct < 0).sort((a, b) => a.pnlPct - b.pnlPct);
const wins = list.filter((t) => t.pnlPct > 0);

console.log(`\n=== SITUATION TRADE AUTOPSY ${FROM} → ${TO} ===`);
console.log(`Total entries: ${list.length} | Wins: ${wins.length} | Losses: ${losses.length}`);
console.log(`Net: ${(m.totalReturnPct ?? 0) >= 0 ? "+" : ""}${(m.totalReturnPct ?? 0).toFixed(2)}% (equity, start $${START_USDT})`);

const byTrigger = {};
for (const t of list) {
  const k = t.trigger;
  if (!byTrigger[k]) byTrigger[k] = { n: 0, wins: 0, net: 0, losses: [] };
  byTrigger[k].n++;
  byTrigger[k].net += t.pnlPct;
  if (t.pnlPct > 0) byTrigger[k].wins++;
  if (t.pnlPct < 0) byTrigger[k].losses.push(t);
}

console.log("\n--- By trigger ---");
for (const [k, v] of Object.entries(byTrigger).sort((a, b) => a[1].net - b[1].net)) {
  console.log(
    `  ${k}: n=${v.n} wr=${((v.wins / v.n) * 100).toFixed(0)}% net=${v.net >= 0 ? "+" : ""}${v.net.toFixed(2)}% losses=${v.losses.length}`,
  );
}

console.log("\n--- All losses (sorted by magnitude) ---");
for (const t of losses) {
  console.log(
    `  ${t.utc} ${t.dir} ${t.pnlPct.toFixed(2)}% | ${t.situation}/${t.trigger} | exit=${t.exits.join("+")} | dayRange=${(t.dayRangePct * 100).toFixed(1)}% adx=${t.adx?.toFixed(0)} rsi=${t.rsi?.toFixed(0)} htfDown=${t.htfDown}`,
  );
}

const lossPatterns = {
  extendedDay: losses.filter((t) => t.dayRangePct > 0.03).length,
  lateSession: losses.filter((t) => {
    const h = new Date(t.ts).getUTCHours();
    return h < 6 || h >= 20;
  }).length,
  dispLosses: losses.filter((t) => t.trigger === "displacement_short").length,
  exhaustLosses: losses.filter((t) => t.trigger === "exhaustion_long").length,
  slOnly: losses.filter((t) => t.exits.includes("sl") && !t.exits.includes("tp1_partial")).length,
};

console.log("\n--- Loss patterns ---");
console.log(`  dayRange>3%: ${lossPatterns.extendedDay}/${losses.length}`);
console.log(`  late/early session (before 6 or after 20 UTC): ${lossPatterns.lateSession}/${losses.length}`);
console.log(`  displacement_short losses: ${lossPatterns.dispLosses}`);
console.log(`  exhaustion_long losses: ${lossPatterns.exhaustLosses}`);
console.log(`  full SL (no partial): ${lossPatterns.slOnly}/${losses.length}`);

const byMonth = new Map();
for (const t of list) {
  byMonth.set(t.month, (byMonth.get(t.month) || 0) + t.pnlPct);
}
console.log("\n--- Worst months (trade count in month) ---");
for (const [mo, p] of [...byMonth.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5)) {
  const monthTrades = list.filter((t) => t.month === mo);
  const monthLosses = monthTrades.filter((t) => t.pnlPct < 0);
  console.log(
    `  ${mo}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}% (${monthTrades.length} trades, ${monthLosses.length} losses) triggers=${[...new Set(monthTrades.map((t) => t.trigger))].join(",")}`,
  );
}

const sitCounts = {};
for (const t of list) sitCounts[t.situation] = (sitCounts[t.situation] || 0) + 1;
console.log("\n--- Situations traded ---");
console.log(sitCounts);

await closePool();
