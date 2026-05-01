# Pattern: forecaster

**Example package:** [`examples/external-restorer-impls/polymarket-forecaster`](../../../../examples/external-restorer-impls/polymarket-forecaster)
**In-repo anchor:** [`client/src/restorer/impls/prediction-v0-baseline/`](../../../../client/src/restorer/impls/prediction-v0-baseline)

## Recruit shape

You're a Polymarket / Kalshi / Manifold bot operator. You have a working forecasting pipeline — a function that takes a market and returns a probability — and you want it dispatched against Jinn `prediction.v0` intents. The forecaster pattern wraps your pipeline as a `RestorerImpl` whose `run()` calls into your existing code.

This is by far the most common Phase A.2 recruit shape: a working monolith that wants Jinn intents pointed at it.

## What the pattern does

A `forecaster` impl claims `prediction.v0` restoration intents (`type !== 'evaluation'`), reads the intent's market reference, calls your forecasting pipeline, and returns a `RestorationOutput` with the probability in `restorationPayload`.

The in-repo `prediction-v0-baseline` is the working reference implementation; reading it alongside this walkthrough gives you the full picture of what an in-production forecaster looks like.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/polymarket-forecaster",
  "version": "0.1.0",
  "supportedKinds": ["prediction.v0>=1.0.0"],
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
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ExternalRestorerEnv,
} from '@jinn-network/restorer-sdk';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      const market = await fetchMarketState(ctx.intent, ctx.rpc);
      const probability = await computeForecast(market);
      return {
        venueRef: { name: 'polymarket' },
        gating: { probability, marketId: market.id },
        restorationPayload: {
          probability,
          horizonTs: ctx.intent.window?.endTs,
        },
      };
    },
  };
}
```

The `supports()` check filters out evaluation intents (those go to evaluator impls). `isReady()` returns stub-mode for CLI introspection so `jinn impls show` can display the impl without hitting the live API. `run()` fetches market state via `ctx.rpc` (the manifest-allowed RPC handle), computes the forecast, returns the output.

## Test → publish

```bash
cd examples/external-restorer-impls/polymarket-forecaster
yarn install
yarn test                                      # unit tests, mocked context
yarn vitest run test/e2e-anvil.test.ts         # spawns Anvil fork, full attempt against synthetic intent
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
