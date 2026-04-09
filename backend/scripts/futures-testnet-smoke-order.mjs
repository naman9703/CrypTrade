#!/usr/bin/env node
/**
 * One-shot USD-M futures testnet MARKET order via `binanceFuturesTestnetUsdM` (same path as the bot).
 *
 * Usage:
 *   cd backend && node scripts/futures-testnet-smoke-order.mjs [SYMBOL] [BUY|SELL]
 *
 * Env (backend/.env):
 *   BINANCE_FUTURES_API_KEY / BINANCE_FUTURES_API_SECRET — futures testnet keys
 *   BINANCE_FUTURES_TESTNET_REST_BASE — default https://testnet.binancefuture.com
 *   FUTURES_SMOKE_QTY — base qty (default 0.002 BTC)
 *   FUTURES_SMOKE_SL_PCT / FUTURES_SMOKE_TP_PCT — bracket distance (default 2% each)
 */
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const base = process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com";

async function main() {
  const symbol = (process.argv[2] || "BTCUSDT").toUpperCase();
  const sideArg = (process.argv[3] || "BUY").toUpperCase();
  const side = sideArg === "SELL" ? "SELL" : "BUY";

  const key = process.env.BINANCE_FUTURES_API_KEY || "";
  const secret = process.env.BINANCE_FUTURES_API_SECRET || "";
  if (!key || !secret) {
    console.error(
      "Missing BINANCE_FUTURES_API_KEY or BINANCE_FUTURES_API_SECRET in backend/.env.\n" +
        "Create keys at https://testnet.binancefuture.com/ and paste them (not mainnet keys).",
    );
    process.exit(1);
  }

  const { data: tick } = await axios.get(`${base}/fapi/v1/ticker/price`, {
    params: { symbol },
    timeout: 15_000,
  });
  const px = Number(tick?.price);
  if (!Number.isFinite(px) || px <= 0) {
    console.error("Bad ticker response:", tick);
    process.exit(1);
  }

  const { createBinanceFuturesTestnetUsdMExchange } = await import(
    "../src/svc/exchange/binanceFuturesTestnetUsdM.js"
  );
  const log = {
    info: (...a) => console.log("[info]", ...a),
    warn: (...a) => console.warn("[warn]", ...a),
  };
  const ex = createBinanceFuturesTestnetUsdMExchange({ log });

  const slPct = Number(process.env.FUTURES_SMOKE_SL_PCT || 0.02);
  const tpPct = Number(process.env.FUTURES_SMOKE_TP_PCT || 0.02);
  const qty = Number(process.env.FUTURES_SMOKE_QTY || 0.002);

  let stopLoss;
  let takeProfit;
  if (side === "BUY") {
    stopLoss = px * (1 - slPct);
    takeProfit = px * (1 + tpPct);
  } else {
    stopLoss = px * (1 + slPct);
    takeProfit = px * (1 - tpPct);
  }

  console.log("Futures testnet smoke:", { symbol, side, qty, refPrice: px, stopLoss, takeProfit, base });

  const out = await ex.placeOrder({
    symbol,
    side,
    qty,
    price: px,
    stopLoss,
    takeProfit,
    strategy: "SMOKE_TEST",
    meta: { smokeTest: true },
  });

  console.log("placeOrder OK:", JSON.stringify(out, null, 2));
  console.log("Tip: set app mode to BINANCE_TESTNET + FUTURES + start bot to trade from UI.");
}

main().catch((e) => {
  const body = e?.response?.data;
  if (body) console.error("API error:", JSON.stringify(body, null, 2));
  else console.error(e?.message || e);
  process.exit(1);
});
