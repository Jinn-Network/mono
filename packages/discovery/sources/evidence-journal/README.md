# `@jinn-network/record-discovery-source-evidence-journal`

The deterministic **published-source wrapper** that re-seals the frozen evidence journal and
catalog into one Jinn Record Discovery Protocol v1 chain (design §11:
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

...and merges both into ONE re-sealed, DSSE-signable Announcement Entry chain of its own —
it never signs journal bytes as-is, and it makes **zero changes** to the frozen evidence
contracts.

## The pinned §11 field-map

| Evidence layer (frozen) | Record Discovery Protocol |
| --- | --- |
| `reference{family, digest}` | `record{kind: familyToKind(family), digest}` (`src/project.ts`) |
| `publishedLocation{bindingProfile, locator}` | one-item `locations[]`; `locator`'s arbitrary JSON object is encoded as canonical (RFC 8785 JCS) text, since discovery's `PublishedLocation.locator` is a string |
| `repositoryId` / withdrawal `sourceId` | dropped — stays local, never published |
| journal `revision` | fixed-width `sequence`, gap-free single counter per source (`src/reconcile.ts`) |
| journal `predecessorDigest` | **not** reused — `previous` chains over the RE-SEALED projected entries |
| evidence withdrawal | `action: "withdrawn"`, `reason: "delisted"` always (the evidence layer has no substrate; it never emits `reorged`) |

`src/project.ts` holds the pure, I/O-free field-map functions. `src/reconcile.ts` sequences and
chains them into a merged `AnnouncementEntry[]` (see its top comment for the sequence-assignment
implementer finding: a single monotonic counter, not a literal `revision - offset` formula
re-applied forever, because that formula cannot survive withdrawal interleaving in one shared
gap-free sequence space — see plan Task 25 / design §11). `src/publish.ts` signs and writes the
result through `@jinn-network/record-discovery-serve`'s toolkit (archive pages + head
maintenance), never signing journal bytes as-is. The wrapper emits no facts card in v1 (design
§11; enriching output with `facts/evidence` cards is a named follow-up).

## Frozen-contract boundary

Zero edits to `packages/evidence/discovery` or `packages/evidence/repository`. `AnnouncementJournalEntryV1`
is internal to evidence-discovery's journal module (not re-exported through its package `exports`
map), so `src/ports.ts` declares its own structurally-identical `EvidenceJournalEntry` port shape
instead of importing it — the same precedent `record-discovery-serve`'s `head.ts` uses for
`DsseEnvelope` relative to `trust-core`. Translating a real
`FilesystemEvidenceAnnouncementJournal`'s `.read()` output into that port shape (recovering each
entry's `revision`) is host assembly, out of this package's scope.

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
