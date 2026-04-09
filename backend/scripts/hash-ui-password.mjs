#!/usr/bin/env node
/**
 * Print a bcrypt hash for APP_UI_AUTH_PASSWORD_HASH.
 * Usage: node scripts/hash-ui-password.mjs
 *        APP_UI_PASSWORD='your-secret' node scripts/hash-ui-password.mjs
 *
 * Uses 12 rounds (adjust via BCRYPT_ROUNDS).
 */
import bcrypt from "bcrypt";
import readline from "readline";

const rounds = Math.max(10, Math.min(14, Number(process.env.BCRYPT_ROUNDS || 12)));

async function main() {
  let plain = process.env.APP_UI_PASSWORD;
  if (typeof plain === "string") plain = plain.trim();
  else plain = "";

  if (plain) {
    console.error("hash-ui-password: using APP_UI_PASSWORD from the environment (interactive prompt skipped).\n");
  } else if (!process.stdin.isTTY) {
    console.error("hash-ui-password: no interactive terminal (stdin is not a TTY), so there is no password prompt.");
    console.error("Run one of:");
    console.error("  APP_UI_PASSWORD='your-secret-here' node scripts/hash-ui-password.mjs");
    console.error("  Or use a real terminal: Terminal.app / iTerm and run the same command without APP_UI_PASSWORD.");
    process.exit(1);
  } else {
    console.error("hash-ui-password: type your UI login password (min 8 chars) and press Enter.");
    console.error("Tip: characters echo to the terminal. For no echo, use:");
    console.error("  APP_UI_PASSWORD='…' node scripts/hash-ui-password.mjs\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    plain = await new Promise((resolve) => {
      rl.question("Password: ", (ans) => {
        rl.close();
        resolve(ans ?? "");
      });
    });
  }
  if (!plain || plain.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const hash = await bcrypt.hash(plain, rounds);
  console.log("\nAdd to backend .env:\n  APP_UI_AUTH_PASSWORD_HASH=" + hash + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
