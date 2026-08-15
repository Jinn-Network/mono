# Harness SDK quickstart

A 60-second walkthrough for shipping a Harness as an external npm package.

## Audience

Builders with a working forecaster, evaluator, or alternative harness who want it dispatched against Jinn tasks. Polymarket / Kalshi bot operators, Numerai-orbit forecasters, MiroFish-orbit quants, Bittensor SN6 (Numinous Signals) miners, prediction-tool builders. If you only have solverType-specific schemas, MCP tools, or skills for Claude Code, ship a SolverPlugin instead.

## 1. Pick a pattern

Three patterns cover the vast majority of Phase A.2 recruit shapes. Full walkthroughs at [patterns/](./patterns/README.md).

| Pattern | When it fits |
|---|---|
| `forecaster` | You have an end-to-end forecasting pipeline — fetch market state, compute a probability, return a prediction.v0 envelope. |
| `evaluator` | You have a custom scoring rule — log-loss, calibration decomposition, Numerai-shape continuous loss — and want to evaluate other Harnesses' solutions. |
| `alternative-harness` | You have a non-Claude-Code learner runtime (Pi.dev, Codex, Gemini CLI) and want to ship the seven-phase pipeline against it. |

## 2. Scaffold

```bash
jinn create harness @yourname/your-package --pattern <pattern> --solver-type prediction.v0 --network base-sepolia
```

The scaffolder asks three questions if you don't pass them as flags: pattern (forecaster / evaluator / alternative-harness), solverType (`prediction.v0` / `prediction.apy.v0` / `portfolio.v0` / custom), network (`base-sepolia` / `base-mainnet` / custom). It emits a working package:

```
@yourname/your-package/
├── package.json                # depends on @jinn-network/sdk/harness
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
yarn vitest run test/e2e-anvil.test.ts   # Anvil fork — full attempt against a synthetic Task
```

The scaffolded `src/index.ts` exports a factory matching the chosen pattern's skeleton. Replace the `TODO` body with your real pipeline; rerun the tests.

The default-export shape (per `spec/2026-05-external-harnesses.md` §3.2):

```ts
import type { Harness, ExternalHarnessEnv } from '@jinn-network/sdk/harness';

export default function createHarness(env: ExternalHarnessEnv): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role !== 'evaluation';
    },
    async run(ctx) {
      // your pipeline here
      return { /* Solution */ };
    },
  };
}
```

See [sdk-reference.md](./sdk-reference.md) for the full type surface.

## 4. Sign + publish manifest

The manifest signing flow is documented in detail at [publishing.md](./publishing.md). The short version:

1. Generate an ed25519 signer key (one-time per maintainer).
2. `npm pack` to produce the tarball; compute its sha256 + IPFS CID.
3. Fill in `jinn.manifest.json` with the package CID + hash + your `supportedSolverTypes` + `capabilities` allow-list.
4. Canonicalise the manifest (sorted keys, signature stripped) and ed25519-sign.
5. Pin the tarball + the manifest to IPFS.
6. Publish the npm package alongside.

The scaffolded `.github/workflows/publish.yml` does steps 2–5 automatically; you supply the signing key as a GitHub Actions secret.

## 5. Operator-side install

The operator (the human running the daemon) adds your signing key to
`trustedImplSigners[]` once, then registers the package:

```bash
jinn harnesses add ./node_modules/@yourname/your-package
```

The daemon verifies the signature against the trust store, validates the
package's CID + hash, and appends to `~/.jinn-client/config.json` under
`harnesses.externalImpls`.

## 6. Daemon dispatches your Harness

Restart the daemon. At boot, the loader walks `harnesses.externalImpls`, dynamic-imports each entry, and constructs your Harness via its factory. For each Task, the engine resolves the SolverNet and then calls `supports(solverType, role)` on registered Harnesses as needed. When your Harness matches, `run(ctx)` is invoked.

`jinn harnesses list` shows what's installed; `jinn harnesses show <name>` shows the manifest; `jinn harnesses remove <name>` uninstalls.

## Next

- [sdk-reference.md](./sdk-reference.md) — the full `@jinn-network/sdk/harness` surface.
- [publishing.md](./publishing.md) — manifest signing, IPFS publish, CI config.
- [patterns/](./patterns/README.md) — three worked-pattern walkthroughs.
