<!-- SPDX-License-Identifier: MIT -->
# `@jinn-network/evidence-local-runtime`

An embeddable, single-process composition of Jinn's exact-byte Evidence
Repository, durable local announcement journal, generic Indexer, and SQLite
Evidence Catalog.

```text
Application-specific producer adapter
                  |
                  v
       Execution Recorder / Attestation Issuer
                  |
                  v
       Local Evidence Runtime
          |       |       |       |
          v       v       v       v
     filesystem  journal  SQLite  optional injected
     repository           catalog Record Discovery bridge
```

The runtime closes a deployment boundary. It does not add evidence semantics or
replace any producer or storage contract.

## Open a runtime

```ts
import { resolve } from "node:path";

import { createExecutionRecorder } from "@jinn-network/execution-recorder";
import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";

const runtime = await openLocalEvidenceRuntime({
  rootDir: resolve("evidence-state"),
});

// Existing producers receive the ordinary EvidenceRepository contract.
const recorder = createExecutionRecorder({
  repository: runtime.repository,
});

// Start and finalize the recording through the Recorder's public lifecycle.
// A successful finalization stores exact bytes and durably announces the record;
// Catalog projection continues independently.
const recording = await recorder.start(startInput);
const finalized = await recording.finalize(finalizeInput);

if (finalized.finalized) {
  const indexed = await runtime.awaitIndexed(
    finalized.receipt.record,
  );
  if (indexed.status === "indexed") {
    const projection = await runtime.catalog.getRecord(
      finalized.receipt.record,
    );
  }
}

await runtime.close();
```

`@jinn-network/execution-recorder` is an application dependency in this example,
not a runtime dependency.

## Persistence and indexing

`runtime.repository` is the existing `EvidenceRepository` interface. Artifact
writes delegate directly to the filesystem repository and are never announced.
A record write returns only after the exact record bytes and one replayable
local `available` announcement are durable. It does not wait for validation or
Catalog projection, and it says nothing about trust, admission, or publication.

Use:

- `awaitIndexed(reference)` for the terminal outcome of one announced record;
- `sync()` to capture one journal high-water mark and wait until it is processed;
- `getStatus()` for bounded lifecycle, queue, checkpoint, and recent-failure
  state; and
- `listIndexingFailures({ reference, category, limit, cursor })` for bounded,
  deterministic failure inspection.

Protocol rejection and immutable corruption become terminal outcomes for that
record without blocking later announcements. Retryable repository, Catalog, or
filesystem failures leave the checkpoint unchanged.

## Root ownership and recovery

One runtime handle owns one caller-selected root and one writable process owns
that root at a time. The root contains private runtime identity, repository,
journal, operational outbox, Catalog generations, and an operating-system-backed
lock. Runtime-managed directories and files use private POSIX modes and reject
unsafe traversal or symbolic links.

The outbox bridges repository persistence and journal publication. On restart,
unfinished writes recover from their staged exact bytes before indexing starts.
The journal and repository remain authoritative; the Catalog is a disposable
record-scoped projection.

When Catalog or projector versions change, the runtime builds a new generation
from retained journal events and repository bytes. Readers retain leases on the
old generation while in-flight calls finish, and `current.json` switches
atomically only after the replacement catches up. A failed rebuild leaves the
previous generation active.

Local discovery is automatic for records written through `runtime.repository`.

## Optional public Record Discovery bridge

The package can host the real filesystem journal as an explicitly configured Record Discovery
source. The adapter stays outside the ordinary local-runtime dependency closure: the application
installs `@jinn-network/record-discovery-source-evidence-journal` and injects its factory.

```ts
import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import {
  createEvidenceJournalDurableBridge,
} from "@jinn-network/record-discovery-source-evidence-journal";

const bridgeFactory = (context) => createEvidenceJournalDurableBridge({
  source: context.source,
  evidenceSourceId: context.evidenceSourceId,
  journal: context.journal,
  withdrawals: context.withdrawals,
  records: context.records,
  writer: context.writer,
  writerIntents: context.writerIntents,
  states: context.openBridgeStateStore(),
  strategies: context.strategies,
  now: context.now,
});

const runtime = await openLocalEvidenceRuntime({
  rootDir,
  publicDiscovery: {
    source,
    signer,
    blobs,
    withdrawals,
    bridgeFactory,
  },
});
```

The runtime persists the source writer state, append intent, bridge cursors, pending command, and
the exclusive strategy claim in its private `public-discovery/` directory. `open` and `sync()`
recover before consuming new input. Available announcements preserve the local `announcementId`,
original record digest, and exact bytes. The separately injected withdrawal source preserves its
announcement and retraction identities. A second publication strategy for the same public source
identity fails closed.

The host performs no network transport and has no ambient signer or clock. Public blobs, signing,
withdrawals, and time are explicit application ports. Omitting `publicDiscovery` retains the
local-only runtime and does not load the adapter.

## Boundary

This package does not provide a built-in application adapter, daemon, plugin,
marketplace integration, Autopilot integration, OCI or IPFS binding, network
service, corpus membership, ranking, trust or admission policy, scrubbing,
retention, deletion, or migration. Applications compose those concerns above
the Catalog and repository contracts. Its optional public host only supplies
durability and explicit ports for the separately installed evidence-journal
adapter and generic Record Discovery source writer.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
