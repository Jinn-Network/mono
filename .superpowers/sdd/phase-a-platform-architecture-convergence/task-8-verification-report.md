# Task 8 verification report — Full convergence and integration closure

## Verdict

Phase A verification passed at source commit
`d3024785349edd74bd25506990776b2823ad4593` on branch
`codex/platform-architecture-convergence`. The worktree was clean before verification and the
tracked tree remained clean after real builds, packing, deterministic regeneration, and all test
groups. No production-code fix was required.

All commands used Node `v22.22.2` from
`/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin`. Tests that build packages, temporarily
stage manifests, or pack consumers ran with `--test-concurrency=1` or as explicitly serial package
commands.

No package was published. No push, tag, deployment, pull request, live GitHub mutation, npm
configuration mutation, or branch-settings change was performed.

## Verification matrix

`$NODE` below is the absolute Node 22 executable described above.

| Verification | Command/selection | Result |
| --- | --- | --- |
| Catalog, schema, completeness, closure, tiers, graph, assets, generator | `$NODE --test --test-concurrency=1 .github/scripts/{platform-catalog,stack-package-graph,public-surface-assets,generate-architecture}.test.mjs` | 87 passed, 0 failed |
| Eight domain inventory/boundary/packed-type trios | `$NODE --test --test-concurrency=1 .github/scripts/{benchmarking,environments,evidence,marketplace,record-discovery,task-execution,task-supply,trust}-{package-inventory,packed-types,source-boundaries}.test.mjs` | 116 passed, 0 failed |
| Reconstructed historical architecture/guard baseline | The eight inventory and boundary pairs above plus `stack-publication-surface`, `build-profile-root`, `fixture-manifest`, and `stack-package-graph` | **151 passed, 0 failed** |
| Expanded historical matrix | All 24 domain trio files plus the four historical guards | 159 passed, 0 failed |
| Public assets and manifests | `public-surface-assets`, `fixture-manifest`, `stack-publication-surface`, `build-profile-root`, and `build-platform-public-surface` tests | 42 passed, 0 failed |
| Release, receipt, fake publisher, and workflow contracts | `stack-package-graph`, `publish-stack`, `stack-publish-manifest`, `publish-stack-run`, `stack-trusted-publishers`, `build-prepublication-bundle`, `prepublication-external-consumer`, `platform-verification-receipt`, `publish-verified-platform`, `platform-verification-workflow`, `stack-publish-workflow`, `stack-external-acceptance`, `fixture-immutability`, and `sign-profile-manifest` tests | 121 passed, 0 failed |
| Ownership, branch policy, and generated topology | `architecture-control`, `branch-protection-audit`, `architecture-control-workflow`, and `generate-architecture` tests | 78 passed, 0 failed |
| Launcher package regression suite | `yarn --cwd packages/task-execution/backend-local/launchers test` | 6 files; 32 passed, 0 failed |
| Changed workflow lint | `actionlint` over the 10 workflows changed from the audited base | 10 clean, 0 errors |
| Changed module syntax | `$NODE --check` over all 34 changed `.mjs` files | 34 clean, 0 errors |

The exact 24 domain files now total 116 because each of the eight current packed-consumer files is
reported by Node as one file-level test. The known 151 baseline is not fabricated from that changed
count: it is reproducibly the 108 tests in the historical 16 inventory/boundary files, 8 publication
surface tests, 20 profile-root tests, 6 fixture-manifest tests, and 9 stack-graph tests. That exact
selection reached 151/151. Its formerly failing evaluator-adapters fixture export is green in the
publication-surface guard, and the launcher `node:child_process` production boundary is green in
the task-execution source guard. The standalone launcher suite adds 32/32 green behavior tests.

The first packed-type pass was 113/116 because seven catalog-disabled experimental packages had
no ignored `dist` prerequisites in the clean checkout. Building the documented prerequisites in
dependency order (`environments/{record,verification}`,
`task-supply/{curation,admission,derivation,posting}`, then `discovery/facts/environments`) made the
three affected consumers pass; the full serial matrix then passed 116/116. This was a preparation
issue, not a product defect, so no source patch was made.

## Real fresh-output dry run

The real artifact path used a newly created temporary root and the production scripts, not mocks:

1. `build-platform-public-surface.mjs` wrote the exact 50-package `platform-v1` canary manifest.
2. `build-profile-root.mjs` wrote 508 exact documents for the same 50 packages.
3. `build-prepublication-bundle.mjs` ran immutable install, build, and pack commands serially in the
   catalog-derived seven waves. It produced exactly 50 tarballs at version
   `0.1.0-canary.sha.d3024785349edd74bd25506990776b2823ad4593`, dist-tag `canary`.
4. `prepublication-external-consumer.mjs` installed all 50 tarballs in a clean external consumer
   with the scoped `@jinn-network` registry blackholed and reported
   `external consumer accepted 50 prepublication tarballs`.
5. `platform-verification-receipt.mjs` created a same-source immutable receipt with exact-success
   conclusions for `catalog`, `benchmarking`, `record-discovery`, `evidence`, `marketplace`,
   `task-execution`, `trust`, `artifacts`, and `external-consumer`.

Artifact identities from that run:

| Artifact | SHA-256 / integrity |
| --- | --- |
| Catalog | `02569ba5f09236bbe8fb23b6228df07d4456ad69f7a127dc918ae450193d5c3a` |
| Prepublication manifest (50 tarballs, 7 waves) | `a9f098dae0a6cadcee080ee737aab862dd30feafd2eaebaafb2146acc402156b` |
| Public-surface manifest (50 packages) | `3161d6e128f9e96144eae8f38d88e90c34fbdb488c29179752d9e303060f1ba6` |
| Profile manifest (50 packages, 508 documents) | `c9e0f2e515dc7c0f196add17c0d5b587d9c010643651e038ac927faf6a3fd98f` |
| Verification receipt | `01e33addb047541e14998b42f2254f924d35d9fba56bdf726426494dd4f3435f` |
| First ordered tarball, `@jinn-network/evidence-protocol` | `sha512-PSyM8ZLMZ6Vzm2KrpuQ01bNeqi3iGXizAQmc3iSLn+gAdIxJQjFNNcWknUrVbrwfEO6nFdLMO+vzK3CpN/65Yw==` |
| Last ordered tarball, `@jinn-network/marketplace-testing` | `sha512-4d42wY2yvsKCcFuwLiZkEmOY2hLhog9kg1KkNspZB4e61/RGGgdwJaNbXVzkfYwCB9BJy/VARhWZ2jF9k55+4w==` |

The prepublication manifest and receipt bind the complete ordered 50-entry name, filename, and SRI
set; the aggregate digests above bind all entries without duplicating the full manifests in this
tracked report.

## Publication safety and real/simulated boundaries

The real dry-run path ends after `yarn pack` and external-consumer installation; it contains no
publish operation. Publisher behavior was exercised only through the injected fake executor in
`publish-verified-platform.test.mjs`. The success case verified the receipt and on-disk subjects,
then observed 50 fake canary publish calls in seven-wave order. Every negative case observed zero
publish calls, including:

- a deliberately failed or missing domain conclusion;
- source, catalog, release-group, lane, package set/order/wave, version, dist-tag, or public-surface
  identity mismatch;
- tarball, public-manifest, profile-manifest, fixture/inventory, or receipt-integrity drift;
- noncanonical repository or destination;
- failed trusted-publisher/provenance preflight; and
- final subject mismatch, which also prevented receipt production.

The production publisher rejects every lane other than `canary` and every release group other than
`platform-v1`. The stable workflow terminates at the explicit `stable-hosting-blocker`; the seven
experimental packages have disabled release flags. Searches of executable release tooling found no
old `STACK_ROOTS`, hard-coded six-root discovery, workflow-run polling, skipped/neutral/cancelled
gate acceptance, `continue-on-error: true`, or reachable stable/experimental publication command.
Historical prose snapshots were not treated as executable findings.

Local verification cannot create the GitHub-hosted OIDC/npm provenance attestation. Its workflow,
permissions, exact-subject, and fail-closed provenance contract passed structural tests and
`actionlint`; this report does not claim a local cryptographic attestation. Likewise, branch policy
and CODEOWNERS enforcement passed fixture/structural audits without calling the live GitHub API or
altering repository settings.

## Determinism, diff, and cleanliness

`generate-architecture.mjs` rewrote its two expected outputs, after which `--check` regenerated to
a fresh directory and byte-compared cleanly. Fixture manifests were current. The generated topology
still records 69 entries (65 packages plus 4 adjacent entries), the exact 50-package core group,
7 disabled experimental packages, 7 waves, 30 public identity claims, 639 public assets, and 3,024
owned paths.

The complete
`3c7828bb53e69b4e2e8c6872fa7c9187ef514879..d3024785349edd74bd25506990776b2823ad4593`
branch diff was inspected: 75 files, 59,983 additions, 1,133 deletions. `git diff --check` passed.
There were no binary entries, unexpected build/cache/tarball residue, credential-like filenames,
private-key/token signatures, credential assignments, or out-of-scope paths. All changed paths are
within the planned catalog, architecture, workflows, scripts, generated artifacts, documentation,
public fixtures/manifests, and launcher-test convergence.

## Remaining external blockers

- GitHub-hosted OIDC provenance and an actual npm trusted-publisher run remain intentionally
  unexecuted; satisfying them requires the hosted workflow and external npm state.
- Live branch-protection and owner-team configuration remain an administrator-controlled boundary;
  the repository-side audit contract is green, but no settings were changed or claimed.
- Stable publication remains fail-closed until automated live `jinn.network` profile hosting and
  verification exist. Canary verification does not weaken or bypass that blocker.
