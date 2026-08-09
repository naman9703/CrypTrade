#!/usr/bin/env node
/**
 * MICRO_EVENT live-path paper proof:
 * inject cascade microstructure → tick engine → paper futures placeOrder → open position.
 *
 * Run from backend/: node scripts/smoke-micro-event-paper-path.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYM = "BTCUSDT";
const ENTRY = 100_000;
const LIQ_HIGH = 101_200; // long-liq cascade extreme (higher)

const { ingestForceOrderTick } = await import("../src/intelligence/collectors/liquidationCollector.js");
const { ingestAggTradeMessage } = await import("../src/intelligence/collectors/aggTradeRolling.js");
const { recordOpenInterestSample } = await import("../src/strategy/data/openInterestHistory.js");
const { getMicrostructureSnapshot } = await import("../src/strategy/data/microstructureSnapshot.js");
const {
  startMicroEventLiveEngine,
  stopMicroEventLiveEngine,
  microEventLiveEvents,
} = await import("../src/svc/microEventLiveEngine.js");
const { createPaperFuturesExchange } = await import("../src/svc/exchange/paperFutures.js");
const { evaluateMicroEventFromSnapshot } = await import("../src/strategy/techniques/microEvent.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function seedCascade() {
  const now = Date.now();
  // Prior window quiet (for z-like > 1)
  for (let i = 0; i < 3; i++) {
    ingestForceOrderTick({
      symbol: SYM,
      time: now - 120_000 - i * 5_000,
      side: "SELL",
      price: ENTRY + 50,
      qty: 0.05,
      notionalUsd: ENTRY * 0.05,
      persist: false,
    });
  }
  // Cascade: large long liquidations (force SELL)
  for (let i = 0; i < 8; i++) {
    const px = LIQ_HIGH - i * 80;
    ingestForceOrderTick({
      symbol: SYM,
      time: now - 40_000 + i * 2_000,
      side: "SELL",
      price: px,
      qty: 0.4,
      notionalUsd: px * 0.4,
      persist: false,
    });
  }
  // Aggressive sell CVD — must land in the *recent* half of the 60s window
  for (let i = 0; i < 20; i++) {
    ingestAggTradeMessage(SYM, {
      T: now - 18_000 + i * 800,
      p: ENTRY - i * 5,
      q: 0.15,
      m: true, // buyer is maker → sell aggression
    });
  }
  // OI unwind: span ≥50% of 1m and 5m windows
  recordOpenInterestSample(SYM, 1_000_000, now - 320_000);
  recordOpenInterestSample(SYM, 995_000, now - 160_000);
  recordOpenInterestSample(SYM, 985_000, now - 70_000);
  recordOpenInterestSample(SYM, 978_000, now - 35_000);
  recordOpenInterestSample(SYM, 970_000, now - 5_000);
}

const paper = createPaperFuturesExchange({
  log: { info: () => {}, warn: () => {}, error: console.error },
  name: "micro_event_smoke_paper",
  baseDir: path.resolve(__dirname, "../data/paper-smoke-micro-event"),
});

const cfgState = {
  running: true,
  manualStrategy: "MICRO_EVENT",
  tradingMode: "PAPER",
  symbol: SYM,
  microEventLiveTickEnabled: true,
  microEventDirectionMode: "continuation",
  microEventMinConfluenceScore: 30,
  microEventMinConfirmLayers: 2,
  microEventLiqWindowSec: 90,
  microEventLiqMinUsd: 25_000,
  microEventLiqZMin: 1.5,
  microEventLiqRequired: true,
  microEventOiGateEnabled: true,
  microEventBookGateEnabled: false, // book often null in harness
  microEventCvdGateEnabled: true,
  microEventFundingGateEnabled: false,
  microEventMacroGateEnabled: false,
  microEventCooldownSec: 45,
  microEventMaxTradesPerHour: 12,
  microEventTradeSides: "BOTH",
  microEventSlBufferPct: 0.0015,
  microEventTpRr: 1.2,
  supertrendFuturesTwoWay: true,
};

const signals = [];
const skips = [];
microEventLiveEvents.on("signal", (p) => signals.push(p));
microEventLiveEvents.on("skip", (p) => skips.push(p));

let placed = null;
seedCascade(); // buffers only — engine not listening yet

startMicroEventLiveEngine({
  getState: () => cfgState,
  log: {
    info: (m, d) => {
      if (String(m).includes("oi") || String(m).startsWith("micro_event")) {
        console.log(`[engine] ${m}`, d ? JSON.stringify(d) : "");
      }
    },
    warn: (m, d) => console.warn(`[engine] ${m}`, d ? JSON.stringify(d) : ""),
  },
  onSignal: async (payload) => {
    const side = payload.action === "BUY" ? "BUY" : "SELL";
    const entry = Number(payload.liqBrackets?.entryPrice ?? ENTRY);
    const slPct = Number(payload.liqBrackets?.slPct ?? 0.01);
    const tpPct = Number(payload.liqBrackets?.tpPct ?? 0.012);
    const sl = side === "BUY" ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = side === "BUY" ? entry * (1 + tpPct) : entry * (1 - tpPct);
    const qty = 0.01;
    const res = await paper.placeOrder({
      symbol: SYM,
      side,
      qty,
      price: entry,
      stopLoss: sl,
      takeProfit: tp,
      strategy: "MICRO_EVENT",
      meta: {
        strategyKey: "MICRO_EVENT",
        confluenceScore: payload.confluenceScore,
        layers: payload.layers,
        maxHoldSec: payload.liqBrackets?.maxHoldSec,
        tickToOrderProof: true,
      },
    });
    placed = { side, entry, sl, tp, res, payload };
    return { action: "placed", ...res };
  },
});

const snap = getMicrostructureSnapshot(SYM, { liqWindowSec: 90, domRatio: 1.2 });
console.log("\n=== snapshot ===");
console.log({
  liqDom: snap.liqDom,
  liqTotalUsd: Math.round(snap.liqTotalUsd),
  liqZLike: Number(snap.liqZLike?.toFixed?.(2) ?? snap.liqZLike),
  liqExtremePrice: snap.liqExtremePrice,
  oiDeltaPct1m: snap.oiDeltaPct1m,
  oiDeltaPct5m: snap.oiDeltaPct5m,
  aggressiveSellUsd60s: Math.round(snap.aggressiveSellUsd60s ?? 0),
  cvdSlope60s: Math.round(snap.cvdSlope60s ?? 0),
});

const direct = evaluateMicroEventFromSnapshot(snap, cfgState, ENTRY);
console.log("\n=== direct evaluate ===", {
  action: direct.action,
  score: direct.confluenceScore,
  layers: direct.layers,
  failedGate: direct.audit?.failedGate,
  slPct: direct.liqBrackets?.slPct,
});

// Single live trigger (Binance WS path)
ingestForceOrderTick({
  symbol: SYM,
  time: Date.now(),
  side: "SELL",
  price: ENTRY - 50,
  qty: 0.5,
  notionalUsd: (ENTRY - 50) * 0.5,
  persist: false,
});

await sleep(300);
stopMicroEventLiveEngine();

const positions = await paper.getPositions();
const open = (positions || []).filter((p) => String(p.symbol).toUpperCase() === SYM);

console.log("\n=== live engine result ===");
console.log({
  signals: signals.length,
  skips: skips.length,
  lastSkip: skips.at(-1)?.audit?.failedGate ?? null,
  placed: placed
    ? {
        side: placed.side,
        entry: placed.entry,
        sl: placed.sl,
        tp: placed.tp,
        score: placed.payload.confluenceScore,
        layers: placed.payload.layers,
        extremeUsed: placed.payload.snapshot?.liqExtremePrice,
      }
    : null,
  openPositions: open.map((p) => ({
    side: p.side,
    qty: p.qty ?? p.quantity,
    entry: p.entryPrice ?? p.avgPrice,
    sl: p.stopLoss ?? p.sl,
    tp: p.takeProfit ?? p.tp,
  })),
});

const ok =
  signals.length === 1 &&
  open.length === 1 &&
  placed?.side === "SELL" &&
  Number(placed.sl) > Number(placed.entry) &&
  Number(placed.payload.snapshot?.liqExtremePrice) >= LIQ_HIGH - 1;

if (!ok) {
  console.error("\nFAIL — expected exactly one paper SELL with SL above entry/extreme");
  process.exit(1);
}

console.log("\nPASS — MICRO_EVENT live tick → paper futures open (continuation SELL, 1 fill)");
process.exit(0);
