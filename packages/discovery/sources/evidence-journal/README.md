# `@jinn-network/record-discovery-source-evidence-journal`

The deterministic **local-to-public adapter** that projects the permanent local evidence
journal/outbox into one Jinn Record Discovery Protocol v1 source chain (design §11:
`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`; plan Task 25:
`docs/superpowers/plans/2026-07-28-record-discovery.md`).

The in-flight evidence discovery contracts (`@jinn-network/evidence-discovery`,
`@jinn-network/evidence-repository`) are conforming under a defined, mechanical projection —
this package **is** that projection. It reads two frozen evidence surfaces:

- the append-only announcement journal's `AnnouncementJournalEntryV1` entries
  (`{version, revision, predecessorDigest?, announcement}`, available-only) for the **available**
  chain;
- the catalog's `EvidenceRecordAnnouncementSource.read({after})`, whose `AnnouncementBatch`
  carries the `available | withdrawn` union, for **withdrawals**
  (`RecordLocationWithdrawal {sourceId, announcementId, retractsAnnouncementId}`).

...and merges both into ONE re-sealed, DSSE-signable Announcement Entry chain of its own. It
never signs journal bytes as-is, never recanonicalizes evidence records, and makes **zero
changes** to the frozen evidence contracts. Record Discovery is the public plane; evidence
discovery remains the private local catalog and publication outbox.

## The pinned §11 field-map

| Evidence layer (frozen) | Record Discovery Protocol |
| --- | --- |
| `reference{family, digest}` | `record{kind: familyToKind(family), digest}` (`src/project.ts`) |
| `publishedLocation{bindingProfile, locator}` | one-item `locations[]`; `locator`'s arbitrary JSON object is encoded as canonical (RFC 8785 JCS) text, since discovery's `PublishedLocation.locator` is a string |
| `repositoryId` / withdrawal `sourceId` | dropped — stays local, never published |
| journal `revision` | fixed-width `sequence`, gap-free single counter per source (`src/reconcile.ts`) |
| journal `predecessorDigest` | **not** reused — `previous` chains over the RE-SEALED projected entries |
| evidence withdrawal | `action: "withdrawn"`, `reason: "delisted"` always (the evidence layer has no substrate; it never emits `reorged`) |

`src/project.ts` holds the pure, I/O-free field-map functions. The compatibility
`src/reconcile.ts` and `src/publish.ts` APIs remain for existing callers. New runtime hosts use
`createEvidenceJournalDurableBridge`, which persists the available cursor, withdrawal cursor,
the exact pending projected command, and its timestamp. Source sequence, previous-entry linkage,
signed bytes, pages, heads, and append recovery remain exclusively owned by
`@jinn-network/record-discovery-serve`'s `DurableSourceWriter`.

The bridge reads one fixed publication strategy per public source identity before it touches
writer state. Before creating a new claim, a read-only preflight rejects any pre-existing writer
state or append intent; the rejected attempt creates no ownership record, so retries remain
fail-closed before writer recovery can mutate source blobs or state. An already-owned
strategy retains normal append-intent recovery. Another strategy for the same identity fails
closed. After a crash it replays the
persisted command with the same `announcementId`, original record digest, exact record bytes, and
timestamp; the writer's publication-key idempotency prevents a duplicate source entry. Available
announcements are read from the filesystem journal. Withdrawals are a separately injected local
source and are projected as `reason: "delisted"` without deleting original bytes or history.

## Frozen-contract boundary

The adapter owns no filesystem, signer, blob store, repository, transport, or clock. The optional
host in `@jinn-network/evidence-local-runtime` supplies its real
`FilesystemEvidenceAnnouncementJournal`, exact-byte repository, durable JSON state stores,
source writer, signer, blob store, withdrawal source, and clock through a structurally injected
factory. This package is intentionally not a normal dependency of evidence-local-runtime, so
ordinary native-role dependency closure does not load the optional bridge.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` (Task 25) for the implementation
plan.
