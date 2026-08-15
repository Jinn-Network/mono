# Pattern: evaluator

**Example package:** [`examples/external-harnesses/prediction-evaluator`](../../../../examples/external-harnesses/prediction-evaluator)
**In-repo anchor:** [`operator/src/harnesses/impls/prediction-v0-evaluator/`](../../../../client/src/harnesses/impls/prediction-v0-evaluator)

## Recruit shape

You're an evaluator-builder with an alternative scoring approach: log-loss instead of Brier, calibration decomposition, Numerai-shape continuous loss, a domain-specific accuracy metric. You don't run a forecaster — you score forecasters.

The evaluator pattern wraps your scoring rule as a `Harness` that claims evaluation Tasks and emits a `verdictPayload`.

## What the pattern does

An evaluator Harness claims `prediction.v0` evaluation Tasks (`role === 'evaluation'`), reads the prediction under evaluation + the resolved oracle outcome, applies your scoring rule, and returns a `Solution` with the score in `verdictPayload`.

The in-repo `prediction-v0-evaluator` is the canonical reference — a deterministic Brier scorer over `oraclePriceAtResolveTs`. Reading it gives you the full structure of what an evaluator looks like in production.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/prediction-evaluator",
  "version": "0.1.0",
  "supportedSolverTypes": ["prediction.v0>=1.0.0"],
  "entry": "./dist/index.js",
  "package": { "cid": "bafybei...", "hash": "sha256:..." },
  "capabilities": {
    "rpc": [
      { "chainId": 84532, "methods": ["eth_call", "eth_blockNumber", "eth_getLogs"] }
    ]
  },
  "signature": { "alg": "ed25519", "publicKey": "...", "sig": "..." },
  "license": "MIT"
}
```

Evaluators usually need a slightly wider RPC allow-list than forecasters because oracle reads frequently involve event-log queries (`eth_getLogs`) — pricing oracles, resolution events, etc. No signer; evaluators do not transact.

## Slot entry walkthrough

`src/index.ts` differs from the forecaster pattern in two places: `supports()` returns `true` for `role === 'evaluation'`, and `run()` returns `verdictPayload` instead of `solutionPayload`.

```ts
import type {
  Harness,
  HarnessContext,
  Solution,
  ExternalHarnessEnv,
} from '@jinn-network/sdk/harness';

export default function createEvaluator(env: ExternalHarnessEnv): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role === 'evaluation';
    },
    async run(ctx: HarnessContext): Promise<Solution> {
      const prediction = readPredictionFromTask(ctx.task);
      const outcome = await readOracleOutcome(prediction, ctx.rpc);
      const score = brierScore(prediction.probability, outcome);
      const calibration = decomposeCalibration(prediction, outcome);
      return {
        venueRef: { name: 'jinn-evaluator' },
        gating: { score, outcome },
        verdictPayload: {
          score,
          calibration,
          method: 'brier-with-decomposition',
          oracleResolveTs: outcome.ts,
        },
      };
    },
  };
}
```

## Test → publish

```bash
cd examples/external-harnesses/prediction-evaluator
yarn install
yarn test
yarn vitest run test/e2e-anvil.test.ts        # posts a synthetic envelope, asserts the verdict
yarn build
```

Then sign + pin + publish per [publishing.md](../publishing.md).

## Replace the stub

1. **Implement your scoring rule.** Replace `brierScore` + `decomposeCalibration` with your real code. Keep `run()` deterministic — the same inputs MUST yield the same `verdictPayload` so other operators can reproduce.
2. **Implement `readOracleOutcome`** against the oracle your evaluator depends on (Polymarket resolution event, Pyth, Chainlink). The example reads from a mock oracle for tests.
3. **Make `verdictPayload` self-describing.** Include `method`, `version`, the inputs that fed the score, and any decomposition components. Other operators reading the corpus need to understand what they're seeing.
4. **Handle disputed resolutions cleanly.** If the oracle disputes or invalidates a market, throw `SkippableError` — the daemon releases the claim without consuming a delivery slot.
5. **Document your scoring rule.** Operators inspecting `jinn harnesses show` see the manifest's `description`; recruits considering your evaluator should see a README that names the scoring method, the inputs, and the property it optimises for.

Multi-evaluator consensus is a Phase B concern; for Phase A.2, evaluators compete on `supports()` first-match, and the operator's config decides which evaluator runs by ordering `harnesses.externalImpls`.
