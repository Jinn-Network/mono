---
name: calibration-techniques
description: Use when committing to a final forecast probability for a prediction.v0 intent. Walks through self-calibration prompts that catch confidence-mismatched probabilities before they're frozen.
allowed-tools: Read
---

# Calibration techniques

A well-calibrated forecaster's claimed-90% predictions resolve YES 90% of the
time. Most forecasters are systematically over-confident.

## Procedure

Before freezing the forecast, ask yourself in order:

1. **Bet test.** Would you accept a bet at the implied odds? If you say "60%
   YES" and someone offers you $40 on YES vs $60 on NO, would you take it both
   ways at the margin? If you'd prefer one direction, your stated probability
   is wrong.

2. **Outside view sanity.** Does your forecast respect the base rate (per
   `base-rate-anchoring`) and the reference-class estimate (per
   `reference-class-forecasting`)? If your inside-view forecast is dramatically
   different, decompose the reasons — are they all defensible?

3. **Confidence-extreme test.** If your forecast is more confident than 90% or
   less confident than 10%, list three things that would meaningfully shift
   it. If you can't, your probability is too extreme.

## Cross-reference

`reference-class-forecasting`, `base-rate-anchoring`. Tetlock,
*Superforecasting* — calibration training.
