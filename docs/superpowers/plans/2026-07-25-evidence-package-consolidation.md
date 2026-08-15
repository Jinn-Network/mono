# Evidence Package Consolidation PR Stack

> **For agentic workers:** implement this plan with
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`, preserving the review and verification
> checkpoints at every PR boundary.

**Date:** 2026-07-25

## Goal

Consolidate the complete evidence implementation into eight packages under
`packages/evidence/`, preserving evidence semantics and runtime behavior while
strengthening source-level architectural boundaries.

This is a packaging and boundary refactor. It intentionally changes several
unpublished npm import specifiers:

```text
@jinn-network/evidence-repository-fs
→ @jinn-network/evidence-repository/fs

@jinn-network/evidence-catalog
→ @jinn-network/evidence-discovery

@jinn-network/evidence-catalog/testing
→ @jinn-network/evidence-discovery/testing

@jinn-network/evidence-indexer
→ @jinn-network/evidence-discovery/indexer

@jinn-network/evidence-announcement-journal
→ @jinn-network/evidence-discovery/journal
```

No compatibility packages are retained because the affected package identities
are unpublished.

## Integration base

Build the stack on a synthetic branch that combines the two sibling
implementation stacks:

- Local Runtime PR #2161:
  `bd8b0ea182b7ec8d1e3be51915aa7802079052f8`
- Attestation Issuer PR #2157:
  `82b4af42222f9a941919ec247996f05532f9720b`
- Common ancestor: `56c8f86066d970cfc2608dec9f6dd85bf7bfc0ef`
- Synthetic branch: `codex/evidence-consolidation-base`

Create a signed, no-fast-forward merge with Local Runtime as first parent.
Open no pull request for the synthetic branch and never merge it directly.
If either sibling head changes before the stack is created, stop and refresh
these exact SHAs.

## Architectural rule

Package boundaries follow both release lifecycle and architectural ownership:

- Keep a separately installable package when it has a distinct release
  lifecycle, optional or heavyweight dependencies, or an independently useful
  public contract.
- Use a guarded subpath when functionality belongs to the same release unit but
  must remain inaccessible from the package root.
- Treat source-import boundaries as executable architecture. Consolidation must
  not allow internal modules to bypass public ownership rules merely because
  they now share a package.

Under this rule:

- the native filesystem Repository implementation becomes the Repository
  `/fs` subpath;
- Catalog contracts, Indexer, and filesystem announcement Journal share the
  Discovery release unit while retaining guarded internal boundaries and
  distinct public subpaths;
- OCI, SQLite, Recorder, Issuer, and Local Runtime remain separate packages;
- the Journal remains a concrete filesystem binding;
- only Local Runtime composes concrete Catalog storage.

IPFS is an optional future Repository binding, not a prerequisite public rail.
The plugin, not Autopilot itself, owns the future Autopilot recording
integration.

## Final inventory

```text
packages/evidence/
├── protocol                 @jinn-network/evidence-protocol
├── repository               @jinn-network/evidence-repository
├── repository-oci           @jinn-network/evidence-repository-oci
├── discovery                @jinn-network/evidence-discovery
├── catalog-sqlite           @jinn-network/evidence-catalog-sqlite
├── execution-recorder       @jinn-network/execution-recorder
├── attestation-issuer       @jinn-network/attestation-issuer
└── local-runtime            @jinn-network/evidence-local-runtime
```

Each package keeps an independent lockfile and build configuration. Do not add
a root Yarn workspace.

## PR stack

All commits require DCO sign-off. All five pull requests remain draft while the
sibling evidence stacks are open. Each pull request uses its immediate
predecessor as its base.

### PR 1 — Revised consolidation plan

- Branch: `codex/evidence-consolidation-pr1-plan`
- Base: `codex/evidence-consolidation-base`
- Recreate this plan on the synthetic history.
- Do not cherry-pick the earlier unsigned Cursor commit.
- Include only this plan. Do not include the unrelated architecture-map
  deletion or untracked architecture specification from the source worktree.

### PR 2 — Inventory and boundary guards

- Branch: `codex/evidence-consolidation-pr2-guards`
- Base: PR 1
- Add a robust repository-level inventory test for the eleven-package combined
  tree. Inspect only explicit package paths, or verify that `package.json`
  exists before reading a directory.
- Encode the complete allowed Jinn dependency graph.
- Require every declared Jinn dependency to have exactly one matching
  `portal:` resolution and prohibit unmatched Jinn resolutions.
- Fix the announcement Journal's stale Evidence Protocol resolution by matching
  it with the direct dev dependency required for an independent portal-linked
  install, then regenerate its lockfile.
- Add executable source-import guards and canaries:
  - Protocol imports no Jinn package.
  - Repository root neither exposes nor imports filesystem implementation code.
  - Catalog imports neither Indexer nor Journal.
  - Indexer may consume Catalog contracts but not Journal or concrete bindings.
  - Journal does not import Indexer.
  - Recorder and Issuer import neither concrete bindings nor Local Runtime.
  - Only Local Runtime may depend on concrete Catalog storage.
- Run both guards from `repository-structure.yml`.

### PR 3 — Filesystem Repository consolidation

- Branch: `codex/evidence-consolidation-pr3-repository-fs`
- Base: PR 2
- Move the complete filesystem Repository implementation, tests, fixtures, and
  supporting assets into Evidence Repository.
- Export it only at `@jinn-network/evidence-repository/fs`; do not re-export it
  from the root.
- Preserve symbols, repository format, security checks, permissions,
  atomic-write behavior, and on-disk layout.
- Update Local Runtime to use the subpath and remove the old package dependency
  and resolution.
- Delete the predecessor package and update the guarded inventory to ten
  packages.
- Keep Repository and Local Runtime workflows green for this intermediate
  layout.
- Extend packed-install coverage for root, `/testing`, and `/fs`, including
  undeclared-dependency checks.

### PR 4 — Discovery consolidation

- Branch: `codex/evidence-consolidation-pr4-discovery`
- Base: PR 3
- Combine Catalog, Indexer, and the filesystem announcement Journal into
  `@jinn-network/evidence-discovery`.
- Preserve these entry points:
  - root Catalog API;
  - `/testing`;
  - `/indexer`;
  - `/journal`.
- Preserve each moved subtree's internal `index.ts` barrel. Do not rename those
  internal barrels.
- Move all tracked fixtures, scripts, tests, README-relevant assets, and
  specifications required by the combined package.
- Re-export unchanged public symbols from the internal barrels.
- Update SQLite Catalog and Local Runtime imports, dependencies, resolutions,
  tests, and lockfiles.
- Update the inventory to eight flat packages and rewrite source guards for the
  combined internal directories.
- Keep `/journal` a concrete binding: Catalog cannot import it, Indexer cannot
  import its implementation, it may use Node filesystem APIs, and it remains
  independently addressable only through its subpath.
- Keep Discovery and Local Runtime workflows green for the intermediate flat
  layout.
- Delete the three predecessors only after packed imports and dependent
  integrations pass.

### PR 5 — Nested layout and unified CI

- Branch: `codex/evidence-consolidation-pr5-layout-ci`
- Base: PR 4
- Move the final eight packages under `packages/evidence/`.
- Update package repository directories, `portal:` paths, package-local
  scripts, README links, active code/configuration paths, and CI filters.
- Do not rewrite dated historical design documents merely because they contain
  old paths.
- Update the guards to require exactly the final eight directories and final
  dependency graph.
- Replace all six evidence workflows with one `Evidence CI` workflow:
  1. `architecture` runs inventory and source-boundary guards;
  2. `foundation` verifies Protocol then Repository and uploads their `dist/`;
  3. a parallel matrix consumes the foundation `dist/` artifacts and verifies
     Repository OCI, Discovery, Recorder, and Issuer;
  4. `catalog-sqlite` consumes foundation and Discovery artifacts;
  5. `local-runtime` consumes foundation, Discovery, SQLite Catalog, and
     Recorder artifacts;
  6. `verify` is the aggregate gate and depends on every preceding job.
- Run profile drift checks wherever declared.
- Retain individual job visibility while making `Evidence CI / verify` the
  single intended required branch-protection check.
- Before PR 5 merges, a maintainer must update the required-check setting.

## Verification

At the synthetic base and every PR boundary:

- verify immediate base/head SHAs and inspect the stacked diff;
- run immutable install, profile drift checks where applicable, typecheck,
  tests, build, and packed-install smoke checks for every affected package;
- run the complete combined package suite before completing PRs 4 and 5;
- confirm Protocol golden fixtures, record digests, schemas, Repository layouts,
  and Local Runtime behavior are unchanged;
- compare pre/post runtime export keys and compile TypeScript consumers against
  every new subpath;
- verify no predecessor import remains outside dated documentation;
- prove source-boundary canaries reject synthetic forbidden imports;
- install all final tarballs independently with declared dependencies only;
- run `git diff --check`;
- verify every new commit contains a `Signed-off-by:` trailer;
- obtain fresh architecture-boundary and packaging/CI reviews of the final
  head.

## Stack lifecycle

Push the synthetic branch but open no pull request for it. Open the five
consolidation pull requests as drafts and do not merge, publish, or deploy
anything.

After both sibling stacks merge into `next`, retarget PR 1 from the synthetic
branch to `next`. Merge the consolidation pull requests in order, retargeting
each successor to `next` only after its predecessor lands.

Before implementation, confirm every affected npm identity remains unpublished.
If any name resolves, stop and design a compatibility and migration path.
If either upstream exact head changes after the stack is published, refresh the
integration base and coordinate a replacement stack rather than force-updating
the published branches.

The following remain out of scope:

- EpisodeV1 migration;
- plugin integration;
- IPFS and public publication;
- retrieval, search, and corpus policy;
- scrubbing;
- npm publication or release automation.
