import { trailStepToTierLabel } from "./supertrendTrailingSl.js";

/**
 * Trail **tier** step used for CLOSE `reason` / UI labels: exchange-verified only.
 * When `confirmedTrailStep` is still 0, we do not assign T01/T02 from optimistic `trailStep`
 * (requested SL replace may not be live yet — label would overshoot the actual protective stop).
 * When both are positive, use `min` so a briefly-ahead `trailStep` cannot label above the last acked tier.
 *
 * @param {number|string|null|undefined} pendingRaw local / requested `trailStep`
 * @param {number|string|null|undefined} confirmedRaw exchange-acked `confirmedTrailStep`
 * @returns {number} integer step ≥ 0 suitable for `trailStepToTierLabel`, or 0 = no verified tier
 */
export function trailTierStepForCloseAudit(pendingRaw, confirmedRaw) {
  const pending = Math.max(0, Math.floor(Number(pendingRaw) || 0));
  const confirmed = Math.max(0, Math.floor(Number(confirmedRaw) || 0));
  if (confirmed > 0) return Math.min(pending || confirmed, confirmed);
  return 0;
}

/**
 * One-way USD-M position side at open (BUY = long, SELL = short) from the reduce-only **close** order side.
 */
export function positionSideAtOpenFromCloseSide(closeSide) {
  const c = String(closeSide || "").toUpperCase();
  if (c === "BUY") return "SELL";
  if (c === "SELL") return "BUY";
  return undefined;
}

/**
 * Snapshot trail tier fields from `mem.trailingBySymbol` when a reduce-only SL close is about to fire.
 * `trailStepAtClose` stores the **pending** local step; tier strings use {@link trailTierStepForCloseAudit}
 * so history labels match exchange-verified trailing, not optimistic step alone.
 *
 * @param {object|null|undefined} trailMeta
 * @param {string} hit `"SL"` | `"TP"` | …
 * @returns {{
 *   exitViaTrailedStop: boolean;
 *   trailStepAtClose: number;
 *   trailTierAtClose: string|undefined;
 *   trailingMode: string|undefined;
 * }}
 */
export function trailCloseFieldsFromMemory(trailMeta, hit) {
  const isSl = String(hit || "").toUpperCase() === "SL";
  if (!trailMeta || !isSl) {
    return {
      exitViaTrailedStop: false,
      trailStepAtClose: 0,
      trailTierAtClose: undefined,
      trailingMode: trailMeta?.trailingMode != null ? String(trailMeta.trailingMode) : undefined,
    };
  }
  const pendingStep = Math.max(0, Math.floor(Number(trailMeta.trailStep) || 0));
  const confirmedStep = Math.max(0, Math.floor(Number(trailMeta.confirmedTrailStep) || 0));
  const stepForTier = trailTierStepForCloseAudit(pendingStep, confirmedStep);
  const style = trailMeta.trailStepLabelStyle || "classic";
  const tierFromMem = stepForTier > 0 ? trailStepToTierLabel(stepForTier, style) : null;
  return {
    exitViaTrailedStop: pendingStep > 0 || confirmedStep > 0,
    trailStepAtClose: pendingStep,
    trailTierAtClose: tierFromMem || undefined,
    trailingMode: trailMeta.trailingMode != null ? String(trailMeta.trailingMode) : undefined,
  };
}

/**
 * Normalize tier token for `reason` strings (e.g. `T1`, `T01`, `T02`).
 * @param {string|null|undefined} s
 */
function tierTokenForReason(s) {
  if (s == null || String(s).trim() === "") return null;
  return String(s)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
}

/**
 * Stable close `reason` for USD-M CLOSE rows merged from REALIZED_PNL + local hints.
 * Prefer `TRAILED_SUPERTREND_<tier>` for Supertrend trailing; `TRAILED_STOP_LOSS_<tier>` for fee ladder.
 *
 * @param {object} lc local close hint
 */
export function closeReasonFromLocalCloseHint(lc) {
  const bt = String(lc?.bracketType || "").toUpperCase();
  const tmode = String(lc?.trailingMode || "").toUpperCase();

  const pendingClose = Math.max(0, Math.floor(Number(lc?.trailStepAtClose) || 0));
  const confirmedClose = Math.max(0, Math.floor(Number(lc?.confirmedTrailStepAtClose) || 0));
  const stepForTier = trailTierStepForCloseAudit(pendingClose, confirmedClose);

  let tierLc = null;
  if (stepForTier > 0) {
    const sty = lc?.trailStepLabelStyleAtClose || lc?.trailStepLabelStyle || "classic";
    tierLc = trailStepToTierLabel(stepForTier, sty);
  }
  const tierU = tierTokenForReason(tierLc);

  let exitTrailed = lc?.exitViaTrailedStop === true;
  /** Race / income merge: verified tier step or flag, but not optimistic-only pending */
  if (bt === "SL" && !exitTrailed && stepForTier > 0) {
    exitTrailed = true;
  }

  if (bt === "SL") {
    if (exitTrailed) {
      /** No exchange-verified tier yet — keep generic SL reason (avoids false `T02` on lagging SL replace). */
      if (!tierU) return "STOP_LOSS_DEFAULT";
      if (tmode === "FEE_LADDER") {
        return `TRAILED_STOP_LOSS_${tierU}`;
      }
      /** SUPERTREND, unset, or any non–fee-ladder mode — tiered autotrade uses these `reason` codes. */
      return `TRAILED_SUPERTREND_${tierU}`;
    }
    return "STOP_LOSS_DEFAULT";
  }
  if (bt === "TP") return "TAKE_PROFIT";
  const scr = String(lc?.strategyCloseReason || "").toUpperCase();
  if (scr === "SUPERTREND_EXIT" || scr === "SUPERTREND_FLIP") return scr;
  /**
   * `bracketType` was left null by the reconcile path because mark wasn't near SL or TP — we genuinely
   * don't know what triggered the exchange-side close. Return `EXCHANGE_REALIZED` rather than
   * `MANUAL_CLOSE` so the UI distinguishes "user clicked close" vs "exchange closed the position".
   */
  if (lc?.exchangeNativeClose === true && (bt == null || bt === "")) return "EXCHANGE_REALIZED";
  return "MANUAL_CLOSE";
}

/**
 * Close-reason tolerance: how close the **actual exit avg fill** must be to SL/TP (as a fraction of
 * price) to label the row as `STOP_LOSS` / `TAKE_PROFIT`. 0.0035 ≈ 0.35%, which comfortably covers
 * stop slippage (a few ticks past trigger) plus a small buffer without tagging unrelated signal /
 * manual / trailing exits as SL/TP.
 */
const CLOSE_REASON_FILL_BAND = 0.0035;

/**
 * Re-derive the CLOSE `reason` after the **actual exit avg fill price** is known (from `userTrades`).
 *
 * The original reason often lands as `EXCHANGE_REALIZED` or `MANUAL_CLOSE` — either because the
 * reconciler ran before a mark price was available, or because the mark moved past SL/TP before we
 * snapshotted. Once we have the true fill price, we can tell whether the close actually hit a bracket
 * and upgrade the label to `STOP_LOSS` / `TRAILED_SUPERTREND_Tnn` / `TAKE_PROFIT`.
 *
 * Only *upgrades* unknown/generic reasons. Never overrides an already-specific reason
 * (`TRAILED_STOP_LOSS_*`, `TAKE_PROFIT`, `SUPERTREND_FLIP`, …) to avoid demoting a correct label.
 *
 * @param {{
 *   existingReason?: string | null;
 *   exitAvgFillPrice: number | null | undefined;
 *   stopLoss: number | null | undefined;
 *   takeProfit: number | null | undefined;
 *   positionSideAtOpen?: string | null;
 *   trailStepAtClose?: number | null;
 *   confirmedTrailStepAtClose?: number | null;
 *   trailStepLabelStyleAtClose?: string | null;
 *   trailingMode?: string | null;
 *   exitViaTrailedStop?: boolean;
 * }} p
 * @returns {string | null} Upgraded reason, or original `existingReason` if we can't confidently upgrade.
 */
export function refineCloseReasonFromExitFill(p) {
  const existing = String(p.existingReason || "").trim().toUpperCase();
  const upgradable =
    existing === "" ||
    existing === "EXCHANGE_REALIZED" ||
    existing === "MANUAL_CLOSE" ||
    existing === "STOP_LOSS_DEFAULT";
  if (!upgradable) return p.existingReason ?? null;

  const px = Number(p.exitAvgFillPrice);
  if (!Number.isFinite(px) || px <= 0) return p.existingReason ?? null;
  const sl = Number(p.stopLoss);
  const tp = Number(p.takeProfit);

  const posSide = String(p.positionSideAtOpen || "").toUpperCase();
  /** Default to long when we don't know — same as existing helpers — but only for orientation in
   * `nearSl`/`nearTp` sign checks below, which use absolute distance anyway. */
  const isLong = posSide === "BUY" || posSide === "LONG" || posSide === "";

  const nearSl =
    Number.isFinite(sl) && sl > 0 && Math.abs(px - sl) / sl <= CLOSE_REASON_FILL_BAND;
  const nearTp =
    Number.isFinite(tp) && tp > 0 && Math.abs(px - tp) / tp <= CLOSE_REASON_FILL_BAND;

  /** If both brackets look close (unusual — e.g. very tight TP), pick the closer one. */
  let pickSl = nearSl && !nearTp;
  let pickTp = nearTp && !nearSl;
  if (nearSl && nearTp) {
    const dSl = Math.abs(px - sl);
    const dTp = Math.abs(px - tp);
    if (dSl <= dTp) pickSl = true;
    else pickTp = true;
  }

  /** Additional directional sanity: long SL below entry/px, long TP above; short inverted.
   * Without a trustworthy `isLong` we skip this and rely on the band check. */
  void isLong;

  if (pickTp) return "TAKE_PROFIT";
  if (pickSl) {
    return closeReasonFromLocalCloseHint({
      bracketType: "SL",
      exitViaTrailedStop: p.exitViaTrailedStop === true,
      trailStepAtClose: p.trailStepAtClose,
      confirmedTrailStepAtClose: p.confirmedTrailStepAtClose,
      trailStepLabelStyleAtClose: p.trailStepLabelStyleAtClose,
      trailingMode: p.trailingMode,
    });
  }

  return p.existingReason ?? null;
}
