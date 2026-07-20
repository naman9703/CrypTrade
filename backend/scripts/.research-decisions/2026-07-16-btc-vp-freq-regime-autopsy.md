# 2026-07-16 — BTC VP FREQ regime autopsy + adaptive A/B (partial)

**Mandate:** Analyse BTC like ETH — market-condition dependencies, adapt behaviour
for BTC’s nature (not copy ETH long-side locks). Maximize honest return + usable
frequency; do not crush N as the “solution.”

**Artifacts**
- `research-vp-freq-btc-bad-years-deep.mjs` → `.vp-freq-btc-bad-years-deep.json`
- `backtest-vp-freq-btc-adaptive-stack.mjs` → `.vp-freq-btc-adaptive-stack.json` / log
- Round 2 script ready: `backtest-vp-freq-btc-adaptive-r2.mjs` (blocked: DB down / disk full)

## BTC nature (vs ETH)

| | ETH FREQ | BTC FREQ (current) |
|--|----------|---------------------|
| Setup bias | Open funnel (VAH + VAL + rej) | **Short-biased** (VAL + va_rej; VAH longs banned — funnel 2026-07-15) |
| Edge in good year | VAL follow-through in clean bear | Mild +16% (2025–26) on baseline; **va_rej carries** under tight HTF |
| Bad-year bleed | Vacuum VAH + shallow bull shorts | **Shallow-HTF VAL shorts**, esp. macroBull / grind |
| Frequency | Higher | Structural low on 15m (~0.8/wk prior); cannot reopen with looser gates |

**Do not port:** ETH vacuum VAH cap, buy-chase, BUY-side locks.

## Baseline (locked `VOLUME_PROFILE_FREQ_BTC_15M`, $100, risk 2.5%, no maxDailyLoss)

| Window | N | WR | Net / Ret |
|--------|--:|---:|----------:|
| 2022–23 | 49 | 31% | **−$40 / −40%** |
| 2023–24 | 41 | 20% | **−$53 / −53%** |
| 2024–25 | 42 | 29% | **−$14 / −14%** |
| 2025–26 | 41 | 46% | **+$17 / +17%** |
| **Full 2022-06→2026-05** | **173** | 31% | **−72%** DD 85% |

Bleed is almost entirely `SELL:val_breakdown`. `va_rejection` is small-N mixed.

## Counterfactual (trade-filter) — universal BTC signal

**Block VAL when `macroBull` AND `htfSep < 0.5%`** improves **all four** year nets
(+14 / +25 / +9 / +10). That is the BTC analogue of ETH’s bull/shallow-HTF problem —
implemented via sell HTF floors, not year hardcoding.

Other CFs:
- Global `htfSep < 0.5%` block: huge help 22–23/23–24, mild later — frequency cost.
- Chop MFE “exit leak” present, but full-sim **chop SELL trail HURTS BTC** (REJECT).
- Block extended-down SELL va_rej: **hurts** 22–23 (opposite of ETH) — REJECT copy.
- Block all BUY: helps 22–23, hurts 24–25 — not lock.

## Full-sim A/B (one family at a time, then stacks)

| Variant | N | Full ret | 22–23 | 23–24 | 24–25 | 25–26 | Verdict |
|---------|--:|--------:|------:|------:|------:|------:|---------|
| Baseline | 173 | −72% | −40 | −53 | −14 | +17 | — |
| A macroAdapt (soft 0.15% / bull 0.5%) | 124 | −41% | −27 | −30 | −14 | **+33** | Helps; still red |
| B nonBear alone | 173 | −72% | =base | | | | No-op without macroAdapt |
| C chop SELL trail | 173 | −76% | | | worse | | **REJECT** |
| D rej wick 0.35 | 166 | −73% | better | | worse | | Mixed — no lock |
| AF macro+weakBear | 91 | −23% | −10 | −21 | −18 | +32 | Best adapt-stack; still red |
| AB / ABF stacks | ≤105 | −35…−55% | | | | | Non-bear over-filters edge |
| **G global HTF 0.5%** | **64** | **+8%** | **+9** | −16 | −10 | **+30** | **First green full window** |
| H VAL-only | 86 | −52% | | | | | REJECT (drops carrying va_rej) |

Under **G**, setups flip relative to ETH narrative: `va_rejection` **+$37 / 5t**,
`val_breakdown` still **−$29 / 59t**. Mid years (bull grind / chop) remain the hole.

## What is locked / not locked

**Not locked yet** — mid years still negative under best candidate; round-2 (HTF 0.4/0.6,
G+vol, G+score, rej-only, soft+harder bull) blocked by Timescale down / disk ~100%.

**BTC-native direction (next when DB up):**
1. Re-run `backtest-vp-freq-btc-adaptive-r2.mjs`
2. Prefer condition→behaviour (macro / weak-bear HTF) that restores N vs pure global 0.5%
3. Attack residual VAL bleed in 23–24/24–25 with **one** change (vol/path/score) —
   measure; do not stack blind
4. Only then update `VOLUME_PROFILE_FREQ_BTC_15M` + frontend mirror + handoff

## Infra note

Disk at ~100% caused `Connection terminated` / `ECONNREFUSED` mid-grid. Free ≥10GB
(Cursor `state.vscdb.backup` ~21GB is the known reclaim) and restart Docker before
continuing.

## Status

Research checkpoint — **no BTC preset change this turn.** Baseline proven deeply
negative multi-year; macroAdapt and global HTF 0.5% are the two honest levers;
ETH exit/long locks do not transfer.
