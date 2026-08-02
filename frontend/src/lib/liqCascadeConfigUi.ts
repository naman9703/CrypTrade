/** UI snapshot of LIQ_CASCADE bot keys (TradingPanel + config panel). */
import { LIQ_CASCADE_1M_BASE } from "./liqCascadePresets";

export type LiqCascadeCfgUi = {
  liqCascadeInterval: string;
  liqCascadeZScoreMin: number;
  liqCascadeLookbackBars: number;
  liqCascadeWindowBars: number;
  liqCascadeMinDispAtr: number;
  liqCascadeStrongDispAtr: number;
  liqCascadeMinOiDropPct: number;
  liqCascadeOiGateMode: string;
  liqCascadeOiWindowBars: number;
  liqCascadeOiSource: string;
  liqCascadeConfirmMode: string;
  liqCascadeConfirmLiqBars: number;
  liqCascadeExhaustionDecay: number;
  liqCascadeDirectionMode: string;
  liqCascadeMinAtrPct: number;
  liqCascadeSlBufferPct: number;
  liqCascadeTpAtrMult: number;
  liqCascadeTpRr: number;
  liqCascadeMinRr: number;
  liqCascadeMaxHoldBars: number;
  liqCascadeMaxTradesPerDay: number;
  liqCascadeMinBarGap: number;
  liqCascadeEventCooldownLiqBars: number;
  liqCascadeMinLiqUsdBar: number;
  liqCascadeLiqSource: string;
  liqCascadeLiveTickEnabled: boolean;
  liqCascadeTradeSides: string;
};

const D = LIQ_CASCADE_1M_BASE;

function num(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string) {
  const s = String(v ?? "").trim();
  return s || fallback;
}

export function liqCascadeCfgFromBot(bot: Record<string, unknown> | null | undefined): LiqCascadeCfgUi {
  return {
    liqCascadeInterval: str(bot?.liqCascadeInterval, String(D.liqCascadeInterval)),
    liqCascadeZScoreMin: num(bot?.liqCascadeZScoreMin, Number(D.liqCascadeZScoreMin)),
    liqCascadeLookbackBars: Math.max(8, Math.min(240, Math.round(num(bot?.liqCascadeLookbackBars, Number(D.liqCascadeLookbackBars))))),
    liqCascadeWindowBars: Math.max(1, Math.min(48, Math.round(num(bot?.liqCascadeWindowBars, Number(D.liqCascadeWindowBars))))),
    liqCascadeMinDispAtr: num(bot?.liqCascadeMinDispAtr, Number(D.liqCascadeMinDispAtr)),
    liqCascadeStrongDispAtr: num(bot?.liqCascadeStrongDispAtr, Number(D.liqCascadeStrongDispAtr)),
    liqCascadeMinOiDropPct: num(bot?.liqCascadeMinOiDropPct, Number(D.liqCascadeMinOiDropPct)),
    liqCascadeOiGateMode: str(bot?.liqCascadeOiGateMode, String(D.liqCascadeOiGateMode)).toLowerCase(),
    liqCascadeOiWindowBars: Math.max(1, Math.min(24, Math.round(num(bot?.liqCascadeOiWindowBars, Number(D.liqCascadeOiWindowBars))))),
    liqCascadeOiSource: str(bot?.liqCascadeOiSource, String(D.liqCascadeOiSource ?? "binance")).toLowerCase(),
    liqCascadeConfirmMode: str(bot?.liqCascadeConfirmMode, String(D.liqCascadeConfirmMode)),
    liqCascadeConfirmLiqBars: Math.max(1, Math.min(12, Math.round(num(bot?.liqCascadeConfirmLiqBars, Number(D.liqCascadeConfirmLiqBars))))),
    liqCascadeExhaustionDecay: Math.max(0, Math.min(1, num(bot?.liqCascadeExhaustionDecay, Number(D.liqCascadeExhaustionDecay)))),
    liqCascadeDirectionMode: str(bot?.liqCascadeDirectionMode, String(D.liqCascadeDirectionMode)),
    liqCascadeMinAtrPct: num(bot?.liqCascadeMinAtrPct, 0.035),
    liqCascadeSlBufferPct: num(bot?.liqCascadeSlBufferPct, 0.0015),
    liqCascadeTpAtrMult: num(bot?.liqCascadeTpAtrMult, Number(D.liqCascadeTpAtrMult)),
    liqCascadeTpRr: num(bot?.liqCascadeTpRr, Number(D.liqCascadeTpRr ?? 0)),
    liqCascadeMinRr: num(bot?.liqCascadeMinRr, Number(D.liqCascadeMinRr)),
    liqCascadeMaxHoldBars: Math.max(0, Math.min(500, Math.round(num(bot?.liqCascadeMaxHoldBars, Number(D.liqCascadeMaxHoldBars))))),
    liqCascadeMaxTradesPerDay: Math.max(1, Math.min(50, Math.round(num(bot?.liqCascadeMaxTradesPerDay, Number(D.liqCascadeMaxTradesPerDay))))),
    liqCascadeMinBarGap: Math.max(0, Math.min(100, Math.round(num(bot?.liqCascadeMinBarGap, Number(D.liqCascadeMinBarGap))))),
    liqCascadeEventCooldownLiqBars: Math.max(0, Math.min(48, Math.round(num(bot?.liqCascadeEventCooldownLiqBars, Number(D.liqCascadeEventCooldownLiqBars))))),
    liqCascadeMinLiqUsdBar: Math.max(0, Math.round(num(bot?.liqCascadeMinLiqUsdBar, 50_000))),
    liqCascadeLiqSource: str(bot?.liqCascadeLiqSource, String(D.liqCascadeLiqSource)),
    liqCascadeLiveTickEnabled: bot?.liqCascadeLiveTickEnabled === true,
    liqCascadeTradeSides: str(bot?.liqCascadeTradeSides, "BOTH").toUpperCase(),
  };
}

export function liqCascadeOiGateEnabled(cfg: LiqCascadeCfgUi) {
  return cfg.liqCascadeOiGateMode !== "off" && cfg.liqCascadeMinOiDropPct > 0;
}
