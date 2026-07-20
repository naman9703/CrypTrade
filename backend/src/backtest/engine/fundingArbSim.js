/**
 * Dual-leg funding cash-and-carry simulator (Phase 2).
 *
 * Models: spot inventory + perp hedge, funding income, basis PnL,
 * dual-leg fees/slippage, capital = spot notional + perp initial margin.
 * Does NOT use directional runSimulation.
 */
import { applySlippage } from "./costModel.js";
import {
  CARRY_SIDE,
  resolveFundingArbCfg,
  fundingIncomeBetween,
  perpSideForCarry,
  spotSideForCarry,
  annualizeFundingRate,
} from "../../strategy/fundingArb/types.js";
import { shouldEnter, shouldExit } from "../../strategy/fundingArb/signal.js";
import { capitalDeployed } from "../../strategy/fundingArb/risk.js";

/**
 * Build a chronological decision timeline from funding settlements.
 * @param {Array<{ts:number,rate:number}>} fundingRates
 * @param {Array<{ts:number,close:number}>} spotCandles
 * @param {Array<{ts:number,close:number}>} perpCandles
 * @returns {Array<{ts:number,rate:number,spotPx:number,perpPx:number,rateIdx:number}>}
 */
function buildSettlementTimeline(fundingRates, spotCandles, perpCandles) {
  const spot = [...(spotCandles || [])].sort((a, b) => a.ts - b.ts);
  const perp = [...(perpCandles || [])].sort((a, b) => a.ts - b.ts);
  const rates = [...(fundingRates || [])].sort((a, b) => a.ts - b.ts);

  function nearestClose(series, ts) {
    if (!series.length) return null;
    let best = null;
    for (const c of series) {
      if (c.ts > ts) break;
      best = c;
    }
    return best?.close ?? null;
  }

  const out = [];
  for (let i = 0; i < rates.length; i++) {
    const fr = rates[i];
    const spotPx = nearestClose(spot, fr.ts);
    const perpPx = nearestClose(perp, fr.ts);
    if (!(spotPx > 0) || !(perpPx > 0)) continue;
    out.push({
      ts: fr.ts,
      rate: Number(fr.rate),
      spotPx: Number(spotPx),
      perpPx: Number(perpPx),
      rateIdx: i,
    });
  }
  return out;
}

function legFee(notional, feeRate, feeStressMult) {
  const n = Math.abs(Number(notional));
  const fee = n * Number(feeRate) * Number(feeStressMult);
  return fee;
}

/**
 * Mark-to-market basis PnL for a carry from entry to exit prices.
 * Positive = carry profit from basis move.
 *
 * LONG_SPOT_SHORT_PERP: spot gain + short-perp gain
 *   = (spotExit-spotEntry)*qty + (perpEntry-perpExit)*qty
 * SHORT_SPOT_LONG_PERP: reverse
 */
export function basisPnl(carrySide, qty, spotEntry, perpEntry, spotExit, perpExit) {
  const q = Math.abs(Number(qty));
  if (carrySide === CARRY_SIDE.LONG_SPOT_SHORT_PERP) {
    return (Number(spotExit) - Number(spotEntry)) * q + (Number(perpEntry) - Number(perpExit)) * q;
  }
  if (carrySide === CARRY_SIDE.SHORT_SPOT_LONG_PERP) {
    return (Number(spotEntry) - Number(spotExit)) * q + (Number(perpExit) - Number(perpEntry)) * q;
  }
  return 0;
}

/**
 * Run dual-leg funding arb simulation.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {Array<{ts:number,rate:number}>} args.fundingRates
 * @param {Array<{ts:number,close:number}>} args.spotCandles
 * @param {Array<{ts:number,close:number}>} args.perpCandles
 * @param {object} [args.cfg]
 * @returns {{ trades: object[], summary: object }}
 */
export function runFundingArbSim({
  symbol,
  fundingRates = [],
  spotCandles = [],
  perpCandles = [],
  cfg = {},
} = {}) {
  const c = resolveFundingArbCfg(cfg);
  const timeline = buildSettlementTimeline(fundingRates, spotCandles, perpCandles);
  const ratesChron = fundingRates.slice().sort((a, b) => a.ts - b.ts);

  const trades = [];
  let pos = null;
  let equityCurve = [];
  let peakDeployed = 0;
  let maxDdPct = 0;
  let equity = 0; // cumulative net PnL
  let peakEquity = 0;
  let timeInMarketIntervals = 0;
  let totalIntervals = timeline.length;

  for (let i = 0; i < timeline.length; i++) {
    const row = timeline[i];
    const recent = ratesChron
      .filter((r) => r.ts <= row.ts)
      .slice(-Math.max(c.avgLookback, c.stabilityIntervals, 6));

    if (!pos) {
      const sig = shouldEnter({ rate: row.rate, recentRates: recent, cfg: c });
      if (!sig.enter) {
        equityCurve.push({ ts: row.ts, equity, inMarket: false });
        continue;
      }

      const carrySide = sig.side;
      const spotSide = spotSideForCarry(carrySide);
      const perpSide = perpSideForCarry(carrySide);
      const spotMid = row.spotPx;
      const perpMid = row.perpPx;
      const qty = c.notionalUsdt / spotMid;
      const deployed = capitalDeployed(c.notionalUsdt, c.perpLeverage);
      peakDeployed = Math.max(peakDeployed, deployed);

      const openFees =
        legFee(c.notionalUsdt, c.spotFeeRate, c.feeStressMult) +
        legFee(c.notionalUsdt, c.perpFeeRate, c.feeStressMult);
      const openSlip =
        2 * c.notionalUsdt * c.slippagePct * c.feeStressMult;

      pos = {
        carrySide,
        entryTs: row.ts,
        entryRateIdx: row.rateIdx,
        entryInterval: i,
        spotEntry: spotMid,
        perpEntry: perpMid,
        spotEntryFill: applySlippage(spotSide, spotMid, c.slippagePct),
        perpEntryFill: applySlippage(perpSide, perpMid, c.slippagePct),
        qty,
        notionalUsdt: c.notionalUsdt,
        deployed,
        openFees,
        openSlip,
        entryAnnualizedPct: sig.annualizedPct,
      };
      timeInMarketIntervals += 1;
      equityCurve.push({ ts: row.ts, equity, inMarket: true });
      continue;
    }

    // Holding — check exit after this settlement accrues
    timeInMarketIntervals += 1;
    const holdIntervals = i - pos.entryInterval;
    const exitSig = shouldExit({
      rate: row.rate,
      positionSide: pos.carrySide,
      holdIntervals,
      cfg: c,
    });
    const maxHoldHit = c.maxHoldIntervals > 0 && holdIntervals >= c.maxHoldIntervals;
    const isLast = i === timeline.length - 1;

    if (!exitSig.exit && !maxHoldHit && !isLast) {
      equityCurve.push({ ts: row.ts, equity, inMarket: true });
      continue;
    }

    // Close
    const perpSide = perpSideForCarry(pos.carrySide);
    // Close at mid; charge close fees + exit slip explicitly
    const spotExit = row.spotPx;
    const perpExit = row.perpPx;

    const fundingIncome = fundingIncomeBetween(
      perpSide,
      pos.qty,
      pos.perpEntry,
      ratesChron,
      pos.entryTs,
      row.ts,
    );
    const basis = basisPnl(pos.carrySide, pos.qty, pos.spotEntry, pos.perpEntry, spotExit, perpExit);

    const exitNotionalSpot = pos.qty * spotExit;
    const exitNotionalPerp = pos.qty * perpExit;
    const closeFees =
      legFee(exitNotionalSpot, c.spotFeeRate, c.feeStressMult) +
      legFee(exitNotionalPerp, c.perpFeeRate, c.feeStressMult);
    const closeSlip =
      (Math.abs(exitNotionalSpot) + Math.abs(exitNotionalPerp)) * c.slippagePct * c.feeStressMult;
    const fees = pos.openFees + closeFees;
    const slipCost = pos.openSlip + closeSlip;

    const netPnl = fundingIncome + basis - fees - slipCost;
    equity += netPnl;
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity > 0 ? (peakEquity - equity) / Math.max(peakDeployed, 1) : 0;
    // DD vs capital deployed peak
    const ddVsCap =
      peakDeployed > 0 ? Math.max(0, (peakEquity - equity) / peakDeployed) : 0;
    maxDdPct = Math.max(maxDdPct, ddVsCap * 100);

    const exitReason = isLast && !exitSig.exit && !maxHoldHit
      ? "end_of_data"
      : maxHoldHit
        ? "max_hold"
        : exitSig.reason;

    trades.push({
      symbol: String(symbol).toUpperCase(),
      carrySide: pos.carrySide,
      entryTs: pos.entryTs,
      exitTs: row.ts,
      holdIntervals,
      entryRate: ratesChron.find((r) => r.ts === pos.entryTs)?.rate ?? null,
      exitRate: row.rate,
      entryAnnualizedPct: pos.entryAnnualizedPct,
      exitAnnualizedPct: annualizeFundingRate(row.rate, c.intervalHours),
      qty: pos.qty,
      notionalUsdt: pos.notionalUsdt,
      capitalDeployed: pos.deployed,
      fundingIncome,
      basisPnl: basis,
      fees,
      slipCost,
      netPnl,
      returnOnCapitalPct: pos.deployed > 0 ? (netPnl / pos.deployed) * 100 : 0,
      exitReason,
    });

    pos = null;
    equityCurve.push({ ts: row.ts, equity, inMarket: false });
  }

  const grossFunding = trades.reduce((s, t) => s + t.fundingIncome, 0);
  const totalBasis = trades.reduce((s, t) => s + t.basisPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const totalSlip = trades.reduce((s, t) => s + t.slipCost, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const flips = trades.filter((t) => String(t.exitReason).includes("flip")).length;

  const firstTs = timeline[0]?.ts ?? 0;
  const lastTs = timeline[timeline.length - 1]?.ts ?? firstTs;
  const years = Math.max((lastTs - firstTs) / (365.25 * 864e5), 1 / 365);
  const avgCapital = peakDeployed > 0 ? peakDeployed : capitalDeployed(c.notionalUsdt, c.perpLeverage);
  const netAnnualizedOnCapitalPct = avgCapital > 0 ? ((netPnl / avgCapital) / years) * 100 : 0;
  const grossFundingAnnPct = avgCapital > 0 ? ((grossFunding / avgCapital) / years) * 100 : 0;

  const honestyPass = netPnl > 0 && netAnnualizedOnCapitalPct > 0;
  const honestyNotes = [];
  if (grossFunding > 0 && netPnl <= 0) {
    honestyNotes.push("gross_funding_positive_but_net_nonpositive_after_fees_basis");
  }
  if (c.feeStressMult >= 2 && !honestyPass) {
    honestyNotes.push("failed_under_fee_stress");
  }

  return {
    trades,
    summary: {
      symbol: String(symbol).toUpperCase(),
      settlements: totalIntervals,
      trades: trades.length,
      flips,
      timeInMarketPct: totalIntervals > 0 ? (timeInMarketIntervals / totalIntervals) * 100 : 0,
      years: Number(years.toFixed(4)),
      capitalDeployedPeak: peakDeployed || avgCapital,
      grossFunding,
      basisPnl: totalBasis,
      fees: totalFees,
      slipCost: totalSlip,
      netPnl,
      grossFundingAnnPct: Number(grossFundingAnnPct.toFixed(2)),
      netAnnualizedOnCapitalPct: Number(netAnnualizedOnCapitalPct.toFixed(2)),
      maxDrawdownPct: Number(maxDdPct.toFixed(2)),
      honestyPass,
      honestyNotes,
      cfg: {
        minAnnualizedYieldPct: c.minAnnualizedYieldPct,
        exitAnnualizedYieldPct: c.exitAnnualizedYieldPct,
        stabilityIntervals: c.stabilityIntervals,
        minHoldIntervals: c.minHoldIntervals,
        feeMode: c.feeMode,
        notionalUsdt: c.notionalUsdt,
        perpLeverage: c.perpLeverage,
        spotFeeRate: c.spotFeeRate,
        perpFeeRate: c.perpFeeRate,
        slippagePct: c.slippagePct,
        feeStressMult: c.feeStressMult,
      },
    },
    equityCurve,
  };
}

/**
 * Aggregate multi-symbol results.
 * @param {Array<ReturnType<typeof runFundingArbSim>>} results
 */
export function aggregateFundingArbResults(results) {
  const summaries = results.map((r) => r.summary);
  const netPnl = summaries.reduce((s, x) => s + x.netPnl, 0);
  const grossFunding = summaries.reduce((s, x) => s + x.grossFunding, 0);
  const fees = summaries.reduce((s, x) => s + x.fees, 0);
  const basis = summaries.reduce((s, x) => s + x.basisPnl, 0);
  const trades = summaries.reduce((s, x) => s + x.trades, 0);
  const capital = Math.max(...summaries.map((x) => x.capitalDeployedPeak), 0);
  const years = Math.max(...summaries.map((x) => x.years), 0.01);
  const netAnn = capital > 0 ? ((netPnl / capital) / years) * 100 : 0;
  const honestyPass = summaries.every((x) => x.honestyPass) && netPnl > 0;
  return {
    symbols: summaries.map((x) => x.symbol),
    trades,
    grossFunding,
    basisPnl: basis,
    fees,
    netPnl,
    capitalDeployedPeak: capital,
    netAnnualizedOnCapitalPct: Number(netAnn.toFixed(2)),
    honestyPass,
    perSymbol: summaries,
  };
}
