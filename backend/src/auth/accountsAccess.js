import { uiAuthEnabled } from "./uiGate.js";
import { getPool } from "../db/pool.js";
import * as usersService from "../db/services/usersService.js";

export function requireAccountsDbUser(req, res, next) {
  if (!uiAuthEnabled()) return next();
  if (req.session?.uiUserId) return next();
  /** Env-only operator: same session shape as `requireDbUserSession` implicit user. */
  if (req.session?.uiAuthOk && String(req.session.uiUserRole || "") === "admin") return next();
  return res.status(403).json({ ok: false, error: "db_user_required" });
}

/**
 * Owner for account rows when UI auth is off (dev): first active user.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<string | null>} user UUID or null if response already sent
 */
export async function resolveAccountsOwnerUserId(req, res) {
  if (req.session?.uiUserId) return req.session.uiUserId;
  if (getPool()) {
    try {
      const allowImplicit =
        !uiAuthEnabled() ||
        (uiAuthEnabled() &&
          req.session?.uiAuthOk &&
          String(req.session.uiUserRole || "") === "admin" &&
          !req.session?.uiUserId);
      if (allowImplicit) {
        const uid = await usersService.getFirstActiveUserId();
        if (uid) return uid;
      }
    } catch {
      /* ignore */
    }
  }
  res.status(403).json({ ok: false, error: "db_user_required" });
  return null;
}

/**
 * For routes that are not behind `requireDbUserSession` (e.g. bot start) but need a `users.id` for DB helpers.
 */
export async function resolveDbActingUserId(req) {
  if (req.session?.uiUserId != null && String(req.session.uiUserId).trim() !== "") return String(req.session.uiUserId);
  if (req.dbActingUserId != null && String(req.dbActingUserId).trim() !== "") return String(req.dbActingUserId);
  if (!getPool()) return null;
  const allowImplicit =
    !uiAuthEnabled() ||
    (uiAuthEnabled() &&
      req.session?.uiAuthOk &&
      String(req.session.uiUserRole || "") === "admin" &&
      !req.session?.uiUserId);
  if (!allowImplicit) return null;
  const uid = await usersService.getFirstActiveUserId();
  return uid ? String(uid) : null;
}

/**
 * Env-only session (admin, no uiUserId) may mutate any non-system account.
 * @param {import('express').Request} req
 * @param {{ account_type?: string, user_id?: string }} row
 * @param {string} [ownerUserId] dev implicit owner when UI auth is off
 */
export function assertAccountMutable(req, row, ownerUserId) {
  if (!row) return "not_found";
  if (String(row.account_type || "") === "system") return "system_readonly";
  if (String(req.session?.uiUserRole || "") === "admin" && !req.session?.uiUserId) return null;
  if (req.session?.uiUserId) return row.user_id === req.session.uiUserId ? null : "forbidden";
  if (!uiAuthEnabled() && ownerUserId) return row.user_id === ownerUserId ? null : "forbidden";
  return "forbidden";
}

/**
 * @param {import('express').Request} req
 * @param {{ account_type?: string, user_id?: string, mode_slug?: string }} row
 * @param {string} ownerUserId
 */
export function assertAccountVisible(req, row, ownerUserId) {
  if (!row) return "not_found";
  if (row.user_id === ownerUserId) return null;
  if (String(row.mode_slug || "") === "paper" && String(row.account_type || "") === "system") return null;
  if (String(req.session?.uiUserRole || "") === "admin" && !req.session?.uiUserId) return null;
  if (!uiAuthEnabled() && ownerUserId && row.user_id === ownerUserId) return null;
  return "forbidden";
}
