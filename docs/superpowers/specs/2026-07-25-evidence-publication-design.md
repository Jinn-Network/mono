# Evidence Publication Design

**Date:** 2026-07-25

**Status:** design settled; updated after repository, discovery, and package consolidation

**Scope:** `@jinn-network/evidence-publication` — the `AnnouncementSink` port, deterministic
bundle planning, store-before-announce recovery, reconciliation, a durable filesystem journal
binding, and the boundary between shared substrate and application-held authority

**Out of scope:** Evidence Protocol semantics, the IPFS repository binding, public derivation,
search and corpus policy, a concrete announcement medium, signing, wallet ownership, and migration
from the legacy publication path

**Implementation entrypoint:** read
`../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is authoritative
for the base branch, repository capability prerequisite, package paths, shared-file ownership, and
PR order.

## 1. Decision

Publication is the write-side counterpart to discovery:

```text
exact records and artifacts
  └─▶ publication
       ├─▶ remote EvidenceRepository
       └─▶ AnnouncementSink
                          │
remote AnnouncementSource ─▶ discovery/indexer ─▶ catalog
```

The package owns:

- exact input normalization and identity;
- repository capability preflight;
- store artifacts before records;
- deterministic partition planning using the sink's exact physical framing;
- a durable recovery journal;
- idempotent placement and reconciliation over an abstract sink; and
- conformance kits for sink and journal implementations.

It does not validate Evidence Protocol conformance. The repository and publication layers verify
only reference syntax and exact-byte digests. A producer or caller decides whether the records are
semantically admissible before publication.

## 2. What this package refuses

The legacy publication path combined transport with application policy. These concerns stay out:

| Concern | Owner |
| --- | --- |
| Contribution economics, price, or veto | Application policy |
| Result polarity or evaluation meaning | Evidence Protocol and evaluator |
| Operator wallet, agent EOA, or registry identity | Application |
| Credential acquisition and persistence | Application |
| DSSE signing | Attestation issuer through injected `DsseSigner` |
| Chain ID, registry address, or transaction replacement policy | Concrete sink |
| Corpus admission, retention, ranking, or search | Policy and views |
| `EpisodeV1` conversion | Legacy migration |
| Scrubbing and public derivative creation | Evidence derivation |

The shared package may call an injected authority-bearing sink. It must not accept passwords,
tokens, private keys, or wallet files as publication options.

## 3. Logical publication input

Publication receives all exact bytes required to make a selected set of records retrievable:

```ts
export interface PublishRecord {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

export interface PublishArtifact {
  readonly reference: EvidenceArtifactReference;
  readonly bytes: Uint8Array;
}

/** Absolute IRI naming the configured repository/announcement destination. */
export type DestinationScope = string;

export interface PublishInput {
  readonly records: readonly PublishRecord[];
  readonly artifacts?: readonly PublishArtifact[];
  readonly destination: DestinationScope;
  readonly signal?: AbortSignal;
}
```

Each supplied byte sequence must match its declared SHA-256 reference. Record families are part of
record identity. Artifact identity is digest-only.

Normalization is deterministic:

1. require at least one record;
2. validate every reference and exact digest;
3. sort records by family, then digest;
4. sort artifacts by digest;
5. collapse byte-identical duplicate declarations; and
6. reject two declarations of the same reference whose bytes differ.

Artifacts and records remain independent repository objects. Publication does not infer which
artifacts a record references and does not rewrite either. The caller supplies the closure it wants
to publish.

The logical bundle identity is a SHA-256 digest of a versioned canonical local representation
containing:

- ordered record references;
- ordered unique artifact references; and
- destination scope.

It does not include transient repository receipts or medium placement results. This serialization
is recovery state, not a public interoperability format.

## 4. Physical framing belongs to the sink

The pipeline chooses partitions, but only the sink knows the exact size and bytes of a physical
announcement frame. Record body sizes are irrelevant to an OCI index, DAG-JSON list, or chain
calldata frame that contains record references.

The sink therefore exposes a pure preparation operation:

```ts
export interface AnnouncementMember {
  readonly reference: EvidenceRecordReference;
}

export interface AnnouncementPreparationContext {
  readonly destination: DestinationScope;
  readonly partitionOrdinal: number;
}

export interface PreparedAnnouncement {
  readonly medium: string;
  readonly profile: string;
  readonly members: readonly AnnouncementMember[];
  readonly frameBytes: Uint8Array;
  readonly frameDigest: Sha256Digest;
  readonly frameSize: number;
}

export interface AnnouncementSinkCapabilities {
  readonly maxMembersPerAnnouncement?: number;
  readonly maxFrameBytes?: number;
}

export interface AnnouncementSink {
  readonly medium: string;
  /** Absolute, versioned medium-profile IRI, frozen when the sink is constructed. */
  readonly profile: string;
  readonly capabilities: AnnouncementSinkCapabilities;

  prepare(
    members: readonly AnnouncementMember[],
    context: AnnouncementPreparationContext,
    options?: RepositoryOperationOptions,
  ): Promise<PreparedAnnouncement>;

  place(
    prepared: PreparedAnnouncement,
    idempotencyKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<PlaceResult>;

  reconcile(
    prepared: PreparedAnnouncement,
    pending: PendingAnnouncement,
    options?: RepositoryOperationOptions,
  ): Promise<ReconcileResult>;
}

export interface OpaqueSinkState {
  /** Absolute, versioned format IRI owned by the concrete medium profile. */
  readonly format: string;
  readonly bytes: Uint8Array;
}

export interface Placement {
  readonly externalId: string;
  readonly state?: OpaqueSinkState;
}

export interface PendingAnnouncement {
  readonly idempotencyKey: Sha256Digest;
  readonly frameDigest: Sha256Digest;
  /** Absent for the intent checkpoint written before the first placement call. */
  readonly state?: OpaqueSinkState;
}

export type PlaceResult =
  | { readonly status: "placed" | "existing"; readonly placement: Placement }
  | { readonly status: "pending"; readonly pending: PendingAnnouncement };

export type ReconcileResult =
  | { readonly status: "placed" | "existing"; readonly placement: Placement }
  | { readonly status: "pending"; readonly pending: PendingAnnouncement }
  | { readonly status: "not-found" }
  | {
      readonly status: "reverted";
      readonly externalId?: string;
      readonly reason?: string;
    };
```

`frameBytes` and every `OpaqueSinkState.bytes` value contain only non-secret publication and
recovery data. Credentials, private keys, bearer tokens, wallet authority, and other secrets are
closed over by the injected sink capability and never serialized into prepared frames, pending
state, placement state, journal entries, or receipts. The shared pipeline treats these bytes as
opaque and cannot discover an arbitrary secret by inspection, so every concrete sink must run its
contract tests with printable and binary synthetic authority markers. The tests recursively scan
all returned and persisted sink fields, journal encodings, logical receipts, and thrown or mapped
error graphs for the raw markers and their canonical hex, base64, base64url, and URL encodings.
Error scans include messages plus every inert own field and recursively bounded `cause` chains;
cycles are detected and do not terminate the test walk. This is scoped conformance evidence for
the tested implementation, not a sandbox or proof against dishonest authority-bearing code.

`prepare` may be synchronous internally, but the contract is asynchronous for a uniform port. It
must perform no network, repository, durable filesystem, clock, randomness, or other ambient I/O.
All framing configuration must be frozen when the sink is constructed.

For the same normalized members and preparation context it must return identical frame bytes,
digest, size, medium, profile, and member sequence. `frameSize` must equal
`frameBytes.byteLength`. `PreparedAnnouncement.medium` and `.profile` must equal the sink's
immutable `medium` and `profile`. Its `members` must equal the requested candidate
element-for-element by canonical record family and digest, with the same length and order.
Defensive clones are valid; omission, substitution, reordering, or duplication is not. The
pipeline validates these invariants before accepting a size result, checkpointing a plan, placing,
or reconciling. A member, medium, or profile mismatch is `SINK_PROTOCOL_VIOLATION` even when the
returned frame bytes, digest, and size are otherwise self-consistent.

If the medium cannot prepare an exact frame without creating an effect, it does not conform to
this v1 sink contract. `medium`, `profile`, destination scope, and opaque-state format identifiers
are absolute IRIs.

The pipeline uses deterministic greedy partitioning in normalized record order. It tests each
candidate member set through `prepare` and freezes the largest candidate that satisfies both sink
capabilities. A single member that cannot fit fails before placement.

The resulting prepared plan — including each partition's immutable sink medium and profile, exact
frame bytes, and digests — is journaled before the first placement. Recovery never repartitions
an existing bundle with changed code or sink limits.

## 5. Sink and source interoperability

An announcement has value only if a remote `EvidenceRecordAnnouncementSource` can decode it. The
sink's injected medium configuration and the absolute destination scope supply whatever physical
repository locator the frame requires; the publication contract itself carries only repository
record references. Each concrete medium therefore requires a normative, versioned profile
specifying:

- the physical frame;
- member reference and repository-location encoding;
- announcement identity;
- ordering and duplicate rules;
- unsupported-version behavior; and
- cursor and replay behavior on the source side.

Sink and source implementations for one medium may live in the same package when they share a
release lifecycle. They may also be separate when authority or deployment boundaries differ.
Co-location is a convenience, not the contract.

Interoperability is established by:

1. the normative medium profile;
2. golden frame fixtures; and
3. a sink-to-source round-trip test using independently addressable entrypoints.

Discovery's indexer remains medium-agnostic. The source unwraps a physical frame into per-record
announcements before the indexer sees it.

## 6. Identities and idempotency

Publication uses four separate identities:

| Identity | Meaning |
| --- | --- |
| Record/artifact digest | Canonical identity of exact protocol or artifact bytes |
| Bundle key | Identity of normalized requested publication input |
| Prepared frame digest | Identity of exact sink-owned physical frame bytes |
| Placement identity | Medium-specific external effect returned by the sink |

The idempotency key for one placement is derived from:

- bundle key;
- destination scope;
- partition ordinal;
- prepared frame digest; and
- sink medium/profile.

The pipeline never assumes a transaction hash, CID, OCI manifest digest, or URL is the canonical
evidence identity.

Before the first `place`, the pipeline journals a `PendingAnnouncement` containing the
idempotency key and frame digest with no sink state. This makes a lost response recoverable:
`reconcile` receives the exact prepared frame plus that intent and must inspect the medium by
idempotency key/frame. It returns `not-found` only when it can authoritatively establish that no
effect exists; only then may the pipeline call `place`.

`place` must also be idempotent for the same idempotency key and prepared frame. It returns one of:

- `placed`: the effect is confirmed;
- `pending`: an effect may exist and must be reconciled;
- `existing`: an equivalent effect already exists.

If the same idempotency key is observed with incompatible prepared bytes, the sink throws
`IDEMPOTENCY_CONFLICT`. Opaque sink state is byte-preserved in the journal and interpreted only by
the same medium implementation/profile named by its absolute format IRI. Recovery rejects a
journaled prepared partition whose medium or profile differs from the injected sink's immutable
medium or profile before calling `place` or `reconcile`.

## 7. Repository capability preflight

The repository contract exposes read-only capabilities:

```ts
export interface EvidenceRepositoryCapabilities {
  readonly maxObjectBytes?: number;
}

export interface EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;
  // existing methods unchanged
}
```

`undefined` means the binding declares no finite application-level maximum, not that every backend
can accept infinite data.

The Repository prerequisite guarantees that the repository is non-proxy, its `capabilities` slot
is a stable own data property, and the value is an inert immutable snapshot with a plain or null
prototype and own immutable data fields. Publication reads only `maxObjectBytes` and ignores
unknown future fields. Repository and snapshot Proxies, accessors, and inherited slots/limits are
nonconforming and rejected by the Repository contract kit. This keeps conforming preflight
side-effect-free.

Before any repository or sink effect, publication verifies that every supplied record and artifact
fits the target repository's declared `maxObjectBytes`. This is essential for bounded bindings such
as standard raw-block IPFS. An oversize input fails with `REPOSITORY_CAPABILITY_EXCEEDED`.

The filesystem and OCI bindings expose the same property. Their v1 value may be `{}` when they
impose no smaller finite limit. The IPFS binding declares its tested raw-block ceiling.

## 8. Durable recovery journal

The root package defines an asynchronous compare-and-swap port:

```ts
export interface PublicationJournalStore {
  load(
    bundleKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry | null>;

  create(
    entry: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry>;

  compareAndSwap(
    expected: VersionedPublicationJournalEntry,
    next: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry>;
}
```

The journal entry records:

- schema version, bundle key, payload fingerprint, and destination;
- normalized record and artifact references;
- repository capability snapshot used for preflight;
- `storedArtifacts`;
- `storedRecords`;
- the frozen prepared partitions, including each partition's exact sink medium and profile;
- each partition's placement status and any opaque pending/placement sink state;
- completion status; and
- monotonically increasing revision.

The package ships:

- an in-memory implementation from `/testing`; and
- a durable filesystem binding from `@jinn-network/evidence-publication/fs`.

The root entrypoint cannot import or re-export filesystem implementation code.

The filesystem binding uses a private versioned layout, `0700` roots, `0600` files, symlink and
path-escape rejection, immutable revision files, same-directory temporary writes, flush,
no-overwrite atomic publication, and CAS conflict detection. It mirrors the existing static
hardening patterns of `@jinn-network/evidence-repository/fs`, but it does not reuse that repository
as an implicit journal.

### 8.1 Filesystem threat model

The v1 filesystem journal is trusted local application state. The configured root and its
unmanaged ancestors must be stable and not writable or replaceable by an untrusted peer. Unmanaged
ancestors need not be owned by the application and may contain stable platform-managed symlinks,
such as the macOS `/var` alias. The binding resolves the existing unmanaged ancestor prefix to a
stable physical path before it creates or opens the configured root. The configured root itself
and every component below it are managed journal state and cannot be symlinks.

Within that trust boundary, the binding must reject lexical path escapes, pre-existing symlinks at
every managed component, non-regular managed files, malformed or corrupt revisions, and stale or
conflicting writers. Where the platform exposes POSIX ownership, a configured root, managed
directory, or managed file owned by another user is rejected. New managed directories and files
use exact modes `0700` and `0600`; an existing current-user-owned managed component is normalized
to the corresponding exact private mode before use. Ancestors above the configured root are an
operator-controlled precondition rather than managed journal state, so the binding neither changes
their ownership or modes nor claims to defend against their hostile mutation.

The binding must use non-following leaf opens where Node exposes them and revalidate managed
components around pathname-based operations so detectable replacement or corruption fails closed.
The journal contract and filesystem tests cover these static and accidental conditions,
deterministically detected between-check replacement, concurrent journal writers, cancellation,
and crash recovery. A detection test does not imply that pathname-based operations can contain the
effect of a hostile replacement before the following validation.

Node 22 does not expose descriptor-relative child operations such as `openat` and `linkat`.
Therefore the portable v1 binding does not claim containment against an equally privileged local
actor that wins an active time-of-check/time-of-use race by replacing a validated ancestor or
managed directory between validation and a pathname-based filesystem operation. Native filesystem
extensions, platform restrictions, and protection from hostile same-user mutation are out of scope
for v1.

This boundary does not weaken Evidence object integrity. Evidence bytes remain content-addressed
and digest-checked, so modification is detectable. The journal is a durable recovery log, not a
cryptographic trust anchor: it prevents duplicate or reordered publication effects after ordinary
crashes and cancellation, but it is not tamper-proof against an operator or process that already
controls the journal files. Its process-crash durability assumes a local filesystem that honors
Node's successful file and directory `sync()` calls; it does not claim a portable hardware
power-loss guarantee beyond the operating system and storage device's contract.

## 9. Publication algorithm

For a new bundle:

1. normalize and digest-check records and artifacts;
2. compute the bundle key and payload fingerprint;
3. preflight all bytes against repository capabilities;
4. create the journal entry with no external effects;
5. store artifacts in digest order, verifying each receipt repeats the expected reference and
   exact size before checkpointing success;
6. store records in family/digest order with the same receipt verification; any mismatch fails
   with `EvidenceRepositoryError("REFERENCE_CONFLICT")`;
7. greedily prepare exact sink frames from the stored record references, destination, and injected
   sink configuration, then persist the complete frozen plan;
8. place partitions in ordinal order, checkpointing a state-less pending intent before the first
   call, reconciling that intent after any interruption, and checkpointing returned pending or
   confirmed state afterward; and
9. mark the bundle complete.

For an existing journal entry:

1. require the same payload fingerprint and destination;
2. recheck remaining bytes against the repository's current declared capabilities;
3. resume the first uncheckpointed repository write;
4. reuse the frozen prepared plan if present, after requiring every journaled partition's medium
   and profile to equal the injected sink's immutable medium and profile;
5. reconcile any pending placement before calling `place`; call `place` only after authoritative
   `not-found`;
6. continue from the first incomplete partition; and
7. return the same logical result once complete.

Artifacts are always written before records. Records are always written before announcements.
Content-addressed repository writes may safely remain after cancellation or failure. They are not
rolled back.

Every operation accepts `AbortSignal`. Cancellation is checked before and after each awaited
boundary except after a filesystem journal publication link succeeds: there it is latched while
the non-interruptible directory-sync, temporary-unlink, and second-sync section finishes, then
surfaced. Cancellation produces `OPERATION_ABORTED`, leaves the latest durable checkpoint intact,
and never converts an uncertain placement into a blind retry.

## 10. Errors

Stable publication error codes:

- `INVALID_INPUT`
- `CONTENT_DIGEST_MISMATCH`
- `REPOSITORY_CAPABILITY_EXCEEDED`
- `BUNDLE_CONFLICT`
- `JOURNAL_CONFLICT`
- `JOURNAL_CORRUPT`
- `FRAME_TOO_LARGE`
- `SINK_PROTOCOL_VIOLATION`
- `IDEMPOTENCY_CONFLICT`
- `PLACEMENT_REVERTED`
- `PLACEMENT_UNCERTAIN`
- `OPERATION_ABORTED`
- `IO_FAILURE`

`EvidenceRepositoryError` propagates without translation. Concrete sink errors may preserve their
cause but must map uncertainty, denial, and permanent rejection consistently in their own package.

A confirmed reverted chain transaction is a permanent placement failure, not a pending effect. A
submitted transaction whose outcome cannot be observed is pending and must be reconciled.

## 11. Testing

The root package exports `describeAnnouncementSinkContract(...)` and
`describePublicationJournalStoreContract(...)` from `/testing`.

Required sink contract scenarios:

- deterministic `prepare`;
- exact candidate member sequence and immutable configured medium/profile pair;
- exact frame size and digest;
- size/member-limit rejection;
- no effect during preparation;
- idempotent repeated placement;
- conflict on changed bytes for the same key;
- state-less intent reconciliation, pending-then-reconcile, and authoritative not-found;
- cancellation; and
- golden sink-to-source round-trip supplied by each concrete medium.

Required journal contract scenarios:

- absent load;
- create;
- monotonic CAS;
- stale-writer conflict;
- exact round-trip of prepared bytes and opaque pending/placement sink state;
- cancellation; and
- corruption reporting.

Publication integration tests cover:

- records and artifacts stored byte-for-byte;
- artifacts-before-records-before-announcements;
- repository capability preflight before effects;
- current-capability recheck before remaining writes on resume;
- repository receipt reference/size verification;
- duplicate normalization and conflict;
- exact sink-measured partition boundaries;
- otherwise-valid prepared results that omit, substitute, reorder, or duplicate a member, or
  change the sink medium or profile, fail with `SINK_PROTOCOL_VIOLATION` before checkpoint or
  placement;
- recovery rejects a journaled prepared medium or profile that differs from the injected sink
  before any sink effect, including a same-profile/different-medium sink and a
  same-medium/different-profile sink;
- crash/cancellation before and after every journal, repository, preparation, placement, and
  reconciliation transition;
- resume without repeated confirmed effects;
- concurrent publishers of the same and conflicting bundle;
- no Evidence Protocol conformance admission;
- packed root, `/testing`, and `/fs` imports; and
- source-boundary canaries proving the root does not import `/fs`, Discovery, concrete repository
  bindings, or applications.

## 12. Prior art composed

- OCI Distribution separates content upload from manifest/tag publication.
- Transactional outbox patterns durably record intent before an external effect.
- Kubernetes-style reconciliation observes uncertain state before retrying.
- RFC 9457 supports stable machine-readable error codes.
- Existing Jinn repository and recorder code proves exact-byte identity, idempotent writes, and
  crash recovery patterns.

The new part is their composition around Evidence Repository references and a medium-neutral
announcement port.

## 13. Settled decisions

- Publication handles records **and** artifacts.
- It verifies exact digests but does not enforce Evidence Protocol conformance.
- Repository artifacts are stored first, then records, then announcements.
- The pipeline owns deterministic partition choice; the sink owns and measures exact physical
  framing.
- Prepared plans are frozen in the recovery journal.
- The journal port is asynchronous and a durable filesystem binding ships in v1.
- External and durable operations use cooperative cancellation checks before and after awaited
  boundaries. After a filesystem journal publication link succeeds, cancellation is deferred until
  the specified non-interruptible directory-sync, temporary-unlink, and second-sync section
  completes.
- Announcement interoperability requires a normative medium profile and round-trip tests.
- Sink/source co-location is optional.
- Credentials and trust remain outside the package.
- No concrete announcement medium, plugin integration, search, corpus admission, or legacy
  migration is part of this design.
