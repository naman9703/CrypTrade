#!/usr/bin/env node
/**
 * One-shot trade-history backfill: patches old CLOSE / OPEN rows with authoritative
 * `userTrades` avg-fill price + commission, attributes FUNDING, and fixes bogus
 * STOP_LOSS reasons whose recorded exit price is nowhere near the stored SL.
 *
 * Operates on one mode's `data/modes/<slug>/trade-ws-events.jsonl` at a time.
 *
 * Usage (from backend/):
 *   node scripts/backfill-trade-history.mjs --mode=live [--dry-run] [--since=2025-01-01] [--verbose]
 *   node scripts/backfill-trade-history.mjs --mode=demo_api --dry-run
 *
 * Modes → API env vars:
 *   live       → BINANCE_LIVE_FUTURES_API_KEY/SECRET  (fallback BINANCE_LIVE_API_KEY/SECRET)
 *                REST base: BINANCE_LIVE_FUTURES_REST_BASE (default https://fapi.binance.com)
 *   demo_api   → BINANCE_DEMO_FUTURES_API_KEY/SECRET (fallback BINANCE_DEMO_API_KEY/SECRET)
 *                REST base: BINANCE_DEMO_FUTURES_REST_BASE (default https://demo-fapi.binance.com)
 *   testnet    → BINANCE_FUTURES_API_KEY/SECRET
 *                REST base: BINANCE_FUTURES_TESTNET_REST_BASE (default https://testnet.binancefuture.com)
 *   paper      → no API; only reason sanity + local idempotent cleanup
 *
 * Output: writes `<path>.bak.<ts>` backup, then atomically rewrites the JSONL.
 * `--dry-run` prints a per-row diff summary and does NOT write any file.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { mode: null, dryRun: false, since: null, verbose: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") out.dryRun = true;
    else if (raw === "--verbose") out.verbose = true;
    else if (raw.startsWith("--mode=")) out.mode = raw.slice(7).trim();
    else if (raw.startsWith("--since=")) out.since = Date.parse(raw.slice(8).trim());
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.mode) {
  console.error(
    "Missing --mode. One of: live | demo_api | testnet | paper\n" +
      "  node scripts/backfill-trade-history.mjs --mode=live --dry-run",
  );
  process.exit(1);
}

const MODE_CONFIG = {
  live: {
    key: process.env.BINANCE_LIVE_FUTURES_API_KEY || process.env.BINANCE_LIVE_API_KEY || "",
    secret: process.env.BINANCE_LIVE_FUTURES_API_SECRET || process.env.BINANCE_LIVE_API_SECRET || "",
    base: process.env.BINANCE_LIVE_FUTURES_REST_BASE || "https://fapi.binance.com",
  },
  demo_api: {
    key: process.env.BINANCE_DEMO_FUTURES_API_KEY || process.env.BINANCE_DEMO_API_KEY || "",
    secret: process.env.BINANCE_DEMO_FUTURES_API_SECRET || process.env.BINANCE_DEMO_API_SECRET || "",
    base: process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com",
  },
  testnet: {
    key: process.env.BINANCE_FUTURES_API_KEY || "",
    secret: process.env.BINANCE_FUTURES_API_SECRET || "",
    base: process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com",
  },
  paper: { key: "", secret: "", base: "" },
};

const cfg = MODE_CONFIG[args.mode];
if (!cfg) {
  console.error(`Unknown mode "${args.mode}". Allowed: ${Object.keys(MODE_CONFIG).join(", ")}`);
  process.exit(1);
}

const jsonlPath = path.join(__dirname, "..", "..", "data", "modes", args.mode, "trade-ws-events.jsonl");
if (!fs.existsSync(jsonlPath)) {
  console.error(`Trade log not found: ${jsonlPath}`);
  process.exit(1);
}

// ── Signed HTTP client (mirrors binanceLiveFuturesUsdM) ────────────────────
const client = cfg.base ? axios.create({ baseURL: cfg.base, timeout: 20_000, headers: { "X-MBX-APIKEY": cfg.key } }) : null;

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function signedGet(pathStr, params = {}) {
  if (!client || !cfg.key || !cfg.secret) throw new Error("no_api_creds");
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qp.append(k, String(v));
  qp.append("timestamp", String(Date.now()));
  qp.append("recvWindow", "5000");
  const sig = hmacSha256(cfg.secret, qp.toString());
  qp.append("signature", sig);
  const r = await client.get(`${pathStr}?${qp.toString()}`);
  return r.data;
}

async function publicGet(pathStr, params = {}) {
  if (!client) throw new Error("no_rest_base");
  const r = await client.get(pathStr, { params });
  return r.data;
}

// ── userTrades commission + avgPrice (mirrors binanceUsdMUserTradeCommission.js) ──
async function fetchOrderCommissionDetails(symbol, orderId) {
  if (!orderId) return null;
  let rows;
  try {
    rows = await signedGet("/fapi/v1/userTrades", { symbol, orderId, limit: 1000 });
  } catch (e) {
    if (args.verbose) console.warn("[warn] userTrades failed:", symbol, orderId, String(e?.message || e));
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let usdt = 0;
  let bnb = 0;
  let notionalNum = 0;
  let qtySum = 0;
  let anyMaker = null;
  for (const t of rows) {
    const c = Number(t?.commission);
    const asset = String(t?.commissionAsset || "").toUpperCase();
    if (Number.isFinite(c) && c > 0) {
      if (asset === "USDT") usdt += c;
      else if (asset === "BNB") bnb += c;
    }
    const px = Number(t?.price);
    const q = Math.abs(Number(t?.qty));
    if (Number.isFinite(px) && px > 0 && Number.isFinite(q) && q > 0) {
      notionalNum += px * q;
      qtySum += q;
    }
    if (t?.maker === true) anyMaker = anyMaker === false ? false : true;
    else if (t?.maker === false) anyMaker = false;
  }
  if (bnb > 0) {
    try {
      const px = await publicGet("/fapi/v1/ticker/price", { symbol: "BNBUSDT" });
      const pr = Number(px?.price);
      if (Number.isFinite(pr) && pr > 0) usdt += bnb * pr;
    } catch {
      /* ignore BNB conversion failure */
    }
  }
  return {
    usdt: Math.round(usdt * 1e8) / 1e8,
    avgPrice: qtySum > 0 ? notionalNum / qtySum : null,
    filledQty: qtySum,
    allMaker: anyMaker,
  };
}

// ── FUNDING puller (chunks /fapi/v1/income?incomeType=FUNDING) ─────────────
async function fetchFundingRowsSince(startMs, endMs) {
  if (!client || !cfg.key || !cfg.secret) return [];
  const out = [];
  let cur = startMs;
  const stop = endMs;
  /** Binance income endpoint caps 7-day windows at 1000 rows. */
  while (cur < stop) {
    const chunkEnd = Math.min(stop, cur + 7 * 24 * 3600 * 1000);
    let rows;
    try {
      rows = await signedGet("/fapi/v1/income", {
        incomeType: "FUNDING_FEE",
        startTime: cur,
        endTime: chunkEnd,
        limit: 1000,
      });
    } catch (e) {
      console.warn("[warn] funding fetch failed:", new Date(cur).toISOString(), String(e?.message || e));
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      cur = chunkEnd;
      continue;
    }
    for (const r of rows) {
      const amt = Number(r.income || 0);
      const sym = String(r.symbol || "").toUpperCase();
      const t = Number(r.time || 0);
      const tid = r.tranId != null ? String(r.tranId) : `f_${t}_${sym}_${amt}`;
      if (!Number.isFinite(amt) || amt === 0 || !sym || !t) continue;
      out.push({ tranId: tid, symbol: sym, time: t, amt });
    }
    const maxT = rows.reduce((m, r) => Math.max(m, Number(r.time || 0)), cur);
    cur = Math.max(maxT + 1, chunkEnd);
  }
  return out;
}

// ── Backfill core ───────────────────────────────────────────────────────────
function rowTsMs(t) {
  const raw = t?.ts ?? t?.exitTs;
  if (raw == null) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function readJsonl(p) {
  const txt = fs.readFileSync(p, "utf8");
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ __raw: line });
    }
  }
  return out;
}

function writeJsonlAtomic(p, rows) {
  const tmp = `${p}.backfill.${process.pid}.tmp`;
  const lines = rows.map((r) => {
    if (r && typeof r === "object" && "__raw" in r) return String(r.__raw);
    return JSON.stringify(r);
  });
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
  fs.renameSync(tmp, p);
}

function makeBackup(p) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bp = `${p}.bak.${stamp}`;
  fs.copyFileSync(p, bp);
  return bp;
}

/** Exit avg fill deviating > 1% from stored SL is not a genuine stop-loss exit. */
const SL_SANITY_DEV_FRAC = Math.max(
  0.001,
  Math.min(0.05, Number(process.env.BACKFILL_SL_SANITY_FRAC || 0.01)),
);

/**
 * Tolerance band for upgrading generic (EXCHANGE_REALIZED / MANUAL_CLOSE / STOP_LOSS_DEFAULT) reasons
 * back to `STOP_LOSS` / `TAKE_PROFIT` when the actual exit fill price is within this fraction of a
 * bracket. 0.35% by default — covers stop slippage (a few ticks past trigger) without mislabeling
 * unrelated signal / manual exits as SL/TP.
 */
const CLOSE_REASON_FILL_BAND = Math.max(
  0.001,
  Math.min(0.02, Number(process.env.BACKFILL_FILL_REASON_BAND || 0.0035)),
);

function sanityFixCloseReason(row) {
  if (row?.type !== "CLOSE") return false;
  const r = String(row.reason || "").toUpperCase();
  if (r !== "STOP_LOSS" && r !== "STOP_LOSS_DEFAULT") return false;
  const sl = Number(row.stopLoss ?? row.meta?.stopLoss ?? row.meta?.sl);
  const exit = Number(row.meta?.exitAvgFillPrice ?? row.price ?? row.meta?.exitPrice);
  if (!Number.isFinite(sl) || !Number.isFinite(exit) || sl <= 0 || exit <= 0) return false;
  const dev = Math.abs(exit - sl) / sl;
  if (dev <= SL_SANITY_DEV_FRAC) return false;
  row.reason = "EXCHANGE_REALIZED";
  row.meta = {
    ...(row.meta || {}),
    closeReason: "EXCHANGE_REALIZED",
    reasonSanityFixed: true,
    reasonSanityPrior: r,
    reasonSanityDevFrac: dev,
  };
  return true;
}

/**
 * Upgrade generic `EXCHANGE_REALIZED` / `MANUAL_CLOSE` labels to `STOP_LOSS` or `TAKE_PROFIT` when
 * the exit avg fill price actually lands within {@link CLOSE_REASON_FILL_BAND} of SL/TP. This
 * addresses the reported issue where nearly every historical CLOSE was tagged "Exchange" even
 * though the fill unambiguously matched the stop or take-profit trigger.
 *
 * Never downgrades an already-specific reason (TRAILED_*, SUPERTREND_*, TAKE_PROFIT, …).
 *
 * @returns {boolean} true if the row was upgraded
 */
function upgradeReasonFromExitFill(row) {
  if (row?.type !== "CLOSE") return false;
  const existing = String(row.reason || "").toUpperCase();
  const upgradable =
    existing === "" ||
    existing === "EXCHANGE_REALIZED" ||
    existing === "MANUAL_CLOSE" ||
    existing === "STOP_LOSS_DEFAULT";
  if (!upgradable) return false;
  const px = Number(row.meta?.exitAvgFillPrice ?? row.meta?.exitPrice ?? row.price);
  if (!Number.isFinite(px) || px <= 0) return false;
  const sl = Number(row.stopLoss ?? row.meta?.stopLoss ?? row.meta?.sl);
  const tp = Number(row.takeProfit ?? row.meta?.takeProfit ?? row.meta?.tp);
  const nearSl = Number.isFinite(sl) && sl > 0 && Math.abs(px - sl) / sl <= CLOSE_REASON_FILL_BAND;
  const nearTp = Number.isFinite(tp) && tp > 0 && Math.abs(px - tp) / tp <= CLOSE_REASON_FILL_BAND;
  let pickSl = nearSl && !nearTp;
  let pickTp = nearTp && !nearSl;
  if (nearSl && nearTp) {
    if (Math.abs(px - sl) <= Math.abs(px - tp)) pickSl = true;
    else pickTp = true;
  }
  if (!pickSl && !pickTp) return false;
  const prior = row.reason;
  const trailPending = Math.max(0, Math.floor(Number(row.meta?.trailStepAtClose) || 0));
  const trailConf = Math.max(0, Math.floor(Number(row.meta?.confirmedTrailStepAtClose) || 0));
  const trailed = trailPending > 0 || trailConf > 0 || row.meta?.exitViaTrailedStop === true;
  if (pickTp) {
    row.reason = "TAKE_PROFIT";
  } else if (trailed && trailConf > 0) {
    const tmode = String(row.meta?.trailingMode || "").toUpperCase();
    const tier = trailConf <= 1 ? "T01" : trailConf === 2 ? "T02" : `T${String(trailConf).padStart(2, "0")}`;
    row.reason = tmode === "FEE_LADDER" ? `TRAILED_STOP_LOSS_${tier}` : `TRAILED_SUPERTREND_${tier}`;
  } else {
    row.reason = "STOP_LOSS";
  }
  row.meta = {
    ...(row.meta || {}),
    closeReason: row.reason,
    reasonUpgradedFromFill: true,
    reasonUpgradedPrior: prior,
  };
  return true;
}

/**
 * Collapse duplicate CLOSE rows that share a `meta.orderId` — the reported CSV showed 7 consecutive
 * rows per single reduce order (one per REALIZED_PNL fill shard) each carrying the full OPEN qty,
 * which inflated displayed fees 7× and made Net PnL diverge from Binance's total. We aggregate
 * `pnl`, `fee`, and qty, and recompute the qty-weighted avg fill price.
 *
 * Safe: only collapses rows within the same mode file that all share an `meta.orderId`. Older rows
 * without `orderId` are untouched.
 *
 * @returns {{ removed: number; merged: number }}
 */
function collapseDuplicateCloseByOrderId(rows) {
  const stats = { removed: 0, merged: 0 };
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== "object" || "__raw" in r) continue;
    if (r.type !== "CLOSE") continue;
    const orderId = r?.meta?.orderId ?? r?.meta?.closeOrderId;
    if (orderId == null || String(orderId).trim() === "") continue;
    const sym = String(r.symbol || "").toUpperCase();
    if (!sym) continue;
    const key = `${sym}::${String(orderId)}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  const toRemove = new Set();
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    idxs.sort((a, b) => a - b);
    const keepIdx = idxs[0];
    const keep = rows[keepIdx];
    /** Keep the earliest row as the canonical row; fold the rest into it. */
    let pnlAcc = Number(keep.pnl || 0);
    let feeAcc = Number(keep.fee || 0);
    let qtyAcc = Number(keep.qty || 0);
    let notionalAcc =
      Number.isFinite(Number(keep.price)) && Number(keep.price) > 0 ? Number(keep.price) * qtyAcc : 0;
    const tranIds = Array.isArray(keep.meta?.tranIds) ? [...keep.meta.tranIds] : keep.meta?.tranId ? [keep.meta.tranId] : [];
    for (let k = 1; k < idxs.length; k++) {
      const dup = rows[idxs[k]];
      pnlAcc += Number(dup.pnl || 0);
      feeAcc += Number(dup.fee || 0);
      const q = Number(dup.qty || 0);
      const p = Number(dup.price || 0);
      if (Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0) {
        qtyAcc += q;
        notionalAcc += q * p;
      }
      const dupIds = Array.isArray(dup.meta?.tranIds) ? dup.meta.tranIds : dup.meta?.tranId ? [dup.meta.tranId] : [];
      for (const tid of dupIds) if (tid && !tranIds.includes(tid)) tranIds.push(tid);
      toRemove.add(idxs[k]);
      stats.removed += 1;
    }
    keep.pnl = pnlAcc;
    keep.fee = feeAcc;
    if (qtyAcc > 0) {
      keep.qty = qtyAcc;
      if (notionalAcc > 0) {
        const avg = notionalAcc / qtyAcc;
        keep.price = avg;
        keep.meta = {
          ...(keep.meta || {}),
          exitAvgFillPrice: avg,
          exitPrice: avg,
          exitPriceSource: "fapi_userTrades",
        };
      }
    }
    keep.meta = {
      ...(keep.meta || {}),
      tranIds,
      tranId: tranIds[tranIds.length - 1],
      collapsedFromShards: idxs.length,
    };
    stats.merged += 1;
  }
  if (toRemove.size === 0) return stats;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) rows.splice(i, 1);
  }
  return stats;
}

function attributeFundingToCloseRows(rows, fundingRows) {
  if (!fundingRows.length || !rows.length) return 0;
  let mutated = 0;
  for (let i = 0; i < rows.length; i++) {
    const cr = rows[i];
    if (cr?.type !== "CLOSE") continue;
    const sym = String(cr.symbol || "").toUpperCase();
    if (!sym) continue;
    const closeTs = rowTsMs(cr);
    if (!closeTs) continue;
    let openTs = 0;
    for (let j = i - 1; j >= 0; j--) {
      const o = rows[j];
      if (!o) continue;
      if (o.type === "CLOSE" && String(o.symbol || "").toUpperCase() === sym) break;
      if (o.type === "OPEN" && String(o.symbol || "").toUpperCase() === sym) {
        openTs = rowTsMs(o);
        break;
      }
    }
    if (!openTs || openTs >= closeTs) continue;
    const seen = new Set(
      Array.isArray(cr.meta?.fundingTranIds) ? cr.meta.fundingTranIds.map(String) : [],
    );
    let sumNew = 0;
    const newIds = [];
    for (const fr of fundingRows) {
      if (fr.symbol !== sym) continue;
      if (fr.time < openTs || fr.time > closeTs) continue;
      if (seen.has(fr.tranId)) continue;
      sumNew += fr.amt;
      newIds.push(fr.tranId);
    }
    if (!newIds.length) continue;
    cr.meta = {
      ...(cr.meta || {}),
      fundingFeeUsd: Number(cr.meta?.fundingFeeUsd || 0) + sumNew,
      fundingTranIds: [
        ...(Array.isArray(cr.meta?.fundingTranIds) ? cr.meta.fundingTranIds : []),
        ...newIds,
      ],
    };
    cr.fee = Number(cr.fee || 0) + -sumNew;
    mutated += 1;
  }
  return mutated;
}

async function backfillOrderFills(rows) {
  const stats = { openPatched: 0, closePatched: 0, skippedNoOrderId: 0, skippedAlready: 0, skippedNonFutures: 0, failed: 0 };
  if (!cfg.key || !cfg.secret || args.mode === "paper") {
    console.log(`Skipping exchange fills lookup (mode=${args.mode}, no API creds).`);
    return stats;
  }
  /** ~6 symbols × 2 legs/sec — Binance userTrades weight is 5/request, 1200/min budget. */
  const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.BACKFILL_CONCURRENCY || 4)));
  const queue = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || "__raw" in row) continue;
    if (args.since != null && rowTsMs(row) < args.since) continue;
    const venue = String(row?.meta?.venue || row?.venue || "").toUpperCase();
    if (venue !== "FUTURES") {
      stats.skippedNonFutures += 1;
      continue;
    }
    const orderId = row?.meta?.orderId;
    if (!orderId || String(orderId).trim() === "") {
      stats.skippedNoOrderId += 1;
      continue;
    }
    if (row.type === "OPEN" && row.meta?.entryPriceSource === "fapi_userTrades") {
      stats.skippedAlready += 1;
      continue;
    }
    if (row.type === "CLOSE" && row.meta?.exitPriceSource === "fapi_userTrades") {
      stats.skippedAlready += 1;
      continue;
    }
    queue.push(row);
  }

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const row = queue[idx];
      const sym = String(row.symbol || "").toUpperCase();
      const orderId = String(row.meta.orderId);
      try {
        const det = await fetchOrderCommissionDetails(sym, orderId);
        if (!det) continue;
        const hasFill = det.avgPrice != null && Number.isFinite(Number(det.avgPrice)) && Number(det.avgPrice) > 0;
        const hasCommission = Number(det.usdt) > 0;
        if (!hasFill && !hasCommission) continue;
        const patch = {};
        if (row.type === "OPEN") {
          if (hasCommission) {
            row.fee = det.usdt;
            patch.openFee = det.usdt;
            patch.commissionSource = "fapi_userTrades";
            if (det.allMaker === true) patch.entryAllMaker = true;
            else if (det.allMaker === false) patch.entryAllMaker = false;
          }
          if (hasFill) {
            row.price = Number(det.avgPrice);
            patch.entryAvgFillPrice = Number(det.avgPrice);
            patch.entryPriceSource = "fapi_userTrades";
            if (
              Number.isFinite(Number(det.filledQty)) &&
              Number(det.filledQty) > 0 &&
              Math.abs(Number(det.filledQty) - Number(row.qty || 0)) > 1e-8
            ) {
              row.qty = Number(det.filledQty);
              patch.entryFilledQty = Number(det.filledQty);
            }
          }
          row.meta = { ...(row.meta || {}), ...patch };
          stats.openPatched += 1;
          if (args.verbose) console.log(`OPEN  ${sym} ${orderId} → price=${row.price} fee=${row.fee}`);
        } else if (row.type === "CLOSE") {
          if (hasCommission) {
            row.fee = det.usdt;
            patch.exitFee = det.usdt;
            patch.commissionSourceClose = "fapi_userTrades";
            if (det.allMaker === true) patch.exitAllMaker = true;
            else if (det.allMaker === false) patch.exitAllMaker = false;
          }
          if (hasFill) {
            row.price = Number(det.avgPrice);
            patch.exitPrice = Number(det.avgPrice);
            patch.exitAvgFillPrice = Number(det.avgPrice);
            patch.exitPriceSource = "fapi_userTrades";
          }
          row.meta = { ...(row.meta || {}), ...patch };
          stats.closePatched += 1;
          if (args.verbose) console.log(`CLOSE ${sym} ${orderId} → price=${row.price} fee=${row.fee}`);
        }
      } catch (e) {
        stats.failed += 1;
        if (args.verbose) console.warn("[warn] backfill row failed:", sym, orderId, String(e?.message || e));
      }
      // Soft rate limit: 200ms between calls per worker
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return stats;
}

async function main() {
  console.log(`Backfill mode=${args.mode} path=${jsonlPath} dryRun=${args.dryRun}`);
  const before = fs.statSync(jsonlPath).size;
  const rows = readJsonl(jsonlPath);
  console.log(`Loaded ${rows.length} rows (${(before / 1024).toFixed(1)} KB).`);

  let reasonFixed = 0;
  let reasonUpgraded = 0;
  /** First pass: fetch authoritative fills for OPEN/CLOSE rows. */
  const fillStats = await backfillOrderFills(rows);
  console.log("Order-fill backfill:", fillStats);

  /** Second pass: reason sanity. Runs AFTER fill patches so we check against true avg fill. */
  for (const r of rows) {
    if (r && typeof r === "object" && sanityFixCloseReason(r)) reasonFixed += 1;
  }

  /**
   * 2.5: Upgrade generic reasons back to SL/TP when the exit fill IS actually on a bracket. Runs
   * after the sanity demotion so it only looks at rows that either were already generic or got
   * demoted in the prior pass. Fixes the main symptom in the user's Sheet6 CSV: "why is every row
   * tagged Exchange when the fill clearly hit SL?".
   */
  for (const r of rows) {
    if (r && typeof r === "object" && upgradeReasonFromExitFill(r)) reasonUpgraded += 1;
  }

  /**
   * 2.6: Collapse duplicate CLOSE rows that share `meta.orderId`. Binance splits a single reduce
   * order into many REALIZED_PNL shards (one per fill), and the prior app code pushed each shard as
   * a separate history row carrying the full OPEN qty — inflating displayed fees N× and breaking
   * Net PnL match. One row per orderId is the correct representation.
   */
  const collapseStats = collapseDuplicateCloseByOrderId(rows);
  console.log(
    `Duplicate-CLOSE collapse: merged ${collapseStats.merged} orderId group(s), removed ${collapseStats.removed} shard(s).`,
  );

  /** Third pass: funding attribution. Pull FUNDING for the full timespan of the file. */
  let fundingAttributed = 0;
  if (cfg.key && cfg.secret && args.mode !== "paper") {
    let minT = Infinity;
    let maxT = 0;
    for (const r of rows) {
      const t = rowTsMs(r);
      if (t > 0) {
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }
    }
    if (args.since != null) minT = Math.max(minT, args.since);
    if (Number.isFinite(minT) && maxT > 0) {
      console.log(`Fetching FUNDING rows for ${new Date(minT).toISOString()} → ${new Date(maxT).toISOString()}`);
      const funding = await fetchFundingRowsSince(minT - 60_000, maxT + 60_000);
      console.log(`Fetched ${funding.length} funding rows.`);
      fundingAttributed = attributeFundingToCloseRows(rows, funding);
    }
  }

  console.log(
    `Reason sanity demotions: ${reasonFixed}. Reason upgrades from exit fill: ${reasonUpgraded}. Funding attributions: ${fundingAttributed}.`,
  );

  if (args.dryRun) {
    console.log("--dry-run: not writing file. Summary only.");
    return;
  }

  const backup = makeBackup(jsonlPath);
  writeJsonlAtomic(jsonlPath, rows);
  const after = fs.statSync(jsonlPath).size;
  console.log(`Backup: ${backup}`);
  console.log(`Wrote ${rows.length} rows (${(after / 1024).toFixed(1)} KB).`);
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
