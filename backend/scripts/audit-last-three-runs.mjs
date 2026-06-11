#!/usr/bin/env node
/**
 * Thorough audit of last N backtest runs: replay fidelity, PnL math, compounding, per-trade checks.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const N = Number(process.env.N || 3);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runs = (
  await pool.query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
       FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      ORDER BY br.created_at DESC
      LIMIT $1`,
    [N],
  )
).rows.reverse(); // oldest first of the three

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { tradeBreakdown } = await import("../src/backtest/engine/costModel.js");
const { resolveCostModel } = await import("../src/backtest/engine/costModel.js");
const { portfolioReplay, tradesToREvents } = await import("../src/backtest/engine/portfolioReplay.js");

function pickBotCfg(snapshot, fallback) {
  const root = snapshot && typeof snapshot === "object" ? snapshot : fallback ?? {};
  return root?.bot && typeof root.bot === "object" ? root.bot : root;
}

function pickStrategyKey(cfg, engineType) {
  const mmUp = String(cfg?.marketMode || cfg?.market || "").toUpperCase();
  const stFut = Boolean(cfg?.supertrendFuturesAuto);
  const stSpot = Boolean(cfg?.supertrendSpotAuto);
  if ((mmUp === "FUTURES" && stFut) || (mmUp === "SPOT" && stSpot)) return "SUPERTREND";
  const stratMode = String(cfg?.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(cfg?.manualStrategy ?? "").toUpperCase();
    if (m && m !== "MANUAL" && m !== "AUTO") return m;
  }
  return String(engineType ?? "SUPERTREND_ELITE").toUpperCase();
}

async function materializeCfg(run) {
  let cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const { normalizeEliteStRunCfg } = await import("../src/strategy/supertrendElite.js");
  const { ensureBacktestMarketMode, applyInstanceOperationalToBot } = await import("../src/lib/strategyInstanceSplit.js");
  if (run.instance_operational_snapshot) applyInstanceOperationalToBot(cfg, run.instance_operational_snapshot);
  cfg = ensureBacktestMarketMode(cfg);
  if (String(cfg.manualStrategy ?? "").toUpperCase() === "SUPERTREND_ELITE") {
    Object.assign(cfg, normalizeEliteStRunCfg(cfg));
  }
  cfg._intradayEngineMaterialized = true;
  return cfg;
}

function auditTradeMath(t, cm) {
  const issues = [];
  const gross = Number(t.gross_pnl);
  const fees = Number(t.fees_usdt);
  const fund = Number(t.funding_paid || 0);
  const net = Number(t.net_pnl);
  if (Math.abs(gross - fees - fund - net) > 0.02) {
    issues.push(`pnl_identity: gross(${gross.toFixed(4)}) - fees(${fees.toFixed(4)}) - fund(${fund.toFixed(4)}) != net(${net.toFixed(4)})`);
  }
  const sc = typeof t.signal_context === "string" ? JSON.parse(t.signal_context) : t.signal_context ?? {};
  const entry = Number(t.entry_price);
  const exit = Number(t.exit_price);
  const qty = Number(t.quantity);
  const side = String(t.direction).toUpperCase();
  if (Number.isFinite(entry) && Number.isFinite(exit) && qty > 0) {
    const isLong = side === "BUY";
    const exitFill = exit;
    const breakdown = tradeBreakdown({
      side,
      entryFill: entry,
      exitFill,
      qty,
      leverage: cm.leverage,
      model: cm,
    });
    const grossDrift = Math.abs(breakdown.gross - gross);
    const feeDrift = Math.abs(breakdown.fees - fees);
    if (grossDrift > 0.05) issues.push(`gross_recalc_drift: ${grossDrift.toFixed(4)} (stored ${gross.toFixed(4)} vs ${breakdown.gross.toFixed(4)})`);
    if (feeDrift > 0.05) issues.push(`fees_recalc_drift: ${feeDrift.toFixed(4)}`);
  }
  const eqEntry = Number(sc.equityAtEntry);
  if (!Number.isFinite(eqEntry)) issues.push("missing_equityAtEntry");
  return { issues, eqEntry, sc };
}

async function replaySingle(run, cfg, symbol) {
  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const tf = String(run.timeframe);
  const cm = resolveCostModel(cfg, run.cost_model ?? {});
  const isFutures = String(cfg.marketMode ?? "").toUpperCase() === "FUTURES";
  const market = isFutures ? "futures" : "spot";
  const strategyKey = pickStrategyKey(cfg, run.engine_type);
  const candles = await readCandles(symbol, tf, fromMs, toMs, { market });
  const fundingRates = isFutures ? await readFundingRates(symbol, fromMs, toMs).catch(() => []) : [];
  const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
  const gateMode = String(run.gate_mode || "off") === "approx" ? "approx" : "off";
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride: run.cost_model ?? {},
    gateMode,
    fundingRates,
    startingUsdt: Number(run.initial_capital),
    timeframe: tf,
    symbol,
    adapters,
  });
  return { sim, cm, strategyKey };
}

async function auditRun(run) {
  const sep = "═".repeat(72);
  console.log(`\n${sep}`);
  console.log(`AUDIT: ${run.id}`);
  console.log(
    `${run.is_portfolio ? "PORTFOLIO " + (run.symbols || []).join(",") : run.symbol} · ${run.timeframe} · ${String(run.start_date).slice(0, 10)} → ${String(run.end_date).slice(0, 10)}`,
  );
  console.log(`Status: ${run.status} · Trades: ${run.total_trades} · $${Number(run.initial_capital)} → $${Number(run.final_capital)}`);
  console.log(sep);

  const cfg = await materializeCfg(run);
  const riskPct = Number(cfg.riskPerTrade ?? 10);
  console.log(`Strategy: ${cfg.manualStrategy} · risk ${riskPct}% · leverage ${cfg.futuresLeverage}`);

  const persisted = (
    await pool.query(
      `SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
      [run.id],
    )
  ).rows;

  let replayTrades = [];
  let replayFinal = 0;
  let cm;

  if (run.is_portfolio) {
    const symbols = (run.symbols || []).map(String);
    const fromMs = new Date(run.start_date).getTime();
    const toMs = new Date(run.end_date).getTime();
    const allEvents = [];
    cm = resolveCostModel(cfg, run.cost_model ?? {});
    for (const sym of symbols) {
      const { sim } = await replaySingle(run, cfg, sym);
      console.log(`  Per-coin sim ${sym}: ${sim.trades.length} trades, final $${sim.finalEquity.toFixed(2)} (isolated)`);
      allEvents.push(...tradesToREvents(sym, sim.trades, riskPct));
    }
    const replay = portfolioReplay({
      events: allEvents,
      startingUsdt: Number(run.initial_capital),
      riskFrac: riskPct / 100,
      startTs: fromMs,
    });
    replayTrades = replay.trades;
    replayFinal = replay.finalEquity;
    console.log(`  Portfolio replay: ${replayTrades.length} trades, final $${replayFinal.toFixed(2)}`);
  } else {
    const { sim, cm: c } = await replaySingle(run, cfg, run.symbol);
    cm = c;
    replayTrades = sim.trades;
    replayFinal = sim.finalEquity;
  }

  const dbFinal = Number(run.final_capital);
  const finalDrift = Math.abs(replayFinal - dbFinal);
  console.log(`\n1. REPLAY FIDELITY`);
  console.log(`   DB final:     $${dbFinal.toFixed(2)}`);
  console.log(`   Replay final: $${replayFinal.toFixed(2)} ${finalDrift < 0.05 ? "✓" : "✗ DRIFT $" + finalDrift.toFixed(2)}`);
  console.log(`   DB trades: ${persisted.length} · Replay: ${replayTrades.length}`);

  let matchCount = 0;
  let pnlDriftSum = 0;
  const n = Math.min(persisted.length, replayTrades.length);
  const tradeMismatches = [];
  for (let i = 0; i < n; i++) {
    const p = persisted[i];
    const s = replayTrades[i];
    const symOk = !run.is_portfolio || p.symbol === s.symbol;
    const dirOk = p.direction === s.direction;
    const reasonOk = p.exit_reason === s.exitReason;
    const entryDrift = Math.abs(Number(p.entry_price) - Number(s.entryPrice));
    const exitDrift = Math.abs(Number(p.exit_price) - Number(s.exitPrice));
    const pnlDrift = Math.abs(Number(p.net_pnl) - Number(s.netPnl));
    pnlDriftSum += pnlDrift;
    if (symOk && dirOk && reasonOk && entryDrift < 0.02 && exitDrift < 0.02 && pnlDrift < 0.05) {
      matchCount++;
    } else {
      tradeMismatches.push({
        n: p.trade_number,
        sym: p.symbol,
        issues: [
          !symOk && `symbol ${p.symbol} vs ${s.symbol}`,
          !dirOk && `dir ${p.direction} vs ${s.direction}`,
          !reasonOk && `reason ${p.exit_reason} vs ${s.exitReason}`,
          entryDrift >= 0.02 && `entry drift ${entryDrift.toFixed(4)}`,
          exitDrift >= 0.02 && `exit drift ${exitDrift.toFixed(4)}`,
          pnlDrift >= 0.05 && `pnl drift ${pnlDrift.toFixed(4)}`,
        ].filter(Boolean),
      });
    }
  }
  if (persisted.length !== replayTrades.length) {
    tradeMismatches.push({ n: "COUNT", issues: [`count ${persisted.length} vs ${replayTrades.length}`] });
  }
  console.log(`   Matched trades: ${matchCount}/${n}`);
  console.log(`   Sum |PnL drift|: $${pnlDriftSum.toFixed(4)}`);
  if (tradeMismatches.length) {
    console.log(`   Mismatches:`);
    for (const m of tradeMismatches.slice(0, 10)) {
      console.log(`     #${m.n}: ${m.issues.join("; ")}`);
    }
  }

  console.log(`\n2. PER-TRADE PnL & COMPOUNDING (${persisted.length} trades)`);
  let eq = Number(run.initial_capital);
  let mathOk = 0;
  let eqOk = 0;
  const tradeIssues = [];
  for (const p of persisted) {
    const { issues, eqEntry } = auditTradeMath(p, cm);
    const eqMatch = Math.abs(eqEntry - eq) < 0.1;
    if (issues.length === 0) mathOk++;
    else tradeIssues.push({ n: p.trade_number, sym: p.symbol, issues });
    if (eqMatch) eqOk++;
    else tradeIssues.push({ n: p.trade_number, sym: p.symbol, issues: [`eq@entry ${eqEntry?.toFixed(2)} expected ${eq.toFixed(2)}`] });
    eq += Number(p.net_pnl);
  }
  const eqFinalDrift = Math.abs(eq - dbFinal);
  console.log(`   PnL identity: ${mathOk}/${persisted.length} ✓`);
  console.log(`   Compounding chain: ${eqOk}/${persisted.length} eq@entry ✓`);
  console.log(`   Chain final: $${eq.toFixed(2)} vs DB $${dbFinal.toFixed(2)} ${eqFinalDrift < 0.05 ? "✓" : "✗"}`);

  console.log(`\n3. TRADE-BY-TRADE`);
  console.log(
    `${"#".padStart(3)} ${"Coin".padEnd(6)} ${"Side".padEnd(5)} ${"Entry".padStart(10)} ${"Exit".padStart(10)} ${"Net".padStart(10)} ${"Eq@E".padStart(10)} ${"Risk$".padStart(8)} Reason`,
  );
  for (const p of persisted) {
    const sc = typeof p.signal_context === "string" ? JSON.parse(p.signal_context) : p.signal_context ?? {};
    const sym = String(p.symbol || run.symbol).replace("USDT", "").padEnd(6);
    const risk = Number(sc.initialRiskUsd ?? 0);
    const net = Number(p.net_pnl);
    const sign = net >= 0 ? "+" : "";
    console.log(
      `${String(p.trade_number).padStart(3)} ${sym} ${String(p.direction).padEnd(5)} ${Number(p.entry_price).toFixed(2).padStart(10)} ${Number(p.exit_price).toFixed(2).padStart(10)} ${(sign + net.toFixed(2)).padStart(10)} ${Number(sc.equityAtEntry ?? 0).toFixed(2).padStart(10)} ${risk.toFixed(1).padStart(8)} ${p.exit_reason}`,
    );
  }

  if (tradeIssues.length) {
    console.log(`\n4. ISSUES (${tradeIssues.length})`);
    for (const ti of tradeIssues.slice(0, 15)) {
      console.log(`   #${ti.n} ${ti.sym ?? ""}: ${ti.issues.join("; ")}`);
    }
  } else {
    console.log(`\n4. ISSUES: none`);
  }

  const metrics = typeof run.metrics === "string" ? JSON.parse(run.metrics) : run.metrics;
  const mReplay = computeAllMetrics({
    trades: replayTrades,
    equityCurve: [],
    tf: run.timeframe,
    startingEquity: Number(run.initial_capital),
  });
  console.log(`\n5. METRICS CHECK`);
  console.log(`   Return DB: ${Number(metrics?.totalReturnPct ?? 0).toFixed(2)}% · Replay: ${Number(mReplay.totalReturnPct ?? 0).toFixed(2)}%`);
  console.log(`   MaxDD DB:  ${Number(metrics?.maxDrawdownPct ?? 0).toFixed(2)}% · Replay: ${Number(mReplay.maxDrawdownPct ?? 0).toFixed(2)}%`);
  console.log(`   PF DB:     ${Number(metrics?.profitFactor ?? 0).toFixed(2)} · Replay: ${Number(mReplay.profitFactor ?? 0).toFixed(2)}`);

  return {
    id: run.id,
    ok: finalDrift < 0.05 && mathOk === persisted.length && eqOk === persisted.length && tradeMismatches.length === 0,
    trades: persisted.length,
    finalDrift,
    mathOk,
    eqOk,
  };
}

const results = [];
for (const run of runs) {
  results.push(await auditRun(run));
}

console.log(`\n${"═".repeat(72)}`);
console.log("SUMMARY");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.id.slice(0, 8)}… ${r.trades} trades · math ${r.mathOk}/${r.trades} · eq ${r.eqOk}/${r.trades} · final drift $${r.finalDrift.toFixed(4)}`);
}

// Cross-run portfolio sanity
const port = runs.find((r) => r.is_portfolio);
const singles = runs.filter((r) => !r.is_portfolio);
if (port && singles.length >= 2) {
  console.log(`\n6. PORTFOLIO vs SINGLE-COIN SANITY`);
  console.log(`   Portfolio: $100 → $${Number(port.final_capital).toFixed(2)} (${port.total_trades} trades)`);
  for (const s of singles) {
    console.log(`   ${s.symbol} alone: $100 → $${Number(s.final_capital).toFixed(2)} (${s.total_trades} trades)`);
  }
  console.log(`   Note: Portfolio shared-account compounding ≠ sum of isolated runs.`);
  console.log(`   Portfolio should have ~${singles.reduce((a, s) => a + Number(s.total_trades), 0)} trades if same window (minus partial overlaps).`);
}

await closePool();
