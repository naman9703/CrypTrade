import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";

process.env.API_CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { encryptSecret, decryptSecret } = await import("./encryption.js");

test("encryptSecret round-trips decryptSecret", () => {
  const plain = "my-api-secret";
  const enc = encryptSecret(plain);
  const parts = enc.split(":");
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(decryptSecret(enc), plain);
});

test("decryptSecret rejects malformed payload", () => {
  assert.throws(() => decryptSecret("nope"), /invalid_ciphertext/);
});
