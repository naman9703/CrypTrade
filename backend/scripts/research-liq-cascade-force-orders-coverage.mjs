#!/usr/bin/env node
/**
 * Report Binance forceOrder tick archive coverage for accurate LIQ_CASCADE replay.
 *
 * Usage (backend/):
 *   node scripts/research-liq-cascade-force-orders-coverage.mjs
 *   SYMBOL=BTCUSDT LIQ_INTERVAL=1min node scripts/research-liq-cascade-force-orders-coverage.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const LIQ_INTERVAL = process.env.LIQ_INTERVAL || "5min";
const MIN_WEEKS_ACCURATE = Number(process.env.MIN_WEEKS_ACCURATE || 8);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { liqIntervalToMs } = await import("../src/strategy/techniques/liqCascade.js");
const {
  aggregateTicksToLiqSeries,
  loadLiqCascadeForceOrderSeries,
  resolveLiqCascadeLiqSource,
} = await import("../src/strategy/liqCascadeIntraday.js");

async function probeDb() {
  const url = String(process.env.DATABASE_URL || "").trim();
  const host = String(process.env.DB_HOST || "").trim();
  if (!url && !host) return false;
  try {
    const pg = (await import("pg")).default;
    const cfg = url
      ? { connectionString: url, connectionTimeoutMillis: 4000 }
      : {
          host,
          port: Number(process.env.DB_PORT || 5432),
          database: String(process.env.DB_NAME || "trading"),
          user: String(process.env.DB_USER || "postgres"),
          password: String(process.env.DB_PASSWORD || ""),
          connectionTimeoutMillis: 4000,
        };
    const test = new pg.Pool(cfg);
    await test.query("SELECT 1");
    await test.end();
    if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
    return Boolean(getPool?.());
  } catch (err) {
    console.error("DB unavailable:", err?.message || err);
    return false;
  }
}

const dbOk = await probeDb();
if (!dbOk) {
  console.log("\n=== LIQ_CASCADE force_orders coverage ===\n");
  console.log("DB not reachable. Start Docker Timescale (`docker compose -f docker-compose.db.yml up -d`)");
  console.log("and run the bot with liquidation WS enabled to accumulate ticks.");
  console.log("\nAccurate replay requires LIQ_SOURCE=force_orders with ≥8 weeks of ticks.");
  process.exit(1);
}

const pool = getPool();
const intervalMs = liqIntervalToMs(LIQ_INTERVAL);
const rows = [];

for (const symbol of SYMBOLS) {
  const sym = symbol.toUpperCase();
  const { rows: stats } = await pool.query(
    `SELECT COUNT(*)::bigint AS tick_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            SUM(notional_usd)::float8 AS total_usd,
            COUNT(DISTINCT date_trunc('day', ts))::int AS active_days
     FROM force_orders
     WHERE symbol = $1`,
    [sym],
  );
  const s = stats[0];
  const tickCount = Number(s.tick_count || 0);
  const firstMs = s.first_ts ? new Date(s.first_ts).getTime() : null;
  const lastMs = s.last_ts ? new Date(s.last_ts).getTime() : null;
  const weeks =
    firstMs != null && lastMs != null && lastMs > firstMs ? (lastMs - firstMs) / (7 * 864e5) : 0;

  let liqBarCount = 0;
  let nonzeroBars = 0;
  if (tickCount > 0 && firstMs != null && lastMs != null) {
    const loaded = await loadLiqCascadeForceOrderSeries(sym, firstMs, lastMs, {
      liqCascadeInterval: LIQ_INTERVAL,
    });
    liqBarCount = loaded.liqBarCount;
    nonzeroBars = loaded.liqSeries.filter((b) => (b.liqLongUsd + b.liqShortUsd) > 0).length;
  }

  const accurateReady = weeks >= MIN_WEEKS_ACCURATE && tickCount >= 500;
  const row = {
    symbol: sym,
    tickCount,
    totalUsd: s.total_usd != null ? Math.round(Number(s.total_usd)) : 0,
    activeDays: Number(s.active_days || 0),
    firstTs: firstMs ? new Date(firstMs).toISOString() : null,
    lastTs: lastMs ? new Date(lastMs).toISOString() : null,
    weeks: +weeks.toFixed(2),
    liqInterval: LIQ_INTERVAL,
    liqBarCount,
    nonzeroLiqBars: nonzeroBars,
    accurateReplayReady: accurateReady,
  };
  rows.push(row);
  console.log(
    `${sym.padEnd(8)} ticks=${String(tickCount).padStart(6)} weeks=${String(row.weeks).padStart(5)} ` +
      `bars=${String(liqBarCount).padStart(5)} (${nonzeroBars} nonzero) ` +
      `ready=${accurateReady ? "YES" : "NO"}`,
  );
}

const anyReady = rows.some((r) => r.accurateReplayReady);
const report = {
  generatedAt: new Date().toISOString(),
  liqSource: resolveLiqCascadeLiqSource({ liqCascadeLiqSource: "force_orders" }),
  liqInterval: LIQ_INTERVAL,
  intervalMs,
  minWeeksAccurate: MIN_WEEKS_ACCURATE,
  anyAccurateReplayReady: anyReady,
  symbols: rows,
  nextSteps: anyReady
    ? [
        `LIQ_SOURCE=force_orders LIQ_INTERVAL=${LIQ_INTERVAL} FROM=<first> TO=<last> node scripts/research-liq-cascade-phase0.mjs`,
        `LIQ_SOURCE=force_orders FROM=<first> TO=<last> node scripts/backtest-validate-liq-cascade.mjs`,
      ]
    : [
        "Keep bot running with Binance forceOrder WS + migration 036 applied.",
        `Re-run when any symbol has ≥${MIN_WEEKS_ACCURATE} weeks of ticks.`,
        "Do not treat Coinalyze 1hour bars as accurate — edge is below cost floor at that granularity.",
      ],
};

fs.writeFileSync(path.join(__dirname, ".liq-cascade-force-orders-coverage.json"), JSON.stringify(report, null, 2));
console.log(`\nAny symbol accurate-ready (≥${MIN_WEEKS_ACCURATE}wk): ${anyReady ? "YES" : "NO"}`);
console.log(`Report → scripts/.liq-cascade-force-orders-coverage.json`);
await closePool?.();
