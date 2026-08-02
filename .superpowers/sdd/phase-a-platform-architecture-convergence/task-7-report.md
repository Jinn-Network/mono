# Task 7 report — Generated topology and documentation convergence

## Status

Implementation complete in commit `17d8c459d7d7283719df4137f5e7cd147a6ff047`. No publishing,
pushes, pull requests, live-host changes, npm configuration changes, or other external mutations
were performed.

## Generated architecture view

- `.github/scripts/generate-architecture.mjs` generates and checks the exact two-file artifact set.
- `architecture/generated/platform-topology.md` is the compact human view with an explicit
  generated-file banner.
- `architecture/generated/platform-topology.v1.json` is the canonical two-space-formatted machine
  view, including Task 6's complete ownership report.
- `.github/scripts/generate-architecture.test.mjs` covers catalog counts and package fields,
  dependency kinds/closure/waves, release and trusted-publisher policy, public claims, ownership,
  transitions, determinism, portability, actual tracked-output drift, missing/changed output, and
  unknown generated files.

The generated inventory contains 69 entries: 65 below `packages/**` and 4 adjacent entries. It
records the exact 50-package `platform-v1` group, 7 disabled experimental-environment packages,
8 other `packages/**` entries, 188 first-party runtime/optional/peer edges, seven `platform-v1`
waves, 30 catalog-declared self-identifying public claims, 3,023 Task 6 ownership paths, and eight
transitional/deprecated entries. Development dependencies never enter the graph or release order.

Check mode regenerates into a fresh temporary directory and byte-compares both tracked files. It
fails on missing, changed, or unknown files. The outputs contain no wall-clock timestamp or
machine-specific absolute path.

## Documentation convergence

- `architecture/README.md` establishes the authority hierarchy, tier direction, release groups,
  generated views, and atomic add/move/deprecate/promote procedures.
- `docs/runbooks/stack-npm-publishing.md` now describes the catalog-derived 50-package canary set,
  seven disabled experiments, same-run receipts and exact tarballs, independent legacy/product
  lanes, and the hard stable-hosting hold.
- `docs/runbooks/jinn-network-profile-hosting.md` now derives the served surface from catalog
  declarations, includes trajectory identities, excludes experimental environment identities,
  binds immutable manifests/receipts, and treats live-host verification as the stable blocker.
- The live platform, evidence, discovery, and operator designs link to the generated current view
  instead of maintaining stale package counts or tree tables. Obsolete evidence links now resolve
  to the nested current paths.
- The 2026-07-30 decision record and stack-publication plan preserve their historical prose and
  add dated snapshot notices pointing to the generated live topology.
- Trusted-publisher instructions no longer claim an active stable publisher. They keep the npm
  Environment field blank for the current receipt-gated canary lane without pre-binding a future
  stable environment.

## RED evidence

The initial focused command was run before the generator existed:

```text
/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin/node --test \
  .github/scripts/generate-architecture.test.mjs \
  .github/scripts/stack-trusted-publishers.test.mjs
```

Result: exit 1; 4 passed and 7 failed. Generator behavior failed with `ERR_MODULE_NOT_FOUND`; the
trusted-publisher prose still claimed stable publication from `npm-stable-publish` and did not name
the live `jinn.network` blocker.

Two fail-closed identity regressions were mutation-checked independently. Without contextual JSON
handling, malformed catalog-declared schema JSON escaped as a raw `SyntaxError`. Without duplicate
claim rejection, the duplicate-profile fixture advanced to unrelated ownership validation. Both
focused cases failed RED, then passed after contextual malformed-input and duplicate-URI rejection
were restored. Canonical pretty JSON was also introduced test-first: the focused artifact test
failed while output was compact and passed after deterministic two-space formatting.

## GREEN verification

- Final catalog/topology/public-surface/profile/CODEOWNERS/generator/trusted-publisher/docs suite:
  133 tests passed, 0 failed.
- `node .github/scripts/generate-architecture.mjs --check`: exit 0; both tracked files byte-identical
  to fresh temporary regeneration.
- Node syntax checks for `generate-architecture.mjs` and `stack-trusted-publishers.mjs`: exit 0.
- Relative Markdown path check: 43 links across 12 changed Markdown files resolved.
- Generated-count check: exact 69 / 65 / 50 / 7 / 8 / 4 split and seven waves.
- Live-doc drift scan: no live six-tree or 45-package authority outside labeled historical records.
- Generated portability scan: no local absolute paths or ISO wall-clock timestamps.
- `git diff --check`: exit 0.

## Self-review and residual concerns

- The compact Markdown deliberately summarizes ownership by category; the exhaustive 3,021-path
  Task 6 result remains in machine JSON. This keeps the human artifact reviewable without creating
  a second ownership model.
- Public self-identifiers are extracted only from catalog-declared schema/profile roots. Nested
  overlapping declarations copy a source once, while malformed JSON and distinct duplicate claims
  fail closed.
- Stable npm publication remains intentionally unavailable. Completion of this task documents and
  enforces the blocker; it does not implement or verify the live `jinn.network` host.
- The machine artifact is about 1.23 MB because it embeds 639 exact public assets plus exhaustive
  ownership evidence. Its stable formatting and exact-file drift check make that size an
  intentional reviewability tradeoff.

## Independent-review fix round 1

Reviewed base: `a393af416e63865b4a6133eda7f4496b334f6ef9`. Implementation commit:
`cfe957d3d8cb8a82bdcfdf6849ae9a959a55ebfd`.

### RED evidence

The focused review-regression matrix was run before implementation with Node 22 over the new asset,
catalog, generator, ownership, workflow, and documentation probes. Result: exit 1; 0 passed and 17
failed.

- The shared asset module did not exist, so exact non-self-identifying schema, fixture, conformance
  source/packed-target, declared-root symlink, and nested-symlink probes failed.
- The generated report had no `publicSurfaces.assets` collection.
- Traversal, absolute, and backslash public roots were accepted (three missing rejections).
- `repositoryCandidateFiles` did not exist; Task 6 still enumerated the raw live filesystem.
- Generated check mode followed file and directory symlinks and did not distinguish real files,
  directories, or unexpected non-file entries (five failed subtests).
- The normal architecture-control workflow did not run generated drift checking.
- The marketplace ground-truth section lacked a dated snapshot label and generated-topology link.

### Fixes

- Added one read-only public-surface authority that enumerates all catalog-declared schema, profile,
  and fixture files plus each conformance export's first-party source and packed targets. Each of
  the 639 generated assets records kind, package, package-relative source, repository path, export,
  packed targets, and any self-identifying claim. The kind split is 23 conformance, 569 fixtures,
  28 profiles, and 19 schemas.
- Catalog loading now rejects non-normalized public roots. The shared walker uses `lstat` and
  `realpath` containment to reject root/nested symlinks, special entries, and package/repository
  escapes. Generator, publication-surface validation, profile-root input enumeration, public
  artifact validation, and Task 6 conformance ownership reuse it. Profile serving retains fixture
  non-remapping, fixture-over-schema/profile precedence, `.sha256` exclusion, and its established
  served-path collision diagnostics.
- Generated write/check mode requires a real output directory and real expected files, rejecting
  missing entries, directories, symlinks, unexpected regular files, and unexpected non-file types
  before byte comparison.
- Task 6 now derives candidate files from `git ls-files --cached --others --exclude-standard -z` in
  Git checkouts, with deterministic filesystem fallback for non-Git controlled fixtures. Ignored
  machine files do not affect ownership bytes/counts; intended unignored new controls remain
  visible and subject to CODEOWNERS.
- The marketplace evidence section is labeled `Historical snapshot (2026-07-30)` and guarded. The
  normal `platform-architecture-control` job now invokes `generate-architecture.mjs --check`.

### GREEN verification

- Full Task 6+7 adjacent matrix: 184 tests passed, 0 failed.
- Generator write followed by `--check`: both tracked files byte-identical to temporary regeneration.
- `/opt/homebrew/bin/actionlint .github/workflows/platform-architecture-control.yml`: exit 0.
- Node syntax checks for every changed implementation module: exit 0.
- Relative Markdown links: 9 checked across the two changed Markdown artifacts; all resolved.
- Machine artifact: 639 exact assets; every catalog conformance export has a source/packed-target
  entry; no absolute local paths or wall-clock timestamps.
- `git diff --check`: exit 0.

### Residual concerns

- Non-Git fixture repositories intentionally use the deterministic filesystem fallback because Git
  ignore semantics do not exist there. Real checkouts fail closed if Git candidate enumeration
  fails instead of silently reintroducing raw-filesystem dependence.
- Stable npm publication remains blocked on automated live `jinn.network` hosting verification;
  this fix round does not change or weaken that external-state hold.
