#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const run = (
  await pool.query(`
  SELECT * FROM backtest_runs
  WHERE symbol='ETHUSDT' AND timeframe='15m' AND status='done'
  ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1`)
).rows[0];

if (!run) {
  console.error("no run");
  process.exit(1);
}

const m = run.metrics || {};
const bot = run.config_snapshot?.bot || run.config_snapshot || {};
const trades = (
  await pool.query(
    `SELECT * FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`,
    [run.id],
  )
).rows;

console.log("RUN", run.id);
console.log(`ret=${m.totalReturnPct}% dd=${m.maxDrawdownPct}% trades=${m.totalTrades} PF=${m.profitFactor}`);
console.log(`window ${run.start_date} -> ${run.end_date}`);
console.log(
  `cfg: ext=${bot.intradayLiqMinSweepExtensionPct} rr=${bot.intradayLiqMinRr} maxTpRr=${bot.intradayLiqMaxTpRr} ` +
    `partial=${bot.intradayLiqPartialTp} tp1=${bot.intradayLiqTp1Enabled} tp2=${bot.intradayLiqTp2Enabled} ` +
    `frac=${bot.intradayLiqPartialFrac} bePartial=${bot.intradayLiqBreakevenAfterPartial} useFixedTp=${bot.supertrendFuturesUseFixedTp}`,
);

const logical = new Map();
for (const t of trades) {
  const key = `${new Date(t.entry_time).getTime()}:${t.direction}`;
  if (!logical.has(key)) {
    logical.set(key, {
      num: t.trade_number,
      direction: t.direction,
      entry: Number(t.entry_price),
      entryTs: t.entry_time,
      sl: Number(t.sl_price),
      tp: t.tp_price != null ? Number(t.tp_price) : null,
      legs: [],
      net: 0,
      sc: t.signal_context || {},
    });
  }
  const o = logical.get(key);
  o.legs.push({
    exit: t.exit_reason,
    exitPx: Number(t.exit_price),
    net: Number(t.net_pnl),
    exitTs: t.exit_time,
    mfe: t.mfe,
    mae: t.mae,
  });
  o.net += Number(t.net_pnl);
}

let rSum = 0;
let rN = 0;
const exitMix = {};

for (const [key, t] of logical) {
  const risk = t.sl > 0 ? Math.abs(t.entry - t.sl) : 0;
  const r = risk > 0 ? (t.legs.reduce((s, l) => s + (l.exitPx - t.entry) * (t.direction === "BUY" ? 1 : -1), 0) / risk) : 0;
  // approximate R from net vs initial risk using qty from first leg context
  const sc = t.sc;
  const liq = sc.liqContext || {};
  const rr = liq.rr ?? sc.rr;
  const tp1 = sc.tp1Price ?? liq.tp1Price;
  const maxMfe = Math.max(...t.legs.map((l) => Number(l.mfe) || 0));
  const maxMae = Math.max(...t.legs.map((l) => Number(l.mae) || 0));
  const exits = t.legs.map((l) => l.exit).join("+");
  exitMix[exits] = (exitMix[exits] || 0) + 1;

  // R from signal context initial risk if available
  const initRisk = Number(sc.initialRiskUsd);
  const rNet = initRisk > 0 ? t.net / initRisk : (risk > 0 ? t.net / (risk * (Number(trades.find(x => x.trade_number===t.num)?.quantity)||1)) : 0);

  rSum += rNet;
  rN++;

  console.log(
    `\n#${t.num} ${t.direction} ${String(t.entryTs).slice(0, 10)} entry=${t.entry.toFixed(2)} sl=${t.sl?.toFixed(2)} tp=${t.tp?.toFixed(2) ?? "null"}`,
  );
  console.log(`  signal rr=${rr} tp1=${tp1} level=${liq.levelType} exits=${exits} net=$${t.net.toFixed(2)} ~R=${rNet.toFixed(2)} mfe=${maxMfe} mae=${maxMae}`);
  for (const l of t.legs) {
    console.log(`    ${l.exit} @ ${l.exitPx.toFixed(2)} net=$${l.net.toFixed(2)}`);
  }
}

console.log("\n--- SUMMARY ---");
console.log("logical entries", logical.size);
console.log("exit mix", exitMix);
console.log("avg R (net/initialRisk)", rN ? (rSum / rN).toFixed(3) : "n/a");
console.log("expectancyR metrics", m.expectancyR);

await closePool?.();
