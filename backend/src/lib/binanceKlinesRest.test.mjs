import test from "node:test";
import assert from "node:assert/strict";
import { chartKlineRestCandidates } from "./binanceKlinesRest.js";

test("chartKlineRestCandidates prefers demo futures hosts for demo mode", () => {
  process.env.BINANCE_DEMO_FUTURES_REST_BASE = "https://demo-fapi.binance.com";
  process.env.BINANCE_FUTURES_TESTNET_REST_BASE = "https://testnet.binancefuture.com";
  process.env.BINANCE_LIVE_FUTURES_REST_BASE = "https://fapi.binance.com";

  const out = chartKlineRestCandidates("BINANCE_FUTURES", "BINANCE_DEMO_API");
  assert.equal(out[0], "https://demo-fapi.binance.com");
  assert.equal(out.includes("https://fapi.binance.com"), true);
});

test("chartKlineRestCandidates prefers live spot hosts for live mode", () => {
  process.env.BINANCE_DEMO_REST_BASE = "https://demo-api.binance.com/api";
  process.env.BINANCE_TESTNET_REST_BASE = "https://testnet.binance.vision";
  process.env.BINANCE_LIVE_REST_BASE = "https://api.binance.com/api";

  const out = chartKlineRestCandidates("BINANCE", "BINANCE_LIVE");
  assert.equal(out[0], "https://api.binance.com");
  assert.equal(out.includes("https://demo-api.binance.com"), true);
});
