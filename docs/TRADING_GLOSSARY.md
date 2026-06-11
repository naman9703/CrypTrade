# Trading & Crypto Glossary

> **Purpose:** Master reference for building and validating our automated crypto strategy.
> **How to use:** Search (`Cmd+F`) by term. Each entry has a **definition**, **use case**, and **notes** where helpful.
> **Companion docs:** `STRATEGY_RESEARCH_HANDOFF.md`, `strategy.md`, `AGENTS.md`
> **Last updated:** 2026-06-03

---

## Table of contents

1. [How to use this glossary](#how-to-use-this-glossary)
2. [Fundamentals of crypto trading — how the market behaves](#0-fundamentals-of-crypto-trading--how-the-market-behaves)
3. [Markets, venues & instruments](#1-markets-venues--instruments)
4. [Order flow, execution & microstructure](#2-order-flow-execution--microstructure)
5. [Derivatives & leverage](#3-derivatives--leverage)
6. [Position & account management](#4-position--account-management)
7. [Risk management](#5-risk-management)
8. [Technical analysis — indicators](#6-technical-analysis--indicators)
9. [Candlesticks & single-bar signals](#7-candlesticks--single-bar-signals)
10. [Market structure & price action](#8-market-structure--price-action)
11. [Support, resistance & zones](#9-support-resistance--zones)
12. [Liquidity & stop pools](#10-liquidity--stop-pools)
13. [ICT / SMC concepts](#11-ict--smc-concepts)
14. [Chart patterns](#12-chart-patterns)
15. [Fibonacci & measured moves](#13-fibonacci--measured-moves)
16. [Volume profile & order flow](#14-volume-profile--order-flow)
17. [Multi-timeframe analysis](#15-multi-timeframe-analysis)
18. [Entry, stop & target marking](#16-entry-stop--target-marking)
19. [Sessions & time-based analysis](#17-sessions--time-based-analysis)
20. [Regime, context & filters](#18-regime-context--filters)
21. [Strategy archetypes](#19-strategy-archetypes)
22. [Backtesting & validation](#20-backtesting--validation)
23. [Quant & statistics](#21-quant--statistics)
24. [Bot, data & infrastructure](#22-bot-data--infrastructure)
25. [On-chain, DeFi & crypto-native](#23-on-chain-defi--crypto-native)
26. [Sentiment, macro & events](#24-sentiment-macro--events)
27. [Psychology & process](#25-psychology--process)
28. [Compliance & operational safety](#26-compliance--operational-safety)
29. [Acronyms quick reference](#27-acronyms-quick-reference)
30. [Entry markup shorthand](#28-entry-markup-shorthand)
31. [Minimum professional chart markup](#29-minimum-professional-chart-markup)

---

## How to use this glossary

- **Read first:** [§0 Fundamentals](#0-fundamentals-of-crypto-trading--how-the-market-behaves) — how crypto markets behave before picking indicators.
- **Design phase:** Pick one framework (structure, ICT, indicator hybrid) and define terms *operationally* in your playbook (e.g. “FVG min size = 0.3× ATR”).
- **Coding phase:** Map terms to config keys / signal functions in `backend/src/strategy/`.
- **Validation phase:** Use §22–23 terms; never deploy on in-sample results alone.
- **Honest expectations:** High-frequency TA on 15m taker fills often fails after costs; low-frequency trend systems survive better (see `STRATEGY_RESEARCH_HANDOFF.md`).

---

## 0. Fundamentals of crypto trading — how the market behaves

> Mental model for strategy design: **behavior first, indicators second.**
> Cross-reference: §1–5 (instruments & risk), §18 (regimes), §20 (backtesting), Appendix A (repo results).

### 0.1 What you are actually trading

| Layer | What happens | Our stack |
|-------|----------------|-----------|
| **Spot** | Own/owe the asset; no product leverage by itself | Basis vs perp; some accumulation strategies |
| **Perpetuals (perps)** | Bet on price, no expiry; anchored via **funding** | **Primary** — USDT-margined CEX perps |
| **Futures** | Fixed expiry | Less common in our bots |

**Definition (trading reality):** You trade **liquidity, leverage, and positioning** as much as “fair value.” Price is where aggressive buyers and sellers meet *now*.

**Use case:** Choose perps for 24/7 API automation; model funding + mark price in risk.

**Notes:** PnL and liquidation use **mark price**, not last print.

---

### 0.2 Who moves the market (participants)

| Participant | Typical effect on price |
|-------------|-------------------------|
| Market makers / HFT | Tight spread; short-horizon mean reversion |
| Directional funds | Trends, narratives, size |
| Retail + leveraged crowd | Momentum, FOMO, **liquidation cascades** |
| Arbitrageurs | Spot–perp basis, funding, cross-venue alignment |
| Miners / treasuries | Slow supply pressure (BTC especially) |
| Macro flows (ETF, institutions) | Structural bid/offer on BTC/ETH |

**Crypto-specific behavior:**

- Retail + leverage are large → fast legs and long wicks.
- No session close → news and liquidations anytime.
- Same asset on many venues → prices align via arb; **perp premium** can diverge briefly.
- **BTC leads, alts follow** — risk-on: alts outperform; risk-off: alts often dump harder.

**Use case:** Match playbook to *who is in control* (trend funds vs chop vs panic), not only indicator values.

**Implication:** Edge is rarely a secret indicator; it is **regime + selectivity + costs**.

---

### 0.3 The 24/7 rhythm (time still matters)

The market never closes, but **liquidity and volatility are not uniform**.

| Phase (UTC-ish) | Typical behavior |
|-----------------|------------------|
| **Asia** | Range formation; sweeps of highs/lows |
| **London open** | Volatility increase; breakouts or fakeouts |
| **US (NY)** | Often largest daily moves; macro overlap |
| **Weekend** | Thinner books → wider spreads, sharper wicks on less size |

**Definition:** Session — clock window where flow and volatility differ (see §17 killzones).

**Use case:** Filter entries by session or RVOL; avoid dead hours for breakout systems.

**Notes:** 24/7 ≠ identical behavior every hour.

---

### 0.4 Three engines of price movement

#### A. Order flow (immediate)

- Aggressive **buyers** lift offer → price up.
- Aggressive **sellers** hit bid → price down.
- **Limit liquidity** at levels; when consumed → slippage and jumps.

**Chart signatures:** wicks (stop runs), displacement (one-sided aggression), absorption (volume without progress). See §14.

#### B. Leverage and liquidations (crypto amplifier)

```
Price moves against crowded side
  → thin margin
  → forced liquidations (market orders)
  → more price movement
  → cascade
```

**Definition:** Liquidation cascade — chain reaction of forced closes on mark price.

**Use case:** Expect wicks through obvious stops; place structural SL beyond pools (§10).

**Open interest (OI):** Rising OI + rising price ≈ new positions building; OI drop on a move ≈ covering/closing, not always new trend.

#### C. Funding and positioning (hours-scale pressure)

- **Positive funding** → longs pay shorts → crowded long bias.
- **Extreme funding** → squeeze or chop risk; not a precise entry timer.
- **Basis / premium** → perp vs index; mean-reversion context.

**Use case:** Context filter (avoid adding longs into extreme positive funding); not sole entry signal.

---

### 0.5 Market regimes (behavior clusters)

Price cycles through **regimes**. Strategy must declare which regimes it trades.

| Regime | Behavior | Often works | Often fails |
|--------|----------|-------------|-------------|
| **Trend up** | HH/HL, pullbacks bought | Trend follow, trail winners | Fading strength, tight MR |
| **Trend down** | LH/LL, rallies sold | Short trend / no longs | Blind buy dips |
| **Range / chop** | Bounds, fake breaks | Rare MR if few trades | Trend systems whipsawed |
| **Squeeze → expansion** | Low vol then breakout | Breakout after filter | Trading inside squeeze |
| **Panic / cascade** | Violent moves, funding spike | Stand down or cut size | Tight SL, full size |

**Repo evidence (`REGIME_RESEARCH_FINDINGS.md`):** Naive always-on 15m signals are ~random **gross**; costs make net negative. Regime router alone (`REGIME_ADAPTIVE`) still failed OOS — router must be simple and proven.

**Use case:** `regimeEngine.js` labels; playbook says **stand-down** in VOLATILE_AVOID / chop.

**Implication:** Profitable systems define **when not to trade** as much as entries.

---

### 0.6 Liquidity and levels (why charts react)

Orders cluster at **obvious** prices:

- Previous day/week high/low (PDH/PDL, PWH/PWL)
- Round numbers
- Equal highs/lows (EQH/EQL) — stop pools
- Session highs/lows
- VWAP, POC, moving averages (§9, §14)

**Typical sequence:**

1. **Sweep** liquidity (wick through level)
2. **Reverse or accelerate** (context-dependent)
3. **Retest** broken structure (S/R flip, OB, FVG — §8–11)

**Use case:** Entries at **confluence** (HTF bias + level + trigger), not isolated indicator crosses.

**Notes:** Not mysticism — visible stop density + reaction.

---

### 0.7 Costs as part of market behavior

On **15m perps with taker fills**, fees + slippage are often the main opponent:

| Cost component | Typical magnitude (order of) |
|----------------|------------------------------|
| Taker fee | ~4–5 bps/side |
| Slippage | ~5 bps/side modeled in backtests |
| Funding | Variable; hours-scale drag/credit |
| High leverage | Large notional per 1% equity risk → **fee bill scales up** |

**Definition:** Fee bleed — edge consumed by transaction costs because trade count is too high.

**Use case:** Prefer **low frequency**; realistic `costModel.js`; compare strategies with same risk normalization.

**Repo evidence:** EMA_CROSS / BREAKOUT_VOL ≈ **−95%+** on 15m compare; SUPERTREND_ELITE survives via **~1.3 trades/coin/month**.

**Implication:** Market behavior *for your bot* includes paying the exchange every round trip.

---

### 0.8 BTC vs alts (correlation structure)

```
BTC stable/up + risk-on  → alts can outperform (beta > 1)
BTC down fast            → alts often dump harder
BTC.D rising             → capital into BTC, alts weak
Illiquid alts            → slippage, gaps, manipulation
```

**Use case:** Portfolio of **majors** (BTC, ETH, BNB, LINK, XRP); HTF BTC bias for alt longs.

**Notes:** Multi-coin diversifies **trade timing**, not crash risk (correlation → 1 in panics).

---

### 0.9 Information, narratives, and speed

| Source | Speed | Role in systematic trading |
|--------|-------|----------------------------|
| Macro (rates, DXY, equities) | Hours–days | HTF risk-on/off filter |
| Crypto-native (ETF, hacks, regulation) | Minutes–days | Event stand-down |
| Narratives (sectors, memes) | Days–weeks | Symbol universe selection |
| On-chain (flows, unlocks) | Hours–days | Bias, not 15m trigger alone |

**Use case:** HTF bias before LTF entry; do not trade 15m against 4h structure (§15).

---

### 0.10 Market efficiency (realistic view)

- Crypto is **not** as efficient as mature equities — inefficiencies exist.
- It is **efficient enough** that simple public 15m TA + taker fees is mostly arbed away after costs.
- Remaining edges tend to be **lower frequency**: regime persistence, positioning stress, session effects, slow repricing.

**Use case:** Validate over **long OOS** windows; distrust one hot quarter (e.g. 2026 H1 alone).

**Honest return band (validated in repo):** ~**10–21% CAGR**, ~**1–1.5%/month**, 15–30% DD — not 50%/month systematic.

---

### 0.11 Causal stack (how layers build)

```text
                    ┌──────────────┐
                    │ Macro / news │
                    └──────┬───────┘
                           ▼
              ┌────────────────────────┐
              │ Positioning (OI, fund) │
              └────────────┬───────────┘
                           ▼
         ┌─────────────────────────────────────┐
         │ Regime: trend / range / panic       │
         └─────────────────┬───────────────────┘
                           ▼
      ┌────────────────────────────────────────────┐
      │ Liquidity levels (stops, VA, VWAP, structure)│
      └────────────────────┬───────────────────────┘
                           ▼
           ┌───────────────────────────────┐
           │ Order flow at LTF (trigger)   │
           └───────────────┬───────────────┘
                           ▼
                    YOUR ENTRY / EXIT
                           │
                           ▼
              ┌────────────────────────┐
              │ Costs + funding + slip │  ← often decides net PnL
              └────────────────────────┘
```

**Use case:** Checklist top-down when grading a setup (A/B/C).

---

### 0.12 Rules of thumb for our strategy build

1. **Define regime first** — only trade when behavior matches playbook (§18).
2. **HTF bias, LTF trigger** — no 15m entries against 4h structure (§15).
3. **Respect liquidity** — entries near levels with clear invalidation (§10, §16).
4. **Minimize trade count** — each trade pays fees (§0.7, §20).
5. **Size for volatility** — ATR expansion/contraction; `riskScale` overlay (§5, §22).
6. **Expect wicks** — structural stops beyond obvious pools.
7. **Validate over full cycles** — walk-forward + Monte Carlo gates (§20).

---

### 0.13 Empirical lessons from this repo

| Market lesson | Backtest / validation result |
|---------------|------------------------------|
| High-frequency TA bleeds on taker 15m | EMA_CROSS, BREAKOUT_VOL ≈ −95%+ |
| Low-frequency trend + trail exit survives | **SUPERTREND_ELITE** — only strategy passing all 4 OOS gates |
| Over-gating → no sample | Order-flow paths: 0–6 trades |
| Short windows mislead | 2026 H1 leaders ≠ 17mo validated edge |
| Regime router ≠ automatic edge | REGIME_ADAPTIVE negative OOS |
| Honest deploy expectation | ~10–21% CAGR, 15–30% MDD at moderate risk |

See `STRATEGY_RESEARCH_HANDOFF.md`, `strategy.md`, Appendix A below.

---

### 0.14 Playbook starting points (choose one regime to exploit)

| Playbook | Description | Repo status |
|----------|-------------|-------------|
| **Trend continuation** | HTF trend + LTF trigger + trail exit | **Validated** (`SUPERTREND_ELITE`) |
| **Range fade** | Mean reversion at range extremes | Mostly negative OOS on 15m taker |
| **Post-sweep reversal** | Liquidity sweep + structure flip | SMART_REVERSAL negative; needs strict rules |

**Next step:** Add **Appendix C — Playbook definitions** with numeric rules for chosen playbook only.

---

## 1. Markets, venues & instruments

### Exchange (CEX)
**Definition:** Centralized platform that matches orders and holds custody of funds.
**Use case:** Binance, Bybit — where we run perps bots via API.
**Notes:** Counterparty + regulatory risk.

### DEX (Decentralized exchange)
**Definition:** On-chain protocol (AMM or order book) without central custody.
**Use case:** Swaps, LP; different execution and MEV risks than CEX.
**Notes:** Slippage and gas matter more.

### Spot
**Definition:** Buy/sell actual asset delivery (no built-in leverage from product alone).
**Use case:** Accumulation, basis vs perp; some strategies only trade spot.
**Notes:** No funding; can still margin on CEX.

### Perpetual swap (perp)
**Definition:** Futures-like contract with no expiry; price anchored via funding.
**Use case:** Primary instrument for our intraday/swing systems.
**Notes:** 24/7; funding every 8h (venue-dependent).

### Linear / USDT-margined contract
**Definition:** PnL and margin in USDT; PnL scales linearly with price move.
**Use case:** Default for altcoin perps in this repo.
**Notes:** Easier risk math than inverse.

### Inverse / coin-margined contract
**Definition:** Margin and PnL in the base coin (e.g. BTC).
**Use case:** BTC-denominated books; nonlinear USD PnL.
**Notes:** Less common in our current stack.

### Trading pair / symbol
**Definition:** Base + quote instrument code (e.g. BTCUSDT).
**Use case:** Config `symbol`, DB candle keys, backtest scope.
**Notes:** Portfolio = multiple symbols.

### Tick size / lot size / min notional
**Definition:** Minimum price step, quantity step, and order value allowed.
**Use case:** Round entries/stops; avoid rejected orders in live bot.
**Notes:** Varies per symbol on exchange.

### Liquidity
**Definition:** How easily size can trade without moving price.
**Use case:** Prefer BTC/ETH for size; avoid illiquid alts for large notionals.
**Notes:** Measured via depth, spread, slippage.

### Spread
**Definition:** Ask − bid; cost to cross the book immediately.
**Use case:** Widen in stress → reduce size or stand down.
**Notes:** Part of realistic backtest cost model.

### Slippage
**Definition:** Difference between expected fill price and actual fill.
**Use case:** Model ~5 bps/side in backtests for taker entries.
**Notes:** Dominates high-frequency strategies.

### Market impact
**Definition:** Price movement caused by your own order size.
**Use case:** Caps max position; explains why huge size erodes edge.
**Notes:** Grows with notional vs book depth.

### Correlation / beta
**Definition:** How an asset moves relative to another (often BTC).
**Use case:** Portfolio diversification; alt strategies need BTC regime filter.
**Notes:** Correlation rises in risk-off dumps.

### BTC dominance (BTC.D)
**Definition:** BTC market cap as % of total crypto cap.
**Use case:** Risk-on alts when falling; flight to BTC when rising.
**Notes:** Macro context filter, not entry trigger alone.

---

## 2. Order flow, execution & microstructure

### Market order
**Definition:** Execute immediately at best available price (taker).
**Use case:** Urgent exit; entry when signal is time-critical.
**Notes:** Pays taker fee; suffers spread + slippage.

### Limit order
**Definition:** Execute only at specified price or better.
**Use case:** Maker entries to reduce fees; passive fills at levels.
**Notes:** May not fill; adverse selection if level is “obvious.”

### Stop order / stop-market
**Definition:** Triggers market order when price hits stop price.
**Use case:** Protective stop-loss; breakout stop-entry.
**Notes:** Slippage on gap through level.

### Stop-limit
**Definition:** At stop trigger, places limit order instead of market.
**Use case:** Control exit price; risk non-fill in fast markets.
**Notes:** Dangerous in crashes if limit not hit.

### Take-profit (TP)
**Definition:** Order to close winner at target price.
**Use case:** Fixed RR systems; partial scale-out levels.
**Notes:** Our validated Supertrend system uses trail instead of fixed TP.

### Stop-loss (SL)
**Definition:** Order to close loser at max acceptable loss.
**Use case:** Every trade must have defined SL before entry.
**Notes:** Structural SL preferred over arbitrary %.

### Trailing stop
**Definition:** Stop price moves in favor as trade profits.
**Use case:** Let winners run (Supertrend trail in SUPERTREND_ELITE).
**Notes:** Better for trends than fixed TP.

### OCO (one-cancels-other)
**Definition:** Two linked orders; fill of one cancels the other.
**Use case:** TP + SL bracket after entry.
**Notes:** Standard on most CEX APIs.

### Post-only
**Definition:** Limit order that only adds liquidity; rejects if would take.
**Use case:** Guarantee maker fee tier.
**Notes:** No fill if price runs away.

### Reduce-only
**Definition:** Order can only decrease position size, not flip side.
**Use case:** Safe exits; prevent accidental reverse on close order.
**Notes:** Always use for exit bots.

### Maker / taker
**Definition:** Maker adds liquidity; taker removes it.
**Use case:** Fee optimization; backtest assumes taker unless modeled otherwise.
**Notes:** Taker ~4–5 bps/side typical on Binance futures.

### Funding payment window
**Definition:** Scheduled times when perp funding is exchanged.
**Use case:** Avoid holding adverse funding into payment if scalping.
**Notes:** 8h intervals on Binance.

### Order book / depth
**Definition:** Visible limit orders at price levels.
**Use case:** Estimate slippage; spot absorption at levels.
**Notes:** L2 data for advanced microstructure.

### Bid / ask / mid
**Definition:** Best buy price, best sell price, average of both.
**Use case:** Mid for fair value; cross spread to trade.
**Notes:** Mark vs last price on perps.

### Adverse selection
**Definition:** Filled on limit because price is about to move against you.
**Use case:** Why “obvious” support limits get run over.
**Notes:** Informed flow vs passive quotes.

### MEV (maximal extractable value)
**Definition:** Profit from reordering/inserting on-chain txs (DEX context).
**Use case:** Sandwich risk on DEX swaps; less on CEX API trading.
**Notes:** Separate from CEX latency arb.

---

## 3. Derivatives & leverage

### Funding rate
**Definition:** Periodic payment between longs and shorts to peg perp to spot/index.
**Use case:** Filter extreme funding (crowded side); funding arb strategies.
**Notes:** Positive funding = longs pay shorts.

### Index price / mark price
**Definition:** Index = spot composite; mark = fair value for liquidations/PNL.
**Use case:** Don't trade off stale last print; use mark for risk.
**Notes:** Liquidations use mark, not last.

### Basis / premium
**Definition:** Perp price minus index (or spot).
**Use case:** Basis trade, sentiment gauge.
**Notes:** Extreme premium often mean-reverts.

### Open interest (OI)
**Definition:** Total open contracts not yet closed.
**Use case:** Rising OI + price up = new longs; divergence analysis.
**Notes:** OI drop on move = short covering or long liquidation.

### Long/short ratio
**Definition:** Ratio of accounts or size on long vs short side.
**Use case:** Contrarian filter at extremes.
**Notes:** Exchange-specific methodology.

### Leverage
**Definition:** Multiplier on exposure vs margin posted.
**Use case:** 5–25× in our backtests; magnifies PnL and liquidation risk.
**Notes:** High leverage + tight stop = large notional → fee drag.

### Notional
**Definition:** Total position value (size × price).
**Use case:** Fee and slippage scale with notional, not just margin.
**Notes:** Risk-at-SL sizing ties notional to stop distance.

### Initial / maintenance margin
**Definition:** Collateral to open vs minimum to keep position open.
**Use case:** Position sizing caps; liquidation buffer.
**Notes:** Cross vs isolated margin modes differ.

### Liquidation
**Definition:** Forced close when margin insufficient vs mark price.
**Use case:** Must engineer stops well before liquidation price.
**Notes:** Cascade liquidations move price (crypto vol events).

### ADL (auto-deleverage)
**Definition:** Exchange closes profitable counterparty positions in extreme events.
**Use case:** Tail risk on profitable shorts in squeezes.
**Notes:** Rare but real on CEX perps.

---

## 4. Position & account management

### Long / short / flat
**Definition:** Bullish exposure, bearish exposure, no position.
**Use case:** Strategy bias and position state machine in bot.
**Notes:** Flat is a deliberate state — not “missing out.”

### Entry / exit
**Definition:** Open or close (full or partial) a position.
**Use case:** Signal module vs execution module separation.
**Notes:** Scale-in/out = multiple entries/exits.

### Scale-in / scale-out
**Definition:** Multiple partial entries or exits at different prices.
**Use case:** Reduce timing risk; take partial at 1R, runner for 3R.
**Notes:** Complicates R-multiple accounting.

### Hedge / delta-neutral
**Definition:** Offset directional risk with opposite or correlated instrument.
**Use case:** Basis arb, spot vs perp hedge.
**Notes:** Not our primary deploy mode today.

### Realized / unrealized PnL
**Definition:** Closed profit/loss vs mark-to-market on open position.
**Use case:** Risk dashboards; kill switch on realized daily loss.
**Notes:** Unrealized can vanish on reversal.

### R-multiple
**Definition:** Profit or loss expressed in units of initial risk (1R = distance to SL).
**Use case:** Compare trades fairly; expectancy in R.
**Notes:** Breakeven trail must use *initial* R (fixed in our `metrics.js`).

### Expectancy
**Definition:** Average outcome per trade: (win% × avg win) − (loss% × avg loss).
**Use case:** Must be positive after costs for viable system.
**Notes:** Often expressed in R or %.

### Win rate / profit factor (PF)
**Definition:** % winning trades; gross profit ÷ gross loss.
**Use case:** PF > 1 necessary but not sufficient; low WR OK if payoff high.
**Notes:** High WR + low RR can still lose after fees.

### Risk per trade
**Definition:** % or $ of equity willing to lose if SL hit.
**Use case:** 1–2% conservative; 10% in aggressive backtests in repo docs.
**Notes:** `RISK_AT_SL` sizing in backtest engine.

### Volatility targeting
**Definition:** Adjust position size inversely to current volatility (e.g. ATR).
**Use case:** Equalize risk across regimes; `riskScale` overlay in runner.
**Notes:** Reduces size in chaos.

### Equity / available margin
**Definition:** Account value; margin free for new positions.
**Use case:** Compounding portfolio backtests; live risk caps.
**Notes:** Shared account across multi-coin portfolio.

---

## 5. Risk management

### Max drawdown (MDD)
**Definition:** Largest peak-to-trough equity decline.
**Use case:** Acceptance gate; realistic 15–30% for trend systems at moderate risk.
**Notes:** Calmar = CAGR / MDD.

### Kill switch
**Definition:** Halt all new trades when DD or loss threshold breached.
**Use case:** `riskKillSwitchDdPct` in bot overlay.
**Notes:** Must be wired in live execution.

### Cooldown
**Definition:** Mandatory pause after N consecutive losses or daily loss.
**Use case:** `riskConsecutiveLossLimit` — prevents revenge spirals.
**Notes:** Behavioral + mathematical benefit.

### Sharpe / Sortino / Calmar
**Definition:** Return per volatility; return per downside vol; return per MDD.
**Use case:** Compare strategies; Calmar > 1 used as acceptance gate.
**Notes:** Sharpe inflates with short samples.

### VaR / CVaR
**Definition:** Value at risk; expected shortfall beyond VaR threshold.
**Use case:** Tail risk reporting for portfolio.
**Notes:** Less common in retail bot docs.

### Breakeven stop (BE)
**Definition:** Move SL to entry after price moves favorably.
**Use case:** Protect winners; can cap upside if too early.
**Notes:** Distorts R stats if initial risk not stored.

### Time stop
**Definition:** Exit if trade hasn't worked within N bars.
**Use case:** Scalps; avoid dead capital in chop.
**Notes:** Reduces fee bleed in range markets.

### Portfolio heat
**Definition:** Sum of risk across open positions as % equity.
**Use case:** Cap total simultaneous risk (multi-coin portfolio).
**Notes:** Critical when running 5+ symbols.

### Concentration limit
**Definition:** Max exposure to one asset or correlated basket.
**Use case:** Prevent all alts moving together from wiping account.
**Notes:** BTC correlation spike in crashes.

---

## 6. Technical analysis — indicators

### OHLCV
**Definition:** Open, high, low, close, volume per bar.
**Use case:** Core candle input for all backtests in DB.
**Notes:** Align bar close times to UTC.

### Timeframe (TF)
**Definition:** Bar duration (1m, 5m, 15m, 1h, 4h, 1d).
**Use case:** Signal TF vs filter TF (MTF).
**Notes:** Our validated edge mostly 15m + 1h/4h filters.

### EMA / SMA
**Definition:** Exponential or simple moving average of close.
**Use case:** Trend filter (EMA21/50 on 1H); crossover systems (weak alone).
**Notes:** EMA reacts faster than SMA.

### VWAP
**Definition:** Volume-weighted average price for session or anchor.
**Use case:** Intraday fair value; reclaim/lost as bias shift.
**Notes:** Session VWAP resets; anchored for swing levels.

### Supertrend
**Definition:** ATR-based trailing trend line; flips on cross.
**Use case:** SUPERTREND_ELITE entries and trailing exit.
**Notes:** Period 10, mult 3.0 in deploy config.

### ADX / +DI / −DI
**Definition:** Trend strength; directional movement components.
**Use case:** Gate entries ADX ≥ 20 rising; avoid chop when ADX low.
**Notes:** ADX does not show direction alone.

### RSI
**Definition:** Relative strength index (0–100) momentum oscillator.
**Use case:** Overbought/oversold, divergence; HTF_RSI strategy (failed OOS).
**Notes:** Mean reversion weak on 15m crypto taker.

### MACD
**Definition:** Difference of EMAs + signal line + histogram.
**Use case:** Momentum confirmation in confluence scores.
**Notes:** Lagging; poor alone after fees.

### ATR
**Definition:** Average true range — volatility measure.
**Use case:** Stop distance, position sizing, ATR expansion gate.
**Notes:** `eliteStRequireAtrExpansion` in Elite config.

### Bollinger Bands
**Definition:** MA ± k standard deviations.
**Use case:** Mean reversion fades, squeeze breakout setups.
**Notes:** Squeeze = low vol before expansion.

### Donchian channel
**Definition:** Highest high / lowest low over N bars.
**Use case:** Breakout systems; regime research baseline.
**Notes:** Gross-positive only in some trend windows.

### Keltner channel
**Definition:** EMA ± ATR multiple.
**Use case:** Trend channel; alternative to Bollinger.
**Notes:** Less common in our codebase.

### Ichimoku
**Definition:** Cloud (Kumo) system with multiple lines.
**Use case:** HTF trend filter in some discretionary systems.
**Notes:** Not core to current validated strategy.

### Parabolic SAR
**Definition:** Trailing stop dots above/below price.
**Use case:** Alternative trailing exit.
**Notes:** Whipsaws in ranges.

### Stochastic / CCI / MFI / ROC
**Definition:** Various momentum/flow oscillators.
**Use case:** Secondary confirmation in confluence strategies.
**Notes:** Redundant if stacked without independence.

### Choppiness index
**Definition:** High values = sideways chop.
**Use case:** Stand-down filter.
**Notes:** Complements ADX.

---

## 7. Candlesticks & single-bar signals

### Body / wick (shadow)
**Definition:** Open-close range vs thin extremes beyond body.
**Use case:** Rejection wicks signal absorption at level.
**Notes:** Body-to-range ratio quantifies conviction.

### Marubozu
**Definition:** Full body, little wick — strong directional conviction.
**Use case:** Impulse confirmation after breakout.
**Notes:** Displacement candle in SMC.

### Hammer / shooting star / pin bar
**Definition:** Long wick one side, small body — rejection at extreme.
**Use case:** Entry trigger at OB or liquidity sweep low/high.
**Notes:** Must define min wick ratio for automation.

### Doji / spinning top
**Definition:** Open ≈ close; indecision.
**Use case:** Pause before break; not standalone entry.
**Notes:** Context at level matters.

### Engulfing
**Definition:** Body fully engulfs prior body opposite color.
**Use case:** Reversal confirmation at support/resistance.
**Notes:** Rule-based detection in PA bots.

### Inside bar (IB)
**Definition:** High-low range inside previous bar.
**Use case:** Compression; breakout of mother bar range.
**Notes:** Classic Nick Radge pattern.

### Outside bar
**Definition:** Range engulfs previous bar (wider high and low).
**Use case:** Volatility expansion signal.
**Notes:** Not same as “order block.”

### Morning / evening star
**Definition:** Three-bar reversal patterns.
**Use case:** Discretionary grading; rarely auto-traded alone.
**Notes:** Low frequency on crypto 24/7.

### Impulse / displacement / exhaustion candle
**Definition:** Large trend bar; violent move; climax bar.
**Use case:** Displacement after sweep confirms institutional move in SMC.
**Notes:** Size threshold often vs ATR.

---

## 8. Market structure & price action

### Swing high / swing low
**Definition:** Local extremum pivot on N bars left/right.
**Use case:** Define structure, SL placement, trendlines.
**Notes:** Fractal parameter affects sensitivity.

### Higher high (HH) / higher low (HL)
**Definition:** Uptrend structural sequence.
**Use case:** Long-only bias when HH+HL intact.
**Notes:** Break of HL → caution.

### Lower high (LH) / lower low (LL)
**Definition:** Downtrend structural sequence.
**Use case:** Short bias or stand down longs.
**Notes:** Mirror of HH/HL.

### Break of structure (BOS)
**Definition:** Price breaks prior swing in trend direction (continuation).
**Use case:** Trend following entry on retest of broken level.
**Notes:** Must define swing lookback for code.

### Change of character (CHoCH)
**Definition:** First break against prevailing trend structure.
**Use case:** Early reversal warning; SMC entry after sweep + CHoCH.
**Notes:** Subjective sensitivity; codify swings.

### Market structure shift (MSS)
**Definition:** Synonym cluster with CHoCH for trend change.
**Use case:** Label on chart for bias flip.
**Notes:** Align team definitions.

### Range / consolidation / chop
**Definition:** Price oscillates between bounds without trend.
**Use case:** Stand down trend systems; enable mean reversion only if validated.
**Notes:** ADX low, choppiness high.

### Impulse leg / corrective leg
**Definition:** Strong move with trend vs pullback against it.
**Use case:** Enter on corrective leg end in trend direction.
**Notes:** Fib retracement on impulse leg.

### No-man's land
**Definition:** Middle of range far from edge or level.
**Use case:** Avoid entries — poor RR and unclear invalidation.
**Notes:** Professional filter.

---

## 9. Support, resistance & zones

### Support (S) / resistance (R)
**Definition:** Price level where buying/selling repeatedly emerged.
**Use case:** Horizontal lines for entries, SL, TP.
**Notes:** Zones > single line on crypto.

### Supply / demand zone
**Definition:** Area where aggressive sell/buy originated (price reacted away fast).
**Use case:** OB-like zones in classical PA.
**Notes:** Overlap with order blocks in SMC.

### S/R flip
**Definition:** Broken resistance becomes support (or vice versa).
**Use case:** Retest entries after breakout.
**Notes:** High-quality confluence.

### Trendline
**Definition:** Line connecting swing lows (uptrend) or highs (downtrend).
**Use case:** Break-and-retest entries; channel bounds.
**Notes:** Subjective; algorithm uses pivots.

### Dynamic support
**Definition:** Moving level (EMA, VWAP, Supertrend).
**Use case:** Pullback entries in trend.
**Notes:** 1H EMA21/50 in Elite gate.

### Confluence zone
**Definition:** Multiple independent levels overlap (Fib + S/R + VWAP).
**Use case:** A-grade setup grading.
**Notes:** Score or require N of M aligns.

### Retest / rejection
**Definition:** Price returns to level; holds (reject) or fails.
**Use case:** Confirmation entry vs blind limit at level.
**Notes:** Close confirmation reduces fake breaks.

---

## 10. Liquidity & stop pools

### Buy-side liquidity (BSL) / sell-side liquidity (SSL)
**Definition:** Stops and orders above highs (BSL) or below lows (SSL).
**Use case:** Target for move; sweep then reversal setup.
**Notes:** “Liquidity” in SMC ≠ order book depth alone.

### Liquidity sweep / stop hunt / stop run
**Definition:** Wick through level to trigger stops then reverse.
**Use case:** SMART_REVERSAL style fades (failed OOS in repo).
**Notes:** Needs clear sweep definition for code.

### Equal highs (EQH) / equal lows (EQL)
**Definition:** Two+ similar highs/lows — obvious stop cluster.
**Use case:** Turtle soup; liquidity pool target.
**Notes:** Tolerance in ticks for “equal.”

### PDH / PDL (previous day high/low)
**Definition:** Prior session extremes.
**Use case:** Intraday targets and sweep levels.
**Notes:** Standard session markup.

### PWH / PWL
**Definition:** Previous week high/low.
**Use case:** Swing HTF liquidity targets.
**Notes:** Stronger than PDH for 15m swings.

### Draw on liquidity
**Definition:** Theory that price moves toward resting stops.
**Use case:** Narrative for target placement beyond entry.
**Notes:** Not always provable; use as hypothesis.

### Inducement (Ind)
**Definition:** Minor swing designed to trap early entrants before real move.
**Use case:** Filter bad entries before true BOS.
**Notes:** Advanced SMC; hard to automate.

---

## 11. ICT / SMC concepts

### Order block (OB)
**Definition:** Last opposing candle before impulsive move away (institutional footprint).
**Use case:** Limit entry zone on retest; SL beyond OB.
**Notes:** Subjective; define via last down-close before rally (bull OB).

### Breaker block (BB)
**Definition:** Failed OB that flips role after structure break.
**Use case:** Retest entry in new trend.
**Notes:** Second-chance entry model.

### Mitigation block (MB)
**Definition:** Zone where unfilled orders are “mitigated” on retest.
**Use case:** Partial fill exit target.
**Notes:** Terminology varies by educator.

### Fair value gap (FVG)
**Definition:** Three-candle imbalance: gap between wick of candle 1 and wick of candle 3.
**Use case:** Entry on 50% CE (consequent encroachment) of gap.
**Notes:** Min gap size filter for crypto noise.

### BISI / SIBI
**Definition:** Bullish / bearish imbalance (FVG direction labels).
**Use case:** Tag gap direction for entry rules.
**Notes:** ICT naming.

### Premium / discount
**Definition:** Upper/lower half of dealing range (expensive vs cheap).
**Use case:** Long only in discount, short only in premium.
**Notes:** Requires defined range anchors.

### Equilibrium (EQ)
**Definition:** 50% of defined range.
**Use case:** Mean reversion target; OTE zone anchor.
**Notes:** Not same as VWAP equilibrium.

### OTE (optimal trade entry)
**Definition:** Typically 62–79% Fib retracement in impulse leg.
**Use case:** Pullback entry in trend.
**Notes:** Pair with HTF bias.

### Killzone (KZ)
**Definition:** Time window of elevated volatility (London/NY open).
**Use case:** `sessionKillzones.js` — only trade setups in KZ.
**Notes:** UTC alignment critical.

### Power of three (AMD)
**Definition:** Accumulation, manipulation, distribution narrative.
**Use case:** Session framing; not sole signal.
**Notes:** Discretionary overlay.

### Judas swing
**Definition:** False move at session open before real direction.
**Use case:** Fade early move if aligns with liquidity sweep model.
**Notes:** High false positive rate if automated naively.

### SMT divergence
**Definition:** Correlated asset fails to confirm (e.g. ES vs NQ; ETH vs BTC).
**Use case:** Weakness filter for entries.
**Notes:** Pair selection matters.

### Displacement
**Definition:** Strong impulsive move away from level post-sweep.
**Use case:** Confirms CHoCH valid; enter on pullback to FVG.
**Notes:** ATR multiple threshold.

---

## 12. Chart patterns

### Flag / pennant
**Definition:** Brief consolidation after impulse; continuation pattern.
**Use case:** Breakout entry in trend direction.
**Notes:** Measure pole height for target.

### Triangle (ascending / descending / symmetrical)
**Definition:** Converging trendlines; breakout expected.
**Use case:** Breakout with volume confirmation.
**Notes:** Symmetrical = indecision.

### Head and shoulders (H&S)
**Definition:** Three peaks; middle highest; neckline break confirms.
**Use case:** Reversal short; inverse for long.
**Notes:** Sloping neckline complicates automation.

### Double top / bottom
**Definition:** Two tests of similar level; reversal.
**Use case:** EQH/EQL liquidity narrative.
**Notes:** Confirmation on neckline break.

### False breakout / fakeout
**Definition:** Break level then close back inside range.
**Use case:** Fade with tight stop; liquidity sweep model.
**Notes:** High fee if whipsawed repeatedly.

### Wyckoff accumulation / distribution
**Definition:** Composite operator phases marking range before trend.
**Use case:** Context for spring/upthrust.
**Notes:** Long horizon; hard on 15m alone.

### Spring / upthrust
**Definition:** False breakdown below support (spring) or false breakout above (upthrust).
**Use case:** Reversal long/short in Wyckoff ranges.
**Notes:** Similar to liquidity sweep.

---

## 13. Fibonacci & measured moves

### Retracement
**Definition:** Horizontal levels at 38.2%, 50%, 61.8% of impulse leg.
**Use case:** Pullback entry zone; OTE overlap.
**Notes:** Swing high/low definition must be consistent.

### Extension
**Definition:** Targets beyond 100% (127.2%, 161.8%).
**Use case:** TP placement.
**Notes:** Multiple valid swings — pick HTF leg.

### Golden pocket (GP)
**Definition:** Zone ~61.8–65% retracement.
**Use case:** High confluence pullback entry.
**Notes:** `intradayFibContext` in repo.

### Fib cluster / confluence
**Definition:** Multiple Fib levels from different swings align.
**Use case:** A-grade zone.
**Notes:** Automation: min cluster width.

### AB=CD
**Definition:** Harmonic measured move equality.
**Use case:** TP projection.
**Notes:** Less validated in our backtests.

### Measured move
**Definition:** Project equal leg length from breakout.
**Use case:** TP1/TP2 price targets.
**Notes:** 1:1 from range height common.

---

## 14. Volume profile & order flow

### Volume
**Definition:** Contracts/coins traded per bar.
**Use case:** Spike filter ≥1.5× avg in SUPERTREND_ELITE.
**Notes:** Use same units as exchange.

### Relative volume (RVOL)
**Definition:** Current volume vs average for that bar slot.
**Use case:** Confirm breakouts; filter dead sessions.
**Notes:** Time-of-day seasonality on crypto.

### Volume profile (VP)
**Definition:** Histogram of volume at price levels over period.
**Use case:** POC, VAH, VAL structure trades (`volumeProfileStrategy.js`).
**Notes:** Computationally heavy per bar in backtest.

### POC (point of control)
**Definition:** Price with highest traded volume in profile.
**Use case:** Magnet price; support/resistance.
**Notes:** Developing POC moves intraday.

### Value area (VA) / VAH / VAL
**Definition:** Range containing ~70% of volume; its high and low.
**Use case:** Fade extremes back to POC; break VA for trend.
**Notes:** Parameter: value area %.

### HVN / LVN
**Definition:** High / low volume node.
**Use case:** HVN = support; LVN = price moves fast through (gap).
**Notes:** LVN targets for runners.

### Delta
**Definition:** Buy volume minus sell volume (approx or from taker side).
**Use case:** Confirm direction at level; divergence warning.
**Notes:** Needs `taker_buy_volume` in DB (backfilled BTC/ETH 15m).

### CVD (cumulative volume delta)
**Definition:** Running sum of delta.
**Use case:** Trend of aggressive participation; divergence vs price.
**Notes:** `orderFlow.js` in repo.

### Absorption
**Definition:** High volume without price progress — passive side absorbing.
**Use case:** Reversal at level when delta flat but volume high.
**Notes:** Key order-flow pattern.

### Footprint chart
**Definition:** Per-price bid/ask volume within candle.
**Use case:** Discretionary microstructure; hard to backtest without tick data.
**Notes:** Future enhancement if we ingest ticks.

### Taker buy / sell volume
**Definition:** Aggressor side volume from exchange kline field.
**Use case:** Real order-flow vs OHLC proxy.
**Notes:** Migration `029_ohlcv_taker_buy_volume.sql`.

### Imbalance (footprint)
**Definition:** Diagonal bid/ask ratio extreme at price level.
**Use case:** Scalp entries; stacked imbalances as levels.
**Notes:** Different from FVG “imbalance.”

---

## 15. Multi-timeframe analysis

### HTF / LTF
**Definition:** Higher timeframe (bias) vs lower timeframe (entry).
**Use case:** 4h/1h filter + 15m entry standard in repo.
**Notes:** Top-down analysis mandatory.

### Bias / alignment
**Definition:** Directional permission from HTF (long-only, short-only, neutral).
**Use case:** Gate all counter-trend entries.
**Notes:** `eliteStRequireHtf1hEmaAlign` etc.

### Conflict
**Definition:** HTF and LTF disagree.
**Use case:** No trade or reduced size.
**Notes:** Reduces whipsaw.

### Fractal alignment
**Definition:** Structure trend same on multiple TFs.
**Use case:** A+ confluence.
**Notes:** Not Elliott “fractal” unless specified.

---

## 16. Entry, stop & target marking

### Breakout entry
**Definition:** Enter when price breaks key level.
**Use case:** Donchian, range break — verify cost impact (often over-trades).
**Notes:** Wait for close confirmation.

### Pullback entry
**Definition:** Enter on retest after break in trend direction.
**Use case:** Trend pullback strategy (`trendPullback.js`).
**Notes:** Failed OOS in repo at 15m.

### Retest entry
**Definition:** Price returns to broken level then holds.
**Use case:** OB, FVG CE, S/R flip.
**Notes:** Limit order at zone.

### Stop entry (buy-stop / sell-stop)
**Definition:** Order triggers when price reaches level (breakout side).
**Use case:** Enter on momentum through level.
**Notes:** Becomes market order — taker fees.

### Close confirmation
**Definition:** Require candle close beyond level, not just wick.
**Use case:** Filter false breakouts.
**Notes:** One-bar vs two-bar rule.

### Invalidation
**Definition:** Price level or condition that voids setup thesis.
**Use case:** SL placement reference; no-trade if hit pre-entry.
**Notes:** Must be single unambiguous rule.

### Structural stop
**Definition:** SL beyond swing, OB, or range extreme.
**Use case:** Preferred over fixed % — respects market structure.
**Notes:** Defines R for sizing.

### ATR stop
**Definition:** SL at k × ATR from entry.
**Use case:** Volatility-normalized risk.
**Notes:** k tuned per TF and symbol.

### Breakeven (BE)
**Definition:** SL moved to entry after +1R or trigger.
**Use case:** Free risk; may exit winners early.
**Notes:** Document in journal.

### Partial TP / runner
**Definition:** Close fraction at TP1; leave rest for trail.
**Use case:** Balance certainty vs upside.
**Notes:** Regime adaptive used partials — still rejected OOS.

### 1R / 2R / 3R
**Definition:** Target multiples of initial risk.
**Use case:** Minimum 2R required in many playbooks.
**Notes:** RR tool on chart.

### Risk-reward (RR)
**Definition:** Potential profit ÷ potential loss.
**Use case:** Skip trades RR < 2 before costs.
**Notes:** Costs reduce effective RR.

### Trailing TP / exit on flip
**Definition:** No fixed TP; exit when trail hit or indicator flips.
**Use case:** SUPERTREND_ELITE exit — key to validation.
**Notes:** Better than fixed TP in trends.

### Setup grade (A / B / C)
**Definition:** Quality tier from confluence count.
**Use case:** Only trade A/B; C is watchlist.
**Notes:** `regimeAdaptive` grade gates.

---

## 17. Sessions & time-based analysis

### Asian / London / New York session
**Definition:** Geographic trading windows (UTC-defined).
**Use case:** Session boxes, volatility expectations.
**Notes:** Crypto trades 24/7 but flows follow sessions.

### Session high / low
**Definition:** Extreme price during named session.
**Use case:** Liquidity targets; breakout of Asian range.
**Notes:** `sessionKillzones.js`, `ictSessions` frontend lib.

### Killzone
**Definition:** High-probability time window (ICT).
**Use case:** Restrict entries to KZ only.
**Notes:** Over-filtering → zero trades (order-flow issue).

### Opening range (OR)
**Definition:** High/low of first N minutes of session.
**Use case:** Breakout systems intraday.
**Notes:** N parameter matters.

### Daily / weekly / monthly open
**Definition:** Open price of calendar period.
**Use case:** Bias above/below open; equilibrium references.
**Notes:** Mark on chart for context.

### Inside day / outside day
**Definition:** Range inside prior day / engulfs prior day range.
**Use case:** Compression vs expansion day tags.
**Notes:** Regime context filter.

---

## 18. Regime, context & filters

### Trending / ranging / chop
**Definition:** Market behavior classification.
**Use case:** Router picks playbook (`regimeEngine.js`).
**Notes:** REGIME_ADAPTIVE rejected — router must be proven.

### Risk-on / risk-off
**Definition:** Appetite for risky assets vs safety.
**Use case:** Reduce alt exposure when off; BTC safe haven flows.
**Notes:** Macro filter.

### Volatility expansion / contraction
**Definition:** ATR rising vs falling.
**Use case:** Elite requires expansion; stand down in squeeze.
**Notes:** Bollinger squeeze precursor.

### Stand-down mode
**Definition:** Strategy intentionally flat — no new trades.
**Use case:** VOLATILE_AVOID, chop, news, kill switch.
**Notes:** Professional capital preservation.

### No-trade zone
**Definition:** Conditions where playbook is disabled.
**Use case:** Document in playbook; enforce in bot.
**Notes:** Different from flat market.

### Confluence / score / veto
**Definition:** Multiple signals align; numeric strength; hard block rule.
**Use case:** `intradayLearnedRules`, confluence strategy.
**Notes:** Too many vetoes → no trades.

### Funding extreme filter
**Definition:** Skip longs when funding very positive (crowded longs).
**Use case:** Avoid paying funding into overheated long.
**Notes:** Context not entry.

### ADX chop filter
**Definition:** ADX below threshold → no trend trades.
**Use case:** Prevent losses in range.
**Notes:** Standard gate.

---

## 19. Strategy archetypes

### Trend following
**Definition:** Trade in direction of established trend; let winners run.
**Use case:** SUPERTREND_ELITE — only validated OOS approach in repo.
**Notes:** Low frequency survives fees.

### Mean reversion
**Definition:** Fade extremes expecting return to mean.
**Use case:** RSI, BB fade — mostly negative OOS on 15m taker.
**Notes:** Best gross near breakeven in regime research; costs kill.

### Breakout
**Definition:** Enter on new high/low or range break.
**Use case:** BREAKOUT_VOL — catastrophic fee bleed in compare script.
**Notes:** Needs few trades + wide targets.

### Scalping
**Definition:** Many small profits; short hold time.
**Use case:** Requires maker fees or very tight edge — rarely works taker 15m.
**Notes:** Do not pursue for our bot without infra change.

### Swing trading
**Definition:** Holds days to weeks.
**Use case:** Lower frequency on 1h/4h; aligns with Elite philosophy.
**Notes:** Match backtest window length to hold time.

### Market making / arb
**Definition:** Capture spread or price differences; low directional risk.
**Use case:** Separate from directional bot; needs different infra.
**Notes:** Not in current repo deploy path.

### Regime-switching / meta-strategy
**Definition:** Different playbooks per regime (AUTO mode).
**Use case:** REGIME_ADAPTIVE — rejected; caution on complexity.
**Notes:** Adds parameters → overfit risk.

### Ensemble / confluence
**Definition:** Combine multiple strategies or indicators.
**Use case:** ENSEMBLE, CONFLUENCE — deep negative in compare.
**Notes:** Stacks weak edges.

---

## 20. Backtesting & validation

### Backtest
**Definition:** Simulate strategy on historical data.
**Use case:** All `backend/scripts/backtest-*.mjs` tools.
**Notes:** Garbage in = garbage out (data quality, costs).

### In-sample (IS) / out-of-sample (OOS)
**Definition:** Train/tune period vs unseen holdout period.
**Use case:** Never deploy on IS alone.
**Notes:** OOS must be positive after costs.

### Walk-forward (WF)
**Definition:** Rolling train/test windows through time.
**Use case:** `backtest-validate-supertrend.mjs` — degradation < 35% gate.
**Notes:** Purged WF avoids label leakage.

### Purge / embargo
**Definition:** Remove training samples near test window to prevent overlap leakage.
**Use case:** Proper validation for overlapping bars.
**Notes:** Standard in Lopez de Prado framework.

### Monte Carlo (MC)
**Definition:** Shuffle trade order or returns to distribution of outcomes.
**Use case:** p5 > 0 gate — worst 5% path still profitable.
**Notes:** `backtest-validate-mc.mjs`.

### Acceptance gates
**Definition:** Pass/fail criteria before deploy (OOS>0, MC p5>0, Calmar>1, WF deg<35%).
**Use case:** Only SUPERTREND_ELITE passed all four.
**Notes:** Non-negotiable for this project per AGENTS.md.

### Overfitting / curve fitting
**Definition:** Params tuned to noise; fails live.
**Use case:** HTF_RSI UI 125% vs honest −18%.
**Notes:** Fewer params + walk-forward mitigates.

### Lookahead bias
**Definition:** Using future data not known at bar close.
**Use case:** Signal must use closed bar only; adapter cache discipline.
**Notes:** Repainting indicators forbidden.

### Survivorship bias
**Definition:** Testing only assets that still exist.
**Use case:** Use current liquid list consciously.
**Notes:** Delisted alts vanish from history.

### Realistic cost model
**Definition:** Fees + slippage + funding in simulation.
**Use case:** `costModel.js` — taker 5 bps, slippage 5 bps default.
**Notes:** High-freq strategies die here honestly.

### Paper trading / forward test
**Definition:** Live data, no real money.
**Use case:** Mandatory before capital; detect drift vs backtest.
**Notes:** Open step in handoff.

### CAGR / maxDD / Calmar / Sharpe
**Definition:** Annualized return; peak trough loss; CAGR/MDD; risk-adj return.
**Use case:** Report cards in compare and validate scripts.
**Notes:** Short windows inflate CAGR.

### Profit factor / expectancy / win rate
**Definition:** Standard trade statistics.
**Use case:** PF>1 necessary; combine with trade count and OOS.
**Notes:** 5 trades PF 999 = meaningless sample.

---

## 21. Quant & statistics

### Alpha
**Definition:** Excess return not explained by beta/market.
**Use case:** What we're trying to prove exists after costs.
**Notes:** Decays with competition.

### Beta
**Definition:** Sensitivity to market (BTC) moves.
**Use case:** Size alt positions lower when beta high.
**Notes:** Hedge reduces beta.

### Z-score
**Definition:** Standard deviations from mean.
**Use case:** Mean reversion entry when price stretched.
**Notes:** Window length critical.

### Cointegration / pairs trade
**Definition:** Two prices mean-revert together long-run.
**Use case:** Market-neutral stat arb (not core repo).
**Notes:** Different from correlated momentum.

### Stationarity
**Definition:** Statistical properties constant over time.
**Use case:** Required for many stat arb assumptions.
**Notes:** Crypto prices often non-stationary.

### Autocorrelation
**Definition:** Correlation of series with lagged self.
**Use case:** Detect momentum vs mean reversion in returns.
**Notes:** Regime-dependent.

### Hurst exponent
**Definition:** H>0.5 trending, H<0.5 mean-reverting tendency.
**Use case:** Regime feature input.
**Notes:** Estimate noisy on short samples.

### Kelly criterion
**Definition:** Optimal bet fraction from edge and odds.
**Use case:** Cap fractional Kelly for sizing upper bound.
**Notes:** Full Kelly too aggressive; use ¼ Kelly.

### Turnover / capacity
**Definition:** How often portfolio trades; how much AUM strategy supports.
**Use case:** High turnover + fees = death; capacity limits alt size.
**Notes:** Our edge is low turnover.

### Deflated Sharpe / multiple testing
**Definition:** Adjust significance when many strategies tested.
**Use case:** Remember we compared 18 strategies — best may be luck.
**Notes:** Bonferroni humility.

### Bootstrap
**Definition:** Resample data/trades to estimate confidence intervals.
**Use case:** Related to Monte Carlo validation.
**Notes:** Doesn't fix bad hypothesis.

### Triple barrier labeling
**Definition:** ML labels for TP, SL, or time exit first touch.
**Use case:** SURF_PULSE_ML style meta-labeling.
**Notes:** Requires careful purge in train.

### Meta-labeling
**Definition:** Secondary model filters primary signals.
**Use case:** ML gate on rule-based entries.
**Notes:** Needs live ML service.

---

## 22. Bot, data & infrastructure

### Signal / entry / exit modules
**Definition:** Separation of concerns in bot architecture.
**Use case:** `strategies.js` signal vs `runner.js` execution.
**Notes:** Clean separation aids testing.

### Gate / gateMode
**Definition:** Extra filters (intraday gates) applied or off in backtest.
**Use case:** `gateMode: off` in compare for raw strategy edge.
**Notes:** SR_INTRADAY over-gated with gates on.

### State machine
**Definition:** Bot states: flat, long, short, pending, cooldown.
**Use case:** `bot.js` position lifecycle.
**Notes:** Must reconcile with exchange.

### Reconciliation
**Definition:** Match local position/orders to exchange truth.
**Use case:** After reconnect, API errors.
**Notes:** Prevents double exposure.

### WebSocket / REST
**Definition:** Streaming vs request/response API.
**Use case:** Klines via WS; orders via REST typically.
**Notes:** Rate limits on REST.

### Kline / candle ingest
**Definition:** Pipeline storing OHLCV to TimescaleDB.
**Use case:** `klineIngest.js`, `binanceKlinesRest.js`.
**Notes:** Docker DB port 54333.

### Hypertable / compression
**Definition:** TimescaleDB time partitioning and storage compression.
**Use case:** Backfill taker volume needs decompression setting.
**Notes:** See handoff gotcha.

### Backfill / gap fill
**Definition:** Load missing historical or live candles.
**Use case:** `backfill-taker-volume.mjs`.
**Notes:** 7 min per symbol noted.

### UTC bar alignment
**Definition:** Candle open/close timestamps in UTC.
**Use case:** Session definitions; avoid DST issues.
**Notes:** Binance uses UTC.

### API rate limit
**Definition:** Max requests per minute.
**Use case:** Throttle backfill and live orders.
**Notes:** Ban risk if exceeded.

### Kill switch API
**Definition:** Programmatic halt of trading.
**Use case:** Risk overlay emergency.
**Notes:** Wire before live capital.

### `manualStrategy` / `strategyMode`
**Definition:** Config selecting which registered strategy runs.
**Use case:** `SUPERTREND_ELITE` + `MANUAL` for deploy.
**Notes:** AUTO picks regime router.

### `RISK_AT_SL` sizing
**Definition:** Position size from equity, risk %, and stop distance.
**Use case:** Standard in backtest compare normalization.
**Notes:** Links risk to structure.

---

## 23. On-chain, DeFi & crypto-native

### Exchange inflow / outflow
**Definition:** Coins moving to/from exchange wallets.
**Use case:** Sell pressure fear on inflows; accumulation thesis on outflows.
**Notes:** Glassnode-style metrics.

### Whale wallet
**Definition:** Large holder address.
**Use case:** Watch transfers; not precise timing for 15m bot.
**Notes:** Sentiment context.

### MVRV / SOPR / NUPL
**Definition:** On-chain valuation and profit-taking metrics.
**Use case:** Macro filter for risk appetite.
**Notes:** Slow moving vs intraday.

### TVL (total value locked)
**Definition:** Assets deposited in DeFi protocol.
**Use case:** Protocol health; chain activity.
**Notes:** DeFi-specific strategies.

### Impermanent loss (IL)
**Definition:** LP loss vs holding when prices diverge.
**Use case:** LP strategy risk — not directional bot.
**Notes:** Separate playbook.

### Staking / slashing
**Definition:** Lock for yield; penalty for validator misbehavior.
**Use case:** Yield overlay, not intraday.
**Notes:** Opportunity cost of capital.

### Gas / priority fee
**Definition:** Cost to execute on-chain tx.
**Use case:** DEX execution economics.
**Notes:** Irrelevant for CEX API bot.

### Oracle
**Definition:** Price feed for DeFi contracts.
**Use case:** Oracle lag manipulation awareness.
**Notes:** Smart contract risk.

### Token unlock / vesting
**Definition:** Scheduled supply release.
**Use case:** Avoid longs into large unlock supply events.
**Notes:** Event calendar filter.

---

## 24. Sentiment, macro & events

### Fear & greed index
**Definition:** Composite sentiment score 0–100.
**Use case:** Contrarian or trend confirmation filter.
**Notes:** Lagging; not primary signal.

### Narrative / sector rotation
**Definition:** Market story driving flows (AI, L2, memes).
**Use case:** Pick universe of symbols to trade.
**Notes:** Changes faster than backtest window.

### Fed / rates / DXY
**Definition:** Macro drivers of global liquidity.
**Use case:** Risk-off filter for crypto longs.
**Notes:** BTC increasingly macro-correlated.

### Halving
**Definition:** BTC block reward cut ~4 years.
**Use case:** Long-cycle supply narrative.
**Notes:** Not intraday trigger.

### ETF flows
**Definition:** Institutional spot BTC/ETH ETF in/outflows.
**Use case:** Structural bid indicator.
**Notes:** Daily granularity.

### Hack / exploit / delisting
**Definition:** Tail risk events.
**Use case:** Blacklist symbol; kill switch.
**Notes:** Operational risk.

### Maintenance / funding event
**Definition:** Exchange downtime or scheduled macro release.
**Use case:** Stand down trading.
**Notes:** Calendar in ops runbook.

---

## 25. Psychology & process

### Trading plan
**Definition:** Written rules for when to trade and not trade.
**Use case:** Convert glossary terms into your playbook.
**Notes:** Bot = plan encoded.

### Playbook
**Definition:** Specific setups with diagrams and rules.
**Use case:** One page per A-setup type.
**Notes:** Matches strategy build steps.

### Journal
**Definition:** Record of trades with screenshots and tags.
**Use case:** Post-trade review; improve filters.
**Notes:** Tag with glossary shorthand.

### Revenge trading / FOMO / overtrading
**Definition:** Emotional violations of plan.
**Use case:** Why cooldown and max trades/day exist.
**Notes:** Automation removes some bias.

### Pre-mortem / post-mortem
**Definition:** Imagine failure before; analyze after.
**Use case:** Risk review before deploy; weekly strategy review.
**Notes:** Professional discipline.

### Deviation log
**Definition:** Record when you broke rules.
**Use case:** Discretionary overlay on bot — minimize.
**Notes:** If frequent, fix plan not willpower.

### Hypothesis-driven development
**Definition:** State edge hypothesis before backtest.
**Use case:** Our step-by-step strategy build process.
**Notes:** Prevents random indicator fishing.

---

## 26. Compliance & operational safety

### KYC / AML
**Definition:** Identity verification and anti-money-laundering rules.
**Use case:** Exchange account access.
**Notes:** Jurisdiction-dependent.

### API key security
**Definition:** Restrict permissions, IP whitelist, no withdraw on trade keys.
**Use case:** Mandatory before live bot.
**Notes:** Rotate on leak.

### Counterparty risk
**Definition:** Exchange insolvency or freeze risk.
**Use case:** Don't keep excess capital on CEX.
**Notes:** FTX lesson.

### Tax lots / reporting
**Definition:** Track cost basis per trade for taxes.
**Use case:** Separate from signal logic; jurisdiction-specific.
**Notes:** Not financial advice.

### ToS / geo-block
**Definition:** Exchange terms and restricted countries.
**Use case:** Compliance before automation.
**Notes:** VPN evasion = risk.

---

## 27. Acronyms quick reference

| Acronym | Meaning |
|---------|---------|
| TA | Technical analysis |
| FA | Fundamental analysis |
| PA | Price action |
| HTF / LTF | Higher / lower timeframe |
| MTF | Multi-timeframe |
| SL / TP | Stop loss / take profit |
| BE | Breakeven (stop at entry) |
| RR | Risk-reward ratio |
| PF | Profit factor |
| DD / MDD | Drawdown / maximum drawdown |
| OOS / IS | Out-of-sample / in-sample |
| WF | Walk-forward |
| MC | Monte Carlo |
| ATR | Average true range |
| ADX | Average directional index |
| RSI | Relative strength index |
| EMA / SMA | Exponential / simple moving average |
| VWAP | Volume-weighted average price |
| VP | Volume profile |
| POC | Point of control |
| VAH / VAL | Value area high / low |
| HVN / LVN | High / low volume node |
| OI | Open interest |
| FVG | Fair value gap |
| OB / BB / MB | Order / breaker / mitigation block |
| BSL / SSL | Buy-side / sell-side liquidity |
| EQH / EQL | Equal highs / lows |
| PDH / PDL | Previous day high / low |
| PWH / PWL | Previous week high / low |
| SMC / ICT | Smart money concepts / Inner Circle Trader |
| BOS / CHoCH / MSS | Break / change of structure |
| CVD | Cumulative volume delta |
| RVOL | Relative volume |
| OTE | Optimal trade entry |
| CE | Consequent encroachment (50% FVG) |
| KZ | Killzone |
| AMD | Accumulation, manipulation, distribution |
| SMT | Smart money technique (divergence) |
| IB | Inside bar |
| GP | Golden pocket |
| MEV | Maximal extractable value |
| IL | Impermanent loss |
| TVL | Total value locked |
| DeFi | Decentralized finance |
| CEX / DEX | Centralized / decentralized exchange |
| PnL | Profit and loss |
| ROE | Return on equity (on margin) |
| CAGR | Compound annual growth rate |
| VaR | Value at risk |
| CVaR | Conditional VaR |
| ML | Machine learning |
| API | Application programming interface |
| UTC | Coordinated universal time |

---

## 28. Entry markup shorthand

| Shorthand | Meaning | Use case |
|-----------|---------|----------|
| LTF long @ FVG CE | Long at 50% of bullish FVG | Pullback after displacement up |
| SH sweep → CHoCH → OB | Sweep highs, structure flips, short OB retest | SMC short model |
| BOS retest | Enter pullback to broken structure | Trend continuation |
| TL break + retest | Trendline break then retest | Classical PA |
| GP + OB | Golden pocket overlaps order block | A-grade confluence |
| PDH sweep short | Wick above PDH then fail | Intraday reversal |
| ST flip + ADX | Supertrend flip with strength | SUPERTREND_ELITE family |
| VWAP reclaim | Close back above VWAP | Intraday bias long |
| IB break | Mother bar breakout | Compression release |
| 2nd entry | Re-entry rule at same zone | Missed first fill protocol |

---

## 29. Minimum professional chart markup

Before every live or paper trade, mark:

1. **Bias** — HTF direction (long / short / neutral)
2. **Key level** — structure, liquidity, or zone
3. **Trigger** — exact condition (candle type, flip, sweep)
4. **Entry** — price or zone
5. **Stop** — invalidation (one line)
6. **Target(s)** — liquidity, structure, or R multiple
7. **RR** — reward ÷ risk after estimated costs
8. **Context** — session, regime, RVOL, funding
9. **Grade** — A / B / C
10. **Outcome** — post-trade tag (TP / SL / BE / invalid / no-fill)

---

## Appendix A — Registered strategies in this repo

| Key | One-line | Research status |
|-----|----------|-----------------|
| SUPERTREND_ELITE | 5-gate Supertrend + trail exit | **Only OOS-validated** |
| TREND_HTF_ST | HTF trend + Supertrend | Promising 2026 H1; needs full WF |
| HTF_LEG_RIDER | HTF + range breakout legs | Mixed; validate |
| TREND_PULLBACK | HTF trend + RSI pullback | Negative OOS |
| HTF_RSI | 1h trend + 15m RSI | Negative; UI overfit |
| SMART_REVERSAL | Sweep fade | Negative |
| REGIME_ADAPTIVE | Regime router | Rejected |
| SR_INTRADAY / INTRADAY_PRO | Multi-technique + order flow | Over-gated / no edge |
| EMA_CROSS, RSI_MEAN, BREAKOUT_VOL, MOMENTUM_SURGE | Classic baselines | Severe fee bleed |
| ENSEMBLE, CONFLUENCE | Combined weak signals | Negative |

See `strategy.md` and `STRATEGY_RESEARCH_HANDOFF.md` for configs and numbers.

---

## Appendix B — Coverage honesty

| Scope | Coverage in this file |
|-------|------------------------|
| Crypto perps chart trading + bot build | ~90% of terms you'll use |
| Full global finance | Not exhaustive |
| Every indicator ever published | Representative set only |
| Elliott Wave / harmonic patterns | Named in patterns; not every wave count |
| Deep options book | Light (see §3); expand if needed |
| Exchange-specific UI labels | Generic; add per venue if needed |

**To make complete for our project:** add **Appendix C — Playbook definitions** with exact numeric rules as we design each term operationally (see §0.14).

---

*End of glossary. Update this file when we add new playbook terms.*
