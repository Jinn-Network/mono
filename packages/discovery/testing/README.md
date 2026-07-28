# `@jinn-network/record-discovery-testing`

Conformance testing kit for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`).

Ships the full §18 golden-vector corpus, a reusable conformance harness, in-memory
deterministic fakes for every injected port `@jinn-network/record-discovery-protocol`
defines (including a `FactsRecompute` registry that recomputes the vectors' record facts
from bytes), and the exported `run*Conformance` suites that `protocol` (source-chain and
item verification), `serve` (source conformance), and `client` (query, subscribe, consumer
conformance) drive against their own implementations.

Depends only on `@jinn-network/record-discovery-protocol` — no cross-tree Jinn dependency.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` for the implementation plan.
