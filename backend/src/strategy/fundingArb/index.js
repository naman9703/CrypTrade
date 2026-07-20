/**
 * Funding-rate cash-and-carry research module (Phase 1–2).
 * Not registered as a live MANUAL strategy until net-yield gates pass.
 */

export * from "./types.js";
export * from "./signal.js";
export * from "./monitor.js";
export * from "./risk.js";
export {
  ArbExecutor,
  HedgeMismatchError,
  verifyHedge,
  enterCarry,
  exitCarry,
} from "./executor.js";
