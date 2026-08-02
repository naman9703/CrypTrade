import assert from "node:assert/strict";
import test from "node:test";
import { shouldForwardActivityToTelegram } from "./telegramSidecar.js";

test("shouldForwardActivityToTelegram — skips signal outcomes", () => {
  assert.equal(
    shouldForwardActivityToTelegram({
      category: "signal",
      msg: "Strategy signal · MICRO_EVENT · — · SKIPPED · micro_event_skip:confirm_layers",
    }),
    false,
  );
  assert.equal(
    shouldForwardActivityToTelegram({
      category: "signal",
      msg: "Strategy signal · MICRO_EVENT · SELL · PLACED",
      detail: { action: "PLACED" },
    }),
    false,
  );
});

test("shouldForwardActivityToTelegram — forwards lifecycle and manual fills", () => {
  assert.equal(
    shouldForwardActivityToTelegram({ category: "bot_lifecycle", msg: "Engine started" }),
    true,
  );
  assert.equal(
    shouldForwardActivityToTelegram({ category: "manual_trade", msg: "Manual trade · BUY BTCUSDT" }),
    true,
  );
});

test("shouldForwardActivityToTelegram — ignores other activity categories", () => {
  assert.equal(
    shouldForwardActivityToTelegram({ category: "micro_event", msg: "MICRO_EVENT tick SELL BTCUSDT" }),
    false,
  );
  assert.equal(shouldForwardActivityToTelegram({ category: "risk", msg: "Stop loss triggered" }), false);
});
