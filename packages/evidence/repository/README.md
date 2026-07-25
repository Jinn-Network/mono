# `@jinn-network/evidence-repository`

Exact-byte persistence contracts for Jinn execution evidence.

The repository layer sits above
`@jinn-network/evidence-protocol`. It computes record and artifact identities from
the exact bytes supplied, makes writes idempotent, verifies content integrity on
retrieval, and distinguishes missing content from exceptional failures.

It deliberately does not:

- validate Evidence Protocol conformance;
- interpret relationships between records and artifacts;
- list, search, rank, retain, or delete content;
- discover evaluations or verifications;
- enforce identity, trust, marketplace, or access policy.

Consumers validate retrieved record bytes with the Evidence Protocol package.
Repository implementations may use local files, OCI registries, or another
transport without changing the consumer-facing contract.

## Filesystem binding

The native filesystem binding is deliberately opt-in through the `/fs` subpath;
the package root remains contracts only.

```ts
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository/fs";

const repository = await createFilesystemEvidenceRepository({
  rootDir: "/private/path/to/evidence",
});
```

It stores exact bytes in a rebuildable content-addressed layout:

```text
repository.json
objects/sha256/<prefix>/<remaining-hex>
records/<family>/sha256/<prefix>/<remaining-hex>.json
```

Objects contain the supplied bytes. A record marker registers an object digest
under one record family without duplicating or interpreting it. Writes use
flushed same-directory temporary files and atomic no-clobber publication;
reads reject symlinks and non-regular managed paths and re-check SHA-256 before
returning bytes. New roots and managed directories use mode `0700`; new files
use `0600` on platforms with POSIX permissions.

This binding adds no list, query, deletion, retention, encryption, validation,
or policy API. Evidence Protocol conformance remains a consumer concern.

## Use

```ts
import type {
  EvidenceRepository,
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import {
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";

async function readExecution(
  repository: EvidenceRepository,
  reference: EvidenceRecordReference,
) {
  const bytes = await repository.getRecord(reference);
  return bytes === null ? null : validateExecutionEvidence(bytes);
}
```

Missing content returns `null`. Malformed references, corruption, access
failures, dependency failures, cancellation, and I/O failures throw
`EvidenceRepositoryError` with a stable error code.

## Implementation contract

Repository implementations should run the reusable Vitest suite:

```ts
import {
  describeEvidenceRepositoryContract,
} from "@jinn-network/evidence-repository/testing";

describeEvidenceRepositoryContract(async () => ({
  repository: await createRepository(),
  cleanup: async () => closeRepository(),
}));
```

See [`specification.md`](./specification.md) for the complete v1 boundary.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
