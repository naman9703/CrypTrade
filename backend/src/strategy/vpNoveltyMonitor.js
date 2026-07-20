/**
 * VP novelty / drift monitor (Layer 3–4 prepared-regime doctrine).
 *
 * - Known bleed cells → abstain (handled by prepared-regime filter).
 * - Prepared cells → trade until rolling live expectancy breaches.
 * - Unknown / thin cells → optional size-down or abstain (allowlist / unknown policy).
 *
 * Pure state machine — backtest and live share the same rules.
 */

/**
 * @typedef {object} VpNoveltyMonitorState
 * @property {Map<string, { outcomes: number[], disabled: boolean, disabledAt: number|null, reason: string|null }>} cells
 * @property {object} opts
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.minOutcomes=8] minimum closed trades before kill-switch can fire
 * @param {number} [opts.rollingWindow=20] max outcomes retained per cell
 * @param {number} [opts.minExpectancyR=-0.05] disable when mean R below this
 * @param {number} [opts.minWinRate=0.35] disable when WR below this (with minOutcomes)
 * @param {"trade"|"size_down"|"abstain"} [opts.unknownPolicy="trade"]
 * @param {number} [opts.unknownSizeMult=0.5]
 * @param {string[]} [opts.preparedCells]
 * @param {string[]} [opts.bleedCells]
 * @param {boolean} [opts.allowlistOnly=false]
 */
export function createVpNoveltyMonitor(opts = {}) {
  return {
    cells: new Map(),
    opts: {
      minOutcomes: Math.max(3, Math.floor(Number(opts.minOutcomes ?? 8))),
      rollingWindow: Math.max(5, Math.floor(Number(opts.rollingWindow ?? 20))),
      minExpectancyR: Number(opts.minExpectancyR ?? -0.05),
      minWinRate: Number(opts.minWinRate ?? 0.35),
      unknownPolicy: String(opts.unknownPolicy ?? "trade"),
      unknownSizeMult: Math.max(0.1, Math.min(1, Number(opts.unknownSizeMult ?? 0.5))),
      preparedCells: new Set((opts.preparedCells ?? []).map(String)),
      bleedCells: new Set((opts.bleedCells ?? []).map(String)),
      allowlistOnly: opts.allowlistOnly === true,
    },
  };
}

function cellBucket(state, key) {
  if (!state.cells.has(key)) {
    state.cells.set(key, { outcomes: [], disabled: false, disabledAt: null, reason: null });
  }
  return state.cells.get(key);
}

/**
 * Record a closed-trade R-multiple (or net PnL proxy scaled as R) for a cell.
 * @param {VpNoveltyMonitorState} state
 * @param {string} cellKey
 * @param {number} rMultiple
 * @param {number} [ts]
 */
export function recordVpCellOutcome(state, cellKey, rMultiple, ts = Date.now()) {
  if (!cellKey || !Number.isFinite(Number(rMultiple))) return;
  const bucket = cellBucket(state, cellKey);
  bucket.outcomes.push(Number(rMultiple));
  const win = state.opts.rollingWindow;
  if (bucket.outcomes.length > win) bucket.outcomes.splice(0, bucket.outcomes.length - win);

  const n = bucket.outcomes.length;
  if (n < state.opts.minOutcomes) return;

  const mean = bucket.outcomes.reduce((s, x) => s + x, 0) / n;
  const wr = bucket.outcomes.filter((x) => x > 0).length / n;
  if (mean < state.opts.minExpectancyR || wr < state.opts.minWinRate) {
    bucket.disabled = true;
    bucket.disabledAt = ts;
    bucket.reason =
      mean < state.opts.minExpectancyR
        ? `rolling_expectancy_${mean.toFixed(3)}`
        : `rolling_wr_${(wr * 100).toFixed(0)}`;
  }
}

/**
 * Re-enable a cell after autopsy (manual or research).
 * @param {VpNoveltyMonitorState} state
 * @param {string} cellKey
 */
export function resetVpCell(state, cellKey) {
  if (!state.cells.has(cellKey)) return;
  const bucket = state.cells.get(cellKey);
  bucket.disabled = false;
  bucket.disabledAt = null;
  bucket.reason = null;
  bucket.outcomes = [];
}

/**
 * @typedef {object} VpNoveltyDecision
 * @property {boolean} allow
 * @property {number} sizeMult
 * @property {string} policy
 * @property {string|null} reason
 * @property {"prepared"|"bleed"|"unknown"|"disabled"} classification
 */

/**
 * Decide whether to take a signal for this condition cell.
 * @param {VpNoveltyMonitorState} state
 * @param {string} cellKey
 * @returns {VpNoveltyDecision}
 */
export function decideVpNovelty(state, cellKey) {
  const key = String(cellKey ?? "");
  if (!key) {
    return { allow: true, sizeMult: 1, policy: "missing_key", reason: null, classification: "unknown" };
  }

  if (state.opts.bleedCells.has(key)) {
    return {
      allow: false,
      sizeMult: 0,
      policy: "bleed_cell",
      reason: "known_bleed_cell",
      classification: "bleed",
    };
  }

  const isPrepared = state.opts.preparedCells.size === 0 || state.opts.preparedCells.has(key);
  const isUnknown = state.opts.preparedCells.size > 0 && !state.opts.preparedCells.has(key);

  if (state.opts.allowlistOnly && isUnknown) {
    return {
      allow: false,
      sizeMult: 0,
      policy: "allowlist",
      reason: "unknown_cell_allowlist",
      classification: "unknown",
    };
  }

  const bucket = state.cells.get(key);
  if (bucket?.disabled) {
    return {
      allow: false,
      sizeMult: 0,
      policy: "kill_switch",
      reason: bucket.reason ?? "rolling_drift",
      classification: "disabled",
    };
  }

  if (isUnknown) {
    const pol = state.opts.unknownPolicy;
    if (pol === "abstain") {
      return {
        allow: false,
        sizeMult: 0,
        policy: "unknown_abstain",
        reason: "unknown_cell",
        classification: "unknown",
      };
    }
    if (pol === "size_down") {
      return {
        allow: true,
        sizeMult: state.opts.unknownSizeMult,
        policy: "unknown_size_down",
        reason: null,
        classification: "unknown",
      };
    }
    return {
      allow: true,
      sizeMult: 1,
      policy: "unknown_trade",
      reason: null,
      classification: "unknown",
    };
  }

  return {
    allow: true,
    sizeMult: 1,
    policy: "prepared",
    reason: null,
    classification: isPrepared ? "prepared" : "unknown",
  };
}

/** Snapshot for persistence / UI. */
export function serializeVpNoveltyMonitor(state) {
  const cells = {};
  for (const [k, v] of state.cells.entries()) {
    cells[k] = {
      n: v.outcomes.length,
      meanR: v.outcomes.length ? v.outcomes.reduce((s, x) => s + x, 0) / v.outcomes.length : null,
      wr: v.outcomes.length ? v.outcomes.filter((x) => x > 0).length / v.outcomes.length : null,
      disabled: v.disabled,
      disabledAt: v.disabledAt,
      reason: v.reason,
    };
  }
  return {
    opts: {
      ...state.opts,
      preparedCells: [...state.opts.preparedCells],
      bleedCells: [...state.opts.bleedCells],
    },
    cells,
  };
}
