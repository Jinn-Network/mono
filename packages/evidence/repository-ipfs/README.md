# `@jinn-network/evidence-repository-ipfs`

Bounded raw-block IPFS binding for the Jinn Evidence Repository contract.

The package maps each exact repository object digest to a CIDv1 `raw`
SHA2-256 CID and defines a deterministic second block that registers its
record family or artifact namespace. It never uses UnixFS, chunking, mutable
indexes, credentials, announcements, or public-gateway fallbacks.

```ts
import {
  buildArtifactRegistrationBytes,
  registrationCidForReference,
} from "@jinn-network/evidence-repository-ipfs";
import { digestToRawCid } from "@jinn-network/evidence-repository-ipfs/cid";

const contentCid = digestToRawCid(reference.digest);
const registrationBytes = buildArtifactRegistrationBytes(reference);
const registrationCid = registrationCidForReference(reference);
```

The repository adapter accepts an application-constructed Kubo client:

```ts
import { create as createKuboRPCClient } from "kubo-rpc-client";
import {
  IpfsEvidenceRepository,
  createKuboBlockReader,
} from "@jinn-network/evidence-repository-ipfs";

const endpoint = "http://127.0.0.1:5001";
const repository = new IpfsEvidenceRepository({
  client: createKuboRPCClient({
    url: new URL("/api/v0", endpoint),
  }),
  reader: createKuboBlockReader({ endpoint }),
});
```

Applications construct the Kubo client or injected `fetch` capability and
therefore retain all endpoint authentication authority. This package has no
token, password, authorization-header, key, or pin-service credential option.
Failures from those injected capabilities are mapped to stable Repository
error codes. Raw dependency exceptions are never exposed as public causes;
dependency diagnostics use only a frozen package-owned cause containing the
stable operation class and failure kind.

## Profile

Every content and registration block is:

- CIDv1;
- `raw` codec;
- SHA2-256;
- at most 2 MiB, inclusive; and
- written with `allowBigBlock: false`.

Writes require Kubo v0.40.0 or newer. This version is verified against Kubo
v0.40.0 and v0.42.0. The older v0.32.1 fixture is reader/error-envelope
compatibility only.

A successful write verifies the CIDs returned by Kubo, confirms an explicit
direct or recursive local root pin, completes any configured remote pin,
and reads the exact registration and content bytes back through the
configured reader. An indirect-only pin is not explicit custody and is
repaired. The binding never unpins.

The normative registration profile, closed schema, and golden fixtures ship
under `profile/v1/`.

## Readers

`createKuboBlockReader` streams `POST /api/v0/block/get`; the gateway reader
streams `GET /ipfs/<cid>?format=raw`. Both enforce the fixed 2 MiB
accumulation ceiling, cancel on overrun, and verify every returned block
against its CID. Kubo absence is recognized only through bounded, exact
fixtures captured from the three pinned releases.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn check:profile
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

`yarn test:kubo` runs reader compatibility on v0.32.1 and the full writer
matrix on v0.40.0 and v0.42.0 using immutable official container image
digests. It requires a responsive Docker engine.
