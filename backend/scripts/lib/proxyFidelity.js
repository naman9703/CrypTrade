/**
 * Per-symbol cross-venue proxy fidelity — from research-bybit-proxy-validate.mjs (28d overlap).
 * Asset-dependent: ETH/SOL/BNB credible; BTC/XRP weak.
 */
export const PROXY_FIDELITY_BY_SYMBOL = {
  BTCUSDT: {
    pearsonOi: 0.341,
    spearmanOi: 0.359,
    credibleProxy: false,
    note: "Cross-venue OI diverges — do not use Bybit as Binance OI proxy",
  },
  BNBUSDT: {
    pearsonOi: 0.705,
    spearmanOi: 0.603,
    credibleProxy: true,
    note: "Reasonable cross-venue proxy",
  },
  ETHUSDT: {
    pearsonOi: 0.79,
    spearmanOi: 0.775,
    credibleProxy: true,
    note: "Strong cross-venue proxy",
  },
  SOLUSDT: {
    pearsonOi: 0.861,
    spearmanOi: 0.795,
    credibleProxy: true,
    note: "Strongest cross-venue proxy in set",
  },
  XRPUSDT: {
    pearsonOi: 0.119,
    spearmanOi: 0.2,
    credibleProxy: false,
    note: "Cross-venue OI diverges — do not use Bybit as Binance OI proxy",
  },
};

export const PROXY_MIN_PEARSON = 0.7;

export function isCredibleProxyForSymbol(symbol, minPearson = PROXY_MIN_PEARSON) {
  const row = PROXY_FIDELITY_BY_SYMBOL[symbol];
  if (!row) return false;
  return row.pearsonOi >= minPearson;
}

export function proxyFidelityForSymbol(symbol) {
  return PROXY_FIDELITY_BY_SYMBOL[symbol] ?? { credibleProxy: false, note: "not validated" };
}

export function proxyFidelityToMarkdown() {
  const lines = [
    "# Proxy Fidelity (Bybit OI vs Binance OI)",
    "",
    "Cross-venue behavior is **asset-dependent**. Use per-symbol fidelity before trusting Bybit as a Binance OI proxy.",
    "",
    "| Symbol | Pearson | Spearman | Credible proxy |",
    "|--------|---------|----------|----------------|",
  ];
  for (const [sym, r] of Object.entries(PROXY_FIDELITY_BY_SYMBOL)) {
    lines.push(
      `| ${sym} | ${r.pearsonOi.toFixed(3)} | ${r.spearmanOi.toFixed(3)} | ${r.credibleProxy ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    "> ETH/SOL/BNB: reasonable proxy for exploratory research. BTC/XRP: not credible at 15m candidate ranking.",
  );
  return lines.join("\n");
}
