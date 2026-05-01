# Path 2 quickstart

A 60-second walkthrough for shipping a Path 2 restorer impl as an external npm package.

## Audience

Builders with a working forecaster, evaluator, or alternative harness who want it dispatched against Jinn intents. Polymarket / Kalshi bot operators, Numerai-orbit forecasters, MiroFish-orbit quants, Bittensor SN6 (Numinous Signals) miners, prediction-tool builders. If you only have one *piece* of a forecaster (a calibration model, an MCP tool, a skill) you want to drop into a working restorer, see [Path 1](../path-1/README.md) instead.

## 1. Pick a pattern

Three patterns cover the vast majority of Phase A.2 recruit shapes. Full walkthroughs at [patterns/](./patterns/README.md).

| Pattern | When it fits |
|---|---|
| `forecaster` | You have an end-to-end forecasting pipeline — fetch market state, compute a probability, return a prediction.v0 envelope. |
| `evaluator` | You have a custom scoring rule — log-loss, calibration decomposition, Numerai-shape continuous loss — and want to evaluate other impls' restorations. |
| `alternative-harness` | You have a non-Claude-Code learner runtime (Pi.dev, Codex, Gemini CLI) and want to ship the seven-phase pipeline against it. |

## 2. Scaffold

```bash
jinn create restorer @yourname/your-package --pattern <pattern> --kind prediction.v0 --network base-sepolia
```

The scaffolder asks three questions if you don't pass them as flags: pattern (forecaster / evaluator / alternative-harness), kind (`prediction.v0` / `prediction.apy.v0` / `portfolio.v0` / custom), network (`base-sepolia` / `base-mainnet` / custom). It emits a working package:

```
@yourname/your-package/
├── package.json                # depends on @jinn-network/restorer-sdk
├── jinn.manifest.json          # signed at publish time
├── src/
│   └── index.ts                # default-exports the factory
├── test/
│   ├── unit.test.ts            # vitest, mocked context
│   └── e2e-anvil.test.ts       # Anvil fork, full attempt
├── .github/workflows/
│   ├── ci.yml                  # typecheck + test + manifest verify
│   └── publish.yml             # signs manifest + pins tarball + emits CID
├── README.md
├── tsconfig.json
└── .gitignore
```

## 3. Edit + test

```bash
cd @yourname/your-package
yarn install
yarn test                        # vitest, mocked context — passes immediately
yarn vitest run test/e2e-anvil.test.ts   # Anvil fork — full attempt against a synthetic intent
```

The scaffolded `src/index.ts` exports a factory matching the chosen pattern's skeleton. Replace the `TODO` body with your real pipeline; rerun the tests.

The default-export shape (per `spec/2026-05-external-restorer-impls.md` §3.2):

```ts
import type { RestorerImpl, ExternalRestorerEnv } from '@jinn-network/restorer-sdk';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async run(ctx) {
      // your pipeline here
      return { /* RestorationOutput */ };
    },
  };
}
```

See [sdk-reference.md](./sdk-reference.md) for the full type surface.

## 4. Sign + publish manifest

The manifest signing flow is documented in detail at [publishing.md](./publishing.md). The short version:

1. Generate an ed25519 signer key (one-time per maintainer).
2. `npm pack` to produce the tarball; compute its sha256 + IPFS CID.
3. Fill in `jinn.manifest.json` with the package CID + hash + your `supportedKinds` + `capabilities` allow-list.
4. Canonicalise the manifest (sorted keys, signature stripped) and ed25519-sign.
5. Pin the tarball + the manifest to IPFS.
6. Publish the npm package alongside.

The scaffolded `.github/workflows/publish.yml` does steps 2–5 automatically; you supply the signing key as a GitHub Actions secret.

## 5. Operator-side install

The operator (the human running the daemon) runs:

```bash
jinn impls trust ed25519:<base64-pubkey> --label <your-name>
jinn impls add ipfs://<manifest-cid>
```

The first command adds your signing key to the operator's trust store (one-time per maintainer). The second registers your impl: the daemon fetches the manifest from IPFS, verifies the signature against the trust store, validates the package's CID + hash, and appends to `~/.jinn-client/config.json` under `restorers.externalImpls`.

## 6. Daemon dispatches your impl

Restart the daemon. At boot, the loader walks `restorers.externalImpls`, dynamic-imports each entry, and constructs your impl via its factory. On every intent, the engine calls `supports(kind, type)` on each registered impl in order; first match wins. When your impl matches, `run(ctx)` is invoked.

`jinn impls list` shows what's installed; `jinn impls show <name>` shows the manifest; `jinn impls remove <name>` uninstalls.

## Next

- [sdk-reference.md](./sdk-reference.md) — the full `@jinn-network/restorer-sdk` surface.
- [publishing.md](./publishing.md) — manifest signing, IPFS publish, CI config.
- [patterns/](./patterns/README.md) — three worked-pattern walkthroughs.
