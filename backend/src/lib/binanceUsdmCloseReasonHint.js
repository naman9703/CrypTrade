import { trailStepToTierLabel } from "./supertrendTrailingSl.js";

/**
 * Snapshot trail tier fields from `mem.trailingBySymbol` when a reduce-only SL close is about to fire.
 * Uses max(trailStep, confirmedTrailStep) so exchange-verified tier is not lost if `trailStep` lags briefly.
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
  const stepEff = Math.max(
    0,
    Math.floor(Number(trailMeta.trailStep) || 0),
    Math.floor(Number(trailMeta.confirmedTrailStep) || 0),
  );
  const style = trailMeta.trailStepLabelStyle || "classic";
  const tierFromMem =
    trailMeta.trailTierLabel != null && String(trailMeta.trailTierLabel).trim() !== ""
      ? String(trailMeta.trailTierLabel).trim()
      : trailMeta.confirmedTrailTierLabel != null && String(trailMeta.confirmedTrailTierLabel).trim() !== ""
        ? String(trailMeta.confirmedTrailTierLabel).trim()
        : stepEff > 0
          ? trailStepToTierLabel(stepEff, style)
          : null;
  return {
    exitViaTrailedStop: stepEff > 0,
    trailStepAtClose: stepEff,
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

  const stepClose = Math.max(
    0,
    Math.floor(Number(lc?.trailStepAtClose) || 0),
    Math.floor(Number(lc?.confirmedTrailStepAtClose) || 0),
  );

  let tierLc = lc?.trailTierAtClose != null && String(lc.trailTierAtClose).trim() !== "" ? String(lc.trailTierAtClose).trim() : null;
  if (!tierLc && stepClose > 0) {
    const sty = lc?.trailStepLabelStyleAtClose || lc?.trailStepLabelStyle || "classic";
    tierLc = trailStepToTierLabel(stepClose, sty);
  }
  const tierU = tierTokenForReason(tierLc);

  let exitTrailed = lc?.exitViaTrailedStop === true;
  /** Race / income merge: step or tier present but flag missing */
  if (bt === "SL" && !exitTrailed && (Boolean(tierU) || stepClose > 0)) {
    exitTrailed = true;
  }

  if (bt === "SL") {
    if (exitTrailed) {
      if (tmode === "FEE_LADDER") {
        return tierU ? `TRAILED_STOP_LOSS_${tierU}` : "TRAILED_STOP_LOSS";
      }
      /** SUPERTREND, unset, or any non–fee-ladder mode — tiered autotrade uses these `reason` codes. */
      return tierU ? `TRAILED_SUPERTREND_${tierU}` : "TRAILED_SUPERTREND";
    }
    return "STOP_LOSS_DEFAULT";
  }
  if (bt === "TP") return "TAKE_PROFIT";
  const scr = String(lc?.strategyCloseReason || "").toUpperCase();
  if (scr === "SUPERTREND_EXIT" || scr === "SUPERTREND_FLIP") return scr;
  return "MANUAL_CLOSE";
}
