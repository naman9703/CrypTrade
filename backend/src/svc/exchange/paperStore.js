import fs from "fs";
import path from "path";

function safeJsonParse(txt, fallback) {
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function createPaperStore({ baseDir }) {
  const dir = baseDir || path.resolve(process.cwd(), "data", "paper");
  ensureDir(dir);

  const snapshotPath = path.join(dir, "snapshot.json");
  const tradesPath = path.join(dir, "trades.csv");

  function loadSnapshot() {
    if (!fs.existsSync(snapshotPath)) return null;
    const txt = fs.readFileSync(snapshotPath, "utf8");
    return safeJsonParse(txt, null);
  }

  function saveSnapshot(snapshot) {
    const tmp = snapshotPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, snapshotPath);
  }

  function appendTradeCsv(row) {
    const header =
      "ts,id,symbol,type,side,qty,price,stopLoss,takeProfit,reason,pnl,strategy,metaJson\n";
    const exists = fs.existsSync(tradesPath);
    const line = [
      row.ts,
      row.id,
      row.symbol,
      row.type,
      row.side ?? "",
      row.qty ?? "",
      row.price ?? "",
      row.stopLoss ?? "",
      row.takeProfit ?? "",
      row.reason ?? "",
      row.pnl ?? "",
      row.strategy ?? "",
      JSON.stringify(row.meta || {}),
    ]
      .map((v) => `"${String(v).replaceAll('"', '""')}"`)
      .join(",")
      .concat("\n");

    if (!exists) fs.writeFileSync(tradesPath, header);
    fs.appendFileSync(tradesPath, line);
  }

  function resetFiles() {
    try {
      if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(tradesPath)) fs.unlinkSync(tradesPath);
    } catch {
      // ignore
    }
  }

  return {
    dir,
    snapshotPath,
    tradesPath,
    loadSnapshot,
    saveSnapshot,
    appendTradeCsv,
    resetFiles,
  };
}

