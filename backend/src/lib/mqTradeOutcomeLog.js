/**
 * Append one JSON line per Supertrend close that carries `meta.mqAtEntry` (for offline MQ threshold tuning).
 * Path: data/modes/<persistenceSlug>/mq-trade-outcomes.jsonl
 */
import fs from "fs";
import path from "path";
import { resolveModeDataRootDir } from "./tradingModePersistence.js";

const MAX_BYTES = Number(process.env.MQ_TRADE_OUTCOMES_MAX_BYTES || 8_000_000);

function trimJsonlTail(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (st.size <= maxBytes) return;
    const txt = fs.readFileSync(p, "utf8");
    const lines = txt.split("\n").filter((line) => line.trim().length);
    let keep = lines;
    while (keep.join("\n").length > maxBytes * 0.85 && keep.length > 50) {
      keep = keep.slice(Math.floor(keep.length * 0.15));
    }
    const tmp = `${p}.trim.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${keep.join("\n")}\n`, "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* ignore */
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} [persistenceSlug]
 */
export function appendMqTradeOutcomeRow(row, persistenceSlug) {
  if (String(process.env.MQ_TRADE_OUTCOMES_LOG || "1") === "0") return;
  const slug =
    persistenceSlug != null && String(persistenceSlug).trim() ? String(persistenceSlug).trim() : "paper";
  const dir = path.join(resolveModeDataRootDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "mq-trade-outcomes.jsonl");
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_BYTES);
}
