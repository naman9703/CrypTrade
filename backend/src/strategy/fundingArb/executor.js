/**
 * Dual-leg carry executor stub (Phase 3 — not wired to live exchange yet).
 * Defines the hedge-mismatch API for future spot+perp clients.
 */

export class HedgeMismatchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HedgeMismatchError";
    this.details = details;
  }
}

/**
 * Verify spot and perp filled quantities are within tolerance.
 * @param {{ filled_qty: number }} spotOrder
 * @param {{ filled_qty: number }} perpOrder
 * @param {number} size
 * @param {number} [tolFrac=0.01]
 */
export function verifyHedge(spotOrder, perpOrder, size, tolFrac = 0.01) {
  const s = Math.abs(Number(spotOrder?.filled_qty ?? 0));
  const p = Math.abs(Number(perpOrder?.filled_qty ?? 0));
  const target = Math.abs(Number(size));
  const filledDiff = Math.abs(s - p);
  if (target > 0 && filledDiff > target * tolFrac) {
    throw new HedgeMismatchError("Legs did not fill symmetrically — manual review needed", {
      spotQty: s,
      perpQty: p,
      size: target,
      filledDiff,
    });
  }
  return true;
}

/**
 * Placeholder executor — throws until Phase 3 wires real clients.
 */
export class ArbExecutor {
  /**
   * @param {{ spotClient?: object, perpClient?: object, positionSize?: number }} opts
   */
  constructor(opts = {}) {
    this.spot = opts.spotClient ?? null;
    this.perp = opts.perpClient ?? null;
    this.size = Number(opts.positionSize ?? 0);
  }

  /**
   * @param {string} _symbol
   * @param {'positive_funding'|'negative_funding'} _direction
   */
  async enterCarry(_symbol, _direction = "positive_funding") {
    throw new Error("funding_arb_executor_not_wired_phase3");
  }

  /**
   * @param {string} _symbol
   * @param {string} _carrySide
   */
  async exitCarry(_symbol, _carrySide) {
    throw new Error("funding_arb_executor_not_wired_phase3");
  }
}

export async function enterCarry(...args) {
  const ex = new ArbExecutor();
  return ex.enterCarry(...args);
}

export async function exitCarry(...args) {
  const ex = new ArbExecutor();
  return ex.exitCarry(...args);
}
