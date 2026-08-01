# Task 3 report — catalog-driven public surfaces and known guard fixes

## Status

Implemented on `codex/platform-architecture-convergence` from
`956c235f991211fe604594626e21536485ac10e3`, using Node `v22.22.2`.
The publication hold and catalog release-group membership remain unchanged; no receipt
workflow was added.

## Changes

- `buildProfileRoot` now loads packages from a selected catalog release group (default
  `platform-v1`) and walks only human-authored `publicSurface.schemas`, `.profiles`, and
  `.fixtures` declarations.
- Nested declarations share an absolute-source visited set, so one source file is copied
  once. Fixture fallbacks are package-qualified (`@scope/package/<declared path>`) so fixture
  corpora with identical relative names cannot overwrite each other; fixtures remain exempt
  from `$id`/`profile` identity remapping.
- Non-fixture `$id` and top-level `profile` claims are served at their identifier paths;
  duplicate claims now fail even when both files are in the same package.
- The real core root includes both evidence-trajectory schema identities and contains no
  documents from the seven-package experimental environment/supply group. Selecting
  `experimental-environment-supply` includes
  `records/environment/1.0/schema` from `@jinn-network/environment-record`.
- Publication validation is now a reusable catalog-driven guard. It rejects missing
  declarations, declarations outside `files`, packed static schema/profile/fixture trees
  absent from the matching catalog field, missing conformance export keys, and declared
  packed asset paths with no reachable export target. Compiled `dist` module trees are not
  mistaken for static publication assets, so the guard is build-state independent.
- The previously packed IPFS repository profile and nested fixtures are now explicitly
  declared in the catalog.
- `@jinn-network/task-execution-evaluator-adapters` now exports `./fixtures/*`; its fixture
  files remain in `files` and were observed in `npm pack --dry-run --ignore-scripts --json`.
- The process-spawning launcher test moved from `src/launchers.test.ts` to
  `test/launchers.test.ts`. Vitest discovers both `src/**/*.test.ts` and
  `test/**/*.test.ts`; `tsconfig.json` remains rooted at and limited to `src`.

## RED evidence

All RED runs used `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.

### Profile-root behavior

Command:

```text
node --test .github/scripts/build-profile-root.test.mjs
```

Observed before implementation: `15` tests, `11` pass, `4` fail.

- catalog-only path test expected declared `api/schema-documents` and `api/examples`, but
  the old directory inference emitted only undeclared `profiles/undeclared.json`;
- nested declarations expected one schema, but old generation emitted none;
- duplicate same-package `$id` claims did not throw;
- release-group test expected the trajectory schema but received an empty core root.

Additional fixture-collision RED:

```text
node --test --test-name-pattern='fixture paths are package-qualified' \
  .github/scripts/build-profile-root.test.mjs
```

Observed: `0` pass, `1` fail with
`fixtures/example.json is claimed by both @jinn-network/benchmarking-records and @jinn-network/evidence-trajectory`.

### Publication-surface behavior

Command:

```text
node --test --test-name-pattern='declared schema|packed schema|declared conformance|packed declared' \
  .github/scripts/stack-publication-surface.test.mjs
```

Observed before implementation: `4` tests, `0` pass, `4` fail. The old top-level directory
inference returned no violations for missing/unpacked declarations, packed undeclared
directories, absent conformance exports, or unreachable declared nested fixtures.

Build-state regression RED:

```text
node --test --test-name-pattern='compiled module' \
  .github/scripts/stack-publication-surface.test.mjs
```

Observed: `0` pass, `1` fail because a built `dist/schemas` module directory was incorrectly
reported as an undeclared static schema surface. The guard now excludes compiled `dist`
trees from static-asset discovery.

### Known red guards

Command:

```text
node --test .github/scripts/stack-publication-surface.test.mjs \
  .github/scripts/fixture-manifest.test.mjs
```

Observed before manifest/export fixes: `8` tests, `6` pass, `2` fail.

- fixture-manifest guard reported missing manifests for
  `packages/evidence/trace-decode`, `packages/evidence/trajectory`, and
  `packages/task-execution/evaluator-adapters`;
- publication guard reported evaluator-adapters `fixtures/` packed without an export.

Command:

```text
node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Observed before relocation: `7` tests, `6` pass, `1` fail with
`packages/task-execution/backend-local/launchers/src/launchers.test.ts -> node:child_process`.

## GREEN evidence

### Focused guards

Command:

```text
node --test .github/scripts/fixture-manifest.test.mjs \
  .github/scripts/stack-publication-surface.test.mjs \
  .github/scripts/build-profile-root.test.mjs
```

Observed after implementation: `28/28` pass in the first focused run. The profile test was
then strengthened with a real-repository core/experimental assertion.

Command:

```text
node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Observed after relocation: `7/7` pass; the production scanner still enforces the
`node:child_process` ban over `launchers/src`.

Command (after building the portal dependency chain):

```text
corepack yarn --cwd packages/task-execution/backend-local/launchers test
```

Observed: `6` test files passed, `32/32` tests passed, including
`test/launchers.test.ts` and its real spawned prediction baseline.

## Final verification

Node guard suite:

```text
node --test \
  .github/scripts/platform-catalog.test.mjs \
  .github/scripts/stack-package-graph.test.mjs \
  .github/scripts/build-profile-root.test.mjs \
  .github/scripts/stack-publication-surface.test.mjs \
  .github/scripts/fixture-manifest.test.mjs \
  .github/scripts/task-execution-source-boundaries.test.mjs
```

Observed fresh: `98/98` tests passed, `0` failed.

Additional fresh checks:

```text
node .github/scripts/fixture-manifest.mjs --check
# fixture manifests are current

corepack yarn test
# launchers: 6 files passed, 32/32 tests passed

corepack yarn typecheck
# exit 0

npm pack --dry-run --ignore-scripts --json
# evaluator-adapters: 7 entries, including all four fixture payloads/READMEs and manifest.sha256.json
```

## Fixture-manifest metadata update (separate record)

The catalog-driven checks exposed three existing fixture directories without
`fixtures/manifest.sha256.json`. Added deterministic manifests only for:

- `packages/evidence/trace-decode/fixtures` (`21` existing payload entries);
- `packages/evidence/trajectory/fixtures` (`21` existing payload entries);
- `packages/task-execution/evaluator-adapters/fixtures` (`4` existing payload entries).

No fixture payload bytes or semantics changed. `fixture-manifest.mjs --check` reports all
catalogued platform fixture manifests current.

## Files changed

- `.github/scripts/build-profile-root.mjs`
- `.github/scripts/build-profile-root.test.mjs`
- `.github/scripts/stack-publication-surface.mjs` (new)
- `.github/scripts/stack-publication-surface.test.mjs`
- `architecture/platform-packages.v1.json`
- `packages/evidence/trace-decode/fixtures/manifest.sha256.json` (new)
- `packages/evidence/trajectory/fixtures/manifest.sha256.json` (new)
- `packages/task-execution/evaluator-adapters/package.json`
- `packages/task-execution/evaluator-adapters/fixtures/manifest.sha256.json` (new)
- `packages/task-execution/backend-local/launchers/src/launchers.test.ts` (moved)
- `packages/task-execution/backend-local/launchers/test/launchers.test.ts` (move target)
- `packages/task-execution/backend-local/launchers/vitest.config.ts`
- `.superpowers/sdd/phase-a-platform-architecture-convergence/task-3-report.md`

## Self-review

- Compared each Task 3 requirement against a behavioral test or real guard assertion.
- Confirmed catalog membership counts, release policies, and publication hold remain green
  through the canonical catalog and 50-package graph tests.
- Confirmed no directory-name fallback remains in profile generation; only publication
  validation discovers packed static asset directories, solely to reject catalog omissions.
- Confirmed fixture documents do not become identity claims and package qualification avoids
  destructive overwrite in the combined root.
- Confirmed same-package and cross-package identity collisions both fail.
- Confirmed the launcher move is byte-equivalent except for relative imports and that
  production TypeScript still includes only `src/**/*`.
- Ran `git diff --check` before the report and repeated final verification before commit.

## Concerns

- Package-qualifying fixture fallback paths was necessary because catalog-declared fixture
  corpora contain distinct files with identical package-relative names. Self-identifying
  schemas/profiles are unaffected and still resolve exactly at their `https://jinn.network/`
  identifiers.
- Launcher package tests require its portal dependencies to have built `dist` entry points;
  this is pre-existing package setup behavior. After building the dependency chain, the
  relocated real test is collected and passes.
