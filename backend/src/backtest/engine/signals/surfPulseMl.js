/**
 * SurfPulse XGBoost gate for backtests — only used when `cfg.surfPulseMlGateEnabled`
 * is true (default), matching live. Rules-only signals come from the shared
 * `SURF_PULSE_ML` baseline adapter in `baselines.js`.
 *
 * Flow (same as live):
 *   1. `surfPulseHardRules()` — trend / pullback / volume filter
 *   2. Optional: POST /predict/surfpulse (8-feature model); threshold from cfg
 *
 * Training-time guard: avoids look-ahead vs `trained_at` unless bypassed in saved
 * cfg (`surfPulseIgnoreTrainingCutoff`) or env `BACKTEST_SURF_IGNORE_TRAINING_CUTOFF`.
 */

import axios from "axios";
import { surfPulseHardRules } from "../../../strategy/surfPulseMl.js";

/** Must be >= surfPulseMl MIN_CANDLES (200) so hard-rules have enough history. */
const WARMUP_BARS = 200;
const DEFAULT_ML_THRESHOLD = 0.6;

/**
 * @param {{ symbol:string, tf:string,
 *   candles: Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>,
 *   cfg: Record<string, unknown>, fromMs: number }} args
 */
export async function buildSurfPulseMlGateAdapter({ symbol, tf, candles, cfg, fromMs }) {
  if (!candles?.length) throw new Error("surf_pulse_ml: no candles in window");

  const baseUrl = String(
    process.env.AI_SERVICE_URL || cfg?.aiBaseUrl || "http://localhost:8001"
  ).replace(/\/$/, "");
  const mlThreshold = Number(cfg?.surfPulseMlThreshold ?? DEFAULT_ML_THRESHOLD);

  // Pre-fetch training cutoff from the AI service health endpoint (best-effort).
  let trainingCutoffMs = null;
  try {
    const healthResp = await axios.get(`${baseUrl}/health`, { timeout: 5_000, validateStatus: (s) => s < 500 });
    const trainedAt = healthResp.data?.meta?.trained_at;
    if (typeof trainedAt === "string") trainingCutoffMs = new Date(trainedAt).getTime();
  } catch {
    /* health endpoint unavailable — continue without cutoff check */
  }

  if (Number.isFinite(trainingCutoffMs) && trainingCutoffMs > fromMs) {
    const c = new Date(trainingCutoffMs).toISOString().slice(0, 10);
    const s = new Date(fromMs).toISOString().slice(0, 10);
    const ignore =
      cfg?.surfPulseIgnoreTrainingCutoff === true ||
      ["1", "true", "yes"].includes(String(process.env.BACKTEST_SURF_IGNORE_TRAINING_CUTOFF || "").toLowerCase());
    if (!ignore) {
      throw new Error(
        `surf_pulse_ml: the loaded AI model was trained at ${c} (UTC), which is after your backtest start ${s}. ` +
          `Move **From** to **${c}** or later, or set \`bot.surfPulseIgnoreTrainingCutoff\` in the saved strategy (research only), ` +
          `or \`BACKTEST_SURF_IGNORE_TRAINING_CUTOFF=1\` on the backend.`,
      );
    }
    console.warn("[backtest:surfPulseMl] training cutoff check bypassed", { trainingCutoffMs, fromMs });
  }

  let lastDir = 0;

  return async function adapter(bar, idx, ctx) {
    if (idx < WARMUP_BARS) return null;

    // ── Door 1: rule-based hard filter (identical to live strategy) ──────────
    const slice = ctx.candles.slice(0, idx + 1);
    const ruleResult = surfPulseHardRules({ candles: slice });
    if (!ruleResult || ruleResult.action === "HOLD") return null;

    const action = ruleResult.action; // "BUY" | "SELL"

    // Skip if same direction as last signal (emit flip-only signals)
    const newDir = action === "BUY" ? 1 : -1;
    if (newDir === lastDir) return null;

    // ── Door 2: ML gate (8-feature surfpulse model) ───────────────────────────
    // Best-effort: if the AI service is down, pass through the rule-based signal.
    let mlApproved = true;
    if (ruleResult.features) {
      try {
        const resp = await axios.post(
          `${baseUrl}/predict/surfpulse`,
          { features: ruleResult.features },
          { timeout: 8_000, validateStatus: (s) => s === 200 },
        );
        const prob = Number(resp.data?.probability ?? 0.5);
        mlApproved = prob >= mlThreshold;
      } catch (err) {
        console.warn("[backtest:surfPulseMl] ML gate unavailable, using rule signal only:", err?.message || err);
        mlApproved = true; // degraded mode: rule-based only
      }
    }

    if (!mlApproved) return null;

    lastDir = newDir;
    return { action, reason: ruleResult.reason };
  };
}
