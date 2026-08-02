# Task 5 report — receipt-gated canary publication

## Status

Complete on `codex/platform-architecture-convergence` from base
`e367d8ac0c7a141862a0d5900aa3e3122b6e33fe`, using Node `v22.22.2`.
No npm publication, push, tag, deployment, pull request, or repository-setting mutation
was performed.

## Implementation

### Fail-closed receipt publisher

- Added `.github/scripts/publish-verified-platform.mjs`, an injectable publisher that
  accepts only the checked-out repository, same-run verification artifact root, immutable
  verification receipt, exact 40-character source SHA, `platform-v1` canary lane, canonical
  repository identity `Jinn-Network/mono`, and exact npm destination
  `https://registry.npmjs.org/`.
- It reconstructs Task 4's canonical verification receipt from the checked-out catalog and
  submitted pack/public/profile manifests, then requires byte-for-byte equality with the
  attested receipt. This revalidates exact successful gates, source/catalog/group/lane,
  the 50-package set, runtime waves/order, computed canary version/tag, actual tarball
  filenames and SHA-512 SRI, and actual public/profile bytes and digests.
- The pack directory is closed over the receipt inventory: missing, extra, unsupported, or
  symbolic-link entries fail. Task 4's receipt reconstruction likewise closes and
  rehashes the public and profile surfaces.
- The publisher validates the generated trusted-publisher JSON as exactly 50 registrations
  with the receipt's package set and fixed provider/organization/repository/workflow/blank-
  environment fields. Its Markdown must be the exact canonical rendering of that JSON.
- Before any npm command, it runs strict GitHub attestation verification for the pack
  manifest, all 50 tarballs, public manifest, profile manifest and all profile documents,
  both trusted-publisher prerequisite files, and the verification receipt. Every invocation
  is bound to the exact repository, signer workflow
  `Jinn-Network/mono/.github/workflows/platform-verification.yml`, and source digest.
- Registry execution removes long-lived npm token variables. Every registry query and
  publication explicitly uses the canonical registry; publication uses only receipt
  tarballs with `--access public --provenance --tag canary`. No build, pack, manifest
  rewrite, or checkout package path exists in the publisher.
- The full 50-package registry state is preflighted before the first mutation. Existing
  versions are idempotent only when version, SRI, and canary tag exactly match. Missing
  versions publish in receipt wave order.
- Each newly published tarball is reverified before the next tarball can publish. Only
  expected propagation states (E404, temporarily absent value, or lagging tag) receive a
  bounded injectable retry; integrity drift, malformed output, authentication/network
  errors, and other registry failures stop immediately.
- A final independent pass requires all 50 versions, SRIs, and canary tags. Only then is a
  canonical publication receipt written, binding the verification-receipt digest,
  source/catalog/group/lane, version/tag, waves/order, exact npm destination,
  trusted-publisher prerequisite digests, and observed registry state. An existing output
  path fails before external access.

### Verification and publication workflows

- Replaced the old publisher job with a direct reusable call to
  `.github/workflows/platform-verification.yml` at exact `github.sha`, lane `canary`,
  least required permissions, and only the named marketplace fork-RPC secret.
- The canary publisher directly needs that job and runs only on its exact `success`.
  It downloads exactly the current run's `platform-verification-artifacts` and
  `platform-verification-receipt`, provides explicit `GH_TOKEN`, invokes the receipt
  publisher, then attests and uploads the immutable publication receipt.
- Moved trusted-publisher registration generation into the reusable verification artifact
  job and added both canonical files to the attestation subjects. Registration/profile
  work is no longer a parallel best-effort publication prerequisite.
- Removed workflow-run polling, permissive conclusions, the temporary Phase A boolean,
  legacy pack/publish/registry-wait paths, and parallel registration/profile jobs.
- Preserved push/release/manual triggers and cross-branch canary serialization.
- Stable remains verification-only and mechanically red: it requires an exact
  `stack-v<major>.<minor>.<patch>` tag, checks checked-out `HEAD` against both the local
  peeled tag and peeled origin tag, requires one coherent `platform-v1` manifest version
  equal to the tag, and runs the existing read-only fixture-immutability registry baseline
  before reusable lane-`stable` verification. Its terminal live-profile-host blocker
  always exits 1. There is no stable npm publication job or publication environment.

## TDD evidence

### RED

Behavior-first failures were observed before each implementation slice:

- The new publisher suite initially failed with `ERR_MODULE_NOT_FOUND`; the rewritten
  workflow contract had nine failures against the polling publisher.
- Receipt/source/catalog/surface/tarball/package-set/wave/order/version/tag/provenance/
  destination mutations were added before their validator behavior.
- Hardening tests produced seven failures before registration generation/attestation,
  canonical repository identity, explicit `GH_TOKEN`, and per-tarball propagation
  verification were implemented.
- With registration validation deliberately bypassed, the registration-drift mutation test
  failed with `Missing expected rejection`; restoring the real validator made it green.
- The stable prerequisite contract failed before exact semver-tag, coherent manifest
  version, fixture baseline, and failing host blocker behavior existed.
- Final self-review added a checked-out-`HEAD` invariant: the focused stable test failed
  because `git rev-parse HEAD` was absent, then passed after comparing it to the peeled
  origin tag.

### GREEN

Fresh adjacent regression command:

```text
/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test \
  .github/scripts/publish-verified-platform.test.mjs \
  .github/scripts/stack-publish-workflow.test.mjs \
  .github/scripts/platform-verification-workflow.test.mjs \
  .github/scripts/platform-verification-receipt.test.mjs \
  .github/scripts/build-prepublication-bundle.test.mjs \
  .github/scripts/publish-stack-run.test.mjs \
  .github/scripts/publish-stack.test.mjs \
  .github/scripts/stack-publish-manifest.test.mjs \
  .github/scripts/stack-trusted-publishers.test.mjs \
  .github/scripts/stack-publication-surface.test.mjs
```

Result: `88/88` passed, `0` failed. All publisher/provenance/registry behavior uses
injected execution; no test invokes a real registry mutation.

Additional checks:

- `actionlint` passes both changed workflows.
- Node 22 `--check` passes all four changed/new JavaScript files.
- `git diff --check` passes.

## Files changed

- `.github/scripts/publish-verified-platform.mjs`
- `.github/scripts/publish-verified-platform.test.mjs`
- `.github/scripts/stack-publish-workflow.test.mjs`
- `.github/scripts/platform-verification-workflow.test.mjs`
- `.github/workflows/stack-npm-publish.yml`
- `.github/workflows/platform-verification.yml`
- `.superpowers/sdd/phase-a-platform-architecture-convergence/task-5-report.md`

## Self-review

- Matched every Task 5 binding behavior and required test to a behavioral or workflow
  assertion, including all non-success/stale identities, all receipt dimensions, exact
  same-run artifacts, no repack path, full-set preflight, wave order, idempotence,
  post-publish stop/retry behavior, final receipt binding, and stable mechanical disablement.
- Confirmed validation order is local arguments/immutable output, reconstructed receipt and
  artifact bytes, trusted-publisher prerequisites, strict GitHub provenance, full registry
  preflight, receipt-wave publication with per-package verification, then final full-set
  verification and receipt emission.
- Confirmed the workflow grants only the permissions required by reusable artifact
  attestation and publisher OIDC/attestation, and passes no inherited secret set.
- Confirmed no experimental or stable publication path was introduced.

## Concerns

- Real GitHub attestation verification and npm trusted publication were intentionally not
  exercised locally. Their command shapes and failure ordering are covered with injected
  behavioral tests and workflow assertions; the first real canary run remains the external
  integration proof.
- Stable verification intentionally ends in a failing blocker until live profile-host
  verification is implemented. Its fixture baseline performs read-only npm registry access,
  but there is no stable publication operation.
