#!/usr/bin/env node
/**
 * BTC SMC 1H→15m — per-trade root-cause autopsy on Phase 0 tape.
 *
 *   node scripts/research-smc-btc-1h15m-trade-autopsy.mjs
 *   TAPE=scripts/.smc-btc-1h15m-phase0-tape.jsonl node ...
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAPE =
  process.env.TAPE || path.join(__dirname, ".smc-btc-1h15m-phase0-tape.jsonl");

function classifyLoss(t) {
  const modes = [];
  if (t.chochIdx == null) modes.push("missing_choch");
  if (!t.fvgTop && !t.obTop && t.entryZone === "reclaim") modes.push("chase_reclaim_entry");
  if (t.barsAfterReclaim === 0 && t.entryZone !== "fvg" && t.entryZone !== "ob" && t.entryZone !== "fvg_mid") {
    modes.push("entry_chase");
  }
  if (t.h1SideAligned === false) modes.push("wrong_htf_narrative");
  if (t.h1PoiAligned === false && t.h1DrEq != null) modes.push("wrong_htf_poi");
  if (t.mfePct > 0.004 && t.netPnl <= 0) modes.push("mfe_giveback");
  if (t.mfePct <= 0.001) modes.push("never_green");
  if (t.sweepExtensionPct != null && t.sweepExtensionPct < 0.003) modes.push("micro_sweep");
  if (t.htfBiasDisagreement === true) modes.push("htf_disagree");
  const hour = Number(t.utcHour);
  if (Number.isFinite(hour) && hour >= 0 && hour < 7 && t.netPnl <= 0) {
    modes.push("session_asia_risk");
  }
  if (Number.isFinite(hour) && hour >= 7 && hour < 9 && t.mfePct <= 0.001) {
    modes.push("session_judas_amd");
  }
  if (t.plannedRr != null && t.plannedRr < 1.5) modes.push("sub_min_rr");
  if (!modes.length) modes.push("concept_ok_still_lost");
  return modes;
}

function primaryMode(modes) {
  const priority = [
    "wrong_htf_narrative",
    "wrong_htf_poi",
    "entry_chase",
    "chase_reclaim_entry",
    "missing_choch",
    "never_green",
    "mfe_giveback",
    "session_judas_amd",
    "session_asia_risk",
    "micro_sweep",
    "htf_disagree",
    "sub_min_rr",
    "concept_ok_still_lost",
  ];
  for (const p of priority) if (modes.includes(p)) return p;
  return modes[0];
}

const raw = fs.readFileSync(TAPE, "utf8").trim();
if (!raw) {
  console.error(`Empty tape: ${TAPE} — run phase0 harvest first`);
  process.exit(1);
}
const trades = raw.split("\n").map((l) => JSON.parse(l));
const losers = trades.filter((t) => t.netPnl <= 0);
const winners = trades.filter((t) => t.netPnl > 0);

const annotated = trades.map((t) => {
  const modes = t.netPnl <= 0 ? classifyLoss(t) : [];
  return {
    ...t,
    entryIso: new Date(t.entryTs).toISOString(),
    failureModes: modes,
    primaryFailure: t.netPnl <= 0 ? primaryMode(modes) : null,
  };
});

const byMode = {};
for (const t of annotated.filter((x) => x.netPnl <= 0)) {
  const k = t.primaryFailure ?? "unknown";
  byMode[k] ??= { n: 0, pnl: 0, examples: [] };
  byMode[k].n += 1;
  byMode[k].pnl += t.netPnl;
  if (byMode[k].examples.length < 3) {
    byMode[k].examples.push({
      entryIso: t.entryIso,
      side: t.side,
      netPnl: +t.netPnl.toFixed(2),
      mfePct: t.mfePct,
      h1StructureState: t.h1StructureState,
      h1PoiAligned: t.h1PoiAligned,
      h1SideAligned: t.h1SideAligned,
      entryZone: t.entryZone,
      utcHour: t.utcHour,
    });
  }
}

const ranked = Object.entries(byMode)
  .map(([mode, s]) => ({
    mode,
    n: s.n,
    pnl: +s.pnl.toFixed(2),
    examples: s.examples,
  }))
  .sort((a, b) => a.pnl - b.pnl);

// Winner pattern: side × h1 alignment
function bucketKey(t) {
  return `${t.side}|h1=${t.h1StructureState ?? "?"}|poi=${t.h1PoiAligned === true ? "Y" : t.h1PoiAligned === false ? "N" : "?"}`;
}
const winPat = {};
const losePat = {};
for (const t of winners) {
  const k = bucketKey(t);
  winPat[k] ??= { n: 0, pnl: 0 };
  winPat[k].n += 1;
  winPat[k].pnl += t.netPnl;
}
for (const t of losers) {
  const k = bucketKey(t);
  losePat[k] ??= { n: 0, pnl: 0 };
  losePat[k].n += 1;
  losePat[k].pnl += t.netPnl;
}

const top = ranked[0];
const hypotheses = {
  wrong_htf_narrative:
    "H1: Require completed-1H narrative soft alignment (block hard opposite bias only).",
  wrong_htf_poi:
    "H1: Enter only in 1H dealing-range discount (BUY) / premium (SELL) — POI context.",
  never_green:
    "H2: Displacement stickiness / inducement — only if narrative+POI insufficient.",
  mfe_giveback: "H3: Exit/SL geometry — risk layer, not entry N-crush.",
  session_judas_amd: "H4: Session Judas/AMD conditioning on London open losers.",
  concept_ok_still_lost: "H5: Deeper regime feature — do not filter-stack blindly.",
};

console.log(`\n══ BTC 1H→15m trade autopsy — ${trades.length} trades (${losers.length} losers) ══`);
console.log("\n── Loss taxonomy (worst PnL first) ──");
for (const r of ranked) {
  console.log(`  ${r.mode.padEnd(28)} n=${String(r.n).padStart(3)} pnl=${r.pnl}`);
}
console.log(`\n#1 failure: ${top?.mode ?? "none"}`);
console.log(`hypothesis: ${hypotheses[top?.mode] ?? "Investigate manually."}`);

if (top?.examples?.length) {
  console.log("\n── Example losers (#1 mode) ──");
  for (const e of top.examples) {
    console.log(
      `  ${e.entryIso} ${e.side} pnl=${e.netPnl} mfe=${e.mfePct} h1=${e.h1StructureState} poi=${e.h1PoiAligned} zone=${e.entryZone} utcH=${e.utcHour}`,
    );
  }
}

console.log("\n── Winner patterns (side|h1|poi) ──");
for (const [k, s] of Object.entries(winPat).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 8)) {
  console.log(`  ${k.padEnd(36)} n=${s.n} pnl=${s.pnl.toFixed(2)}`);
}

const out = {
  generatedAt: new Date().toISOString(),
  tape: path.basename(TAPE),
  n: trades.length,
  losers: losers.length,
  rankedModes: ranked,
  topFailure: top?.mode ?? null,
  namedHypothesis: hypotheses[top?.mode] ?? null,
  winPatterns: winPat,
  losePatterns: losePat,
};
fs.writeFileSync(path.join(__dirname, ".smc-btc-1h15m-trade-autopsy.json"), JSON.stringify(out, null, 2));
console.log("\nwrote .smc-btc-1h15m-trade-autopsy.json");
