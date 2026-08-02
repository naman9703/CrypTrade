/**
 * Optional external market intelligence — delegates to microstructureSnapshot.
 * @deprecated Use microstructureSnapshot.js directly for MICRO_EVENT.
 */
export {
  fetchMarketIntelSnapshot,
  passesMarketIntelFilter,
  getMicrostructureSnapshot,
  buildMicrostructureSnapshot,
} from "./microstructureSnapshot.js";
