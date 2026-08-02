export type MicroEventCfgUi = {
  /** Futures direction mode — MICRO_EVENT continuation SELL requires 2-way for shorts. */
  supertrendFuturesTwoWay: boolean;
  microEventDirectionMode: string;
  microEventMinConfluenceScore: number;
  microEventMinConfirmLayers: number;
  microEventLiqWindowSec: number;
  microEventLiqZMin: number;
  microEventLiqMinUsd: number;
  microEventLiqDomRatio: number;
  microEventLiqRequired: boolean;
  microEventOiGateEnabled: boolean;
  microEventOiMinDropPct1m: number;
  microEventOiMinDropPct5m: number;
  microEventBookGateEnabled: boolean;
  microEventMinImbalance: number;
  microEventMaxOppositeWallUsd: number;
  microEventCvdGateEnabled: boolean;
  microEventMinAggressiveUsd: number;
  microEventMinCvdSlope: number;
  microEventFundingGateEnabled: boolean;
  microEventMinFundingZ: number;
  microEventSlBufferPct: number;
  microEventTpRr: number;
  microEventMaxHoldSec: number;
  microEventMaxTradesPerHour: number;
  microEventCooldownSec: number;
  microEventLiveTickEnabled: boolean;
  microEventTradeSides: string;
};

export function microEventCfgFromBot(bot: Record<string, unknown> | null | undefined): MicroEventCfgUi {
  const b = bot ?? {};
  return {
    supertrendFuturesTwoWay: b.supertrendFuturesTwoWay === true,
    microEventDirectionMode: String(b.microEventDirectionMode ?? "continuation"),
    microEventMinConfluenceScore: Number(b.microEventMinConfluenceScore ?? 55),
    microEventMinConfirmLayers: Number(b.microEventMinConfirmLayers ?? 2),
    microEventLiqWindowSec: Number(b.microEventLiqWindowSec ?? 90),
    microEventLiqZMin: Number(b.microEventLiqZMin ?? 1.5),
    microEventLiqMinUsd: Number(b.microEventLiqMinUsd ?? 25_000),
    microEventLiqDomRatio: Number(b.microEventLiqDomRatio ?? 1.2),
    microEventLiqRequired: b.microEventLiqRequired !== false,
    microEventOiGateEnabled: b.microEventOiGateEnabled !== false,
    microEventOiMinDropPct1m: Number(b.microEventOiMinDropPct1m ?? 0.3),
    microEventOiMinDropPct5m: Number(b.microEventOiMinDropPct5m ?? 0.8),
    microEventBookGateEnabled: b.microEventBookGateEnabled !== false,
    microEventMinImbalance: Number(b.microEventMinImbalance ?? 0.62),
    microEventMaxOppositeWallUsd: Number(b.microEventMaxOppositeWallUsd ?? 500_000),
    microEventCvdGateEnabled: b.microEventCvdGateEnabled !== false,
    microEventMinAggressiveUsd: Number(b.microEventMinAggressiveUsd ?? 15_000),
    microEventMinCvdSlope: Number(b.microEventMinCvdSlope ?? 5000),
    microEventFundingGateEnabled: b.microEventFundingGateEnabled !== false,
    microEventMinFundingZ: Number(b.microEventMinFundingZ ?? 1.2),
    microEventSlBufferPct: Number(b.microEventSlBufferPct ?? 0.0015),
    microEventTpRr: Number(b.microEventTpRr ?? 1.2),
    microEventMaxHoldSec: Number(b.microEventMaxHoldSec ?? 180),
    microEventMaxTradesPerHour: Number(b.microEventMaxTradesPerHour ?? 12),
    microEventCooldownSec: Number(b.microEventCooldownSec ?? 45),
    microEventLiveTickEnabled: b.microEventLiveTickEnabled !== false,
    microEventTradeSides: String(b.microEventTradeSides ?? "BOTH"),
  };
}
