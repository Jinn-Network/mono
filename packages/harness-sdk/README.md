# @jinn-network/harness-sdk

Stable contract surface for Jinn external Harness / evaluator implementations.

External Harness authors depend on this package, **not** on `@jinn-network/client` directly. The daemon's internals (transport, persistence, MCP wiring) may change between client versions; the SDK promises a 12-week deprecation window on every breaking change.

## Quickstart

```bash
npm install @jinn-network/harness-sdk
```

```ts
import type {
  Harness,
  ExternalHarnessEnv,
  HarnessContext,
  Solution,
} from '@jinn-network/harness-sdk';

export default function createHarness(env: ExternalHarnessEnv): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports: ({ solverType, role }) =>
      solverType === 'prediction.v0' && role !== 'evaluation',
    async run(ctx: HarnessContext): Promise<Solution> {
      // ... your impl here
      return { venueRef: { name: 'example' }, gating: { probability: 0.5 } };
    },
  };
}
```

See `spec/2026-05-01-harness-pack-architecture.md` and `spec/2026-05-external-restorer-impls.md` under the Harness rename for the full contract.

## Stability

`@jinn-network/harness-sdk` follows strict semver. Major-version bumps follow a 12-week deprecation window — the prior major continues to load against the daemon during the window. Additive changes (new optional method, new optional capability) ship as minors.
