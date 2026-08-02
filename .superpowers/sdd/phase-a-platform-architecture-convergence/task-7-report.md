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
waves, 30 catalog-declared self-identifying public claims, 3,021 Task 6 ownership paths, and eight
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
- The machine artifact is about 989 KB because it embeds exhaustive ownership evidence. Its stable
  formatting and exact-file drift check make that size an intentional reviewability tradeoff.
