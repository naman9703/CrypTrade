/**
 * Per-layer toggles for backtest trade chart overlays — legend chips click to show/hide.
 */
import type { SeriesMarker, UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../types/backtest";
import type { StrategyTaOverlay } from "./backtestChartOverlays";
import type { SmcChartMarkup } from "./smcChartMarkup";

export type ChartOverlayLayerId =
  | "session_pdh"
  | "session_pdl"
  | "session_pwh"
  | "session_pwl"
  | "bracket_entry"
  | "bracket_sl"
  | "bracket_tp"
  | "bracket_exit"
  | "trade_link"
  | "liq_sr_zone"
  | "liq_sweep_wick"
  | "liq_opposing"
  | "sweep_level"
  | "strategy_entry"
  | "strategy_sl"
  | "strategy_tp"
  | "strategy_tp1"
  | "smc_choch"
  | "smc_bos"
  | "smc_fvg"
  | "smc_ob"
  | "swings"
  | "sweep_events"
  | "risk_band"
  | "reward_band"
  | "partial_tp"
  | "mae_mfe"
  | "tokyo_session_box";

export type OverlayToggleItem = {
  id: ChartOverlayLayerId;
  label: string;
  /** Short line-style hint shown before the label */
  prefix: string;
  prefixClass: string;
};

export const OVERLAY_TOGGLE_META: Record<ChartOverlayLayerId, Omit<OverlayToggleItem, "id">> = {
  session_pdh: { label: "Prev day high", prefix: "━━", prefixClass: "text-sky-400" },
  session_pdl: { label: "Prev day low", prefix: "━━", prefixClass: "text-emerald-400" },
  session_pwh: { label: "Prev week high", prefix: "╌╌", prefixClass: "text-indigo-400" },
  session_pwl: { label: "Prev week low", prefix: "╌╌", prefixClass: "text-amber-400" },
  bracket_entry: { label: "Entry", prefix: "╌╌", prefixClass: "text-sky-300" },
  bracket_sl: { label: "Stop", prefix: "╌╌", prefixClass: "text-red-400" },
  bracket_tp: { label: "Target", prefix: "╌╌", prefixClass: "text-violet-400" },
  bracket_exit: { label: "Exit fill", prefix: "━━", prefixClass: "text-green-400" },
  trade_link: { label: "Entry→exit link", prefix: "╌╌", prefixClass: "text-amber-500" },
  liq_sr_zone: { label: "Support / resistance zone (swept)", prefix: "━━", prefixClass: "text-teal-400" },
  liq_sweep_wick: { label: "Sweep wick (SL ref)", prefix: "╌╌", prefixClass: "text-rose-400" },
  liq_opposing: { label: "Opposing liquidity (TP pool)", prefix: "╌╌", prefixClass: "text-purple-400" },
  sweep_level: { label: "Liquidity sweep level", prefix: "╌╌", prefixClass: "text-pink-400" },
  strategy_entry: { label: "Strategy entry", prefix: "╌╌", prefixClass: "text-cyan-400" },
  strategy_sl: { label: "Strategy stop", prefix: "╌╌", prefixClass: "text-red-400" },
  strategy_tp: { label: "Strategy target", prefix: "╌╌", prefixClass: "text-violet-400" },
  strategy_tp1: { label: "TP1 (1R partial)", prefix: "╌╌", prefixClass: "text-lime-400" },
  smc_choch: { label: "CHoCH", prefix: "╌╌", prefixClass: "text-fuchsia-400" },
  smc_bos: { label: "BOS / MSS", prefix: "━━", prefixClass: "text-sky-400" },
  smc_fvg: { label: "Fair value gap", prefix: "╌╌", prefixClass: "text-violet-400" },
  smc_ob: { label: "Order block", prefix: "╌╌", prefixClass: "text-amber-400" },
  swings: { label: "Swing high / low (SH/SL)", prefix: "▲▼", prefixClass: "text-slate-400" },
  sweep_events: { label: "Sweep & reclaim markers", prefix: "○", prefixClass: "text-pink-400" },
  risk_band: { label: "Risk band (entry → stop)", prefix: "▬", prefixClass: "text-red-300" },
  reward_band: { label: "Reward band (entry → target)", prefix: "▬", prefixClass: "text-green-300" },
  partial_tp: { label: "Partial take-profit @ 1R", prefix: "╌╌", prefixClass: "text-yellow-400" },
  mae_mfe: { label: "MAE / MFE", prefix: "·", prefixClass: "text-slate-500" },
  tokyo_session_box: { label: "Tokyo session range", prefix: "▬", prefixClass: "text-orange-400" },
};

const ALL_LAYER_IDS = Object.keys(OVERLAY_TOGGLE_META) as ChartOverlayLayerId[];

export function defaultOverlayLayerState(): Record<ChartOverlayLayerId, boolean> {
  return Object.fromEntries(ALL_LAYER_IDS.map((id) => [id, true])) as Record<ChartOverlayLayerId, boolean>;
}

export function isOverlayLayerOn(
  layers: Record<ChartOverlayLayerId, boolean>,
  id: ChartOverlayLayerId,
): boolean {
  return layers[id] !== false;
}

/** Legend lines from strategy markup → toggle ids (deduped). */
function layersFromMarkupLegend(legend: string[] | undefined): ChartOverlayLayerId[] {
  if (!legend?.length) return [];
  const out: ChartOverlayLayerId[] = [];
  for (const line of legend) {
    const l = line.toLowerCase();
    if (l.includes("support") || l.includes("resistance zone")) out.push("liq_sr_zone");
    else if (l.includes("sweep wick")) out.push("liq_sweep_wick");
    else if (l.includes("opposing liquidity")) out.push("liq_opposing");
    else if (l.includes("liquidity sweep") || l.includes("pink")) out.push("sweep_level");
    else if (l.includes("sh/sl") || l.includes("swing")) out.push("swings");
    else if (l.includes("choch") || l.includes("fuchsia")) out.push("smc_choch");
    else if (l.includes("bos") || l.includes("mss")) out.push("smc_bos");
    else if (l.includes("fvg")) out.push("smc_fvg");
    else if (l.includes("order block") || l.includes("amber")) out.push("smc_ob");
    else if (l.includes("cyan") && l.includes("entry")) {
      out.push("strategy_entry", "strategy_sl", "strategy_tp", "strategy_tp1");
    }
  }
  return out;
}

function layersFromTaOverlay(ta: StrategyTaOverlay | null): ChartOverlayLayerId[] {
  if (!ta?.legend.length) return [];
  const out: ChartOverlayLayerId[] = [];
  for (const line of ta.legend) {
    const l = line.toLowerCase();
    if (l.includes("swept liquidity") || l.includes("pink")) out.push("sweep_level");
    else if (l.includes("sweep wick")) out.push("liq_sweep_wick");
    else if (l.includes("draw on liquidity") || l.includes("opposing")) out.push("liq_opposing");
    else if (l.includes("mss") || l.includes("bos")) out.push("smc_bos");
    else if (l.includes("fvg")) out.push("smc_fvg");
    else if (l.includes("order block")) out.push("smc_ob");
    else if (l.includes("tokyo session")) out.push("tokyo_session_box");
  }
  return out;
}

function layersFromPatternLegend(legend: string[] | undefined): ChartOverlayLayerId[] {
  if (!legend?.length) return [];
  const out: ChartOverlayLayerId[] = [];
  for (const line of legend) {
    const l = line.toLowerCase();
    if (l.includes("risk")) out.push("risk_band");
    else if (l.includes("reward")) out.push("reward_band");
    else if (l.includes("partial") || l.includes("1r")) out.push("partial_tp");
    else if (l.includes("mae") || l.includes("mfe")) out.push("mae_mfe");
    else if (l.includes("tokyo session")) out.push("tokyo_session_box");
  }
  return out;
}

function dedupe(ids: ChartOverlayLayerId[]): ChartOverlayLayerId[] {
  return [...new Set(ids)];
}

export function buildDetailOverlayToggleList(opts: {
  showSessionSr: boolean;
  hasTrade: boolean;
  trade: BacktestTrade | null;
  markup: SmcChartMarkup | null;
  taOverlay: StrategyTaOverlay | null;
  patternLegend: string[] | undefined;
  strategyKind: string;
}): OverlayToggleItem[] {
  const ids: ChartOverlayLayerId[] = [];

  if (opts.showSessionSr) {
    ids.push("session_pdh", "session_pdl", "session_pwh", "session_pwl");
  }
  if (opts.hasTrade) {
    ids.push("bracket_entry", "bracket_sl", "bracket_tp", "bracket_exit", "trade_link");
  }
  if (opts.strategyKind === "liquidity") {
    ids.push("liq_sr_zone", "liq_sweep_wick", "liq_opposing", "swings", "sweep_events");
    ids.push("strategy_entry", "strategy_sl", "strategy_tp", "strategy_tp1");
  } else if (opts.strategyKind === "smc_ict" && opts.markup) {
    ids.push(...layersFromMarkupLegend(opts.markup.legend));
    if (opts.markup.swings.length) ids.push("swings");
    if (opts.markup.events.some((e) => e.kind === "sweep" || e.kind === "reclaim")) ids.push("sweep_events");
    if (opts.markup.bos) ids.push("smc_bos");
    if (opts.markup.events.some((e) => e.kind === "choch")) ids.push("smc_choch");
  } else {
    ids.push(...layersFromMarkupLegend(opts.markup?.legend));
    ids.push(...layersFromTaOverlay(opts.taOverlay));
  }

  ids.push(...layersFromPatternLegend(opts.patternLegend));
  if (opts.trade && (opts.trade.maePct != null || opts.trade.mfePct != null)) {
    ids.push("mae_mfe");
  }

  return dedupe(ids).map((id) => ({
    id,
    ...OVERLAY_TOGGLE_META[id],
  }));
}

/** Infer layer from a strategy TA line when `layer` was not persisted. */
export function inferTaLineLayer(color: string, lineWidth?: number): ChartOverlayLayerId | null {
  const c = color.toLowerCase();
  if (c.includes("2dd4bf") || c.includes("fb923c")) return "liq_sr_zone";
  if (c.includes("fb7185") || c.includes("f472b6")) return "liq_sweep_wick";
  if (c.includes("c084fc") || c.includes("a855f7")) return "liq_opposing";
  if (c.includes("0ea5e9") || c.includes("38bdf8")) return lineWidth === 2 ? "smc_bos" : "strategy_entry";
  if (c.includes("f87171") || c.includes("ef4444")) return "strategy_sl";
  if (c.includes("fde047")) return "partial_tp";
  if (c.includes("a3e635")) return "strategy_tp1";
  if (c.includes("a78bfa")) return "smc_fvg";
  if (c.includes("fbbf24")) return "smc_ob";
  if (c.includes("e879f9")) return "smc_choch";
  return null;
}

export function formatMaeMfeLine(trade: BacktestTrade): string | null {
  if (trade.maePct == null && trade.mfePct == null) return null;
  return `MAE ${trade.maePct != null ? `${trade.maePct.toFixed(2)}%` : "—"} · MFE ${trade.mfePct != null ? `${trade.mfePct.toFixed(2)}%` : "—"}`;
}

/** Filter candlestick markers by overlay layer toggles. */
export function filterTradeMarkers(
  markers: SeriesMarker<UTCTimestamp>[],
  layers: Record<ChartOverlayLayerId, boolean>,
): SeriesMarker<UTCTimestamp>[] {
  return markers.filter((m) => {
    const text = String(m.text ?? "");
    if (text === "SH" || text === "SL") return isOverlayLayerOn(layers, "swings");
    if (text === "Sweep" || text === "Reclaim") return isOverlayLayerOn(layers, "sweep_events");
    if (text === "CHoCH") return isOverlayLayerOn(layers, "smc_choch");
    if (text === "MSS/BOS" || text === "BOS") return isOverlayLayerOn(layers, "smc_bos");
    if (text === "Entry") return isOverlayLayerOn(layers, "strategy_entry");
    if (m.shape === "arrowUp" || m.shape === "arrowDown") return isOverlayLayerOn(layers, "bracket_entry");
    if (m.shape === "circle") return isOverlayLayerOn(layers, "bracket_exit");
    return true;
  });
}
