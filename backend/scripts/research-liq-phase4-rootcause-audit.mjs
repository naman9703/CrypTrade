#!/usr/bin/env node
/**
 * Phase 0–4: Clean LIQ_CORE baseline + trade-level root-cause audit.
 *
 * NO strategy parameter changes. Diagnosis only.
 *
 * - Phase 0: definitions locked in docs/LIQ_SWEEP_RECLAIM_PHASE0.md
 * - Phase 1: regime tags from liqFeatures.marketState + ADX/ATR
 * - Phase 2: INTRADAY_PRO_LIQ_CORE_15M with research-sleeve knobs pinned OFF
 * - Phase 3: full trade log (JSONL + summary)
 * - Phase 4: every loser → taxonomy; $ share by category × regime
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-phase4-rootcause-audit.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2025-07-01";
const TO = process.env.TO || "2026-07-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { rejectionWickRatio } = await import("../src/strategy/techniques/liquidity.js");

/** Clean control — every research sleeve knob explicitly off. */
const BASELINE = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  riskConsecutiveLossLimit: 0,
  // Pin sleeves OFF
  intradayLiqDaySituationBias: false,
  intradayLiqMitigationEntry: false,
  intradayLiqMitigationFrac: 0,
  intradayLiqMitigationWaitBars: 0,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqSweepDisplacementMinAtrMult: 0,
  intradayLiqRequireSweepDisplacement: false,
  intradayLiqRequireFollowThrough: false,
  intradayLiqRequirePostReclaimDisplacement: false,
  intradayLiqMarketStateGate: false,
  intradayLiqRequireKillzone: false,
  intradayLiqSweepQualityGate: false,
  intradayLiqContinuationGate: false,
  intradayLiqRequireChoch: false,
  intradayLiqTrendContinuation: false,
  intradayLiqBreakdownDayBias: false,
  intradayLiqVetoCounterTrend: false,
  intradayLiqUseEntryScore: false,
  intradayLiqUseEntryScoreV2: false,
  intradayLiqMinSlPct: 0,
  intradayGateLiquidity: true,
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  intradayGateInstitutionalSr: false,
};

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const t = Number(ts);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].ts);
    if (ct === t) return mid;
    if (ct < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function hourUtc(ts) {
  return new Date(Number(ts)).getUTCHours();
}

/** Low-liquidity crypto hours (UTC): Asia lunch / late US → early Asia. */
function isOffSession(hour) {
  return hour >= 0 && hour < 7; // 00–07 UTC thin for BNB vs London/NY overlap
}

function rMultiple(t) {
  const risk = Number(t.initialRiskUsd ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (!(risk > 0)) return null;
  return pnl / risk;
}

/**
 * Primary root-cause label for a LOSING trade (taxonomy from user prompt).
 * Order = priority when multiple flags fire (highest-confidence first).
 */
function classifyLoser(row) {
  const flags = [];
  const f = row.features || {};
  const sweep = f.sweep || {};
  const disp = f.displacement || {};
  const ms = f.marketState || {};
  const mfe = Number(row.mfePct ?? 0);
  const mae = Number(row.maePct ?? 0);
  const side = row.side;
  const regime = String(ms.regime ?? row.regime ?? "UNKNOWN");
  const daySit = String(ms.daySituation ?? "range");
  const impulse = Number(disp.impulseAtr ?? 0);
  const mom = Number(disp.momentumPersistence ?? 0);
  const volSpike = Number(sweep.sweepVolSpike ?? 0);
  const exhaust = Number(sweep.exhaustionScore ?? 0);
  const wickBody = Number(row.sweepWickBodyRatio ?? 0);
  const distSl = Number(row.distSlPct ?? 0);
  const atrPct = Number(ms.atrPct ?? 0);
  const hour = row.hourUtc;

  // 4. Regime mismatch — fade into accepted break day / against strong trend
  if (side === "BUY" && (daySit === "breakdown" || regime === "TREND_DOWN")) {
    flags.push({ code: "regime_mismatch", w: 3, detail: `${side}|${daySit}|${regime}` });
  }
  if (side === "SELL" && (daySit === "breakout" || regime === "TREND_UP")) {
    flags.push({ code: "regime_mismatch", w: 3, detail: `${side}|${daySit}|${regime}` });
  }

  // 1. Low-quality sweep
  if (wickBody > 0 && wickBody < 0.45 && exhaust < 0.35) {
    flags.push({ code: "low_quality_sweep", w: 2, detail: `wickBody=${wickBody.toFixed(2)} exh=${exhaust}` });
  }
  if (volSpike > 0 && volSpike < 1.15 && exhaust < 0.4) {
    flags.push({ code: "low_quality_sweep", w: 2, detail: `volSpike=${volSpike}` });
  }

  // 3. Missing displacement (entry without follow-through strength at signal)
  if (impulse > 0 && impulse < 0.8 && mom < 0.35) {
    flags.push({ code: "missing_displacement", w: 3, detail: `imp=${impulse.toFixed(2)} mom=${mom}` });
  }

  // 2. False reclaim — never green or micro MFE (auction rejected the fade immediately)
  if (mfe <= 0.001) {
    flags.push({ code: "false_reclaim", w: 4, detail: "never_green" });
  } else if (mfe < 0.005) {
    flags.push({ code: "false_reclaim", w: 3, detail: "micro_mfe" });
  }

  // 5. Bad stop placement
  if (atrPct > 0 && distSl > 0) {
    const slAtr = distSl / atrPct;
    if (slAtr < 1.2) flags.push({ code: "bad_stop", w: 2, detail: `sl/ATR=${slAtr.toFixed(2)} tight` });
    if (slAtr > 5) flags.push({ code: "bad_stop", w: 1, detail: `sl/ATR=${slAtr.toFixed(2)} wide` });
  }

  // 6. Bad exit — had real MFE then gave it all back
  if (mfe >= 0.01 && Number(row.netPnl) < 0) {
    flags.push({ code: "bad_exit", w: 3, detail: `mfe=${(mfe * 100).toFixed(2)}% then loss` });
  }

  // 7. Session / liquidity timing
  if (isOffSession(hour)) {
    flags.push({ code: "session_timing", w: 2, detail: `hour=${hour}` });
  }

  // 8. HTF conflict proxy via daySituation already in regime_mismatch; add ADX strong fade
  const adx = Number(ms.adx ?? 0);
  if (adx >= 30 && ((side === "BUY" && regime === "TREND_DOWN") || (side === "SELL" && regime === "TREND_UP"))) {
    flags.push({ code: "htf_conflict", w: 3, detail: `adx=${adx}` });
  }

  if (!flags.length) {
    return { primary: "other_unclassified", flags: [], detail: `mfe=${mfe} mae=${mae}` };
  }
  flags.sort((a, b) => b.w - a.w);
  return { primary: flags[0].code, flags, detail: flags[0].detail };
}

function metricsOf(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    meanR: (() => {
      const rs = s.map(rMultiple).filter((x) => x != null);
      if (!rs.length) return null;
      return +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3);
    })(),
  };
}

function barShape(bar, side) {
  if (!bar) return { wickBody: null };
  const wickR = rejectionWickRatio(bar, side);
  return { wickBody: wickR };
}

// ─── run ───────────────────────────────────────────────────────────────────
console.log("=== Phase 2–4: clean LIQ_CORE baseline + root-cause audit ===");
console.log(`window ${FROM} → ${TO}  ${SYMBOL} ${TF}`);

const pad = 40 * 864e5;
const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);

// Data quality snapshot
let gaps = 0;
let zeroVol = 0;
const step = 15 * 60e3;
for (let i = 1; i < candles.length; i++) {
  const dt = Number(candles[i].ts) - Number(candles[i - 1].ts);
  if (dt > step * 1.5) gaps++;
  if (!(Number(candles[i].volume) > 0)) zeroVol++;
}
console.log(`candles=${candles.length} gaps≈${gaps} zeroVol=${zeroVol}`);

clearIntradayAdapterCache?.();
let cfg = { ...BASELINE, backtestSignalStartMs: fromMs };
cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
const sim = await runSimulation({
  strategyKey: "SR_INTRADAY",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: funding,
  startingUsdt: 100,
  timeframe: TF,
  adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
  symbol: SYMBOL,
});

const trades = (sim.trades ?? [])
  .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
  .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);

const baselineMetrics = metricsOf(trades, fromMs, toMs);
console.log("\nBASELINE metrics:", baselineMetrics);

const rows = [];
for (const t of trades) {
  const entryIdx = findIdx(candles, t.entryTs);
  const ctx = t.liqContext && typeof t.liqContext === "object" ? t.liqContext : {};
  const feats = ctx.features || t.features || t.liqFeatures || {};
  const ms = feats.marketState || {};
  const side = String(t.direction || t.side || t.entrySide || "").toUpperCase();
  const entryBar = candles[entryIdx];
  const reclaimIdx = Number(feats.reclaimIdx ?? feats.sweep?.reclaimIdx ?? NaN);
  const reclaimBar = Number.isFinite(reclaimIdx) ? candles[reclaimIdx] : null;
  const wickShape = barShape(reclaimBar || entryBar, side);

  const entryPx = Number(t.entryPrice ?? t.entryPx ?? 0);
  const slPx = Number(t.initialSlPrice ?? t.slPrice ?? 0);
  const distSlPct = entryPx > 0 && slPx > 0 ? Math.abs(entryPx - slPx) / entryPx : 0;

  const row = {
    entryTs: t.entryTs,
    exitTs: t.exitTs,
    side,
    levelType: ctx.levelType ?? t.levelType ?? feats.level?.type ?? null,
    regime: ms.regime ?? t.regime ?? null,
    daySituation: ms.daySituation ?? null,
    hourUtc: hourUtc(t.entryTs),
    offSession: isOffSession(hourUtc(t.entryTs)),
    adx: ms.adx ?? null,
    atrPct: ms.atrPct ?? null,
    mfePct: t.mfePct,
    maePct: t.maePct,
    netPnl: t.netPnl,
    rMult: rMultiple(t),
    exitReason: t.exitReason,
    barsHeld: t.barsHeld,
    distSlPct,
    sweepWickBodyRatio: wickShape.wickBody,
    features: {
      marketState: ms,
      sweep: feats.sweep ?? null,
      displacement: feats.displacement ?? null,
      continuation: feats.continuation ?? null,
      level: feats.level ?? null,
    },
  };

  if (Number(t.netPnl) <= 0) {
    const cls = classifyLoser(row);
    row.rootCause = cls.primary;
    row.rootCauseDetail = cls.detail;
    row.rootCauseFlags = cls.flags.map((x) => x.code);
  } else {
    row.rootCause = "winner";
    row.rootCauseDetail = null;
    row.rootCauseFlags = [];
  }
  rows.push(row);
}

// ─── Phase 4 summary ───────────────────────────────────────────────────────
const losers = rows.filter((r) => r.rootCause !== "winner");
const lossDollars = losers.reduce((s, r) => s + Math.abs(Math.min(0, Number(r.netPnl))), 0);
const byCause = {};
const byCauseRegime = {};
const byRegime = {};

for (const r of losers) {
  const c = r.rootCause;
  const reg = String(r.regime ?? "UNKNOWN");
  byCause[c] ??= { n: 0, pnl: 0, lossAbs: 0 };
  byCause[c].n += 1;
  byCause[c].pnl += Number(r.netPnl);
  byCause[c].lossAbs += Math.abs(Math.min(0, Number(r.netPnl)));
  const key = `${c}|${reg}`;
  byCauseRegime[key] ??= { n: 0, pnl: 0 };
  byCauseRegime[key].n += 1;
  byCauseRegime[key].pnl += Number(r.netPnl);
}

for (const r of rows) {
  const reg = String(r.regime ?? "UNKNOWN");
  byRegime[reg] ??= { n: 0, wins: 0, pnl: 0 };
  byRegime[reg].n += 1;
  byRegime[reg].pnl += Number(r.netPnl);
  if (Number(r.netPnl) > 0) byRegime[reg].wins += 1;
}

const causeRank = Object.entries(byCause)
  .map(([k, v]) => ({
    cause: k,
    n: v.n,
    pctOfLosers: +((v.n / Math.max(1, losers.length)) * 100).toFixed(1),
    pctOfLossDollars: +((v.lossAbs / Math.max(1e-9, lossDollars)) * 100).toFixed(1),
    pnl: +v.pnl.toFixed(2),
  }))
  .sort((a, b) => b.pctOfLossDollars - a.pctOfLossDollars);

const regimeRows = Object.entries(byRegime)
  .map(([k, v]) => ({
    regime: k,
    n: v.n,
    wr: +((v.wins / v.n) * 100).toFixed(1),
    pnl: +v.pnl.toFixed(2),
    avg: +(v.pnl / v.n).toFixed(3),
  }))
  .sort((a, b) => a.pnl - b.pnl);

console.log("\n══ Phase 4 — loss taxonomy (% of loss $) ══");
for (const r of causeRank) {
  console.log(
    `  ${r.cause.padEnd(22)} n=${String(r.n).padStart(3)}  ${String(r.pctOfLosers).padStart(5)}% losers  ${String(r.pctOfLossDollars).padStart(5)}% $loss  pnl=${r.pnl}`,
  );
}

console.log("\n══ Performance by regime ══");
for (const r of regimeRows) {
  console.log(
    `  ${r.regime.padEnd(16)} n=${String(r.n).padStart(3)} wr=${String(r.wr).padStart(5)}% pnl=${String(r.pnl).padStart(8)} avg=${r.avg}`,
  );
}

console.log("\n══ Top cause × regime cells (by |pnl|) ══");
Object.entries(byCauseRegime)
  .map(([k, v]) => ({ k, n: v.n, pnl: +v.pnl.toFixed(2) }))
  .sort((a, b) => a.pnl - b.pnl)
  .slice(0, 12)
  .forEach((r) => console.log(`  ${String(r.n).padStart(3)}  pnl=${String(r.pnl).padStart(8)}  ${r.k}`));

// Winner vs loser feature contrast (for Phase 5 hypothesis)
function mean(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
const winners = rows.filter((r) => r.rootCause === "winner");
const contrast = {
  impulseAtr: {
    win: mean(winners.map((r) => Number(r.features?.displacement?.impulseAtr))),
    loss: mean(losers.map((r) => Number(r.features?.displacement?.impulseAtr))),
  },
  momentum: {
    win: mean(winners.map((r) => Number(r.features?.displacement?.momentumPersistence))),
    loss: mean(losers.map((r) => Number(r.features?.displacement?.momentumPersistence))),
  },
  volSpike: {
    win: mean(winners.map((r) => Number(r.features?.sweep?.sweepVolSpike))),
    loss: mean(losers.map((r) => Number(r.features?.sweep?.sweepVolSpike))),
  },
  exhaustion: {
    win: mean(winners.map((r) => Number(r.features?.sweep?.exhaustionScore))),
    loss: mean(losers.map((r) => Number(r.features?.sweep?.exhaustionScore))),
  },
  wickBody: {
    win: mean(winners.map((r) => Number(r.sweepWickBodyRatio))),
    loss: mean(losers.map((r) => Number(r.sweepWickBodyRatio))),
  },
  distSlPct: {
    win: mean(winners.map((r) => Number(r.distSlPct))),
    loss: mean(losers.map((r) => Number(r.distSlPct))),
  },
  mfePct: {
    win: mean(winners.map((r) => Number(r.mfePct))),
    loss: mean(losers.map((r) => Number(r.mfePct))),
  },
};
console.log("\n══ Winner vs loser feature means ══");
for (const [k, v] of Object.entries(contrast)) {
  console.log(
    `  ${k.padEnd(14)} win=${v.win == null ? "n/a" : v.win.toFixed(4)}  loss=${v.loss == null ? "n/a" : v.loss.toFixed(4)}`,
  );
}

const topCause = causeRank[0]?.cause ?? null;
const out = {
  generatedAt: new Date().toISOString(),
  phase0Doc: "docs/LIQ_SWEEP_RECLAIM_PHASE0.md",
  window: { from: FROM, to: TO },
  symbol: SYMBOL,
  timeframe: TF,
  dataQuality: { candles: candles.length, gapsApprox: gaps, zeroVol },
  baseline: BASELINE,
  baselineMetrics,
  nTrades: rows.length,
  nLosers: losers.length,
  lossDollars: +lossDollars.toFixed(2),
  causeRank,
  regimeRows,
  causeRegimeTop: Object.entries(byCauseRegime)
    .map(([k, v]) => ({ cell: k, n: v.n, pnl: +v.pnl.toFixed(2) }))
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 20),
  featureContrast: contrast,
  diagnosis: {
    topLossCause: topCause,
    topLossSharePct: causeRank[0]?.pctOfLossDollars ?? null,
    note:
      "Phase 5 may address ONLY the topLossCause with one isolated, toggleable change. " +
      "Do not stack filters. Do not accept N-only cuts without OOS expectancy lift.",
  },
  trades: rows,
};

const jsonPath = path.join(__dirname, ".liq-phase4-rootcause-audit.json");
const jsonlPath = path.join(__dirname, ".liq-phase4-trade-log.jsonl");
fs.writeFileSync(jsonPath, JSON.stringify({ ...out, trades: undefined, nTradesLogged: rows.length }, null, 2));
fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const decisionPath = path.join(
  __dirname,
  ".research-decisions",
  "2026-07-25-liq-phase4-rootcause-audit.md",
);
const md = `# Phase 4 root-cause audit — BNB LIQ_CORE clean baseline (2026-07-25)

**Window:** ${FROM} → ${TO} · BNBUSDT 15m  
**Baseline:** \`INTRADAY_PRO_LIQ_CORE_15M\` with all research sleeves pinned OFF  
(see \`docs/LIQ_SWEEP_RECLAIM_PHASE0.md\`).

Artifacts: \`.liq-phase4-rootcause-audit.json\`, \`.liq-phase4-trade-log.jsonl\`  
Script: \`research-liq-phase4-rootcause-audit.mjs\`

## Baseline metrics

| n | tw | ret% | PF | WR% | DD% | meanR |
|---|----|------|----|-----|-----|-------|
| ${baselineMetrics.n} | ${baselineMetrics.tw} | ${baselineMetrics.ret} | ${baselineMetrics.pf} | ${baselineMetrics.wr} | ${baselineMetrics.dd} | ${baselineMetrics.meanR ?? "—"} |

## Loss taxonomy (sorted by % of loss dollars)

| Cause | n | % losers | % loss $ | pnl |
|-------|---|----------|----------|-----|
${causeRank.map((r) => `| ${r.cause} | ${r.n} | ${r.pctOfLosers}% | ${r.pctOfLossDollars}% | ${r.pnl} |`).join("\n")}

## Performance by regime

| Regime | n | WR% | pnl | avg |
|--------|---|-----|-----|-----|
${regimeRows.map((r) => `| ${r.regime} | ${r.n} | ${r.wr} | ${r.pnl} | ${r.avg} |`).join("\n")}

## Feature contrast (win vs loss means)

| Feature | winners | losers |
|---------|---------|--------|
${Object.entries(contrast)
  .map(
    ([k, v]) =>
      `| ${k} | ${v.win == null ? "n/a" : v.win.toFixed(4)} | ${v.loss == null ? "n/a" : v.loss.toFixed(4)} |`,
  )
  .join("\n")}

## Diagnosis

**Top loss cause:** \`${topCause}\` (${causeRank[0]?.pctOfLossDollars ?? "?"}% of loss $).

**Hard rule reminder:** a change that only cuts frequency with unchanged WR / no expectancy
lift is a **reject**. Address this top cause with **one** isolated hypothesis next
(Phase 5) — tune on first 70% of Y1, validate on last 30%.

## Explicitly NOT done in this step

- No BUYBD / toxic / mitigation / MinSl / displacement gate changes.
- No parameter sweeps.
- Prior sleeve \`INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M\` remains **superseded / not deployable**
  (2026 H1 −9.6%); do not use it as the research baseline.
`;
fs.writeFileSync(decisionPath, md);
console.log(`\nWrote ${jsonPath}`);
console.log(`Wrote ${jsonlPath}`);
console.log(`Wrote ${decisionPath}`);
console.log(`\n>>> TOP CAUSE: ${topCause} (${causeRank[0]?.pctOfLossDollars}% of loss $)`);

await closePool?.();
