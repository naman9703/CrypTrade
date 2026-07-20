/** Max candles kept in Zustand (WS + REST merge buffer for backfill). */
export const CHART_STORE_MAX = 3000;

/** Max bars rendered on the lightweight-charts canvas (display window). */
export const CHART_DISPLAY_MAX = 1000;

/** When visible range is within this many bars of the oldest loaded bar, fetch older history. */
export const CHART_BACKFILL_EDGE_BARS = 60;

/** Hours to request on each pan-left backfill step. */
export const CHART_BACKFILL_HOURS_STEP = 24;

/** Cap total history hours fetched via lazy backfill. */
export const CHART_BACKFILL_MAX_HOURS = 168;
