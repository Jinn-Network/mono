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

Every repository is a non-Proxy object that exposes `capabilities` through a
stable own data slot. The slot may use the writable and configurable descriptor
of an ordinary class field, but its value remains stable. The capability
snapshot is non-Proxy, non-extensible, has `Object.prototype` or `null` as its
prototype, and contains only non-writable, non-configurable own data fields.
Accessors and inherited `maxObjectBytes` values are rejected without evaluation.

The optional own `maxObjectBytes` field is a positive safe integer when a
binding declares a finite per-object limit. A present `undefined` value is
invalid. Only an absent field means that the binding declares no finite
application-level limit; it does not guarantee infinite storage. Unknown own
fields are semantically ignored but follow the same representation rules. The
in-memory, filesystem, and OCI bindings use the shared frozen, null-prototype
`NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES` object.

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
failures, dependency failures, size-limit violations, cancellation, and I/O failures throw
`EvidenceRepositoryError` with a stable error code.

## Implementation contract

Repository implementations should run the reusable Vitest suite:

```ts
import {
  describeEvidenceRepositoryContract,
} from "@jinn-network/evidence-repository/testing";

const DECLARED_MAX_OBJECT_BYTES = 2 * 1024 * 1024;

describeEvidenceRepositoryContract(async () => ({
  repository: await createRepository({
    maxObjectBytes: DECLARED_MAX_OBJECT_BYTES,
  }),
  createObjectAtDeclaredLimit: () =>
    new Uint8Array(DECLARED_MAX_OBJECT_BYTES),
  createObjectAboveDeclaredLimit: () =>
    new Uint8Array(DECLARED_MAX_OBJECT_BYTES + 1),
  cleanup: async () => closeRepository(),
}));
```

Bounded bindings must provide both boundary factories. They return fixtures
whose byte lengths are exactly the declared inclusive limit and that limit plus
one. Requiring explicit fixtures prevents the generic kit from allocating an
arbitrary capability value. Bindings without a declared finite limit omit both.
The kit validates repository and capability representation before invoking
repository behavior and revalidates the original capability slot after every
behavior test.

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
