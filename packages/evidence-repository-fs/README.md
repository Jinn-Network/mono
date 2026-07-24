# `@jinn-network/evidence-repository-fs`

Secure native filesystem implementation of the Jinn Evidence Repository
contract.

```ts
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository-fs";

const repository = await createFilesystemEvidenceRepository({
  rootDir: "/private/path/to/evidence",
});
```

The repository is a rebuildable content-addressed store:

```text
repository.json
objects/sha256/<prefix>/<remaining-hex>
records/<family>/sha256/<prefix>/<remaining-hex>.json
```

Objects contain the exact supplied bytes. A record marker registers a content
digest under one record family; it does not duplicate or reinterpret the
object. Identical object bytes are deduplicated across records and artifacts.

Writes use flushed same-directory temporary files and atomic no-clobber
publication. Reads reject symlinks and non-regular managed paths and verify the
SHA-256 digest before returning bytes. New roots and managed directories use
mode `0700`; new files use `0600` on platforms with POSIX permissions.

This binding adds no list, query, delete, retention, encryption, validation, or
policy API. Evidence Protocol conformance remains a consumer concern.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
