---
name: base-rate-anchoring
description: Use when generating a forecast for a prediction.v0 intent and a base rate is readily computable from public data. Anchors on the base rate first, adjusts only for case-specific signals, surfaces the magnitude of any adjustment for review.
allowed-tools: Read
---

# Base-rate anchoring

Surface bias: forecasters routinely produce forecasts dramatically below or
above well-known base rates, persuaded by case-specific narrative.

## Procedure

1. State the base rate explicitly. (e.g., "Polymarket binary markets resolve
   YES roughly 50% of the time; markets with non-trivial yes-price activity
   resolve YES at the implied rate the market itself reports.")
2. Forecast = base rate + sum(adjustments), each adjustment ≤ 0.10 in magnitude
   unless you have strong evidence for a larger move.
3. If your forecast is more than 0.20 from the base rate, justify each step
   that took you there — flag yourself if you can't.

## Cross-reference

Kahneman, *Thinking Fast and Slow* (2011) — anchoring effect.
