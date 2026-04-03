const REGIME_CANDIDATES = {
  TRENDING: ["CONFLUENCE", "EMA_CROSS", "MOMENTUM_SURGE"],
  SIDEWAYS: ["CONFLUENCE", "RSI_MEAN", "MOMENTUM_SURGE"],
  VOLATILE: ["CONFLUENCE", "BREAKOUT_VOL", "MOMENTUM_SURGE"],
};

export function pickStrategyAuto({ regime, stats }) {
  const regimeType = regime?.type || "TRENDING";
  const candidates = REGIME_CANDIDATES[regimeType] || REGIME_CANDIDATES.TRENDING;
  const primary = candidates[0];

  if (!stats) return primary;

  const scored = candidates.map((key) => {
    const s = stats[key];
    if (!s || s.trades < 5) return { key, score: key === primary ? 1.0 : 0.5 };
    const wr = s.wins / s.trades;
    const avgPnl = s.pnl / s.trades;
    let score = wr * 0.6 + (avgPnl > 0 ? 0.4 : -0.1);
    if (key === primary) score += 0.25;
    return { key, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].key;
}

export function topStrategies(stats) {
  const rows = Object.entries(stats).map(([key, v]) => {
    const winRate = v.trades ? v.wins / v.trades : 0;
    return { key, trades: v.trades, wins: v.wins, pnl: v.pnl, winRate };
  });
  rows.sort((a, b) => (b.pnl - a.pnl) || (b.winRate - a.winRate));
  return rows.slice(0, 10);
}
