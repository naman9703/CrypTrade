import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import * as usersService from "../db/services/usersService.js";

/** Valid bcrypt of "__no_user_match__" — used so bcrypt.compare always runs (no email oracle). */
const BCRYPT_NO_USER_PLACEHOLDER = "$2b$12$fDmbJ2juUJ.mNaCFylelnudb3Tlhj4Q05rpRmSP6SdHM5vbHZr30W";

/** @type {Array<{ emailNorm: string, hash: string }>} */
let uiAuthUsersCache = [];

const SESSION_NAME = "trading.sid";

/** Default browser session length when `APP_UI_AUTH_SESSION_MS` is unset (24 hours). */
const DEFAULT_UI_AUTH_SESSION_MS = 24 * 60 * 60 * 1000;
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
  const dbUrl = String(process.env.DATABASE_URL || "").trim();
  if (!users.length && !dbUrl) {
    log.error("app_ui_auth_misconfigured", {
      hint:
        "No UI users: set APP_UI_AUTH_EMAIL + APP_UI_AUTH_PASSWORD_HASH and/or numbered _1.._N, or set DATABASE_URL and run npm run db:seed-admin. Run: node scripts/hash-ui-password.mjs",
    });
    process.exit(1);
  }
  if (!users.length && dbUrl) {
    log.warn("app_ui_auth_env_users_empty", {
      hint: "Using DATABASE_URL: log in with users in the `users` table (see npm run db:seed-admin). Env password hashes optional.",
    });
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

/**
 * @param {{ log: import('../lib/logger.js').Logger, pool?: import('pg').Pool | null }} opts
 * When `pool` is set, sessions persist in `express_sessions` (migration 015 + connect-pg-simple).
 */
export function createSessionMiddleware({ log, pool }) {
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
  const sessionMsRaw = String(process.env.APP_UI_AUTH_SESSION_MS ?? "").trim();
  const sessionMsParsed = sessionMsRaw !== "" ? Number(sessionMsRaw) : DEFAULT_UI_AUTH_SESSION_MS;
  const cookieMaxAge =
    Number.isFinite(sessionMsParsed) && sessionMsParsed > 0 ? sessionMsParsed : DEFAULT_UI_AUTH_SESSION_MS;

  const sessionOpts = {
    name: SESSION_NAME,
    secret,
    resave: false,
    saveUninitialized: false,
    /** Reset `Set-Cookie` expiry on each response so active users keep the full window (idle timeout = maxAge). */
    rolling: true,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: "lax",
      maxAge: cookieMaxAge,
      path: "/",
    },
  };

  if (pool) {
    const PgSession = connectPgSimple(session);
    log.info?.("session_store_pg", { table: "express_sessions" });
    return session({
      ...sessionOpts,
      store: new PgSession({
        pool,
        tableName: "express_sessions",
        createTableIfMissing: false,
      }),
    });
  }
  log.warn?.("session_store_memory", { hint: "Set DATABASE_URL for restart-safe sessions (express_sessions)." });
  return session(sessionOpts);
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
const loginHttpRateLimitOff =
  truthyEnv(process.env.LOGIN_HTTP_RATE_LIMIT_DISABLED) ||
  String(process.env.LOGIN_HTTP_RATE_LIMIT_MAX ?? "").trim() === "0";
const loginRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(6, Math.min(120, Number(process.env.LOGIN_HTTP_RATE_LIMIT_MAX || 60))),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});

/** @param {{ log: import('../lib/logger.js').Logger }} opts */
export function createUiAuthRouter({ log }) {
  const r = express.Router();

  r.get("/me", (req, res) => {
    if (!uiAuthEnabled()) {
      return res.json({
        ok: true,
        enabled: false,
        authenticated: true,
        uiUserTag: null,
        uiTradingMode: null,
        syncUiPrefs: false,
        uiUserRole: null,
      });
    }
    const ok = Boolean(req.session?.uiAuthOk);
    res.json({
      ok: true,
      enabled: true,
      authenticated: ok,
      uiUserTag: ok && req.session?.uiUserTag ? String(req.session.uiUserTag) : null,
      uiTradingMode: ok && req.session?.uiTradingMode ? String(req.session.uiTradingMode) : null,
      syncUiPrefs: ok && Boolean(req.session?.uiUserId),
      uiUserRole: ok && req.session?.uiUserRole ? String(req.session.uiUserRole) : null,
    });
  });

  r.post("/login", loginHttpRateLimitOff ? ((_req, _res, next) => next()) : loginRouteLimiter, async (req, res) => {
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
    const emailNorm = String(parsed.data.email || "")
      .toLowerCase()
      .trim();

    let passOk = false;
    let matchedEnv = false;
    /** @type {Awaited<ReturnType<typeof usersService.findUserByUsername>> | null} */
    let dbUserForSession = null;

    const pool = getPool();
    if (pool) {
      try {
        const dbUser = await usersService.findUserByUsername(emailNorm);
        if (dbUser) {
          try {
            passOk = await usersService.validatePassword(dbUser, password);
          } catch (e) {
            log.warn("ui_login_bcrypt_error", { error: String(e?.message || e), source: "db" });
          }
          if (!passOk) {
            recordFailure(ip);
            await bcrypt.hash(String(password + "hmac"), 4).catch(() => {});
            return res.status(401).json({ ok: false, error: "invalid_credentials" });
          }
          dbUserForSession = dbUser;
          matchedEnv = true; // reuse flow below (session regenerate)
        }
      } catch (e) {
        log.warn("ui_login_db_error", { error: String(e?.message || e) });
        return res.status(503).json({ ok: false, error: "auth_backend_unavailable" });
      }
    }

    if (!matchedEnv) {
      const users = uiAuthUsersCache;
      let matchedHash = null;
      for (const u of users) {
        if (emailsMatch(u.emailNorm, email)) {
          matchedHash = u.hash;
          break;
        }
      }
      const hashForCompare = matchedHash || BCRYPT_NO_USER_PLACEHOLDER;
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

      /**
       * Env-only login has no `users.id` until a row exists — accounts/strategies then return
       * `db_user_required`. Auto-provision so the session owns DB rows (same email/password).
       */
      if (pool) {
        try {
          let u = await usersService.findUserByUsername(emailNorm);
          if (!u) {
            try {
              u = await usersService.createUser(emailNorm, password, "admin");
              log.info("ui_login_auto_provisioned_db_user", { email: emailNorm });
            } catch (createErr) {
              if (createErr?.code === "23505") {
                u = await usersService.findUserByUsername(emailNorm);
              } else {
                throw createErr;
              }
            }
          }
          if (u) dbUserForSession = u;
        } catch (e) {
          log.warn("ui_login_auto_provision_failed", { error: String(e?.message || e) });
        }
      }
    }

    recordSuccess(ip);
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        log.warn("ui_login_regenerate", { error: String(regenErr?.message || regenErr) });
        return res.status(500).json({ ok: false, error: "session_error" });
      }
      req.session.uiAuthOk = true;
      req.session.uiAuthAt = Date.now();
      req.session.uiUserTag = crypto.createHash("sha256").update(emailNorm).digest("hex").slice(0, 24);
      req.session.uiAuthEmailNorm = emailNorm;
      if (dbUserForSession) {
        req.session.uiUserId = dbUserForSession.id;
        req.session.uiUserRole = String(dbUserForSession.role || "user");
      } else {
        delete req.session.uiUserId;
        req.session.uiUserRole = "admin";
      }
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

/** Credential routes: UI auth must be on; session must be admin (DB role or env-login operator). */
export function requireAdmin(req, res, next) {
  if (!uiAuthEnabled()) {
    return res.status(403).json({ ok: false, error: "ui_auth_required" });
  }
  if (!req.session?.uiAuthOk) {
    return res.status(401).json({ ok: false, error: "auth_required" });
  }
  if (String(req.session.uiUserRole || "") !== "admin") {
    return res.status(403).json({ ok: false, error: "admin_required" });
  }
  return next();
}

/**
 * `/api/me/ui-prefs`, strategies, instances, etc. need a `users.id`.
 * - DB email/password login sets `session.uiUserId`.
 * - Env-only admin (`APP_UI_AUTH_*` without a matching `users` row) has no `uiUserId`; use first active user (same as accounts dev fallback).
 * - UI auth off: same implicit user for local/dev parity with `resolveAccountsOwnerUserId`.
 */
export function requireDbUserSession(req, res, next) {
  if (req.session?.uiUserId != null && String(req.session.uiUserId).trim() !== "") return next();
  void (async () => {
    try {
      if (!getPool()) {
        res.status(503).json({ ok: false, error: "db_not_configured" });
        return;
      }
      const allowImplicit =
        !uiAuthEnabled() ||
        (uiAuthEnabled() &&
          req.session?.uiAuthOk &&
          String(req.session.uiUserRole || "") === "admin" &&
          !req.session?.uiUserId);
      if (!allowImplicit) {
        res.status(403).json({ ok: false, error: "db_user_required" });
        return;
      }
      const uid = await usersService.getFirstActiveUserId();
      if (uid) {
        req.dbActingUserId = String(uid);
        next();
        return;
      }
    } catch {
      /* fall through */
    }
    res.status(403).json({ ok: false, error: "db_user_required" });
  })().catch(() => res.status(500).json({ ok: false, error: "db_user_resolve_failed" }));
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
