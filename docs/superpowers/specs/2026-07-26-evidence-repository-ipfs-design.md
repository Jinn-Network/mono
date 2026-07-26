# IPFS Evidence Repository Binding Design

**Date:** 2026-07-26

**Status:** design complete; unimplemented; corrected to the standard transferable raw-block
ceiling and an explicit repository capability prerequisite

**Scope:** `packages/evidence/repository-ipfs` — an IPFS binding for
`@jinn-network/evidence-repository`, strict SHA-256 digest/CID conversion, deterministic
repository-registration blocks, Kubo RPC writes and pin verification, Kubo or gateway reads, and
the binding-specific conformance profile

**Out of scope:** announcement framing, chain anchoring, an IPFS `AnnouncementSink` or
`EvidenceRecordAnnouncementSource`, application wiring, credentials, retention policy, unpinning,
garbage-collection scheduling, protocol changes, legacy publication cutover, and content larger
than one raw IPFS block

**Implementation entrypoint:** read
`../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is authoritative
for the base branch, repository capability prerequisite, package paths, shared-file ownership, and
PR order.

## 1. Decision

Implement `@jinn-network/evidence-repository-ipfs` as a bounded, exact-byte
`EvidenceRepository` binding over **CIDv1 raw SHA2-256 blocks**.

For every record or artifact, the binding pins two blocks:

1. the caller's exact bytes, whose CID is reversibly derived from the repository
   `sha256:<hex>` digest; and
2. a small, canonical registration block, whose CID is deterministically derivable from the
   repository reference alone.

The registration block preserves the repository's record-family and record/artifact namespaces.
It is not an announcement, collection, or protocol document. `getRecord` and `getArtifact` are its
readers.

Writes require an application-injected Kubo RPC client. Reads use either that Kubo node or an
application-selected raw-block gateway reader. A successful put means that the expected blocks
were accepted under the expected CIDs, the configured custody pins were confirmed, and the
complete repository object was read back byte-for-byte through the configured read path. It does
not mean that the blocks are permanently available, globally replicated, or immediately
retrievable through every public gateway.

Content larger than `2 * 1024 * 1024` bytes is rejected. Chunking would replace the reversible
digest-to-raw-CID mapping with a DAG root that cannot be derived from an
`EvidenceArtifactReference` or `EvidenceRecordReference` alone. Adding a mutable lookup index to
repair that would make this a different repository design.

The 256 KiB value used by the legacy helper is Kubo's default UnixFS chunk size, not the largest
standard raw block. This binding uses raw blocks directly, does not use UnixFS, and stays within
the standard 2 MiB Bitswap block limit. Kubo v0.40.0 is the minimum supported writer because it is
the first release whose standard `block.put` accepts that boundary. The binding never enables
Kubo's `allow-big-block` escape hatch.

## 2. What this package refuses

| Concern | Owner or reason |
| --- | --- |
| Bundle framing, anchoring, and announcement | A future IPFS medium package containing the paired sink and source |
| Chain transactions, wallets, operator identities, or signers | Application binding; credentials stop above substrate |
| Kubo authentication headers or pin-service secrets | Application constructs the Kubo client or authorized fetch capability |
| Evidence validation, canonical protocol serialization, or conformance tiers | `evidence-protocol` |
| Scrubbing, derivation, recording, or attestation issuance | Producer packages |
| Catalog projection, query, pagination, or resolution policy | `evidence-discovery` and catalog bindings |
| Cross-gateway ranking and fallback policy | Application composition |
| Retention periods, leases, renewal, monitoring, or storage billing | Operator infrastructure |
| Delete, unpin, or garbage-collection control | Not present in `EvidenceRepository`; unsafe to infer |
| UnixFS files, DAG-PB roots, recursive DAG import, or arbitrary CID storage | Breaks the total digest/raw-CID mapping selected here |
| Application cutover from `packages/layer` or `client/` | A later adoption item |
| Permanent availability or global IPFS propagation | No IPFS write acknowledgment can establish either property |

## 3. Contract fit and package boundary

### 3.1 Public shape

Before this binding lands, the repository contract gains a small read-only capability surface and
one capacity error:

```ts
interface EvidenceRepositoryCapabilities {
  readonly maxObjectBytes?: number;
}

interface EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;
  // existing put/get methods unchanged
}
```

`maxObjectBytes: undefined` means the binding declares no smaller finite application-level
maximum. It does not promise infinite backend capacity. The repository error-code union adds
`CONTENT_TOO_LARGE`.

The filesystem, OCI, and test repositories implement the property, and the shared contract kit
tests capability syntax plus the declared boundary. Because the affected packages are unpublished,
this correction lands before the IPFS package rather than preserving an ambiguous v1 contract.

The Repository prerequisite defines `capabilities` as an inert immutable snapshot with a plain or
null prototype and only own immutable data fields. Unknown future fields remain semantically
ignored. The IPFS repository is an ordinary non-proxy class instance whose `capabilities` class
field is an own data slot. The binding exposes a frozen data object; it does not use accessors,
inheritance, or proxy behavior to compute the limit.

The binding then implements the widened contract:

```ts
class IpfsEvidenceRepository implements EvidenceRepository {
  readonly capabilities = Object.freeze({
    maxObjectBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
  });

  putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<IpfsRepositoryWriteReceipt<EvidenceRecordReference>>;

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null>;

  putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<IpfsRepositoryWriteReceipt<EvidenceArtifactReference>>;

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null>;
}

interface IpfsRepositoryWriteReceipt<TReference>
  extends RepositoryWriteReceipt<TReference> {
  /** Canonical lowercase base16 CIDv1 text for the exact content block. */
  readonly contentCid: string;
  /** Canonical lowercase base16 CIDv1 text for the repository registration block. */
  readonly registrationCid: string;
}
```

The added receipt fields are binding-specific diagnostics. Callers typed against
`EvidenceRepository` see the unchanged base receipt. Neither CID becomes repository identity;
`reference` remains authoritative.

Construction separates write custody from retrieval:

```ts
interface IpfsBlockReader {
  getBlock(
    cid: string,
    options: RepositoryOperationOptions & { readonly maxBytes: number },
  ): Promise<Uint8Array | null>;
}

interface KuboBlockReaderOptions {
  /** Kubo RPC base URL without userinfo, query, or fragment. */
  readonly endpoint: string | URL;
  /** May be closed over application-owned authority. */
  readonly fetch?: typeof globalThis.fetch;
}

function createKuboBlockReader(options: KuboBlockReaderOptions): IpfsBlockReader;

interface IpfsEvidenceRepositoryOptions {
  /** Constructed by the application, including any RPC authentication. */
  readonly client: KuboRPCClient;
  /** Explicit bounded read capability; never inferred from the eager RPC client. */
  readonly reader: IpfsBlockReader;
  /** Kubo-configured remote pin service name; never a token or endpoint secret. */
  readonly remotePinService?: string;
  /** Total time allowed for configured-path readback; default 60 seconds. */
  readonly readbackTimeoutMs?: number;
}
```

The package exports a Kubo block reader and a gateway block reader. Both receive an endpoint and
optionally an injected `fetch` capability. The Kubo reader performs a streamed
`POST /api/v0/block/get?arg=<canonical-cid>`; it does not call
`kubo-rpc-client.block.get`, because version 7.1.0 eagerly materializes the entire response with
`Response.arrayBuffer()` before a package-level limit can run. Neither reader accepts an
`Authorization` header, username, token, or API key. An application that needs authentication
injects a fetch function already closed over that authority.

### 3.2 Layer and dependencies

This is a **Binding** package because it implements one Contract-layer port for one external
medium and introduces one heavyweight dependency:

```text
@jinn-network/evidence-repository-ipfs
├── @jinn-network/evidence-repository
└── kubo-rpc-client
```

It MUST NOT depend on `evidence-protocol`, `publication`, `evidence-discovery`, another evidence
binding, `packages/layer`, `client/`, or an application package. Built-in `fetch` is sufficient for
gateway reads. The repository contract creates and parses repository references; this package
only maps those references onto IPFS storage.

The application owns endpoint selection and constructs the configured capabilities. The binding
owns only their content-addressed use.

## 4. Digest and CID mapping

### 4.1 Normative mapping

For a repository digest:

```text
sha256:<64 lowercase hexadecimal characters>
```

the content CID has this multicodec structure:

```text
CID version       0x01       CIDv1
multicodec        0x55       raw
multihash code    0x12       SHA2-256
digest length     0x20       32 bytes
digest            <the 32 bytes represented by the repository digest>
```

This mapping is total and reversible:

```text
sha256:<hex>  <->  CIDv1(raw, sha2-256, hex bytes)
```

The binding emits one stable textual representation: lowercase base16, which is:

```text
f01551220<64 lowercase hexadecimal characters>
```

The base16 choice preserves the production convention in `packages/layer/src/ipfs-cid.ts` and
avoids text drift in logs, receipts, and fixtures. CID identity is binary, so a structurally
identical canonical base32 CID is accepted at parsing boundaries and normalized to this base16
form.

### 4.2 Accepted and rejected CID text

The dependency-free helper module supersedes the strict behavior of
`packages/layer/src/ipfs-cid.ts`:

- accept strict CIDv0 DAG-PB and canonical CIDv1 raw/DAG-PB text in the general `parseIpfsCid`
  parser, matching the incumbent helper;
- accept canonical lowercase base32 or lowercase base16 text for CIDv1;
- reject non-minimal varints, mixed or uppercase text, base58 aliases for CIDv1, and noncanonical
  encodings;
- require CIDv1 + raw + SHA2-256 for digest conversion and repository operations;
- reject CIDv0, DAG-PB, other codecs, and other multihashes at the binding boundary with
  `INVALID_REFERENCE`; and
- reject a syntactically valid raw CID whose digest does not match the supplied bytes with
  `REFERENCE_CONFLICT`.

Repository methods never ask callers for a CID. These rules govern exported CID helpers, CIDs
returned by Kubo, and internal gateway construction.

### 4.3 Ownership of the helpers

The new package copies the algorithms and tests from the legacy helper, then owns them. It does
not import `packages/layer`, because a new substrate package taking a legacy dependency reverses
the rebuild boundary. The legacy file remains untouched until an application-cutover item removes
its consumers.

For now the package exports the dependency-free helpers through
`@jinn-network/evidence-repository-ipfs/cid`. A future IPFS announcement-medium design needs the
same raw CID mapping and `MAX_STANDARD_IPFS_BLOCK_BYTES`, but MUST NOT create a permanent
binding-to-binding dependency. When that second substrate consumer is implemented, the helpers
move once into a neutral, zero-runtime-dependency IPFS utility package and both bindings import
them. Creating that package before the second consumer exists is speculative; copying the helpers
again is forbidden.

## 5. Repository registrations

### 5.1 Why the content CID is insufficient

The repository reference spaces are not one flat digest map:

- a record is addressed by `(family, digest)`;
- an artifact is addressed by `digest`; and
- writing one namespace does not register the bytes in another.

A raw content block knows only the digest. If `getRecord` fetched that block directly, writing an
execution-evidence record would make the same digest appear as result-evaluation and
execution-verification. If `getArtifact` fetched it directly, every record write would also create
an artifact. That would disagree with the filesystem and OCI bindings even though the current
contract kit does not test the cross-namespace cases.

### 5.2 Registration profile

The binding therefore defines a versioned, normative registration profile. Its two exact UTF-8
JSON Lines forms are:

```json
{"digest":"sha256:<hex>","family":"execution-evidence","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

```json
{"digest":"sha256:<hex>","kind":"artifact","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

Each line ends with exactly one LF byte. There is no BOM or trailing whitespace. Keys appear in
the shown order. `<hex>` is exactly 64 lowercase hexadecimal characters, and `family` is one of
the three contract families. The implementation constructs these bytes directly from a parsed
reference rather than relying on incidental JavaScript object order.

The registration block is itself stored as CIDv1 raw SHA2-256. Its bytes, and therefore its CID,
are derivable from a reference without fetching or indexing anything.

The package ships:

- a normative profile document;
- golden digest/content-CID/registration-bytes/registration-CID vectors for all record families
  and artifacts; and
- builders and validators used by the binding.

This local profile is warranted because registration blocks cross operator and implementation
boundaries. It does not amend `evidence-protocol`: the block records repository membership, which
protocol §16 deliberately disclaims.

### 5.3 Read behavior

`getRecord(reference)`:

1. parses the repository reference;
2. derives the exact registration bytes and registration CID;
3. fetches that registration block;
4. returns `null` if the registration block is absent;
5. rejects a present but nonmatching registration block as `CONTENT_CORRUPT`;
6. derives and fetches the content CID;
7. rejects absent content behind a present registration as `CONTENT_CORRUPT`;
8. verifies the content digest; and
9. returns a fresh byte array.

`getArtifact` is identical with the artifact registration form. It returns `null` when the
artifact registration is absent, even if an equal raw content block exists because a record
registered it.

The binding does not require the registration to remain pinned merely to perform a read; any
configured reader that can retrieve both blocks is valid.

## 6. Writer, reader, and operator shape

### 6.1 Writes require Kubo RPC

The write path requires Kubo's RPC API. For each block it uses `block.put` with:

```text
format=raw
mhtype=sha2-256
version=1
pin=true
allow-big-block=false
```

The binding computes the expected CID before the call and verifies Kubo's returned CID afterward.
It then confirms the CID appears in `pin.ls` as an explicit `direct` or `recursive` pin.
`block.put(pin=true)` creates a `recursive` pin on the supported Kubo writer line. For this raw
block profile there are no descendants, so either explicit pin class protects the same single
block from garbage collection. An `indirect`-only result does not establish custody and is
rejected. The binding does not issue a second pin mutation merely to change this Kubo-managed
classification.

Kubo RPC is an administrative API and MUST NOT be exposed directly to the public internet. The
application supplies an already-configured `KuboRPCClient`; the binding never constructs
credential-bearing headers from data values.

An optional `remotePinService` is a service name already configured in Kubo. When present, every
content and registration block is also submitted through `pin.remote.add` with
`background=false`. A write cannot succeed until the service reports `pinned`. Pin-service
credentials and endpoint configuration remain in Kubo.

### 6.2 Reads may differ from writes

Two readers ship:

| Reader | Operation | Intended use |
| --- | --- | --- |
| Kubo block reader | streamed `POST /api/v0/block/get?arg=<CID>` | Local/private deployments and deterministic integration tests |
| Raw gateway reader | `GET <base>/ipfs/<cid>?format=raw` with `Accept: application/vnd.ipld.raw` | Verify the public read path used by other operators |

The gateway reader requires an explicit base URL. It does not contain a fallback list. A caller
may compose a policy outside this package, but the repository gets one authoritative configured
read capability so its success condition is unambiguous.

After an operator-managed upgrade from the observed v0.32.1 node to a supported Kubo writer, the
future production-aligned composition is:

```text
writer: application-authenticated Autonolas registry Kubo RPC client
reader: Autonolas raw-block gateway
```

No production endpoint is compiled into the package.

Readers distinguish absence from outage:

- a gateway's authoritative 404 returns `null`;
- Kubo RPC reports command failures, including missing blocks, as HTTP 500. The Kubo reader returns
  `null` only when a bounded, strict error-envelope parser matches one of the exact
  version-specific not-found fixtures proven against every pinned Kubo release;
- authentication, rate limiting, timeout, connection failure, and 5xx responses throw a stable
  repository error, except for that recognized Kubo not-found envelope; and
- a 2xx response whose bytes do not hash to the requested CID is `CONTENT_CORRUPT`.

Every shipped reader enforces the requested byte ceiling while streaming. An oversized
`Content-Length` is rejected before body consumption when present, but the delivered-byte counter
is authoritative when the header is absent or wrong. The reader cancels immediately when the next
chunk would cross the inclusive limit and never retains or copies that chunk into accumulated
storage. The package guarantees bounded package-level accumulation and prompt transport
cancellation; it does not claim control over a fetch implementation's internal socket buffers.

Kubo error bodies use a separate package-internal
`MAX_KUBO_ERROR_BODY_BYTES = 64 * 1024` ceiling. The reader applies the same streamed counting and
cancellation rules before fatal UTF-8 decoding and strict parsing of the closed Kubo command-error
shape (`Message`, `Code`, and `Type`, with the exact optionality and value types frozen by the
pinned-version fixtures). Duplicate keys, extra keys, malformed JSON, oversized bodies, unknown
messages, or a fixture mismatch are `DEPENDENCY_UNAVAILABLE`, never `null`. A recognized
not-found message must identify the requested canonical CID under the exact anchored
version-specific rule. The package never uses an open-ended substring match.

## 7. Successful writes and graded durability

IPFS cannot acknowledge “durably stored everywhere.” This binding makes a narrower success claim
that the publication pipeline can rely on.

### 7.1 Required for every successful put

Before returning a receipt, the binding MUST have:

1. parsed the family/reference inputs and copied the caller's bytes;
2. computed the expected content and registration CIDs locally;
3. submitted both exact blocks to the writer as raw SHA2-256 CIDv1 blocks;
4. verified both returned CIDs against the locally computed values;
5. confirmed explicit local (`direct` or `recursive`) pins for both CIDs on the writer;
6. satisfied every configured remote-pinning requirement; and
7. fetched the complete repository object through the configured reader and compared the returned
   content byte-for-byte.

Readback retries absence and transient dependency errors until `readbackTimeoutMs`, because a
gateway may lag the writer. It does not retry integrity mismatch. If the deadline expires, the put
fails with `DEPENDENCY_UNAVAILABLE`; the already-pinned blocks remain and make retry safe.

This means a successful store phase is **point-in-time retrievable through the operator's declared
read path and held by its declared custody set**.

### 7.2 Conditional on configured custody

| Configuration | Additional success condition |
| --- | --- |
| Local Kubo only | Both blocks have explicit `direct` or `recursive` pins on that node |
| Local Kubo + remote pin service | Both blocks have explicit local pins and are reported `pinned` by that service |
| Gateway reader | Both registrations and content are retrievable and verified through that gateway before return |

The remote service condition is required when configured, not best effort. A rejected, failed, or
timed-out remote pin makes the put fail.

### 7.3 Explicitly not guaranteed

Success does not establish:

- permanent retention by the local node or a remote service;
- renewal after a service lease, account, or quota expires;
- replication beyond the configured custody set;
- DHT provider visibility;
- retrieval from an arbitrary or fallback gateway;
- survival after the operator removes a pin or loses node state; or
- continued availability after the successful readback instant.

These are operational properties to monitor above the binding. Calling the method “durable” must
always mean the graded claim above, never permanent public availability.

## 8. Pinning, idempotency, and garbage collection

Pinning is part of `putRecord` and `putArtifact`; a successful repository write cannot leave its
blocks eligible for the configured writer's garbage collection.

Before writing, the binding inspects the required local and remote pin state:

- `existing` means both the content and the appropriate registration already satisfy the complete
  configured custody and readback conditions;
- `created` means the call had to establish or repair any part of that registered object; and
- a raw content block pinned for a different family or namespace does not make a new registration
  `existing`.

Two concurrent first writes may both observe absence and both return `created`. They converge on
the same CIDs and pins; no divergent state or duplicate content is created. The existing contract
requires sequential idempotency, not a single-winner creation transaction.

If a call pins content and then fails while pinning the registration, it reports failure and leaves
the content pinned. A retry completes the same deterministic registration. If a remote service
later expires or removes a pin, the next put repairs it and returns `created`; ordinary gets make
no custody claim and do not mutate pins.

The binding never unpins. `EvidenceRepository` has no delete or retention contract, and guessing
when cross-referenced content is safe to collect would be destructive. Operators manage leases,
renewal, audits, and reclamation outside this package.

## 9. Block-size ceiling

`MAX_STANDARD_IPFS_BLOCK_BYTES` is exactly `2 * 1024 * 1024` bytes, inclusive. Content of 2 MiB is
accepted. Content of 2 MiB plus one byte is rejected before any remote call with
`EvidenceRepositoryError("CONTENT_TOO_LARGE")`.

This is the standard transferable raw-block ceiling used by Kubo and Bitswap. The implementation
pins its tested supported Kubo writer releases and proves both boundary cases against real Kubo.
Kubo releases before v0.40.0 retained the older 1 MiB default and are not compatible writers for
this repository profile. If a supported writer executable test contradicts the inclusive boundary,
implementation stops and corrects this specification before shipping; it does not quietly change
the constant.

The limit applies independently to record and artifact content. Registration blocks are bounded
by their fixed profile and are far smaller. Readers enforce a package-level accumulation ceiling
derived from the same constant so a faulty endpoint cannot cause unbounded buffering by this
binding.

Kubo's 256 KiB default is a UnixFS chunking choice and is irrelevant to this raw-block binding.
`allow-big-block=true` is prohibited because oversized blocks are not standardly exchangeable and
would turn a local write success into a misleading portability claim.

The repository capability lets publication reject an incompatible record/artifact closure before
creating any remote effect. Evidence with any object over this limit uses OCI or another
large-object repository binding. Native traces commonly exceed the limit, so the IPFS binding is
an optional bounded rail, not the universal public repository.

An announcement medium's frame limit is independent. Its sink measures its own exact physical
frame through `AnnouncementSink.prepare`; it must not reuse the size of repository object bodies as
a partition estimate.

## 10. Errors and failure semantics

All public failures use the repository's stable error class. Values thrown by injected Kubo
clients or injected `fetch` capabilities are untrusted and potentially authority-bearing: their
messages, URLs, headers, own fields, and nested causes may contain credentials. The binding never
returns such a raw value as a public error or `cause`.

When a dependency failure needs causal diagnostics, the public `EvidenceRepositoryError.cause` is
a package-owned, frozen, closed data value containing only a stable operation class and failure
kind selected by the binding. It contains no raw message, stack, endpoint, request/response
object, header, body, client value, or nested injected cause. Validation failures that need no
dependency diagnostics omit `cause`. Every adapter runs error-path conformance tests with
printable and binary synthetic authority markers and recursively scans the public error graph,
including messages, inert own fields, and bounded cycle-safe cause chains, for raw, lowercase-hex,
base64, unpadded base64url, and percent/URL-encoded marker forms. This is scoped conformance
evidence for the tested binding, not a sandbox around injected code.

| Condition | Result |
| --- | --- |
| Invalid family, digest, reference, or CID text | `INVALID_REFERENCE` |
| Put bytes or a streamed read exceed `MAX_STANDARD_IPFS_BLOCK_BYTES` | `CONTENT_TOO_LARGE` |
| Kubo returns a structurally valid CID different from the expected CID | `REFERENCE_CONFLICT` |
| Present registration bytes do not match their derived reference | `CONTENT_CORRUPT` |
| Present content does not hash to its reference, or content is absent behind a present registration | `CONTENT_CORRUPT` |
| Authoritative read reports registration absent | `null` |
| Authoritative artifact/record content absent with no registration | `null` |
| RPC/gateway connection failure, timeout, 429, 5xx, failed remote pin, or readback deadline | `DEPENDENCY_UNAVAILABLE` |
| Explicit 401/403, pin-service authorization failure, or confirmed quota rejection | `ACCESS_DENIED` |
| Caller abort before or during work | `OPERATION_ABORTED` |
| Unexpected client/protocol/I/O failure not classified above | `IO_FAILURE` |

Cancellation is checked before every effect and passed to Kubo and fetch calls. An abort cannot
roll back an earlier content-addressed put or pin; the method throws `OPERATION_ABORTED`, leaves
safe partial pins in place, and a retry converges.

No put receipt is returned after partial success. No get turns an outage into `null`.

## 11. Contract and binding-specific tests

### 11.1 Unmodified contract kit

`describeEvidenceRepositoryContract` runs unchanged against an isolated, initially empty Kubo node
using the Kubo reader. It must pass:

- exact byte round trips for all three record families;
- artifact round trip;
- missing content as `null`;
- sequential `created` then `existing`;
- input/output buffer isolation; and
- already-aborted operations.

An isolated node is necessary for deterministic first-write status. A shared public node may
already hold a fixture CID and is not a conformance environment.

### 11.2 Binding-specific unit tests

Additional tests cover behavior the shared kit cannot see:

- digest/CID golden vectors and reversible conversion;
- strict canonical base32/base16 acceptance and all incumbent rejection cases;
- 2 MiB acceptance and 2 MiB plus one byte rejection before I/O;
- exact registration bytes and CIDs for every family and artifact;
- wrong-family and record/artifact isolation;
- content present without registration returns `null`;
- registration present without content is `CONTENT_CORRUPT`;
- returned CID mismatch is `REFERENCE_CONFLICT`;
- local pin verification and repair;
- optional remote pin success, rejection, timeout, and expired-pin repair;
- gateway and Kubo reader absence/outage/integrity mapping;
- gateway and Kubo streaming limits, including exactly 2 MiB accepted and the next byte causing
  immediate cancellation without retaining the complete body;
- missing or false `Content-Length`, an oversized first chunk, and caller cancellation cannot
  bypass the delivered-byte counter;
- real-Kubo not-found error fixtures for every pinned version, plus oversized, malformed,
  duplicate-key, extra-key, wrong-CID, and unknown HTTP-500 envelopes;
- readback propagation retry and deadline;
- partial-write retry;
- concurrent identical puts converge; and
- abort at each effect boundary.

### 11.3 Real-Kubo integration

The full repository integration suite exercises `block.put`, the shipped streamed Kubo reader,
`pin.ls`, explicit local garbage collection protection, and gateway raw reads against:

1. Kubo v0.40.0, the minimum supported writer and first standard 2 MiB `block.put` release; and
2. Kubo v0.42.0, the implementation-time current stable release on 2026-07-26.

Kubo v0.32.1, the version observed at the Autonolas registry RPC on 2026-07-26, is retained only in
the reader-compatibility lane. That lane captures and verifies its bounded missing-block error
envelope and may read digest-verified raw blocks within the older node's limit. It does not run the
Repository contract kit, does not claim writer compatibility, and never enables `allow-big-block`.
The observed node requires an operator-managed upgrade before this repository writer can target it;
that infrastructure change is outside this stack.

The suite runs locally via Docker and in evidence CI. It never writes to the production Autonolas
node. Remote-pin-service transitions use a deterministic fake at unit level unless CI supplies a
disposable pinning service.

## 12. Rejected alternatives

### 12.1 UnixFS or custom DAG chunking

**Rejected.** A chunked root CID hashes a DAG node, not the caller's exact bytes. The root therefore
cannot be derived from `sha256:<hex>`, and `get(reference)` has no root CID with which to start.
A side index, IPNS name, or marker whose CID contains the unknown root would introduce mutable
lookup state. Chunking needs a different repository reference contract.

### 12.2 Content block without registrations

**Rejected.** It collapses all record families and the artifact namespace into one digest set,
making unwritten references readable. That disagrees with both incumbent bindings.

### 12.3 Kubo `add` and UnixFS defaults

**Rejected.** `add` has flags capable of producing one raw block, and the legacy client uses them,
but it is a file-import API whose defaults include UnixFS behavior. `block.put` states this
binding's one-block intent directly and returns the block CID that must be verified.

### 12.4 Gateway-only binding

**Rejected.** A gateway is a read capability, not acknowledged custody. It cannot satisfy put or
pin semantics.

### 12.5 Embedded Helia node

**Rejected.** It makes node lifecycle, networking, persistence, peer discovery, and garbage
collection library concerns of the repository binding. The operator already runs Kubo in the
production path. An injected RPC capability is smaller and operationally honest.

### 12.6 Add-and-return without pin/readback verification

**Rejected.** It proves only that one RPC accepted bytes. The publication pipeline could advance
to announcement while its declared public read path still could not retrieve them.

### 12.7 Direct pinning-service credentials

**Rejected.** Tokens in package options cross the substrate/authority boundary. Kubo holds service
configuration; the binding receives only the configured service name.

### 12.8 Importing or independently recopying the legacy CID helper

**Rejected.** Importing creates a new-to-legacy dependency. Leaving two permanent copies invites
drift. This package supersedes the helper now; a neutral extraction occurs only when the future
medium becomes a second substrate consumer.

## 13. Prior art composed

This design names and reuses the mechanisms it composes:

- **Content-addressed immutability:** repository SHA-256 identity maps directly to an IPFS raw-block
  CID.
- **Deterministic sidecar registration:** the filesystem binding's family marker and the OCI
  binding's family-qualified lookup inspired a reference-derived registration block that preserves
  namespaces without an index.
- **Write-then-read verification:** a put is not complete until the configured consumer path can
  read and verify the object.
- **Idempotent ensure operation:** pinning by CID and deterministic registration make retries
  convergent.
- **Capability injection:** authenticated Kubo and fetch clients are constructed by the
  application; the binding receives authority-bearing capabilities rather than credentials.
- **Graded guarantees:** the publication design's required/conditional discipline is applied to
  IPFS custody and visibility.
- **Bounded adapter:** the binding declares and enforces the incumbent raw-block ceiling rather
  than hiding an incompatible DAG representation.
- **Normative profile plus golden vectors:** the OCI binding's cross-operator interoperability
  discipline is applied to registration blocks.

Source prior art read for this design:

- `packages/layer/src/ipfs-cid.ts` — strict parsing and raw CID derivation; its comment conflating
  the 256 KiB UnixFS chunk default with the raw-block ceiling is explicitly not carried forward;
- `client/src/adapters/mech/ipfs.ts` — Autonolas registry writes, raw-leaf settings, pins, and
  gateway reads;
- `packages/indexer/src/ipfs.ts` and `packages/core/src/corpus-read/ipfs.ts` — gateway behavior
  under read-side conditions;
- the unmerged `evidence-repository`, filesystem, and OCI implementations from PR #2161 — exact
  contract, conformance kit, family isolation, errors, and binding profiles;
- `packages/layer/src/publish.ts` — compute-before-effect CID verification and bounded raw blocks;
- the [Kubo RPC reference](https://docs.ipfs.tech/reference/kubo/rpc/) — raw `block.put`,
  `block.get`, the supported writer line's default refusal of blocks over 2 MiB, explicit pins,
  remote pins, and the administrative-API warning;
- the [Kubo CLI reference](https://docs.ipfs.tech/reference/kubo/cli/) — the separate 256 KiB
  UnixFS default chunk size and standard 2 MiB block ceiling; and
- the [IPFS pinning guide](https://docs.ipfs.tech/how-to/work-with-pinning-services/) — garbage
  collection protection and remote pin status semantics.

## 14. Self-review findings

The required cross-package review produced these results:

1. **Artifact readers.** Exact content and registration blocks are read by
   `IpfsEvidenceRepository.getRecord` / `getArtifact`; the normative profile also supports
   independent implementations. No bundle or announcement artifact is created. This check changed
   the design: it added an artifact registration, not only record-family registrations, so a
   record write cannot create an artifact implicitly.
2. **Name collisions.** Package/type/export searches found no existing
   `IpfsEvidenceRepository`, `IpfsBlockReader`, or “registration block” public meaning in the
   evidence stack. Existing `EvidenceRepository` names are reused rather than aliased. The design
   avoids “batch,” already owned by discovery's `AnnouncementBatch`.
3. **Layer boundary.** The dependency edge is Binding → Contract plus one external medium client.
   There is no edge to a pipeline, application, credential holder, legacy package, or peer
   binding. The future CID-helper extraction prevents a permanent Binding → Binding edge.
4. **Guarantees.** A public gateway is the weakest configured reader. The design therefore claims
   point-in-time verified retrieval only through the selected reader and conditional retention
   only from confirmed pins. Permanent/global availability was removed from the success claim.
5. **Source claims.** Contract behavior was checked in the repository modules and conformance kit,
   not only their barrels. Filesystem and OCI sources exposed the namespace issue. Kubo client
   source and current official RPC documentation confirmed the required raw-block, local-pin, and
   remote-pin operations.

The review also surfaced the unbounded-contract/bounded-binding mismatch in §9. It is resolved by
the explicit repository capability prerequisite rather than left as an application guess.

## 15. Settled decisions and open questions

### Settled

- One exact object is one CIDv1 raw SHA2-256 content block.
- Emitted CID text is canonical lowercase base16; canonical base32 is accepted and normalized.
- Both records and artifacts have deterministic, versioned registration blocks.
- Kubo RPC is required for writes; Kubo or a raw gateway may serve reads.
- Successful puts verify CIDs, configured pins, and configured-path readback.
- A configured remote pin service is a hard success condition, not best effort.
- The binding rejects content above the standard 2 MiB raw-block ceiling and does not chunk.
- Kubo v0.40.0 is the minimum supported writer; v0.32.1 is reader/error-envelope compatibility
  only.
- The repository contract exposes `maxObjectBytes`; direct oversized puts use
  `CONTENT_TOO_LARGE`.
- The updated contract kit is mandatory, with additional real-Kubo boundary tests.
- Kubo's 256 KiB UnixFS chunk default is not a raw-block limit.
- `allow-big-block` is prohibited.
- The package supersedes, but does not yet delete, the legacy CID helper.
- Unpinning, retention, announcement, and credentials stay outside the package.

### Open

There are no implementation-blocking design questions after the repository capability prerequisite
lands. Operator choices—production Kubo endpoint, gateway, remote pin service, retention policy,
and later application cutover—are deliberately left to deployment and adoption work.
