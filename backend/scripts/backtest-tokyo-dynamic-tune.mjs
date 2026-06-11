#!/usr/bin/env node
/** Tune DYNAMIC SL/TP + trail buffer for TOKYO_SESSION. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-08";
const RISK = Number(process.env.RISK || 2);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildTokyoSessionBacktestAdapter,
  resolveTokyoSessionCfg,
  tokyoSessionPadFromMs,
} = await import("../src/strategy/tokyoSessionIntraday.js");
const { TOKYO_SESSION_BNB_15M } = await import("../src/strategy/presets/tokyoSessionOptimized.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const candles = await readCandles(SYMBOL, TF, tokyoSessionPadFromMs(fromMs, TF), toMs, { market: "futures" });
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

async function runOne(label, patch) {
  const cfg = resolveTokyoSessionCfg({ ...TOKYO_SESSION_BNB_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: RISK, ...patch });
  const adapter = buildTokyoSessionBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "TOKYO_SESSION",
    cfg: { ...cfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { TOKYO_SESSION: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 100 });
  const inW = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const exits = {};
  for (const t of inW) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  return { label, ret: m.totalReturnPct ?? 0, n: inW.length, wr: (m.winRate ?? 0) * 100, dd: m.maxDrawdownPct ?? 0, pf: m.profitFactor ?? 0, exits, patch };
}

const grid = [];
grid.push(await runOne("LEGACY ADAPTIVE 2R no trail", { tokyoSlMode: "ADAPTIVE", tokyoTpMode: "RR", tokyoTpRr: 2, trailingStopLossAuto: false, intradayLiqPartialTp: false }));
grid.push(await runOne("DYNAMIC no trail", { trailingStopLossAuto: false }));

for (const slMin of [0.0035, 0.0045, 0.0055]) {
  for (const tpMin of [0.006, 0.008, 0.01]) {
    for (const preFrac of [0.35, 0.42, 0.5]) {
      for (const atrMult of [0.9, 1.1, 1.3]) {
        for (const trail of [false, true]) {
          const patch = {
            tokyoSlMinPct: slMin,
            tokyoTpMinPct: tpMin,
            tokyoTpPreWidthFrac: preFrac,
            tokyoSlAtrMult: atrMult,
            trailingStopLossAuto: trail,
            trailBufferMode: "ATR",
            trailBufferAtrMult: atrMult,
            trailBufferRate: 0.0003,
            futuresTrailingStopMode: "FEE_LADDER",
          };
          if (!trail) patch.intradayLiqPartialTp = false;
          grid.push(
            await runOne(
              `dyn slMin=${slMin} tpMin=${tpMin} pre=${preFrac} atr=${atrMult} trail=${trail}`,
              patch,
            ),
          );
        }
      }
    }
  }
}

grid.sort((a, b) => b.ret - a.ret);
console.log(`\n=== TOKYO DYNAMIC + TRAIL TUNE ${SYMBOL} ${TF} ===\n`);
for (const r of grid.slice(0, 25)) {
  console.log(
    `${r.label.slice(0, 58).padEnd(58)} ret=${r.ret.toFixed(1)}% wr=${r.wr.toFixed(0)}% dd=${r.dd.toFixed(1)}% pf=${r.pf?.toFixed(2)} exits=${JSON.stringify(r.exits)}`,
  );
}
console.log("\nBEST:", JSON.stringify(grid[0], null, 2));
await closePool();
