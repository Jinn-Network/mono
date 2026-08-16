# Pattern: forecaster

**Example package:** [`examples/external-harnesses/polymarket-forecaster`](../../../../examples/external-harnesses/polymarket-forecaster)
**In-repo anchor:** [`operator/src/harnesses/impls/prediction-v0-baseline/`](../../../../client/src/harnesses/impls/prediction-v0-baseline)

## Recruit shape

You're a Polymarket / Kalshi / Manifold bot operator. You have a working forecasting pipeline — a function that takes a market and returns a probability — and you want it dispatched against Jinn `prediction.v0` Tasks. The forecaster pattern wraps your pipeline as a `Harness` whose `run()` calls into your existing code.

This is by far the most common Phase A.2 recruit shape: a working monolith that wants Jinn Tasks pointed at it.

## What the pattern does

A `forecaster` Harness claims `prediction.v0` restoration Tasks (`role !== 'evaluation'`), reads the Task's market reference, calls your forecasting pipeline, and returns a `Solution` with the probability in `solutionPayload`.

The in-repo `prediction-v0-baseline` is the working reference implementation; reading it alongside this walkthrough gives you the full picture of what an in-production forecaster looks like.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/polymarket-forecaster",
  "version": "0.1.0",
  "supportedSolverTypes": ["prediction.v0>=1.0.0"],
  "entry": "./dist/index.js",
  "package": {
    "cid": "bafybei...",
    "hash": "sha256:..."
  },
  "capabilities": {
    "rpc": [
      { "chainId": 8453, "methods": ["eth_call", "eth_blockNumber"] }
    ]
  },
  "signature": { "alg": "ed25519", "publicKey": "...", "sig": "..." },
  "license": "MIT"
}
```

The `capabilities.rpc` allow-list is narrow: the forecaster only reads chain state (no signer, no writes). For Polymarket reads, `eth_call` + `eth_blockNumber` is sufficient. Wider allow-lists earn slower install decisions from operators.

## Slot entry walkthrough

`src/index.ts` default-exports the factory:

```ts
import type {
  Harness,
  HarnessContext,
  Solution,
  ExternalHarnessEnv,
} from '@jinn-network/sdk/harness';

export default function createHarness(env: ExternalHarnessEnv): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: HarnessContext): Promise<Solution> {
      const market = await fetchMarketState(ctx.task, ctx.rpc);
      const probability = await computeForecast(market);
      return {
        venueRef: { name: 'polymarket' },
        gating: { probability, marketId: market.id },
        solutionPayload: {
          probability,
          horizonTs: ctx.task.window?.endTs,
        },
      };
    },
  };
}
```

The `supports()` check filters out evaluation Tasks (those go to evaluator Harnesses). `isReady()` returns stub-mode for CLI introspection so `jinn harnesses show` can display the Harness without hitting the live API. `run()` fetches market state via `ctx.rpc` (the manifest-allowed RPC handle), computes the forecast, returns the output.

## Test → publish

```bash
cd examples/external-harnesses/polymarket-forecaster
yarn install
yarn test                                      # unit tests, mocked context
yarn vitest run test/e2e-anvil.test.ts         # spawns Anvil fork, full attempt against a synthetic Task
yarn build                                     # tsc → dist/
```

Then sign + pin + publish per [publishing.md](../publishing.md).

## Replace the stub

1. **Implement `fetchMarketState` and `computeForecast`** with your real code. The example's `lib.ts` has stubs that return canned values; swap them for your pipeline's calls.
2. **Tighten `capabilities.rpc`.** If your pipeline only reads from a specific contract, you can document that in the manifest's `description` and operators will trust faster.
3. **Use `ctx.implStateDir`** for any persistent state (calibration history, recent-attempt cache). It survives across attempts; `ctx.workingDir` does not.
4. **Throw `SkippableError`** for structural failures (market resolved before resolve-time, account not funded, API down). The daemon releases the claim cleanly.
5. **Respect `ctx.abort` and `ctx.msUntilEndTs()`.** Long-running fetches should pass the abort signal to fetch / SDK calls; budget computation against the time remaining.

The in-repo `prediction-v0-baseline` is the canonical working reference — its `run()` is the shape your `run()` should converge on.
