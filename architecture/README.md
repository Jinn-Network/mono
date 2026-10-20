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

### Syncing a release

[`.github/scripts/sync-spec-release.mjs`](../.github/scripts/sync-spec-release.mjs) is the only
sanctioned way to change a vendored byte or the pin. Given a release tag it fetches the signed
manifest the release attaches for each release group and the `documents/` tree at that tag,
verifies each manifest's DSSE signature against the pinned key and each document against the
digest its manifest names, places every document through the provenance rows, and writes:

- the documents, into the packages' existing `schemas/`, `profiles/`, and `fixtures/` directories;
- `architecture/spec-provenance.v1.json`: the release, and for each vendored file its served
  path, its repository path, its SHA-256, and the release it came from;
- `architecture/spec-release/`: a byte copy of each signed manifest and its envelope;
- the catalog's `specPin` and `pinned` markers.

```bash
# Report what syncing a release would change. Writes nothing.
node .github/scripts/sync-spec-release.mjs --tag v0.2.0 --check
# Vendor it.
node .github/scripts/sync-spec-release.mjs --tag v0.2.0
```

It refuses and never skips. A missing or failing signature, a document whose digest differs, a
document no manifest lists, a provenance row the release no longer ships, a document with no
place in this tree, and a pinned tag that comes back with another manifest are all errors, and a
refused sync writes nothing.

The signing key's identity is `specPin.signingKey`, and its bytes are read from
`.github/keys/<key id>.pub`, which must hash to that identity. While the catalog pins nothing,
pass the identity with `--key-id` and `--public-key-sha256`. A released document that has no
provenance row yet is an error unless `--adopt` is passed, and `--adopt` places only what the tree
can show: the file this repository already serves at that path, or, for a path scoped by its
source package's name, the same relative path inside that package's declared `schemas`,
`profiles`, or `fixtures`.

## Toolchain bands

A band is the one Node or TypeScript line the repository supports. There is one band for every
release group, recorded here once instead of as a row per group. It answers
[#1595](https://github.com/Jinn-Network/mono/issues/1595) (Node and `@types/node`) and
[#1594](https://github.com/Jinn-Network/mono/issues/1594) (TypeScript). A manifest that differs from
a band today is brought into it by a separate change, not by Dependabot.

### Node and `@types/node`

The band is Node 22, for every release group. Legacy and transitional trees stay in it; none gets an
older band.

- CI, the npm publish workflows, the Dockerfiles that start from a Node image, `.nvmrc` and
  `.node-version` run Node 22. Some verification jobs pin the exact patch.
- Every package that publishes to npm (its catalog `publishPolicy` is not `private`, `never` or
  `disabled`) declares `engines.node` as `>=22`.
- `@types/node` stays on major 22 (`^22`) in every manifest that declares it, so type definitions
  never describe APIs the runtime lacks.
- Dependabot never bumps `@types/node`. Every npm entry in `.github/dependabot.yml` ignores it for
  every update type, so it changes only when the band moves.
- The band moves in one pull request that changes CI, the publish workflows, the Dockerfiles,
  `.nvmrc`, `.node-version`, the Node version stated in `CLAUDE.md`, `engines` and `@types/node`
  together, and not before Node 22 leaves maintenance support. The public Node release schedule ends
  that on 30 April 2027.

### TypeScript

The band is TypeScript 5.9 (`^5.9.3`) for every package that publishes declarations or is imported
by another package, in every release group, with one named exception: `operator`.

- A leaf application that nothing imports may run a newer major and never has to move back. Today
  `apps/operator-console`, `apps/website` and `packages/benchmark-product/web` run 6.x.
- `operator` is the exception: it publishes declarations and stays on 6.x. Nothing in the repository imports it, and `.github/scripts/operator-packed-types.test.mjs` compiles a TypeScript 5.9.3 consumer against its packed declarations in CI.
- No package in the repository compiles against declarations produced by a newer major than its own.
- Fixtures, examples and `contracts` are outside this policy and follow none of it.
- Dependabot ignores `typescript` major updates in every npm entry of `.github/dependabot.yml`, so no
  package moves to TypeScript 7 until an issue names the first leaf application to move.
- A new major reaches a leaf application first, once `tsc --noEmit` and its tests pass. A package that
  publishes declarations or is imported moves only when a consumer needs the newer major, consumers
  before the packages they import, with its group's CI and packed-types tests green.

### Set aside

- Per-group bands. Four of the five publishing groups already sit in both bands, one package
  (`packages/contract-abis`) aside; the fifth, `legacy-product-lines`, does not yet, and the policy
  gives it no band of its own.
- A newer Node with `@types/node` tracking it, or Dependabot moving `@types/node` within `^22`. The
  first moves CI, publish jobs, Dockerfiles and every `engines` field for no product reason; the
  second keeps a weekly line in every directory for typings a person can bump by hand.
- A repository-wide TypeScript 6 or 7, or forcing the leaf applications back to 5.9. The first moves
  every declaration consumer for no product reason; the second churns trees that nothing imports.

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
