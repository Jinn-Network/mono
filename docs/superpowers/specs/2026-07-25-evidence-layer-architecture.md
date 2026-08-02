# Evidence Layer Architecture

**Date:** 2026-07-25

**Status:** settled for the evidence substrate; updated after package consolidation

**Live package view:** the catalog-derived [generated platform topology](../../../architecture/generated/platform-topology.md#inventory)
is the current authority for evidence package membership, roles, paths, dependencies, release
classification, and public surfaces. This dated design owns the role boundaries and semantics; it
does not maintain a parallel package inventory.

**Scope:** how evidence entrypoints and guarded source regions stratify, what each role owns, how
the consolidated packages preserve those boundaries, and where the remaining primitives belong

**Out of scope:** protocol semantics (see
`2026-07-23-jinn-execution-evidence-protocol-design.md`), application policy, migration from
`EpisodeV1`, and implementation sequencing

**Implementation entrypoint:** read
`../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` before using this design to
write code.

## 1. Decision

Evidence code stratifies into seven architectural roles. The unit that has exactly one role is a
**public entrypoint or guarded source region**, not necessarily an npm package.

An npm package is a release and cohesion boundary. It may contain more than one architectural role
when all of the following hold:

1. each role has a distinct public subpath or private source region;
2. the root entrypoint does not re-export a concrete binding;
3. source-import guards prevent higher-level or concrete code from leaking into lower-level
   regions; and
4. consumers can depend on the contract without importing the binding.

This is already the shape of the consolidated implementation:

- `@jinn-network/evidence-repository` is a contract at its root and exposes its filesystem binding
  only at `/fs`;
- `@jinn-network/evidence-discovery` exposes catalog contracts at its root, the indexer pipeline at
  `/indexer`, and a concrete filesystem announcement journal at `/journal`.

Architecture is therefore derived from three surfaces together:

- package dependency manifests;
- public `exports` maps; and
- source-import boundary guards.

No one of those surfaces is sufficient by itself. In particular, `package.json` cannot describe
the internal role separation of a consolidated package.

## 2. Role rules

| Role | Test for membership |
| --- | --- |
| Semantics | Changing it changes the evidence protocol or its conformance rules |
| Contract | Defines a port, value types, errors, and usually a reusable contract kit |
| Binding | Adapts one external medium or durable mechanism to a contract |
| Producer | Creates a conforming record from an observed or reported execution |
| Pipeline | Moves or transforms records without adding protocol record families |
| Composition | Wires one deployment shape and owns no domain policy |
| Policy | Interprets evidence to admit, rank, trust, retain, recommend, or otherwise decide |

The producer/pipeline boundary is deliberate. The execution recorder and attestation issuer create
records from the world. Derivation creates a record from an existing record, so it is a pipeline.
Publication moves exact records and artifacts into a remote repository and announces their
availability, so it is also a pipeline.

A binding is defined by the medium it adapts, not by an arbitrary package count. A package may
export both a writer and reader for one medium when they share a release lifecycle, but
co-location is not the interoperability mechanism. A normative medium profile and independent
sink-to-source compatibility tests are.

## 3. Consolidated stack

```text
applications
  operator app        plugin        marketplace operator        other producers/consumers
       │                 │                    │
       └─────────────────┴────────────────────┘
                                 │
policy and views
  admission   corpus membership   ranking   trust   search   recommendation
                                 │
composition
  @jinn-network/evidence-local-runtime
                                 │
record-producing and record-moving roles
  producers: execution-recorder   attestation-issuer
  pipelines: discovery/indexer   derivation*   publication*
                                 │
contracts and bindings
  repository root ─────── repository/fs
          ├────────────── repository-oci
          └────────────── repository-ipfs*
  discovery root ──────── discovery/journal
          └────────────── catalog-sqlite
  publication root* ───── publication/fs*
                                 │
semantics
  @jinn-network/evidence-protocol

* = designed, not yet implemented
```

Dependencies point toward lower-level contracts and semantics. Concrete composition roots may
depend on the bindings they wire. Policy and applications sit above the substrate and are not
imported by it.

The plugin, not Autopilot, owns the Autopilot recording integration. Autopilot invokes the plugin;
the plugin maps that execution into the producer-neutral recorder API.

## 4. Implemented primitives

The current implemented evidence-domain packages and subpaths are recorded in the generated
[inventory](../../../architecture/generated/platform-topology.md#inventory), with their
manifest-derived dependency edges in the generated
[runtime topology](../../../architecture/generated/platform-topology.md#runtime-dependency-topology).
The role distinctions in §2–§3 remain normative even when one package exposes multiple guarded
entrypoints. New implementation work changes the catalog and generated view atomically rather than
adding another intended-home table here.

A concrete public announcement medium is **not** designed by these documents. Publication defines
the sink port and the shared recovery pipeline. A later medium profile and adapter must implement
the write side and compose with an `EvidenceRecordAnnouncementSource` on the discovery side.

The `DsseSigner` port is not a gap. It is already injected into the attestation issuer. Key
resolution and trust policy remain higher-level concerns.

## 5. Directory and package rules

Domain remains a stable nesting axis and layer is not a directory axis. The catalog's `evidence`
domain entries in the generated [inventory](../../../architecture/generated/platform-topology.md#inventory)
are the current directory and package view; this design does not freeze a second tree listing.

The repository asserts this structure through:

- `.github/scripts/evidence-package-inventory.test.mjs`;
- `.github/scripts/evidence-source-boundaries.test.mjs`;
- `.github/scripts/evidence-packed-types.test.mjs`; and
- `.github/workflows/evidence-ci.yml`.

Those guards must be extended whenever a package or subpath is added. They are the executable
architecture map. A dated design document may explain a boundary, but it does not replace a
failing import canary.

## 6. Data flows

Local capture and retrieval:

```text
world
  └─▶ plugin/producer adapter
       └─▶ execution-recorder
            └─▶ repository/fs
                 └─▶ discovery/journal
                      └─▶ discovery/indexer
                           └─▶ catalog-sqlite

consumer ─▶ discovery query ─▶ record digest ─▶ repository.get ─▶ exact bytes
```

Public derivation and publication:

```text
private record + exact artifacts
  └─▶ derivation
       └─▶ public record + public artifacts + scrub receipt
            └─▶ publication
                 ├─▶ remote EvidenceRepository
                 └─▶ AnnouncementSink
                              │
remote AnnouncementSource ─▶ discovery/indexer ─▶ catalog
consumer ─▶ catalog query ─▶ remote repository ─▶ exact bytes
```

The repository does not list, search, admit, rank, retain, or discover relationships. Discovery
projects announcements into a queryable catalog. Search, semantic similarity, ranking, and corpus
membership are optional policy or view modules above that catalog boundary.

## 7. Authority is a layering boundary

Shared substrate must not silently acquire application authority.

> Shared contracts and pipelines accept authority-bearing behavior only through injected ports.
> Shared bindings may consume an injected authority-bearing client or callback, but must not
> acquire, persist, serialize, infer, or expose credentials.

This rule permits:

- an IPFS repository binding to use an injected authenticated Kubo client;
- the attestation issuer to call an injected `DsseSigner`; and
- a future chain sink to call an injected transaction sender.

It forbids those packages from reading wallet files, accepting secrets as convenient string
options, inventing identity from credentials, or owning key lifecycle.

The application decides which credentialed capability to inject and what authority it represents.
The evidence substrate records exact effects and identities supplied through its contracts; it does
not decide whether they should be trusted.

## 8. Settled boundaries

- Protocol owns record structure and conformance, not stores, discovery, or policy.
- Repositories own exact-byte persistence and integrity, not listing or admission.
- Recorder and issuer produce records; derivation transforms them.
- Publication owns store-before-announce recovery over abstract ports.
- Discovery owns source-to-catalog indexing and query contracts, not remote publication.
- A sink and source for the same medium may share a package, but interoperability comes from a
  normative medium profile and round-trip tests.
- Concrete credentials and trust decisions stay with applications and policy.
- `packages/core` migration and deletion are separate legacy-cleanup work.

No architecture ambiguity remains before implementing repository capabilities, derivation, IPFS,
and publication. Search modules, public-medium selection, and plugin cutover are deliberately later
designs rather than hidden decisions inside this substrate.
