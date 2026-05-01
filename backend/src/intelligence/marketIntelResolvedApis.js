import * as usersService from '../db/services/usersService.js';
import { decryptSecret } from '../lib/encryption.js';

/** @typedef {{ finnhubApiKey: string, cryptoquantApiKey: string, whaleAlertApiKey: string, aiBaseUrl: string }} ResolvedApis */

function fromEnv() {
  return {
    finnhubApiKey: String(process.env.FINNHUB_API_KEY ?? '').trim(),
    cryptoquantApiKey: String(process.env.CRYPTOQUANT_API_KEY ?? '').trim(),
    whaleAlertApiKey: String(process.env.WHALE_ALERT_API_KEY ?? '').trim(),
    aiBaseUrl: String(process.env.AI_BASE_URL || 'http://127.0.0.1:8001').replace(/\/$/, ''),
  };
}

/** @type {ResolvedApis} */
let _resolved = fromEnv();

/**
 * Merge env + decrypted ui_prefs (`marketIntelProvidersCipher` on first active user).
 * Stored values override env when non-empty.
 */
export async function refreshMarketIntelApisFromStore() {
  const env = fromEnv();
  let stored = {};
  try {
    const uid = await usersService.getFirstActiveUserId();
    if (uid) {
      const prefs = await usersService.getUiPrefsByUserId(uid);
      const c = prefs.marketIntelProvidersCipher;
      if (typeof c === 'string' && c.length > 5) {
        try {
          stored = JSON.parse(decryptSecret(c));
        } catch {
          stored = {};
        }
      }
    }
  } catch {
    stored = {};
  }

  const pick = (k) => {
    const v = stored[k];
    return typeof v === 'string' && v.trim() ? v.trim() : env[k];
  };

  _resolved = {
    finnhubApiKey: pick('finnhubApiKey'),
    cryptoquantApiKey: pick('cryptoquantApiKey'),
    whaleAlertApiKey: pick('whaleAlertApiKey'),
    aiBaseUrl:
      typeof stored.aiBaseUrl === 'string' && stored.aiBaseUrl.trim()
        ? stored.aiBaseUrl.trim().replace(/\/$/, '')
        : env.aiBaseUrl,
  };
}

/** @returns {ResolvedApis} */
export function getResolvedMarketIntelApis() {
  return { ..._resolved };
}

export function marketIntelEncryptionKeyConfigured() {
  const raw = String(process.env.API_CREDENTIALS_ENCRYPTION_KEY || '').trim();
  return raw.length > 0;
}
