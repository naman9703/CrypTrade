/**
 * Multi-symbol Binance depth20@100ms — up to 6 watch symbols for MICRO_EVENT.
 */
import { createBinanceOrderBook } from "./orderBookBinance.js";

const MAX_SYMBOLS = 6;

function normSym(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * @param {{ log: object, wsBase?: string }} opts
 */
export function createMultiBinanceOrderBook({ log, wsBase }) {
  /** @type {Map<string, ReturnType<typeof createBinanceOrderBook>>} */
  const clients = new Map();

  function syncSymbols(symbols) {
    const want = [...new Set((symbols ?? []).map(normSym).filter(Boolean))].slice(0, MAX_SYMBOLS);
    const wantSet = new Set(want);
    for (const sym of [...clients.keys()]) {
      if (!wantSet.has(sym)) {
        try {
          clients.get(sym)?.close();
        } catch {
          /* ignore */
        }
        clients.delete(sym);
      }
    }
    for (const sym of want) {
      if (!clients.has(sym)) {
        clients.set(sym, createBinanceOrderBook({ log, symbol: sym, wsBase }));
      }
    }
  }

  return {
    syncSymbols,
    getBooks() {
      const out = {};
      for (const [sym, c] of clients.entries()) {
        const b = c.getBook();
        if (b?.symbol) out[sym] = b;
      }
      return out;
    },
    getStatus() {
      const out = {};
      for (const [sym, c] of clients.entries()) {
        out[sym] = c.getStatus();
      }
      return out;
    },
    close() {
      for (const c of clients.values()) {
        try {
          c.close();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
  };
}
