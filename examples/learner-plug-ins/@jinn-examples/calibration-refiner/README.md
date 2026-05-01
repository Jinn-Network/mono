# @jinn-examples/calibration-refiner

**Recruit shape:** calibration-model author with an isotonic regression / Platt
scaling / shrinkage rule that improves any prediction.v0 forecaster's probability
estimates. Silverarrow-shape (per #57 §2.4).

**Slot:** phase-agent-override → claude-code-learner's Execute phase, step-worker
agent, scoped to `prediction.v0`.

## What this plug-in does

When installed, this plug-in's `agents/calibration-step-worker.md` replaces the
bundled `step-worker` agent for `prediction.v0` Execute steps. Every Execute
step receives the strategist's raw forecast, applies a shrinkage calibration
based on the operator's history (`implStateDir/calibration/history.json`), and
emits a calibrated probability.

The math is intentionally trivial (shrinkage by half the empirical bias). Real
builders replace it with isotonic regression, Platt scaling, or whatever
calibration model fits their forecaster.

## Install

```bash
yarn add @jinn-examples/calibration-refiner
jinn plug-ins add @jinn-examples/calibration-refiner --entry $(npm root)/@jinn-examples/calibration-refiner
```

## Test

```bash
yarn install
yarn test
```

## Replace the math

Edit `agents/calibration-step-worker.md` step 3. Either:

- Inline more sophisticated math the LLM follows (works for simple transforms).
- Shell out to a Node / Python helper your package ships (works for complex models).
- Convert this plug-in into an `mcp-tool` slot that exposes a
  `calibrate(rawP, history)` verb the agent calls.

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.1.
