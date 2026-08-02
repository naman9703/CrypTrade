import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLiqCascadeKlinesOk,
  buildLiqCascadeFeedStatus,
} from "./liqCascadeFeedStatus.js";

test("klines ok when WS flag false but fresh buffer exists", () => {
  const now = Date.now();
  const r = resolveLiqCascadeKlinesOk(
    true,
    {
      ok: false,
      source: "BINANCE_FUTURES",
      buffer: 1200,
      lastMsgAt: now - 5_000,
      lastPrimaryBufferPushAt: now - 4_000,
    },
    "1m",
  );
  assert.equal(r.ok, true);
  assert.ok(r.reason === "data_fresh" || r.reason === "ws_reconnect");
});

test("klines missing on synthetic feed", () => {
  const r = resolveLiqCascadeKlinesOk(
    false,
    { ok: true, source: "SYNTH", buffer: 200 },
    "1m",
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "synth_feed");
});

test("OI optional when gate off", () => {
  const st = buildLiqCascadeFeedStatus({
    symbol: "BTCUSDT",
    timeframe: "1m",
    marketFeedLive: true,
    feedStatus: {
      ok: true,
      source: "BINANCE_FUTURES",
      buffer: 500,
      lastMsgAt: Date.now(),
      lastPrimaryBufferPushAt: Date.now(),
    },
    liqCascadeOiGateMode: "off",
    liqCascadeMinOiDropPct: 0,
    liqCascadeLiveTickEnabled: false,
    botRunning: false,
    ensureStream: false,
  });
  assert.equal(st.feeds.openInterest.required, false);
});
