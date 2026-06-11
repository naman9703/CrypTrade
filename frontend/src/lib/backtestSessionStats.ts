import type { BacktestTrade } from "../types/backtest";
import { ICT_BACKTEST_SESSIONS, tradeInSession, type IctSessionDef } from "./ictSessions";

export type SessionTradeBreakdown = {
  session: IctSessionDef;
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  winPct: number;
  lossPct: number;
  breakevenPct: number;
  netPnlUsdt: number;
};

function isWin(netPnl: number): boolean {
  return netPnl > 0;
}

function isLoss(netPnl: number): boolean {
  return netPnl < 0;
}

export type SessionWeekdayCell = {
  sessionId: string;
  weekday: number;
  total: number;
  wins: number;
  winPct: number;
  netPnlUsdt: number;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayLabel(d: number): string {
  return WEEKDAYS[d] ?? "?";
}

/** Session × weekday heatmap cells (UTC weekday from entry time). */
export function breakdownSessionWeekdayHeatmap(trades: BacktestTrade[]): SessionWeekdayCell[] {
  const cells: SessionWeekdayCell[] = [];
  for (const session of ICT_BACKTEST_SESSIONS) {
    for (let wd = 0; wd < 7; wd++) {
      const inCell = trades.filter((t) => {
        if (!tradeInSession(t.entryTs, session)) return false;
        const d = new Date(t.entryTs);
        const utcWd = (d.getUTCDay() + 6) % 7;
        return utcWd === wd;
      });
      let wins = 0;
      let netPnlUsdt = 0;
      for (const t of inCell) {
        const pnl = Number(t.netPnl);
        if (!Number.isFinite(pnl)) continue;
        netPnlUsdt += pnl;
        if (pnl > 0) wins += 1;
      }
      const total = inCell.length;
      cells.push({
        sessionId: session.id,
        weekday: wd,
        total,
        wins,
        winPct: total ? (wins / total) * 100 : 0,
        netPnlUsdt,
      });
    }
  }
  return cells;
}

export function breakdownTradesBySession(trades: BacktestTrade[]): SessionTradeBreakdown[] {
  return ICT_BACKTEST_SESSIONS.map((session) => {
    const inSession = trades.filter((t) => tradeInSession(t.entryTs, session));
    const total = inSession.length;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let netPnlUsdt = 0;
    for (const t of inSession) {
      const pnl = Number(t.netPnl);
      if (!Number.isFinite(pnl)) continue;
      netPnlUsdt += pnl;
      if (isWin(pnl)) wins += 1;
      else if (isLoss(pnl)) losses += 1;
      else breakeven += 1;
    }
    const denom = total || 1;
    return {
      session,
      total,
      wins,
      losses,
      breakeven,
      winPct: total ? (wins / denom) * 100 : 0,
      lossPct: total ? (losses / denom) * 100 : 0,
      breakevenPct: total ? (breakeven / denom) * 100 : 0,
      netPnlUsdt,
    };
  });
}
