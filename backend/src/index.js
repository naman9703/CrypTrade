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
import { WebSocketServer } from "ws";

import { createLogger } from "./lib/logger.js";
import { createAppState } from "./state/appState.js";
import { createRouter } from "./transport/http.js";
import { attachWs } from "./transport/ws.js";

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

const log = createLogger();
process.on("unhandledRejection", (err) => {
  log.error("unhandled_rejection", { error: String(err?.message || err) });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { error: String(err?.message || err) });
});
const appState = createAppState({ log });

const app = express();
app.use(
  cors({
    origin: FRONTEND_ORIGINS.length === 1 ? FRONTEND_ORIGINS[0] : FRONTEND_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: appState.mode,
    bot: appState.bot.getPublicState(),
    ai: { baseUrl: appState.ai.baseUrl },
    exchange: { name: appState.exchange?.name || null, storeInfo: appState.exchange?.storeInfo || null },
  });
});

app.use("/api", createRouter({ appState }));

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
const wss = new WebSocketServer({ server, path: "/ws" });
attachWs({ wss, appState });

const listenHost = process.env.LISTEN_HOST;
const onListen = () => {
  log.info("server_listening", {
    port: PORT,
    host: listenHost || "default",
    wsPath: "/ws",
    marketFeed: String(process.env.MARKET_FEED || "SYNTH").toUpperCase(),
    serveFrontend: Boolean(serveFrontend && fs.existsSync(distPath)),
  });
};
if (listenHost) {
  server.listen(PORT, listenHost, onListen);
} else {
  server.listen(PORT, onListen);
}

