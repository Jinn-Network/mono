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
