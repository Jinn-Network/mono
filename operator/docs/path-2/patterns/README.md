# Path 2 patterns

Three patterns cover the vast majority of Phase A.2 recruit shapes. Each is a complete worked example shipped under `examples/external-harnesses/`, with a passing `yarn test` and a passing e2e Anvil test.

| Walkthrough | Pattern | Example package | Recruit shape | In-repo anchor |
|---|---|---|---|---|
| [forecaster.md](./forecaster.md) | `forecaster` | [`examples/external-harnesses/polymarket-forecaster`](../../../../examples/external-harnesses/polymarket-forecaster) | Polymarket / Kalshi bot operator with a working forecasting pipeline. | [`operator/src/harnesses/impls/prediction-v0-baseline/`](../../../../client/src/harnesses/impls/prediction-v0-baseline) |
| [evaluator.md](./evaluator.md) | `evaluator` | [`examples/external-harnesses/prediction-evaluator`](../../../../examples/external-harnesses/prediction-evaluator) | Evaluator-builder with a custom scoring rule. | [`operator/src/harnesses/impls/prediction-v0-evaluator/`](../../../../client/src/harnesses/impls/prediction-v0-evaluator) |
| [alternative-harness.md](./alternative-harness.md) | `alternative-harness` | [`examples/external-harnesses/alternative-harness`](../../../../examples/external-harnesses/alternative-harness) | Harness builder running Pi.dev, Codex, Gemini CLI, or a custom runtime. | [`operator/plugins/claude-code-learner/`](../../../../client/plugins/claude-code-learner) |

Each walkthrough follows the same shape: recruit shape → what the pattern does → manifest → entry walkthrough → test → publish → replace-the-stub.

The example packages are scoped under `@jinn-examples/` and not signed for production trust — the manifest's `signature.publicKey` and `signature.sig` fields are placeholders. To run an example end-to-end against your own daemon, follow the install steps in the walkthrough using your own signing key.
