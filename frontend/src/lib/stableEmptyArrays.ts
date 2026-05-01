import type { BotInstance } from "../types/instance";
import type { Strategy } from "../types/strategy";

/**
 * Stable fallbacks for Zustand selectors. Never use `?? []` inline in a selector — each evaluation
 * allocates a fresh array, so `getSnapshot`/effects see a "changed" value every time → infinite loops.
 */
export const EMPTY_BOT_INSTANCES: BotInstance[] = [];
export const EMPTY_STRATEGIES: Strategy[] = [];
