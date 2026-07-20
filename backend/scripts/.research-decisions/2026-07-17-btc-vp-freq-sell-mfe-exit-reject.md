# 2026-07-17 — BTC VP FREQ SELL MFE exit REJECT

## Experiment

- **Baseline:** `VOLUME_PROFILE_FREQ_BTC_15M`, BTCUSDT, futures, 2022-06-01 → 2026-05-31
- **Hypothesis:** Current BTC entries are selective but some SELL losers reach useful MFE before giving back. A SELL-only MFE giveback trail may improve VAL short expectancy without reducing N.
- **Single change:** exit-only MFE giveback trail on SELLs; entries unchanged.
- **Script:** `backtest-vp-freq-btc-sell-mfe-exit.mjs`
- **Artifact:** `.vp-freq-btc-sell-mfe-exit.json`

## Results

| Variant | N | Trades/wk | Return | DD | Years < 0 | Verdict |
|---------|--:|----------:|-------:|---:|----------:|---------|
| Locked, no MFE trail | 56 | 0.27 | +90.5% | 24.4% | 0 | Baseline |
| SELL MFE 1.0%, giveback 35% | 56 | 0.27 | +80.4% | 16.9% | 0 | Reject |
| SELL MFE 1.0%, giveback 50% | 56 | 0.27 | +83.8% | 16.1% | 0 | Reject |
| SELL MFE 0.8%, giveback 35% | 56 | 0.27 | +60.7% | 17.9% | 0 | Reject |
| SELL MFE 1.2%, giveback 35% | 56 | 0.27 | +78.9% | 15.7% | 0 | Reject |
| Chop-only SELL MFE 1.0%, giveback 35% | 56 | 0.27 | +90.5% | 24.4% | 0 | No-op |

SELL MFE trails improved drawdown and win rate but reduced total return. The main damage came from clipping the few BTC short runners that pay for many small failures.

## Verdict

**REJECT as promotion.** Keep the current BTC 15m preset unchanged. The next BTC frequency path should be a genuinely new BTC-native setup/playbook, not 5m VP FREQ or generic SELL MFE trailing.

