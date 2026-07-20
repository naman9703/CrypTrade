/**
 * Funding-arb opportunity scanner (Phase 1 — monitor only, no orders).
 */
import {
  annualizeFundingRate,
  carrySideFromRate,
  computeBasis,
  resolveFundingArbCfg,
} from "./types.js";
import { shouldEnter, shouldExit, averageLastRates } from "./signal.js";

/**
 * Build a per-symbol opportunity snapshot from rate history + optional live fields.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {Array<{ts:number,rate:number}>} args.rates — chronological historical settlements
 * @param {{ predicted?: number, nextTime?: Date|number|string, current?: number, bias?: string }|null} [args.live]
 * @param {number|null} [args.spotPx]
 * @param {number|null} [args.perpPx]
 * @param {object} [args.cfg]
 * @param {string|null} [args.openCarrySide] — if holding, include exit advice
 */
export function evaluateSymbolOpportunity({
  symbol,
  rates = [],
  live = null,
  spotPx = null,
  perpPx = null,
  cfg = {},
  openCarrySide = null,
} = {}) {
  const c = resolveFundingArbCfg(cfg);
  const chron = Array.isArray(rates) ? [...rates].sort((a, b) => a.ts - b.ts) : [];
  const latest = chron.length ? chron[chron.length - 1] : null;
  const rate =
    Number.isFinite(Number(live?.predicted))
      ? Number(live.predicted)
      : Number.isFinite(Number(live?.current))
        ? Number(live.current)
        : latest
          ? Number(latest.rate)
          : null;

  if (!Number.isFinite(rate)) {
    return {
      symbol,
      ok: false,
      reason: "no_funding_data",
      rate: null,
      annualizedPct: 0,
      side: null,
      enter: false,
      exit: false,
    };
  }

  const annualizedPct = annualizeFundingRate(rate, c.intervalHours);
  const side = carrySideFromRate(rate);
  const avg3 = averageLastRates(chron, Math.min(3, chron.length || 1));
  const avg3Ann = avg3 != null ? annualizeFundingRate(avg3, c.intervalHours) : null;
  const basis = computeBasis(spotPx, perpPx);
  const entry = shouldEnter({ rate, recentRates: chron, cfg: c });
  const exitAdvice = openCarrySide
    ? shouldExit({ rate, positionSide: openCarrySide, cfg: c })
    : { exit: false, annualizedPct, reason: "flat" };

  let nextFundingTs = null;
  if (live?.nextTime != null) {
    const t = live.nextTime instanceof Date ? live.nextTime.getTime() : Number(live.nextTime);
    nextFundingTs = Number.isFinite(t) ? t : null;
  }

  return {
    symbol: String(symbol).toUpperCase(),
    ok: true,
    rate,
    predicted: Number.isFinite(Number(live?.predicted)) ? Number(live.predicted) : null,
    annualizedPct,
    avg3Ann,
    side,
    basis,
    spotPx: Number.isFinite(Number(spotPx)) ? Number(spotPx) : null,
    perpPx: Number.isFinite(Number(perpPx)) ? Number(perpPx) : null,
    bias: live?.bias ?? null,
    nextFundingTs,
    lastSettlementTs: latest?.ts ?? null,
    enter: entry.enter,
    enterReason: entry.reason,
    exit: exitAdvice.exit,
    exitReason: exitAdvice.reason,
    settlementCount: chron.length,
  };
}

/**
 * Scan many symbols — pure (no I/O). Caller supplies rates/live/prices.
 *
 * @param {Array<{symbol:string, rates:Array, live?:object, spotPx?:number, perpPx?:number, openCarrySide?:string}>} rows
 * @param {object} [cfg]
 */
export function scanFundingOpportunities(rows, cfg = {}) {
  const out = [];
  for (const row of rows || []) {
    out.push(
      evaluateSymbolOpportunity({
        symbol: row.symbol,
        rates: row.rates,
        live: row.live,
        spotPx: row.spotPx,
        perpPx: row.perpPx,
        openCarrySide: row.openCarrySide,
        cfg,
      }),
    );
  }
  out.sort((a, b) => Math.abs(b.annualizedPct || 0) - Math.abs(a.annualizedPct || 0));
  return out;
}

/**
 * Format a monitor table for CLI / markdown.
 * @param {ReturnType<typeof scanFundingOpportunities>} rows
 */
export function formatOpportunityTable(rows) {
  const header =
    "symbol     | rate%     | ann%    | side                    | basis%   | enter | reason";
  const lines = [header, "-".repeat(header.length)];
  for (const r of rows) {
    if (!r.ok) {
      lines.push(`${String(r.symbol).padEnd(10)} | NO DATA`);
      continue;
    }
    lines.push(
      [
        String(r.symbol).padEnd(10),
        ((r.rate ?? 0) * 100).toFixed(4).padStart(8),
        (r.annualizedPct ?? 0).toFixed(1).padStart(7),
        String(r.side ?? "—").padEnd(23),
        r.basis != null ? ((r.basis * 100).toFixed(3)).padStart(7) : "   —  ",
        r.enter ? " YES " : "  no ",
        r.enterReason ?? "",
      ].join(" | "),
    );
  }
  return lines.join("\n");
}
