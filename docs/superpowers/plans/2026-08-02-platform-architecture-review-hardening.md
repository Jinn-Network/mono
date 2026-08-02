# Platform Architecture Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PR #2360's release-security and architecture-authority findings while preserving the fail-closed Phase A release topology.

**Architecture:** Keep `architecture/platform-packages.v1.json` as the single human-authored membership and release-policy authority. Repository-wide manifest discovery independently proves catalog completeness; operational release code derives package sets and counts from the selected catalog group. Package-controlled build jobs never receive OIDC, while artifact-only jobs attest immutable downloads, and npm trusted publishing is restricted to the `npm-publish` deployment environment and `npm publish` action.

**Tech Stack:** Node.js 22 ESM, `node:test`, JSON Schema Draft 2020-12, GitHub Actions reusable workflows, npm 11 trusted publishing, GitHub artifact attestations.

## Global Constraints

- Preserve the current 69-entry topology: 50 `platform-v1`, 7 disabled experiments, 8 other packages-root entries, and 4 adjacent entries.
- Stable publication remains disabled until the live `jinn.network` profile-host deployment is verified.
- Only the final publication job may enter the `npm-publish` GitHub environment.
- Jobs that check out or execute package-controlled code must not receive `id-token: write` or `attestations: write`.
- No npm trusted-publisher, package, tag, hosted profile, branch-protection, or deployment-environment setting is mutated without explicit administrator authorization.
- Each production behavior change follows red-green-refactor and is committed independently.

---

### Task 1: Isolate OIDC and bind npm trusted publishing to the deployment environment

**Files:**
- Modify: `.github/scripts/stack-trusted-publishers.mjs`
- Modify: `.github/scripts/stack-trusted-publishers.test.mjs`
- Modify: `.github/scripts/publish-verified-platform.mjs`
- Modify: `.github/scripts/publish-verified-platform.test.mjs`
- Modify: `.github/workflows/platform-verification.yml`
- Modify: `.github/scripts/platform-verification-workflow.test.mjs`
- Modify: `.github/workflows/stack-npm-publish.yml`
- Modify: `.github/scripts/stack-publish-workflow.test.mjs`
- Modify: `docs/runbooks/stack-npm-publishing.md`

**Interfaces:**
- Consumes: the catalog-derived `platform-v1` package set and same-run GitHub artifacts.
- Produces: registrations shaped as `{ package, provider, organization, repository, workflow, environment: "npm-publish", allowedActions: ["npm publish"] }`; separate `artifact_attestation` and `receipt_attestation` jobs.

- [ ] **Step 1: Write failing trusted-publisher tests**

Add assertions that every generated registration has `environment === 'npm-publish'` and `allowedActions` exactly equal to `['npm publish']`, and that publisher validation rejects a blank environment, a missing allowed action, or an extra allowed action.

- [ ] **Step 2: Run the focused registration/publisher tests and verify RED**

Run:

```bash
node --test .github/scripts/stack-trusted-publishers.test.mjs .github/scripts/publish-verified-platform.test.mjs
```

Expected: failures report the current blank environment and missing `allowedActions` contract.

- [ ] **Step 3: Write failing workflow-boundary tests**

Assert observable workflow structure:

```js
assert.doesNotMatch(jobBlock(platform, 'artifacts'), /id-token: write|attestations: write|actions\/attest/);
assert.doesNotMatch(jobBlock(platform, 'verification_receipt'), /id-token: write|attestations: write|actions\/attest/);
assert.match(jobBlock(platform, 'artifact_attestation'), /actions\/download-artifact@v4[\s\S]*actions\/attest@v4/);
assert.doesNotMatch(jobBlock(platform, 'artifact_attestation'), /actions\/checkout|actions\/setup-node|\n\s+run:/);
assert.match(jobBlock(platform, 'receipt_attestation'), /actions\/download-artifact@v4[\s\S]*actions\/attest@v4/);
assert.doesNotMatch(jobBlock(platform, 'receipt_attestation'), /actions\/checkout|actions\/setup-node|\n\s+run:/);
```

Also assert that `canary-publish` is the only job in `stack-npm-publish.yml` with `environment: npm-publish` and that it remains fail-closed behind the verification result and an explicit enablement flag.

- [ ] **Step 4: Run workflow tests and verify RED**

Run:

```bash
node --test .github/scripts/platform-verification-workflow.test.mjs .github/scripts/stack-publish-workflow.test.mjs
```

Expected: failures identify OIDC/attestation permissions in code-executing jobs and missing artifact-only attestation jobs.

- [ ] **Step 5: Implement the minimal OIDC split and registration contract**

Change the registration builder and validator to require the protected environment and allowed action. Upload build outputs before attestation; make `artifact_attestation` download and attest those outputs without checkout, setup, or `run` steps. Make receipt construction upload the receipt without OIDC; make `receipt_attestation` download and attest only that receipt. Keep caller-level OIDC as the reusable-workflow permission ceiling, but explicitly restrict every code-executing called job to `contents: read` plus only the artifact permission it actually needs.

- [ ] **Step 6: Update the activation runbook**

Replace the blank-environment instruction with exact `npm-publish` configuration, exact `npm publish` allowed action, and a fail-closed activation sequence: configure all packages, configure environment protection, validate hosted verification, then enable canary publication.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the four focused test files from Steps 2 and 4. Expected: all pass.

- [ ] **Step 8: Commit Task 1**

Commit message:

```text
fix(release): isolate trusted publishing credentials
```

---

### Task 2: Make first-party manifest completeness repository-wide

**Files:**
- Modify: `architecture/platform-packages.schema.json`
- Modify: `architecture/platform-packages.v1.json`
- Modify: `.github/scripts/platform-catalog.mjs`
- Modify: `.github/scripts/platform-catalog-test-fixture.mjs`
- Modify: `.github/scripts/platform-catalog.test.mjs`
- Modify: `architecture/README.md`

**Interfaces:**
- Consumes: `repositoryCandidateFiles(repoRoot)` and every tracked or non-ignored untracked `package.json`.
- Produces: repository-wide first-party inventory plus catalog `manifestExclusions` entries shaped as `{ path, reason, ownerGroup, classification, reviewCondition }`.

- [ ] **Step 1: Write the five failing completeness tests**

Cover:

1. `services/new-service/package.json` named `@jinn-network/new-service` is rejected when absent from both roots and packages.
2. A scoped vendored manifest is accepted only with an explicit valid exclusion.
3. An exclusion missing `reason` or `ownerGroup` is rejected by schema/semantic validation.
4. A catalogued package that is also excluded is rejected.
5. Duplicate `@jinn-network/*` names at different paths are rejected before path agreement.

Each expectation is a literal error contract naming the offending path or package.

- [ ] **Step 2: Run the catalog tests and verify RED**

Run:

```bash
node --test .github/scripts/platform-catalog.test.mjs
```

Expected: the undeclared-root package is currently invisible and exclusion schema is unavailable.

- [ ] **Step 3: Add the exclusion schema and fixture data**

Require top-level `manifestExclusions`. Require every entry to have repository-relative `path`, non-empty `reason`, known `ownerGroup`, `classification` in `vendored | fixture | external | transitional`, and non-empty `reviewCondition`. Keep the canonical list empty until a real scoped exception exists.

- [ ] **Step 4: Implement independent repository-wide discovery**

Enumerate all candidate `package.json` files with `repositoryCandidateFiles()`, parse each manifest, select names beginning with `@jinn-network/`, and then enforce exactly one catalog entry or one explicit exclusion. Separately retain `manifestRoots` validation for governed layout. Reject stale exclusions, catalog/exclusion overlap, duplicate first-party names, name/path mismatch, and missing catalog paths.

- [ ] **Step 5: Run catalog tests and verify GREEN**

Run the catalog test file. Expected: all baseline and five new cases pass.

- [ ] **Step 6: Commit Task 2**

Commit message:

```text
fix(architecture): discover first-party manifests repository-wide
```

---

### Task 3: Remove operational package-count and membership duplication

**Files:**
- Modify: `architecture/platform-packages.schema.json`
- Modify: `architecture/platform-packages.v1.json`
- Modify: `.github/scripts/platform-catalog.mjs`
- Modify: `.github/scripts/platform-catalog-test-fixture.mjs`
- Modify: `.github/scripts/platform-catalog.test.mjs`
- Modify: `.github/scripts/build-prepublication-bundle.mjs`
- Modify: `.github/scripts/build-prepublication-bundle.test.mjs`
- Modify: `.github/scripts/publish-verified-platform.mjs`
- Modify: `.github/scripts/publish-verified-platform.test.mjs`
- Modify: `.github/scripts/platform-verification-receipt.mjs`
- Modify: `.github/scripts/platform-verification-receipt.test.mjs`
- Modify: `.github/scripts/stack-package-graph.mjs`
- Modify: `.github/scripts/stack-package-graph.test.mjs`
- Modify: `architecture/README.md`
- Regenerate: `architecture/generated/platform-topology.md`
- Regenerate: `architecture/generated/platform-topology.v1.json`

**Interfaces:**
- Consumes: `catalog.releaseGroups[groupId]` and `catalog.packages.filter(pkg => pkg.releaseGroup === groupId)`.
- Produces: generic release-group validation and publication checks comparing the catalog digest, catalog-derived member names, receipt package order, and exact tarball manifest without literal membership counts.

- [ ] **Step 1: Write a failing dynamic-membership catalog test**

Add a valid scoped platform package, increment only `releaseGroups['platform-v1'].expectedPackageCount`, give the package the group's required gates and allowed classification/policy, and assert `validatePlatformCatalog()` succeeds. This test must fail on the current `50`, `69`, `65`, and exact-membership constants.

- [ ] **Step 2: Write failing dynamic bundle and publisher tests**

Build a fixture whose selected release group has a non-50 member count. Assert bundle construction accepts exactly the catalog-derived set and publisher validation rejects any registration, receipt entry, or tarball not in that set—not because a literal count differs.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test \
  .github/scripts/platform-catalog.test.mjs \
  .github/scripts/build-prepublication-bundle.test.mjs \
  .github/scripts/publish-verified-platform.test.mjs \
  .github/scripts/platform-verification-receipt.test.mjs \
  .github/scripts/stack-package-graph.test.mjs
```

Expected: failures identify literal initial topology and `50` assertions.

- [ ] **Step 4: Move release-group policy into catalog data**

Add `allowedClassifications` and `allowedDependencyReleaseGroups` to every release-group definition. Validate group relationships and canary/stable/publish-policy consistency generically. Delete `INITIAL_EXPERIMENTAL_PACKAGES`, `INITIAL_ADJACENT_PATHS`, `INITIAL_RELEASE_GROUPS`, `INITIAL_RELEASE_GROUP_CLASSIFICATIONS`, and `ALLOWED_RELEASE_GROUP_DEPENDENCIES`.

- [ ] **Step 5: Derive exact operational sets from the selected catalog group**

In bundle, receipt, graph, and publisher code, load the selected group, validate `members.length === expectedPackageCount`, and compare exact sorted package names/order/tarballs/registrations. Remove literal `50`, `69`, `65`, `8`, and exact experimental/adjacent membership assertions from operational JavaScript.

- [ ] **Step 6: Update documentation and regenerate topology**

Document that baseline counts are generated observations, while release-group counts and policy live only in catalog data. Run:

```bash
node .github/scripts/generate-architecture.mjs
node .github/scripts/generate-architecture.mjs --check
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the five focused files from Step 3. Expected: all pass.

- [ ] **Step 8: Commit Task 3**

Commit message:

```text
refactor(architecture): derive release membership from catalog
```

---

### Task 4: Verify the exact final SHA and update the draft PR

**Files:**
- Modify only if verification exposes a defect: files directly responsible for that defect plus a failing regression test.
- Update: `.superpowers/sdd/phase-a-platform-architecture-convergence/task-8-verification-report.md`

**Interfaces:**
- Consumes: the final committed branch SHA and GitHub-hosted workflow conclusions.
- Produces: local verification evidence, pushed commits, and hosted checks attached to the exact PR head.

- [ ] **Step 1: Run the complete affected/adjacent suite**

Run all catalog, graph, public-surface, receipt, bundle, publisher, workflow, ownership, and fixture tests with Node 22 and `--test-concurrency=1`.

- [ ] **Step 2: Run static validation**

Run generated topology drift checking, `actionlint` on every changed workflow, JSON parsing, JavaScript syntax checks, `git diff --check`, and confirm a clean worktree.

- [ ] **Step 3: Run a real 50-package dry run**

Build the exact catalog-selected tarball set, run the clean external consumer with the internal registry fallback unreachable, and construct the verification receipt without invoking npm publication.

- [ ] **Step 4: Update and commit verification evidence**

Record exact final SHA, package/tarball counts derived from catalog, digests, test totals, and the explicit statement that no npm publication occurred.

- [ ] **Step 5: Push the branch and observe hosted checks**

Push the exact reviewed commit to `codex/platform-architecture-convergence`, then wait for PR #2360 checks. Require exact success for architecture control, platform verification, all six domain gates, artifacts, external consumer, receipt construction, and both artifact-only attestation jobs.

- [ ] **Step 6: Stop at external-state gates**

Do not enable canary publication or modify npm/GitHub settings. Report the remaining administrator actions: configure all npm trusted publishers for `npm-publish` + `npm publish`, protect the deployment environment, apply branch protection, and run the live audit.
