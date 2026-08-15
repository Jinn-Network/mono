# Evidence Publication Implementation Plan

> **Implementation foundation:** Read
> `../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is the single
> source of truth for the base branch, repository capability prerequisite, package locations,
> shared-file ownership, and PR order.

**Design:** `../specs/2026-07-25-evidence-publication-design.md`

**Package:** `@jinn-network/evidence-publication@0.1.0`

**Final entrypoints:**

```text
@jinn-network/evidence-publication
@jinn-network/evidence-publication/testing
@jinn-network/evidence-publication/fs
```

**Stack position:** PRs 7 and 8 in the operational stack, after repository capabilities,
derivation, and IPFS

## Goal

Implement a producer- and medium-neutral publication pipeline that:

1. accepts exact record and artifact bytes;
2. verifies their declared SHA-256 identities;
3. preflights repository capacity;
4. stores artifacts, then records;
5. asks an injected sink to prepare exact announcement frames;
6. journals the frozen plan durably;
7. places and reconciles those frames idempotently; and
8. resumes safely after cancellation, crash, or uncertain external effects.

Do not implement a concrete announcement medium, Discovery source, credentials, signing,
derivation, corpus policy, or application integration.

Runtime dependencies are limited to `@jinn-network/evidence-repository` and Node 22 standard
library. Hash exact bytes with `node:crypto`. Do not depend on Evidence Protocol merely to obtain a
hash helper, and do not add Discovery or a concrete repository binding.

The filesystem journal's configured root and ancestors are trusted local application state. The
portable v1 binding must handle static and accidental symlinks, path escapes, corruption,
permission faults, concurrent journal writers, cancellation, and crashes. It does not claim
containment against an equally privileged hostile local process that replaces a validated path
component during a pathname-based Node filesystem operation. Do not add native extensions,
platform restrictions, or tests that imply that stronger guarantee.

## Package layout

```text
packages/evidence/publication/
├── package.json
├── yarn.lock
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── scripts/
│   └── pack-smoke.mjs
└── src/
    ├── index.ts
    ├── types.ts
    ├── validation.ts
    ├── identities.ts
    ├── errors.ts
    ├── partition.ts
    ├── journal.ts
    ├── publish.ts
    ├── reconcile.ts
    ├── testing.ts
    └── fs/
        ├── index.ts
        ├── paths.ts
        ├── store.ts
        └── validation.ts
```

Co-locate unit tests with their source files. Put black-box packed-consumer fixtures under
`test/fixtures/` only when the existing evidence packages use that convention.

The root source must not import `src/fs/**`. Export `/fs` directly from its own compiled entrypoint.

## Public contracts to freeze first

Use repository types rather than creating aliases:

```ts
export interface PublishRecord {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

export interface PublishArtifact {
  readonly reference: EvidenceArtifactReference;
  readonly bytes: Uint8Array;
}

export interface PublishInput {
  readonly records: readonly PublishRecord[];
  readonly artifacts?: readonly PublishArtifact[];
  readonly destination: DestinationScope;
  readonly signal?: AbortSignal;
}

export interface PreparedAnnouncement {
  readonly medium: string;
  readonly profile: string;
  readonly members: readonly AnnouncementMember[];
  readonly frameBytes: Uint8Array;
  readonly frameDigest: Sha256Digest;
  readonly frameSize: number;
}

export interface AnnouncementSink {
  readonly medium: string;
  readonly profile: string;
  readonly capabilities: AnnouncementSinkCapabilities;
  prepare(...): Promise<PreparedAnnouncement>;
  place(...): Promise<PlaceResult>;
  reconcile(...): Promise<ReconcileResult>;
}

export interface PublicationJournalStore {
  load(...): Promise<VersionedPublicationJournalEntry | null>;
  create(...): Promise<VersionedPublicationJournalEntry>;
  compareAndSwap(...): Promise<VersionedPublicationJournalEntry>;
}
```

Every operation takes `RepositoryOperationOptions` or an equivalent options object containing
`signal?: AbortSignal`.

Stable publication codes:

```text
INVALID_INPUT
CONTENT_DIGEST_MISMATCH
REPOSITORY_CAPABILITY_EXCEEDED
BUNDLE_CONFLICT
JOURNAL_CONFLICT
JOURNAL_CORRUPT
FRAME_TOO_LARGE
SINK_PROTOCOL_VIOLATION
IDEMPOTENCY_CONFLICT
PLACEMENT_REVERTED
PLACEMENT_UNCERTAIN
OPERATION_ABORTED
IO_FAILURE
```

Repository failures retain their original `EvidenceRepositoryError`.

## PR 7 — Contracts and durable journal

Branch from the exact IPFS-adapter PR head recorded by the coordinator. Keep the PR draft and base
it on that branch.

### Task 1: Scaffold and boundary tests

Files:

- create the package skeleton and root exports;
- update the three evidence architecture guards through the integration coordinator;
- update the Evidence CI DAG through the integration coordinator.

Test first:

- root and `/testing` import in a temporary TypeScript consumer;
- `/fs` import in a separate consumer;
- root export keys contain no filesystem constructor;
- root source cannot import filesystem, Discovery, concrete repositories, or applications;
- package has only declared `portal:` resolutions; and
- package is independently packable.

Use the same Node 22, ES2022, Yarn 4.13.0, Vitest, Apache-2.0, SPDX, and DCO conventions as the
neighboring evidence packages.

### Task 2: Exact input validation and identities

Implement and test:

- strict record/artifact reference parsing through repository helpers;
- strict absolute-IRI validation for `DestinationScope`;
- digest verification against exact supplied bytes;
- deterministic sorting;
- byte-identical duplicate collapse;
- conflict on same reference with different bytes;
- non-empty record requirement;
- defensive copying;
- bundle key;
- payload fingerprint covering ordered record references, ordered unique artifact references, and
  destination;
- prepared-frame digest validation; and
- exact prepared-member validation by canonical family/digest, length, and order;
- exact equality between a prepared medium/profile pair and the sink's immutable configured
  medium/profile pair; and
- placement idempotency-key derivation.

Do not use record body sizes for partitioning. Do not validate Evidence Protocol conformance.
Omitted, substituted, reordered, or duplicated members and a changed medium or profile are
`SINK_PROTOCOL_VIOLATION`, even when the returned frame bytes, digest, and size are otherwise
self-consistent.

### Task 3: Sink preparation and contract kit

Implement `describeAnnouncementSinkContract(factory)` under `/testing`.

The factory returns:

```ts
export interface AnnouncementSinkContractContext {
  readonly sink: AnnouncementSink;
  readonly effectCount: () => number;
  readonly authorityMarkers: readonly Uint8Array[];
  readonly prepareFrameAtSize?: (
    exactFrameBytes: number,
  ) => Promise<PreparedAnnouncement>;
  readonly cleanup?: () => Promise<void> | void;
}
```

The context contains at least two unique synthetic secrets of at least 32 bytes: one printable
UTF-8 marker and one binary non-UTF-8 marker. Both are closed over by the sink test fixture and are
never passed as preparation, placement, or reconciliation arguments. The kit derives each
marker's raw, lowercase-hex, base64, unpadded base64url, and percent/URL-encoded representations.

The contract suite proves:

- `prepare` performs no network, repository, durable filesystem, clock, randomness, or other
  ambient I/O;
- identical members/context produce identical frame bytes, digest, and size;
- returned members equal the requested candidate element-for-element by canonical family and
  digest, while defensively cloned member objects remain valid;
- `frameSize === frameBytes.byteLength`;
- returned digest matches exact frame bytes;
- medium, the sink's immutable profile, destination, and opaque-state format identifiers are
  absolute IRIs;
- every prepared result repeats the sink's exact configured medium and profile;
- member and byte limits are enforced;
- changed bytes under the same idempotency key conflict;
- repeated placement is idempotent;
- a state-less pre-placement intent can be reconciled after a lost response;
- `not-found` is returned only after authoritative absence;
- pending placement is reconciled before retry;
- no raw or derived authority-marker representation occurs in any inert own data field returned by
  `prepare`, `place`, or `reconcile`, including frame bytes, opaque state, placement/reverted
  `externalId`, and reverted `reason`;
- failure cases for `prepare`, `place`, and `reconcile` recursively scan the mapped or propagated
  error's message, inert own fields, and bounded cycle-safe `cause` chain for every raw or derived
  authority-marker representation;
- cancellation maps to `OPERATION_ABORTED`; and
- implementers can add their medium-specific sink-to-source golden round trip.

Run the kit against an in-memory sink whose physical frame is a small versioned canonical JSON
fixture. The in-memory harness closes over at least one non-UTF-8 synthetic authority marker and
one printable marker and produces scoped conformance evidence that neither leaks. That frame is a
test medium, not a public Jinn format. Every future concrete sink must configure its real
authority-bearing capability with equivalent synthetic markers and run this contract requirement.
Marker scans are evidence for the tested implementation, not a sandbox or proof against dishonest
sink code.

### Task 4: Async journal contract and codecs

Define versioned closed codecs for:

- destination;
- normalized record/artifact references;
- repository capability snapshot;
- stored-artifact and stored-record checkpoints;
- exact prepared partitions, including sink medium/profile and frame bytes;
- opaque pending and placement state with absolute versioned format IRIs;
- placement state;
- completion state; and
- revision.

Reject unknown journal schema versions, malformed base64/JSON, duplicate checkpoints, prepared
frame mismatch, non-monotonic revisions, and states that skip required predecessors.

Export `describePublicationJournalStoreContract(factory)` and run it against an in-memory CAS
implementation in `/testing`. The contract kit must create, load, and compare-and-swap entries
whose pending and confirmed placements carry nontrivial opaque state. It must prove that the exact
format IRI and arbitrary opaque bytes survive every clone and codec boundary without
reinterpretation. At least one fixture uses a non-JSON, non-UTF-8 byte sequence such as
`Uint8Array.of(0xff, 0xfe, 0x00, 0x80)` and compares it byte-for-byte after replay.
Reuse the same authority-marker fixture and scanner helper to encode and replay journal entries
containing prepared, pending, and confirmed outputs, then recursively scan the canonical journal
bytes and decoded entry for every raw and derived marker representation.

### Task 5: Filesystem journal binding

Implement:

```ts
createFilesystemPublicationJournalStore({
  rootDir: string,
}): Promise<FilesystemPublicationJournalStore>;
```

Use a versioned private layout:

```text
publication-journal.json
entries/sha256/<prefix>/<remaining-hex>/<zero-padded-revision>.json
```

Requirements:

- where POSIX modes are exposed, every new managed directory, including the configured root and
  nested revision hierarchy, has exact mode `0700`; every new managed file has exact mode `0600`;
- on POSIX platforms, reject a configured root, managed directory, or managed file whose `uid`
  differs from `process.getuid()`; do not inspect or change ownership or modes above the configured
  root;
- before use, normalize every current-user-owned existing managed directory to exact mode `0700`
  and every current-user-owned existing managed regular file to exact mode `0600`, whether its
  prior mode was broader or narrower;
- resolve a stable existing unmanaged ancestor prefix to its physical path before managing the
  configured root; accept a stable symlink in that unmanaged prefix, including macOS `/var`, but
  reject the configured root or any component below it when it is a symlink;
- reject lexical path escapes and pre-existing symlinks at every managed component;
- use `O_NOFOLLOW` for managed leaf opens where Node exposes it, reject non-regular files, and
  revalidate the configured path anchors and managed directories around pathname-based operations;
- document in `README.md` that unmanaged ancestors must be trusted and stable and that the root
  must not be concurrently mutated by an equally privileged hostile process;
- document that modes are defense in depth rather than encryption or secret scrubbing; backups,
  retention, and deletion are operator responsibilities; exact frames and opaque sink state must
  not contain credentials, private keys, bearer tokens, or other authority material; and concrete
  sinks persist only non-secret recovery identifiers;
- same-directory temporary file;
- flush file before publication and the containing directory afterward where supported;
- publish each immutable revision without overwrite, using a same-filesystem hard link or another
  primitive with equivalent create-if-absent semantics—never `rename` over an existing revision;
- `create` publishes revision zero;
- `compareAndSwap` publishes exactly `expected.revision + 1` only when the current highest
  contiguous revision still equals `expected`;
- two concurrent writers targeting the same next revision have one winner and one
  `JOURNAL_CONFLICT`;
- ignore only recognized temporary files;
- reject gaps, duplicate/noncanonical revision names, and invalid predecessor transitions;
- verify directory key, embedded key, revision, and full codec on replay;
- check cancellation before and after every awaited I/O boundary in `load`, `create`, and
  `compareAndSwap`, including immediately after closing a flushed temporary file and before its
  no-overwrite publication link;
- remove an unpublished temporary file when cancellation or another failure occurs;
- after the no-overwrite link succeeds, defer cancellation while the store synchronizes the
  revision directory, unlinks the temporary name, and synchronizes the directory again; surface a
  pending cancellation only after this non-interruptible durability section;
- if the first post-link sync fails, preserve the temp/final pair and return `IO_FAILURE`; if temp
  unlink fails after that sync, still attempt the final directory sync and preserve the unlink
  failure as the cause; never acknowledge the revision after any post-link durability error;
- during replay, accept and repair one recognized temporary name sharing the highest final
  revision's inode only when both names are current-user-owned regular files with `nlink === 2`;
  reject symlinked, non-regular, foreign-owned, or excess-link variants; and
- stable mapping to publication errors.

Write the failing coverage in `src/fs/store.test.ts` and `src/fs/store-faults.test.ts` before
changing `src/fs/store.ts`, `src/fs/paths.ts`, or `src/fs/validation.ts`. Run the journal contract
kit plus corruption, permission, static traversal/symlink, stale-writer, concurrent-writer, and
crash tests against temporary directories. POSIX-gated permission tests must prove exact
normalization from representative broader modes (`0755`, `0644`) and narrower modes (`0500`,
`0400`). Use focused filesystem test doubles to prove foreign ownership and injected `EACCES` or
`EPERM` failures are mapped correctly without requiring elevated privileges. A positive macOS test
must use a root beneath the stable `/var` alias; negative tests must retain configured-root and
managed-component symlink rejection.

Fault tests must interrupt after the publication link, after the first directory sync, after the
temporary unlink, and before the second directory sync. Reopen the journal after each simulated
process crash and prove the final revision is either absent or replayable, every recoverable
temp/final link pair is repaired, and an acknowledged revision is never lost. These are
process-crash and API-fault tests; they do not assert portable hardware power-loss behavior beyond
successful Node file and directory `sync()` calls.

Add one deterministic fault-injection test that replaces a managed component after one successful
anchor validation and proves that the following validation returns `JOURNAL_CORRUPT`. The test
proves detection only; it must not assert containment or absence of an outside effect during the
replacement window. In this task, a concurrent-writer race means two legitimate journal writers
competing for the same immutable revision. An active same-authority path-replacement race remains
outside the v1 threat model.

### Task 6: PR 7 distribution gate

The coordinator:

- adds `publication` as package 11 in inventory;
- adds root, `/testing`, and `/fs` source-boundary canaries;
- places the package in the parallel component tier of Evidence CI; and
- updates packed-types fixtures.

Package smoke test:

- install the tarball into a clean temporary project;
- install declared dependencies only;
- import all three entrypoints;
- compile representative public types;
- execute in-memory sink and filesystem journal smoke scenarios; and
- assert no tests or undeclared Jinn packages leak into `dist`.

Commit sequence:

```text
feat(evidence-publication): define publication contracts
feat(evidence-publication): add durable filesystem journal
test(evidence-publication): add sink and journal contract kits
```

All commits require DCO sign-off.

## PR 8 — Pipeline, recovery, and final distribution

Branch from PR 7's exact reviewed head.

### Task 7: Repository preflight and write checkpoints

Write failing tests for:

- every record and artifact digest checked before effects;
- repository preflight reads the canonical inert capability snapshot without interpreting unknown
  future fields;
- a declared `maxObjectBytes` violation before journal creation or remote writes;
- `undefined` capability treated as no declared finite limit;
- artifact writes sorted by digest;
- record writes sorted by family/digest;
- all artifacts stored before any record;
- all records stored before sink preparation or placement;
- existing repository objects accepted idempotently;
- a repository error propagated unchanged;
- verify every receipt repeats the expected reference and exact size, otherwise throw
  `EvidenceRepositoryError("REFERENCE_CONFLICT")`;
- checkpoint after every verified successful write; and
- resume from the first uncheckpointed object.

Then implement the smallest orchestration needed to pass them.

### Task 8: Exact-frame partition planning

Implement deterministic greedy partitioning over normalized record members:

1. append the next member to the current candidate;
2. call `sink.prepare(candidate, context)`;
3. validate the prepared result, including exact candidate-member sequence and the sink's
   immutable configured medium and profile;
4. retain it if it fits both declared sink capabilities;
5. otherwise freeze the previous candidate and begin a new one; and
6. fail if a single-member candidate cannot fit.

Tests must prove:

- boundaries use exact `frameBytes.byteLength`, not record sizes;
- preparation results are deterministic;
- candidate preparation has no placement effect;
- the complete prepared plan is checkpointed before first placement;
- resume reuses journaled frame bytes even if sink limits later change;
- empty partitions and duplicate members are impossible; and
- an invalid sink result fails with `SINK_PROTOCOL_VIOLATION`.

Negative cases must return otherwise self-consistent frames that omit, substitute, reorder, or
duplicate a candidate member, or change the configured medium or profile. Every case must fail
before a prepared-plan checkpoint or placement. A positive case must accept defensively cloned
member objects with the same canonical family/digest sequence.

### Task 9: Placement and reconciliation

Implement `publish(input, deps)` and `reconcile(bundleKey, deps, options)`.

For each frozen partition:

- reject a journaled prepared medium or profile that differs from the injected sink's immutable
  medium or profile before any sink effect;
- derive one stable placement idempotency key;
- checkpoint a state-less pending intent before the first `place`;
- after any interruption, call `reconcile(prepared, intent)` before another placement attempt;
- call `place` only for a new intent or after authoritative `not-found`;
- store confirmed/existing placement results;
- never blindly resubmit;
- treat confirmed reversion as permanent;
- mark completion only after every placement is confirmed; and
- return the same logical receipt on an identical repeated call.

Conflicting payload or destination for an existing bundle key fails without effects.

Crash/resume tests must also prove that a prepared plan frozen under one sink cannot be recovered
through a sink with the same profile but a different medium, or the same medium but a different
profile. Both mismatches fail before `place` or `reconcile`.

### Task 10: Crash and cancellation matrix

Add fault injection immediately before and after:

- journal create/CAS;
- each artifact put;
- each record put;
- plan preparation and plan checkpoint;
- pending-placement checkpoint;
- sink placement;
- confirmed-placement checkpoint;
- sink reconciliation; and
- completion checkpoint.

For each fault, create a fresh pipeline over the same durable journal and repositories and prove:

- no confirmed effect is duplicated;
- uncertain effects are reconciled;
- successful content-addressed writes are reused;
- exact prepared frames are reused;
- cancellation returns `OPERATION_ABORTED`;
- repository errors retain their type/code/cause;
- eventual receipt is stable;
- final receipts and persisted journal bytes contain no raw or derived authority-marker
  representation; and
- conflicting concurrent publishers fail safely.

### Task 11: Final verification and review

Run:

```text
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

inside the package, then all foundation gates and the full Evidence CI dependency order.

Obtain two fresh reviews:

1. architecture and contract review — especially no Discovery or concrete-binding dependency; and
2. durability/security review — especially CAS, uncertain placement, symlinks, cancellation, and
   frame reuse.

Commit sequence:

```text
feat(evidence-publication): store and plan exact publication bundles
feat(evidence-publication): reconcile durable announcement placement
test(evidence-publication): cover crash and cancellation recovery
ci(evidence-publication): integrate the evidence DAG
```

## Acceptance checklist

- [ ] Exact artifacts and records are both inputs.
- [ ] Duplicate declarations dedupe only when bytes match.
- [ ] Capacity preflight occurs before any effect.
- [ ] Artifacts precede records; records precede announcements.
- [ ] Sink preparation owns exact physical framing and is effect-free.
- [ ] The pipeline partitions using exact prepared frame size.
- [ ] The frozen prepared plan, including exact sink medium and profile, is durable and reused
      only with the same configured sink identity on recovery.
- [ ] The journal port is async and `/fs` is production-usable.
- [ ] Root does not expose or import `/fs`.
- [ ] Awaited boundaries use cooperative cancellation checks, with cancellation deferred only
      inside the specified post-link filesystem durability section.
- [ ] Uncertain placement reconciles before retry.
- [ ] Repository failures propagate unchanged.
- [ ] No Evidence Protocol admission, Discovery dependency, concrete medium, credentials, or
      application integration was added.
- [ ] Architecture guards, packed types, Evidence CI, and independent tarball installation pass.

## Follow-ups

- Select and specify a concrete public announcement medium.
- Implement that medium's sink and source against one normative profile.
- Integrate publication into the plugin/operator composition.
- Design public corpus admission and retention.

Those are separate items. They do not weaken this package's v1 recovery or contract requirements.
