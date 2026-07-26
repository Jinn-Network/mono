# Evidence Substrate Implementation Foundation

**Date:** 2026-07-26

**Status:** read this first; operational source of truth for the next implementation stack

This document exists to remove setup and location ambiguity. It does not restate the three package
specifications. If another plan disagrees with this document about the base branch, package path,
shared-file ownership, prerequisite order, or PR stack, this document wins and the stale plan must
be corrected before code is written.

It contains no workstation paths or credentials. Use repository-relative paths and a fresh
worktree chosen by the implementer.

## 1. Exact foundation

The implementation stack begins on the complete Evidence consolidation head:

```text
PR:          #2182
branch:      codex/evidence-consolidation-pr5-layout-ci
known head:  ce68af63d851a49318351552f35969a5c39b758a
```

Before creating any implementation branch:

1. fetch the remote branch;
2. verify its current head;
3. if the head differs from the known head, inspect the delta and record the refreshed SHA;
4. create a clean, dedicated worktree from that exact head; and
5. do not copy unrelated changes from the primary checkout.

The design documents may initially be supplied as one clean docs-only commit. That commit becomes
the first stacked branch. Do not import an unrelated architecture-map deletion, legacy cleanup, or
other dirty-worktree content.

All PRs remain draft and target their immediate predecessor. Nothing in this stack is merged,
published to npm, deployed, or wired into the plugin.

## 2. Current package map

The starting tree contains exactly eight package directories:

```text
packages/evidence/
├── protocol
├── repository
├── repository-oci
├── discovery
├── catalog-sqlite
├── execution-recorder
├── attestation-issuer
└── local-runtime
```

Important existing subpaths:

```text
@jinn-network/evidence-repository/fs
@jinn-network/evidence-repository/testing
@jinn-network/evidence-discovery/testing
@jinn-network/evidence-discovery/indexer
@jinn-network/evidence-discovery/journal
@jinn-network/execution-recorder/testing
```

Do not recreate predecessor packages such as `evidence-repository-fs`, `evidence-catalog`,
`evidence-indexer`, or `evidence-announcement-journal`.

The completed stack adds three package directories:

```text
packages/evidence/
├── repository-ipfs
├── derivation
└── publication
```

Publication also exports a guarded concrete binding at
`@jinn-network/evidence-publication/fs`. Its root must not expose filesystem implementation code.

## 3. One prerequisite contract change

Repository capabilities land before any of the three new packages:

```ts
export interface EvidenceRepositoryCapabilities {
  readonly maxObjectBytes?: number;
}

export interface EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;
  // existing methods unchanged
}
```

Add `CONTENT_TOO_LARGE` to the stable `EvidenceRepositoryError` code union.

Update:

- the repository contract and `/testing` contract kit;
- the in-memory test repository;
- the `/fs` implementation;
- the OCI implementation; and
- every existing repository test double.

Bindings without a smaller finite application-level limit expose `{}`. The IPFS binding later
declares `2 * 1024 * 1024`. Publication preflights all supplied record and artifact bytes before
external effects.

That IPFS write capability requires Kubo v0.40.0 or newer. Kubo v0.40.0 is the first release whose
standard `block.put` accepts 2 MiB without `allow-big-block`; the implementation-time current
stable release is v0.42.0. The full write-conformance matrix pins v0.40.0 as the compatibility floor
and v0.42.0 as current stable. The observed Autonolas Kubo v0.32.1 remains a bounded
reader/error-envelope compatibility target only and is not a supported
`IpfsEvidenceRepository` writer. Targeting that node for writes requires an operator-managed Kubo
upgrade outside this stack. Do not reduce the repository capability or enable `allow-big-block` to
claim compatibility with an older writer.

Kubo v0.40.0 and v0.42.0 also establish that `block.put(pin=true)` records a raw block as an
explicit `recursive` pin. The IPFS binding accepts an explicit `direct` or `recursive` local pin as
custody and rejects `indirect`-only state. For a raw block there are no descendants, so both
explicit pin classes protect the same single block from garbage collection. Do not add a second
pin mutation merely to rewrite Kubo's pin class.

The repository implementation object itself is not a Proxy, and its `capabilities` slot is an own
data property rather than an accessor or inherited property. The contract kit rejects a repository
Proxy before invoking any other reflection, inspects the slot descriptor before using its value,
and proves the descriptor value remains stable for the repository lifetime. The slot need not be
runtime non-writable; TypeScript `readonly` plus the stable-value contract remains the public
surface.

The capability value is an inert immutable snapshot, not a negotiation object or behavior-bearing
port. It has either `Object.prototype` or `null` as its prototype, is non-extensible, and exposes
only own non-writable, non-configurable data properties. `maxObjectBytes`, when present, is such an
own data property; accessors and inherited limits are invalid. Unknown future own data properties
remain permitted and are ignored semantically by v1 consumers, but they obey the same immutable
snapshot rules. The repository returns the same snapshot, prototype, keys, descriptors, and values
for its lifetime. Proxy objects are invalid and must be rejected before any other reflection
because reflection itself can invoke proxy traps.

These repository-slot and snapshot rules ensure capability preflight cannot invoke getters,
setters, inherited behavior, proxy traps, or ambient I/O before the caller's intended effects.

This is the only planned change to an existing public evidence contract. If implementation
discovers another necessary cross-package contract change, stop and update the design before
proceeding.

## 4. Read in this order

1. This document.
2. `docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md`.
3. For PR 2,
   `docs/superpowers/plans/2026-07-26-evidence-repository-capabilities.md`.
4. For later PRs, the relevant package design:
   - `docs/superpowers/specs/2026-07-26-evidence-derivation-design.md`;
   - `docs/superpowers/specs/2026-07-26-evidence-repository-ipfs-design.md`; or
   - `docs/superpowers/specs/2026-07-25-evidence-publication-design.md`.
5. The matching implementation plan under `docs/superpowers/plans/`.
6. The existing implementation at the exact base head.

Source-of-truth order is:

```text
Evidence Protocol
  > this operational foundation for repository/stack mechanics
  > package design
  > package implementation plan
  > illustrative legacy code
```

An implementation plan is executable guidance, not permission to contradict its design. If a
copied code snippet is stale, correct the plan rather than implementing the stale snippet.

## 5. Locked boundaries

- Evidence Protocol owns semantic conformance.
- Repository owns exact-byte persistence and integrity, not listing or admission.
- Derivation's functional core, built-in detectors, and every conforming injected detector form a
  pure byte-in/byte-out transform with no repository, network, durable filesystem, clock,
  randomness, or other ambient I/O. An injected detector receives private transformable plaintext
  and is therefore trusted application code; JavaScript provides no sandbox, and the conformance
  kit is evidence rather than isolation.
- IPFS is one bounded repository binding, not the mandatory public rail. Its writer requires Kubo
  v0.40.0 or newer for the standard inclusive 2 MiB block boundary.
- Publication stores exact artifacts, then exact records, then announces record references.
- Publication does not validate Evidence Protocol conformance.
- The sink owns exact physical framing and measurement; the pipeline owns deterministic partition
  choice and recovery.
- Discovery owns source-to-catalog indexing and queries. Publication does not import it.
- A concrete announcement medium is not part of this stack.
- Credentials, wallets, trust, retention, corpus membership, search, ranking, and recommendation
  remain above or outside these packages.
- The plugin owns future Autopilot recording integration. Autopilot itself is not modified.
- `EpisodeV1`, legacy stores, `packages/core` deletion, and application cutover remain untouched.

## 6. Operational PR stack

Use this review order:

1. **Docs foundation** — corrected architecture, three package designs, three implementation
   plans, and this document.
2. **Repository capabilities** — `maxObjectBytes`, `CONTENT_TOO_LARGE`, all existing bindings and
   contract tests.
3. **Derivation contracts and engine** — exact transform, detectors, codecs, public graph, root
   packed install, root boundary guards, and provisional CI coverage.
4. **Derivation hardening and distribution** — public conformance kits and `/testing`, adversarial
   tests, expanded packed install, and final CI coverage.
5. **IPFS profile and pure mapping** — CID helpers, registration profile, schema, fixtures, drift
   tests, and bounded Kubo/gateway readers with hermetic unit tests.
6. **IPFS adapter and distribution** — exact writes, real-Kubo contract tests, packed install, and
   CI DAG update.
7. **Publication contracts and durable journal** — public API, identities, sink/journal kits, and
   `/fs`.
8. **Publication pipeline and distribution** — repository preflight, exact frame planning,
   store-before-announce recovery, crash matrix, packed install, CI DAG update.

Derivation and the IPFS profile can be developed in parallel from the exact repository-capabilities
head. Publication contracts may also begin there. The coordinator still integrates them in the
fixed order above so every public PR has one immediate base and the final DAG is deterministic.

Do not stack one stream on an unreviewed private subagent branch. Subagents work in isolated
worktrees; the coordinator reviews and cherry-picks bounded commits onto the public stack.

## 7. Shared-file ownership

Only the integration coordinator edits these files:

```text
.github/scripts/evidence-package-inventory.test.mjs
.github/scripts/evidence-source-boundaries.test.mjs
.github/scripts/evidence-packed-types.test.mjs
.github/workflows/evidence-ci.yml
```

Package subagents own only their assigned package directory, tests, fixtures, and package-local
lockfile. A repository-capabilities subagent may edit `repository`, `repository-oci`, and affected
test doubles only when explicitly assigned that cross-package prerequisite.

The coordinator:

- updates exact package inventory from 8 to 11 as packages land;
- adds boundary canaries before accepting new imports;
- extends the existing dependency-aware Evidence CI DAG rather than creating per-package
  workflows;
- updates package-local `portal:` resolutions and lockfiles;
- checks every tarball independently; and
- resolves all export-map and shared-script changes after cherry-picking.

## 8. Required gates at every PR boundary

Run the affected package's immutable install, profile drift checks where declared, typecheck,
tests, build, and packed-install smoke test. Also run:

```text
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
node --test .github/scripts/evidence-packed-types.test.mjs
git diff --check
```

Before the final PR, run the complete Evidence CI dependency order and install all eleven packed
packages in clean temporary consumers.

Every implementation commit has a DCO `Signed-off-by:` trailer. Use TDD for new behavior. Obtain
fresh independent architecture-boundary and durability/security reviews on each package's final
head.

## 9. Stop conditions

Stop and report rather than improvising if:

- PR #2182's refreshed head materially changes the eight-package architecture;
- any affected npm identity has been published;
- the repository capability change requires another record or store semantic;
- a pinned supported Kubo writer (v0.40.0 or v0.42.0) rejects exactly 2 MiB under standard
  `block.put` with `allow-big-block` disabled;
- a sink cannot prepare exact frame bytes without an external effect;
- a plan requires credentials inside shared substrate;
- a source-boundary guard must be weakened to make an import work; or
- a change would touch plugin, marketplace, Autopilot, legacy cutover, or concrete public-medium
  code.

These are design findings, not implementation inconveniences.
