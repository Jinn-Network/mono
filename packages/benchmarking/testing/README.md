# @jinn-network/benchmarking-testing

The conformance kit for the Jinn benchmarking application (design §16). Kits precede
implementations (program §7.6): a product proves it implements the frozen §6-§14 surface by
running the `describe…Conformance()` driver for the piece it implements, against fixtures shipped
here.

## What's live in this wave (Phase 5, extension wave 1: `records` + `aggregate` + this kit)

- **`describeRecordConformance()`** — schema validation, producer re-seal, consumer digest
  verification, and the named Benchmark checks, run over `@jinn-network/benchmarking-records`'
  golden fixtures. Green in this package's own suite.
- **`describeMethodRegistryConformance(registry)`** — for each fixture under `fixtures/methods/`,
  `registry.get(id, version)!.compute(...)` must reproduce the pinned `expectedResults` exactly.
  Ground truth for every fixture is computed independently in
  `scripts/generate-method-fixtures.mjs` (closed-form Wilson, the already-shipped
  `packages/core/src/paired.ts` exact-McNemar port, and the Chen 2021 pass@k estimator — never by
  importing `aggregate`). RED here (no registry to run it against); green in
  `@jinn-network/benchmarking-aggregate`'s own suite (M3).
- **`describeOrderingConformance(legs?)`** — leg (a) (structural: a dispatched cell's extension
  block commits to its Run's digest) is real and runs unconditionally against
  `benchmarking-records` alone. Legs (b) (anchored) and (c) (local append-order) run only when a
  caller supplies a transcript; this wave supplies neither (see below).

## What's deferred to later waves

Per the program's extension-wave split (§10), `benchmarking/run` (M4-M5, local-mode) and
`benchmarking/marketplace` (M7) are separate waves. Two drivers are frozen here as **types plus a
loud placeholder body** so those waves implement against a kit-owned contract rather than
inventing their own, but are not exercised by anything in this wave:

- **`describeAssemblyConformance(assemble)`** — needs the design §16 miniature run (a full
  3-item × 2-arm × 2-replicate benchmark run with every outcome, a replacement lineage, a
  multi-verdict cell, and an asymmetry flag, byte-exact against an expected Matrix). Building that
  fixture is `benchmarking/run`'s (M4, wave 2) proving ground — it is authored there, alongside
  the `assembleMatrix` implementation it exists to green.
- **`describeExportConformance(exporters)`** — needs the same miniature run projected through the
  EvalLog and Croissant exporters. Authored with `benchmarking/interop` (M5, wave 2).
- `describeOrderingConformance`'s anchored leg (b) is asserted by `benchmarking/marketplace` (M7,
  wave 3), the only package with a real chain-anchored transcript to check it against.

Calling either placeholder throws immediately rather than reporting a false green — a future
wave replaces the placeholder body when it builds the fixture, it never leaves it silently
unexercised.

## Layout

- `src/record-conformance.ts`, `src/method-conformance.ts`, `src/ordering-conformance.ts` — the
  three live drivers.
- `src/method-types.ts` — `Method`/`MethodRegistry`/`MethodComputeInput`, the injected shape
  `aggregate` implements.
- `src/assembly-types.ts`, `src/export-types.ts` — frozen types + placeholder drivers for the
  deferred pieces above.
- `fixtures/methods/*.json` — one file per method-registry fixture; `parameters`, `verdictRule`,
  raw Matrix documents, a verdict-digest → outcome map, and the pinned `expectedResults`.
  Regenerate with `node scripts/generate-method-fixtures.mjs`.

See `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §16 and
`docs/superpowers/plans/2026-07-28-benchmarking-application.md` M2 for the full design.
