import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Ensure we always load backend/.env even if started from repo root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Do not override vars already set in the shell (e.g. PORT=8020 node src/index.js).
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";

import { createLogger } from "./lib/logger.js";
import { setTelegramActivityHook } from "./lib/activityLog.js";
import { createAppState } from "./state/appState.js";
import {
  createSessionMiddleware,
  createUiAuthRouter,
  requireUiAuth,
  runSessionForUpgrade,
  uiAuthEnabled,
  validateUiAuthEnv,
} from "./auth/uiGate.js";
import { createRouter } from "./transport/http.js";
import { attachWs, setTelegramTradeHook } from "./transport/ws.js";
import { createTelegramSidecar } from "./svc/telegram/telegramSidecar.js";

const PORT = Number(process.env.PORT || 8000);
function expandFrontendOrigins(raw) {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(list);
  for (const o of list) {
    try {
      const u = new URL(o);
      if (u.hostname === "localhost") {
        set.add(`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ""}`);
      } else if (u.hostname === "127.0.0.1") {
        set.add(`${u.protocol}//localhost${u.port ? `:${u.port}` : ""}`);
      }
    } catch {
      // ignore invalid URL
    }
  }
  return [...set];
}
const railwayPublic =
  process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const FRONTEND_ORIGINS = expandFrontendOrigins(
  process.env.FRONTEND_ORIGIN ||
    railwayPublic ||
    "http://localhost:5173,http://127.0.0.1:5173",
);

function truthyProxy(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function truthyEnv(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

const log = createLogger();
validateUiAuthEnv(log);
process.on("unhandledRejection", (err) => {
  log.error("unhandled_rejection", { error: String(err?.message || err) });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { error: String(err?.message || err) });
});
const appState = createAppState({ log });
const telegramSidecar = createTelegramSidecar({ log, appState });
setTelegramActivityHook((p) => telegramSidecar.notifyActivity(p));
setTelegramTradeHook((p) => telegramSidecar.notifyTrade(p));

const app = express();
{
  const tpRaw = String(process.env.TRUST_PROXY ?? "").trim().toLowerCase();
  const trustProxyOff = tpRaw === "0" || tpRaw === "false" || tpRaw === "no";
  if (
    !trustProxyOff &&
    (truthyProxy(process.env.TRUST_PROXY) || process.env.NODE_ENV === "production")
  ) {
    app.set("trust proxy", 1);
  }
}

/** Baseline security headers. CSP disabled so Vite/React SPA (if SERVE_FRONTEND) and JSON API stay compatible. */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: FRONTEND_ORIGINS.length === 1 ? FRONTEND_ORIGINS[0] : FRONTEND_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));

const apiRateLimitOff =
  truthyEnv(process.env.API_RATE_LIMIT_DISABLED) || String(process.env.API_RATE_LIMIT_MAX ?? "").trim() === "0";
if (apiRateLimitOff) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    log.warn("api_rate_limit_disabled", { hint: "Re-enable for public hosts (API_RATE_LIMIT_DISABLED unset, API_RATE_LIMIT_MAX>0)" });
  }
} else {
  const apiRateWindowMs = Math.max(60_000, Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000));
  const apiRateMax = Math.max(20, Number(process.env.API_RATE_LIMIT_MAX || 400));
  app.use(
    "/api",
    rateLimit({
      windowMs: apiRateWindowMs,
      max: apiRateMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: "rate_limited" },
    }),
  );
}

let sessionMiddleware = null;
if (uiAuthEnabled()) {
  sessionMiddleware = createSessionMiddleware({ log });
  app.use(sessionMiddleware);
}

/** Liveness only — never include bot, exchange, or AI details (those belong in authenticated /api/state). */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", createUiAuthRouter({ log }));
app.use("/api", requireUiAuth, createRouter({ appState }));

const distPath = path.resolve(__dirname, "..", "..", "frontend", "dist");
const serveFrontend =
  String(process.env.SERVE_FRONTEND || "").toLowerCase() === "1" ||
  String(process.env.SERVE_FRONTEND || "").toLowerCase() === "true";
if (serveFrontend && fs.existsSync(distPath)) {
  app.use(express.static(distPath, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distPath, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
attachWs({ wss, appState });

server.on("upgrade", (request, socket, head) => {
  let pathname = "/";
  try {
    const host = request.headers.host || "localhost";
    pathname = new URL(request.url || "/", `http://${host}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  if (!uiAuthEnabled() || !sessionMiddleware) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }

  runSessionForUpgrade(request, sessionMiddleware, () => {
    if (!request.session?.uiAuthOk) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
});

const listenHost = process.env.LISTEN_HOST;
const onListen = () => {
  log.info("server_listening", {
    port: PORT,
    host: listenHost || "default",
    wsPath: "/ws",
    marketFeed: String(process.env.MARKET_FEED || "SYNTH").toUpperCase(),
    serveFrontend: Boolean(serveFrontend && fs.existsSync(distPath)),
  });
  if (truthyProxy(process.env.BOT_START_ON_BOOT)) {
    try {
      appState.bot.start({
        wsHub: appState.wsHub,
        reason: "boot_env",
        source: "env",
      });
      log.info("bot_start_on_boot");
    } catch (e) {
      log.warn("bot_start_on_boot_failed", { error: String(e?.message || e) });
    }
  }
  telegramSidecar.start();
};
if (listenHost) {
  server.listen(PORT, listenHost, onListen);
} else {
  server.listen(PORT, onListen);
}

