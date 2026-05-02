# @jinn-network/sdk

Stable SDK surface for Jinn SolverNets, Harnesses, plugins, and typed
payloads.

Runtime internals live in `@jinn-network/client`. The SDK builds, validates,
describes, and prepares; the client runs, stores, posts, claims, signs,
submits, and watches.

## Install

```bash
npm install @jinn-network/sdk
```

## Harness authoring

```ts
import type {
  Harness,
  ExternalHarnessEnv,
  HarnessContext,
  Solution,
} from '@jinn-network/sdk/harness';
import { buildSolutionOutput } from '@jinn-network/sdk/solvernets/prediction-v1';

export default function createHarness(env: ExternalHarnessEnv): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports: ({ solverType, role }) =>
      solverType === 'prediction.v1' && role !== 'evaluation',
    async run(ctx: HarnessContext): Promise<Solution> {
      return buildSolutionOutput({
        solverType: 'prediction.v1',
        venueName: 'polymarket',
        payload: {
          probabilityYes: '0.50',
          submittedAt: new Date().toISOString(),
          format: 'decimal',
          modelId: 'example-harness',
        },
      });
    },
  };
}
```

## Public subpaths

- `@jinn-network/sdk/harness` — Harness interfaces, context, capability
  handles, and signed Harness manifest types.
- `@jinn-network/sdk/solvernets` — SolverNet contract registry, validation, and
  generic typed output builders.
- `@jinn-network/sdk/solvernets/prediction-v1` — first-party Prediction v1
  schemas, payload types, validation, and output helpers.
- `@jinn-network/sdk/plugins` — SolverPlugin manifest types and validation
  helpers for normal AI tooling plugins.

The daemon still performs final runtime validation, envelope assembly, signing,
storage, and submission.
