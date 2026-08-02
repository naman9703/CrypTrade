import test from "node:test";
import assert from "node:assert/strict";
import { aggTradeRollingEvents } from "../intelligence/collectors/aggTradeRolling.js";
import {
  startMicroEventLiveEngine,
  stopMicroEventLiveEngine,
  microEventLiveEvents,
} from "./microEventLiveEngine.js";

function fakeState() {
  return {
    running: true,
    manualStrategy: "MICRO_EVENT",
    tradingMode: "PAPER",
    symbol: "BTCUSDT",
    microEventLiveTickEnabled: true,
  };
}

function emitAggTick(px) {
  aggTradeRollingEvents.emit("tick", {
    symbol: "BTCUSDT",
    tick: { time: Date.now(), price: px, qty: 0.01, notionalUsd: px * 0.01, side: "buy" },
  });
}

test("throttles duplicate skip telemetry across rapid tick evals (no Activity flood)", async () => {
  const skips = [];
  const onSkip = (p) => skips.push(p);
  microEventLiveEvents.on("skip", onSkip);
  startMicroEventLiveEngine({
    getState: fakeState,
    log: { info: () => {}, warn: () => {} },
    onSignal: async () => {},
  });
  try {
    // No liq/OI/book/CVD data is fed in this test, so every tick evaluates to the same
    // "liq_required" skip reason. Without throttling, each of these would independently emit
    // a "skip" event (and, in bot.js, a synchronous Activity disk-append) — one per aggTrade tick.
    for (let i = 0; i < 25; i++) {
      emitAggTick(100_000 + i);
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    assert.equal(skips.length, 1, "rapid ticks with an unchanged skip reason must collapse to one emission");
    assert.equal(skips[0].symbol, "BTCUSDT");
  } finally {
    stopMicroEventLiveEngine();
    microEventLiveEvents.off("skip", onSkip);
  }
});

test("stopping the engine clears throttle state so a fresh start can emit again", async () => {
  const skips = [];
  const onSkip = (p) => skips.push(p);
  microEventLiveEvents.on("skip", onSkip);
  try {
    startMicroEventLiveEngine({
      getState: fakeState,
      log: { info: () => {}, warn: () => {} },
      onSignal: async () => {},
    });
    emitAggTick(100_000);
    await Promise.resolve();
    stopMicroEventLiveEngine();

    startMicroEventLiveEngine({
      getState: fakeState,
      log: { info: () => {}, warn: () => {} },
      onSignal: async () => {},
    });
    emitAggTick(100_001);
    await Promise.resolve();

    assert.equal(skips.length, 2, "a fresh engine start should not inherit the prior run's throttle state");
  } finally {
    stopMicroEventLiveEngine();
    microEventLiveEvents.off("skip", onSkip);
  }
});
