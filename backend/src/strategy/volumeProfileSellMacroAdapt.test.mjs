import test from "node:test";
import assert from "node:assert/strict";
import { resolveVpSellMinHtfSep } from "./volumeProfileStrategy.js";

test("resolveVpSellMinHtfSep: soft when macro bearish", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.05],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellMacroBullMinHtfSepPct: 0.005,
  });
  assert.equal(sep, 0.0025);
});

test("resolveVpSellMinHtfSep: hard when above 20d EMA", () => {
  const pre = {
    macroAboveEma20d: [true],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.05],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellMacroBullMinHtfSepPct: 0.005,
  });
  assert.equal(sep, 0.005);
});

test("resolveVpSellMinHtfSep: hard when 5d EMA rising", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [0.01],
    macroPrior20d: [-0.02],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellMacroBullMinHtfSepPct: 0.005,
  });
  assert.equal(sep, 0.005);
});

test("resolveVpSellMinHtfSep: off uses soft / legacy", () => {
  const pre = { macroAboveEma20d: [true], macroEma5dSlope: [0.01], macroPrior20d: [0.1] };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: false,
    vpMinHtfSepPct: 0.0015,
    vpSellMinHtfSepPct: 0.0025,
  });
  assert.equal(sep, 0.0025);
});

test("resolveVpSellMinHtfSep: non-bear floor when prior60d above bear threshold", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.03],
    macroPrior60d: [0.02],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellMacroBullMinHtfSepPct: 0.005,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
  });
  assert.equal(sep, 0.005);
});

test("resolveVpSellMinHtfSep: sustained bear keeps soft sep", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.08],
    macroPrior60d: [-0.12],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
  });
  assert.equal(sep, 0.0025);
});

test("resolveVpSellMinHtfSep: weak-bear floor hardens shallow transition shorts", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.03],
    macroPrior60d: [-0.12],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellWeakBearMinHtfSepPct: 0.005,
    vpSellWeakBearPrior20dFloorPct: -0.1,
  });
  assert.equal(sep, 0.005);
});

test("resolveVpSellMinHtfSep: deep bear bypasses weak-bear floor", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.2],
    macroPrior60d: [-0.12],
  };
  const sep = resolveVpSellMinHtfSep(pre, 0, {
    vpSellMacroAdapt: true,
    vpSellMinHtfSepPct: 0.0025,
    vpSellWeakBearMinHtfSepPct: 0.005,
    vpSellWeakBearPrior20dFloorPct: -0.1,
  });
  assert.equal(sep, 0.0025);
});
