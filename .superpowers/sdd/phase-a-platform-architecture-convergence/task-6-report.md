# Task 6 report — Architecture ownership and branch-policy audit

## Status

Implementation complete. No live GitHub API calls, branch-setting mutations, publishing, pushes, or pull requests were performed.

## Changed files

- `.github/CODEOWNERS` — appends the protected architecture-control rules last, while retaining the existing canonical, UI, and governance rules.
- `.github/scripts/architecture-control.mjs` — reusable CODEOWNERS parser/matcher, exhaustive catalog/control-path enumerator, validator, and deterministic JSON CLI.
- `.github/scripts/architecture-control.test.mjs` — controlled-fixture and canonical-repository ownership behavior tests.
- `.github/scripts/platform-catalog.mjs` and its test — fail-closed own-property resolution for owner groups and gate IDs.
- `.github/scripts/branch-protection-audit.mjs` — injectable GET-only branch-protection and owner-eligibility auditor plus deterministic JSON/Markdown CLI.
- `.github/scripts/branch-protection-audit.test.mjs` — owner/API and every required branch-policy drift test.
- `.github/scripts/architecture-control-workflow.test.mjs` — exact required check, explicit-head, non-publishing, scheduled/manual audit workflow contracts.
- `.github/workflows/platform-architecture-control.yml` — PR/manual control workflow with exact `platform-architecture-control` and final `platform-verification` job/check names.
- `.github/workflows/architecture-policy-audit.yml` — scheduled/manual read-only external-state audit, summary, artifact, and drift failure.
- `docs/engineering/architecture-control.md` — human-admin boundary, read-only token, attestation, and fork-token limitations.

## RED evidence

Initial behavioral matrix, before either implementation module or workflow existed:

```text
/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test \
  .github/scripts/architecture-control.test.mjs \
  .github/scripts/branch-protection-audit.test.mjs \
  .github/scripts/architecture-control-workflow.test.mjs
```

Result: exit 1; 0 passed, 12 failed. The CODEOWNERS tests failed with `ERR_MODULE_NOT_FOUND` for `architecture-control.mjs`; branch drift/GET-only tests failed with `ERR_MODULE_NOT_FOUND` for `branch-protection-audit.mjs`; both workflow contract tests failed with `ENOENT` for their missing workflow files. The matrix already contained later override, missing owner, new manifest/new testing directory, malformed owner group/pattern, exhaustive category enumeration, all branch drift variants, GET-only enforcement, exact check names/result gating, and no-publish behavior.

The username-currentness regression was mutation-checked independently: with the login-identity condition removed, the focused command exited 1 because renamed and malformed `/users/{username}` responses produced “Missing expected rejection”; restoring the condition made all four focused assertions pass.

The first explicit actionlint run exited 1 on `SC2129` in the scheduled audit summary step. Grouping the summary redirects removed that workflow defect. A later dependent-suite pass also exposed that the controlled fixture lacked the newly enumerated `jinn-plugin-split.yml` generator source; adding the real fixture file restored the intended ownership assertions. Final self-review added a malformed-bypass response case; it failed RED with “Missing expected rejection” until bypass object/array validation was made fail-closed.

## GREEN verification

- Final focused architecture/audit/workflow plus catalog behavior: 105 tests passed, 0 failed.
- Catalog and every discovered catalog-consuming dependent suite: 192 tests passed, 0 failed.
- Node syntax checks for both implementation modules: exit 0.
- `/opt/homebrew/bin/actionlint .github/workflows/platform-architecture-control.yml .github/workflows/architecture-policy-audit.yml`: exit 0.
- Deterministic coverage CLI to caller-selected `/tmp/task6-final-coverage.json`: exit 0; no timestamps or absolute repository paths.
- `git diff --check`: exit 0.
- The root `.architecture-control/` runtime output was removed from the worktree (moved to `/tmp/task6-architecture-control-runtime`); it is not source and is not included in the commit.

## Coverage

The canonical report contains 3,019 unique repository-relative control paths. Category membership is overlapping by design:

- 69 catalog manifests (all catalog packages, never a sample)
- 19 authority documents
- 2 decision records
- 18 unique boundary-policy paths
- 18 unique required-gate implementations/workflows
- 951 catalog public-surface directories/files
- 23 first-party conformance source files resolved through package `exports`
- 46 declared conformance packed targets
- 2,403 discovered first-party schema/profile/fixture/conformance/test/testing directories and files below all scoped roots, excluding dependency/build trees
- 498 exhaustively discovered first-party generator/automation source paths
- 997 catalog-declared generated-output directories/files and packed targets
- 2 catalog/schema files
- 2 marketplace control roots (`binding` and `testing`)
- 6 other static control roots/files

Each catalog authority, decision, boundary, and gate reference is asserted individually in the canonical behavior test. Conformance catalog values are treated as export keys, resolved through each manifest's conditional export targets, and mapped to actual first-party sources rather than mistaken for synthetic filesystem paths.

## Self-review

- Effective owners are compared as a unique set, not order-sensitive text, and deterministic output normalizes them to `@oaksprout @ritsukai`.
- All catalog owner groups require exact local GitHub username syntax; the architecture group must be exactly the two required handles and every package group reference must resolve.
- The parser supports only the repository's controlled subset: root anchoring, directory rules, `*`, `**`, and last match. Negation, character classes, triple stars, unanchored rules, inline comments, and ownerless/malformed rules fail closed.
- Late protected CODEOWNERS rules retain earlier canonical/UI/governance entries and make all enumerated architecture paths resolve to the exact owner set. A later override is behavior-tested and rejected.
- The audit repository is pinned to exact `Jinn-Network/mono`; all three branches and both users are always attempted with GET. Username responses must retain the current handle case-insensitively. Visible collaborator permission must be `write`, `maintain`, or `admin`; `read`, `triage`, missing, unknown, and visible non-collaborators fail. A 403 is recorded explicitly as `visibility-unavailable`.
- Branch review, context, force-push, admin, and user/team/app bypass drift variants are all tested. Extra required contexts may coexist with the exact two required architecture contexts.
- Drift errors carry a deterministic complete report and the scheduled workflow uploads evidence and writes a summary before failing.
- The PR workflow checks out the explicit pull-request head SHA, uses the verifier's valid `canary` lane only as a verification canary, maps only the marketplace fork secret, grants attestation writes only to the reusable verification job, never publishes, and never uses `pull_request_target`.
- The final job named exactly `platform-verification` depends on the reusable verifier result and fails unless it is exactly `success`.

## Concerns

- Branch protection and collaborator eligibility are external state. The scheduled workflow can only observe them; a repository administrator must configure or repair drift manually.
- If `ARCHITECTURE_AUDIT_TOKEN` is not configured and `GITHUB_TOKEN` cannot view collaborator permissions or branch protection, the audit records collaborator visibility as unavailable and fails closed because write eligibility was not proven. The dedicated token should remain fine-grained and read-only.
- Fork pull requests may lack the write-capable token permissions required by the reusable verifier's attestations. The same explicit head SHA must then be rerun by a maintainer in the trusted repository context, as documented; no elevated target-context workflow is used.

## Fix round 1

Reviewed base: `bf44f9dbd890cb3d873d4d6d0d058970bbfbfea3`.

### RED evidence

- `/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test .github/scripts/branch-protection-audit.test.mjs .github/scripts/architecture-control-workflow.test.mjs` exited 1 with 31 passed / 4 failed: collaborator-permission 403 did not reject, the injectable CLI runner did not exist, and workflow-scope permissions still included all three write grants.
- `/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test .github/scripts/architecture-control.test.mjs .github/scripts/branch-protection-audit.test.mjs` exited 1 with 50 passed / 9 failed: a newly named `tools/refresh-assets.mjs` and its indirect helper were absent, an unreferenced gate definition was absent, prototype-inherited `toString` ownership was accepted, declared generated outputs were incomplete (`client/schemas` was the first canonical failure), and missing bypass object/users/teams/apps arrays were accepted.
- `/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test --test-name-pattern='rejects missing ownership' .github/scripts/platform-catalog.test.mjs` exited 1: a `toString` gate ID was accepted through inherited prototype membership.

### Fix rationale

- A 403 collaborator-permission response remains deterministic evidence with `collaborator: "visibility-unavailable"`, but now adds policy drift. Both owners and all branches remain in the thrown error report. The exported CLI runner writes JSON and Markdown before rethrowing, so the scheduled job uploads evidence and exits nonzero.
- Workflow-level permissions are now only `contents: read`. `id-token`, `attestations`, and `artifact-metadata` writes exist only on `platform-verification-reusable`; the ordinary control and final-result jobs cannot receive them.
- Generator custody no longer uses generate-name or repository filename whitelists. It exhaustively includes first-party package `scripts/` trees, arbitrary Node/tsx/bun entrypoint directories declared by package scripts (including indirect helpers), and complete repository `.github/scripts/` and workflow generator surfaces, while excluding dependency/build trees.
- Every catalog public surface and resolved conformance source/packed target is independently tagged as a declared generated output; canonical tests assert category coverage path by path rather than merely checking a nonzero count.
- Every `gateDefinitions` implementation is enumerated independently of package references.
- Owner-group and required-gate lookup use `Object.hasOwn`, rejecting prototype-inherited names.
- Review bypass allowances require an explicit object with explicit empty `users`, `teams`, and `apps` arrays. Missing/malformed structures fail closed.

### GREEN evidence

- Focused architecture/audit/workflow/catalog suite: 115 passed, 0 failed.
- Catalog-dependent consumers: 88 passed, 0 failed.
- Node syntax checks for `architecture-control.mjs`, `branch-protection-audit.mjs`, and `platform-catalog.mjs`: exit 0.
- `/opt/homebrew/bin/actionlint` on both Task 6 workflows: exit 0.
- Two caller-selected coverage outputs compared byte-for-byte: identical; 3,019 unique paths, no timestamps or absolute paths.
- `git diff --check` and the no-root-`.architecture-control/` assertion: exit 0.
