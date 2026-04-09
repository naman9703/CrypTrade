import { createPaperExchange } from "../svc/exchange/paper.js";
import { createPaperFuturesExchange } from "../svc/exchange/paperFutures.js";
import { createBinanceTestnetSpotExchange } from "../svc/exchange/binanceTestnetSpot.js";
import { createBinanceDemoSpotExchange } from "../svc/exchange/binanceDemoSpot.js";
import { createBinanceDemoFuturesUsdMExchange } from "../svc/exchange/binanceDemoFuturesUsdM.js";
import { createBinanceLiveSpotExchange } from "../svc/exchange/binanceLiveSpot.js";
import { createBinanceLiveFuturesUsdMExchange } from "../svc/exchange/binanceLiveFuturesUsdM.js";
import { createBinanceFuturesTestnetUsdMExchange } from "../svc/exchange/binanceFuturesTestnetUsdM.js";
import { createHybridExchange } from "../svc/exchange/hybrid.js";
import { resolveDefaultDemoFuturesSimDir } from "../lib/tradingModePersistence.js";

export function createExchange({ mode, log }) {
  let m = String(mode || "PAPER").toUpperCase();
  // Removed TRADING_MODE; still accepted e.g. from scripts — appState logs a warning on startup.
  if (m === "BINANCE_DEMO_FUTURES") m = "BINANCE_DEMO_API";
  if (m === "BINANCE_FUTURES_TESTNET") m = "BINANCE_TESTNET";
  if (m === "BINANCE_TESTNET") {
    // Single testnet mode: hybrid spot testnet + USD-M futures testnet when each leg initializes (keys/REST may still fail per-call).
    let spot = null;
    let futures = null;
    try {
      spot = createBinanceTestnetSpotExchange({ log });
    } catch (e) {
      log?.warn?.("binance_testnet_spot_init_failed", { error: String(e?.message || e) });
    }
    try {
      futures = createBinanceFuturesTestnetUsdMExchange({ log });
    } catch (e) {
      log?.warn?.("binance_testnet_futures_init_failed", { error: String(e?.message || e) });
    }
    if (!spot && !futures) {
      log?.warn?.("binance_testnet_no_legs_using_paper", {
        detail: "Could not init spot or futures testnet connectors — using PAPER.",
      });
      return createPaperExchange({ log });
    }
    return createHybridExchange({ spot, futures, log });
  }
  if (m === "BINANCE_DEMO_API") {
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
        baseDir: resolveDefaultDemoFuturesSimDir(),
      });
      futures.supportsAutoTrading = true;
    }
    return createHybridExchange({ spot, futures, log });
  }
  if (m === "BINANCE_LIVE") {
    if (String(process.env.BINANCE_LIVE_TRADING_ENABLED || "0") !== "1") {
      throw new Error(
        "binance_live_not_enabled: set BINANCE_LIVE_TRADING_ENABLED=1 in backend/.env after reviewing real-funds and API-key risk."
      );
    }
    const spot = createBinanceLiveSpotExchange({ log });
    let futures = null;
    try {
      futures = createBinanceLiveFuturesUsdMExchange({ log });
    } catch (e) {
      log?.warn?.("binance_live_futures_init_failed", { error: String(e?.message || e) });
      futures = null;
    }
    if (!futures) {
      log?.warn?.("binance_live_futures_unavailable_spot_only_hybrid", {
        detail: "Futures leg failed to initialize — hybrid spot-only until BINANCE_LIVE_FUTURES_* / keys are fixed.",
      });
    }
    return createHybridExchange({ spot, futures, log });
  }
  return createPaperExchange({ log });
}

