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
import { initPool, getPool } from "./db/pool.js";
import { ensurePaperSystemAccount } from "./db/ensurePaperSystemAccount.js";
import { ensureDefaultStrategies } from "./db/ensureDefaultStrategies.js";
import { backfillStrategyInstanceSplit } from "./db/backfillStrategyInstanceSplit.js";
import * as usersService from "./db/services/usersService.js";
import * as instanceService from "./db/services/instanceService.js";
import { tradingModeToPersistenceSlug } from "./lib/tradingModePersistence.js";
import { createAppState, modeSlugRequiresSelectedAccount } from "./state/appState.js";
import {
  createSessionMiddleware,
  createUiAuthRouter,
  requireUiAuth,
  runSessionForUpgrade,
  uiAuthEnabled,
  validateUiAuthEnv,
} from "./auth/uiGate.js";
import { createRouter } from "./transport/http.js";
import { sendTradingModesJson } from "./transport/tradingModesHandler.js";
import { attachWs, setTelegramTradeHook } from "./transport/ws.js";
import { createTelegramSidecar } from "./svc/telegram/telegramSidecar.js";
import { startWalletSnapshotPoller } from "./lib/walletSnapshotPoller.js";
import { startIntelligenceEngine } from "./intelligence/index.js";

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
await initPool(log);
try {
  if (getPool()) await ensurePaperSystemAccount({ log });
} catch (e) {
  log.warn("ensure_paper_system_account_failed", { error: String(e?.message || e) });
}
try {
  if (getPool()) await ensureDefaultStrategies({ log });
} catch (e) {
  log.warn("ensure_default_strategies_failed", { error: String(e?.message || e) });
}
try {
  if (getPool()) await backfillStrategyInstanceSplit({ log });
} catch (e) {
  log.warn("backfill_strategy_instance_split_failed", { error: String(e?.message || e) });
}
const appState = createAppState({ log });
try {
  if (getPool()) {
    const uid = await usersService.getFirstActiveUserId();
    if (uid) {
      const prefs = await usersService.getUiPrefsByUserId(uid);
      appState.hydrateActiveAccountByMode(prefs);
      appState.hydrateActiveStrategyVersionByMode(prefs);
      appState.hydrateActiveInstanceByMode(prefs);
      try {
        await instanceService.syncSidebarFromActiveInstances(appState);
      } catch (e) {
        log.warn("sync_active_instance_sidebar_failed", { error: String(e?.message || e) });
      }
    }
  }
} catch (e) {
  log.warn("hydrate_active_account_by_mode_failed", { error: String(e?.message || e) });
}
try {
  await appState.ensureInitialEngine();
} catch (e) {
  log.warn("ensure_initial_engine_failed", {
    error: String(e?.message || e),
    hint: "Engines will initialize on first /api or WS use",
  });
}
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
  /** Default high enough for WS-down polling (/api/state + /api/ai/health every 4s) plus charts without false 429s. */
  const apiRateMax = Math.max(20, Number(process.env.API_RATE_LIMIT_MAX || 2000));
  app.use(
    "/api",
    rateLimit({
      windowMs: apiRateWindowMs,
      max: apiRateMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: "rate_limited" },
      /** Login + `/api/auth/me` bootstrap share this bucket with chart/state polling; excluding auth avoids false 429s and long retries. */
      skip: (req) => {
        const u = String(req.originalUrl || req.url || "").split("?")[0];
        return u.startsWith("/api/auth");
      },
    }),
  );
}

let sessionMiddleware = null;
if (uiAuthEnabled()) {
  sessionMiddleware = createSessionMiddleware({ log, pool: getPool() });
  app.use(sessionMiddleware);
}

/** Liveness only — never include bot, exchange, or AI details (those belong in authenticated /api/state). */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** DB connectivity (no secrets). Omit detailed errors in production if desired. */
app.get("/health/db", async (_req, res) => {
  const pool = getPool();
  if (!pool) {
    return res.json({ ok: true, db: "skipped", hint: "DATABASE_URL not set" });
  }
  try {
    const r = await pool.query("SELECT 1 AS ok");
    return res.json({ ok: true, db: "up", result: r.rows[0] });
  } catch (e) {
    return res.status(503).json({ ok: false, db: "down", error: String(e?.message || e) });
  }
});

app.use("/api/auth", createUiAuthRouter({ log }));
/** Public: same payload as DB-backed modes (login UI / tooling) — no secrets. */
app.get("/api/trading-modes", (_req, res) => sendTradingModesJson(res));
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
  const pollMs = Number(process.env.WALLET_SNAPSHOT_POLL_MS || 60_000);
  startWalletSnapshotPoller(appState, log, pollMs);
  startIntelligenceEngine(appState.wsHub);
  if (truthyProxy(process.env.BOT_START_ON_BOOT)) {
    void (async () => {
      try {
        const m = appState.mode;
        const slug = tradingModeToPersistenceSlug(m);
        if (modeSlugRequiresSelectedAccount(slug) && !appState.getActiveAccount(slug)) {
          log.warn("bot_start_on_boot_skipped_no_account", { mode: m, slug });
          return;
        }
        await appState.ensureEngine(m);
        appState.bot.start({
          wsHub: appState.wsHub,
          reason: "boot_env",
          source: "env",
        });
        log.info("bot_start_on_boot");
      } catch (e) {
        log.warn("bot_start_on_boot_failed", { error: String(e?.message || e) });
      }
    })();
  }
  telegramSidecar.start();
};
if (listenHost) {
  server.listen(PORT, listenHost, onListen);
} else {
  server.listen(PORT, onListen);
}

