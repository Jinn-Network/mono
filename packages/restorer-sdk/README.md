# @jinn-network/restorer-sdk

Stable contract surface for Jinn external restorer / evaluator implementations.

External impl authors depend on this package, **not** on `@jinn-network/client` directly. The daemon's internals (transport, persistence, MCP wiring) may change between client versions; the SDK promises a 12-week deprecation window on every breaking change.

## Quickstart

```bash
npm install @jinn-network/restorer-sdk
```

```ts
import type {
  RestorerImpl,
  ExternalRestorerEnv,
  RestorationContext,
  RestorationOutput,
} from '@jinn-network/restorer-sdk';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports: ({ kind, type }) =>
      kind === 'prediction.v0' && type !== 'evaluation',
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      // ... your impl here
      return { venueRef: { name: 'example' }, gating: { probability: 0.5 } };
    },
  };
}
```

See `spec/2026-04-30-plug-in-surface.md` §3 and `spec/2026-05-external-restorer-impls.md` for the full contract.

## Stability

`@jinn-network/restorer-sdk` follows strict semver. Major-version bumps follow a 12-week deprecation window — the prior major continues to load against the daemon during the window. Additive changes (new optional method, new optional capability) ship as minors.
