import fs from "fs";
import path from "path";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function createBinanceTestnetStore({ baseDir }) {
  const dir = baseDir || path.resolve(process.cwd(), "data", "binance-testnet");
  ensureDir(dir);
  const snapshotPath = path.join(dir, "snapshot.json");

  function loadSnapshot() {
    if (!fs.existsSync(snapshotPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    } catch {
      return null;
    }
  }

  function saveSnapshot(snapshot) {
    const tmp = snapshotPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, snapshotPath);
  }

  return { dir, snapshotPath, loadSnapshot, saveSnapshot };
}

