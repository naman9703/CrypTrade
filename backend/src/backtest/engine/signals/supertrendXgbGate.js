/**
 * Supertrend XGBoost gate for backtests — filters ST flips by P(win) from
 * /predict/supertrend using entry-bar features (same contract as train).
 *
 * AI base URL: AI_SERVICE_URL || AI_BASE_URL || cfg.aiBaseUrl || localhost:8001
 * (Docker Compose sets AI_BASE_URL=http://ai:8001 — must not fall back to localhost.)
 *
 * Fail-open by default if AI is down (research safety). Apply-re-sim sets
 * supertrendXgbFailClosed so a dead AI cannot silently match the ungated baseline.
 *
 * Training-cutoff: when ignoreTrainingCutoff is false, bars with ts <= train_end
 * pass ungated (honest OOS-only scoring). Apply sets ignore so the full window
 * is scored for A/B vs baseline.
 */
import axios from "axios";
import {
  encodeSupertrendXgbFeatures,
  isSupertrendXgbStrategy,
  SUPERTREND_XGB_FEATURE_KEYS,
} from "../../../strategy/supertrendXgbFeatures.js";
import {
  buildIndicatorSeries,
  featuresAtBar,
  sessionFromUtcHour,
} from "../../reporting/tradeCsvFeatures.js";
import { signalFromSupertrendBar } from "./supertrend.js";

const DEFAULT_THRESHOLD = 0.55;

function resolveAiBaseUrl(cfg) {
  return String(
    process.env.AI_SERVICE_URL ||
      process.env.AI_BASE_URL ||
      cfg?.aiBaseUrl ||
      "http://localhost:8001",
  ).replace(/\/$/, "");
}

function weekdayLabel(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function ignoreTrainingCutoff(cfg) {
  return (
    cfg?.supertrendXgbIgnoreTrainingCutoff === true ||
    ["1", "true", "yes"].includes(
      String(process.env.BACKTEST_ST_XGB_IGNORE_TRAINING_CUTOFF || "").toLowerCase(),
    )
  );
}

/**
 * @param {{
 *   candles: any[],
 *   cfg: Record<string, unknown>,
 *   fromMs?: number,
 *   stSeries?: any[],
 * }} args
 */
export async function prepareSupertrendXgbGate({ candles, cfg, fromMs, stSeries }) {
  if (cfg?.supertrendXgbGateEnabled !== true) return null;
  if (!candles?.length) return null;

  const baseUrl = resolveAiBaseUrl(cfg);
  const threshold = Number(cfg?.supertrendXgbThreshold ?? DEFAULT_THRESHOLD);
  const failClosed = cfg?.supertrendXgbFailClosed === true;
  const ignoreCutoff = ignoreTrainingCutoff(cfg);

  /**
   * Research / offline path: precomputed idx→probability map (or ts→prob).
   * When set, skip AI health + HTTP scoring (fail-closed on missing).
   */
  const localByIdx = cfg?.supertrendXgbLocalProbByIdx;
  const localByTs = cfg?.supertrendXgbLocalProbByTs;
  const hasLocal =
    (localByIdx && typeof localByIdx === "object") ||
    (localByTs && typeof localByTs === "object");
  if (hasLocal) {
    const series = buildIndicatorSeries(candles);
    const idxMap =
      localByIdx instanceof Map
        ? localByIdx
        : new Map(
            Object.entries(localByIdx || {}).map(([k, v]) => [Number(k), Number(v)]),
          );
    const tsMap =
      localByTs instanceof Map
        ? localByTs
        : new Map(
            Object.entries(localByTs || {}).map(([k, v]) => [Number(k), Number(v)]),
          );
    return {
      enabled: true,
      threshold,
      baseUrl: "local",
      series,
      cutoffMs: null,
      failClosed: true,
      ignoreCutoff: true,
      local: true,
      async filterSignal(barSignal, idx, bar) {
        if (!barSignal?.action || barSignal.action === "HOLD" || barSignal.action === "EXIT") {
          return barSignal;
        }
        let p = idxMap.has(idx) ? idxMap.get(idx) : undefined;
        if (p === undefined) {
          const ts = Number(bar?.ts);
          if (Number.isFinite(ts) && tsMap.has(ts)) p = tsMap.get(ts);
        }
        p = Number(p);
        if (!Number.isFinite(p)) return null;
        if (p < threshold) return null;
        return { ...barSignal, supertrendXgbProb: p, reason: barSignal.reason || "supertrend_xgb_pass" };
      },
    };
  }

  let trainEndMs = null;
  let trainedAtMs = null;
  let healthOk = false;
  try {
    const healthResp = await axios.get(`${baseUrl}/health`, {
      timeout: 5_000,
      validateStatus: (s) => s < 500,
    });
    healthOk = healthResp.status === 200 && healthResp.data?.ok !== false;
    const meta = healthResp.data?.supertrend_xgb_meta ?? healthResp.data?.meta_supertrend_xgb;
    if (meta?.train_end_ts != null) trainEndMs = Number(meta.train_end_ts);
    if (typeof meta?.trained_at === "string") trainedAtMs = new Date(meta.trained_at).getTime();
    if (!Number.isFinite(trainEndMs) && Number.isFinite(trainedAtMs)) trainEndMs = trainedAtMs;
    if (healthResp.data?.supertrend_xgb_loaded === false) {
      console.warn("[backtest:supertrendXgb] model not loaded on AI service", { baseUrl });
      if (failClosed) {
        return {
          enabled: true,
          threshold,
          baseUrl,
          cutoffMs: null,
          failClosed: true,
          prepError: "model_not_loaded",
          async filterSignal() {
            return null;
          },
        };
      }
    }
  } catch (err) {
    console.warn(
      "[backtest:supertrendXgb] AI health failed —",
      failClosed ? "fail-closed (all ST entries vetoed)" : "fail-open",
      { baseUrl, error: String(err?.message || err) },
    );
    if (failClosed) {
      return {
        enabled: true,
        threshold,
        baseUrl,
        cutoffMs: null,
        failClosed: true,
        prepError: "ai_unreachable",
        async filterSignal() {
          return null;
        },
      };
    }
  }

  const cutoff = !ignoreCutoff && Number.isFinite(trainEndMs) ? trainEndMs : null;
  if (cutoff != null && Number.isFinite(fromMs) && cutoff > fromMs && !ignoreCutoff) {
    console.warn(
      "[backtest:supertrendXgb] model train_end after backtest from — pre-cutoff bars ungated; set supertrendXgbIgnoreTrainingCutoff for full-window A/B",
      { cutoff, fromMs },
    );
  }

  const series = buildIndicatorSeries(candles);
  /** @type {Map<number, number|null>} idx → probability (null = veto / missing) */
  const probByIdx = new Map();

  // Pre-score Supertrend flip bars in one batch (avoids N HTTP round-trips).
  if (Array.isArray(stSeries) && stSeries.length === candles.length && healthOk) {
    const flipIdx = [];
    const featRows = [];
    for (let i = 0; i < candles.length; i++) {
      const sig = signalFromSupertrendBar(stSeries[i]);
      if (!sig?.action || sig.action === "HOLD") continue;
      const ts = Number(candles[i]?.ts);
      if (cutoff != null && Number.isFinite(ts) && ts <= cutoff) continue;
      const raw = featuresAtBar(candles, series, i);
      const hour = Number.isFinite(ts) ? new Date(ts).getUTCHours() : null;
      const feat = encodeSupertrendXgbFeatures(
        {
          ...raw,
          entryHourUtc: hour,
          entryWeekday: weekdayLabel(ts),
          session: sessionFromUtcHour(hour),
        },
        sig.action,
      );
      flipIdx.push(i);
      featRows.push(feat);
    }
    if (featRows.length) {
      try {
        const { data } = await axios.post(
          `${baseUrl}/predict/supertrend/batch`,
          { features_list: featRows },
          { timeout: 120_000, validateStatus: (s) => s < 500 },
        );
        const probs = Array.isArray(data?.probabilities) ? data.probabilities : [];
        for (let j = 0; j < flipIdx.length; j++) {
          const p = Number(probs[j]);
          probByIdx.set(flipIdx[j], Number.isFinite(p) ? p : null);
        }
        console.info("[backtest:supertrendXgb] batch scored", {
          flips: flipIdx.length,
          threshold,
          baseUrl,
          ignoreCutoff,
          failClosed,
        });
      } catch (err) {
        console.warn("[backtest:supertrendXgb] batch predict failed", {
          baseUrl,
          error: String(err?.message || err),
          failClosed,
        });
        if (failClosed) {
          for (const i of flipIdx) probByIdx.set(i, null);
        }
      }
    }
  }

  return {
    enabled: true,
    threshold,
    baseUrl,
    series,
    cutoffMs: cutoff,
    failClosed,
    ignoreCutoff,
    async filterSignal(barSignal, idx, bar) {
      if (!barSignal?.action || barSignal.action === "HOLD" || barSignal.action === "EXIT") {
        return barSignal;
      }
      const ts = Number(bar?.ts);
      if (cutoff != null && Number.isFinite(ts) && ts <= cutoff) {
        return { ...barSignal, supertrendXgbBypass: "cutoff" };
      }

      let p = probByIdx.has(idx) ? probByIdx.get(idx) : undefined;
      if (p === undefined) {
        try {
          const raw = featuresAtBar(candles, series, idx);
          const hour = Number.isFinite(ts) ? new Date(ts).getUTCHours() : null;
          const feat = encodeSupertrendXgbFeatures(
            {
              ...raw,
              entryHourUtc: hour,
              entryWeekday: weekdayLabel(ts),
              session: sessionFromUtcHour(hour),
            },
            barSignal.action,
          );
          const { data } = await axios.post(
            `${baseUrl}/predict/supertrend`,
            { features: feat },
            { timeout: 8_000, validateStatus: (s) => s < 500 },
          );
          p = Number(data?.probability);
          if (!Number.isFinite(p)) p = null;
          probByIdx.set(idx, p);
        } catch {
          if (failClosed) return null;
          return { ...barSignal, supertrendXgbBypass: "fail_open" };
        }
      }

      if (p == null || !Number.isFinite(p)) {
        if (failClosed) return null;
        return { ...barSignal, supertrendXgbBypass: "fail_open" };
      }
      if (p < threshold) return null;
      return { ...barSignal, supertrendXgbProb: p, reason: barSignal.reason || "supertrend_xgb_pass" };
    },
  };
}

export function strategyUsesSupertrendXgbGate(strategyKey, cfg) {
  return cfg?.supertrendXgbGateEnabled === true && isSupertrendXgbStrategy(strategyKey);
}

export { SUPERTREND_XGB_FEATURE_KEYS };
