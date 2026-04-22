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
- Baseline restorer: TWA `windowEnd` is `min(resolveTs, now)` at submission time so samples stay in the past. Evaluator at resolution uses `resolveTs` as the window end.
- Testnet: optional `prediction.apy.v0` auto-intents when `JINN_ENABLE_APY_AUTO_INTENTS=1` (off by default; `prediction.v0` auto remains the default loop activity).

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

## Verdict manifest

- `claimed.submissionManifestCid` is optional (omit when no IPFS child CID; do not use a placeholder string).

## Checks

1. availability: Aave pool/reserve data readable for every sample point.
2. eligibility: `submittedAt` in `[window.startTs, window.endTs)`; and `submittedAt ≤ window.startTs + eligibility.maxSubmissionDelayMs` (default 72h in schema so short windows are not accidentally cut off by a 60s default).
3. integrity:
   - `integrity.manifest_signature`: recompute the keccak256 over the canonical unsigned JSON (same as restorer `signCanonical`) and verify the secp256k1 signature.
   - `integrity.intent_ref`: compare the submission manifest’s `intent.cid` to the **restoration** job’s intended-state IPFS CID. The evaluation job’s `DesiredState` is a different IPFS object; the protocol therefore requires `context.restorationIntentCid` on the **evaluation** `DesiredState` (set by Jinn’s mech adapter when it creates the eval job from a delivered restoration). If that key is missing (e.g. legacy or third-party eval jobs), the check is `INDETERMINATE` — the evaluator does **not** fall back to the evaluation job’s `intentCid` (which would be the wrong reference and cause false `FAIL` / false `PASS` bugs).
4. spec: valid TWA sample spacing (≥1s between samples), and positive tolerance.

Verdicts:

- availability fail -> `INDETERMINATE`
- any `integrity.*` with status `INDETERMINATE` (e.g. missing `context.restorationIntentCid`) -> `INDETERMINATE`
- eligibility fail -> `REJECTED`
- other integrity or spec fail -> `FAIL`
- all pass -> `PASS`

`prediction.v0` evaluation uses the same `context.restorationIntentCid` rule and the same `integrity.*` / `INDETERMINATE` ordering.

## Restorer variants

| Impl | Default for kind | Notes |
|------|------------------|--------|
| `prediction-apy-v0-baseline` | Yes (`restorers.byKind['prediction.apy.v0']`) | Deterministic: TWA from on-chain samples at `min(resolveTs, now)`. |
| `claude-mcp-prediction-apy` | No (opt-in) | Spawns Claude Code with MCP tools `read_aave_reserve` + `submit_apy_prediction`. Operators select via `jinn intents` / config `restorers.byKind`. |

Do not flip the default to the Claude impl until the opt-in isolation test (`JINN_TEST_CLAUDE_PREDICTION_APY=1`, script `yarn test:claude-prediction-apy`) is green on at least three separate runs, matching the gate used for `prediction.v0` / `claude-mcp-prediction`.
