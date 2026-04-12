import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";

/** Valid bcrypt of "__no_user_match__" — used so bcrypt.compare always runs (no email oracle). */
const BCRYPT_NO_USER_PLACEHOLDER = "$2b$12$fDmbJ2juUJ.mNaCFylelnudb3Tlhj4Q05rpRmSP6SdHM5vbHZr30W";

/** @type {Array<{ emailNorm: string, hash: string }>} */
let uiAuthUsersCache = [];

const SESSION_NAME = "trading.sid";
const LOGIN_BODY = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(500),
});

function truthyEnv(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function uiAuthEnabled() {
  return truthyEnv(process.env.APP_UI_AUTH_ENABLED);
}

function normalizedUrlPath(req) {
  let p = String(req.originalUrl || req.url || "").split("?")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Narrow routes that accept BOT_HTTP_API_KEY instead of a browser session (headless / scripts). */
function isBotHttpKeyBypassRoute(req) {
  const path = normalizedUrlPath(req);
  const m = req.method;
  if (m === "GET" && path === "/api/state") return true;
  if (m === "POST" && (path === "/api/bot/start" || path === "/api/bot/stop")) return true;
  return false;
}

function botHttpApiKeyMatches(req) {
  const want = String(process.env.BOT_HTTP_API_KEY || "").trim();
  if (!want || want.length < 16) return false;
  const got = String(req.headers["x-bot-api-key"] || "").trim();
  if (!got || got.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(want, "utf8"));
  } catch {
    return false;
  }
}

const MAX_NUMBERED_UI_USERS = 20;

/**
 * Merge users from APP_UI_AUTH_EMAIL_1..N + hashes and legacy APP_UI_AUTH_EMAIL + hash.
 * Same email: legacy pair wins last (overrides numbered slots).
 */
function loadUiAuthUsers() {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 1; i <= MAX_NUMBERED_UI_USERS; i++) {
    const em = String(process.env[`APP_UI_AUTH_EMAIL_${i}`] || "").toLowerCase().trim();
    const h = String(process.env[`APP_UI_AUTH_PASSWORD_HASH_${i}`] || "").trim();
    if (em && h.startsWith("$2")) map.set(em, h);
  }
  const legEm = String(process.env.APP_UI_AUTH_EMAIL || "").toLowerCase().trim();
  const legH = String(process.env.APP_UI_AUTH_PASSWORD_HASH || "").trim();
  if (legEm && legH.startsWith("$2")) map.set(legEm, legH);
  return [...map.entries()].map(([emailNorm, hash]) => ({ emailNorm, hash }));
}

export function validateUiAuthEnv(log) {
  const requireAuthProd =
    truthyEnv(process.env.REQUIRE_APP_UI_AUTH_IN_PRODUCTION) ||
    truthyEnv(process.env.ENFORCE_UI_AUTH_IN_PRODUCTION);
  if (process.env.NODE_ENV === "production" && requireAuthProd && !uiAuthEnabled()) {
    log.error("production_requires_ui_auth", {
      hint: "Set APP_UI_AUTH_ENABLED=1 and configure APP_UI_AUTH_EMAIL + APP_UI_AUTH_PASSWORD_HASH (or unset REQUIRE_APP_UI_AUTH_IN_PRODUCTION).",
    });
    process.exit(1);
  }
  if (!uiAuthEnabled()) {
    log.warn("app_ui_auth_disabled", {
      hint: "On any network you do not fully trust, set APP_UI_AUTH_ENABLED=1 — /api/* (except /api/auth/*), /ws, and an open /health body are otherwise reachable without login.",
    });
    return;
  }
  const botKey = String(process.env.BOT_HTTP_API_KEY || "").trim();
  if (botKey && botKey.length < 16) {
    log.warn("bot_http_api_key_short", { hint: "Use at least 16 random characters for BOT_HTTP_API_KEY" });
  }
  const users = loadUiAuthUsers();
  if (!users.length) {
    log.error("app_ui_auth_misconfigured", {
      hint:
        "No UI users: set APP_UI_AUTH_EMAIL + APP_UI_AUTH_PASSWORD_HASH and/or APP_UI_AUTH_EMAIL_1 + APP_UI_AUTH_PASSWORD_HASH_1 (… _2, _3). Run: node scripts/hash-ui-password.mjs",
    });
    process.exit(1);
  }
  uiAuthUsersCache = users;
  const sec = String(process.env.SESSION_SECRET || "").trim();
  if (process.env.NODE_ENV === "production" && sec.length < 32) {
    log.error("session_secret_required", {
      hint: "SESSION_SECRET must be at least 32 random bytes in production when APP_UI_AUTH_ENABLED=1",
    });
    process.exit(1);
  }
}

/** @param {{ log: import('../lib/logger.js').Logger }} opts */
export function createSessionMiddleware({ log }) {
  const secret =
    String(process.env.SESSION_SECRET || "").trim() ||
    (process.env.NODE_ENV === "production" ? null : "dev-only-insecure-session-secret-change-me");
  if (!secret) {
    log.error("session_secret_missing");
    process.exit(1);
  }
  // If COOKIE_SECURE is set, it wins (e.g. COOKIE_SECURE=0 for http://localhost over SSH tunnel while NODE_ENV=production).
  const rawCookieSecure = String(process.env.COOKIE_SECURE ?? "").trim();
  const firstFrontendOrigin = String(process.env.FRONTEND_ORIGIN || "")
    .split(",")[0]
    .trim();
  const secure =
    rawCookieSecure !== ""
      ? truthyEnv(process.env.COOKIE_SECURE)
      : process.env.NODE_ENV === "production"
        ? !firstFrontendOrigin.toLowerCase().startsWith("http://")
        : false;
  return session({
    name: SESSION_NAME,
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: "lax",
      maxAge: Number(process.env.APP_UI_AUTH_SESSION_MS || 7 * 24 * 60 * 60 * 1000),
      path: "/",
    },
  });
}

const attemptState = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_MAX = 12;

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function loginAllowed(ip) {
  const now = Date.now();
  let row = attemptState.get(ip);
  if (!row) return true;
  if (row.lockedUntil && now < row.lockedUntil) return false;
  if (row.windowStart && now - row.windowStart > ATTEMPT_WINDOW_MS) {
    attemptState.delete(ip);
    return true;
  }
  return row.count < ATTEMPT_MAX;
}

function recordFailure(ip) {
  const now = Date.now();
  let row = attemptState.get(ip);
  if (!row || !row.windowStart || now - row.windowStart > ATTEMPT_WINDOW_MS) {
    row = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  row.count += 1;
  if (row.count >= ATTEMPT_MAX) {
    row.lockedUntil = now + ATTEMPT_WINDOW_MS;
  }
  attemptState.set(ip, row);
}

function recordSuccess(ip) {
  attemptState.delete(ip);
}

function emailsMatch(expected, given) {
  const a = String(expected || "").toLowerCase().trim();
  const b = String(given || "").toLowerCase().trim();
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** HTTP-layer limit on POST /login per IP (complements in-memory lockout after failed attempts). */
const loginRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(6, Math.min(120, Number(process.env.LOGIN_HTTP_RATE_LIMIT_MAX || 24))),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

/** @param {{ log: import('../lib/logger.js').Logger }} opts */
export function createUiAuthRouter({ log }) {
  const r = express.Router();

  r.get("/me", (req, res) => {
    if (!uiAuthEnabled()) {
      return res.json({ ok: true, enabled: false, authenticated: true, uiUserTag: null, uiTradingMode: null });
    }
    const ok = Boolean(req.session?.uiAuthOk);
    res.json({
      ok: true,
      enabled: true,
      authenticated: ok,
      uiUserTag: ok && req.session?.uiUserTag ? String(req.session.uiUserTag) : null,
      uiTradingMode: ok && req.session?.uiTradingMode ? String(req.session.uiTradingMode) : null,
    });
  });

  r.post("/login", loginRouteLimiter, async (req, res) => {
    if (!uiAuthEnabled()) {
      return res.status(400).json({ ok: false, error: "auth_disabled" });
    }
    const ip = clientIp(req);
    if (!loginAllowed(ip)) {
      await bcrypt.hash("rate-limited", 4).catch(() => {});
      return res.status(429).json({ ok: false, error: "too_many_attempts" });
    }

    const parsed = LOGIN_BODY.safeParse(req.body);
    if (!parsed.success) {
      recordFailure(ip);
      return res.status(400).json({ ok: false, error: "invalid_body" });
    }

    const { email, password } = parsed.data;
    const users = uiAuthUsersCache;
    let matchedHash = null;
    for (const u of users) {
      if (emailsMatch(u.emailNorm, email)) {
        matchedHash = u.hash;
        break;
      }
    }
    const hashForCompare = matchedHash || BCRYPT_NO_USER_PLACEHOLDER;
    let passOk = false;
    try {
      passOk = await bcrypt.compare(password, hashForCompare);
    } catch (e) {
      log.warn("ui_login_bcrypt_error", { error: String(e?.message || e) });
    }

    if (!matchedHash || !passOk) {
      recordFailure(ip);
      await bcrypt.hash(String(password + "hmac"), 4).catch(() => {});
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    recordSuccess(ip);
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        log.warn("ui_login_regenerate", { error: String(regenErr?.message || regenErr) });
        return res.status(500).json({ ok: false, error: "session_error" });
      }
      req.session.uiAuthOk = true;
      req.session.uiAuthAt = Date.now();
      const emailNorm = String(parsed.data.email || "")
        .toLowerCase()
        .trim();
      req.session.uiUserTag = crypto.createHash("sha256").update(emailNorm).digest("hex").slice(0, 24);
      req.session.save((err) => {
        if (err) {
          log.warn("ui_login_session_save", { error: String(err?.message || err) });
          return res.status(500).json({ ok: false, error: "session_error" });
        }
        res.json({ ok: true });
      });
    });
  });

  r.post("/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        log.warn("ui_logout_error", { error: String(err?.message || err) });
        return res.status(500).json({ ok: false, error: "logout_failed" });
      }
      res.clearCookie(SESSION_NAME, { path: "/" });
      res.json({ ok: true });
    });
  });

  return r;
}

export function requireUiAuth(req, res, next) {
  if (!uiAuthEnabled()) return next();
  if (req.session?.uiAuthOk) return next();
  if (botHttpApiKeyMatches(req) && isBotHttpKeyBypassRoute(req)) return next();
  res.status(401).json({ ok: false, error: "auth_required" });
}

/**
 * Load session for a WebSocket upgrade request (no Express response writes).
 * @param {import('express').Request} req
 * @param {import('express').Handler} sessionMw
 * @param {() => void} next
 */
export function runSessionForUpgrade(req, sessionMw, next) {
  const fauxRes = {
    _headers: {},
    setHeader() {},
    getHeader() {
      return undefined;
    },
    writeHead() {},
    write() {},
    end(chunk, encoding, cb) {
      if (typeof cb === "function") cb();
      else if (typeof encoding === "function") encoding();
    },
  };
  sessionMw(req, fauxRes, next);
}
