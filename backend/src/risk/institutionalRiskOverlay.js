/**
 * Institutional risk overlay — shared by backtest runner and live bot entry path.
 * Halt NEW entries only; never force-close from this module.
 */

/**
 * @param {object} args
 * @param {number} args.equity
 * @param {number} args.peakEquity
 * @param {number} args.weekStartEquity
 * @param {number} [args.barDayMs] UTC day floor ms for consecutive-loss cooldown
 * @param {Array<{netPnl?:number,exitTs?:number,exitReason?:string}>} [args.trades]
 * @param {object} args.cfg
 * @returns {{ blocked: null|"killSwitch"|"weeklyCap"|"consecCooldown", detail?: object }}
 */
export function evaluateInstitutionalRiskOverlay({
  equity,
  peakEquity,
  weekStartEquity,
  barDayMs = null,
  trades = [],
  cfg = {},
}) {
  const killSwitchDdPct = Math.max(0, Math.min(100, Number(cfg.riskKillSwitchDdPct ?? 0)));
  const weeklyDdCapPct = Math.max(0, Math.min(100, Number(cfg.riskWeeklyMaxLossPct ?? 0)));
  const consecLossLimit = Math.max(0, Math.floor(Number(cfg.riskConsecutiveLossLimit ?? 0)));

  if (killSwitchDdPct > 0 && peakEquity > 0 && ((peakEquity - equity) / peakEquity) * 100 >= killSwitchDdPct) {
    return {
      blocked: "killSwitch",
      detail: {
        ddPct: ((peakEquity - equity) / peakEquity) * 100,
        threshold: killSwitchDdPct,
      },
    };
  }

  if (
    weeklyDdCapPct > 0 &&
    weekStartEquity > 0 &&
    ((weekStartEquity - equity) / weekStartEquity) * 100 >= weeklyDdCapPct
  ) {
    return {
      blocked: "weeklyCap",
      detail: {
        weekDdPct: ((weekStartEquity - equity) / weekStartEquity) * 100,
        threshold: weeklyDdCapPct,
      },
    };
  }

  if (consecLossLimit > 0 && trades.length) {
    let tcl = 0;
    let lastExitTs = 0;
    for (let k = trades.length - 1; k >= 0; k--) {
      const t = trades[k];
      if (t.exitReason === "tp1_partial" || t.exitReason === "tp2_partial") continue;
      if (Number(t.netPnl ?? 0) < 0) {
        if (!lastExitTs) lastExitTs = Number(t.exitTs ?? 0);
        tcl++;
      } else break;
    }
    if (tcl >= consecLossLimit) {
      if (barDayMs == null) {
        return { blocked: "consecCooldown", detail: { consecutiveLosses: tcl } };
      }
      const lastLossDay = Math.floor(lastExitTs / 86_400_000) * 86_400_000;
      if (lastLossDay === barDayMs) {
        return { blocked: "consecCooldown", detail: { consecutiveLosses: tcl } };
      }
    }
  }

  return { blocked: null };
}
