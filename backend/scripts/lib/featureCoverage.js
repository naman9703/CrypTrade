/**
 * Feature Coverage Accounting — source-prefixed observable information.
 */
import { num } from "./liqResearchStats.js";
import { getFeatureFidelity, FIDELITY_LABELS } from "./sourceFidelity.js";

export const PROMOTION_MIN_COVERAGE_PCT = 80;
export const EXPLORATORY_MIN_COVERAGE_PCT = 5;

export const ADDITIONAL_OBSERVABLE_GROUPS = {
  binance_funding: {
    id: "binance_funding",
    label: "Binance Funding",
    source: "binance",
    fidelity: "native",
    evaluationMode: "rigorous",
    minCoverageForPromotionPct: PROMOTION_MIN_COVERAGE_PCT,
    hasFlag: "binance_has_funding",
    features: [
      { col: "binance_funding_rate", label: "Funding rate" },
      { col: "binance_funding_zscore", label: "Funding z-score (30d)" },
    ],
  },
  binance_oi: {
    id: "binance_oi",
    label: "Binance OI",
    source: "binance",
    fidelity: "native",
    evaluationMode: "exploratory",
    minCoverageForPromotionPct: PROMOTION_MIN_COVERAGE_PCT,
    hasFlag: "binance_has_oi",
    features: [
      { col: "binance_oi_usdt", label: "OI (USDT)" },
      { col: "binance_oi_change_4h", label: "OI change 4h" },
      { col: "binance_oi_change_24h", label: "OI change 24h" },
      { col: "binance_long_short_ratio", label: "Long/short ratio" },
    ],
  },
  bybit_positioning: {
    id: "bybit_positioning",
    label: "Bybit Positioning (proxy)",
    source: "bybit",
    fidelity: "cross_venue_proxy",
    evaluationMode: "exploratory",
    minCoverageForPromotionPct: PROMOTION_MIN_COVERAGE_PCT,
    requiresProxyValidation: true,
    hasFlag: "bybit_has_oi",
    features: [
      { col: "bybit_oi_usdt", label: "OI (USDT est.)" },
      { col: "bybit_oi_change_4h", label: "OI change 4h" },
      { col: "bybit_oi_change_24h", label: "OI change 24h" },
      { col: "bybit_long_short_ratio", label: "Long/short ratio" },
    ],
  },
};

export const POSITIONING_DATA_MATRIX = [
  { data: "Binance Funding", historical: "full", live: true, fidelity: "native" },
  { data: "Binance OI", historical: "partial", live: true, fidelity: "native" },
  { data: "Bybit OI", historical: "full", live: true, fidelity: "cross_venue_proxy" },
  { data: "Coinalyze Daily OI", historical: "full_daily", live: true, fidelity: "native_daily" },
  { data: "Order Book", historical: false, live: true, fidelity: "native" },
];

function rowHasFlag(row, flag) {
  return row[flag] === "1" || row[flag] === 1 || row[flag] === true;
}

function rowHasValue(row, col) {
  const raw = row[col];
  if (raw == null || raw === "") return false;
  const v = num(raw);
  return v != null && Number.isFinite(v);
}

export function isValidFeatureValue(row, col) {
  return rowHasValue(row, col);
}

function entryTs(row) {
  const ts = num(row.entryTs ?? row.entry_ts ?? row.ts);
  return ts != null && Number.isFinite(ts) ? ts : null;
}

export function accountFeatureColumnCoverage(rows, col, opts = {}) {
  const meta = getFeatureFidelity(col);
  const total = rows.length;
  const valid = rows.filter((r) => rowHasValue(r, col));
  const research = rows.filter((r) => num(r.entryYear) !== 2026);
  const holdout = rows.filter((r) => num(r.entryYear) === 2026);
  const researchValid = research.filter((r) => rowHasValue(r, col));
  const holdoutValid = holdout.filter((r) => rowHasValue(r, col));
  const tsValid = valid.map(entryTs).filter((t) => t != null);
  const coveragePct = total ? (valid.length / total) * 100 : 0;
  const minPromo = opts.minCoverageForPromotionPct ?? PROMOTION_MIN_COVERAGE_PCT;
  const fidelityLabel = FIDELITY_LABELS[meta.fidelity] ?? meta.fidelity;

  return {
    feature: col,
    source: meta.source,
    fidelity: meta.fidelity,
    fidelityLabel,
    totalCandidates: total,
    validCount: valid.length,
    coveragePct,
    researchValidCount: researchValid.length,
    holdoutValidCount: holdoutValid.length,
    historicalWindow:
      tsValid.length >= 2
        ? {
            fromMs: Math.min(...tsValid),
            toMs: Math.max(...tsValid),
            spanMs: Math.max(...tsValid) - Math.min(...tsValid),
          }
        : null,
    meetsPromotionThreshold: coveragePct >= minPromo && meta.fidelity !== "cross_venue_proxy",
    evaluationConfidence:
      meta.fidelity === "cross_venue_proxy"
        ? coveragePct >= EXPLORATORY_MIN_COVERAGE_PCT
          ? "proxy_exploratory"
          : "insufficient"
        : coveragePct >= minPromo
          ? "promotion_grade"
          : coveragePct >= EXPLORATORY_MIN_COVERAGE_PCT
            ? "exploratory"
            : "insufficient",
  };
}

export function accountGroupCoverage(rows, groupKey) {
  const group = ADDITIONAL_OBSERVABLE_GROUPS[groupKey];
  if (!group) throw new Error(`unknown_group:${groupKey}`);

  const total = rows.length;
  const byFlag = rows.filter((r) => rowHasFlag(r, group.hasFlag));
  const byAnyFeature = rows.filter((r) => group.features.some((f) => rowHasValue(r, f.col)));
  const valid = byFlag.length >= byAnyFeature.length ? byFlag : byAnyFeature;
  const coveragePct = total ? (valid.length / total) * 100 : 0;

  const featureAccounts = group.features.map((f) =>
    accountFeatureColumnCoverage(rows, f.col, { minCoverageForPromotionPct: group.minCoverageForPromotionPct }),
  );

  const proxyBlocked = group.fidelity === "cross_venue_proxy";

  return {
    group: groupKey,
    label: group.label,
    source: group.source,
    fidelity: group.fidelity,
    evaluationMode: group.evaluationMode,
    totalCandidates: total,
    validCount: valid.length,
    coveragePct,
    meetsPromotionThreshold: !proxyBlocked && coveragePct >= group.minCoverageForPromotionPct,
    evaluationConfidence: proxyBlocked
      ? coveragePct >= EXPLORATORY_MIN_COVERAGE_PCT
        ? "proxy_exploratory"
        : "insufficient"
      : coveragePct >= group.minCoverageForPromotionPct
        ? "promotion_grade"
        : coveragePct >= EXPLORATORY_MIN_COVERAGE_PCT
          ? "exploratory"
          : "insufficient",
    features: featureAccounts,
  };
}

export function accountDatasetCoverage(rows) {
  const groups = Object.keys(ADDITIONAL_OBSERVABLE_GROUPS).map((k) => accountGroupCoverage(rows, k));
  return {
    totalCandidates: rows.length,
    groups,
    summary: groups.map((g) => ({
      label: g.label,
      source: g.source,
      fidelity: g.fidelity,
      coveragePct: g.coveragePct,
      evaluationMode: g.evaluationMode,
      evaluationConfidence: g.evaluationConfidence,
      meetsPromotionThreshold: g.meetsPromotionThreshold,
    })),
  };
}

export function positioningMatrixToMarkdown(matrix = POSITIONING_DATA_MATRIX) {
  const hist = (v) =>
    v === "full" ? "✅" : v === "partial" ? "⚠️ Partial" : v === "full_daily" ? "✅ Daily" : "❌";
  const live = (v) => (v ? "✅" : "❌");
  return [
    "| Data | Historical | Live | Fidelity |",
    "|------|------------|------|----------|",
    ...matrix.map(
      (r) =>
        `| ${r.data} | ${hist(r.historical)} | ${live(r.live)} | ${FIDELITY_LABELS[r.fidelity] ?? r.fidelity} |`,
    ),
  ].join("\n");
}

export function featureCoverageToMarkdown(coverage) {
  const lines = [
    "### Feature Coverage",
    "",
    "| Feature | Source | Fidelity | Coverage | Valid N | Confidence | Promo OK |",
    "|---------|--------|----------|----------|---------|------------|----------|",
  ];
  for (const g of coverage.groups) {
    lines.push(
      `| **${g.label}** | ${g.source} | ${FIDELITY_LABELS[g.fidelity] ?? g.fidelity} | ${g.coveragePct.toFixed(1)}% | ${g.validCount}/${g.totalCandidates} | ${g.evaluationConfidence} | ${g.meetsPromotionThreshold ? "yes" : "no"} |`,
    );
    for (const f of g.features) {
      lines.push(
        `| ↳ ${f.feature} | ${f.source} | ${f.fidelityLabel} | ${f.coveragePct.toFixed(1)}% | ${f.validCount} | ${f.evaluationConfidence} | ${f.meetsPromotionThreshold ? "yes" : "no"} |`,
      );
    }
  }
  return lines.join("\n");
}

export function phase2bInterpretation(coverage, results = {}) {
  const funding = coverage.groups.find((g) => g.group === "binance_funding");
  const binanceOi = coverage.groups.find((g) => g.group === "binance_oi");
  const bybit = coverage.groups.find((g) => g.group === "bybit_positioning");
  const lines = [
    "### Scientific Interpretation",
    "",
    "**Binance funding (native, rigorous):** " +
      (funding?.meetsPromotionThreshold
        ? "Full coverage — discrimination results are promotion-grade."
        : "Check funding sync before drawing conclusions."),
    "",
    "**Binance OI (native, partial history):** " +
      (binanceOi?.evaluationConfidence === "insufficient"
        ? `Only ~${binanceOi?.coveragePct?.toFixed(0)}% coverage — Binance API ~30d.`
        : "Partial native OI attached."),
    "",
    "**Bybit OI/L-S (cross-venue proxy):** " +
      (bybit?.evaluationConfidence === "proxy_exploratory"
        ? `~${bybit?.coveragePct?.toFixed(0)}% coverage — exploratory only; run proxy validation before trusting.`
        : "Insufficient Bybit coverage — sync with npm run research:bybit:sync."),
    "",
    "> Cross-venue proxies cannot be promoted without proxy fidelity validation + discrimination evidence.",
  ];
  if (results.fundingSignal != null) lines.push("", `Binance funding best Spearman: ${results.fundingSignal}`);
  if (results.bybitSignal != null) lines.push(`Bybit OI best Spearman (proxy): ${results.bybitSignal}`);
  return lines.join("\n");
}
