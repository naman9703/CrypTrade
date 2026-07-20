/**
 * LTF mark-price replay for trailing while a position is open.
 *
 * Live bot evaluates trailing on ~1s mark ticks; this module steps through LTF
 * mark (or trade fallback) bars inside each parent strategy bar so tier
 * activation and stop breaches align much closer with production.
 *
 * - `1m`: wick-based activation (live tick parity)
 * - `5m`/`15m`/…: candle **close** activation via Binance mark klines
 *
 * Intra-bar order (live-aligned):
 *   1. Adverse extreme vs current SL (stop before new trail on same bar)
 *   2. Advance trail from favorable extreme / HWM
 *   3. Re-check adverse vs tightened SL
 */

import {
  adverseExtreme,
  advanceTrailForBar,
  classifyStopExitReason,
  resolveTrailActivationOn,
} from "./trailingSim.js";
import { recordTrailAdvance } from "./trailEventLog.js";
import { tfToMs } from "../data/timeframe.js";

/** Supported trailing micro timeframes (must be strictly below strategy TF). */
export const TRAIL_MICRO_TIMEFRAMES = Object.freeze(["1m", "3m", "5m", "15m", "30m"]);

/** Default on for futures trailing; set `backtestTrailMicroTf: "off"` to disable. */
export function isTrailMicroEnabled(cfg, { trailEnabled } = {}) {
  if (!trailEnabled) return false;
  return resolveTrailMicroTf(cfg) !== "off";
}

export function resolveTrailMicroTf(cfg) {
  const raw = cfg?.backtestTrailMicroTf;
  if (raw === false || raw === 0) return "off";
  const mode = String(raw ?? "1m").trim().toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") return "off";
  return TRAIL_MICRO_TIMEFRAMES.includes(mode) ? mode : "1m";
}

export function resolveTrailPriceSource(cfg) {
  const src = String(cfg?.backtestTrailPriceSource ?? "mark").trim().toLowerCase();
  return src === "trade" ? "trade" : "mark";
}

function alignDown(ts, tfMs) {
  const n = Number(ts);
  const step = Number(tfMs);
  if (!Number.isFinite(n) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(n / step) * step;
}

function toTrailBar(microBar) {
  const close = Number(microBar.close);
  return {
    open: Number(microBar.open),
    high: Number(microBar.high),
    low: Number(microBar.low),
    close,
    mark: close,
  };
}

function slBreached(isLong, sl, adversePx) {
  const stop = Number(sl);
  const adv = Number(adversePx);
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(adv)) return false;
  return isLong ? adv <= stop : adv >= stop;
}

function microBarExitTs(microTs, microTfMs) {
  const ts = Number(microTs);
  const step = Number(microTfMs);
  if (!Number.isFinite(ts) || !Number.isFinite(step) || step <= 0) return null;
  return ts + step - 1;
}

/**
 * Lazy loader for LTF mark/trade bars over the backtest window.
 */
export class TrailMicroBarLoader {
  /**
   * @param {object} opts
   * @param {string} opts.symbol
   * @param {number} opts.fromMs
   * @param {number} opts.toMs
   * @param {"mark"|"trade"} [opts.priceSource]
   * @param {string} [opts.microTf] — `1m`, `5m`, `15m`, …
   */
  constructor({ symbol, fromMs, toMs, priceSource = "mark", microTf = "1m" }) {
    this.symbol = String(symbol || "").toUpperCase();
    this.fromMs = Number(fromMs);
    this.toMs = Number(toMs);
    this.priceSource = priceSource === "trade" ? "trade" : "mark";
    this.microTf = String(microTf || "1m").trim().toLowerCase();
    this.microTfMs = tfToMs(this.microTf);
    /** @type {Array<{ts:number,open:number,high:number,low:number,close:number,volume?:number,kind?:string}>|null} */
    this._bars = null;
    /** @type {Promise<void>|null} */
    this._loadPromise = null;
  }

  async ensureLoaded() {
    if (this._bars) return;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        if (this.microTf === "1m") {
          const { readMicroTrailBars } = await import("../data/markPriceIngest.js");
          this._bars = await readMicroTrailBars(this.symbol, this.fromMs, this.toMs, {
            priceSource: this.priceSource,
          });
          return;
        }
        if (this.priceSource === "trade") {
          const { readCandles } = await import("../data/klineIngest.js");
          this._bars = [];
          const { READ_CANDLES_SLICE_MS } = await import("../data/klineIngest.js");
          for (let cursor = this.fromMs; cursor < this.toMs; cursor += READ_CANDLES_SLICE_MS) {
            const sliceTo = Math.min(this.toMs, cursor + READ_CANDLES_SLICE_MS);
            const part = await readCandles(this.symbol, this.microTf, cursor, sliceTo, {
              market: "futures",
            }).catch(() => []);
            for (const b of part) this._bars.push({ ...b, kind: "trade" });
          }
          return;
        }
        const { readMarkTrailBars } = await import("../data/markPriceIngest.js");
        this._bars = await readMarkTrailBars(this.symbol, this.microTf, this.fromMs, this.toMs);
      })();
    }
    await this._loadPromise;
  }

  /**
   * LTF bars whose open time falls in [parentTs, parentTs + parentTfMs).
   * Clamped to position entry so we do not trail before fill.
   */
  async barsForParentBar(parentTs, parentTfMs, entryFillTs) {
    await this.ensureLoaded();
    const bars = this._bars ?? [];
    const entryMs = Number(entryFillTs);
    const from = Math.max(
      Number(parentTs),
      Number.isFinite(entryMs) ? alignDown(entryMs, this.microTfMs) : 0,
    );
    const to = Number(parentTs) + Number(parentTfMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    return bars.filter((b) => b.ts >= from && b.ts < to);
  }
}

/**
 * Step trailing across micro bars inside one parent strategy bar.
 *
 * @returns {{ exit: { reason: string, price: number, ts?: number } | null, pos: object }}
 */
export function simulateTrailingForParentBar({
  pos,
  parentBar,
  microBars,
  stBar,
  opts,
  mode,
  leverage,
  tickSize = null,
  microTfMs = 60_000,
}) {
  if (!microBars?.length) {
    return simulateTrailingSingleBar({ pos, bar: parentBar, stBar, opts, mode, leverage, tickSize });
  }

  const isLong = pos.side === "BUY";
  let exit = null;
  const stepMs = Number(microTfMs) > 0 ? Number(microTfMs) : 60_000;

  for (const micro of microBars) {
    const bar = toTrailBar(micro);
    const adv = adverseExtreme(bar, isLong);

    if (slBreached(isLong, pos.sl, adv)) {
      exit = {
        reason: classifyStopExitReason(pos),
        price: Number(pos.sl),
        ts: microBarExitTs(micro.ts, stepMs),
      };
      break;
    }

    const advRes = advanceTrailForBar({
      pos,
      bar,
      stBar,
      opts,
      mode,
      leverage,
      tickSize,
    });

    if (advRes.advanced && advRes.proposedSl != null) {
      pos.sl = advRes.proposedSl;
      pos.trailStep = advRes.trailStep;
      pos.trailTierLabel = advRes.tierLabel;
      recordTrailAdvance(pos, {
        ts: microBarExitTs(micro.ts, stepMs) ?? micro.ts,
        advRes,
        opts,
      });
      if (slBreached(isLong, pos.sl, adv)) {
        exit = { reason: "trail", price: Number(pos.sl), ts: microBarExitTs(micro.ts, stepMs) };
        break;
      }
    } else if (advRes.trailStep != null) {
      pos.trailStep = advRes.trailStep;
    }
  }

  return { exit, pos };
}

/** Legacy single-bar path (parent OHLC) when micro data is unavailable. */
export function simulateTrailingSingleBar({ pos, bar, stBar, opts, mode, leverage, tickSize = null }) {
  const isLong = pos.side === "BUY";
  const adv = adverseExtreme(bar, isLong);

  const advRes = advanceTrailForBar({
    pos,
    bar,
    stBar,
    opts,
    mode,
    leverage,
    tickSize,
  });

  let exit = null;
  if (advRes.advanced && advRes.proposedSl != null) {
    pos.sl = advRes.proposedSl;
    pos.trailStep = advRes.trailStep;
    pos.trailTierLabel = advRes.tierLabel;
    recordTrailAdvance(pos, {
      ts: Number(bar.ts),
      advRes,
      opts,
    });
    if (slBreached(isLong, pos.sl, adv)) {
      exit = { reason: "trail", price: Number(pos.sl) };
    }
  } else if (advRes.trailStep != null) {
    pos.trailStep = advRes.trailStep;
  }

  return { exit, pos };
}

/**
 * Build loader + tick size for worker → runner handoff.
 */
export async function buildTrailMicroContext({
  symbol,
  fromMs,
  toMs,
  cfg,
  trailEnabled,
}) {
  if (!isTrailMicroEnabled(cfg, { trailEnabled })) return null;

  const microTf = resolveTrailMicroTf(cfg);
  const priceSource = resolveTrailPriceSource(cfg);

  if (priceSource === "mark") {
    const { ensureMarkKlines } = await import("../data/markPriceIngest.js");
    const result = await ensureMarkKlines(symbol, { from: fromMs, to: toMs, interval: microTf }).catch((err) => {
      console.warn("[backtest] ensureMarkKlines failed:", err?.message || err);
      return null;
    });
    if (result && microTf !== "1m" && result.gaps > 0) {
      console.warn(
        `[backtest] mark ${microTf} klines: ${result.gaps} gaps in window (${symbol})`,
      );
    }
  }

  if (microTf === "1m") {
    const { ensureKlines } = await import("../data/klineIngest.js");
    await ensureKlines(symbol, "1m", { from: fromMs, to: toMs, market: "futures" }).catch(() => {});
  } else if (priceSource === "trade") {
    const { ensureKlines } = await import("../data/klineIngest.js");
    await ensureKlines(symbol, microTf, { from: fromMs, to: toMs, market: "futures" }).catch(() => {});
  }

  const { resolveBacktestTickSize } = await import("./backtestSymbolMeta.js");
  const tickSize = await resolveBacktestTickSize(symbol, cfg?.backtestTickSize);

  const loader = new TrailMicroBarLoader({ symbol, fromMs, toMs, priceSource, microTf });
  await loader.ensureLoaded().catch(() => {});
  const barCount = loader._bars?.length ?? 0;
  if (barCount === 0) {
    console.warn(
      `[backtest] trail micro ${microTf} (${priceSource}): no bars loaded for ${symbol} — trailing falls back to parent bar`,
    );
  }

  return {
    loader,
    tickSize,
    microTf,
    activationOn: cfg?.backtestTrailActivationOn ?? resolveTrailActivationOn(microTf),
  };
}
