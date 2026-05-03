export const compositeScorer = {
  score(symbol, cache) {
    const signals = [];
    const bullish = [];
    const bearish = [];

    // ── Fear & Greed (contrarian) ────────────────────────────
    const fg = cache.fearGreed;
    if (fg) {
      if (fg.value <= 25) {
        bullish.push({ name: 'Extreme Fear', detail: `${fg.value}/100`, weight: 15 });
        signals.push({ score: 75, weight: 15 });
      } else if (fg.value >= 75) {
        bearish.push({ name: 'Extreme Greed', detail: `${fg.value}/100`, weight: 10 });
        signals.push({ score: 30, weight: 10 });
      } else {
        signals.push({ score: 50, weight: 5 });
      }
    }

    // ── Funding Rate ─────────────────────────────────────────
    const fund = cache.funding?.[symbol];
    if (fund) {
      if (fund.zscore > 2) {
        bearish.push({
          name:   'Extreme Funding Long',
          detail: `${(fund.current * 100).toFixed(4)}% (${fund.zscore.toFixed(1)}σ)`,
          weight: 20,
        });
        signals.push({ score: 20, weight: 20 });
      } else if (fund.zscore < -1.5) {
        bullish.push({
          name:   'Extreme Funding Short',
          detail: `${(fund.current * 100).toFixed(4)}% (${fund.zscore.toFixed(1)}σ)`,
          weight: 20,
        });
        signals.push({ score: 80, weight: 20 });
      } else {
        signals.push({ score: 50, weight: 8 });
      }
    }

    // ── Open interest (USD-M OI change + account L/S ratio, modest weights) ────────
    const oi = cache.openInterest?.[symbol];
    if (oi && typeof oi === "object") {
      const ch24 = Number(oi.change24hPct);
      const ls = Number(oi.longShortRatio);
      const hasCh = Number.isFinite(ch24);
      const hasLs = Number.isFinite(ls) && ls > 0;
      let oiStrong24h = false;
      if (hasCh && ch24 >= 12) {
        bullish.push({
          name: "OI build-up (24h)",
          detail: `+${ch24.toFixed(1)}%`,
          weight: 6,
        });
        signals.push({ score: 62, weight: 6 });
        oiStrong24h = true;
      } else if (hasCh && ch24 <= -12) {
        bearish.push({
          name: "OI flush (24h)",
          detail: `${ch24.toFixed(1)}%`,
          weight: 6,
        });
        signals.push({ score: 38, weight: 6 });
        oiStrong24h = true;
      } else if (hasCh || hasLs) {
        signals.push({ score: 50, weight: 3 });
      }
      if (!oiStrong24h && hasLs && ls >= 1.2) {
        bearish.push({
          name: "Crowded longs (OI L/S)",
          detail: ls.toFixed(2),
          weight: 6,
        });
        signals.push({ score: 38, weight: 6 });
      } else if (!oiStrong24h && hasLs && ls <= 0.83) {
        bullish.push({
          name: "Crowded shorts (OI L/S)",
          detail: ls.toFixed(2),
          weight: 6,
        });
        signals.push({ score: 62, weight: 6 });
      }
    }

    // ── Options ──────────────────────────────────────────────
    const opts = cache.options?.[symbol];
    if (opts) {
      if (opts.maxPainDistance < -3) {
        bearish.push({
          name:   'Max Pain Below',
          detail: `$${opts.maxPain.toLocaleString()} (${opts.maxPainDistance.toFixed(1)}%)`,
          weight: 15,
        });
        signals.push({ score: 30, weight: 15 });
      } else if (opts.maxPainDistance > 3) {
        bullish.push({
          name:   'Max Pain Above',
          detail: `$${opts.maxPain.toLocaleString()} (+${opts.maxPainDistance.toFixed(1)}%)`,
          weight: 15,
        });
        signals.push({ score: 70, weight: 15 });
      }
      if (opts.putCallRatio > 0.8) {
        bearish.push({ name: 'High Put/Call', detail: opts.putCallRatio.toFixed(2), weight: 10 });
        signals.push({ score: 35, weight: 10 });
      } else if (opts.putCallRatio < 0.4) {
        bullish.push({ name: 'Low Put/Call', detail: opts.putCallRatio.toFixed(2), weight: 10 });
        signals.push({ score: 65, weight: 10 });
      }
      signals.push({
        score:  opts.gexRegime === 'positive_stabilising' ? 52 : 48,
        weight: 5,
      });
    }

    // ── Timeframe Confluence ─────────────────────────────────
    const conf = cache.confluence?.[symbol];
    if (conf && conf.score !== undefined) {
      const pseudoPrimary =
        conf.primaryDir === "up" || conf.primaryDir === "down"
          ? conf.primaryDir
          : majorityTfBreakdownDir(conf.breakdown);
      if (conf.score >= 70) {
        if (pseudoPrimary === "up") {
          bullish.push({
            name: conf.primaryDir ? "TF Confluence" : "TF Confluence (majority)",
            detail: `${conf.score}% aligned bullish`,
            weight: 20,
          });
          signals.push({ score: 75, weight: 20 });
        } else if (pseudoPrimary === "down") {
          bearish.push({
            name: conf.primaryDir ? "TF Confluence" : "TF Confluence (majority)",
            detail: `${conf.score}% aligned bearish`,
            weight: 20,
          });
          signals.push({ score: 25, weight: 20 });
        } else {
          /** Strong alignment score but no directional read — damped neutral contribution */
          signals.push({ score: 52, weight: 6 });
        }
      } else if (conf.score <= 35) {
        signals.push({ score: 50, weight: 3 });
      } else {
        signals.push({ score: 50, weight: 5 });
      }
    }

    // ── Order Book Imbalance ─────────────────────────────────
    const book = cache.orderBook?.[symbol];
    if (book) {
      if (book.imbalanceRatio > 0.68) {
        bullish.push({
          name:   'Order Book Pressure',
          detail: `${(book.imbalanceRatio * 100).toFixed(0)}% bid-side`,
          weight: 8,
        });
        signals.push({ score: 68, weight: 8 });
      } else if (book.imbalanceRatio < 0.32) {
        bearish.push({
          name:   'Order Book Pressure',
          detail: `${((1 - book.imbalanceRatio) * 100).toFixed(0)}% ask-side`,
          weight: 8,
        });
        signals.push({ score: 32, weight: 8 });
      } else {
        signals.push({ score: 50, weight: 3 });
      }
    }

    // ── On-chain taker flow ──────────────────────────────────
    const oc = cache.onChain?.[symbol];
    if (oc) {
      if (oc.takerBuyRatio > 0.62) {
        bullish.push({
          name:   'Taker Buy Dominance',
          detail: `${(oc.takerBuyRatio * 100).toFixed(0)}%`,
          weight: 8,
        });
        signals.push({ score: 65, weight: 8 });
      } else if (oc.takerBuyRatio < 0.38) {
        bearish.push({
          name:   'Taker Sell Dominance',
          detail: `${((1 - oc.takerBuyRatio) * 100).toFixed(0)}%`,
          weight: 8,
        });
        signals.push({ score: 35, weight: 8 });
      } else {
        signals.push({ score: 50, weight: 3 });
      }
    }

    // ── Liquidations (Binance forceOrder, rolling 4h USD) ─────
    const liq = cache.liquidations?.[symbol];
    if (liq && liq.totalUsd > 1_000_000) {
      if (liq.dominance === 'longs' && liq.intensity !== 'low') {
        const weight =
          liq.intensity === 'extreme' ? 18 :
          liq.intensity === 'high' ? 12 : 6;
        bearish.push({
          name:   'Long Liquidation Cascade',
          detail: `$${formatMillions(liq.longUsd)} longs liquidated (4h)`,
          weight,
        });
        signals.push({
          score: liq.intensity === 'extreme' ? 20 : 30,
          weight,
        });
      } else if (liq.dominance === 'shorts' && liq.intensity !== 'low') {
        const weight =
          liq.intensity === 'extreme' ? 18 :
          liq.intensity === 'high' ? 12 : 6;
        bullish.push({
          name:   'Short Squeeze',
          detail: `$${formatMillions(liq.shortUsd)} shorts liquidated (4h)`,
          weight,
        });
        signals.push({
          score: liq.intensity === 'extreme' ? 80 : 70,
          weight,
        });
      }
    }

    // ── Whale alerts (DB snapshot, last 4h, exchange flow) ─────
    const whaleRows = cache.whaleAlerts?.[symbol];
    const recentWhales = Array.isArray(whaleRows)
      ? whaleRows.filter((w) => {
          const ts = new Date(w.alertedAt ?? w.alerted_at ?? 0).getTime();
          return Number.isFinite(ts) && Date.now() - ts < 4 * 60 * 60 * 1000;
        })
      : [];
    if (recentWhales.length > 0) {
      const inflows = recentWhales.filter((w) => String(w.direction || "") === "into_exchange");
      const outflows = recentWhales.filter((w) => String(w.direction || "") === "out_of_exchange");
      if (inflows.length > 0) {
        const totalUsd = inflows.reduce((s, w) => s + (Number(w.amountUsd) || 0), 0);
        if (totalUsd > 1_000_000) {
          bearish.push({
            name: "Whale exchange inflow",
            detail: `$${(totalUsd / 1e6).toFixed(1)}M to exchanges (4h)`,
            weight: 10,
          });
          signals.push({ score: 35, weight: 10 });
        }
      }
      if (outflows.length > 0) {
        const totalUsd = outflows.reduce((s, w) => s + (Number(w.amountUsd) || 0), 0);
        if (totalUsd > 1_000_000) {
          bullish.push({
            name: "Whale exchange outflow",
            detail: `$${(totalUsd / 1e6).toFixed(1)}M leaving exchanges (4h)`,
            weight: 10,
          });
          signals.push({ score: 65, weight: 10 });
        }
      }
    }

    // ── Economic calendar (high-impact within next 4h) ────────
    let calendarDampening = 1.0;
    const calRows = Array.isArray(cache.calendarEvents) ? cache.calendarEvents : [];
    const nowMs = Date.now();
    const imminent = calRows.filter((e) => {
      const t = new Date(e.eventTime ?? e.event_time ?? 0).getTime();
      if (!Number.isFinite(t)) return false;
      const hoursAway = (t - nowMs) / (1000 * 60 * 60);
      return hoursAway >= 0 && hoursAway <= 4;
    });
    const highImpact = imminent.filter((e) => {
      const il = String(e.impactLevel ?? e.impact_level ?? "").toLowerCase();
      return il === "high" || il === "extreme";
    });
    if (highImpact.length > 0) {
      calendarDampening = 0.5;
      bearish.push({
        name: "High-impact macro event imminent",
        detail: highImpact
          .map((e) => String(e.title || "").trim())
          .filter(Boolean)
          .join("; ")
          .slice(0, 220),
        weight: 0,
      });
    }
    cache._calendarDampening = calendarDampening;

    // ── Headline sentiment (per-asset bucket when available) ─────
    const baseKey = symbol.replace(/USDT$/i, "").replace(/BUSD$/i, "").toUpperCase();
    let ni = cache.newsImpact?.[baseKey];
    if (!ni || typeof ni.sentiment !== "number" || !Number.isFinite(ni.sentiment)) {
      ni = cache.newsImpact?.GLOBAL;
    }
    if (ni && typeof ni.sentiment === "number" && Number.isFinite(ni.sentiment)) {
      const s = ni.sentiment;
      const blurb = typeof ni.summary === "string" ? ni.summary.slice(0, 96) : "";
      const label = cache.newsImpact?.[baseKey] ? `${baseKey} news` : "News flow";
      if (s >= 0.35) {
        bullish.push({ name: label, detail: blurb || `sentiment ${s.toFixed(2)}`, weight: 8 });
        signals.push({ score: Math.round(Math.min(85, 55 + s * 28)), weight: 8 });
      } else if (s <= -0.35) {
        bearish.push({ name: label, detail: blurb || `sentiment ${s.toFixed(2)}`, weight: 8 });
        signals.push({ score: Math.round(Math.max(15, 45 + s * 28)), weight: 8 });
      } else {
        signals.push({ score: 50, weight: 3 });
      }
    }

    // ── Weighted composite ───────────────────────────────────
    const totalWeight   = signals.reduce((s, x) => s + x.weight, 0);
    const weightedScore = totalWeight > 0
      ? signals.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight
      : 50;
    const composite  = Math.round(weightedScore);
    const confidence = Math.round(Math.abs(composite - 50) * 2);
    const vol = cache.volatility?.[symbol];

    return {
      composite,
      bias:
        composite >= 65 ? 'bullish'      :
        composite >= 55 ? 'mild_bullish' :
        composite <= 35 ? 'bearish'      :
        composite <= 45 ? 'mild_bearish' : 'neutral',
      bullishSignals: bullish,
      bearishSignals: bearish,
      confidence,
      sizeMultiplier: computeSizeMultiplier(composite, conf?.score ?? 50, vol, calendarDampening),
    };
  }
};

/** Majority vote on timeframe breakdown when 15m primary direction is null (Supertrend bands neutral). */
function majorityTfBreakdownDir(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return null;
  let up = 0;
  let down = 0;
  for (const tf of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
    const d = breakdown[tf];
    if (d === "up") up++;
    else if (d === "down") down++;
  }
  if (up >= 2 && up > down) return "up";
  if (down >= 2 && down > up) return "down";
  return null;
}

/** @param {number} usd */
function formatMillions(usd) {
  if (!Number.isFinite(usd)) return '0';
  if (usd >= 1_000_000_000) return `${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(1)}M`;
  return `${(usd / 1000).toFixed(0)}K`;
}

function computeSizeMultiplier(composite, confluenceScore, vol, calendarDampening = 1.0) {
  let mult = 1.0;
  if (composite >= 70 || composite <= 30) mult = 1.5;
  if (composite >= 80 || composite <= 20) mult = 2.0;
  if (confluenceScore < 40) mult *= 0.5;
  if (vol?.combined === "high_vol_choppy") mult *= 0.25;
  if (vol?.combined === "low_vol_choppy") mult *= 0.5;
  const cal = Number(calendarDampening);
  if (Number.isFinite(cal) && cal > 0 && cal < 1) mult *= cal;
  return Math.min(2.0, Math.max(0.25, parseFloat(mult.toFixed(2))));
}
