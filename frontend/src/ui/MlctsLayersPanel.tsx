export type MlctsLayerRow = {
  key: string;
  label: string;
  score: number;
  pass: boolean;
  /** Hierarchical: prior layers passed and this layer cleared its threshold. */
  cleared?: boolean;
  /** Waiting on an upstream layer — not evaluated in the chain yet. */
  blocked?: boolean;
  /** Active in chain but failed this layer's threshold. */
  failed?: boolean;
  active: boolean;
  minScore?: number | null;
  required?: boolean;
  isGate?: boolean;
  detail?: Record<string, unknown>;
};

export type MlctsFeedRow = {
  ok: boolean;
  pending?: boolean;
  label?: string;
};

export type MlctsFeeds = {
  openInterest?: MlctsFeedRow;
  funding?: MlctsFeedRow;
  orderBook?: MlctsFeedRow;
};

export type MlctsLayerStatus = {
  symbol: string;
  updatedAt?: number;
  ready?: boolean;
  score: number;
  direction?: string | null;
  allRequiredGreen?: boolean;
  signalOk?: boolean;
  layersAllPass?: boolean;
  hardVetoesOk?: boolean;
  scoreOk?: boolean;
  scoreThreshold?: number;
  layers: Record<string, MlctsLayerRow>;
  featureVector?: Record<string, unknown>;
  displayDirection?: string | null;
  warmingUp?: boolean;
  barCount?: number;
  barsNeeded?: number;
  feeds?: MlctsFeeds;
};

type FeedKey = keyof MlctsFeeds;

type MetricRow = {
  label: string;
  value: string;
  ok?: boolean | null;
  /** Binance-sourced field — show feed health dot before label. */
  feedKey?: FeedKey;
};

const LAYER_ORDER = [
  "trend",
  "liquidity",
  "sweep",
  "structure",
  "orderflow",
  "positioning",
  "volatility",
] as const;

function FeedDot({ feed }: { feed?: MlctsFeedRow }) {
  const ok = feed?.ok === true;
  const cls = ok ? "bg-emerald-500" : "bg-rose-500";
  const title = ok
    ? `${feed?.label ?? "Feed"} live`
    : feed?.pending
      ? `${feed?.label ?? "Feed"} fetching…`
      : `${feed?.label ?? "Feed"} unavailable`;
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} title={title} aria-hidden />;
}

function fmtNum(v: unknown, digits = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtPrice(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
}

function fmtBool(v: unknown): string {
  if (v === true) return "✓";
  if (v === false) return "✗";
  return "—";
}

function weeklyUnavailableLabel(d: Record<string, unknown>): string {
  const reason = String(d.weeklyReason ?? "");
  if (reason === "need_7d_history") return "— (need ≥7d of bars in buffer)";
  if (reason === "need_2nd_week") return "— (fetching weekly…)";
  if (reason === "need_binance_1w") return "— (fetching Binance 1w…)";
  return "— (weekly pending)";
}

function fmtPct(v: unknown, digits = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "—";
}

/** Proximity 0–1: extra precision when near-zero so 0.003 does not display as 0.00. */
function fmtProx(v: unknown, distanceAtr?: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  let out = n.toFixed(digits);
  const dAtr = Number(distanceAtr);
  if (Number.isFinite(dAtr) && dAtr >= 3) out += " (≥3×ATR band)";
  else if (n > 0 && n < 0.01 && Number.isFinite(dAtr) && dAtr >= 2.5) out += " (3×ATR edge)";
  return out;
}

function liquidityVwapLabel(d: Record<string, unknown>): string {
  const standalone = fmtPrice(d.vwap);
  if (standalone !== "—") return standalone;
  if (d.vwapMergedIntoTarget === true && d.sessionVwap != null) {
    return `${fmtPrice(d.sessionVwap)} → merged @ target`;
  }
  if (d.sessionVwap != null) return fmtPrice(d.sessionVwap);
  return "—";
}

function liquidityBreakdownLabel(d: Record<string, unknown>): string {
  const b = d.levelBreakdown as Record<string, number> | undefined;
  if (!b) return "—";
  const vwapPart =
    (b.vwapMerged ?? 0) > 0 ? `vwap ${b.vwap ?? 0}+${b.vwapMerged}→tgt` : `vwap ${b.vwap ?? 0}`;
  return `pdh ${b.pdh ?? 0} · pdl ${b.pdl ?? 0} · wk ${b.weekly ?? 0} · ${vwapPart} · rnd ${b.round ?? 0} · eq ${b.equal ?? 0}`;
}

function layerMetrics(key: string, d: Record<string, unknown>): MetricRow[] {
  switch (key) {
    case "trend":
      return [
        { label: "Bias", value: d.bias != null ? String(d.bias) : "—", ok: d.bias === "BULL" || d.bias === "BEAR" ? true : d.bias === "RANGE" ? false : null },
        ...(d.structureBias != null ? [{ label: "Swing structure", value: String(d.structureBias) }] : []),
        ...(d.emaBias != null ? [{ label: "EMA bias", value: String(d.emaBias) }] : []),
        ...(d.biasReason != null ? [{ label: "Bias reason", value: String(d.biasReason) }] : []),
        ...(d.structureInvalidated != null
          ? [{ label: "Structure invalidated", value: String(d.structureInvalidated) }]
          : []),
        { label: "HH / HL / LH / LL", value: `${fmtBool(d.hh)} / ${fmtBool(d.hl)} / ${fmtBool(d.lh)} / ${fmtBool(d.ll)}` },
        { label: "Swing high", value: fmtPrice(d.swingHigh) },
        { label: "Swing low", value: fmtPrice(d.swingLow) },
        { label: "Prev swing H/L", value: `${fmtPrice(d.prevSwingHigh)} / ${fmtPrice(d.prevSwingLow)}` },
        { label: "Close", value: fmtPrice(d.close) },
        { label: "EMA20", value: fmtPrice(d.ema20) },
        { label: "EMA50", value: fmtPrice(d.ema50) },
        { label: "EMA200", value: fmtPrice(d.ema200) },
        { label: "EMA stack", value: d.emaStack != null ? String(d.emaStack) : "—", ok: d.emaStack === "BULL" || d.emaStack === "BEAR" ? true : d.emaStack === "MIXED" ? false : null },
        { label: "Price > EMA200", value: fmtBool(d.priceAboveEma200), ok: d.priceAboveEma200 === true ? true : d.priceAboveEma200 === false ? false : null },
        {
          label: "ADX",
          value: d.adx != null ? `${fmtNum(d.adx, 1)} (min ${fmtNum(d.minAdx, 0)})` : "—",
          ok: Number(d.adx) >= Number(d.minAdx ?? 20) ? true : Number.isFinite(Number(d.adx)) ? false : null,
        },
      ];
    case "liquidity":
      return [
        ...(d.awaitingBias ? [{ label: "Preview side", value: "L1 bias RANGE — preview only" }] : []),
        { label: "PDH", value: fmtPrice(d.pdh) },
        { label: "PDL", value: fmtPrice(d.pdl) },
        { label: "Weekly high", value: d.weeklyReady === true ? fmtPrice(d.weeklyHigh) : weeklyUnavailableLabel(d) },
        { label: "Weekly low", value: d.weeklyReady === true ? fmtPrice(d.weeklyLow) : weeklyUnavailableLabel(d) },
        ...(d.weeklySource != null && d.weeklyReady === true
          ? [{ label: "Weekly source", value: String(d.weeklySource) }]
          : []),
        { label: "VWAP", value: liquidityVwapLabel(d) },
        { label: "Equal highs", value: d.equalHighCount != null ? `${d.equalHighCount} @ ${fmtPrice(d.nearestEqualHigh)}` : "—" },
        { label: "Equal lows", value: d.equalLowCount != null ? `${d.equalLowCount} @ ${fmtPrice(d.nearestEqualLow)}` : "—" },
        { label: "Target level", value: d.level != null ? `${fmtPrice(d.level)} (${String(d.levelType ?? "—")})` : "—" },
        {
          label: "Target strength (tradeable)",
          value:
            d.targetStrength != null
              ? `${String(d.targetStrength)} / ${String(d.baseStrength ?? "—")} base`
              : "—",
        },
        {
          label: "Structural strength",
          value: d.structuralStrength != null ? `${String(d.structuralStrength)} / 100` : "—",
        },
        ...(Array.isArray(d.mergedTypes) && d.mergedTypes.length
          ? [
              {
                label: "Confluence",
                value: `${d.confluenceCount ?? d.mergedTypes.length} types (${(d.mergedTypes as string[]).join(", ")})`,
              },
              {
                label: "Primary type strength",
                value: d.primaryTypeStrength != null ? fmtNum(Number(d.primaryTypeStrength), 2) : "—",
              },
            ]
          : []),
        ...(d.targetTouches != null
          ? [{ label: "Target touches", value: String(d.targetTouches) }]
          : []),
        {
          label: "Distance to target",
          value:
            d.distancePct != null
              ? `${fmtPct(Number(d.distancePct), 3)}${d.distanceAtr != null ? ` (${fmtNum(Number(d.distanceAtr), 2)}×ATR)` : ""}`
              : "—",
        },
        {
          label: "Prox (1−d/3ATR)",
          value: d.proxLinear != null ? fmtProx(d.proxLinear, d.distanceAtr) : "—",
        },
        { label: "ATR14", value: fmtPrice(d.atr14) },
        { label: "Level count", value: d.levelCount != null ? String(d.levelCount) : "—" },
        {
          label: "Level breakdown",
          value: d.levelBreakdown && typeof d.levelBreakdown === "object" ? liquidityBreakdownLabel(d) : "—",
        },
      ];
    case "sweep":
      return [
        ...(d.awaitingBias ? [{ label: "Preview side", value: "L1 bias RANGE — preview only" }] : []),
        { label: "Side", value: d.side != null ? String(d.side) : "—" },
        { label: "Level", value: fmtPrice(d.level) },
        { label: "Close", value: fmtPrice(d.close) },
        { label: "Wick", value: fmtPrice(d.wick) },
        { label: "Swept", value: fmtBool(d.swept), ok: d.swept === true ? true : d.swept === false ? false : null },
        { label: "Reclaim", value: fmtBool(d.reclaim), ok: d.reclaim === true ? true : d.reclaim === false ? false : null },
        { label: "Depth × ATR", value: d.sweepDepthAtr != null ? fmtNum(d.sweepDepthAtr, 2) : "—" },
        {
          label: "Close-back %",
          value: d.closeBackPct != null ? fmtPct(Number(d.closeBackPct) * 100, 3) : "—",
        },
        { label: "ATR", value: fmtPrice(d.atr) },
        { label: "Sweep min %", value: d.sweepPct != null ? fmtPct(Number(d.sweepPct) * 100, 2) : "—" },
        ...(d.depthScore != null
          ? [
              {
                label: "Score parts",
                value: `depth ${d.depthScore} + reclaim ${fmtNum(d.reclaimScore, 1)} + confirm ${fmtNum(d.confirmScore, 1)}`,
              },
            ]
          : []),
        ...(d.reason ? [{ label: "Reason", value: String(d.reason) }] : []),
      ];
    case "structure":
      return [
        ...(d.awaitingBias ? [{ label: "Preview side", value: "L1 bias RANGE — preview only" }] : []),
        { label: "BOS", value: fmtBool(d.bos), ok: d.bos === true ? true : d.bos === false ? false : null },
        { label: "BOS type", value: d.bosType != null ? String(d.bosType) : "—" },
        { label: "BOS level", value: fmtPrice(d.bosLevel) },
        { label: "Close", value: fmtPrice(d.close) },
        {
          label: "Body %",
          value: d.bodyPct != null ? `${fmtPct(Number(d.bodyPct) * 100, 0)} (min ${fmtPct(Number(d.bodyPctMin ?? 0.7) * 100, 0)})` : "—",
          ok: Number(d.bodyPct) >= Number(d.bodyPctMin ?? 0.7) ? true : Number.isFinite(Number(d.bodyPct)) ? false : null,
        },
        {
          label: "Body × ATR",
          value: d.bodyAtr != null ? `${fmtNum(d.bodyAtr, 2)} (min ${fmtNum(d.bodyAtrMin ?? 1.5, 1)})` : "—",
          ok: Number(d.bodyAtr) >= Number(d.bodyAtrMin ?? 1.5) ? true : Number.isFinite(Number(d.bodyAtr)) ? false : null,
        },
        {
          label: "Body gate",
          value: d.bodyGatePassed != null ? (d.bodyGatePassed ? "✓ (pct OR ATR)" : "✗") : "—",
          ok: d.bodyGatePassed === true ? true : d.bodyGatePassed === false ? false : null,
        },
        { label: "Displacement", value: fmtBool(d.displacement), ok: d.displacement === true ? true : d.displacement === false ? false : null },
        ...(d.displacementRequired === false
          ? [{ label: "Disp required", value: "no (score only)" }]
          : []),
        ...(d.breakScore != null
          ? [{ label: "Score parts", value: `BOS ${d.breakScore} + body ${d.bodyScore ?? 0} + disp ${d.dispScore ?? 0}` }]
          : []),
        { label: "Bar range", value: fmtPrice(d.range) },
      ];
    case "orderflow":
      return [
        ...(d.awaitingBias ? [{ label: "Preview side", value: "L1 bias RANGE — preview only" }] : []),
        ...(d.thinData === true ? [{ label: "Data quality", value: "thin / placeholder — auto fail" }] : []),
        { label: "Delta", value: d.delta != null ? fmtNum(d.delta, 0) : "—" },
        { label: "Buy vol", value: d.buyVol != null ? fmtNum(d.buyVol, 0) : "—" },
        { label: "Sell vol", value: d.sellVol != null ? fmtNum(d.sellVol, 0) : "—" },
        { label: "Delta tier", value: d.deltaTier != null ? String(d.deltaTier) : "—" },
        { label: "CVD", value: d.cvd != null ? fmtNum(d.cvd, 0) : "—" },
        { label: "CVD divergence", value: fmtBool(d.cvdDivergence), ok: d.cvdDivergence === true ? true : d.cvdDivergence === false ? false : null },
        { label: "Absorption", value: fmtBool(d.absorption), ok: d.absorption === true ? true : d.absorption === false ? false : null },
        {
          label: "Book imbalance",
          feedKey: "orderBook",
          value:
            d.bookImbalance != null
              ? `${fmtNum(d.bookImbalance, 2)} (bull ≥${fmtNum(d.bookBullMin ?? 1.5, 1)} / bear ≤${fmtNum(d.bookBearMax ?? 0.67, 2)})`
              : "—",
        },
        ...(d.deltaScore != null
          ? [
              {
                label: "Score parts",
                value: `Δ ${d.deltaScore} · div ${d.divScore ?? 0} · abs ${d.absScore ?? 0} · book ${d.bookScore ?? 0}`,
              },
            ]
          : []),
      ];
    case "positioning":
      return [
        ...(d.awaitingBias ? [{ label: "Preview side", value: "L1 bias RANGE — preview only" }] : []),
        ...(d.side != null ? [{ label: "Side", value: String(d.side) }] : []),
        ...(d.optional ? [{ label: "Data", value: "optional — missing OI/funding" }] : []),
        { label: "Price Δ", value: d.priceChangePct != null ? fmtPct(Number(d.priceChangePct), 2) : "—" },
        { label: "OI Δ", feedKey: "openInterest", value: d.oiChangePct != null ? fmtPct(Number(d.oiChangePct), 2) : "—" },
        { label: "OI class", feedKey: "openInterest", value: d.oiClass != null ? String(d.oiClass) : "—" },
        { label: "OI score", feedKey: "openInterest", value: d.oiScore != null ? fmtNum(d.oiScore, 0) : "—" },
        {
          label: "Funding",
          feedKey: "funding",
          value:
            d.fundingRatePct != null
              ? fmtPct(Number(d.fundingRatePct), 4)
              : d.fundingRate != null
                ? fmtPct(Number(d.fundingRate) * 100, 4)
                : "—",
        },
        { label: "Fund score", feedKey: "funding", value: d.fundScore != null ? fmtNum(d.fundScore, 0) : "—" },
      ];
    case "volatility":
      return [
        { label: "Gate", value: fmtBool(d.gatePassed), ok: d.gatePassed === true ? true : d.gatePassed === false ? false : null },
        { label: "ATR14", value: fmtPrice(d.atr14) },
        { label: "ATR avg20", value: fmtPrice(d.atrAvg20) },
        {
          label: "ATR expansion",
          value:
            d.atrExpansion != null
              ? `${fmtNum(d.atrExpansion, 2)}× (min ${fmtNum(d.atrGateMin ?? 1, 1)}×)`
              : "—",
          ok: Number(d.atrExpansion) >= Number(d.atrGateMin ?? 1) ? true : Number.isFinite(Number(d.atrExpansion)) ? false : null,
        },
        { label: "Vol avg20", value: d.volAvg20 != null ? fmtNum(d.volAvg20, 0) : "—" },
        ...(d.volAvgBars != null ? [{ label: "Vol avg bars", value: `${String(d.volAvgBars)} / 19` }] : []),
        ...(d.volDataOk === false ? [{ label: "Vol feed", value: "sparse — RVOL unavailable" }] : []),
        { label: "Cur vol", value: d.curVol != null ? fmtNum(d.curVol, 0) : "—" },
        {
          label: "RVOL",
          value:
            d.rvolUnavailable === true
              ? "— (no baseline)"
              : d.rvol != null
                ? `${fmtNum(d.rvol, 2)}× (min ${fmtNum(d.rvolGateMin ?? 1.5, 1)}×)`
                : "—",
          ok:
            d.rvolUnavailable === true
              ? false
              : Number(d.rvol) >= Number(d.rvolGateMin ?? 1.5)
                ? true
                : Number.isFinite(Number(d.rvol))
                  ? false
                  : null,
        },
        ...(d.expansionScore != null
          ? [
              {
                label: "Score parts",
                value: `exp ${fmtNum(d.expansionScore, 1)} + rvol ${fmtNum(d.rvolScore ?? 0, 1)}`,
              },
            ]
          : []),
        { label: "ATR %", value: d.atrPct != null ? fmtPct(Number(d.atrPct) * 100, 2) : "—" },
      ];
    default:
      return [];
  }
}

function layerCardClass(row: MlctsLayerRow): string {
  if (row.cleared) {
    return "border-emerald-500/80 bg-emerald-100/90 shadow-sm shadow-emerald-500/10 dark:border-emerald-600 dark:bg-emerald-950/50";
  }
  if (row.blocked) {
    return "border-slate-300/50 bg-slate-100/40 opacity-70 dark:border-slate-700 dark:bg-slate-900/30";
  }
  if (row.failed) {
    return "border-rose-400/70 bg-rose-50/90 dark:border-rose-800 dark:bg-rose-950/40";
  }
  // Fallback for older snapshots without hierarchical flags
  if (row.active && row.pass) {
    return "border-emerald-500/80 bg-emerald-100/90 dark:border-emerald-600 dark:bg-emerald-950/50";
  }
  if (row.active) {
    return "border-rose-400/70 bg-rose-50/90 dark:border-rose-800 dark:bg-rose-950/40";
  }
  return "border-slate-300/50 bg-slate-100/40 opacity-70 dark:border-slate-700 dark:bg-slate-900/30";
}

function LayerDot({ row }: { row: MlctsLayerRow }) {
  const cls = row.cleared
    ? "bg-emerald-500 ring-2 ring-emerald-300/60 dark:ring-emerald-700/60"
    : row.blocked
      ? "bg-slate-400"
      : row.failed
        ? "bg-rose-500"
        : row.active && row.pass
          ? "bg-emerald-500"
          : row.active
            ? "bg-rose-500"
            : "bg-slate-400";
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

function LayerMetricGrid({
  rows,
  highlight: _highlight = true,
  feeds,
}: {
  rows: MetricRow[];
  highlight?: boolean;
  feeds?: MlctsFeeds;
}) {
  if (!rows.length) return null;
  return (
    <dl className="mt-1.5 space-y-0.5 border-t border-slate-200/80 pt-1.5 dark:border-slate-700/80">
      {rows.map((m) => (
        <div key={m.label} className="flex items-baseline justify-between gap-2 text-[9px] leading-snug">
          <dt className="flex min-w-0 shrink-0 items-center gap-1 text-slate-500 dark:text-slate-400">
            {m.feedKey ? <FeedDot feed={feeds?.[m.feedKey]} /> : null}
            <span className="truncate">{m.label}</span>
          </dt>
          <dd
            className={`truncate text-right font-mono tabular-nums ${
              m.ok === true
                ? "text-emerald-700 dark:text-emerald-400"
                : m.ok === false
                  ? "text-rose-700 dark:text-rose-400"
                  : "text-slate-800 dark:text-slate-200"
            }`}
          >
            {m.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function MlctsLayersPanel({ status }: { status: MlctsLayerStatus | null | undefined }) {
  if (!status?.layers) {
    return (
      <div className="rounded-xl border border-violet-300/70 bg-violet-50/80 px-3 py-2 text-[11px] text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200">
        MLCTS layer status pending…
      </div>
    );
  }

  const threshold = status.scoreThreshold ?? 75;
  const rows = LAYER_ORDER.map((k) => status.layers[k]).filter(Boolean) as MlctsLayerRow[];
  const layersAllPass = status.layersAllPass ?? (rows.length > 0 && rows.every((r) => r.pass));
  const signalReady = status.signalOk ?? (status.allRequiredGreen === true);
  const scoreMet = status.scoreOk ?? status.score >= threshold;

  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        signalReady
          ? "border-emerald-400/70 bg-emerald-50/80 dark:border-emerald-800 dark:bg-emerald-950/25"
          : "border-violet-400/70 bg-violet-50/80 dark:border-violet-800 dark:bg-violet-950/30"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-100">
          MLCTS · {status.symbol}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            signalReady ? "bg-emerald-600 text-white" : "bg-violet-700 text-white"
          }`}
        >
          {signalReady ? "READY" : "BUILDING"}
        </span>
        {status.direction ? (
          <span className="font-mono text-[10px] text-slate-600 dark:text-slate-400">{status.direction}</span>
        ) : status.displayDirection ? (
          <span className="font-mono text-[10px] text-amber-700 dark:text-amber-300">preview {status.displayDirection}</span>
        ) : null}
        {status.warmingUp ? (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">
            warming up ({status.barCount ?? "?"} / {status.barsNeeded ?? 120} bars)
          </span>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {rows.map((row) => {
          const metrics = layerMetrics(row.key, row.detail ?? {});
          const minLabel = row.isGate
            ? "gate"
            : row.minScore != null
              ? `100 · pass ≥${row.minScore}`
              : "100";
          const statusLabel = row.cleared ? "✓" : row.blocked ? "wait" : row.failed ? "—" : row.pass ? "✓" : "—";
          return (
            <div key={row.key} className={`rounded-md border px-2.5 py-2 transition-colors ${layerCardClass(row)}`}>
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <LayerDot row={row} />
                  <span
                    className={`truncate text-[10px] font-semibold leading-tight ${
                      row.cleared
                        ? "text-emerald-900 dark:text-emerald-100"
                        : row.failed
                          ? "text-rose-900 dark:text-rose-100"
                          : "text-slate-800 dark:text-slate-200"
                    }`}
                  >
                    {row.label}
                  </span>
                  {row.isGate ? (
                    <span className="shrink-0 rounded bg-amber-200 px-1 text-[8px] font-bold uppercase text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      gate
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-baseline gap-1">
                  <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {row.score}
                  </span>
                  <span className="text-[9px] text-slate-500 dark:text-slate-400">/ {minLabel}</span>
                  <span
                    className={`text-[9px] font-semibold ${
                      row.cleared
                        ? "text-emerald-700 dark:text-emerald-400"
                        : row.failed
                          ? "text-rose-700 dark:text-rose-400"
                          : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>
              </div>
              <LayerMetricGrid rows={metrics} highlight feeds={status.feeds} />
            </div>
          );
        })}
      </div>

      <div
        className={`mt-2.5 rounded-md border px-2.5 py-2 transition-colors ${
          signalReady
            ? "border-emerald-500/80 bg-emerald-100/90 dark:border-emerald-600 dark:bg-emerald-950/50"
            : scoreMet && status.hardVetoesOk
              ? "border-violet-400/60 bg-violet-50/80 dark:border-violet-800 dark:bg-violet-950/30"
              : "border-slate-300/50 bg-white/50 dark:border-slate-700 dark:bg-slate-900/30"
        }`}
      >
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className={signalReady ? "font-semibold text-emerald-900 dark:text-emerald-100" : "text-slate-600 dark:text-slate-400"}>
            L8 Composite score
          </span>
          <span className={`font-mono font-semibold ${signalReady ? "text-emerald-800 dark:text-emerald-200" : ""}`}>
            {status.score} / {threshold}
            {signalReady ? " ✓ signal" : scoreMet ? " (score ✓)" : ""}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className={`h-full transition-all ${signalReady ? "bg-emerald-500" : "bg-violet-500"}`}
            style={{ width: `${Math.min(100, (status.score / threshold) * 100)}%` }}
          />
        </div>
        <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
          {signalReady
            ? "Direction + L7 vol gate + composite threshold + valid brackets — trade fires on bar close."
            : scoreMet && status.hardVetoesOk
              ? `Composite ≥ ${threshold} but brackets or hard veto blocked signal.`
              : layersAllPass
                ? "All L1–L7 pass flags green (diagnostic) — composite or hard veto still blocking signal."
                : "Per-layer pass flags are diagnostic. Entry uses direction + L7 gate + composite only."}
        </p>
      </div>
    </div>
  );
}
