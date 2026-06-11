#!/usr/bin/env node
/**
 * BNB 15m year study — situation × setup edge matrix → route table JSON.
 * Usage: node scripts/study-bnb-situations-year.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);
const MIN_TRADES = Number(process.env.MIN_TRADES || 10);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { buildSituationSeries } = await import("../src/strategy/situation/situationEngine.js");
const { SituationDayState } = await import("../src/strategy/situation/situationState.js");
const { SITUATIONS, DEFAULT_ROUTE_TABLE, SETUP_TRIGGERS } = await import(
  "../src/strategy/situation/situationConstants.js"
);
const { SCANNER_MAP } = await import("../src/strategy/situation/setupScanners.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padMs = 14 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs);
const pre = precomputeIntraday(candles);
const { series: situationSeries } = buildSituationSeries(candles, pre);
const WARMUP = 100;
const dayStates = new Map();

function liqBracketsFromSetup(setup) {
  return {
    slPct: setup.slPct,
    tpPct: setup.tpPct,
    tp1Pct: setup.tp1Pct,
    slPrice: setup.slPrice,
    tpPrice: setup.tp2Price ?? setup.tpPrice,
    tp1Price: setup.tp1Price,
    tp2Price: setup.tp2Price ?? setup.tpPrice,
    tpMode: setup.tpMode,
    rr: setup.rr,
    partialTp: setup.partialTp !== false,
    tp2Enabled: setup.tp2Enabled !== false,
    partialFrac: setup.partialFrac ?? 0.5,
    liqQuality: setup.score ?? 0,
  };
}

function buildTriggerAdapter(trigger, scanFn) {
  return function triggerAdapter(bar, idx) {
    if (idx < WARMUP) return null;
    const day = utcDayId(bar.ts);
    if (!dayStates.has(day)) dayStates.set(day, new SituationDayState());
    const dayState = dayStates.get(day);
    dayState.ensureDay(bar, idx);
    dayState.updateBias(candles, idx, pre, bar);

    const setup = scanFn(candles, idx, pre, dayState, {});
    if (!setup) return null;
    const situation = situationSeries[idx]?.situation || SITUATIONS.CHOP_NEUTRAL;
    return {
      action: setup.action,
      reason: `study|${situation}|${trigger}`,
      situation,
      trigger,
      liqBrackets: liqBracketsFromSetup(setup),
    };
  };
}

const cellStats = {};
const situationCounts = {};
const totalBars = candles.filter((c) => c.ts >= fromMs && c.ts < toMs).length;

for (let i = WARMUP; i < candles.length; i++) {
  if (candles[i].ts < fromMs || candles[i].ts >= toMs) continue;
  const s = situationSeries[i]?.situation;
  if (s) situationCounts[s] = (situationCounts[s] || 0) + 1;
}

console.log(`\n=== BNB Situation Study ${FROM} → ${TO} ===\n`);

for (const [trigger, scanFn] of Object.entries(SCANNER_MAP)) {
  dayStates.clear();
  const STRAT = `STUDY_${trigger}`;
  const sim = await runSimulation({
    candles,
    strategyKey: STRAT,
    cfg: {
      symbol: SYMBOL,
      timeframe: TF,
      marketMode: "FUTURES",
      riskPerTrade: RISK,
      futuresLeverage: 12,
      backtestPositionSizing: "RISK_AT_SL",
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { [STRAT]: buildTriggerAdapter(trigger, scanFn) },
    symbol: SYMBOL,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });

  const entries = new Map();
  for (const t of sim.trades.filter((tr) => tr.entryTs >= fromMs && tr.entryTs < toMs)) {
    const key = `${t.entryTs}_${t.direction}`;
    if (!entries.has(key)) {
      const parts = (t.entryReason || "").split("|");
      entries.set(key, {
        situation: parts[1] || "UNKNOWN",
        trigger: parts[2] || trigger,
        pnl: 0,
      });
    }
    entries.get(key).pnl += Number(t.netPnl);
  }

  for (const e of entries.values()) {
    const key = `${e.situation}|${e.trigger}`;
    if (!cellStats[key]) cellStats[key] = { n: 0, wins: 0, net: 0 };
    cellStats[key].n += 1;
    if (e.pnl > 0) cellStats[key].wins += 1;
    cellStats[key].net += e.pnl;
  }
}

const situations = Object.values(SITUATIONS);
const triggers = Object.values(SETUP_TRIGGERS);
const routes = {};
const enabledCells = [];

for (const sit of situations) {
  routes[sit] = [];
  for (const trig of triggers) {
    const key = `${sit}|${trig}`;
    const v = cellStats[key];
    if (!v || v.n < 1) continue;
    const wr = (v.wins / v.n) * 100;
    const enable = v.net > 0 && v.n >= MIN_TRADES;
    if (enable) {
      routes[sit].push(trig);
      enabledCells.push({ situation: sit, trigger: trig, n: v.n, net: v.net, wr });
    }
    console.log(
      `  ${sit.padEnd(18)} × ${trig.padEnd(22)} n=${String(v.n).padStart(3)} wr=${wr.toFixed(0).padStart(3)}% net=${v.net >= 0 ? "+" : ""}${v.net.toFixed(2)}% ${enable ? "✓" : ""}`,
    );
  }
}

// Only keep empirically positive cells — no fallback to defaults (avoids negative breakout playbooks).
for (const sit of situations) {
  if (!routes[sit].length) routes[sit] = [];
}

const routeTable = {
  meta: {
    symbol: SYMBOL,
    timeframe: TF,
    from: FROM,
    to: TO,
    generatedAt: new Date().toISOString(),
    minTrades: MIN_TRADES,
    enabledCellCount: enabledCells.length,
  },
  routes,
  thresholds: {
    fadeMinAdx: 18,
    fadeMinRvol: 0.9,
    dispMinRvol: 2.0,
    retestMinRvol: 0.75,
    classicalMinRvol: 1.1,
    sessionMinRvol: 1.0,
    minScore: 7,
  },
  enabledCells,
};

const outJson = path.resolve(__dirname, "bnb-situation-route-table.json");
writeFileSync(outJson, JSON.stringify(routeTable, null, 2));

const sitLines = Object.entries(situationCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- **${k}**: ${((v / totalBars) * 100).toFixed(1)}% of bars (${v})`)
  .join("\n");

const md = `# BNB Situation Study — ${FROM} → ${TO}

> Generated by \`study-bnb-situations-year.mjs\`

## Situation frequency (${totalBars} bars)
${sitLines}

## Enabled cells (net > 0, n ≥ ${MIN_TRADES})
${enabledCells.length ? enabledCells.map((c) => `- ${c.situation} × ${c.trigger}: ${c.n} trades, ${c.wr.toFixed(0)}% WR, ${c.net >= 0 ? "+" : ""}${c.net.toFixed(2)}%`).join("\n") : "_No cells met threshold — default routes used_"}

## Routes
\`\`\`json
${JSON.stringify(routes, null, 2)}
\`\`\`
`;

writeFileSync(path.resolve(__dirname, "BNB_SITUATION_STUDY.md"), md);
console.log(`\nEnabled cells: ${enabledCells.length}`);
console.log(`Wrote ${outJson}`);

await closePool();
