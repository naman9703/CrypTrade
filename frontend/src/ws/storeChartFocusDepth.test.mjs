/**
 * Regression: store.ts must import symbolPriceSanity — chart tab focus, market ticks,
 * and depth WS all call normalizeSym / isPlausibleCandleClose. A dropped import
 * breaks multi-coin chart + order book silently (WS handlers swallow errors).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSym } from "../lib/symbolPriceSanity.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storeSrc = readFileSync(join(__dirname, "store.ts"), "utf8");

test("store.ts imports symbolPriceSanity (chart + depth routing)", () => {
  assert.match(
    storeSrc,
    /import\s*\{[^}]*\bnormalizeSym\b[^}]*\}\s*from\s*["']\.\.\/lib\/symbolPriceSanity["']/,
    "store.ts must import normalizeSym from symbolPriceSanity",
  );
  assert.match(
    storeSrc,
    /import\s*\{[^}]*\bisPlausibleCandleClose\b[^}]*\}\s*from\s*["']\.\.\/lib\/symbolPriceSanity["']/,
    "store.ts must import isPlausibleCandleClose from symbolPriceSanity",
  );
});

/** Mirrors scheduleDepthFlush: reject depth when symbol != active chart view. */
function depthAppliesToChart(chartDisplaySymbol, botSymbol, depthPayloadSymbol) {
  const chartSym = normalizeSym(chartDisplaySymbol ?? botSymbol);
  const depthSym = normalizeSym(depthPayloadSymbol);
  if (chartSym && depthSym && chartSym !== depthSym) return false;
  return true;
}

test("depth flush accepts book when chart view matches payload symbol", () => {
  assert.equal(depthAppliesToChart("ETHUSDT", "BTCUSDT", "ETHUSDT"), true);
  assert.equal(depthAppliesToChart(null, "BTCUSDT", "BTCUSDT"), true);
});

test("depth flush rejects stale book after multi-coin tab switch", () => {
  assert.equal(depthAppliesToChart("ETHUSDT", "BTCUSDT", "BTCUSDT"), false);
});
