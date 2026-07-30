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
- `@jinn-network/sdk/autopilot` — stable Autopilot session, result,
  correlation, adoption-comment, Task submission, and delivery-observation
  contracts.
- `@jinn-network/sdk/fixtures/autopilot/*` — byte-stable golden fixtures and
  their SHA-256 manifest for cross-repository consumer tests.
- `@jinn-network/sdk/plugins` — SolverPlugin manifest types and validation
  helpers for normal AI tooling plugins.

The daemon still performs final runtime validation, envelope assembly, signing,
storage, and submission.

## Autopilot marketplace consumers

External Autopilot hosts validate immutable request and result files through
the public protocol boundary:

```ts
import {
  AutopilotDeliveryExpectationSchema,
  AutopilotDeliveryObservationSchema,
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
} from '@jinn-network/sdk/autopilot';
```

The same schema objects remain available from
`@jinn-network/sdk/solvernets/jinn-repo`. Golden inputs and expected failures
are published under `@jinn-network/sdk/fixtures/autopilot/*`; consumers should
hash raw fixture bytes and follow each entry's `decode` disposition in
`manifest.json`.

## Frozen mode (the freeze contract)

Every Harness implementation must respect `HarnessContext.mode`:

- `'train'` (default): writes to `ctx.implStateDir` are allowed. Improve /
  Memory / equivalent learning phases run.
- `'frozen'`: writes to `ctx.implStateDir` are forbidden. The daemon
  hashes the directory before and after each Task; mismatch rejects the
  envelope and rolls back.

Use `requireTrain(ctx, action)` at write call sites to fail fast in
frozen mode rather than after the Task completes:

```typescript
import { requireTrain } from '@jinn-network/sdk/harness';

async function updateConstitutionalState(ctx: HarnessContext, delta: StateDelta) {
  requireTrain(ctx, 'update constitutional state');
  await fs.writeFile(constitutionPath, serialize(delta));
}
```

Frozen mode is the discipline that crystallises the flowing substrate
into externally-comparable artifacts; see
`docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §5–6
for the full design (trust stack, daemon enforcement, verified vs
unverified frozen credibility tier).

## Changelog

### 0.2.0 (2026-07-30)

Breaking (0.x policy: minor = breaking): the `./benchmarking` subpath is
removed. Its schemas were superseded by the benchmarking application design
(`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md`);
the successor surfaces live in `@jinn-network/benchmarking-records`. No
published consumer imported the subpath at removal time. All other subpaths
are unchanged; `@jinn-network/sdk@0.1.1` remains on the registry for pinned
consumers.
