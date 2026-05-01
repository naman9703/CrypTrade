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
import { decryptCredentialsForEngine } from "../db/services/credentialsService.js";

/**
 * Resolve Binance credentials: DB row when `accountId` is set, else `.env` (legacy / paper-adjacent dev).
 * Never logs the plaintext secret.
 * @param {string | null | undefined} accountId
 * @returns {Promise<{ apiKey: string, secret: string } | null>}
 */
async function resolveBinanceCredentials(accountId) {
  if (!accountId) return null;
  const creds = await decryptCredentialsForEngine(String(accountId));
  if (!creds?.apiKey || !creds?.secret) {
    throw new Error(`no_active_credentials:${accountId}`);
  }
  return { apiKey: creds.apiKey, secret: creds.secret };
}

/**
 * @param {{ mode: string, log: import('../lib/logger.js').Logger, accountId?: string | null }} opts
 */
export async function createExchange({ mode, log, accountId = null }) {
  let m = String(mode || "PAPER").toUpperCase();
  if (m === "BINANCE_DEMO_FUTURES") m = "BINANCE_DEMO_API";
  if (m === "BINANCE_FUTURES_TESTNET") m = "BINANCE_TESTNET";
  if (m === "BINANCE_TESTNET") {
    const creds = await resolveBinanceCredentials(accountId);
    const keyOpts = creds ? { apiKey: creds.apiKey, apiSecret: creds.secret } : {};
    let spot = null;
    let futures = null;
    try {
      spot = createBinanceTestnetSpotExchange({ log, ...keyOpts });
    } catch (e) {
      log?.warn?.("binance_testnet_spot_init_failed", { error: String(e?.message || e) });
    }
    try {
      futures = createBinanceFuturesTestnetUsdMExchange({ log, ...keyOpts });
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
    const creds = await resolveBinanceCredentials(accountId);
    const keyOpts = creds ? { apiKey: creds.apiKey, apiSecret: creds.secret } : {};
    const spot = createBinanceDemoSpotExchange({ log, ...keyOpts });
    let futures = null;
    try {
      futures = createBinanceDemoFuturesUsdMExchange({ log, ...keyOpts });
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
        "binance_live_not_enabled: set BINANCE_LIVE_TRADING_ENABLED=1 in backend/.env after reviewing real-funds and API-key risk.",
      );
    }
    const creds = await resolveBinanceCredentials(accountId);
    const keyOpts = creds ? { apiKey: creds.apiKey, apiSecret: creds.secret } : {};
    const spot = createBinanceLiveSpotExchange({ log, ...keyOpts });
    let futures = null;
    try {
      futures = createBinanceLiveFuturesUsdMExchange({ log, ...keyOpts });
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
  if (m === "PAPER") {
    const spot = createPaperExchange({ log });
    const futures = createPaperFuturesExchange({ log, name: "paper_futures" });
    log?.info?.("paper_exchange_hybrid", {
      detail: "Local spot + USD-M sim; public Binance candles come from bot feed (see PAPER_MARKET_FEED / MARKET_FEED). Headline equity sums both ledgers.",
    });
    return createHybridExchange({ spot, futures, log });
  }
  return createPaperExchange({ log });
}
