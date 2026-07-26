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

## Profile

Every content and registration block is:

- CIDv1;
- `raw` codec;
- SHA2-256;
- at most 2 MiB, inclusive; and
- written with `allowBigBlock: false`.

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
