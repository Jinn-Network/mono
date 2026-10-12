# Architecture control

Jinn's package architecture has one human-authored membership authority:
[`platform-packages.v1.json`](./platform-packages.v1.json). Package manifests remain authoritative
for npm identity, version, dependencies, files, exports, privacy, and publication metadata. The
approved specifications and decision records define semantics and rationale; they do not replace
the catalog or manifests.

Catalog completeness is checked independently of `manifestRoots`: repository-wide discovery
parses every tracked or non-ignored `package.json` and requires each `@jinn-network/*` manifest to
have exactly one catalog record. A deliberately unmanaged first-party manifest must instead have
one `manifestExclusions` entry recording its path, reason, owner group, classification, and review
condition. `manifestRoots` remain the governed layout and generation policy; they do not define
the completeness universe.

The reviewable live projection is
[`generated/platform-topology.md`](./generated/platform-topology.md) (repository path
`architecture/generated/platform-topology.md`). Its machine-readable peer is
[`generated/platform-topology.v1.json`](./generated/platform-topology.v1.json). Both are generated;
never edit either by hand.

## Boundary and tier direction

The platform boundary and four-tier law are owned by the
[platform architecture specification](../docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md).
The catalog assigns each package its tier and classification, and `tierRules.allowedDependencies`
is the executable direction policy. Runtime ordering uses only `dependencies`,
`optionalDependencies`, and `peerDependencies`; development dependencies never create an
architecture or release edge.

## Release groups

Release membership and policy come only from the catalog. The generated
[release view](./generated/platform-topology.md#release-and-trusted-publishers) shows each exact
set, trusted-publisher inputs, canary eligibility, disabled groups, independent lines, and the
stable-hosting blocker. A release group's declared policy set must exactly equal its member-policy
union, and its publication flags must agree with every member. Canary packing, trusted-publisher
generation, and registry access independently require a catalog-eligible canary group. A directory
name is never release authority.

## Spec release pin

The protocol's documents are authored in
[`Jinn-Network/spec`](https://github.com/Jinn-Network/spec), and this repository consumes one
pinned release of them
([DR-2026-09-03](../log/decisions/2026-09-03-protocol-spec-repository.md), decision 1). The
catalog records the pin in two places that must agree:

- `specPin` is `null` or one object: `tag` (the release tag, `v<major>.<minor>.<patch>`),
  `groups` (the SHA-256 of the signed manifest the release ships for each release group), and
  `signingKey` (the id of the key that signed those manifests, and the SHA-256 of that key's
  canonical SPKI PEM).
- A package whose `schemas`, `profiles`, or `fixtures` are vendored from the pinned release
  carries `pinned: true`. A package that is not vendored leaves the field out.

`specPin: null` with no `pinned` marker means no release is pinned. The catalog loader refuses a
marker without a pin, a pin with a release group in which no package is pinned, a pinned package
whose release group has no manifest digest, and a pinned package with no document surface.

## Ownership and generated views

Task 6's architecture-control validator applies last-match semantics from
[`.github/architecture-owners`](../.github/architecture-owners) to catalog
authorities, manifests, boundary policies, gates, public surfaces, conformance assets, and
generator sources. That file is the PAC ownership inventory, not GitHub's enqueue
CODEOWNERS gate (see [`.github/CODEOWNERS`](../.github/CODEOWNERS) and
[DR-2026-08-20](../log/decisions/2026-08-20-human-surface-enqueue-gate.md)). The generated ownership section embeds that validator's report rather than
maintaining a second ownership model.

Regenerate after any catalog, manifest, public-surface, gate, or ownership change:

```bash
node .github/scripts/generate-architecture.mjs
node .github/scripts/generate-architecture.mjs --check
```

Check mode regenerates into a temporary directory and byte-compares the exact tracked artifact
set. Missing, changed, or unknown files fail.

### Merge conflicts in generated topology

Two PRs that change the catalog in parallel both regenerate
`architecture/generated/platform-topology.md` and
`architecture/generated/platform-topology.v1.json`. Git then attempts a textual
three-way merge of independently derived bytes. The correct resolution is never a
hand merge — discard both conflict sides and re-run the generator:

```bash
git checkout --theirs architecture/generated/platform-topology.v1.json architecture/generated/platform-topology.md
node .github/scripts/generate-architecture.mjs
node .github/scripts/generate-architecture.mjs --check
git add architecture/generated
```

When merging the target base into a PR branch, `--theirs` selects the incoming base
version before regeneration. Resolve any semantic catalog or manifest hunks first,
then run this block once inputs are consistent. The `--check` contract above is
unchanged.

## Atomic package procedures

For every operation below, update the manifest and catalog in one change, update the owning
design or decision record when semantics change, extend the declared gate/boundary/public-surface
inputs, confirm `.github/architecture-owners` coverage, regenerate, and run the catalog, topology, public-surface,
architecture-control, and generated-drift tests.

- **Add:** create the manifest, add exactly one catalog record, assign tier/classification,
  release group, gates, ownership, boundary policy, and public surfaces, then prove dependency
  closure and direction.
- **Move:** move the manifest tree and change its catalog path atomically. Preserve package identity
  unless a separately approved API migration says otherwise; repair every catalog-owned path.
- **Deprecate:** set the stability and required transition metadata, including reason, status,
  supersession/replacement links, and a mechanical sunset condition. Do not delete the entry while
  the manifest remains in catalog scope.
- **Promote:** change stability or release group only with its required gates and publication policy
  already valid. Promotion is one atomic catalog change plus regenerated evidence; editing a
  workflow or directory list cannot promote a package.
