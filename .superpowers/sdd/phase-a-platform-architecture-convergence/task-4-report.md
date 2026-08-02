# Task 4 report — same-run platform verification and immutable receipts

## Status

Complete on `codex/platform-architecture-convergence` from base
`8a4b51507ed9d164a9148b19696482235746bb9d`, using Node `v22.22.2`.
The existing stack publisher and the Task 1 publication hold remain unchanged.

## Implementation

### Prepublication bundle

- Added `build-prepublication-bundle.mjs`, which validates the 40-character source SHA,
  checked-out catalog SHA-256, `platform-v1` group, and canary/stable lane before any
  package command runs.
- It reuses the existing `buildPublishPlan` and `packWave` implementations, installs,
  builds, and packs the exact 50-package runtime graph in its seven dependency-first waves,
  and never invokes a publication command.
- It writes a recursively key-sorted, compact JSON manifest with a trailing newline. The
  manifest binds source/catalog identity, lane/group, computed version and dist-tag, waves,
  package order, and each tarball's relative filename and SHA-512 SRI.
- Caller output is explicit and fail-closed: existing manifest/tarball output is refused,
  tarballs cannot escape the bundle, and the planned package set must exactly equal the
  catalog release group.

### Clean external consumer

- Added `prepublication-external-consumer.mjs`. It verifies the manifest, exact package set
  and order, all tarball files, and every SRI before starting npm.
- It creates a fresh temporary package with all 50 tarballs as direct `file:` roots. The
  `@jinn-network` registry is set to unreachable loopback port 9, retries are disabled,
  `HOME` and the npm cache are isolated inside the consumer, and `NODE_AUTH_TOKEN` is
  removed. Non-Jinn third-party dependencies can still come from the public npm registry.
- A standalone probe runs from the temporary consumer, so resolution cannot fall back to
  workspace packages. It verifies installed name/version/gitHead, the exact ordered export
  map, every explicit and conditional wildcard target, root and conformance imports, and
  every source-inventoried schema/profile/fixture file and directory.
- The probe exposed two dead wildcard exports on record-discovery client/serve: both
  packages claimed `./fixtures/*` without packing any fixtures. Those two false exports were
  removed, and both packages pass their real tarball `pack:smoke` consumers.

### Public/profile artifacts and immutable receipt

- Added `build-platform-public-surface.mjs`, which reuses the catalog-driven publication
  guard and writes a canonical exact-50 package surface manifest bound to source, catalog,
  group, and lane.
- Extended `build-profile-root.mjs` so its manifest binds the checked-out catalog digest,
  release group, lane, and exact source package set while retaining its existing document
  path/digest/source-package inventory.
- Added `platform-verification-receipt.mjs`. It accepts pack/public/profile manifests plus
  named conclusions for the nine required gates. It rejects missing, extra, or non-`success`
  conclusions before reading artifacts; independently re-derives the catalog package set,
  runtime waves, order, version, and dist-tag; verifies all tarball files/SRIs and surface
  identities; and refuses to overwrite an existing receipt.
- The canonical receipt binds source/catalog/group/lane, version/tag, waves/order, the
  prepublication-manifest digest, tarball records, public/profile manifest digests and
  contents, and every gate conclusion.

### Reusable verification workflow

- Added `.github/workflows/platform-verification.yml` with required `source_sha` and `lane`
  inputs and one optional, explicitly named marketplace fork-RPC secret.
- The `catalog` job requires `source_sha == github.sha == checked-out HEAD`, validates the
  canonical catalog, and exports its digest.
- Benchmarking, record-discovery, evidence, marketplace, task-execution, and trust are six
  static local reusable-workflow calls. Their existing pull-request/push triggers remain;
  task-execution also retains its dispatch trigger.
- Only the marketplace call receives its named optional RPC secret. The other domain calls
  receive no caller secrets.
- `artifacts` builds the public surface, profile root, and exact tarball bundle; attests all
  subjects with `actions/attest@v4`; and uploads the same-run bundle. Uploads explicitly opt
  into dot-directory contents, required by upload-artifact v4.4+.
- `external_consumer` downloads only that same-run artifact and runs the clean tarball
  consumer. The final `verification_receipt` job uses `if: always()`, passes every exact
  `needs.<job>.result`, fails unless all nine are `success`, and attests/uploads the receipt
  only after success.
- The workflow contains no npm publication command, registry wait loop, permissive polling,
  publisher call, or accepted non-success result.

## TDD evidence

### RED

Behavior-first tests failed before each implementation slice:

- the bundle, consumer, public-surface, and receipt tests initially failed with
  `ERR_MODULE_NOT_FOUND` for their absent modules;
- profile-root provenance expected a catalog binding and received `undefined`;
- the workflow contract test initially failed with `ENOENT` for the absent reusable
  workflow;
- clean-consumer mutations initially demonstrated that one missing public file in a
  nonempty directory, export-map drift, and a missing conditional wildcard `.d.ts` target
  were not rejected;
- the source wildcard guard reported the client and serve `./fixtures/*` claims as having
  no source targets to pack;
- review hardening tests failed because both dot-directory uploads omitted
  `include-hidden-files: true`, all six domain calls inherited every caller secret, and the
  new workflow used older checkout/setup-node action majors than the current release gates;
- the first repository-wide parallel run also exposed that the bundle test temporarily
  rewrote real checkout manifests. Its pack test now uses an isolated controlled 50-package
  repository and never touches the shared checkout.

### GREEN

Fresh final focused command:

```text
/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test --test-concurrency=1 \
  .github/scripts/build-platform-public-surface.test.mjs \
  .github/scripts/build-prepublication-bundle.test.mjs \
  .github/scripts/build-profile-root.test.mjs \
  .github/scripts/platform-verification-receipt.test.mjs \
  .github/scripts/platform-verification-workflow.test.mjs \
  .github/scripts/prepublication-external-consumer.test.mjs
```

Result: `51/51` tests passed, `0` failed. This includes exact-success-only receipt
conclusions; failed/skipped/neutral/cancelled/missing gates; source, catalog, package-set,
and missing-tarball drift; exact 50-package/wave planning; no publication; unreachable
scoped fallback; isolated consumer state; installed export/public-target resolution; and
workflow provenance/least-privilege assertions.

Additional real package checks:

```text
corepack yarn@4.13.0 pack:smoke
```

Result: both modified record-discovery client and serve packages built, packed, installed in
fresh consumers, and imported successfully.

## Final verification

- All 11 changed/new `.mjs` files pass Node 22 `--check`.
- `actionlint` passes the new workflow and all six changed domain workflows.
- `git diff --check` passes.
- Independent review found and this task fixed four important issues under RED/GREEN tests:
  dot-directory artifact exclusion, over-broad reusable-workflow secret inheritance,
  shared-checkout mutation in the bundle test, and stale action majors in the new workflow.

## Files changed

- `.github/scripts/build-platform-public-surface.mjs` and test
- `.github/scripts/build-prepublication-bundle.mjs` and test
- `.github/scripts/prepublication-external-consumer.mjs` and test
- `.github/scripts/platform-verification-receipt.mjs` and test
- `.github/scripts/platform-verification-workflow.test.mjs`
- `.github/scripts/build-profile-root.mjs` and test
- `.github/workflows/platform-verification.yml`
- `.github/workflows/benchmarking-ci.yml`
- `.github/workflows/record-discovery-ci.yml`
- `.github/workflows/evidence-ci.yml`
- `.github/workflows/marketplace-ci.yml`
- `.github/workflows/task-execution-ci.yml`
- `.github/workflows/trust-ci.yml`
- `packages/discovery/client/package.json`
- `packages/discovery/serve/package.json`
- `.superpowers/sdd/phase-a-platform-architecture-convergence/task-4-report.md`

## Self-review

- Compared every exact Task 4 interface and workflow requirement with a behavior test or
  changed-workflow assertion.
- Confirmed source/catalog identities fail before package execution, every generated
  manifest carries the required provenance, and receipt generation independently validates
  the checked-out catalog and actual tarball bytes.
- Confirmed the consumer process runs outside the workspace with all 50 packages as direct
  tarball roots and an unreachable scoped fallback.
- Confirmed all existing domain triggers remain present and reusable calls are static.
- Confirmed artifact upload/attestation subjects cover tarballs, pack manifest, public
  manifest, full profile root, and the final receipt.
- Confirmed the Task 1 hold and existing publisher workflow were not modified.

## Concerns

- A repository-wide `node --test .github/scripts/*.test.mjs` invocation ran filesystem-
  mutating packed-type suites concurrently and finished `453/496`, with 43 failures from
  missing generated `dist` entrypoints plus the unrelated existing custody finding at
  `packages/marketplace/venue-base/src/state/database.ts`. This is not the CI execution
  model: domain workflows build prerequisites in dependency order. A serial changed-scope
  run passed `230/232`; its two non-Task-4 results were the existing publisher dry-run test
  intentionally rejecting this task's dirty worktree and record-discovery packed types run
  without its CI-built distributions. These broad-suite findings were not changed here.
- Whole-repository `actionlint` reports four existing SC2129 style warnings in
  `docker.yml` and `release-notes-scaffold.yml`; all seven workflows changed by Task 4 are
  clean.
- Task 5's caller must grant the reusable verification jobs `id-token: write`,
  `attestations: write`, and `artifact-metadata: write`, and should pass only the optional
  marketplace RPC secret if desired. Reusable workflows cannot elevate caller permissions.

## Review round 1/5 — Important findings

### Finding 1: receipt trusted an incomplete profile artifact

Root cause: the receipt checked profile identity, package membership, and source-package
membership, but accepted the submitted `documents` array as its own authority. It did not
re-derive the catalog-driven inventory or inspect the sibling profile-root files.

RED command (Node `v22.22.2`):

```text
node --test .github/scripts/platform-verification-receipt.test.mjs
```

Observed RED: `10` tests, `7` pass, `3` fail. Missing, extra, and digest-drifted manifest
documents; missing, modified, and extra profile-root files; and a `../` document path all
failed with `Missing expected exception` because the old receipt accepted them.

Fix:

- Rebuild the expected profile manifest in a fresh temporary directory from the checked-out
  source, catalog digest, source SHA, release group, and lane; the submitted manifest is not
  used to derive expectations and source files are never modified.
- Require the submitted document inventory to exactly equal the independently generated
  inventory, including path, SHA-256, media type, source package, order, and cardinality.
- Require canonical contained forward-slash paths with no duplicates or traversal.
- Walk the submitted profile root, reject symlinks/unsupported or unexpected files, require
  every expected document file, and recompute each actual file's SHA-256.

GREEN: the focused receipt test passed `10/10`, including every drift mutation above.

### Finding 2: requested SHA was implicit in reusable domain checkouts

Root cause: the platform workflow and six called workflows relied on the caller event's
default checkout SHA. The explicit `source_sha` was not passed to domains, and the catalog
job incorrectly required it to equal `github.sha`, preventing a later caller from verifying
an authoritative peeled tag SHA.

RED command (Node `v22.22.2`):

```text
node --test .github/scripts/platform-verification-workflow.test.mjs
```

Observed RED: `12` tests, `7` pass, `5` fail. The workflows lacked required domain inputs,
static caller propagation, explicit refs on all platform/domain checkouts, and still tied the
input to caller context.

Fix:

- Added required `workflow_call.inputs.source_sha` to all six domain workflows.
- Passed `source_sha: ${{ inputs.source_sha }}` through all six static platform calls.
- Bound all `58` domain checkout steps to
  `${{ inputs.source_sha || github.sha }}`, preserving direct pull-request, push, and dispatch
  triggers while making reusable calls explicit.
- Bound all four platform checkout steps directly to `${{ inputs.source_sha }}`.
- Removed only the `source_sha == github.sha` restriction; catalog validation still requires
  checked-out `HEAD == source_sha` and validates/exports the catalog digest.

GREEN: the focused workflow test passed `12/12`; `actionlint` passed the platform workflow
and all six changed domain workflows.

### Review-round final verification

The combined Task 4 suite passed `58/58`, `0` failed. Changed-workflow `actionlint` and
`git diff --check` passed. Task 5 and the existing publisher were not modified.
