# Task 8 verification report — Full convergence and integration closure

## Verdict

The initial Phase A verification passed at source commit
`d3024785349edd74bd25506990776b2823ad4593` on branch
`codex/platform-architecture-convergence`. The worktree was clean before verification and the
tracked tree remained clean after real builds, packing, deterministic regeneration, and all test
groups. An independent audit subsequently found one direct legacy publisher bypass and one evidence
overstatement; both were closed in fix round 1 at
`1cbfbe3efd6da5182b5b6040f068e170b29d8166`.
A second independent audit found two Important integration gaps: hosted identity paths could escape
the profile output root, and release-group gate authority was not connected to receipt/workflow
enforcement. Both were closed in fix round 2 at
`719a0d5831a0f92bc31d72f66bf6b9580c803663`.

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
then observed 50 fake canary publish calls in seven-wave order. All preflight receipt, gate,
identity, integrity, provenance, and destination negative cases observed zero publish calls,
including:

- a deliberately failed or missing domain conclusion;
- source, catalog, release-group, lane, package set/order/wave, version, dist-tag, or public-surface
  identity mismatch;
- tarball, public-manifest, profile-manifest, fixture/inventory, or receipt-integrity drift;
- noncanonical repository or destination;
- failed trusted-publisher/provenance preflight; and
- existing registry integrity, canary-tag, malformed-response, or unreachable-state mismatch.

Post-publish observation failures necessarily occur after one or more injected fake publish calls.
A corrupt first observation stops before the second package, bounded propagation failures stop the
affected wave, and final registry drift prevents the final publication receipt. No test or dry-run
made a real npm publish or registry-mutation call.

The production publisher rejects every lane other than `canary` and every release group other than
`platform-v1`. The stable workflow terminates at the explicit `stable-hosting-blocker`; the seven
experimental packages have disabled release flags. The initial textual scan correctly found no old
`STACK_ROOTS`, hard-coded six-root discovery, workflow-run polling, skipped/neutral/cancelled gate
acceptance, or `continue-on-error: true`, but missed the direct non-dry `publish-stack.mjs` module
route. Fix round 1 removes that route and adds an executable module/export audit proving that the
receipt-gated verified publisher is the only platform-v1 module containing npm publish logic.
Historical prose snapshots are not treated as executable findings.

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

## Independent-audit fix round 1

Reviewed base: `197b5945172a865b3cdc3ae88822fafa1df0f15a`. Code fix:
`1cbfbe3efd6da5182b5b6040f068e170b29d8166`.

### RED evidence

The Node 22 focused regression matrix reported 5 passed and 6 failed before implementation.

- Non-dry canary reached the injected fake command as
  `npm publish @jinn-network/fixture-core-01@0.1.0-canary...`.
- Non-dry stable with an explicit SHA reached the injected fake command as
  `npm publish @jinn-network/fixture-core-01@0.1.0`.
- The source audit found the dynamic `runPublish` import, eight legacy run-module exports instead
  of only `packWave`, and executable npm publish logic in both `publish-stack-run.mjs` and the
  receipt-gated publisher.
- Argument parsing still exposed the legacy `npmCommand` override.

All commands in the reproducer were injected local fakes. The fake publisher deliberately exited
on its first publish observation; no registry or other external service was contacted.

### Fix

- `publish-stack.mjs` now refuses every non-dry invocation before catalog discovery or any package
  command and directs callers to `publish-verified-platform.mjs`. Canary and stable dry-run planning
  remain available, including stable version and `latest` dist-tag verification.
- The dynamic import and `--npm` override were removed.
- `publish-stack-run.mjs` now exports only `packWave`; registry mutation/verification, retry/sleep,
  wave publication, coherent-set verification, and `runPublish` were deleted. Its tests now cover
  pack/build/mutation-restore/local-specifier/tarball-identity safety only.
- `platform-publisher-surface.test.mjs` audits the CLI source, module exports, bundle-builder import,
  and complete platform-v1 executable publisher set. Only the receipt-gated publisher may contain
  executable npm publish logic.
- Deterministic regeneration records 3,025 owned paths and 504 generator sources after adding the
  audit file.

### GREEN verification

- Focused legacy CLI, pack-only module, and publisher-surface audit: 15 passed, 0 failed.
- Publisher, workflow, receipt, bundle, and trusted-publisher matrix: 69 passed, 0 failed.
- Updated full release selection: 117 passed, 0 failed. The prior 121 count changed because nine
  obsolete legacy-publisher tests were retired while two CLI refusal tests and three surface-audit
  tests were added; no test count was backfilled.
- Historical architecture/guard baseline: 151 passed, 0 failed.
- Generator plus focused regression matrix: 30 passed, 0 failed; write followed by `--check`
  byte-compared both generated files.
- Real committed-code dry run: immutable install/build/pack produced 50 tarballs in seven waves at
  `0.1.0-canary.sha.1cbfbe3efd6da5182b5b6040f068e170b29d8166`; manifest SHA-256
  `66c63d242ac2f127f229cfcfd4fe5f03e721480718edd9a90f84e250645647a3`.
- Canary and stable CLI dry-run plans both passed. Syntax checks for all five changed modules,
  `actionlint` over all 10 Phase A workflows, generator check, and `git diff --check` passed.
- No real npm publish, push, tag, deploy, pull request, live API call, or settings change occurred.

## Independent-audit fix round 2

Reviewed base: `412a793f8b34b5687d8d5183fafb9b83c8469d40`. Code fix:
`719a0d5831a0f92bc31d72f66bf6b9580c803663`. This round used Node `v22.23.1` from
`/opt/homebrew/opt/node@22/bin/node`.

### RED evidence

- The initial shared-asset/profile-root selection reported 26 passed and 6 failed: no shared Jinn
  identifier validator existed, direct and encoded traversal were accepted, source documents could
  claim generated manifest paths, and output-root/nested-parent symlinks were followed. The direct
  traversal reproducer wrote `escaped.json` beside the requested output root before the later receipt
  verifier could reject it.
- A dangling target-symlink reproducer then failed independently: copying the document created the
  previously absent outside target. A noncanonical `https://JINN.network/...` identity was also
  silently treated as non-identifying before the candidate/validator boundary was tightened.
- The release-group schema assertion failed because `requiredGateIds` was absent. After shaping the
  schema/catalog fixture, all five gate-authority mutations failed their expectations: valid
  package-only and group-only swaps, valid group-only addition/removal, and a prototype-inherited
  gate all passed catalog validation.
- The receipt test failed at module load because no catalog-derived conclusion-key function existed;
  the receipt still depended on its independent six-domain constant.

### Fix

- `public-surface-assets.mjs` owns the single Jinn identifier-to-served-path validator. It accepts all
  30 current identities and rejects empty/dot/traversal components, POSIX and Windows absolute forms,
  backslashes, query/fragment text, percent-encoded ambiguity, noncanonical URL normalization, and
  root `manifest.json` / `manifest.dsse.json` collisions. Semantically Jinn URLs with noncanonical
  host, port, or credential spelling enter the validator rather than disappearing as non-claims.
- `build-profile-root.mjs` resolves a real nonsymlink output directory, plans and preflights every
  target before copying, proves every resolved target is strictly below the canonical root, and
  rejects existing parent/target links and non-regular entries. Direct/encoded traversal, root and
  nested links, dangling target links, reserved metadata collisions, and special files all fail
  without creating an outside document; a valid nested identity remains served normally.
- Every catalog release group now declares its required gate IDs. Schema and runtime validation make
  them nonempty/unique, require prototype-safe gate-definition ownership, and require exact equality
  with the union of member-package gates. One-sided add/remove/swap mutations fail while an atomic
  group/member change passes. The generated JSON and Markdown topology expose all four gate sets;
  the seven experimental environment-supply packages and their group remain disabled.
- Platform receipt conclusion keys now come from the selected catalog group by validating and
  stripping `-ci`, then adding only the three infrastructure gates (`catalog`, `artifacts`, and
  `external-consumer`). Missing and extra catalog-derived conclusions fail. There is no independent
  six-domain receipt list.
- The workflow contract loads the catalog and proves exact static reusable `uses:` paths,
  `source_sha` propagation, job `needs`/results, and receipt `--gate` keys with no omissions or
  extras. Static calls and the no-polling rule remain intact.

### GREEN verification

- Shared public-asset and profile-root selection: 36 passed, 0 failed, including the exact 30 valid
  identities and all traversal/link/special-file regressions.
- Catalog/schema/union selection: 66 passed, 0 failed, including four one-sided gate mutations, the
  prototype case, and the positive atomic-change case.
- Receipt plus injected-fake publisher selection: 25 passed, 0 failed. All publisher calls remained
  injected local fakes.
- Catalog-derived platform workflow contract: 14 passed, 0 failed.
- Enumerated 20-file affected/adjacent superset: **288 passed, 0 failed**. The selection comprised
  catalog, stack graph, public assets/profile/public manifest, publication surface, generator,
  ownership/branch/workflow controls, receipt/publisher/publisher-surface, bundle/external consumer,
  stack workflow/trusted publishers, and fixture manifest/immutability suites.
- Exact historical architecture/guard baseline: **151 passed, 0 failed** (the unchanged 131-test
  inventory/boundary/publication/fixture/graph selection plus the original 20 profile-root tests).
  The seven new fix-round profile-root cases also pass in the affected superset.
- Deterministic generator write plus `--check` byte-compared both outputs. `actionlint` passed all 10
  Phase A workflows; Node 22 syntax checks passed all 12 changed MJS modules; `git diff --check`
  passed.
- No npm publish, push, tag, deployment, pull request, live API mutation, or settings change was
  performed.

## PR #2360 request-changes hardening round

Reviewed base: `224d52fdf148f5873b0c13340468aab70cfdd074`. Verified code commit:
`4e8b54bfd94c28c1e7010afba98fd77550c86f8b`. This round closed the request-changes findings and
the independent follow-up review finding:

- npm trusted-publisher registrations now require GitHub environment `npm-publish` and allowed
  action `npm publish`; only the final canary publisher enters that environment, and it remains
  disabled unless `PLATFORM_CANARY_PUBLISH_ENABLED=true`;
- package-controlled build and receipt jobs have no OIDC or attestation authority; separate
  download-only artifact and receipt attestation jobs receive those permissions and execute no
  checked-out repository code;
- completeness discovery independently scans every tracked or non-ignored untracked
  `@jinn-network/*` manifest repository-wide, with only schema-validated, owned, reviewable
  exclusions permitted; and
- release-group classifications, dependency directions, membership, counts, order, tarball set,
  trusted-publisher set, and generated views derive from the catalog instead of executable
  topology constants; and
- each release-group policy list exactly equals its member-policy union, flags agree with every
  member, and a disabled or lane-ineligible group fails before packing, trusted-publisher
  generation, provenance checks, or npm access.

Fresh Node `v22.22.2` verification at the code commit produced:

| Verification | Result |
| --- | --- |
| 25-file affected architecture, ownership, release, receipt, publisher, workflow, profile, fixture, and external-consumer selection | 336 passed, 0 failed |
| Domain inventory/boundary plus historical architecture guards | 158 passed, 0 failed |
| Eight-domain inventory, boundary, and packed-type matrix | 116 passed, 0 failed |
| Launcher regression suite | 6 files; 32 passed, 0 failed |
| Changed workflow lint | 2 clean, 0 errors |
| Changed module syntax | 24 clean, 0 errors |
| Changed JSON parsing | 3 clean, 0 errors |
| Generated topology drift and diff whitespace | clean |

The production dry-run path used a fresh temporary output root, not injected fakes. It built the
catalog-selected `platform-v1` group in seven runtime waves, packed 50 tarballs at
`0.1.0-canary.sha.4e8b54bfd94c28c1e7010afba98fd77550c86f8b`, generated 50 trusted-publisher
registrations, installed all tarballs as direct dependencies in the clean consumer with scoped
registry fallback unreachable, and created the exact-success verification receipt. It did not
invoke npm publication.

| Dry-run artifact | SHA-256 / integrity |
| --- | --- |
| Catalog | `66c5073652dcf8cee61907fb6ae1b612683dcda80982774692a144de9e38035b` |
| Prepublication manifest | `12574833a7ff6672c31a64f948ae3465b0a89b176f88f4bea254399dbf1a916d` |
| Public-surface manifest | `032862bdb60fa1dd6bc2de360909fc35e645c0742c7cd7a2b78a8fc85b2bc579` |
| Profile manifest (508 documents) | `b369ccc7ebd357cd7886c3cab76563d3e142c6d2b005ba2ec110c618aea3b77f` |
| Verification receipt | `469cfa9adcd8233ecabfc034eefc726b51ebf1ec651e75717a5f436627f07dd8` |
| First tarball, `@jinn-network/evidence-protocol` | `sha512-Bhe4P7dDRFM5eAQvESioRBUYG/Jy++lIsG78tL37PBEteBAXbAF2uY5bf9+gi+5JskB6vJd1/+3IhBwa4apZvw==` |
| Last tarball, `@jinn-network/marketplace-testing` | `sha512-DDQ5AhMyF59Eo1D2yByhsaVLWcoyA6dXcQLd5BnyhP3ViPTSuu72MDTgmUhDBOynPdlt7Yr1tuor+YJ7dsLDqw==` |

No npm package, tag, hosted profile, trusted-publisher setting, deployment-environment setting,
branch protection, or repository variable was changed by this hardening round.

## Remaining external blockers

- GitHub-hosted OIDC provenance and an actual npm trusted-publisher run remain intentionally
  unexecuted; satisfying them requires the hosted workflow and external npm state.
- Live branch-protection and owner-team configuration remain an administrator-controlled boundary;
  the repository-side audit contract is green, but no settings were changed or claimed.
- Stable publication remains fail-closed until automated live `jinn.network` profile hosting and
  verification exist. Canary verification does not weaken or bypass that blocker.
