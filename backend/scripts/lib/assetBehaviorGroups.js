/**
 * Asset grouping by market characteristics — not arbitrary coin percentages.
 */

export const ASSET_BEHAVIOR_GROUPS = {
  large_cap_trend: {
    id: "large_cap_trend",
    name: "Large-cap trend followers",
    description: "BTC, ETH — higher liquidity, trend persistence",
    symbols: ["BTCUSDT", "ETHUSDT"],
    objective: "universal_core",
  },
  high_beta_alt: {
    id: "high_beta_alt",
    name: "High-beta altcoins",
    description: "SOL, BNB — higher beta, faster moves",
    symbols: ["SOLUSDT", "BNBUSDT"],
    objective: "specialized",
  },
  mid_cap_rotation: {
    id: "mid_cap_rotation",
    name: "Mid-cap rotation",
    description: "XRP and similar — distinct flow characteristics",
    symbols: ["XRPUSDT"],
    objective: "specialized",
  },
};

export const DEPLOYMENT_OBJECTIVES = {
  universal: {
    id: "universal",
    description: "Must survive all major asset behavior groups",
    requiredGroups: ["large_cap_trend", "high_beta_alt"],
  },
  specialized: {
    id: "specialized",
    description: "Must survive assets sharing similar characteristics within a group",
    minGroupsPositive: 1,
  },
};

export function symbolToGroup(symbol) {
  for (const g of Object.values(ASSET_BEHAVIOR_GROUPS)) {
    if (g.symbols.includes(symbol)) return g;
  }
  return null;
}

export function evaluateAssetGroupStability(sliceBySymbol, groups = ASSET_BEHAVIOR_GROUPS) {
  const out = {};
  for (const g of Object.values(groups)) {
    const slices = g.symbols
      .map((s) => sliceBySymbol[s])
      .filter(Boolean);
    const positive = slices.filter((s) => (s.spread ?? 0) > 0 && (s.monotonicity ?? 0) > 0);
    out[g.id] = {
      name: g.name,
      tested: slices.length,
      positive: positive.length,
      avgSpread: slices.length
        ? slices.reduce((a, s) => a + (s.spread ?? 0), 0) / slices.length
        : null,
      passesSpecialized: positive.length >= 1,
      passesUniversal: positive.length === slices.length && slices.length > 0,
    };
  }
  return out;
}
