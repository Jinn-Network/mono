<!-- SPDX-License-Identifier: MIT -->
# `@jinn-network/evidence-announcement-journal`

A durable, replayable local `available` announcement source for Jinn evidence
records.

## Private local format

This package is a filesystem binding for one local runtime. Its marker, event
files, hash chain, and cursors are private implementation data, not portable
evidence or an interoperability protocol. Exact record bytes remain owned by an
`EvidenceRepository`; the journal stores only serializable record references and
deployment-local repository handles.

```ts
import {
  openFilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-announcement-journal";

const journal = await openFilesystemEvidenceAnnouncementJournal({
  rootDir,
  sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
});

const receipt = await journal.appendAvailable({
  announcementId: "urn:jinn:local-announcement:sha256:...",
  reference,
  repositoryId: "local:11111111-1111-4111-8111-111111111111",
});

for await (const batch of journal.read({ after: checkpoint })) {
  // Each finite snapshot batch contains exactly one durable announcement.
  await indexBatch(batch);
}
```

An append returns only after the immutable revision file and events directory
have been synchronized. Equal announcement replay is idempotent; incompatible
reuse conflicts. A cursor commits to the stable source identity, revision, and
exact event digest.

Opening validates the complete contiguous predecessor chain. Incomplete
temporary files are ignored. A crash after hard-link publication but before
temporary-link removal is recovered only when the final revision has exactly
one matching journal-owned temporary link. Gaps, changed predecessors, reused
identities, unsafe links, and incompatible markers fail closed.

The journal corrects managed POSIX modes to `0700` for directories and `0600`
for files. Runtime-controlled paths reject symlinks and ownership changes.

## Scope

Version 1 appends only local `available` events. It does not retrieve or validate
records, write Catalog projections or checkpoints, withdraw evidence, delete or
retain data, publish portable locations, access a network, or implement trust,
ranking, corpus, plugin, marketplace, OCI, IPFS, or blockchain behavior.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
