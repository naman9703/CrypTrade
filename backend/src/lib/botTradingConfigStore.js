import fs from "fs";
import path from "path";
import {
  getTradingModePersistenceSlug,
  maybeMigrateLegacyModeFiles,
  resolveModeScopedDir,
} from "./tradingModePersistence.js";

export function resolveBotTradingConfigPath() {
  const raw = process.env.BOT_TRADING_CONFIG_PATH;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeScopedDir(), "bot-trading-config.json");
}

/** @returns {object | null} */
export function readBotTradingConfig() {
  const p = resolveBotTradingConfigPath();
  try {
    const txt = fs.readFileSync(p, "utf8");
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

/** @param {object} payload */
export function writeBotTradingConfig(payload) {
  const p = resolveBotTradingConfigPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
}
