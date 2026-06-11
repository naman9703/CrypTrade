import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_ROUTE_TABLE, SITUATIONS } from "./situationConstants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROUTE_PATH = path.resolve(__dirname, "../../../scripts/bnb-situation-route-table.json");

/**
 * Load empirically derived route table; fall back to defaults when missing.
 * @param {string} [filePath]
 * @returns {{ routes: Record<string, string[]>, thresholds: object, meta: object }}
 */
export function loadRouteTable(filePath = process.env.SITUATION_ROUTE_TABLE || DEFAULT_ROUTE_PATH) {
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      return {
        routes: { ...DEFAULT_ROUTE_TABLE, ...(raw.routes || {}) },
        strategies: raw.strategies || {},
        thresholds: raw.thresholds || {},
        meta: raw.meta || {},
      };
    } catch {
      /* fall through */
    }
  }
  return { routes: { ...DEFAULT_ROUTE_TABLE }, strategies: {}, thresholds: {}, meta: { source: "default" } };
}

export function playbooksForSituation(situation, routeTable) {
  const routes = routeTable?.routes || DEFAULT_ROUTE_TABLE;
  return routes[situation] || [];
}

export function isStandDown(situation) {
  return situation === SITUATIONS.VOLATILE_AVOID || situation === SITUATIONS.CHOP_NEUTRAL;
}
