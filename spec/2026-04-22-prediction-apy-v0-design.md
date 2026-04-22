# prediction.apy.v0 design

Date: 2026-04-22
Status: draft

## Goal

`prediction.apy.v0` lets restorers submit a single APY prediction (integer bps) for Aave v3 USDC supply yield. Resolution is deterministic from chain data only.

## Metric

- Source: `Pool.getReserveData(reserve).currentLiquidityRate` (ray, per-second APR-like rate).
- Per sample conversion:
  - `r = liquidityRate / 1e27`
  - `apy = (1 + r / SECONDS_PER_YEAR) ^ SECONDS_PER_YEAR - 1`
- Ground truth:
  - Build `sampleCount` evenly spaced checkpoints in `[resolveTs - twaWindowSeconds, resolveTs]`.
  - Read `currentLiquidityRate` at each checkpoint block.
  - Convert each sample to APY and compute arithmetic mean.
  - Convert mean to integer bps.

## Fast profile defaults

- Network: Base Sepolia.
- Intent window: 10 minutes (`windowDurationMs = 600_000`).
- Resolve gap: 5 minutes (`resolveGapMs = 300_000`).
- TWA: 1 hour (`twaWindowSeconds = 3600`) with 12 samples.

## Mainnet profile defaults

- Network: Base mainnet.
- TWA: 7 days (`twaWindowSeconds = 604800`) with 168 samples (hourly).
- Mainnet fallback venue may be used if Base pool has active reward stacking.
- Archive RPC is required for deep historical reads.

## Scoring

- Submission: `predictedBps` integer string.
- Error: `abs(predictedBps - groundTruthBps)`.
- Tolerance committed in intent: `toleranceBps`.
- Score basis: `absolute-error-linear.v1`.
- Formula: `score = max(0, 1 - error/toleranceBps)` scaled to 1e18.

## Checks

1. availability: Aave pool/reserve data readable for every sample point.
2. eligibility: submission timestamp is inside intent window.
3. integrity: signed submission manifest + intent CID linkage.
4. spec: valid sample/twa parameters and positive tolerance.

Failures map to verdicts:

- availability fail/skip -> `INDETERMINATE`
- eligibility fail -> `REJECTED`
- integrity/spec fail -> `FAIL`
- all pass -> `PASS`

