/**
 * AES-256-GCM helpers for stored API secrets (`api_credentials.secret_enc`).
 *
 * Wire format: `iv:authTag:ciphertext` (each segment base64url-safe base64, no wrapping).
 *
 * Generate a key (32 bytes, base64) and set `API_CREDENTIALS_ENCRYPTION_KEY`:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Or 64 hex chars:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function loadKey() {
  const raw = String(process.env.API_CREDENTIALS_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error("API_CREDENTIALS_ENCRYPTION_KEY is not set");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length === KEY_LEN) return buf;
  throw new Error("API_CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex chars)");
}

/**
 * @param {string} plain
 * @returns {string}
 */
export function encryptSecret(plain) {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(":");
}

/**
 * @param {string} stored
 * @returns {string}
 */
export function decryptSecret(stored) {
  const key = loadKey();
  const parts = String(stored || "").split(":");
  if (parts.length !== 3) {
    throw new Error("invalid_ciphertext_format");
  }
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const data = Buffer.from(parts[2], "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN || !data.length) {
    throw new Error("invalid_ciphertext_segments");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
