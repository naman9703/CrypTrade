/**
 * Rebuild a `createBacktestRun` body from a prior run so the same panel settings
 * (window, sizing, costs, …) can be re-queued after strategy/instance edits.
 */
import { api } from "../../api/client";
import { pickBotFromConfigSnapshot } from "../../lib/backtestEffectiveCfg";
import type { BacktestRunSummary } from "../../types/backtest";
import { useAppStore } from "../../ws/store";

const POSITION_SIZING = new Set(["RISK_AT_SL", "RISK_AT_SL_FULL_MARGIN", "FULL_EQUITY_MARGIN"]);
const PORTFOLIO_SIZING = new Set([
  "EQUAL_SLICE_FULL_MARGIN",
  "EQUAL_SLICE_RISK_AT_SL",
  "TOTAL_CAPITAL_RISK_AT_SL",
]);
const TRAIL_MICRO = new Set(["off", "1m", "3m", "5m", "15m", "30m"]);

function asPositionSizing(raw: unknown): "RISK_AT_SL" | "RISK_AT_SL_FULL_MARGIN" | "FULL_EQUITY_MARGIN" | undefined {
  const s = String(raw ?? "").toUpperCase();
  return POSITION_SIZING.has(s) ? (s as "RISK_AT_SL" | "RISK_AT_SL_FULL_MARGIN" | "FULL_EQUITY_MARGIN") : undefined;
}

function asPortfolioSizing(
  raw: unknown,
): "EQUAL_SLICE_FULL_MARGIN" | "EQUAL_SLICE_RISK_AT_SL" | "TOTAL_CAPITAL_RISK_AT_SL" | undefined {
  const s = String(raw ?? "").toUpperCase();
  return PORTFOLIO_SIZING.has(s)
    ? (s as "EQUAL_SLICE_FULL_MARGIN" | "EQUAL_SLICE_RISK_AT_SL" | "TOTAL_CAPITAL_RISK_AT_SL")
    : undefined;
}

function asTrailMicro(raw: unknown): "off" | "1m" | "3m" | "5m" | "15m" | "30m" | undefined {
  const s = String(raw ?? "").toLowerCase();
  return TRAIL_MICRO.has(s) ? (s as "off" | "1m" | "3m" | "5m" | "15m" | "30m") : undefined;
}

async function loadRunDetail(run: BacktestRunSummary): Promise<BacktestRunSummary> {
  // List rows omit costModel / configSnapshot — always hydrate for faithful panel replay.
  if (run.configSnapshot && run.costModel) return run;
  const r = await api.getBacktestRun(run.id);
  const detail = (r?.run ?? null) as BacktestRunSummary | null;
  if (!detail?.id) throw new Error("run_not_found");
  return detail;
}

/**
 * Queue a new backtest with the same panel knobs as `run`.
 * Strategy/instance cfg is rebuilt live (so instance panel edits are picked up).
 */
export async function rerunBacktestWithSamePanelConfig(run: BacktestRunSummary): Promise<string> {
  const detail = await loadRunDetail(run);
  const bot = pickBotFromConfigSnapshot(detail.configSnapshot);
  const isPortfolio =
    detail.isPortfolio === true ||
    String(detail.symbol || "").toUpperCase() === "PORTFOLIO" ||
    (Array.isArray(detail.symbols) && detail.symbols.length >= 2);

  const symbols = isPortfolio
    ? (detail.symbols ?? [])
        .map((s) => String(s).toUpperCase())
        .filter((s) => /^[A-Z0-9]{5,20}$/.test(s))
    : [];

  if (isPortfolio && symbols.length < 2) {
    throw new Error("portfolio_symbols_missing");
  }

  const strategyVersionId = detail.strategyVersionId ? String(detail.strategyVersionId) : "";
  if (!strategyVersionId) throw new Error("missing_strategy_version");

  const walk =
    detail.walkForwardSplit && typeof detail.walkForwardSplit === "object"
      ? detail.walkForwardSplit
      : null;
  const trainPct = walk?.trainPct != null && Number.isFinite(Number(walk.trainPct)) ? Number(walk.trainPct) : null;

  const useLivePanelOverrides = String(detail.configSource || "").includes("live_panel");
  const positionSizing = asPositionSizing(bot.backtestPositionSizing);
  const portfolioPositionSizing = asPortfolioSizing(bot.portfolioPositionSizing);
  const trailMicroTf = asTrailMicro(bot.backtestTrailMicroTf) ?? "1m";

  const costModel =
    detail.costModel && typeof detail.costModel === "object"
      ? (detail.costModel as Record<string, unknown>)
      : { slippagePct: 0.0005 };

  const res = await api.createBacktestRun({
    strategyVersionId,
    botInstanceId: detail.botInstanceId ?? undefined,
    ...(isPortfolio ? { symbols } : { symbol: String(detail.symbol || "").toUpperCase() }),
    timeframe: detail.timeframe,
    from: detail.startDate,
    to: detail.endDate,
    startingUsdt: detail.initialCapital,
    gateMode: detail.gateMode === "approx" ? "approx" : "off",
    costModel,
    walkForward: trainPct != null ? { trainPct } : undefined,
    positionSizing: isPortfolio ? undefined : positionSizing,
    portfolioPositionSizing: isPortfolio ? portfolioPositionSizing ?? "EQUAL_SLICE_FULL_MARGIN" : undefined,
    trailMicroTf,
    useLivePanelOverrides,
    label: detail.label ? `Re-run · ${detail.label}` : `Re-run · ${detail.symbol} ${detail.timeframe}`,
  });

  if (!res?.ok || !res.runId) throw new Error(res?.error || "create_failed");
  useAppStore.getState().setBacktestProgress(String(res.runId), { status: "queued", progressPct: 0 });
  return String(res.runId);
}
