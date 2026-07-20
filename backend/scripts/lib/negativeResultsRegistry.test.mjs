import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { syncFromExperiments, negativeResultsToMarkdown } from "./negativeResultsRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "negative-results.json");

test("syncFromExperiments records rejected hypotheses", () => {
  const backup = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, "utf8") : null;
  try {
    const results = syncFromExperiments([
      {
        id: "EXP-TEST",
        hypothesis: "Test hypothesis",
        accepted: false,
        result: "WF-mixed",
        fdrSignificant: false,
        slices: {
          regime: {
            slices: {
              RANGE: { monotonicity: -0.3, spread: 0.05 },
              TREND_UP: { monotonicity: 0.2, spread: 0.2 },
            },
          },
        },
      },
      { id: "EXP-OK", hypothesis: "Accepted", accepted: true, result: "pass" },
    ]);
    const rejected = results.find((r) => r.id === "EXP-TEST");
    assert.ok(rejected);
    assert.ok(rejected.whyRejected.includes("walk_forward_inconsistent"));
    assert.ok(rejected.failureConditions?.length > 0);
    const md = negativeResultsToMarkdown(results);
    assert.ok(md.includes("EXP-TEST"));
  } finally {
    if (backup) fs.writeFileSync(REGISTRY_PATH, backup);
    else if (fs.existsSync(REGISTRY_PATH)) fs.unlinkSync(REGISTRY_PATH);
  }
});
