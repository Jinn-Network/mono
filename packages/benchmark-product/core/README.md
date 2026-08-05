# @jinn-network/benchmark-product-core

The Tier 4 product core of the standalone benchmark product, incubating under the internal
placeholder codename `benchmark-product`: the product domain (workspace, draft model, lifecycle
state machine, audit journal, principals/authority), the operations-library facade that is the
single trusted boundary (spec §5.1), and the CLI agent surface — plus the branding surface and
the platform consumption seam.

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

## CLI

The bin is `benchmark-product` (`dist/cli/bin.js` after `yarn build`). Every verb takes
`--workspace <dir>`, `--principal <id>`, and `--json` (machine-readable
`{ok: true, result} | {ok: false, error: {code, detail}}` envelopes; exit codes: 0 success,
2 invalid invocation, 3 authority denied, 1 other typed errors):

```bash
benchmark-product init --workspace ./bench --principal sponsor-1
benchmark-product draft create --workspace ./bench --principal sponsor-1 --name "My comparison"
benchmark-product draft update --workspace ./bench --principal sponsor-1 --draft my-comparison --file patch.json
benchmark-product draft show   --workspace ./bench --principal sponsor-1 --draft my-comparison
benchmark-product draft list   --workspace ./bench --principal sponsor-1
benchmark-product inspect      --workspace ./bench --principal sponsor-1 --draft my-comparison
```

The workspace directory holds `workspace.json`, `authority.json`, `drafts/`, `records/`
(sealed bytes, digest-addressed), `artifacts/`, and the append-only `journal.jsonl` audit
journal (spec §4.4–§4.5). Authority enforcement is local-process policy (spec §4.2): it
provides supervisability and attribution, not cryptographic access control.

## Branding

Product branding lives in [`src/branding.ts`](src/branding.ts). The display name is deliberately
a placeholder (spec §9) — a later branding engagement replaces it with no architectural change.
