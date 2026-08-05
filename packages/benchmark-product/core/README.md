# @jinn-network/benchmark-product-core

The Tier 4 product core of the standalone benchmark product, incubating under the internal
placeholder codename `benchmark-product`: the branding surface and the platform consumption seam
the rest of the product builds on.

**Authority:**
[`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
Program:
[`docs/superpowers/plans/2026-08-05-standalone-benchmarking-product-program.md`](../../../docs/superpowers/plans/2026-08-05-standalone-benchmarking-product-program.md).

Publication is disabled. Nothing in tiers 1–3 may reference this package, and nothing does.

## Local verification

The two portal dependencies must be built from source first, in dependency order:

```bash
(cd packages/task-execution/protocol && yarn install --immutable && yarn build)
(cd packages/benchmarking/records && yarn install --immutable && yarn build)
```

Then, in this package:

```bash
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

## Branding

Product branding lives in [`src/branding.ts`](src/branding.ts). The display name is deliberately
a placeholder (spec §9) — a later branding engagement replaces it with no architectural change.
