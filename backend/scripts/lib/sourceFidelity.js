/**
 * Source Fidelity — every feature declares its origin and promotion rules.
 */
import { isCredibleProxyForSymbol } from "./proxyFidelity.js";
export const SOURCE_FIDELITY = {
  binance_funding_rate: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "rigorous",
    requiresProxyValidation: false,
    promotionAllowed: true,
  },
  binance_funding_zscore: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "rigorous",
    requiresProxyValidation: false,
    promotionAllowed: true,
  },
  binance_oi_usdt: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
    note: "Binance OI API ~30d only",
  },
  binance_oi_change_4h: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
  },
  binance_oi_change_24h: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
  },
  binance_long_short_ratio: {
    source: "binance",
    fidelity: "native",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
  },
  bybit_oi_usdt: {
    source: "bybit",
    fidelity: "cross_venue_proxy",
    evaluationMode: "exploratory",
    requiresProxyValidation: true,
    promotionAllowed: false,
    minProxyPearson: 0.7,
  },
  bybit_oi_change_4h: {
    source: "bybit",
    fidelity: "cross_venue_proxy",
    evaluationMode: "exploratory",
    requiresProxyValidation: true,
    promotionAllowed: false,
    minProxyPearson: 0.7,
  },
  bybit_oi_change_24h: {
    source: "bybit",
    fidelity: "cross_venue_proxy",
    evaluationMode: "exploratory",
    requiresProxyValidation: true,
    promotionAllowed: false,
    minProxyPearson: 0.7,
  },
  bybit_long_short_ratio: {
    source: "bybit",
    fidelity: "cross_venue_proxy",
    evaluationMode: "exploratory",
    requiresProxyValidation: true,
    promotionAllowed: false,
    minProxyPearson: 0.6,
  },
  coinalyze_daily_oi: {
    source: "coinalyze",
    fidelity: "native_daily",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
    note: "Daily OI via Coinalyze — integrated",
  },
  coinalyze_liq_4h_usd: {
    source: "coinalyze",
    fidelity: "aggregated",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
    note: "Aggregated liquidation sum 4h — abstention research",
  },
  coinalyze_liq_total_usd: {
    source: "coinalyze",
    fidelity: "aggregated",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
  },
  coinalyze_oi_change_4h: {
    source: "coinalyze",
    fidelity: "aggregated",
    evaluationMode: "exploratory",
    requiresProxyValidation: false,
    promotionAllowed: false,
  },
};

export const FIDELITY_LABELS = {
  native: "Native",
  cross_venue_proxy: "Cross-venue Proxy",
  native_daily: "Native Daily",
  external_context: "External Context",
};

/** Proxy validation results keyed by symbol — populated by research-bybit-proxy-validate.mjs */
export let proxyValidationCache = null;

export function setProxyValidationResults(results) {
  proxyValidationCache = results;
}

export function getFeatureFidelity(featureCol) {
  return SOURCE_FIDELITY[featureCol] ?? { fidelity: "unknown", promotionAllowed: false };
}

export function canPromoteFeature(featureCol, proxyResults = proxyValidationCache, symbol = null) {
  const meta = getFeatureFidelity(featureCol);
  if (!meta.promotionAllowed && meta.fidelity === "cross_venue_proxy") return false;
  if (!meta.requiresProxyValidation) return meta.promotionAllowed !== false;
  const symResults = proxyResults?.coins ?? proxyResults;
  if (!symResults) return false;
  const minP = meta.minProxyPearson ?? 0.7;
  if (symbol) {
    const row = symResults[symbol];
    return (row?.pearsonOi >= minP || isCredibleProxyForSymbol(symbol, minP)) && meta.promotionAllowed;
  }
  const passes = Object.keys(symResults).some(
    (sym) => symResults[sym]?.pearsonOi >= minP || isCredibleProxyForSymbol(sym, minP),
  );
  return passes && meta.promotionAllowed;
}

export function sourceFidelityToMarkdown(proxyResults = null) {
  const lines = [
    "# Source Fidelity",
    "",
    "| Feature | Source | Fidelity | Proxy validation required | Auto-promotion |",
    "|---------|--------|----------|-------------------------|----------------|",
  ];
  for (const [col, m] of Object.entries(SOURCE_FIDELITY)) {
    lines.push(
      `| ${col} | ${m.source} | ${FIDELITY_LABELS[m.fidelity] ?? m.fidelity} | ${m.requiresProxyValidation ? "yes" : "no"} | ${m.promotionAllowed ? "yes" : "no"} |`,
    );
  }
  if (proxyResults?.coins) {
    lines.push("", "## Proxy validation (Bybit vs Binance OI)", "");
    lines.push("| Symbol | Pearson | Spearman | Same-direction 4h % | Regime agree % |", "|--------|---------|----------|---------------------|----------------|");
    for (const [sym, r] of Object.entries(proxyResults.coins)) {
      lines.push(
        `| ${sym} | ${fmt(r.pearsonOi)} | ${fmt(r.spearmanOi)} | ${fmt(r.sameDirection4hPct)} | ${fmt(r.regimeAgreePct)} |`,
      );
    }
  }
  lines.push(
    "",
    "> Cross-venue proxy features require proxy validation + discrimination evidence before production promotion.",
  );
  return lines.join("\n");
}

function fmt(v) {
  return v == null ? "—" : typeof v === "number" ? v.toFixed(3) : String(v);
}
