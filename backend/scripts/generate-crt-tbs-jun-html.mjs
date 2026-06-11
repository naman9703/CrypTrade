#!/usr/bin/env node
/**
 * Generate CRT+TBS trade explanation HTML for BNBUSDT Jun 1–8 2026.
 * Output: docs/chart-studies/CRT_TBS_BNBUSDT_2026-06-01_to_08.html
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildCrtTbsBacktestAdapter,
  resolveCrtTbsCfg,
  crtTbsPadFromMs,
  optsFromCrtTbsCfg,
} = await import("../src/strategy/crtTbsIntraday.js");
const { CRT_TBS_BNB_15M } = await import("../src/strategy/presets/crtTbsOptimized.js");
const {
  buildCrtContext,
  isTurtleBodySoup,
  buildCrtBrackets,
} = await import("../src/strategy/techniques/crtTbs.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { inSmcKillzone, utcHourFromTs } = await import("../src/strategy/techniques/sessionKillzones.js");
const { detectChochInRange } = await import("../src/strategy/techniques/bosChoch.js");
const { rejectionWickRatio } = await import("../src/strategy/techniques/liquidity.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const FROM = Date.parse("2026-06-01T00:00:00Z");
const TO = Date.parse("2026-06-08T00:00:00Z");
const candles = await readCandles(
  "BNBUSDT",
  "15m",
  crtTbsPadFromMs(FROM, "15m") - 2 * 86_400_000,
  TO,
  { market: "futures" },
);
const cfg = resolveCrtTbsCfg({ ...CRT_TBS_BNB_15M, riskPerTrade: 2 });
const opts = optsFromCrtTbsCfg(cfg);
const pre = precomputeIntraday(candles);
const ctx = buildCrtContext(candles, opts);
const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));

const adapter = buildCrtTbsBacktestAdapter(candles, cfg, "15m");
const sim = await runSimulation({
  candles,
  strategyKey: "CRT_TBS",
  cfg: { ...cfg, symbol: "BNBUSDT" },
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: "15m",
  adapters: { CRT_TBS: adapter },
  symbol: "BNBUSDT",
  costModelOverride: {
    leverage: 12,
    openFeeRate: 0.0004,
    closeFeeRate: 0.0004,
    slippagePct: 0.0005,
  },
});

const windowTrades = sim.trades.filter((t) => t.entryTs >= FROM && t.entryTs < TO);
const byEntry = new Map();
for (const t of windowTrades) {
  if (!byEntry.has(t.entryTs)) byEntry.set(t.entryTs, []);
  byEntry.get(t.entryTs).push(t);
}

function fmtUtc(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function findTbsIdx(entryIdx, crtLo, sweepWick) {
  for (let j = entryIdx - 8; j <= entryIdx; j++) {
    if (j < 0) continue;
    if (isTurtleBodySoup(candles[j], crtLo, "BUY", opts) && Math.abs(candles[j].low - sweepWick) < 0.06) {
      return j;
    }
  }
  for (let j = entryIdx - 8; j <= entryIdx; j++) {
    if (j >= 0 && isTurtleBodySoup(candles[j], crtLo, "BUY", opts)) return j;
  }
  return entryIdx;
}

const tradeReports = [];
for (const [entryTs, legs] of [...byEntry.entries()].sort((a, b) => a[0] - b[0])) {
  const entryIdx = tsToIdx.get(entryTs);
  const eb = candles[entryIdx];
  const liq = legs[0].liqContext || {};
  const crtLo = Number(liq.level);
  const crtHi = Number(liq.opposingLevel);
  const sweepWick = Number(liq.sweepWick);
  const eq = (crtHi + crtLo) / 2;
  const tbsIdx = findTbsIdx(entryIdx, crtLo, sweepWick);
  const tb = candles[tbsIdx];
  const choch = detectChochInRange(candles, tbsIdx, entryIdx, "BUY", opts);
  const chochIdx = choch.ok ? choch.chochIdx : entryIdx;
  const br = buildCrtBrackets("BUY", eb.close, sweepWick, crtHi, crtLo, opts);
  const chartFrom = Math.max(0, tbsIdx - 12);
  const chartTo = Math.min(candles.length - 1, Math.max(entryIdx, ...legs.map((l) => tsToIdx.get(l.exitTs) ?? entryIdx)) + 8);

  tradeReports.push({
    title: fmtUtc(entryTs).slice(0, 10),
    entryTs,
    entryIdx,
    tbsIdx,
    chochIdx,
    exitLegs: legs.map((l) => ({
      reason: l.exitReason,
      exitTs: l.exitTs,
      exitIdx: tsToIdx.get(l.exitTs),
      net: l.netPnl,
      exitPrice: l.exitPrice,
    })),
    netTotal: legs.reduce((s, l) => s + l.netPnl, 0),
    entry: eb.close,
    crt: { lo: crtLo, hi: crtHi, eq, refTs: ctx.crtTs[tbsIdx] },
    tbs: {
      ts: tb.ts,
      o: tb.open,
      h: tb.high,
      l: tb.low,
      c: tb.close,
      wick: rejectionWickRatio(tb, "BUY"),
      kz: inSmcKillzone(tb.ts, opts),
      hour: utcHourFromTs(tb.ts),
    },
    choch: { ok: choch.ok, type: choch.type, level: choch.chochLevel, idx: chochIdx },
    brackets: br,
    chartFrom,
    chartTo,
    chartCandles: candles.slice(chartFrom, chartTo + 1).map((c) => ({
      ts: c.ts,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    })),
  });
}

await closePool();

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderChart(tr) {
  const W = 920;
  const H = 420;
  const padL = 58;
  const padR = 12;
  const padT = 36;
  const padB = 52;
  const cw = W - padL - padR;
  const ch = H - padT - padB;
  const bars = tr.chartCandles;
  const n = bars.length;
  const prices = [
    ...bars.flatMap((b) => [b.h, b.l]),
    tr.crt.hi,
    tr.crt.lo,
    tr.crt.eq,
    tr.brackets?.slPrice,
    tr.brackets?.tp1Price,
    tr.brackets?.tp2Price,
    tr.choch.level,
  ].filter((p) => Number.isFinite(p) && p > 0);
  const yMin = Math.min(...prices) * 0.998;
  const yMax = Math.max(...prices) * 1.002;
  const y = (p) => padT + ((yMax - p) / (yMax - yMin)) * ch;
  const x = (i) => padL + (i + 0.5) * (cw / n);
  const bw = Math.max(3, (cw / n) * 0.55);

  const idxOf = (globalIdx) => globalIdx - tr.chartFrom;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img">`;

  // Killzone bands (London 07-10, NY 12-16 UTC) — shade bars in window
  for (let i = 0; i < n; i++) {
    const h = utcHourFromTs(bars[i].ts);
    const london = h >= 7 && h < 10;
    const ny = h >= 12 && h < 16;
    if (london || ny) {
      const x0 = padL + i * (cw / n);
      svg += `<rect x="${x0}" y="${padT}" width="${cw / n}" height="${ch}" fill="${london ? "rgba(56,189,248,0.07)" : "rgba(167,139,250,0.07)"}" />`;
    }
  }

  // Discount zone (below EQ)
  svg += `<rect x="${padL}" y="${y(tr.crt.eq)}" width="${cw}" height="${ch - (y(tr.crt.eq) - padT)}" fill="rgba(52,211,153,0.06)" />`;

  const hline = (price, color, dash, label, yOff = 0) => {
    if (!Number.isFinite(price)) return "";
    const yy = y(price);
    return `<line x1="${padL}" y1="${yy}" x2="${padL + cw}" y2="${yy}" stroke="${color}" stroke-width="1.5" stroke-dasharray="${dash}" />
      <text x="${padL + cw + 4}" y="${yy + 4 + yOff}" fill="${color}" font-size="10" font-family="ui-monospace,monospace">${esc(label)}</text>`;
  };

  const sw = tr.brackets?.sweepWick ?? tr.tbs.l;
  svg += hline(tr.crt.hi, "#c084fc", "6,4", `CRT High ${tr.crt.hi.toFixed(2)}`);
  svg += hline(tr.crt.eq, "#a3e635", "4,3", `EQ ${tr.crt.eq.toFixed(2)}`);
  svg += hline(tr.crt.lo, "#f472b6", "6,4", `CRT Low ${tr.crt.lo.toFixed(2)}`);
  svg += hline(sw, "#fb7185", "5,3", `Sweep wick ${sw.toFixed(2)}`);
  if (tr.choch.ok && tr.choch.level > 0) {
    svg += hline(tr.choch.level, "#e879f9", "3,2", `CHoCH ${tr.choch.level.toFixed(2)}`);
  }
  svg += hline(tr.brackets?.slPrice, "#f87171", "5,3", `SL ${tr.brackets?.slPrice?.toFixed(2)}`);
  svg += hline(tr.brackets?.tp1Price, "#84cc16", "4,2", `TP1 ${tr.brackets?.tp1Price?.toFixed(2)}`, -10);
  svg += hline(tr.brackets?.tp2Price, "#a855f7", "4,2", `TP2 ${tr.brackets?.tp2Price?.toFixed(2)}`);

  // Candles
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const bull = b.c >= b.o;
    const col = bull ? "#22c55e" : "#ef4444";
    const cx = x(i);
    const yH = y(b.h);
    const yL = y(b.l);
    const yO = y(b.o);
    const yC = y(b.c);
    const top = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    svg += `<line x1="${cx}" y1="${yH}" x2="${cx}" y2="${yL}" stroke="${col}" stroke-width="1" />`;
    svg += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${bodyH}" fill="${col}" rx="0.5" />`;
    if (i % Math.ceil(n / 8) === 0) {
      const lbl = new Date(b.ts).toISOString().slice(5, 16).replace("T", " ");
      svg += `<text x="${cx}" y="${H - 8}" fill="#94a3b8" font-size="9" text-anchor="middle" font-family="ui-monospace,monospace">${esc(lbl)}</text>`;
    }
  }

  const marker = (globalIdx, price, color, label, shape = "tri") => {
    const i = idxOf(globalIdx);
    if (i < 0 || i >= n) return "";
    const cx = x(i);
    const cy = y(price);
    let g = "";
    if (shape === "tri") {
      g += `<polygon points="${cx},${cy - 10} ${cx - 7},${cy + 4} ${cx + 7},${cy + 4}" fill="${color}" />`;
    } else {
      g += `<circle cx="${cx}" cy="${cy}" r="6" fill="${color}" stroke="#0f172a" stroke-width="1.5" />`;
    }
    g += `<text x="${cx}" y="${cy - 14}" fill="${color}" font-size="10" font-weight="600" text-anchor="middle" font-family="system-ui,sans-serif">${esc(label)}</text>`;
    return g;
  };

  svg += marker(tr.tbsIdx, tr.tbs.l, "#fbbf24", "TBS", "circle");
  if (tr.choch.idx !== tr.tbsIdx) svg += marker(tr.choch.idx, tr.choch.level || tr.chartCandles[idxOf(tr.choch.idx)]?.c, "#e879f9", "CHoCH");
  svg += marker(tr.entryIdx, tr.entry, "#38bdf8", "ENTRY");
  for (const leg of tr.exitLegs) {
    const col = leg.reason === "sl" ? "#f87171" : "#4ade80";
    svg += marker(leg.exitIdx, leg.exitPrice, col, leg.reason.toUpperCase(), "circle");
  }

  svg += `</svg>`;
  return svg;
}

const noTradeDays = ["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-06", "2026-06-07"];

const tradeSections = tradeReports
  .map((tr, i) => {
    const win = tr.netTotal >= 0;
    const legsHtml = tr.exitLegs
      .map(
        (l) =>
          `<li><strong>${esc(l.reason)}</strong> @ ${esc(fmtUtc(l.exitTs))} — $${l.net.toFixed(2)} (exit ${l.exitPrice.toFixed(2)})</li>`,
      )
      .join("");
    return `
    <section class="trade-card" id="trade-${i + 1}">
      <header>
        <h2>Trade ${i + 1} — ${esc(fmtUtc(tr.entryTs).slice(0, 10))}</h2>
        <span class="badge ${win ? "win" : "loss"}">${win ? "WIN" : "LOSS"} · $${tr.netTotal.toFixed(2)}</span>
      </header>
      <div class="chart-wrap">${renderChart(tr)}</div>
      <div class="grid-2">
        <div class="panel">
          <h3>Setup phases</h3>
          <ol class="phases">
            <li><span class="tag crt">CRT</span> Prior 4H candle (${esc(fmtUtc(tr.crt.refTs).slice(0, 16))}) → High <strong>${tr.crt.hi.toFixed(2)}</strong>, Low <strong>${tr.crt.lo.toFixed(2)}</strong>, EQ <strong>${tr.crt.eq.toFixed(2)}</strong></li>
            <li><span class="tag tbs">TBS</span> ${esc(fmtUtc(tr.tbs.ts))} — swept to <strong>${tr.tbs.l.toFixed(2)}</strong>, closed <strong>${tr.tbs.c.toFixed(2)}</strong> above CRT low. Wick ratio ${(tr.tbs.wick * 100).toFixed(0)}%. Killzone h${tr.tbs.hour} UTC ${tr.tbs.kz ? "✓" : "✗"}</li>
            <li><span class="tag choch">CHoCH</span> ${tr.choch.ok ? `${esc(tr.choch.type)} @ ${tr.choch.level.toFixed(2)} (${esc(fmtUtc(candles[tr.choch.idx].ts).slice(11, 16))} UTC)` : "—"} — ${tr.entryIdx - tr.tbsIdx} bars after TBS</li>
            <li><span class="tag entry">ENTRY</span> ${esc(fmtUtc(tr.entryTs))} long @ <strong>${tr.entry.toFixed(2)}</strong> ${tr.entry <= tr.crt.eq ? "(discount ✓)" : "(above EQ ⚠)"}</li>
          </ol>
        </div>
        <div class="panel">
          <h3>Brackets</h3>
          <table class="kv">
            <tr><td>Stop (below sweep wick)</td><td>${tr.brackets?.slPrice?.toFixed(2)}</td></tr>
            <tr><td>TP1 @ equilibrium</td><td>${tr.brackets?.tp1Price?.toFixed(2)}</td></tr>
            <tr><td>TP2 @ CRT high</td><td>${tr.brackets?.tp2Price?.toFixed(2)}</td></tr>
            <tr><td>R:R to TP2</td><td>${tr.brackets?.rr?.toFixed(2)}</td></tr>
          </table>
          <h3>Exits</h3>
          <ul>${legsHtml}</ul>
        </div>
      </div>
    </section>`;
  })
  .join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CRT+TBS — BNBUSDT Jun 1–8 2026</title>
  <style>
    :root {
      --bg: #0b1120;
      --card: #131c31;
      --border: #1e293b;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 1.65rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
    .subtitle { color: var(--muted); margin: 0 0 2rem; font-size: 0.95rem; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 0.75rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
    }
    .stat .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .stat .value { font-size: 1.35rem; font-weight: 700; margin-top: 0.25rem; }
    .legend {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin-bottom: 2rem;
      font-size: 0.88rem;
    }
    .legend h2 { font-size: 1rem; margin: 0 0 0.75rem; }
    .legend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.35rem 1rem; }
    .legend-item { display: flex; align-items: center; gap: 0.5rem; color: var(--muted); }
    .swatch { width: 22px; height: 3px; border-radius: 2px; flex-shrink: 0; }
    .swatch.dashed { background: repeating-linear-gradient(90deg, currentColor 0 5px, transparent 5px 9px); height: 2px; }
    .no-trade {
      background: var(--card);
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin-bottom: 2rem;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .trade-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.25rem 1.5rem;
      margin-bottom: 2rem;
    }
    .trade-card header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .trade-card h2 { margin: 0; font-size: 1.15rem; }
    .badge {
      font-size: 0.8rem;
      font-weight: 700;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
    }
    .badge.win { background: rgba(34,197,94,0.15); color: #4ade80; }
    .badge.loss { background: rgba(239,68,68,0.15); color: #f87171; }
    .chart-wrap {
      background: #0a0f1a;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow: hidden;
      margin-bottom: 1rem;
    }
    .chart-svg { width: 100%; height: auto; display: block; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
    .panel h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 0.5rem; }
    .phases { margin: 0; padding-left: 1.2rem; font-size: 0.9rem; }
    .phases li { margin-bottom: 0.5rem; }
    .tag {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      margin-right: 0.35rem;
      vertical-align: middle;
    }
    .tag.crt { background: #312e81; color: #c4b5fd; }
    .tag.tbs { background: #422006; color: #fcd34d; }
    .tag.choch { background: #500724; color: #f0abfc; }
    .tag.entry { background: #0c4a6e; color: #7dd3fc; }
    table.kv { width: 100%; font-size: 0.88rem; border-collapse: collapse; }
    table.kv td { padding: 0.3rem 0; border-bottom: 1px solid var(--border); }
    table.kv td:first-child { color: var(--muted); }
    table.kv td:last-child { text-align: right; font-family: ui-monospace, monospace; }
    footer { margin-top: 2rem; font-size: 0.8rem; color: var(--muted); }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CRT + TBS — BNBUSDT Trade Study</h1>
    <p class="subtitle">15m execution · 4H CRT reference · Jun 1 – 8, 2026 · Strategy preset <code>CRT_TBS_BNB_15M</code> (LONG only)</p>

    <div class="summary">
      <div class="stat"><div class="label">Logical entries</div><div class="value">${tradeReports.length}</div></div>
      <div class="stat"><div class="label">Net PnL (2% risk sim)</div><div class="value">$${tradeReports.reduce((s, t) => s + t.netTotal, 0).toFixed(2)}</div></div>
      <div class="stat"><div class="label">Wins / Losses</div><div class="value">${tradeReports.filter((t) => t.netTotal >= 0).length} / ${tradeReports.filter((t) => t.netTotal < 0).length}</div></div>
      <div class="stat"><div class="label">Quiet days</div><div class="value">${noTradeDays.length}</div></div>
    </div>

    <div class="legend">
      <h2>Chart markings (matches app overlays)</h2>
      <div class="legend-grid">
        <div class="legend-item"><span class="swatch" style="background:#c084fc"></span> CRT High / TP2</div>
        <div class="legend-item"><span class="swatch" style="background:#a3e635"></span> EQ — TP1 partial</div>
        <div class="legend-item"><span class="swatch" style="background:#f472b6"></span> CRT Low — sweep level</div>
        <div class="legend-item"><span class="swatch" style="background:#fb7185"></span> Sweep wick — SL anchor</div>
        <div class="legend-item"><span class="swatch" style="background:#e879f9"></span> CHoCH level</div>
        <div class="legend-item"><span class="swatch" style="background:#f87171"></span> Stop loss</div>
        <div class="legend-item"><span class="swatch" style="background:#38bdf8"></span> Entry marker</div>
        <div class="legend-item"><span class="swatch" style="background:#fbbf24"></span> TBS manipulation bar</div>
        <div class="legend-item"><span style="width:22px;height:14px;background:rgba(56,189,248,0.2);border-radius:2px"></span> London killzone (07–10 UTC)</div>
        <div class="legend-item"><span style="width:22px;height:14px;background:rgba(52,211,153,0.12);border-radius:2px"></span> Discount zone (below EQ)</div>
      </div>
    </div>

    <div class="no-trade">
      <strong>No CRT+TBS entries</strong> on ${noTradeDays.join(", ")} — no valid TBS + CHoCH combo in London/NY killzone met all filters on those UTC days.
    </div>

    ${tradeSections}

    <footer>
      Generated from live BNBUSDT 15m futures candles · See <code>docs/CRT_TBS_CHART_GUIDE.md</code> for the full marking workflow.
    </footer>
  </div>
</body>
</html>`;

const outPath = path.resolve(__dirname, "../../docs/chart-studies/CRT_TBS_BNBUSDT_2026-06-01_to_08.html");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
console.log("Wrote", outPath);
