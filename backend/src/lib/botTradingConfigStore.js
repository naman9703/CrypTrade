import fs from "fs";
import path from "path";
import {
  getTradingModePersistenceSlug,
  maybeMigrateLegacyModeFiles,
  resolveModeDataRootDir,
} from "./tradingModePersistence.js";

/** @param {string} [persistenceSlug] data/modes/<slug>/bot-trading-config.json */
export function resolveBotTradingConfigPath(persistenceSlug) {
  const raw = process.env.BOT_TRADING_CONFIG_PATH;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug =
    persistenceSlug != null && String(persistenceSlug).trim()
      ? String(persistenceSlug).trim()
      : getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeDataRootDir(), slug, "bot-trading-config.json");
}

/** @param {string} [persistenceSlug] @returns {object | null} */
export function readBotTradingConfig(persistenceSlug) {
  const p = resolveBotTradingConfigPath(persistenceSlug);
  try {
    const txt = fs.readFileSync(p, "utf8");
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

/** @param {object} payload @param {string} [persistenceSlug] */
export function writeBotTradingConfig(payload, persistenceSlug) {
  const p = resolveBotTradingConfigPath(persistenceSlug);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
}
