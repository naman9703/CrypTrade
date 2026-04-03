import { createPaperExchange } from "../svc/exchange/paper.js";
import { createPaperFuturesExchange } from "../svc/exchange/paperFutures.js";
import { createBinanceTestnetSpotExchange } from "../svc/exchange/binanceTestnetSpot.js";
import { createBinanceDemoSpotExchange } from "../svc/exchange/binanceDemoSpot.js";
import { createBinanceDemoFuturesUsdMExchange } from "../svc/exchange/binanceDemoFuturesUsdM.js";
import { createBinanceFuturesTestnetUsdMExchange } from "../svc/exchange/binanceFuturesTestnetUsdM.js";
import { createHybridExchange } from "../svc/exchange/hybrid.js";

export function createExchange({ mode, log }) {
  if (mode === "BINANCE_TESTNET") {
    // Create both spot + futures if keys exist; bot can route between them.
    const spot = createBinanceTestnetSpotExchange({ log });
    let futures = null;
    try {
      futures = createBinanceFuturesTestnetUsdMExchange({ log });
    } catch {
      futures = null;
    }
    return createHybridExchange({ spot, futures, log });
  }
  if (mode === "BINANCE_DEMO_API") {
    // Demo Spot API is real demo orders; Binance docs only cover SPOT demo API.
    // If demo futures API is available, pair the *real* demo futures wallet; otherwise fall back to simulated futures.
    const spot = createBinanceDemoSpotExchange({ log });
    let futures = null;
    try {
      futures = createBinanceDemoFuturesUsdMExchange({ log });
    } catch {
      futures = null;
    }
    if (!futures) {
      futures = createPaperFuturesExchange({
        log,
        name: "binance_demo_futures_sim",
        baseDir: process.env.BINANCE_DEMO_FUTURES_STORE_DIR || "./data/binance-demo-futures",
      });
      futures.supportsAutoTrading = true;
    }
    return createHybridExchange({ spot, futures, log });
  }
  if (mode === "BINANCE_DEMO") {
    // Demo = paper execution with real Binance market feed (chart looks like live)
    const ex = createPaperExchange({
      log,
      name: "binance_demo",
      baseDir: process.env.BINANCE_DEMO_STORE_DIR || "./data/binance-demo",
    });
    // Allow the bot to place trades in this mode (it is still an execution-capable demo).
    ex.supportsAutoTrading = true;
    return ex;
  }
  if (mode === "BINANCE_DEMO_FUTURES") {
    // Prefer real Binance USD-M *demo* futures (demo-fapi) when keys are set so positions match the exchange.
    // Without keys, keep local paper futures (persisted under BINANCE_DEMO_FUTURES_STORE_DIR).
    const futKey = process.env.BINANCE_DEMO_FUTURES_API_KEY || process.env.BINANCE_DEMO_API_KEY || "";
    const futSecret =
      process.env.BINANCE_DEMO_FUTURES_API_SECRET || process.env.BINANCE_DEMO_API_SECRET || "";
    if (futKey && futSecret) {
      const ex = createBinanceDemoFuturesUsdMExchange({ log });
      ex.supportsAutoTrading = true;
      return ex;
    }
    const ex = createPaperFuturesExchange({
      log,
      name: "binance_demo_futures",
      baseDir: process.env.BINANCE_DEMO_FUTURES_STORE_DIR || "./data/binance-demo-futures",
    });
    ex.supportsAutoTrading = true;
    return ex;
  }
  if (mode === "BINANCE_FUTURES_TESTNET") {
    const futures = createBinanceFuturesTestnetUsdMExchange({ log });
    // If spot keys exist too, expose it for AUTO routing.
    let spot = null;
    try {
      spot = createBinanceTestnetSpotExchange({ log });
    } catch {
      spot = null;
    }
    return createHybridExchange({ spot, futures, log });
  }
  return createPaperExchange({ log });
}

