import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileAllowsKey, getStrategyProfile, profileChartMarkup } from "./strategyConfigProfile.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("frontend profile JSON matches backend profile JSON", () => {
  const fe = fs.readFileSync(path.join(__dirname, "strategyConfigProfile.data.json"), "utf8");
  const be = fs.readFileSync(
    path.resolve(__dirname, "../../../backend/src/strategy/strategyConfigProfile.data.json"),
    "utf8",
  );
  assert.deepEqual(JSON.parse(fe), JSON.parse(be));
});

test("Elite chart markup is not smc_ict — polluted gate must not imply SMC chart", () => {
  assert.equal(profileChartMarkup("SUPERTREND_ELITE"), "elite");
  assert.notEqual(profileChartMarkup("SUPERTREND_ELITE"), "smc_ict");
});

test("profileAllowsKey scopes Elite vs SR intraday", () => {
  assert.equal(profileAllowsKey("eliteStMinAdx", "SUPERTREND_ELITE"), true);
  assert.equal(profileAllowsKey("intradayGateSmcIct", "SUPERTREND_ELITE"), false);
  assert.equal(profileAllowsKey("intradayGateSmcIct", "SR_INTRADAY"), true);
  assert.equal(getStrategyProfile("SUPERTREND_ELITE").chartMarkup, "elite");
});
