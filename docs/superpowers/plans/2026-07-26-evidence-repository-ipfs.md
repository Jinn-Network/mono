# IPFS Evidence Repository Binding Implementation Plan

> **Implementation foundation:** Read
> `../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is the single
> source of truth for the base branch, repository capability prerequisite, package locations,
> shared-file ownership, and PR order.

**Design:** `../specs/2026-07-26-evidence-repository-ipfs-design.md`

**Package:** `@jinn-network/evidence-repository-ipfs@0.1.0`

**Entrypoints:**

```text
@jinn-network/evidence-repository-ipfs
@jinn-network/evidence-repository-ipfs/cid
```

**Stack position:** PRs 5 and 6, after the repository-capabilities PR

## Goal

Implement a bounded `EvidenceRepository` binding over CIDv1 raw SHA2-256 blocks:

- exact record/artifact bytes map reversibly from protocol SHA-256 digest to one raw content CID;
- deterministic registration blocks preserve record-family and artifact namespaces;
- Kubo RPC writes pin and verify both blocks;
- Kubo or a raw-block gateway may read;
- successful writes perform configured pin confirmation and exact readback; and
- `capabilities.maxObjectBytes` declares the standard 2 MiB raw-block ceiling.

Do not add UnixFS, DAG chunking, mutable lookup indexes, announcements, credentials, application
wiring, retention, unpinning, or legacy cutover.

## Preconditions

The repository-capabilities PR has already added:

```ts
EvidenceRepository.capabilities
EvidenceRepositoryCapabilities
EvidenceRepositoryErrorCode = ... | "CONTENT_TOO_LARGE"
```

Its updated contract kit passes against memory, filesystem, and OCI repositories. The IPFS plan
does not reopen that contract.

The binding exposes its finite limit through the prerequisite's canonical inert capability
snapshot: an own class-field slot containing a frozen own data property on a plain object. The
repository is non-proxy and does not compute the limit through an accessor, inherited value, or
proxy behavior.

Verify current dependency versions from their official package/release sources during
implementation, then pin exact versions in the package lockfile. The locked architecture is:

```text
@jinn-network/evidence-repository-ipfs
├── @jinn-network/evidence-repository
└── kubo-rpc-client
```

Do not add `multiformats` independently if the pinned Kubo client already supplies the CID
implementation used by its public API. Do not add Helia, an HTTP client, or a canonical-JSON
runtime.

Pin the real-Kubo lanes exactly:

- v0.40.0 is the minimum supported writer and compatibility floor;
- v0.42.0 is the implementation-time current stable writer on 2026-07-26; and
- v0.32.1 is a reader/error-envelope compatibility fixture only.

The full unmodified Repository contract kit runs against v0.40.0 and v0.42.0. The v0.32.1 lane
captures the strict bounded not-found envelope and may verify raw reads within its older block
limit, but it never runs writer conformance or claims that the fixed 2 MiB capability is supported
there. Do not enable `allow-big-block`, lower the package capability, or add version-dependent
capability negotiation. The observed Autonolas v0.32.1 node requires an out-of-scope
operator-managed upgrade before this writer can target it.

## Package layout

```text
packages/evidence/repository-ipfs/
├── package.json
├── yarn.lock
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── profile/
│   └── v1/
│       ├── specification.md
│       ├── registration.schema.json
│       └── fixtures/
│           ├── artifact-registration.json
│           ├── execution-evidence-registration.json
│           ├── execution-verification-registration.json
│           └── result-evaluation-registration.json
├── scripts/
│   ├── check-profile.mjs
│   └── pack-smoke.mjs
├── src/
│   ├── index.ts
│   ├── cid.ts
│   ├── registration.ts
│   ├── readers.ts
│   ├── repository.ts
│   └── errors.ts
└── test/
    ├── fake-kubo.ts
    ├── contract.integration.test.ts
    └── kubo.integration.test.ts
```

Tests may be co-located when that matches the neighboring evidence package convention.

## Locked constants and public surface

```ts
export const MAX_STANDARD_IPFS_BLOCK_BYTES = 2 * 1024 * 1024;

export interface IpfsBlockReader {
  getBlock(
    cid: string,
    options: RepositoryOperationOptions & { readonly maxBytes: number },
  ): Promise<Uint8Array | null>;
}

export interface KuboBlockReaderOptions {
  /** Kubo RPC base URL without userinfo, query, or fragment. */
  readonly endpoint: string | URL;
  /** May be closed over application-owned authority. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createKuboBlockReader(
  options: KuboBlockReaderOptions,
): IpfsBlockReader;

export interface IpfsEvidenceRepositoryOptions {
  readonly client: KuboRPCClient;
  readonly reader: IpfsBlockReader;
  readonly remotePinService?: string;
  readonly readbackTimeoutMs?: number;
}

export interface IpfsRepositoryWriteReceipt<TReference>
  extends RepositoryWriteReceipt<TReference> {
  readonly contentCid: string;
  readonly registrationCid: string;
}
```

The package may accept an injected `fetch` capability for a Kubo or gateway reader. It must not accept
tokens, usernames, passwords, authorization headers, private keys, or pin-service credentials.
The pinned `kubo-rpc-client` is the writer/pin client; its eager `block.get` is not a read primitive
for this package.

## PR 5 — Profile and pure mapping

Branch from the exact derivation-distribution PR head recorded by the coordinator.

### Task 1: Scaffold and boundary canaries

Create the package skeleton using the neighboring evidence package conventions: Node 22, ES2022,
Yarn 4.13.0, Vitest, Apache-2.0, SPDX headers, DCO commits, package-local lockfile, build, typecheck,
test, and pack-smoke scripts.

Test first:

- root and `/cid` packed imports;
- only the Repository package appears as a Jinn dependency;
- no Protocol, Publication, Discovery, binding, application, or legacy imports;
- exact `portal:` resolution;
- `capabilities.maxObjectBytes === MAX_STANDARD_IPFS_BLOCK_BYTES`; and
- no tests leak into `dist`.

The integration coordinator alone updates inventory, source-boundary, packed-types, and Evidence CI
files.

### Task 2: Strict digest/CID conversion

Port the dependency-free algorithm from the legacy CID helper, but do not port its incorrect
256 KiB limit or comment.

Implement:

```ts
parseIpfsCid(value: string): ParsedIpfsCid | null;
digestToRawCid(digest: Sha256Digest): string;
rawCidToDigest(cid: string): Sha256Digest;
normalizeRawCid(cid: string): string;
```

`parseIpfsCid` is the general strict parser. It accepts canonical CIDv0 DAG-PB SHA2-256 and
canonical lowercase base32/base16 CIDv1 raw or DAG-PB SHA2-256 values. It rejects uppercase,
non-minimal, trailing-byte, and noncanonical textual aliases. It returns defensive digest bytes.

The three raw-profile helpers and every repository operation accept only CIDv1 raw SHA2-256.

Normative mapping:

```text
CIDv1
raw multicodec (0x55)
sha2-256 multihash (0x12)
32-byte digest
canonical emitted text: lowercase base16
accepted alternate text: canonical base32, normalized to base16
```

At the raw-profile helper and repository boundaries, reject:

- CIDv0;
- DAG-PB or any non-raw codec;
- non-SHA2-256 multihash;
- wrong digest length;
- non-minimal varints;
- uppercase/noncanonical base16;
- noncanonical base32;
- base58 aliases;
- trailing bytes; and
- malformed repository digests.

Golden vectors prove the total round trip:

```text
sha256 digest -> canonical raw CID -> same sha256 digest
```

Separate parser tests prove that canonical CIDv0 and CIDv1 DAG-PB values are accepted by
`parseIpfsCid` but rejected by every raw-profile helper.

### Task 3: Registration profile and drift check

Freeze one versioned profile for exact canonical registration bytes:

```json
{"digest":"sha256:<hex>","family":"execution-evidence","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

```json
{"digest":"sha256:<hex>","kind":"artifact","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

Serialization requirements:

- fixed key order as shown;
- UTF-8;
- no insignificant whitespace;
- one LF terminator;
- lowercase canonical digest;
- valid repository family; and
- closed field set for v1.

Implement deterministic registration bytes, reference-to-registration CID, and strict parser.

Tests prove:

- all three record families are isolated;
- record and artifact namespaces are isolated even for the same content digest;
- identical references produce identical bytes and CIDs;
- malformed/unknown version/extra fields fail;
- fixtures match expected CIDs; and
- `check:profile` is non-mutating and fails on schema, bytes, or CID drift.

### Task 4: Bounded readers

Implement:

- a Kubo reader using streamed `POST /api/v0/block/get?arg=<canonical-cid>` over built-in or
  injected `fetch`;
- raw gateway reader over injected/base `fetch`;
- streamed delivered-byte counting that never accumulates beyond the supplied maximum;
- early `Content-Length` rejection when present, while treating actual streamed bytes as
  authoritative;
- immediate response-body cancellation when the next chunk would exceed the maximum;
- strict CID normalization before request construction;
- gateway authoritative 404 → `null`;
- Kubo HTTP 500 → `null` only through an exact pinned-version not-found recognizer;
- 401/403 → `ACCESS_DENIED`;
- timeout, 429, connection, or every other 5xx → `DEPENDENCY_UNAVAILABLE`;
- abort → `OPERATION_ABORTED`; and
- present bytes whose digest does not match expected CID → `CONTENT_CORRUPT`.

Never use a trustless gateway response without local digest verification.
Reject Kubo endpoints containing userinfo, query, or fragment. Authentication, when needed, is an
injected fetch capability already closed over application authority; the package accepts no
credential-valued option.

Tests use controlled chunk streams to prove exactly `maxBytes` is accepted, `maxBytes + 1` is
rejected with `CONTENT_TOO_LARGE`, a missing or false `Content-Length` cannot bypass counting, an
oversized first chunk is not retained, and caller abort cancels the response body. Fetch
implementations may have internal transport buffers; the guarantee is bounded package
accumulation plus prompt cancellation.

Kubo error handling has a separate package-internal
`MAX_KUBO_ERROR_BODY_BYTES = 64 * 1024` limit. Read it with the same streamed byte counter and
cancellation behavior, then fatal-decode UTF-8 and strictly parse the closed Kubo command-error
envelope (`Message`, `Code`, `Type`). Freeze the exact field optionality, types, and anchored
not-found rules as fixtures captured from every pinned Kubo release. A recognized message must
identify the requested canonical CID. Duplicate/extra keys, malformed JSON, oversized bodies,
wrong-CID or unknown messages, and unrecognized version drift are `DEPENDENCY_UNAVAILABLE`, never
`null`; do not use substring-only matching.

Controlled tests cover a valid not-found fixture for each pinned version and oversized, malformed,
duplicate-key, extra-key, wrong-CID, and unknown HTTP-500 bodies. The real-Kubo suite regenerates
the observed response and fails on drift.

### Task 5: PR 5 verification

Run unit/profile/packed tests and foundation guards. Add the package to the parallel component tier
of Evidence CI, but do not run Docker/Kubo until PR 6.

Commit sequence:

```text
feat(evidence-repository-ipfs): define raw CID mapping
feat(evidence-repository-ipfs): add registration profile
feat(evidence-repository-ipfs): add bounded block readers
```

## PR 6 — Kubo repository adapter and distribution

Branch from PR 5's exact reviewed head.

### Task 6: Read semantics

For `getRecord(reference)`:

1. derive the record registration CID;
2. fetch and strictly parse the registration;
3. absent registration returns `null`;
4. require exact family/reference equality;
5. fetch the derived content CID;
6. absent content behind a present registration is `CONTENT_CORRUPT`;
7. enforce size ceiling;
8. verify SHA-256; and
9. return a defensive copy.

`getArtifact` follows the same steps with the artifact registration namespace.

Never infer record-family membership from a present content block alone.

### Task 7: Put semantics

Before any RPC:

- abort check;
- compute exact repository reference;
- reject bytes over 2 MiB with `CONTENT_TOO_LARGE`;
- derive exact content CID;
- derive exact registration bytes and CID; and
- inspect whether the complete registered object already exists and is valid.

For a new or repair write:

1. `block/put` exact content as raw SHA2-256 CIDv1;
2. require returned CID to equal expected;
3. confirm an explicit local `direct` or `recursive` pin, rejecting `indirect`-only state;
4. `block/put` exact registration bytes;
5. require returned registration CID to equal expected;
6. confirm an explicit local `direct` or `recursive` pin, rejecting `indirect`-only state;
7. when `remotePinService` is configured, request/confirm both remote pins;
8. read back registration and content through the configured reader before the deadline;
9. verify exact bytes; and
10. return the base receipt plus canonical CIDs.

`existing` means both registered-object blocks and configured custody already satisfy the contract.
A repaired missing pin/registration returns `created`. Concurrent identical writes may both return
`created` but must converge on the same two CIDs with no conflict.

Do not unpin partial successes. A retry completes the deterministic object.
Supported Kubo writers classify `block/put(pin=true)` as `recursive`; because these are raw blocks
with no descendants, `direct` and `recursive` are equivalent explicit custody for this profile.
Do not issue a second pin mutation merely to change the classification.

### Task 8: Error and cancellation matrix

Test:

- wrong CID from Kubo → `REFERENCE_CONFLICT`;
- corrupt registration/content → `CONTENT_CORRUPT`;
- absent authoritative registration → `null`;
- absent content behind registration → `CONTENT_CORRUPT`;
- explicit denial/quota rejection → `ACCESS_DENIED`;
- unavailable/readback timeout → `DEPENDENCY_UNAVAILABLE`;
- oversize direct put → `CONTENT_TOO_LARGE`;
- a streamed response of 2 MiB plus one byte is canceled with `CONTENT_TOO_LARGE` without
  retaining the complete body;
- cancellation before/after every RPC and read boundary → `OPERATION_ABORTED`;
- configured remote pin failure makes put fail;
- retry repairs partial content-only state; and
- raw injected client/fetch failures are never exposed as the public cause;
- dependency failures use only the package-owned closed sanitized cause containing a stable
  operation class and failure kind; and
- printable and binary synthetic authority markers placed in injected error messages, own fields,
  and nested cyclic causes do not occur in the mapped public error or its recursively scanned
  message, inert own fields, and bounded cycle-safe cause graph, in raw, lowercase-hex, base64,
  unpadded base64url, or percent/URL-encoded form.

Pin-class tests use deterministic client doubles to prove that:

- an explicit `direct` pin is accepted;
- an explicit `recursive` pin is accepted;
- `indirect`-only state is rejected and repaired before success; and
- an already accepted explicit pin causes no redundant pin mutation.

### Task 9: Shared contract kit against real Kubo

Run the updated, unmodified Repository contract kit for:

- all three record families;
- artifacts;
- missing reads;
- sequential and concurrent idempotency;
- exact-byte round trips;
- declared capability behavior; and
- direct and streamed 2 MiB accepted / 2 MiB + 1 rejected boundaries.

On both supported writers, additionally assert that `block/put(pin=true)` leaves content and
registration blocks explicitly `recursive`, that both blocks survive local garbage collection,
and that exact reads still succeed without a second pin mutation.

Use ephemeral Kubo containers in CI. Pin v0.40.0 and v0.42.0 by immutable official image digest
for the full write-conformance matrix. Pin v0.32.1 separately by immutable official image digest
for reader/error-envelope compatibility only.

Do not depend on a public gateway for hermetic contract tests. A separate optional test may prove
gateway reading against a local HTTP fixture.

If real Kubo rejects exactly 2 MiB under standard `block put`, stop and correct the design before
shipping. This condition applies to the supported v0.40.0-or-newer writer matrix; v0.32.1's
documented older 1 MiB default is the reason it is excluded as a writer. Never enable
`allow-big-block`.

### Task 10: Distribution and final review

Pack smoke must:

- install only declared dependencies;
- import root and `/cid`;
- build a temporary consumer;
- execute digest/CID golden vectors;
- parse registration fixtures;
- prove package capabilities; and
- show no undeclared Jinn dependency.

The coordinator completes the Evidence CI Kubo job and final aggregate dependency edges.

Obtain:

1. architecture/profile review; and
2. security/durability review of authenticated-client injection, bounded reads, pins, readback,
   error mapping, and cancellation.

Commit sequence:

```text
feat(evidence-repository-ipfs): implement registered IPFS repository
test(evidence-repository-ipfs): prove Kubo contract and limits
ci(evidence-repository-ipfs): integrate the evidence DAG
```

## Acceptance checklist

- [ ] Repository capabilities prerequisite is already green.
- [ ] Exact SHA-256 digest maps reversibly to CIDv1 raw SHA2-256.
- [ ] Registration blocks preserve family/artifact namespaces.
- [ ] A 2 MiB put reaches Kubo and succeeds; 2 MiB + 1 fails before every writer, pin, reader, or
      other RPC call.
- [ ] A streamed 2 MiB read is accepted and digest-verified; the next byte is canceled and rejected
      without retaining the complete body.
- [ ] 256 KiB is never described as the raw-block ceiling.
- [ ] `allow-big-block`, UnixFS, chunking, and mutable lookup indexes are absent.
- [ ] Successful put confirms expected CIDs, configured pins, and exact readback.
- [ ] Full Repository writer conformance passes on pinned Kubo v0.40.0 and v0.42.0.
- [ ] Kubo v0.32.1 is tested only for bounded reader/error-envelope compatibility and is never
      advertised as a supported writer.
- [ ] Missing registration returns `null`; corrupt partial objects fail.
- [ ] Reader buffering is bounded and all awaited boundaries are cancellable.
- [ ] Contract kit passes unmodified against real Kubo.
- [ ] No credentials, announcements, Discovery, Protocol, application, or legacy dependencies
      entered the package.
- [ ] Profile drift, packed install, architecture guards, and Evidence CI pass.

## Follow-ups

- Production endpoint, gateway, pin-service, retention, and monitoring selection.
- Optional large-object or DAG-chunking repository design with an explicit root-discovery scheme.
- Concrete public announcement medium.
- Plugin/operator composition and legacy cutover.

None is required for this bounded repository binding to be conforming.
