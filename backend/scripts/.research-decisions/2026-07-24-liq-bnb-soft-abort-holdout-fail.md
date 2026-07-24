# BNB LIQ — soft abort counterfactual (2026-07-24)

Coin: **BNBUSDT** CORE. Companion to MFE oracle + STOPRUN reject.

## Question

If we could abort every `mfe<0.5%` trade at a **cheap fixed cost** (look-ahead), would Y25/H12 clear?

## Soft results

| Rule | Y25 | H12 | FULL | Note |
|------|-----|-----|------|------|
| H0 | −3.0 | −1.9 | −99.7 | |
| oracle **drop** death | **+5.2** | **+2.2** | **+115** | free skip |
| abort @ 15% of mean death loss | **−5.0** | **−8.8** | +82 | cost kills holdout |
| abort @ 25–50% | worse Y25/H12 | worse | still FULL>0 | |
| abort only if death ∧ hold≤N | all Y25 red | all H12 red | −15…−60 | |

## Verdict

Even **oracle abort-with-cost** fails Y25/H12. Holdout only greens when death trades are **never taken** (zero loss), not paid at a small abort. That is exactly the progress-confirm / entry-filter problem — already **REJECT** hard.

Implication: do not spend more cycles on dead-trade / market-abort / no-follow exit proxies for BNB CORE promote. Latent FULL edge is not holdout-safe under realistic abort costs.

## Next fork

Need a **new LIQ family or TF** with coin-native autopsy — or a holdout-valid entry skip that hard sim confirms (none found to date). AST vol15 sleeve remains the only green hard sleeve and is **low-freq only** (not returns+freq target).
