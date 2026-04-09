/**
 * Per-mode data under data/modes/<slug>/: logs, trade-ws-events.jsonl, supertrend-signal-history.jsonl,
 * bot-trading-config, paper/testnet ledgers, demo futures sim, futures income sync — see resolveDefault* helpers.
 */
import fs from "fs";
import path from "path";

let activeSlug = "paper";

const SLUG_BY_MODE = {
  PAPER: "paper",
  BINANCE_DEMO_API: "demo_api",
  BINANCE_TESTNET: "testnet",
  BINANCE_LIVE: "live",
};

/** @param {string} [mode] TRADING_MODE value */
export function tradingModeToPersistenceSlug(mode) {
  const m = String(mode || "PAPER").toUpperCase();
  return SLUG_BY_MODE[m] || "paper";
}

/** Call whenever app `mode` is finalized (startup + after mode switch). */
export function setTradingModePersistenceSlug(mode) {
  activeSlug = tradingModeToPersistenceSlug(mode);
}

export function getTradingModePersistenceSlug() {
  return activeSlug;
}

/** Live/testnet balances & positions must come from Binance — never mix in local/paper fallbacks as if they were exchange truth. */
export function isStrictBinanceAccountMode(mode) {
  const m = String(mode || "").toUpperCase();
  return m === "BINANCE_LIVE" || m === "BINANCE_TESTNET";
}

export function resolveModeDataRootDir() {
  const raw = process.env.MODE_DATA_ROOT;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  return path.resolve(process.cwd(), "data", "modes");
}

export function resolveModeScopedDir() {
  return path.join(resolveModeDataRootDir(), getTradingModePersistenceSlug());
}

function migrateLegacyFile(legacyRel, destPath) {
  try {
    const legacy = path.isAbsolute(legacyRel)
      ? legacyRel
      : path.resolve(process.cwd(), legacyRel);
    if (!fs.existsSync(legacy) || fs.existsSync(destPath)) return;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(legacy, destPath);
  } catch {
    /* ignore */
  }
}

function migrateLegacyDirIfMissing(legacyRel, destDir) {
  try {
    const legacy = path.isAbsolute(legacyRel)
      ? legacyRel
      : path.resolve(process.cwd(), legacyRel);
    if (!fs.existsSync(legacy) || fs.existsSync(destDir)) return;
    if (!fs.statSync(legacy).isDirectory()) return;
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(legacy, destDir, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** One-time copy from single-file layout into data/modes/paper/ */
export function maybeMigrateLegacyModeFiles(slug) {
  if (slug !== "paper") return;
  const dir = path.join(resolveModeDataRootDir(), "paper");
  migrateLegacyFile(path.join("data", "activity-log.jsonl"), path.join(dir, "activity-log.jsonl"));
  migrateLegacyFile(path.join("data", "trade-ws-events.jsonl"), path.join(dir, "trade-ws-events.jsonl"));
  migrateLegacyFile(path.join("data", "bot-trading-config.json"), path.join(dir, "bot-trading-config.json"));
}

export function maybeMigrateLegacyPaperStore(destDir) {
  migrateLegacyDirIfMissing(path.join("data", "paper"), destDir);
}

export function maybeMigrateLegacyTestnetStore(destDir) {
  migrateLegacyDirIfMissing(path.join("data", "binance-testnet"), destDir);
}

export function maybeMigrateLegacyDemoFuturesSim(destDir) {
  migrateLegacyDirIfMissing(path.join("data", "binance-demo-futures"), destDir);
}

export function maybeMigrateLegacyPaperFuturesStore(destDir) {
  migrateLegacyDirIfMissing(path.join("data", "paper-futures"), destDir);
}

/** Default paper spot ledger dir for current mode slug (or PAPER_STORE_DIR). */
export function resolveDefaultPaperStoreDir() {
  const raw = process.env.PAPER_STORE_DIR;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const dest = path.join(resolveModeScopedDir(), "paper-store");
  maybeMigrateLegacyPaperStore(dest);
  return dest;
}

/** Default local futures paper ledger when env not set (e.g. scripts). */
export function resolveDefaultPaperFuturesStoreDir() {
  const raw = process.env.PAPER_FUTURES_STORE_DIR;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const dest = path.join(resolveModeScopedDir(), "paper-futures");
  maybeMigrateLegacyPaperFuturesStore(dest);
  return dest;
}

/** Default testnet spot snapshot dir. */
export function resolveDefaultTestnetSpotStoreDir() {
  const raw = process.env.BINANCE_TESTNET_STORE_DIR;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const dest = path.join(resolveModeScopedDir(), "testnet-spot");
  maybeMigrateLegacyTestnetStore(dest);
  return dest;
}

/** Demo hybrid local futures sim folder. */
export function resolveDefaultDemoFuturesSimDir() {
  const raw = process.env.BINANCE_DEMO_FUTURES_STORE_DIR;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    if (path.isAbsolute(s)) return s;
    return path.resolve(process.cwd(), s);
  }
  const dest = path.join(resolveModeScopedDir(), "demo-futures-sim");
  maybeMigrateLegacyDemoFuturesSim(dest);
  return dest;
}

/** Demo USD-M income sync JSON path (inside current slug dir, usually demo_api). */
export function resolveDefaultDemoFuturesIncomeSyncPath() {
  const raw = process.env.BINANCE_DEMO_FUTURES_INCOME_SYNC_PATH;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const p = path.join(resolveModeScopedDir(), "futures-income-sync.json");
  migrateLegacyFile("data/binance-demo-futures-income-sync.json", p);
  return path.resolve(p);
}

/** Live USD-M income sync JSON path (inside live slug dir). */
export function resolveDefaultLiveFuturesIncomeSyncPath() {
  const raw = process.env.BINANCE_LIVE_FUTURES_INCOME_SYNC_PATH;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const p = path.join(resolveModeScopedDir(), "futures-income-sync.json");
  migrateLegacyFile("data/binance-live-futures-income-sync.json", p);
  return path.resolve(p);
}
