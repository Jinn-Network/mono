# Path 1 worked examples

Six examples ship under `examples/learner-plug-ins/@jinn-examples/`, one per slot category. Each is a complete npm package with a passing `yarn test`. Builders fork the closest example to their recruit shape, swap the example's stub logic for their own, publish.

| Walkthrough | Slot | Example package | Recruit shape |
|---|---|---|---|
| [phase-agent-override.md](./phase-agent-override.md) | `phase-agent-override` | [`@jinn-examples/calibration-refiner`](../../../../examples/learner-plug-ins/@jinn-examples/calibration-refiner) | Calibration-model author (Silverarrow shape). |
| [topic-explorer.md](./topic-explorer.md) | `topic-explorer` | [`@jinn-examples/news-context-topic`](../../../../examples/learner-plug-ins/@jinn-examples/news-context-topic) | Context-aggregation builder. |
| [mcp-tool.md](./mcp-tool.md) | `mcp-tool` | [`@jinn-examples/polymarket-mcp`](../../../../examples/learner-plug-ins/@jinn-examples/polymarket-mcp) | Prediction-tool builder with a venue API. |
| [skill-bundle.md](./skill-bundle.md) | `skill-bundle` | [`@jinn-examples/forecasting-techniques`](../../../../examples/learner-plug-ins/@jinn-examples/forecasting-techniques) | Skill author with documented techniques. |
| [memory-backend.md](./memory-backend.md) | `memory-backend` | [`@jinn-examples/vector-store-memory`](../../../../examples/learner-plug-ins/@jinn-examples/vector-store-memory) | Memory-substrate builder. |
| [hook.md](./hook.md) | `hook` | [`@jinn-examples/prefetch-markets-hook`](../../../../examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook) | Infra-tool author with a pre-fetch optimisation. |

Each walkthrough follows the same shape: recruit shape → what the slot does → manifest → entry walkthrough → test → install → run → replace-the-stub.

The example packages are scoped under `@jinn-examples/` and not published to npm — they exist for local clone, fork, and reference. To run an example end-to-end against your own daemon, follow the install steps in the walkthrough using `yarn add file:.../examples/learner-plug-ins/@jinn-examples/<name>`.
