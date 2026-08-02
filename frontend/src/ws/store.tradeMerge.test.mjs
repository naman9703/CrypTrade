import assert from "node:assert/strict";
import test from "node:test";

/** Minimal replay of store.ts OPEN→CLOSE merge by id. */
function mergeTradeEvent(trades, p) {
  const id = p?.id;
  if (id == null || id === "") return [p, ...trades];
  const idx = trades.findIndex((t) => t?.id === id);
  if (idx < 0) return [p, ...trades];
  const prev = trades[idx];
  const prevType = String(prev?.type ?? "").toUpperCase();
  const nextType = String(p?.type ?? "").toUpperCase();
  if (prevType === "OPEN" && nextType === "CLOSE") {
    const openPrice = prev.price ?? prev.entryPrice;
    const merged = {
      ...prev,
      ...p,
      type: "OPEN",
      status: "CLOSED",
      entryPrice: openPrice,
      exitPrice: p.price,
      price: openPrice,
      meta: { ...(prev.meta || {}), ...(p.meta || {}), entryPrice: openPrice, exitPrice: p.price },
    };
    const next = trades.slice();
    next[idx] = merged;
    return next;
  }
  return trades;
}

test("OPEN then CLOSE with same id merges into one CLOSED row", () => {
  const open = {
    id: "pos-1",
    type: "OPEN",
    symbol: "BTCUSDT",
    side: "BUY",
    price: 100,
    qty: 0.01,
    fee: 0.04,
  };
  const close = {
    id: "pos-1",
    type: "CLOSE",
    symbol: "BTCUSDT",
    side: "SELL",
    price: 101,
    qty: 0.01,
    pnl: 0.5,
    fee: 0.04,
    meta: { grossPnl: 0.54 },
  };
  let trades = [open];
  trades = mergeTradeEvent(trades, close);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, "CLOSED");
  assert.equal(trades[0].type, "OPEN");
  assert.equal(trades[0].price, 100);
  assert.equal(trades[0].exitPrice, 101);
  assert.equal(trades[0].pnl, 0.5);
  assert.equal(trades[0].meta.grossPnl, 0.54);
});
