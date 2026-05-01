---
name: reference-class-forecasting
description: Use when generating a candidate forecast strategy for a prediction.v0 intent. Anchors the forecast on a relevant historical reference class — analogous past events with known outcomes — before applying inside-view adjustments.
allowed-tools: Read
---

# Reference-class forecasting

Most forecasting errors come from over-weighting the inside view (the specific
case in front of you) and under-weighting the base rate from analogous cases.
This skill anchors you on the outside view first.

## When to use

Inside the strategist subagent, after the orient findings load, before you
commit to a candidate approach.

## Procedure

1. Identify the **reference class**. Ask: "what's the closest historical
   population this question belongs to?"
   - "Will an incumbent win a 2024 election?" → past elections with similar
     incumbency / approval / economic conditions.
   - "Will a CPI print exceed 3%?" → past CPI prints in regimes with similar
     lagged indicators.
   - "Will a sports outcome happen?" → past games / matches in equivalent
     context.

2. Estimate the **base rate** from the reference class. Cite the source if you
   have one (in this skill's bundled context, you don't have web access; use
   the orient findings).

3. Adjust **only** for inside-view factors that demonstrably distinguish the
   current case from the reference class. Each adjustment is one sentence
   with explicit rationale.

4. Output: a probability estimate accompanied by:
   - The reference class you used.
   - The base-rate estimate from the reference class.
   - Each inside-view adjustment with rationale.

## Cross-reference

Tetlock & Gardner, *Superforecasting* (2015) ch. 5.
